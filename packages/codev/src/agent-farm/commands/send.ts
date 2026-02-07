/**
 * Send command - send instructions to running builders via tmux buffer paste
 */

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SendOptions } from '../types.js';
import { logger, fatal } from '../utils/logger.js';
import { run } from '../utils/shell.js';
import { loadState, getArchitect } from '../state.js';

const MAX_FILE_SIZE = 48 * 1024; // 48KB limit per spec

/**
 * Format message from architect to builder
 */
function formatArchitectMessage(message: string, fileContent?: string, raw: boolean = false): string {
  let content = message;
  if (fileContent) {
    content += '\n\nAttached content:\n```\n' + fileContent + '\n```';
  }

  if (raw) {
    return content;
  }

  // Structured format helps Claude identify Architect instructions
  const timestamp = new Date().toISOString();
  return `### [ARCHITECT INSTRUCTION | ${timestamp}] ###
${content}
###############################`;
}

/**
 * Format message from builder to architect
 */
function formatBuilderMessage(builderId: string, message: string, fileContent?: string, raw: boolean = false): string {
  let content = message;
  if (fileContent) {
    content += '\n\nAttached content:\n```\n' + fileContent + '\n```';
  }

  if (raw) {
    return content;
  }

  // Structured format helps Claude identify Builder messages
  const timestamp = new Date().toISOString();
  return `### [BUILDER ${builderId} MESSAGE | ${timestamp}] ###
${content}
###############################`;
}

/**
 * Send a message to a specific builder
 */
