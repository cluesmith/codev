/**
 * Send command - send messages to agents via Tower POST /api/send endpoint.
 * Spec 0110: Messaging Infrastructure — Phase 4
 *
 * Delegates address resolution, message formatting, and terminal writing
 * to the Tower server. The CLI handles file reading, workspace detection,
 * and argument parsing.
 */

import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { SendOptions } from '../types.js';
import { logger, fatal } from '../utils/logger.js';
import { loadState } from '../state.js';
import { getGlobalDbPath } from '../db/index.js';
import { normalizeWorkspacePath } from '../utils/workspace-path.js';
import { TowerClient } from '../lib/tower-client.js';

const MAX_FILE_SIZE = 48 * 1024; // 48KB limit per spec

/**
 * Detect workspace root from CWD by walking up to find .git or .codev/config.json.
 * Builder worktrees are at .builders/<id>/ which is inside the workspace root.
 *
 * Note: checks for .codev/config.json (not just .codev/) to avoid false
 * positives from ~/.codev/ which exists for global config.
 */
export function detectWorkspaceRoot(): string | null {
  let dir = process.cwd();
  // If inside .builders/<id>/, the workspace root is the prefix before the
  // LAST `/.builders/`. Greedy `.+` (not lazy `.+?`) so a nested worktree path
  // like `<repo>/.builders/a/.builders/b` resolves the inner builder's
  // workspace, not the outer one — mirrors deriveWorkspaceFromWorktree's
  // lastIndexOf (Issue #1118 codex review). Nesting is an unsupported
  // anti-pattern, but the parse should be consistent with the rest of the code.
  const buildersMatch = dir.match(/^(.+)\/\.builders\/[^/]+/);
  if (buildersMatch) return buildersMatch[1];
  // Walk up looking for markers
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(dir, '.codev', 'config.json')) || existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Thrown when CWD is confirmed to be inside `.builders/<id>/` but the canonical
 * builder identity cannot be verified against the workspace `state.db`.
 *
 * We refuse to fall back to the bare worktree directory name (e.g. `bugfix-774`)
 * here: that non-canonical id does not match any `builders.id` (`builder-bugfix-774`),
 * so Tower's affinity resolver (`lookupBuilderSpawningArchitect` → undefined)
 * silently drops to the "non-builder sender → main first" branch — the builder's
 * `afx send architect` lands on `main` instead of its spawning architect.
 *
 * Per "fail fast, never implement fallbacks": a fatal environmental fault must
 * surface loudly, not be laundered into a subtle misroute (issue #1094).
 */
export class BuilderIdResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuilderIdResolutionError';
  }
}

/**
 * Build an actionable message for a `state.db` open failure, naming the likely
 * cause. A better-sqlite3 ABI mismatch (a `node` on PATH built for a different
 * NODE_MODULE_VERSION than codev's native module) is the real-world trigger
 * from issue #1094 and gets a specific reinstall hint.
 */
export function describeStateDbOpenFailure(dbPath: string, worktreeDirName: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  const abiMismatch = /NODE_MODULE_VERSION|different Node\.js version|was compiled against/i.test(detail);
  const hint = abiMismatch
    ? "This is a better-sqlite3 native-module ABI mismatch: the 'node' on your PATH differs from the one codev was built for. Reinstall codev under your current node (e.g. `npm install -g @cluesmith/codev`)."
    : 'Check the file for corruption, a permissions problem, or a stale lock.';
  return (
    `Cannot resolve builder identity for worktree '${worktreeDirName}': ` +
    `failed to open workspace state.db at ${dbPath} (${detail}). ${hint} ` +
    `Refusing to send with an unverified identity — it would silently misroute to 'main' (issue #1094).`
  );
}

