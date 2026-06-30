/**
 * Shared types for tower server modules.
 * Spec 0105: Tower Server Decomposition
 */

import type http from 'node:http';
import type { WebSocketServer } from 'ws';
import type Database from 'better-sqlite3';
import type { TerminalType } from '@cluesmith/codev-core/tower-client';
import type { TerminalManager } from '../../terminal/pty-manager.js';
import type { SessionManager } from '../../terminal/session-manager.js';
import type { TunnelClient } from '../lib/tunnel-client.js';
import type { FileTab } from '../utils/file-tabs.js';
/**
 * Shared context passed to all tower modules.
 * The orchestrator (tower-server.ts) owns lifecycle — it creates
 * dependencies in startup order and tears them down in gracefulShutdown.
 */
export interface TowerContext {
  port: number;
  log: (level: 'INFO' | 'ERROR' | 'WARN', message: string) => void;
  terminalManager: TerminalManager;
  shellperManager: SessionManager | null;
  workspaceTerminals: Map<string, WorkspaceTerminals>;
  db: () => Database.Database;
  broadcastNotification: (n: { type: string; title: string; body: string; workspace?: string }) => void;
  tunnelClient: TunnelClient | null;
  knownWorkspaces: Set<string>;
  server: http.Server;
  terminalWss: WebSocketServer;
}

/**
 * Tracks terminals belonging to a workspace.
 *
 * Spec 755: `architects` is a name-keyed collection (name → terminalId).
 * Single-architect workspaces hold one entry with name `'main'`. The plural
 * keyed access pattern catches accidental singleton-style code at the type
 * level rather than at runtime.
 */
export interface WorkspaceTerminals {
  architects: Map<string, string>;
  builders: Map<string, string>;
  shells: Map<string, string>;
  fileTabs: Map<string, FileTab>;
}

/** SSE client connection for push notifications */
export interface SSEClient {
  res: http.ServerResponse;
  id: string;
  connectedAt: number;
  /** Per-client max-age with jitter to prevent synchronized eviction bursts */
  maxAge: number;
}

/** Rate limiting entry for activation requests */
export interface RateLimitEntry {
  count: number;
  windowStart: number;
}

/** Terminal entry returned to tower UI. `'file'` is a UI-only file-tab pseudo-terminal. */
export interface TerminalEntry {
  type: TerminalType | 'file';
  id: string;
  label: string;
  url: string;
  active: boolean;
  /**
   * Spec 786 Phase 5: when `type === 'architect'`, the architect's stable name
   * (`'main'` or a sibling). Enables consumers like `afx status` to enumerate
   * architects without parsing the `id`. Older clients ignore this field.
   */
  architectName?: string;
  /**
   * Spec 786 Phase 5: live process ID from Tower's in-memory `PtySession`
   * (only meaningful for architect entries; not persisted in `state.db`).
   */
  pid?: number;
  /**
   * Spec 786 Phase 5: port assigned to the architect terminal, if any.
   */
  port?: number;
  /**
   * Spec 786 Phase 5: the actual PtySession id backing this terminal. For
   * builders/shells the `id` field already IS the session id; for architects
   * the `id` field carries the tab identifier (`'architect'` or
   * `'architect:<name>'`) per Spec 761's deep-link convention, so the
   * underlying session id is exposed separately here. `afx status` displays
   * this so users can correlate architect entries with terminal-attach flows.
   */
  terminalId?: string;
}

/** Instance status returned to tower UI */
export interface InstanceStatus {
  workspacePath: string;
  workspaceName: string;
  running: boolean;
  proxyUrl: string;
  architectUrl: string;
  terminals: TerminalEntry[];
  lastUsed?: string;
}

/**
 * SQLite terminal session row shape.
 * Note: dev PTYs (`type: 'dev'`) are intentionally never written here — see
 * the runtime filter in tower-routes.ts that gates shellper persistence.
 */
export interface DbTerminalSession {
  id: string;
  workspace_path: string;
  type: TerminalType;
  role_id: string | null;
  pid: number | null;
  shellper_socket: string | null;
  shellper_pid: number | null;
  shellper_start_time: number | null;
  label: string | null;
  cwd: string | null;
  created_at: string;
}
