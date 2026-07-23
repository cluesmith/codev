/**
 * Tower API Client
 *
 * Provides a client for interacting with the Tower daemon.
 * Handles authentication and common API operations.
 *
 * Extracted from packages/codev/src/agent-farm/lib/tower-client.ts
 */

import type { DashboardState, OverviewData, IssueView, IssueSearchResponse, ResolvedWorktreeConfig, ResolvedActivityHooks, TowerVersionInfo } from '@cluesmith/codev-types';
import { DEFAULT_TOWER_PORT } from './constants.js';
import { ensureLocalKey } from './auth.js';

const REQUEST_TIMEOUT_MS = 10000;

// ── Types ──────────────────────────────────────────────────────

/**
 * All terminal kinds Tower can host. Used wherever a terminal is created or
 * enumerated. `'dev'` is the ephemeral dev-server PTY spawned by `afx dev`;
 * it is intentionally kept out of SQLite by the runtime filter at
 * `tower-routes.ts` (search for `['builder', 'shell'].includes(body.type)`).
 */
export type TerminalType = 'architect' | 'builder' | 'shell' | 'dev';

/**
 * Readiness-gated first-message delivery for seed-style builder harnesses
 * (Issue #1201 — Kimi). The launch script prints `<sentinel> <session-id>`
 * between seed completion and TUI start; Tower watches the PTY stream for it,
 * waits `graceMs`, writes `message`, and (when `verify` is present) confirms
 * submission against the harness's session store, re-sending on timeout.
 * Bytes written to the PTY during the seed window are silently lost, so
 * ungated delivery would drop the message.
 */
export interface SeedKickRequest {
  /** Sentinel line prefix; the token after it is the harness session id. */
  sentinel: string;
  /** Single-line kick message (e.g. 'BEGIN'). */
  message: string;
  /** Post-sentinel grace before writing, in ms. */
  graceMs?: number;
  /** Delayed-Enter override for the kick write (harness pacing). */
  enterDelayMs?: number;
  /** Store-verified delivery. `kind` selects the verifier; only the Kimi
   *  session store is supported today. */
  verify?: { kind: 'kimi-session-store'; worktreePath: string };
}

export interface TowerWorkspace {
  path: string;
  name: string;
  active: boolean;
  proxyUrl: string;
  terminals: number;
}

export interface TowerWorkspaceStatus {
  path: string;
  name: string;
  active: boolean;
  terminals: Array<{
    type: TerminalType;
    id: string;
    label: string;
    url: string;
    active: boolean;
    /**
     * Spec 786 Phase 5: when `type === 'architect'`, the architect's stable
     * name (`'main'` or a sibling). Older clients ignore this field.
     */
    architectName?: string;
    /**
     * Spec 786 Phase 5: live process ID from Tower's in-memory `PtySession`,
     * surfaced for `afx status`. Not persisted in `state.db.architect` (the
     * row stores `pid: 0` — see state.ts:79, :103), so this field is only
     * available when Tower is running.
     */
    pid?: number;
    /**
     * Spec 786 Phase 5: port assigned to the architect terminal, if any.
     * Same Tower-only constraint as `pid`.
     */
    port?: number;
    /**
     * Spec 786 Phase 5: the actual PtySession id. The `id` field above
     * carries the tab identifier (`'architect'` or `'architect:<name>'`) per
     * Spec 761's deep-link convention; this field exposes the underlying
     * session id so consumers like `afx status` can show it for terminal-
     * attach correlation. Optional for backward compat with older clients
     * that only emit `id`.
     */
    terminalId?: string;
  }>;
}

