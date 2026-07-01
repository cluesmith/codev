/**
 * Utility functions for tower server.
 * Spec 0105: Tower Server Decomposition — Phase 1
 *
 * Contains: rate limiting, path normalization, temp directory detection,
 * workspace name extraction, MIME types, and static file serving.
 */

import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerResponse } from 'node:http';
import type { RateLimitEntry } from './tower-types.js';
import crypto from 'node:crypto';
import { loadRolePrompt, type RoleConfig } from '../utils/roles.js';
import { getArchitectHarness } from '../utils/config.js';
import { getArchitectByName } from '../state.js';

// ============================================================================
// Rate Limiting
// ============================================================================

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 10;

const activationRateLimits = new Map<string, RateLimitEntry>();

/**
 * Check if a client has exceeded the rate limit for activations.
 * Returns true if rate limit exceeded, false if allowed.
 */
export function isRateLimited(clientIp: string): boolean {
  const now = Date.now();
  const entry = activationRateLimits.get(clientIp);

  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    // New window
    activationRateLimits.set(clientIp, { count: 1, windowStart: now });
    return false;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return true;
  }

  entry.count++;
  return false;
}

/**
 * Clean up old rate limit entries.
 */
export function cleanupRateLimits(): void {
  const now = Date.now();
  for (const [ip, entry] of activationRateLimits.entries()) {
    if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS * 2) {
      activationRateLimits.delete(ip);
    }
  }
}

/**
 * Start periodic cleanup of stale rate limit entries.
 * Returns the interval handle so the orchestrator can clear it on shutdown.
 */
export function startRateLimitCleanup(): ReturnType<typeof setInterval> {
  return setInterval(cleanupRateLimits, 5 * 60 * 1000);
}

// ============================================================================
// Path Utilities
// ============================================================================

// Issue #1118: normalizeWorkspacePath moved to the leaf module utils/workspace-path.ts
// so the data layer (state.ts, db/consolidate.ts) can share it without importing
// the server layer. Re-exported here so existing server-side importers are unchanged.
export { normalizeWorkspacePath } from '../utils/workspace-path.js';

/**
 * Get workspace name from path.
 */
export function getWorkspaceName(workspacePath: string): string {
  return path.basename(workspacePath);
}

// Resolve once at module load: both symlinked and real temp dir paths
const _tmpDir = tmpdir();
const _tmpDirResolved = (() => {
  try {
    return fs.realpathSync(_tmpDir);
  } catch {
    return _tmpDir;
  }
})();

/**
 * Check if a workspace path points to a temp directory.
 */
export function isTempDirectory(workspacePath: string): boolean {
  return (
    workspacePath.startsWith(_tmpDir + '/') ||
    workspacePath.startsWith(_tmpDirResolved + '/') ||
    workspacePath.startsWith('/tmp/') ||
    workspacePath.startsWith('/private/tmp/')
  );
}

// ============================================================================
// Language & MIME Detection
// ============================================================================

/**
 * Get language identifier for syntax highlighting.
 */
export function getLanguageForExt(ext: string): string {
  const langMap: Record<string, string> = {
    js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
    py: 'python', sh: 'bash', bash: 'bash', md: 'markdown',
    html: 'markup', css: 'css', json: 'json', yaml: 'yaml', yml: 'yaml',
    rs: 'rust', go: 'go', java: 'java', c: 'c', cpp: 'cpp', h: 'c',
  };
  return langMap[ext] || ext || 'plaintext';
}

/**
 * Get MIME type for a file path (by extension).
 */