/**
 * Detect the current builder ID from the worktree path.
 *
 * Issue #1118: builders live in the single shared `global.db`, scoped by
 * `workspace_path` (per-workspace `state.db` is retired). This resolves the
 * canonical builder ID by reading `global.db` (read-only), scoped to the
 * worktree's owning workspace — NOT the singleton `getDb()`. The miss must NOT
 * fall back to the bare worktree directory name (e.g. `bugfix-774`), because the
 * canonical ID is `builder-bugfix-774` and a non-canonical id misroutes affinity
 * routing downstream (issue #774, then issue #1094 for the silent-fallback class).
 *
 * Mirrors the workspace-scoped lookup used by `lookupBuilderSpawningArchitect`
 * in state.ts.
 *
 * Contract:
 *   - Returns `null` when CWD is not inside a builder worktree (not a builder).
 *   - Returns the canonical builder ID when it can be verified against global.db.
 *   - **Throws `BuilderIdResolutionError`** when CWD *is* a builder worktree but
 *     the canonical ID cannot be verified (global.db missing, unopenable, or no
 *     matching row). Failing loud here is deliberate: returning a bare,
 *     unverified id silently misroutes `afx send architect` to `main` (#1094).
 */
export function detectCurrentBuilderId(): string | null {
  const cwd = process.cwd();
  // Builder worktrees are at .builders/<dir-name>/. Greedy `.+` (not lazy `.+?`)
  // so a nested worktree resolves the INNER builder (the LAST `/.builders/`).
  const match = cwd.match(/^(.+)\/\.builders\/([^/]+)/);
  if (!match) return null;

  const workspacePath = match[1];
  const worktreeDirName = match[2];

  // Issue #1118: builders live in the single shared global.db, scoped by
  // workspace_path (state.db is retired). Open global.db readonly and scope the
  // query to THIS workspace — so a same-id builder in another repo can't be
  // matched. From here on we are unambiguously in a builder worktree, so any
  // inability to resolve the canonical id is an ERROR condition, not a "this
  // isn't a builder" condition (issue #1094 anti-spoofing).
  const dbPath = getGlobalDbPath();
  if (!existsSync(dbPath)) {
    throw new BuilderIdResolutionError(
      `Cannot resolve builder identity for worktree '${worktreeDirName}': ` +
        `global.db not found at ${dbPath} (has Tower ever run?). ` +
        `Refusing to send with an unverified identity — it would silently misroute to 'main' (issue #1094).`,
    );
  }

  let gdb: Database.Database;
  try {
    gdb = new Database(dbPath, { readonly: true });
  } catch (err) {
    throw new BuilderIdResolutionError(describeStateDbOpenFailure(dbPath, worktreeDirName, err));
  }

  try {
    // Match by canonical worktree path first (most precise), then fall back
    // to a tail-segment match for legacy rows that recorded a different
    // absolute prefix. Scoped by workspace_path so only this workspace's
    // builders are considered.
    const ws = normalizeWorkspacePath(workspacePath);
    const canonicalWorktree = join(workspacePath, '.builders', worktreeDirName);
    const rows = gdb
      .prepare('SELECT id, worktree FROM builders WHERE workspace_path = ? AND worktree IS NOT NULL')
      .all(ws) as Array<{ id: string; worktree: string }>;

    const exact = rows.find(r => r.worktree === canonicalWorktree);
    if (exact) return exact.id;

    const tail = rows.find(r => r.worktree.split('/').pop() === worktreeDirName);
    if (tail) return tail.id;

    throw new BuilderIdResolutionError(
      `Cannot resolve canonical builder id for worktree '${worktreeDirName}': ` +
        `no matching builder row in ${dbPath} for workspace ${ws} (the worktree may be stale or unregistered). ` +
        `Refusing to send with an unverified identity — it would silently misroute to 'main' (issue #1094).`,
    );
  } finally {
    gdb.close();
  }
}

/**
 * Read file content for --file flag, with size validation.
 */
function readFileContent(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const fileBuffer = readFileSync(filePath);
  if (fileBuffer.length > MAX_FILE_SIZE) {
    throw new Error(
      `File too large: ${fileBuffer.length} bytes (max ${MAX_FILE_SIZE} bytes / 48KB)`
    );
  }
  return fileBuffer.toString('utf-8');
}

/**
 * Read message from stdin
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

/**
 * Send a message to all builders via Tower API.
 */