export interface TowerHealth {
  status: 'healthy' | 'degraded';
  /**
   * Readiness (#997): true once the startup terminal-session reconcile has
   * completed. Distinct from `status` (process liveness) — after a Tower
   * restart, `/api/state` only reflects the full role→terminalId mapping once
   * `ready` is true. Optional for back-compat with older Tower builds that
   * predate the field.
   */
  ready?: boolean;
  uptime: number;
  activeWorkspaces: number;
  totalWorkspaces: number;
  memoryUsage: number;
  /**
   * Issue #1227: total RSS (KB) of every shellper process in this Tower
   * instance's scope plus their direct children — the real OS-level memory
   * cost of the process fleet, as opposed to `memoryUsage` (Tower's own V8
   * heap). Includes not-yet-swept husks, since the point is surfacing the
   * true cost regardless of registration state. Omitted (not `undefined`)
   * when the underlying `ps` scan or DB read fails — a fleet-accounting
   * hiccup never fails `/health` itself. Optional for back-compat with older
   * Tower builds that predate the field.
   */
  fleetRssKb?: number;
  /**
   * Issue #1227: count of in-scope shellper processes not currently tracked
   * in `terminal_sessions` — a lighter, ungated signal than the husk-sweep
   * predicate (no childless/aged requirement), purely informational. Same
   * omit-on-failure and back-compat notes as `fleetRssKb`.
   */
  unregisteredShellperCount?: number;
  timestamp: string;
}

/** Issue #1227: a shellper the husk sweep would reap (or has reaped). */
export interface HuskCandidate {
  pid: number;
  rssKb: number;
  /** Milliseconds since the shellper process started, or null if undeterminable. */
  ageMs: number | null;
}

export interface HuskPreview {
  candidates: HuskCandidate[];
  /** The grace period (ms) that gated this preview — same value the sweep itself uses. */
  graceMs: number;
}

export interface HuskSweepResult {
  swept: number;
  pids: number[];
}

export interface TowerTunnelStatus {
  registered: boolean;
  state: string;
  uptime: number | null;
  towerId: string | null;
  towerName: string | null;
  serverUrl: string | null;
  accessUrl: string | null;
}

export interface TowerStatus {
  instances?: Array<{ workspaceName: string; running: boolean; terminals: unknown[] }>;
}

export interface TowerTerminal {
  id: string;
  pid: number;
  cols: number;
  rows: number;
  label: string;
  status: 'running' | 'exited';
  createdAt: string;
  wsPath: string;
}

// ── Client Options ─────────────────────────────────────────────

export interface TowerClientOptions {
  port?: number;
  host?: string;
  /** Injectable auth key provider. Defaults to ensureLocalKey() from disk. */
  getAuthKey?: () => string | null;
}

// ── Client ─────────────────────────────────────────────────────

import { encodeWorkspacePath } from './workspace.js';

export class TowerClient {
  private readonly baseUrl: string;
  private readonly getAuthKey: () => string | null;

  constructor(portOrOptions?: number | TowerClientOptions) {
    const options: TowerClientOptions = typeof portOrOptions === 'number'
      ? { port: portOrOptions }
      : portOrOptions ?? {};
    const host = options.host ?? process.env.BRIDGE_TOWER_HOST ?? 'localhost';
    const port = options.port ?? DEFAULT_TOWER_PORT;
    this.baseUrl = `http://${host}:${port}`;
    this.getAuthKey = options.getAuthKey ?? ensureLocalKey;
  }

  async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
    try {
      const authKey = this.getAuthKey();
      const headers: Record<string, string> = {
        ...options.headers as Record<string, string>,
        'Content-Type': 'application/json',
      };
      if (authKey) {
        headers['codev-web-key'] = authKey;
      }

      const response = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const text = await response.text();
        let error: string;
        try {
          const json = JSON.parse(text);
          error = json.error || json.message || text;
        } catch {
          error = text;
        }
        return { ok: false, status: response.status, error };
      }

      if (response.status === 204) {
        return { ok: true, status: 204 };
      }