export function getMimeTypeForFile(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mimeTypes: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    pdf: 'application/pdf', txt: 'text/plain',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

// ============================================================================
// Static File Serving
// ============================================================================

/** MIME types for static file serving */
export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

// ============================================================================
// Architect Role Prompt
// ============================================================================

/**
 * Build architect command args with role prompt injected via harness provider.
 * Writes the role to .architect-role.md in the workspace dir and uses the
 * configured harness to determine the correct CLI args and env vars.
 * Returns args and env for the caller to merge into session creation.
 */
export function buildArchitectArgs(baseArgs: string[], workspacePath: string): { args: string[]; env: Record<string, string> } {
  const codevDir = path.join(workspacePath, 'codev');
  const bundledRolesDir = path.resolve(import.meta.dirname, '../../../skeleton/roles');
  const config: RoleConfig = { codevDir, bundledRolesDir, workspaceRoot: workspacePath };

  const harness = getArchitectHarness(workspacePath);

  const role = loadRolePrompt(config, 'architect');
  if (!role) return { args: baseArgs, env: {} };

  const roleFile = path.join(workspacePath, '.architect-role.md');
  fs.writeFileSync(roleFile, role.content);

  const injection = harness.buildRoleInjection(role.content, roleFile);

  return {
    args: [...baseArgs, ...injection.args],
    env: injection.env,
  };
}

/**
 * Issue #832: resolve the args/env to launch (or revive) an architect, choosing
 * between resuming its persisted conversation and starting a fresh one. The
 * session mechanics are agent-neutral — they come from the resolved harness's
 * `session` capability, so no agent-specific flags appear here.
 *
 * Decision order:
 *   1. Harness has no `session` capability (e.g. Codex/Gemini today) → plain fresh
 *      spawn, `sessionId: null` (nothing to resume next time).
 *   2. `storedSessionId` present → resume it (no role injection — the saved
 *      conversation already holds the role/system prompt); echo the same id back.
 *   3. Else fresh → generate a new id, pin the session to it (with role injection),
 *      and return it for the caller to persist.
 *
 * The returned `sessionId` is the value the caller writes onto the architect row,
 * so the column is populated correctly on every spawn.
 */
export function resolveArchitectLaunch(opts: {
  workspacePath: string;
  name: string;
  baseArgs: string[];
  storedSessionId?: string | null;
}): { args: string[]; env: Record<string, string>; sessionId: string | null; resumed: boolean } {
  const { workspacePath, baseArgs, storedSessionId } = opts;
  const harness = getArchitectHarness(workspacePath);

  // 1. No resumable-session support → plain fresh, nothing to persist.
  if (!harness.session) {
    return { ...buildArchitectArgs(baseArgs, workspacePath), sessionId: null, resumed: false };
  }

  // 2. Resume the persisted conversation (role injection skipped).
  if (storedSessionId) {
    return {
      args: [...baseArgs, ...harness.session.resumeArgs(storedSessionId)],
      env: {},
      sessionId: storedSessionId,
      resumed: true,
    };
  }

  // 3. Fresh: mint an id, pin the session to it, persist it via the returned id.
  const sessionId = crypto.randomUUID();
  const built = buildArchitectArgs([...baseArgs, ...harness.session.newSessionArgs(sessionId)], workspacePath);
  return { ...built, sessionId, resumed: false };
}

/**
 * Issue #832: resolve launch args for an architect being auto-restarted by its
 * shellper (claude crash / reconnect). Reads the architect's stored conversation
 * `session_id` from its state.db row and hands it to `resolveArchitectLaunch`, so an
 * in-process crash revives the SAME conversation (the silent-context-loss path)
 * instead of spawning fresh. A legacy row with no stored id resolves to a fresh
 * session (then self-heals on its next cold revival via the spawn-path persist).
 *
 * Unlike the cold-spawn `main` path, there is **no** jsonl-discovery fallback here —
 * the restart sites rely solely on the stored id (matching #830, which never resumed
 * at restart). Both shellper restart-bake sites in `tower-terminals.ts` call this so
 * the read→resolve wiring lives in one tested place. Returns `resolveArchitectLaunch`'s
 * result plus the `storedSessionId` the caller uses for the "Resuming…" log line.
 */
export function resolveArchitectRestart(
  workspacePath: string,
  architectName: string,
  baseArgs: string[],
): { args: string[]; env: Record<string, string>; sessionId: string | null; resumed: boolean; storedSessionId: string | null } {
  const storedSessionId = getArchitectByName(workspacePath, architectName)?.sessionId ?? null;
  const resolved = resolveArchitectLaunch({ workspacePath, name: architectName, baseArgs, storedSessionId });
  return { ...resolved, storedSessionId };
}

/**
 * Serve a static file from the React dashboard dist.
 * Returns true if the file was served, false otherwise.
 */
export function serveStaticFile(filePath: string, res: ServerResponse): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}
