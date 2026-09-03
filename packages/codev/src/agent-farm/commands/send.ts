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
import { MAX_MESSAGE_BYTES, messageLimitError } from '../utils/message-format.js';
import { formatVerdict, isUnverifiableVerdict } from '../utils/hold-verdict.js';

/**
 * `--file` attachment cap. One constant with the message-body ceiling (Issue #1573): the file's
 * content is APPENDED to the message, so two independent numbers could only ever disagree.
 */
const MAX_FILE_SIZE = MAX_MESSAGE_BYTES;

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
 * builder identity cannot be verified against `global.db`.
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
 * Build an actionable message for a `global.db` open failure, naming the likely
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
    `failed to open global.db at ${dbPath} (${detail}). ${hint} ` +
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
interface SendToAllResults {
  delivered: string[];
  held: Array<{ id: string; reason?: string; detail?: string; mailboxId?: string }>;
  /** Spec 1307 `--delay`: accepted for later delivery, not sent now. */
  scheduled: string[];
  failed: string[];
}

async function sendToAll(
  client: TowerClient,
  message: string,
  workspace: string | undefined,
  from: string,
  options: SendOptions,
): Promise<SendToAllResults> {
  // Bugfix #826: loadState is workspace-scoped (for the architect read).
  // Builders are global per state.db; use the detected workspace root as
  // scope. `process.cwd()` is a safe fallback when detection fails — the
  // architect read returns [] and `--all` only uses `state.builders`.
  const state = loadState(detectWorkspaceRoot() ?? process.cwd());
  // Spec 1307 `--delay` + Spec 1313 mailbox: scheduled (delayed) and held
  // (persisted, awaiting a clean prompt) are tracked separately from delivered.
  // Reporting either as "Delivered" would claim a delivery that hasn't happened.
  const results: SendToAllResults = { delivered: [], held: [], scheduled: [], failed: [] };

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
        // Spec 1307: each target's delivery is scheduled independently.
        deliverAfter: options.delay,
      });
      if (!result.ok) {
        throw new Error(result.error || 'Unknown error');
      }
      // Distinct outcomes, kept distinct (Spec 1307 `--delay` + Spec 1313 mailbox):
      // a scheduled (delayed) or held (persisted, awaiting a clean prompt) message
      // has NOT been delivered now — classifying either as "delivered" would claim a
      // delivery that has not happened.
      if (result.scheduled) {
        results.scheduled.push(builder.id);
      } else if (result.held) {
        results.held.push({
          id: builder.id,
          reason: result.reason,
          detail: result.detail, // Issue #1482: which kind of hold, not just that it held
          mailboxId: result.mailboxId,
        });
      } else {
        results.delivered.push(builder.id);
      }
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

  // Mirror Tower's body ceiling here (Issue #1573) so the refusal is local, immediate and
  // identically worded, instead of a 400 the user has to interpret. Checked AFTER the --file
  // append because that content travels in the same body and counts against the same limit.
  const tooLarge = messageLimitError(message);
  if (tooLarge) fatal(tooLarge);

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

    if (results.delivered.length > 0) {
      logger.success(`Delivered to ${results.delivered.length} builder(s): ${results.delivered.join(', ')}`);
    }
    if (results.held.length > 0) {
      const detail = results.held
        .map((h) => `${h.id} (${formatVerdict(h.reason, h.detail, 'pending')})`)
        .join(', ');
      logger.info(
        `Held for ${results.held.length} builder(s): ${detail}. ` +
          `Each delivers automatically when its prompt is clear.`,
      );
    }
    if (results.scheduled.length > 0) {
      logger.success(
        `Scheduled for ${results.scheduled.length} builder(s) (+${options.delay}s): ${results.scheduled.join(', ')}`,
      );
      logger.info('Each is persisted and durable across a Tower restart; delivers onto a clear prompt when due. Inspect/cancel: afx inbox.');
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
        deliverAfter: options.delay,
      });

      if (!result.ok) {
        throw new Error(result.error || 'Unknown error');
      }

      // Report the real first outcome (Spec 1307 `--delay` + Spec 1313 mailbox). A
      // scheduled message is deferred to a future time; a held message is persisted
      // in the mailbox and delivers automatically once the target's prompt is clear
      // (empty and render-verified) — neither is a failure, and neither has been
      // delivered yet.
      if (result.scheduled) {
        logger.success(
          `Message scheduled for ${result.resolvedTo ?? target} (+${options.delay}s)` +
            `${result.mailboxId ? ` — mailbox id ${result.mailboxId}` : ''}`,
        );
        logger.info('Persisted and durable across a Tower restart; delivers onto a clear prompt when due. Inspect/cancel: afx inbox.');
      } else if (result.held) {
        logger.info(
          `Message held for ${result.resolvedTo ?? target} (${formatVerdict(result.reason, result.detail, 'pending')})` +
            `${result.mailboxId ? ` — mailbox id ${result.mailboxId}` : ''}. ` +
            `It delivers automatically when the prompt is clear.`,
        );
        // Issue #1482: a hold the gate could not classify will NOT clear on its own, so saying
        // "it delivers automatically" and stopping there would be misleading for exactly the
        // case that needs a human. Say so, once, only for that case.
        if (isUnverifiableVerdict(result.reason, result.detail)) {
          logger.warn(
            `The render gate could not verify that composer (${result.detail ?? result.reason}), ` +
              `so this hold will not clear by itself — inspect with 'afx inbox'.`,
          );
        }
      } else {
        // Issue #1573: report WHAT was sent, not just that a send happened. The failures this
        // echo exists for (#1564: a ~1,900-char message arriving as its final ~30) all read as
        // an unqualified success at the sender.
        const size = result.bodyLength !== undefined ? ` (${result.bodyLength} bytes)` : '';
        // Issue #1584: say so when the bytes were accepted but the terminal never showed them.
        // Tower records that row as delivered and does NOT re-write it — re-writing is what
        // re-injected one message dozens of times in #1583 — so this line is the only place the
        // sender learns the delivery was unconfirmed. `verified` absent (older Tower, or a body
        // with no header worth matching) keeps today's wording.
        const unverified = result.verified === false ? ' (unverified — header not seen on the terminal)' : '';
        logger.success(`Message delivered to ${result.resolvedTo ?? target}${size}${unverified}`);
        // Issue #1365: an interrupt/escape that gave up waiting for the terminal's submission
        // lock wrote unserialized, so its bytes may have interleaved with the delivery it
        // skipped. The row is claimed `delivered` before the write (un-claiming would risk a
        // double delivery), so without this the sender would read an unqualified success for a
        // possibly-mangled body. Warn rather than fail: the write did happen.
        if (result.degraded) {
          logger.warn(
            `...but it was NOT serialized against a write already in flight on that terminal ` +
              `(${result.degradedReason ?? 'wait ceiling expired'}), so it may have interleaved. ` +
              `Check the agent's prompt before assuming it read cleanly.`,
          );
        }
      }
    } catch (error) {
      fatal(error instanceof Error ? error.message : String(error));
    }
  }
}
