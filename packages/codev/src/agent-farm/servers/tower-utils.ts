/**
 * Utility functions for tower server.
 * Spec 0105: Tower Server Decomposition — Phase 1
 *
 * Contains: rate limiting, path normalization, temp directory detection,
 * project name extraction, MIME types, and static file serving.
 */

import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerResponse } from 'node:http';
import type { RateLimitEntry } from './tower-types.js';
import { loadRolePrompt, type RoleConfig } from '../utils/roles.js';

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

/**
 * Normalize a project path to its canonical form for consistent SQLite storage.
 * Uses realpath to resolve symlinks and relative paths.
 */
export function normalizeProjectPath(projectPath: string): string {
  try {
    return fs.realpathSync(projectPath);
  } catch {
    // Path doesn't exist yet, normalize without realpath
    return path.resolve(projectPath);
  }
}

/**
 * Get project name from path.
 */
export function getProjectName(projectPath: string): string {
  return path.basename(projectPath);
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
 * Check if a project path points to a temp directory.
 */
export function isTempDirectory(projectPath: string): boolean {
  return (
    projectPath.startsWith(_tmpDir + '/') ||
    projectPath.startsWith(_tmpDirResolved + '/') ||
    projectPath.startsWith('/tmp/') ||
    projectPath.startsWith('/private/tmp/')
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
 * Build architect command args with role prompt injected.
 * Writes the role to .architect-role.md in the project dir and adds
 * --append-system-prompt to the args (matching how builders receive theirs).
 * Returns the modified args array.
 */
export function buildArchitectArgs(baseArgs: string[], projectPath: string): string[] {
  const codevDir = path.join(projectPath, 'codev');
  const bundledRolesDir = path.resolve(import.meta.dirname, '../../skeleton/roles');
  const config: RoleConfig = { codevDir, bundledRolesDir };

  const role = loadRolePrompt(config, 'architect');
  if (!role) return baseArgs;

  const roleFile = path.join(projectPath, '.architect-role.md');
  fs.writeFileSync(roleFile, role.content);

  return [...baseArgs, '--append-system-prompt', role.content];
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
