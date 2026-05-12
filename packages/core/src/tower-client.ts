/**
 * Tower API Client
 *
 * Provides a client for interacting with the Tower daemon.
 * Handles authentication and common API operations.
 *
 * Extracted from packages/codev/src/agent-farm/lib/tower-client.ts
 */

import type { DashboardState, OverviewData } from '@cluesmith/codev-types';
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
  }>;
}

export interface TowerHealth {
  status: 'healthy' | 'degraded';
  uptime: number;
  activeWorkspaces: number;
  totalWorkspaces: number;
  memoryUsage: number;
  timestamp: string;
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