async function sendToBuilder(
  builderId: string,
  message: string,
  options: SendOptions
): Promise<void> {
  const state = loadState();
  const builder = state.builders.find((b) => b.id === builderId);

  if (!builder) {
    throw new Error(`Builder ${builderId} not found. Use 'af status' to see active builders.`);
  }

  if (!builder.tmuxSession) {
    throw new Error(`Builder ${builderId} has no tmux session recorded.`);
  }

  // Verify session exists
  try {
    await run(`tmux has-session -t "${builder.tmuxSession}" 2>/dev/null`);
  } catch {
    throw new Error(
      `tmux session "${builder.tmuxSession}" not found (builder may have exited). Use 'af status' to check.`
    );
  }

  // Optional: Send Ctrl+C first to interrupt any running process
  if (options.interrupt) {
    await run(`tmux send-keys -t "${builder.tmuxSession}" C-c`);
    // Brief pause for prompt to appear
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Load file content if specified
  let fileContent: string | undefined;
  if (options.file) {
    if (!existsSync(options.file)) {
      throw new Error(`File not found: ${options.file}`);
    }
    const fileBuffer = readFileSync(options.file);
    if (fileBuffer.length > MAX_FILE_SIZE) {
      throw new Error(
        `File too large: ${fileBuffer.length} bytes (max ${MAX_FILE_SIZE} bytes / 48KB)`
      );
    }
    fileContent = fileBuffer.toString('utf-8');
  }

  // Format the message
  const formattedMessage = formatArchitectMessage(message, fileContent, options.raw);

  // Write message to temp file (avoids all shell escaping issues)
  const tempFile = join(tmpdir(), `architect-msg-${randomUUID()}.txt`);
  writeFileSync(tempFile, formattedMessage);

  try {
    // Load into tmux buffer and paste
    const bufferName = `architect-${builderId}`;
    await run(`tmux load-buffer -b "${bufferName}" "${tempFile}"`);
    await run(`tmux paste-buffer -b "${bufferName}" -t "${builder.tmuxSession}"`);

    // Clean up tmux buffer
    await run(`tmux delete-buffer -b "${bufferName}"`).catch(() => {
      // Ignore delete-buffer errors (buffer may not exist)
    });

    // Send Enter to submit (unless --no-enter)
    if (!options.noEnter) {
      await run(`tmux send-keys -t "${builder.tmuxSession}" Enter`);
    }

    logger.debug(`Sent to ${builderId}: ${message.substring(0, 50)}...`);
  } finally {
    // Clean up temp file
    try {
      unlinkSync(tempFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Detect project root from CWD by walking up to find .git or af-config.json.
 * Builder worktrees are at .builders/<id>/ which is inside the project root.
 */
function detectProjectRoot(): string | null {
  let dir = process.cwd();
  // If inside .builders/<id>/, the project root is two levels up
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
 * Find the architect tmux session name.
 * Checks state.db first (legacy), then falls back to Tower naming convention.
 */
async function findArchitectTmuxSession(): Promise<string> {
  // Try legacy state.db first
  const architect = getArchitect();
  if (architect?.tmuxSession) {
    try {
      await run(`tmux has-session -t "${architect.tmuxSession}" 2>/dev/null`);
      return architect.tmuxSession;
    } catch {
      // Session recorded but no longer exists — fall through
    }
  }

  // Fallback: Tower creates architect sessions as "architect-<project-basename>"
  const projectRoot = detectProjectRoot();
  if (projectRoot) {
    const candidateSession = `architect-${basename(projectRoot)}`;
    try {
      await run(`tmux has-session -t "${candidateSession}" 2>/dev/null`);
      return candidateSession;
    } catch {
      // Session doesn't exist
    }
  }

  throw new Error('Architect not running. Use "af status" to check.');
}

/**
 * Send a message to the architect (from a builder)
 */
async function sendToArchitect(
  fromBuilderId: string,
  message: string,
  options: SendOptions
): Promise<void> {
  const tmuxSession = await findArchitectTmuxSession();

  // Optional: Send Ctrl+C first to interrupt any running process
  if (options.interrupt) {
    await run(`tmux send-keys -t "${tmuxSession}" C-c`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Load file content if specified
  let fileContent: string | undefined;
  if (options.file) {
    if (!existsSync(options.file)) {
      throw new Error(`File not found: ${options.file}`);
    }
    const fileBuffer = readFileSync(options.file);
    if (fileBuffer.length > MAX_FILE_SIZE) {
      throw new Error(
        `File too large: ${fileBuffer.length} bytes (max ${MAX_FILE_SIZE} bytes / 48KB)`
      );
    }
    fileContent = fileBuffer.toString('utf-8');
  }

  // Format the message (from builder)
  const formattedMessage = formatBuilderMessage(fromBuilderId, message, fileContent, options.raw);

  // Write message to temp file
  const tempFile = join(tmpdir(), `builder-msg-${randomUUID()}.txt`);
  writeFileSync(tempFile, formattedMessage);

  try {
    // Load into tmux buffer and paste
    const bufferName = `builder-${fromBuilderId}`;
    await run(`tmux load-buffer -b "${bufferName}" "${tempFile}"`);
    await run(`tmux paste-buffer -b "${bufferName}" -t "${tmuxSession}"`);

    // Clean up tmux buffer
    await run(`tmux delete-buffer -b "${bufferName}"`).catch(() => {});

    // Send Enter to submit (unless --no-enter)
    if (!options.noEnter) {
      await run(`tmux send-keys -t "${tmuxSession}" Enter`);
    }

    logger.debug(`Sent to architect from ${fromBuilderId}: ${message.substring(0, 50)}...`);
  } finally {
    try {
      unlinkSync(tempFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Send a message to all builders
 */
async function sendToAll(
  message: string,
  options: SendOptions
): Promise<{ sent: string[]; failed: string[] }> {
  const state = loadState();
  const results = { sent: [] as string[], failed: [] as string[] };

  if (state.builders.length === 0) {
    logger.warn('No active builders found.');
    return results;
  }

  for (const builder of state.builders) {
    try {
      await sendToBuilder(builder.id, message, options);
      results.sent.push(builder.id);
    } catch (error) {
      logger.error(`Failed to send to ${builder.id}: ${error instanceof Error ? error.message : String(error)}`);
      results.failed.push(builder.id);
    }
  }

  return results;
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
 * Detect the current builder ID from worktree path
 * Returns null if not in a builder worktree
 */
function detectCurrentBuilderId(): string | null {
  const cwd = process.cwd();
  // Builder worktrees are at .builders/<id>/
  const match = cwd.match(/\.builders\/([^/]+)/);
  return match ? match[1] : null;
}

/**
 * Main send command handler
 */
export async function send(options: SendOptions): Promise<void> {
  // Determine the message
  let message = options.message;
  let builder = options.builder;

  // When using --all, the first positional arg (builder) is actually the message
  if (options.all && builder && !message) {
    message = builder;
    builder = undefined;
  }

  // Handle stdin input (message is "-")
  if (message === '-') {
    message = await readStdin();
  }

  // Validate inputs
  if (!message) {
    fatal('No message provided. Usage: af send <builder> "message" or af send --all "message"');
  }

  if (!options.all && !builder) {
    fatal('Must specify a builder ID or use --all flag. Usage: af send <builder> "message"');
  }

  if (options.all && builder) {
    fatal('Cannot use --all with a specific builder ID.');
  }

  logger.header('Sending Instruction');

  // Check if sending to architect
  const isArchitectTarget = builder?.toLowerCase() === 'architect' || builder?.toLowerCase() === 'arch';

  if (isArchitectTarget) {
    // Sending to architect (from a builder)
    const currentBuilderId = detectCurrentBuilderId();
    if (!currentBuilderId) {
      fatal('Cannot send to architect: not running from a builder worktree. Use from .builders/<id>/ directory.');
    }

    try {
      await sendToArchitect(currentBuilderId, message, options);
      logger.success(`Message sent to architect from builder ${currentBuilderId}`);
    } catch (error) {
      fatal(error instanceof Error ? error.message : String(error));
    }
  } else if (options.all) {
    // Broadcast to all builders
    const results = await sendToAll(message, options);

    if (results.sent.length > 0) {
      logger.success(`Sent to ${results.sent.length} builder(s): ${results.sent.join(', ')}`);
    }
    if (results.failed.length > 0) {
      logger.error(`Failed for ${results.failed.length} builder(s): ${results.failed.join(', ')}`);
    }
  } else {
    // Send to specific builder
    try {
      await sendToBuilder(builder!, message, options);
      logger.success(`Message sent to builder ${builder}`);
    } catch (error) {
      fatal(error instanceof Error ? error.message : String(error));
    }
  }
}
