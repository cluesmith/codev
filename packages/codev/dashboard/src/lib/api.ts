import { getApiBase } from './constants.js';

export interface Builder {
  id: string;
  name: string;
  port: number;
  pid: number;
  status: string;
  phase: string;
  worktree: string;
  branch: string;
  tmuxSession?: string;
  type: string;
  projectId?: string;
  terminalId?: string;
}

export interface UtilTerminal {
  id: string;
  name: string;
  port: number;
  pid: number;
  tmuxSession?: string;
  terminalId?: string;
}

export interface Annotation {
  id: string;
  file: string;
  port: number;
  pid: number;
  parent: { type: string; id?: string };
}

export interface ArchitectState {
  port: number;
  pid: number;
  tmuxSession?: string;
  terminalId?: string;
}

export interface DashboardState {
  architect: ArchitectState | null;
  builders: Builder[];
  utils: UtilTerminal[];
  annotations: Annotation[];
  projectName?: string;
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileEntry[];
}

function apiUrl(endpoint: string): string {
  const base = getApiBase();
  const clean = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  return base + clean;
}

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('codev-web-key');
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}

export async function fetchState(): Promise<DashboardState> {
  const res = await fetch(apiUrl('api/state'), { headers: getAuthHeaders() });
  if (!res.ok) throw new Error(`Failed to fetch state: ${res.status}`);
  return res.json();
}

export async function createShellTab(): Promise<{ id: string; port: number; name: string }> {
  const res = await fetch(apiUrl('api/tabs/shell'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createFileTab(filePath: string, line?: number): Promise<{ id: string; existing: boolean; line?: number }> {
  const res = await fetch(apiUrl('api/tabs/file'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ path: filePath, line }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export interface FileContent {
  path: string;
  name: string;
  content: string | null;
  language: string;
  isMarkdown: boolean;
  isImage: boolean;
  isVideo: boolean;
  size?: number;
}

export async function fetchFileContent(tabId: string): Promise<FileContent> {
  const res = await fetch(apiUrl(`api/file/${tabId}`), { headers: getAuthHeaders() });
  if (!res.ok) throw new Error(`Failed to fetch file: ${res.status}`);
  return res.json();
}

export function getFileRawUrl(tabId: string): string {
  return apiUrl(`api/file/${tabId}/raw`);
}

export async function saveFile(tabId: string, content: string): Promise<void> {
  const res = await fetch(apiUrl(`api/file/${tabId}/save`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function deleteTab(id: string): Promise<void> {
  const res = await fetch(apiUrl(`api/tabs/${id}`), {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function fetchFiles(): Promise<FileEntry[]> {
  const res = await fetch(apiUrl('api/files'), { headers: getAuthHeaders() });
  if (!res.ok) throw new Error(`Failed to fetch files: ${res.status}`);
  return res.json();
}

export async function stopAll(): Promise<void> {
  const res = await fetch(apiUrl('api/stop'), {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  if (!res.ok) throw new Error(await res.text());
}

/** Get WebSocket path for a terminal tab's node-pty session. */
export function getTerminalWsPath(tab: { type: string; terminalId?: string }): string | null {
  if (tab.terminalId) {
    const base = getApiBase();
    return `${base}ws/terminal/${tab.terminalId}`;
  }
  return null;
}

// Spec 0092: Git status and recent files APIs for enhanced file browser

export interface GitStatus {
  modified: string[];
  staged: string[];
  untracked: string[];
  error?: string;
}

export async function fetchGitStatus(): Promise<GitStatus> {
  const res = await fetch(apiUrl('api/git/status'), { headers: getAuthHeaders() });
  if (!res.ok) throw new Error(`Failed to fetch git status: ${res.status}`);
  return res.json();
}

export interface RecentFile {
  id: string;
  path: string;
  name: string;
  relativePath: string;
}

export async function fetchRecentFiles(): Promise<RecentFile[]> {
  const res = await fetch(apiUrl('api/files/recent'), { headers: getAuthHeaders() });
  if (!res.ok) throw new Error(`Failed to fetch recent files: ${res.status}`);
  return res.json();
}

// Spec 0097: Tunnel status and control APIs for cloud connection

export interface TunnelStatus {
  registered: boolean;
  state: 'disconnected' | 'connecting' | 'connected' | 'auth_failed' | 'error';
  uptime: number | null;
  towerId: string | null;
  towerName: string | null;
  serverUrl: string | null;
  accessUrl: string | null;
}

const ERROR_STATUS: TunnelStatus = {
  registered: false, state: 'error', uptime: null,
  towerId: null, towerName: null, serverUrl: null, accessUrl: null,
};

export async function fetchTunnelStatus(): Promise<TunnelStatus | null> {
  try {
    // Tunnel endpoints are tower-level (root), not project-scoped — use absolute path
    const res = await fetch('/api/tunnel/status', { headers: getAuthHeaders() });
    if (res.status === 404) return null; // Tunnel not configured
    if (!res.ok) return ERROR_STATUS; // Server error — distinct from not-registered
    return res.json();
  } catch {
    return ERROR_STATUS; // Network error
  }
}

export async function connectTunnel(): Promise<void> {
  const res = await fetch('/api/tunnel/connect', {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  if (!res.ok) throw new Error(`Connect failed: ${res.status}`);
}

export async function disconnectTunnel(): Promise<void> {
  const res = await fetch('/api/tunnel/disconnect', {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  if (!res.ok) throw new Error(`Disconnect failed: ${res.status}`);
}
