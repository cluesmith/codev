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
import type { SendOptions } from '../types.js';
import { logger, fatal } from '../utils/logger.js';
import { loadState } from '../state.js';
import { TowerClient } from '../lib/tower-client.js';

const MAX_FILE_SIZE = 48 * 1024; // 48KB limit per spec

/**
 * Detect workspace root from CWD by walking up to find .git or af-config.json.
 * Builder worktrees are at .builders/<id>/ which is inside the workspace root.
 */
export function detectWorkspaceRoot(): string | null {
  let dir = process.cwd();
  // If inside .builders/<id>/, the workspace root is two levels up
  const buildersMatch = dir.match(/^(.+?)\/\.builders\/[^/]+/);
  if (buildersMatch) return buildersMatch[1];
  // Walk up looking for markers
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(dir, 'af-config.json')) || existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Detect the current builder ID from worktree path.
 * Looks up the canonical builder ID from state.db by matching worktree path.
 * Falls back to the worktree directory name if no match in state.db.
 * Returns null if not in a builder worktree.
 */
export function detectCurrentBuilderId(): string | null {
  const cwd = process.cwd();
  // Builder worktrees are at .builders/<dir-name>/
  const match = cwd.match(/\.builders\/([^/]+)/);
  if (!match) return null;

  const worktreeDirName = match[1];

  // Look up the canonical builder ID from state.db by matching worktree path
  const state = loadState();
  const builder = state.builders.find(b => {
    if (!b.worktree) return false;
    // Match on the worktree directory name (last segment of the path)
    const builderWorktreeDir = b.worktree.split('/').pop();
    return builderWorktreeDir === worktreeDirName;
  });

  return builder ? builder.id : worktreeDirName;
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
  const state = loadState();
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
    fatal('No message provided. Usage: af send <builder> "message" or af send --all "message"');
  }

  if (!options.all && !target) {
    fatal('Must specify a builder ID or use --all flag. Usage: af send <builder> "message"');
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

  // Detect sender identity (builder ID if in a worktree, otherwise 'architect')
  const from = detectCurrentBuilderId() ?? 'architect';

  // Ensure Tower is running
  const client = new TowerClient();
  const towerRunning = await client.isRunning();
  if (!towerRunning) {
    fatal('Tower is not running. Start it with: af tower start');
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
