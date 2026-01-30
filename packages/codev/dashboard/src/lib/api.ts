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
}

export interface DashboardState {
  architect: ArchitectState | null;
  builders: Builder[];
  utils: UtilTerminal[];
  annotations: Annotation[];
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

export async function createFileTab(filePath: string): Promise<{ id: string; port: number }> {
  const res = await fetch(apiUrl('api/tabs/file'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ path: filePath }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
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
    return `/ws/terminal/${tab.terminalId}`;
  }
  return null;
}
