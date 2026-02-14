/**
 * Shared types for tower server modules.
 * Spec 0105: Tower Server Decomposition
 */

import type http from 'node:http';
import type { WebSocketServer } from 'ws';
import type Database from 'better-sqlite3';
import type { TerminalManager } from '../../terminal/pty-manager.js';
import type { SessionManager } from '../../terminal/session-manager.js';
import type { GateWatcher } from '../utils/gate-watcher.js';
import type { TunnelClient } from '../lib/tunnel-client.js';
import type { FileTab } from '../utils/file-tabs.js';
import type { GateStatus } from '../utils/gate-status.js';

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
  projectTerminals: Map<string, ProjectTerminals>;
  db: () => Database.Database;
  gateWatcher: GateWatcher;
  broadcastNotification: (n: { type: string; title: string; body: string; project?: string }) => void;
  tunnelClient: TunnelClient | null;
  knownProjects: Set<string>;
  server: http.Server;
  terminalWss: WebSocketServer;
}

/** Tracks terminals belonging to a project */
export interface ProjectTerminals {
  architect?: string;
  builders: Map<string, string>;
  shells: Map<string, string>;
  fileTabs: Map<string, FileTab>;
}

/** SSE client connection for push notifications */
export interface SSEClient {
  res: http.ServerResponse;
  id: string;
}

/** Rate limiting entry for activation requests */
export interface RateLimitEntry {
  count: number;
  windowStart: number;
}

/** Terminal entry returned to tower UI */
export interface TerminalEntry {
  type: 'architect' | 'builder' | 'shell' | 'file';
  id: string;
  label: string;
  url: string;
  active: boolean;
}

/** Instance status returned to tower UI */
export interface InstanceStatus {
  projectPath: string;
  projectName: string;
  running: boolean;
  proxyUrl: string;
  architectUrl: string;
  terminals: TerminalEntry[];
  gateStatus?: GateStatus;
  lastUsed?: string;
}

/** SQLite terminal session row shape */
export interface DbTerminalSession {
  id: string;
  project_path: string;
  type: 'architect' | 'builder' | 'shell';
  role_id: string | null;
  pid: number | null;
  shellper_socket: string | null;
  shellper_pid: number | null;
  shellper_start_time: number | null;
  created_at: string;
}
