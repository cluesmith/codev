/**
 * Tower API Client
 *
 * Provides a client for interacting with the Tower daemon.
 * Handles authentication and common API operations.
 *
 * Environment-agnostic (issue #1189): runs unmodified in browser, Node, and
 * React Native. Auth and transport arrive as injected adapters; there is no
 * disk, environment, or fetch-implementation assumption in this module. Node
 * consumers that want the local-key default compose it themselves (the CLI
 * wrapper in packages/codev injects `ensureLocalKey`; the VS Code extension
 * injects its SecretStorage-cached reader; `@cluesmith/codev-sdk/node` offers
 * the read-only reader for standalone Node controllers).
 */

import type { DashboardState, OverviewData, IssueView, PRView, IssueSearchResponse, ResolvedWorktreeConfig, ResolvedActivityHooks, TowerVersionInfo, CommandRequest, CanvasCommand, CanvasCommandRequest, CanvasCommandResult, CanvasCommandClientResult, CanvasCommandErrorCode } from '@cluesmith/codev-types';
import { DEFAULT_TOWER_PORT } from './constants.js';
import { parseSseText, type SseEnvelope } from './sse.js';

/*
 * `getOverview` returns `OverviewData`, so the subpath carries the contract
 * with the client (issue #1357). `export type` only — erased at build, keeping
 * the zero-runtime-deps posture; the import-boundary test pins the form.
 */
export type { OverviewData } from '@cluesmith/codev-types';

const REQUEST_TIMEOUT_MS = 10000;

/**
 * The command-relay route. Mirrors `COMMAND_ROUTE` in `@cluesmith/codev-types`
 * (the provider side) rather than importing it: the sdk's zero-runtime-deps
 * contract keeps codev-types type-only, and the mirror is one string literal.
 * Recorded in issue #1189; the boundary test enforces the type-only rule.
 */
export const COMMAND_ROUTE = '/api/command';

/**
 * The canvas command channel (spec 1401). Mirrored from `@cluesmith/codev-types` for the same
 * reason as `COMMAND_ROUTE` above.
 *
 * Separate from the command relay on purpose: that one broadcasts a verb and answers `ok`
 * regardless, while this one resolves a single target view and reports which — or that none is
 * open, which is the whole point of the channel.
 */
export const CANVAS_COMMAND_ROUTE = '/api/canvas/command';
/** Host-side view lifecycle: register, heartbeat, unregister. */
export const CANVAS_VIEWS_ROUTE = '/api/canvas/views';

/**
 * The failure codes Tower itself can answer with. Mirrored from `CanvasCommandErrorCode` (the
 * sdk keeps codev-types type-only), and pinned to it by the assertion below so a code added to
 * the contract cannot silently go unrecognized here — an unrecognized code is treated as an
 * unreadable answer, which would turn a real Tower verdict into a spurious `unreachable`.
 */
const CANVAS_WIRE_ERROR_CODES = ['no-canvas', 'invalid-request'] as const;

/** Fails to instantiate unless the mirror above covers the contract exactly. */
type AssertTrue<T extends true> = T;
type _WireCodesMatchContract = AssertTrue<
  [Exclude<CanvasCommandErrorCode, (typeof CANVAS_WIRE_ERROR_CODES)[number]>] extends [never]
    ? true
    : false
>;

/**
 * Validate a canvas command response against the wire contract.
 *
 * Checking only for an `ok` field would let `{ok:true}` with no target, or a failure carrying an
 * unknown code, pass through as a typed result — the caller would then read `target.viewId` off
 * undefined, or switch on a code that is not in its union. A response we cannot fully verify is
 * not a verdict, so it is reported as unreadable instead.
 */