      const data = (await response.json()) as T;
      return { ok: true, status: response.status, data };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('ECONNREFUSED')) {
        return { ok: false, status: 0, error: 'Tower not running' };
      }
      if (message.includes('timeout')) {
        return { ok: false, status: 0, error: 'Request timeout' };
      }
      return { ok: false, status: 0, error: message };
    }
  }

  async isRunning(): Promise<boolean> {
    const result = await this.request<TowerHealth>('/health');
    return result.ok && result.data?.status === 'healthy';
  }

  async getHealth(): Promise<TowerHealth | null> {
    const result = await this.request<TowerHealth>('/health');
    return result.ok ? result.data! : null;
  }

  /**
   * Probe the *running* Tower process's version (#983, `GET /api/version`).
   *
   * Returns the raw request result rather than a bare `TowerVersionInfo | null`
   * so the caller can tell the cases apart: `status === 404` means the Tower is
   * too old to expose the endpoint (a divergence signal in its own right),
   * while `status === 0` means unreachable. Keeping that distinction here would
   * bake preflight policy into the wire client — the VS Code preflight owns the
   * interpretation.
   */
  async getVersion(): Promise<{ ok: boolean; status: number; data?: TowerVersionInfo; error?: string }> {
    return this.request<TowerVersionInfo>('/api/version');
  }

  /**
   * Issue #1227: preview which shellpers the husk sweep would reap, without
   * killing anything. Backs `afx tower sweep-husks`'s default (no-flags) mode.
   */
  async findHuskCandidates(): Promise<HuskPreview | null> {
    const result = await this.request<HuskPreview>('/api/shellpers/husks');
    return result.ok ? result.data! : null;
  }

  /**
   * Issue #1227: actually reap the current husk candidates. Backs `afx tower
   * sweep-husks --apply`.
   */
  async sweepHusks(): Promise<HuskSweepResult | null> {
    const result = await this.request<HuskSweepResult>('/api/shellpers/husks/sweep', { method: 'POST' });
    return result.ok ? result.data! : null;
  }

  async listWorkspaces(): Promise<TowerWorkspace[]> {
    const result = await this.request<{ workspaces: TowerWorkspace[] }>('/api/workspaces');
    return result.ok ? result.data!.workspaces : [];
  }

  async activateWorkspace(
    workspacePath: string
  ): Promise<{ ok: boolean; adopted?: boolean; error?: string }> {
    const encoded = encodeWorkspacePath(workspacePath);
    const result = await this.request<{ success: boolean; adopted?: boolean; error?: string }>(
      `/api/workspaces/${encoded}/activate`,
      { method: 'POST' }
    );

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    return {
      ok: result.data?.success ?? true,
      adopted: result.data?.adopted,
      error: result.data?.error,
    };
  }

  /**
   * Register a new named architect terminal in an active workspace (Spec 755).
   *
   * Without `name`, Tower auto-assigns the next available `architect-<N>`
   * (smallest unused integer ≥ 2). With `name`, the value is validated against
   * `[a-z][a-z0-9-]*` (max 64 chars) and rejected with a 4xx if the name is
   * already in use or malformed.
   */
  async addArchitect(
    workspacePath: string,
    name?: string,
  ): Promise<{ ok: boolean; name?: string; terminalId?: string; error?: string }> {
    const encoded = encodeWorkspacePath(workspacePath);
    // Spec 755: distinguish `undefined` (auto-number) from `""` (server
    // must reject as invalid). Truthiness check would swallow the empty
    // string and silently auto-number — wrong. Send the name iff it was
    // explicitly supplied.
    const body = name === undefined ? {} : { name };
    const result = await this.request<{ success: boolean; name?: string; terminalId?: string; error?: string }>(
      `/api/workspaces/${encoded}/architects`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    return {
      ok: result.data?.success ?? false,
      name: result.data?.name,
      terminalId: result.data?.terminalId,
      error: result.data?.error,
    };
  }

  /**
   * Spec 786: remove a named sibling architect from a workspace.
   *
   * REST: `DELETE /api/workspaces/:encoded/architects/:name`. The name is URI-
   * encoded in the path. `main` is rejected server-side (and validated
   * client-side by the CLI before this call). Removing an architect with
   * in-flight builders is permitted — those builders fall back to `main`
   * routing via the existing `tower-messages.ts:336` chain (OQ-A).
   */
  async removeArchitect(
    workspacePath: string,
    name: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const encodedWorkspace = encodeWorkspacePath(workspacePath);
    const encodedName = encodeURIComponent(name);
    const result = await this.request<{ success: boolean; error?: string }>(
      `/api/workspaces/${encodedWorkspace}/architects/${encodedName}`,
      { method: 'DELETE' },
    );

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    return {
      ok: result.data?.success ?? false,
      error: result.data?.error,
    };
  }

  async deactivateWorkspace(
    workspacePath: string
  ): Promise<{ ok: boolean; stopped?: number[]; error?: string }> {
    const encoded = encodeWorkspacePath(workspacePath);
    const result = await this.request<{ success: boolean; stopped?: number[]; error?: string }>(
      `/api/workspaces/${encoded}/deactivate`,
      { method: 'POST' }
    );

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    return {
      ok: result.data?.success ?? true,
      stopped: result.data?.stopped,
      error: result.data?.error,
    };
  }

  async getWorkspaceStatus(workspacePath: string): Promise<TowerWorkspaceStatus | null> {
    const encoded = encodeWorkspacePath(workspacePath);
    const result = await this.request<TowerWorkspaceStatus>(`/api/workspaces/${encoded}/status`);
    return result.ok ? result.data! : null;
  }

  async getOverview(workspacePath?: string): Promise<OverviewData | null> {
    const query = workspacePath ? `?workspace=${encodeURIComponent(workspacePath)}` : '';
    const result = await this.request<OverviewData>(`/api/overview${query}`);
    return result.ok ? result.data! : null;
  }

  /**
   * Fetch a single issue's title/body/state/comments via Tower's
   * forge-backed GET /api/issue. Returns null if the issue can't be
   * resolved (forge unavailable, bad number) so callers can degrade.
   */
  async getIssue(issueNumber: string, workspacePath?: string): Promise<IssueView | null> {
    const params = new URLSearchParams({ number: issueNumber });
    if (workspacePath) { params.set('workspace', workspacePath); }
    const result = await this.request<IssueView>(`/api/issue?${params.toString()}`);
    return result.ok ? result.data! : null;
  }

  /**
   * Fetch the searchable issue dataset (incl. body) from Tower's
   * GET /api/issue-search. Powers the VSCode "Search Backlog" panel,
   * which filters/sorts the returned rows host-side. `state` selects the
   * issue set (default `open` = the sidebar backlog; `closed`/`all` lift
   * the PR-exclusion). Returns null on transport failure so callers degrade.
   */
  async searchIssues(
    workspacePath?: string,
    state?: 'open' | 'closed' | 'all',
  ): Promise<IssueSearchResponse | null> {
    const params = new URLSearchParams();
    if (workspacePath) { params.set('workspace', workspacePath); }
    if (state) { params.set('state', state); }
    const qs = params.toString();
    const result = await this.request<IssueSearchResponse>(
      `/api/issue-search${qs ? `?${qs}` : ''}`,
    );
    return result.ok ? result.data! : null;
  }

  /**
   * Fetch the canonical resolved worktree config (defaults / cache /
   * global / project / project-local layers, deep-merged) from Tower's
   * GET /api/worktree-config. The single source of truth for any client
   * that needs to act on `.codev/config(.local).json` — e.g. the VSCode
   * "Open Dev URL" surface — without parsing or merging the files
   * locally. Tower lazily installs a directory watcher on first call;
   * subsequent edits fan out a `codev-config-updated` SSE event so
   * subscribed clients refetch and re-render. Returns null on failure
   * so callers can degrade.
   */
  async getWorktreeConfig(workspacePath?: string): Promise<ResolvedWorktreeConfig | null> {
    const query = workspacePath ? `?workspace=${encodeURIComponent(workspacePath)}` : '';
    const result = await this.request<ResolvedWorktreeConfig>(`/api/worktree-config${query}`);
    return result.ok ? result.data! : null;
  }

  /**
   * Resolved `activityHooks` from Tower's GET /api/activity-hooks. Single source of
   * truth for the extension's activity hooks — no local file parsing. SECURITY: Tower
   * resolves these from the PERSONAL config layers only (`~/.codev/config.json` +
   * `.codev/config.local.json`), never the committed `.codev/config.json` — hooks open
   * URLs, so a committed hook would be a zero-click RCE (do NOT widen to loadConfig).
   * Shares the config-file watcher with worktree-config, so a `.codev/config(.local).json`
   * edit fans out a `codev-config-updated` SSE and subscribed clients refetch. Null on failure.
   */
  async getActivityHooks(workspacePath?: string): Promise<ResolvedActivityHooks | null> {
    const query = workspacePath ? `?workspace=${encodeURIComponent(workspacePath)}` : '';
    const result = await this.request<ResolvedActivityHooks>(`/api/activity-hooks${query}`);
    return result.ok ? result.data! : null;
  }

  /**
   * Invalidate Tower's in-memory overview cache and broadcast an
   * `overview-changed` SSE event. Subscribed clients (VSCode sidebar,
   * dashboard) re-fetch /api/overview on any SSE event, so this is
   * what makes them notice out-of-band mutations to builder state —
   * e.g., `afx cleanup` invoked from a shell or the architect. Without
   * it, the change is invisible to clients until some other SSE event
   * happens to fire. Best-effort: returns false if Tower isn't running.
   */
  async refreshOverview(): Promise<boolean> {
    const result = await this.request<{ ok: boolean }>('/api/overview/refresh', { method: 'POST' });
    return result.ok;
  }

  async getWorkspaceState(workspacePath: string): Promise<DashboardState | null> {
    const encoded = encodeWorkspacePath(workspacePath);
    const result = await this.request<DashboardState>(`/workspace/${encoded}/api/state`);
    return result.ok ? result.data! : null;
  }

  async createShellTab(workspacePath: string): Promise<{ id: string; name: string; terminalId: string } | null> {
    const encoded = encodeWorkspacePath(workspacePath);
    const result = await this.request<{ id: string; name: string; terminalId: string }>(
      `/workspace/${encoded}/api/tabs/shell`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    return result.ok ? result.data! : null;
  }

  async createTerminal(options: {
    command?: string;
    args?: string[];
    cols?: number;
    rows?: number;
    cwd?: string;
    label?: string;
    env?: Record<string, string>;
    persistent?: boolean;
    workspacePath?: string;
    type?: TerminalType;
    roleId?: string;
    seedKick?: SeedKickRequest;
  }): Promise<TowerTerminal | null> {
    const result = await this.request<TowerTerminal>('/api/terminals', {
      method: 'POST',
      body: JSON.stringify(options),
    });
    return result.ok ? result.data! : null;
  }

  async listTerminals(): Promise<TowerTerminal[]> {
    const result = await this.request<{ terminals: TowerTerminal[] }>('/api/terminals');
    return result.ok ? result.data!.terminals : [];
  }

  async getTerminal(terminalId: string): Promise<TowerTerminal | null> {
    const result = await this.request<TowerTerminal>(`/api/terminals/${terminalId}`);
    return result.ok ? result.data! : null;
  }

  async writeTerminal(terminalId: string, data: string): Promise<boolean> {
    const result = await this.request(`/api/terminals/${terminalId}/write`, {
      method: 'POST',
      body: JSON.stringify({ data }),
    });
    return result.ok;
  }

  async killTerminal(terminalId: string): Promise<boolean> {
    const result = await this.request(`/api/terminals/${terminalId}`, { method: 'DELETE' });
    return result.ok;
  }

  async resizeTerminal(
    terminalId: string,
    cols: number,
    rows: number
  ): Promise<TowerTerminal | null> {
    const result = await this.request<TowerTerminal>(`/api/terminals/${terminalId}/resize`, {
      method: 'POST',
      body: JSON.stringify({ cols, rows }),
    });
    return result.ok ? result.data! : null;
  }

  async renameTerminal(
    sessionId: string,
    name: string,
  ): Promise<{ ok: boolean; status: number; data?: { id: string; name: string }; error?: string }> {
    return this.request<{ id: string; name: string }>(`/api/terminals/${sessionId}/rename`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
  }

  /**
   * Upload a clipboard image to Tower and get back a temp file path.
   *
   * Deliberately does NOT route through request<T>(): that helper force-sets
   * `Content-Type: application/json` after spreading options.headers, so a
   * binary content-type can't pass through. This mirrors request()'s auth
   * (codev-web-key), timeout, and error-normalization for a raw binary body.
   */
  async pasteImage(
    workspacePath: string,
    bytes: Buffer,
    mime: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }> {
    try {
      const authKey = this.getAuthKey();
      const headers: Record<string, string> = { 'Content-Type': mime };
      if (authKey) {
        headers['codev-web-key'] = authKey;
      }
      // Buffer isn't reliably assignable to fetch's BodyInit across
      // @types/node lib versions; an ArrayBuffer slice always is.
      const body = bytes.buffer.slice(
        bytes.byteOffset, bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      // The paste-image handler is workspace-scoped (same router as
      // /workspace/<enc>/api/state) — a global /api/paste-image has no route.
      const encoded = encodeWorkspacePath(workspacePath);
      const response = await fetch(`${this.baseUrl}/workspace/${encoded}/api/paste-image`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        const text = await response.text();
        let error: string;
        try {
          const json = JSON.parse(text);
          error = json.error || json.message || text;
        } catch {
          error = text;
        }
        return { ok: false, error };
      }
      const data = (await response.json()) as { path: string };
      return { ok: true, path: data.path };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('ECONNREFUSED')) {
        return { ok: false, error: 'Tower not running' };
      }
      if (message.includes('timeout')) {
        return { ok: false, error: 'Request timeout' };
      }
      return { ok: false, error: message };
    }
  }

  getWorkspaceUrl(workspacePath: string): string {
    const encoded = encodeWorkspacePath(workspacePath);
    return `${this.baseUrl}/workspace/${encoded}/`;
  }

  async sendMessage(
    to: string,
    message: string,
    options?: {
      from?: string;
      workspace?: string;
      fromWorkspace?: string;
      raw?: boolean;
      noEnter?: boolean;
      interrupt?: boolean;
    },
  ): Promise<{ ok: boolean; resolvedTo?: string; error?: string }> {
    const result = await this.request<{ ok: boolean; resolvedTo: string }>(
      '/api/send',
      {
        method: 'POST',
        body: JSON.stringify({
          to,
          message,
          from: options?.from,
          workspace: options?.workspace,
          fromWorkspace: options?.fromWorkspace,
          options: {
            raw: options?.raw,
            noEnter: options?.noEnter,
            interrupt: options?.interrupt,
          },
        }),
      },
    );

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    return { ok: true, resolvedTo: result.data!.resolvedTo };
  }

  async signalTunnel(action: 'connect' | 'disconnect'): Promise<void> {
    await this.request(`/api/tunnel/${action}`, { method: 'POST' }).catch(() => {});
  }

  async getTunnelStatus(): Promise<TowerTunnelStatus | null> {
    const result = await this.request<TowerTunnelStatus>('/api/tunnel/status');
    return result.ok ? result.data! : null;
  }

  async getStatus(): Promise<TowerStatus | null> {
    const result = await this.request<TowerStatus>('/api/status');
    return result.ok ? result.data! : null;
  }

  async sendNotification(payload: {
    type: string;
    title: string;
    body: string;
    workspace: string;
  }): Promise<boolean> {
    const result = await this.request('/api/notify', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return result.ok;
  }

  getTerminalWsUrl(terminalId: string): string {
    return `ws://localhost:${new URL(this.baseUrl).port}/ws/terminal/${terminalId}`;
  }
}

// ── Default client ─────────────────────────────────────────────

let defaultClient: TowerClient | null = null;

export function getTowerClient(port?: number): TowerClient {
  if (!defaultClient || (port && port !== DEFAULT_TOWER_PORT)) {
    defaultClient = new TowerClient({ port });
  }
  return defaultClient;
}
