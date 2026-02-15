/**
 * Tower API Client (Spec 0090 Phase 3)
 *
 * Provides a client for CLI commands to interact with the tower daemon.
 * Handles local-key authentication and common API operations.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

// Tower configuration
const DEFAULT_TOWER_PORT = 4100;
const AGENT_FARM_DIR = resolve(homedir(), '.agent-farm');
const LOCAL_KEY_PATH = resolve(AGENT_FARM_DIR, 'local-key');

// Request timeout
const REQUEST_TIMEOUT_MS = 10000;

/**
 * Workspace info returned by tower API
 */
export interface TowerWorkspace {
  path: string;
  name: string;
  active: boolean;
  proxyUrl: string;
  terminals: number;
}

/**
 * Workspace status with detailed info
 */
export interface TowerWorkspaceStatus {
  path: string;
  name: string;
  active: boolean;
  terminals: Array<{
    type: 'architect' | 'builder' | 'shell';
    id: string;
    label: string;
    url: string;
    active: boolean;
  }>;
  gateStatus?: {
    hasGate: boolean;
    gateName?: string;
    builderId?: string;
    requestedAt?: string;
  };
}

/**
 * Health status from tower
 */
export interface TowerHealth {
  status: 'healthy' | 'degraded';
  uptime: number;
  activeWorkspaces: number;
  totalWorkspaces: number;
  memoryUsage: number;
  timestamp: string;
}

/**
 * Terminal info from tower
 */
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

/**
 * Get or create the local key for CLI authentication
 */
function getLocalKey(): string {
  if (!existsSync(AGENT_FARM_DIR)) {
    mkdirSync(AGENT_FARM_DIR, { recursive: true, mode: 0o700 });
  }

  if (!existsSync(LOCAL_KEY_PATH)) {
    const key = randomBytes(32).toString('hex');
    writeFileSync(LOCAL_KEY_PATH, key, { mode: 0o600 });
    return key;
  }

  return readFileSync(LOCAL_KEY_PATH, 'utf-8').trim();
}

/**
 * Encode a workspace path for use in tower API URLs
 */
export function encodeWorkspacePath(workspacePath: string): string {
  return Buffer.from(workspacePath).toString('base64url');
}

/**
 * Decode a workspace path from tower API URL
 */
export function decodeWorkspacePath(encoded: string): string {
  return Buffer.from(encoded, 'base64url').toString('utf-8');
}

/**
 * Tower API client class
 */
export class TowerClient {
  private readonly baseUrl: string;
  private readonly localKey: string;

  constructor(port: number = DEFAULT_TOWER_PORT) {
    this.baseUrl = `http://localhost:${port}`;
    this.localKey = getLocalKey();
  }

  /**
   * Make a request to the tower API
   */
  async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers: {
          ...options.headers,
          'codev-web-key': this.localKey,
          'Content-Type': 'application/json',
        },
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

  /**
   * Check if tower is running and healthy
   */
  async isRunning(): Promise<boolean> {
    const result = await this.request<TowerHealth>('/health');
    return result.ok && result.data?.status === 'healthy';
  }

  /**
   * Get tower health status
   */
  async getHealth(): Promise<TowerHealth | null> {
    const result = await this.request<TowerHealth>('/health');
    return result.ok ? result.data! : null;
  }

  /**
   * List all workspaces known to tower
   */
  async listWorkspaces(): Promise<TowerWorkspace[]> {
    const result = await this.request<{ workspaces: TowerWorkspace[] }>('/api/workspaces');
    return result.ok ? result.data!.workspaces : [];
  }

  /**
   * Activate a workspace (start its dashboard)
   */
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
   * Deactivate a workspace (stop its dashboard)
   */
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

  /**
   * Get status of a specific workspace
   */
  async getWorkspaceStatus(workspacePath: string): Promise<TowerWorkspaceStatus | null> {
    const encoded = encodeWorkspacePath(workspacePath);
    const result = await this.request<TowerWorkspaceStatus>(`/api/workspaces/${encoded}/status`);
    return result.ok ? result.data! : null;
  }

  /**
   * Create a terminal session
   */
  async createTerminal(options: {
    command?: string;
    args?: string[];
    cols?: number;
    rows?: number;
    cwd?: string;
    label?: string;
    env?: Record<string, string>;
  }): Promise<TowerTerminal | null> {
    const result = await this.request<TowerTerminal>('/api/terminals', {
      method: 'POST',
      body: JSON.stringify(options),
    });
    return result.ok ? result.data! : null;
  }

  /**
   * List all terminal sessions
   */
  async listTerminals(): Promise<TowerTerminal[]> {
    const result = await this.request<{ terminals: TowerTerminal[] }>('/api/terminals');
    return result.ok ? result.data!.terminals : [];
  }

  /**
   * Get terminal info
   */
  async getTerminal(terminalId: string): Promise<TowerTerminal | null> {
    const result = await this.request<TowerTerminal>(`/api/terminals/${terminalId}`);
    return result.ok ? result.data! : null;
  }

  /**
   * Write data to a terminal session
   */
  async writeTerminal(terminalId: string, data: string): Promise<boolean> {
    const result = await this.request(`/api/terminals/${terminalId}/write`, {
      method: 'POST',
      body: JSON.stringify({ data }),
    });
    return result.ok;
  }

  /**
   * Kill a terminal session
   */
  async killTerminal(terminalId: string): Promise<boolean> {
    const result = await this.request(`/api/terminals/${terminalId}`, { method: 'DELETE' });
    return result.ok;
  }

  /**
   * Resize a terminal
   */
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

  /**
   * Get the tower dashboard URL for a workspace
   */
  getWorkspaceUrl(workspacePath: string): string {
    const encoded = encodeWorkspacePath(workspacePath);
    return `${this.baseUrl}/workspace/${encoded}/`;
  }

  /**
   * Send a message to an agent via address resolution.
   * Uses POST /api/send which resolves [project:]agent addresses.
   */
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

  /**
   * Get the WebSocket URL for a terminal
   */
  getTerminalWsUrl(terminalId: string): string {
    return `ws://localhost:${new URL(this.baseUrl).port}/ws/terminal/${terminalId}`;
  }
}

/**
 * Default tower client instance
 */
let defaultClient: TowerClient | null = null;

/**
 * Get the default tower client
 */
export function getTowerClient(port?: number): TowerClient {
  if (!defaultClient || (port && port !== DEFAULT_TOWER_PORT)) {
    defaultClient = new TowerClient(port);
  }
  return defaultClient;
}