function parseCanvasCommandResult(body: unknown): CanvasCommandResult | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;

  if (raw.ok === true) {
    const target = raw.target as Record<string, unknown> | undefined;
    if (!target || typeof target !== 'object') return null;
    if (typeof target.viewId !== 'string' || typeof target.file !== 'string') return null;
    return { ok: true, target: { viewId: target.viewId, file: target.file } };
  }

  if (raw.ok === false) {
    if (typeof raw.code !== 'string') return null;
    if (!(CANVAS_WIRE_ERROR_CODES as readonly string[]).includes(raw.code)) return null;
    let error = 'Canvas command failed';
    if (typeof raw.error === 'string') error = raw.error;
    return { ok: false, code: raw.code as CanvasCommandErrorCode, error };
  }

  return null;
}

// ── Types ──────────────────────────────────────────────────────

/**
 * All terminal kinds Tower can host. Used wherever a terminal is created or
 * enumerated. `'dev'` is the ephemeral dev-server PTY spawned by `afx dev`;
 * it is intentionally kept out of SQLite by the runtime filter at
 * `tower-routes.ts` (search for `['builder', 'shell'].includes(body.type)`).
 */
export type TerminalType = 'architect' | 'builder' | 'shell' | 'dev';

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
  /**
   * Epoch ms of the last PTY output (Spec 1273). Lets a client measure output
   * quiescence — an agent mid-turn emits continuously, so a stretch with no
   * advance means the turn ended. Optional: terminals served by an older Tower
   * omit it, and a consumer that needs it must say so rather than assume 0.
   */
  lastDataAt?: number;
  /**
   * Whether input can actually reach the process right now (Spec 1273).
   *
   * Distinct from `status`, and they disagree in the case that matters: a
   * session whose shellper connection died reports `status: 'running'` while
   * every write to it is dropped (#1198). Optional for the same reason
   * `lastDataAt` is — an older Tower omits it, and a consumer that needs it
   * must handle absence rather than assume `false`.
   */
  writable?: boolean;
}

// ── Client Options ─────────────────────────────────────────────

export interface TowerClientOptions {
  port?: number;
  host?: string;
  /**
   * Injectable auth key provider. Defaults to no auth (requests carry no
   * `codev-tower-key` header). Consumers entitled to the local key inject a
   * reader; see the module header for the per-environment profiles.
   */
  getAuthKey?: () => string | null;
  /**
   * Injectable transport (the test seam and the environment seam). Defaults
   * to the global fetch, which exists in browsers, Node 18+, and React Native.
   */
  fetchFn?: typeof fetch;
}

// ── Client ─────────────────────────────────────────────────────

import { encodeWorkspacePath } from './workspace.js';

/**
 * Extract a human-facing error string from a Tower error response body (#1333).
 *
 * Tower error responses carry a machine `error` code and, for many cases, a
 * human-readable `message` explaining *why* (e.g. the builder spoofing guard:
 * "builder <id> may only address its own spawning architect"). The previous
 * extraction preferred the bare code and discarded the message, so the CLI
 * surfaced an opaque `NOT_FOUND` with no reason. Surface the descriptive
 * message when present, keeping the code as a parenthetical suffix so both the
 * human reason and the machine code reach the caller. Falls back to the code
 * alone, then to the raw (non-JSON) body text.
 */
function extractTowerError(text: string): string {
  try {
    const json = JSON.parse(text) as { error?: unknown; message?: unknown };
    const code = typeof json.error === 'string' ? json.error : undefined;
    const detail = typeof json.message === 'string' ? json.message : undefined;
    return detail && code && detail !== code
      ? `${detail} (${code})`
      : detail || code || text;
  } catch {
    return text;
  }
}

export class TowerClient {
  private readonly baseUrl: string;
  private readonly getAuthKey: () => string | null;
  private readonly fetchFn: typeof fetch;

