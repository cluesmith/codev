/**
 * Send command - send instructions to running builders via Tower terminal API
 */

import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SendOptions } from '../types.js';
import { logger, fatal } from '../utils/logger.js';
import { loadState, getArchitect } from '../state.js';
import { TowerClient } from '../lib/tower-client.js';

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
 * Send a message to a specific builder via Tower API
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

  if (!builder.terminalId) {
    throw new Error(`Builder ${builderId} has no terminal session.`);
  }

  const client = new TowerClient();
  const towerRunning = await client.isRunning();
  if (!towerRunning) {
    throw new Error('Tower is not running. Start it with: af tower start');
  }

  // Optional: Send Ctrl+C first to interrupt any running process
  if (options.interrupt) {
    await client.writeTerminal(builder.terminalId, '\x03'); // Ctrl+C
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

  // Send via Tower API
  await client.writeTerminal(builder.terminalId, formattedMessage);

  // Send Enter to submit (unless --no-enter)
  if (!options.noEnter) {
    await client.writeTerminal(builder.terminalId, '\r');
  }

  logger.debug(`Sent to ${builderId}: ${message.substring(0, 50)}...`);
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
 * Find the architect terminal ID from state or Tower.
 */
function findArchitectTerminalId(): string {
  const architect = getArchitect();
  if (architect?.terminalId) {
    return architect.terminalId;
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
  const terminalId = findArchitectTerminalId();

  const client = new TowerClient();
  const towerRunning = await client.isRunning();
  if (!towerRunning) {
    throw new Error('Tower is not running. Start it with: af tower start');
  }

  // Optional: Send Ctrl+C first to interrupt any running process
  if (options.interrupt) {
    await client.writeTerminal(terminalId, '\x03'); // Ctrl+C
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

  // Send via Tower API
  await client.writeTerminal(terminalId, formattedMessage);

  // Send Enter to submit (unless --no-enter)
  if (!options.noEnter) {
    await client.writeTerminal(terminalId, '\r');
  }

  logger.debug(`Sent to architect from ${fromBuilderId}: ${message.substring(0, 50)}...`);
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