async function sendToAll(
  client: TowerClient,
  message: string,
  workspace: string | undefined,
  from: string,
  options: SendOptions,
): Promise<{ sent: string[]; failed: string[] }> {
  // Bugfix #826: loadState is workspace-scoped (for the architect read).
  // Builders are global per state.db; use the detected workspace root as
  // scope. `process.cwd()` is a safe fallback when detection fails — the
  // architect read returns [] and `--all` only uses `state.builders`.
  const state = loadState(detectWorkspaceRoot() ?? process.cwd());
  const results = { sent: [] as string[], failed: [] as string[] };

  if (state.builders.length === 0) {
    logger.warn('No active builders found.');
    return results;
  }

  for (const builder of state.builders) {
    try {
      const result = await client.sendMessage(builder.id, message, {
        from,
        workspace,
        fromWorkspace: workspace,
        raw: options.raw,
        noEnter: options.noEnter,
        interrupt: options.interrupt,
      });
      if (!result.ok) {
        throw new Error(result.error || 'Unknown error');
      }
      results.sent.push(builder.id);
    } catch (error) {
      logger.error(`Failed to send to ${builder.id}: ${error instanceof Error ? error.message : String(error)}`);
      results.failed.push(builder.id);
    }
  }

  return results;
}

/**
 * Main send command handler.
 *
 * Delegates to Tower's POST /api/send for address resolution, formatting,
 * and terminal writing. Supports [project:]agent addressing.
 */
export async function send(options: SendOptions): Promise<void> {
  // Determine the message
  let message = options.message;
  let target = options.builder;

  // When using --all, the first positional arg (builder) is actually the message
  if (options.all && target && !message) {
    message = target;
    target = undefined;
  }

  // Handle stdin input (message is "-")
  if (message === '-') {
    message = await readStdin();
  }

  // Validate inputs
  if (!message) {
    fatal('No message provided. Usage: afx send <builder> "message" or afx send --all "message"');
  }

  if (!options.all && !target) {
    fatal('Must specify a builder ID or use --all flag. Usage: afx send <builder> "message"');
  }

  if (options.all && target) {
    fatal('Cannot use --all with a specific builder ID.');
  }

  // Append file content to message if --file specified
  if (options.file) {
    const fileContent = readFileContent(options.file);
    message = message + '\n\nAttached content:\n```\n' + fileContent + '\n```';
  }

  logger.header('Sending Instruction');

  // Detect workspace for target resolution and sender provenance
  const workspace = detectWorkspaceRoot() ?? undefined;

  // Detect sender identity (builder ID if in a worktree, otherwise 'architect').
  // In a confirmed builder worktree, detectCurrentBuilderId throws when the
  // canonical id can't be verified — abort loudly here rather than send an
  // unverified `from` that Tower would silently route to 'main' (issue #1094).
  let from: string;
  try {
    from = detectCurrentBuilderId() ?? 'architect';
  } catch (err) {
    fatal(err instanceof Error ? err.message : String(err));
  }

  // Ensure Tower is running
  const client = new TowerClient();
  const towerRunning = await client.isRunning();
  if (!towerRunning) {
    fatal('Tower is not running. Start it with: afx tower start');
  }

  if (options.all) {
    // Broadcast to all builders
    const results = await sendToAll(client, message, workspace, from, options);

    if (results.sent.length > 0) {
      logger.success(`Sent to ${results.sent.length} builder(s): ${results.sent.join(', ')}`);
    }
    if (results.failed.length > 0) {
      logger.error(`Failed for ${results.failed.length} builder(s): ${results.failed.join(', ')}`);
    }
  } else {
    // Send to specific target (architect, builder, or cross-project address)
    try {
      const result = await client.sendMessage(target!, message, {
        from,
        workspace,
        fromWorkspace: workspace,
        raw: options.raw,
        noEnter: options.noEnter,
        interrupt: options.interrupt,
      });

      if (!result.ok) {
        throw new Error(result.error || 'Unknown error');
      }

      logger.success(`Message sent to ${result.resolvedTo ?? target}`);
    } catch (error) {
      fatal(error instanceof Error ? error.message : String(error));
    }
  }
}