  constructor(portOrOptions?: number | TowerClientOptions) {
    let options: TowerClientOptions;
    if (typeof portOrOptions === 'number') {
      options = { port: portOrOptions };
    } else {
      options = portOrOptions ?? {};
    }
    const host = options.host ?? 'localhost';
    const port = options.port ?? DEFAULT_TOWER_PORT;
    this.baseUrl = `http://${host}:${port}`;
    this.getAuthKey = options.getAuthKey ?? (() => null);
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
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
        headers['codev-tower-key'] = authKey;
      }

      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        ...options,
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const text = await response.text();
        const error = extractTowerError(text);
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
   * Fetch a single PR's title/state/url via Tower's forge-backed
   * GET /api/pr — the PR counterpart of getIssue. Returns null if the PR
   * can't be resolved (forge unavailable, bad number) so callers can
   * degrade.
   */
  async getPR(prNumber: string, workspacePath?: string): Promise<PRView | null> {
    const params = new URLSearchParams({ number: prNumber });
    if (workspacePath) { params.set('workspace', workspacePath); }
    const result = await this.request<PRView>(`/api/pr?${params.toString()}`);
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

  /**
   * Recent PTY output for a terminal (Spec 1273).
   *
   * The `/output` route has existed since the terminal manager was written; it
   * simply had no client binding. Reset uses it for the best-effort `/clear`
   * confirmation — without it that check can never succeed outside tests, and
   * every real run would report the clear as unconfirmed while looking like it
   * had tried.
   */
  async getTerminalOutput(
    terminalId: string,
    lines = 100,
  ): Promise<{ lines: string[]; total: number; hasMore: boolean } | null> {
    const result = await this.request<{ lines: string[]; total: number; hasMore: boolean }>(
      `/api/terminals/${terminalId}/output?lines=${lines}`,
    );
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
   * (codev-tower-key), timeout, and error-normalization for a raw binary body.
   */
  async pasteImage(
    workspacePath: string,
    bytes: Uint8Array,
    mime: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }> {
    try {
      const authKey = this.getAuthKey();
      const headers: Record<string, string> = { 'Content-Type': mime };
      if (authKey) {
        headers['codev-tower-key'] = authKey;
      }
      // A typed-array view isn't reliably assignable to fetch's BodyInit
      // across lib versions; an ArrayBuffer slice always is.
      const body = bytes.buffer.slice(
        bytes.byteOffset, bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      // The paste-image handler is workspace-scoped (same router as
      // /workspace/<enc>/api/state) — a global /api/paste-image has no route.
      const encoded = encodeWorkspacePath(workspacePath);
      const response = await this.fetchFn(`${this.baseUrl}/workspace/${encoded}/api/paste-image`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        const text = await response.text();
        const error = extractTowerError(text);
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
      /**
       * Spec 1273: deliver the message as a bare ESC keystroke (`\x1b`) written
       * straight to the PTY — no formatting, no send-buffer deferral. This is the
       * verified mid-turn recovery: ESC ends the running turn so queued messages
       * can process. Distinct from `interrupt`, which sends Ctrl+C (`\x03`).
       */
      escape?: boolean;
      /**
       * Spec 1307: hold the message in Tower and deliver it after this many
       * seconds. Resolution and authorization still happen at request time —
       * only delivery is deferred.
       *
       * Tower-side rather than a sleeping client because the caller may be the
       * session being written to: `/arch-save` sends its own `/clear` and then a
       * delayed `/arch-init`, and the process issuing them does not survive the
       * clear. Spec 1313 round 3: the row is PERSISTED at request time with a
       * `not_before` due time, so the delay is durable across a Tower restart and
       * the pending send is listable/cancellable via `afx inbox`.
       */
      deliverAfter?: number;
    },
  ): Promise<{
    ok: boolean;
    resolvedTo?: string;
    /** Tower is holding this for later delivery (`deliverAfter`). */
    scheduled?: boolean;
    /** Tower buffered this because the user was typing (Spec 403). */
    deferred?: boolean;
    error?: string;
    /**
     * Spec 1313 mailbox-first delivery. `delivered` = written to the PTY now;
     * `held` = persisted to the durable mailbox and awaiting a clean prompt
     * (`reason` says why: `busy` | `no-profile` | `no-live-pty`), with `mailboxId`
     * the row id. Older Tower binaries omit all four — a bare `{ ok, resolvedTo }`
     * response then reads as delivered (`held` undefined), preserving behavior.
     */
    delivered?: boolean;
    held?: boolean;
    reason?: string;
    /**
     * Issue #1482: the render gate's detail behind a `busy` reason —
     * `'user-text'` (a draft or menu occupies the composer; a human is at the line and the
     * hold clears by itself) vs `'no-region-end'` / `'no-composer-marker'` (the classifier
     * could not verify the composer at all — a drifted profile, a torn frame, or Tower's
     * dimensions diverging from the real PTY, and this hold does NOT clear on its own).
     * Absent/null for a non-gate hold and from older Tower binaries.
     */
    detail?: string;
    mailboxId?: string;
    /**
     * Issue #1365: an `interrupt`/`escape` submission that gave up waiting for the terminal's
     * submission lock and wrote UNSERIALIZED, so its bytes may have interleaved with the
     * delivery write it skipped. Present only when it happened; absent means normally
     * serialized. It matters most for `interrupt`, whose mailbox row is claimed `delivered`
     * BEFORE the write (un-claiming would risk a double delivery), so `delivered: true` alone
     * would otherwise be an unqualified success for a possibly-mangled body.
     */
    degraded?: boolean;
    /** Machine-readable companion to {@link degraded} (`submit-wait-ceiling-expired`). */
    degradedReason?: string;
    /**
     * Spec 1313 round 3: due time (epoch ms) of a scheduled (`deliverAfter`) send. Present
     * only when `scheduled` — the row is persisted at request time and delivers not before
     * this instant. Omitted by older Tower binaries.
     */
    notBefore?: number;
    /**
     * Issue #1573: the exact byte length Tower accepted for this message body. Echoed back so
     * the sender can see WHAT was sent, not just that a send happened — the failures behind
     * this field (#1564) all looked like unqualified successes at the sender. Omitted by older
     * Tower binaries.
     */
    bodyLength?: number;
    /**
     * Issue #1584: whether the delivered message's header was actually SEEN on the receiving
     * terminal. `false` = the bytes were written and accepted, but the terminal never showed
     * them — the message is recorded as delivered and flagged, and is deliberately NOT
     * re-written (re-writing is what re-injected one message dozens of times in #1583).
     * Absent = verification was skipped or does not apply; older Tower binaries omit it, and
     * absent reads exactly as `true` always did.
     */
    verified?: boolean;
    /**
     * Issue #1473: why a delivered message could not be confirmed. `'input-raced'` — the
     * terminal received human input while the body was going out, so it may have been truncated
     * (`^U`/`^W`/`^C`) or submitted early (their Enter); `'no-echo'` — the write completed but
     * the header never appeared. Absent means confirmed, or not verifiable in the first place.
     *
     * Present alongside {@link verified} rather than folded into it, because the raced case
     * frequently reports `verified: true` — the HEADER landed; it was the tail that was lost —
     * which is exactly why that case used to reach the sender as an unqualified success. Older
     * Tower binaries omit it.
     */
    unverifiedCause?: 'no-echo' | 'input-raced';
  }> {
    const result = await this.request<{
      ok: boolean;
      resolvedTo: string;
      scheduled?: boolean;
      deferred?: boolean;
      delivered?: boolean;
      held?: boolean;
      reason?: string | null;
      detail?: string | null;
      mailboxId?: string;
      degraded?: boolean;
      degradedReason?: string;
      notBefore?: number;
      bodyLength?: number;
      verified?: boolean;
      unverifiedCause?: 'no-echo' | 'input-raced';
    }>(
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
            escape: options?.escape,
            deliverAfter: options?.deliverAfter,
          },
        }),
      },
    );

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    return {
      ok: true,
      resolvedTo: result.data!.resolvedTo,
      scheduled: result.data!.scheduled === true,
      deferred: result.data!.deferred === true,
      delivered: result.data!.delivered,
      held: result.data!.held,
      reason: result.data!.reason ?? undefined,
      detail: result.data!.detail ?? undefined,
      mailboxId: result.data!.mailboxId,
      degraded: result.data!.degraded,
      degradedReason: result.data!.degradedReason,
      notBefore: result.data!.notBefore,
      bodyLength: result.data!.bodyLength,
      verified: result.data!.verified,
      unverifiedCause: result.data!.unverifiedCause,
    };
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

  /**
   * POST /api/command: ask the active provider to run a canonical verb.
   * `workspace` (when known) scopes it so a multi-workspace Tower routes to
   * the right provider. Lifted from `@cluesmith/codev-client` (issue #1189
   * absorption); this client owns the controller side of the command relay.
   */
  async sendCommand(
    verb: string,
    args: unknown[] = [],
    workspace?: string,
  ): Promise<{ ok: boolean; status: number; data?: { ok: boolean }; error?: string }> {
    const body: CommandRequest = { verb, args };
    if (workspace) {
      body.workspace = workspace;
    }
    return this.request<{ ok: boolean }>(COMMAND_ROUTE, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * Like `request`, but keeps the parsed body on a non-2xx response.
   *
   * `request` runs failures through `extractTowerError`, which reduces the body to a message and
   * discards everything else. The canvas channel answers with a machine-readable `code`, and a
   * controller has to act on it (render "no canvas open" versus "Tower is down"), so that code
   * must survive the trip. Never throws: a transport failure comes back as `status: 0`, matching
   * the never-reject invariant the rest of this client holds.
   */
  private async requestPreservingBody(
    path: string,
    options: RequestInit = {},
  ): Promise<{ status: number; body: unknown; error?: string }> {
    try {
      const authKey = this.getAuthKey();
      const headers: Record<string, string> = {
        ...(options.headers as Record<string, string>),
        'Content-Type': 'application/json',
      };
      if (authKey) {
        headers['codev-tower-key'] = authKey;
      }
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        ...options,
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null; // an unparseable body is reported by the caller as an unusable answer
      }
      return { status: response.status, body };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('ECONNREFUSED')) return { status: 0, body: null, error: 'Tower not running' };
      if (message.includes('timeout')) return { status: 0, body: null, error: 'Request timeout' };
      return { status: 0, body: null, error: message };
    }
  }

  /**
   * POST /api/canvas/command: drive one open artifact-canvas view (spec 1401).
   *
   * `target.workspace` is required and scopes the lookup; `target.file` narrows to one document,
   * and omitting it targets the workspace's most recently active view. `options.count` repeats a
   * traversal command and is rejected by Tower on any other.
   *
   * Never rejects. A resolved promise always carries Tower's verdict, except for `unreachable`,
   * which this client synthesizes when there was no answer at all — that distinction is the
   * reason the call exists in this shape, since "no canvas is open" and "Tower is down" must not
   * look alike to a controller.
   */
  async sendCanvasCommand(
    command: CanvasCommand,
    target: { workspace: string; file?: string },
    options?: { count?: number },
  ): Promise<CanvasCommandClientResult> {
    const payload: CanvasCommandRequest = { workspace: target.workspace, command };
    if (target.file !== undefined) payload.file = target.file;
    if (options?.count !== undefined) payload.count = options.count;

    const outcome = await this.requestPreservingBody(CANVAS_COMMAND_ROUTE, {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (outcome.status === 0) {
      return { ok: false, code: 'unreachable', error: outcome.error ?? 'Tower unreachable' };
    }
    const verdict = parseCanvasCommandResult(outcome.body);
    if (verdict) return verdict;
    // A response we cannot fully verify is not a verdict, so it is reported as such rather than
    // being flattened into a success or an arbitrary failure code.
    return {
      ok: false,
      code: 'unreachable',
      error: `Unreadable response from Tower (HTTP ${outcome.status})`,
    };
  }

  /**
   * POST /api/canvas/views: a HOST registers one live canvas view and receives its Tower-minted
   * id. Host-side lifecycle, deliberately absent from the controller subpath — controllers drive
   * views, hosts own them.
   */
  async registerCanvasView(
    workspace: string,
    file: string,
  ): Promise<{ ok: boolean; viewId?: string; file?: string; error?: string }> {
    const result = await this.request<{ ok: boolean; viewId: string; file: string }>(
      CANVAS_VIEWS_ROUTE,
      { method: 'POST', body: JSON.stringify({ workspace, file }) },
    );
    if (!result.ok || !result.data) return { ok: false, error: result.error ?? 'Registration failed' };
    return { ok: true, viewId: result.data.viewId, file: result.data.file };
  }

  /**
   * POST /api/canvas/views/:viewId/heartbeat: keep a view's lease alive, and with
   * `focused: true` mark it the most recently active target.
   *
   * `unknownView` distinguishes "Tower has forgotten this id" (a restart, an expired lease) from
   * a transport problem, because the host's response to the two differs: re-register, versus try
   * again later.
   */
  async heartbeatCanvasView(
    viewId: string,
    focused?: boolean,
  ): Promise<{ ok: boolean; unknownView: boolean; error?: string }> {
    const body: { focused?: boolean } = {};
    if (focused !== undefined) body.focused = focused;
    const result = await this.request<{ ok: boolean }>(
      `${CANVAS_VIEWS_ROUTE}/${encodeURIComponent(viewId)}/heartbeat`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    if (result.ok) return { ok: true, unknownView: false };
    return { ok: false, unknownView: result.status === 404, error: result.error };
  }

  /** DELETE /api/canvas/views/:viewId: the host's view is gone. */
  async unregisterCanvasView(viewId: string): Promise<{ ok: boolean; error?: string }> {
    const result = await this.request<{ ok: boolean }>(
      `${CANVAS_VIEWS_ROUTE}/${encodeURIComponent(viewId)}`,
      { method: 'DELETE' },
    );
    if (result.ok) return { ok: true };
    return { ok: false, error: result.error };
  }

  /**
   * Subscribe to Tower's SSE stream (`/api/events`). Calls `onEnvelope` for
   * each decoded event and `onStatus(true|false)` as the connection comes up
   * or drops. Reconnects with backoff until the returned disposer is called.
   * Consumers typically ignore the event body and re-fetch overview on any
   * event (the established Tower-client pattern). `sleep` is injectable for
   * tests. Lifted from `@cluesmith/codev-client` (issue #1189 absorption).
   */
  subscribeEvents(handlers: {
    onEnvelope?: (env: SseEnvelope) => void;
    onStatus?: (online: boolean) => void;
    sleep?: (ms: number) => Promise<void>;
  }): () => void {
    const sleep = handlers.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let stopped = false;
    let abort: AbortController | null = null;

    const run = async (): Promise<void> => {
      let backoffMs = 500;
      while (!stopped) {
        abort = new AbortController();
        try {
          const authKey = this.getAuthKey();
          const headers: Record<string, string> = { Accept: 'text/event-stream' };
          if (authKey) {
            headers['codev-tower-key'] = authKey;
          }
          const res = await this.fetchFn(`${this.baseUrl}/api/events`, {
            headers,
            signal: abort.signal,
          });
          if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
          handlers.onStatus?.(true);
          backoffMs = 500;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            buffer = parseSseText(buffer, (env) => handlers.onEnvelope?.(env));
          }
        } catch {
          // fall through to reconnect
        }
        if (stopped) break;
        handlers.onStatus?.(false);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 10_000);
      }
    };

    run();
    return () => {
      stopped = true;
      abort?.abort();
    };
  }

  /** The base URL, exposed for opening browser links (e.g. a PR url) and tests. */
  get url(): string {
    return this.baseUrl;
  }
}
