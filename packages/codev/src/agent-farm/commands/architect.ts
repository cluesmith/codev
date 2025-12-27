/**
 * Architect command - direct CLI access to architect role
 *
 * Provides terminal-first access to the architect session without
 * requiring the full dashboard. Uses tmux for session persistence.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { getConfig, ensureDirectories } from '../utils/index.js';
import { logger, fatal } from '../utils/logger.js';
import { run, commandExists } from '../utils/shell.js';

const SESSION_NAME = 'af-architect';

/**
 * Find and load a role file - tries local codev/roles/ first, falls back to bundled
 * TODO: Extract to shared utils (duplicated from start.ts)
 */
function loadRolePrompt(config: { codevDir: string; bundledRolesDir: string }, roleName: string): { path: string; source: string } | null {
  // Try local project first
  const localPath = resolve(config.codevDir, 'roles', `${roleName}.md`);
  if (existsSync(localPath)) {
    return { path: localPath, source: 'local' };
  }

  // Fall back to bundled
  const bundledPath = resolve(config.bundledRolesDir, `${roleName}.md`);
  if (existsSync(bundledPath)) {
    return { path: bundledPath, source: 'bundled' };
  }

  return null;
}

/**
 * Check if a tmux session exists
 */
async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  try {
    await run(`tmux has-session -t "${sessionName}" 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Attach to an existing tmux session (foreground, interactive)
 */
function attachToSession(sessionName: string): void {
  // Use spawn with inherited stdio for full interactivity
  const child = spawn('tmux', ['attach-session', '-t', sessionName], {
    stdio: 'inherit',
  });

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });

  child.on('error', (err) => {
    fatal(`Failed to attach to tmux session: ${err.message}`);
  });
}

/**
 * Create a new tmux session with the architect role and attach to it
 */
async function createAndAttach(args: string[]): Promise<void> {
  const config = getConfig();

  // Ensure state directory exists for launch script
  await ensureDirectories(config);

  // Load architect role
  const role = loadRolePrompt(config, 'architect');
  if (!role) {
    fatal('Architect role not found. Expected at: codev/roles/architect.md');
  }

  logger.info(`Loaded architect role (${role.source})`);

  // Create a launch script to avoid shell escaping issues
  // The architect.md file contains backticks, $variables, and other shell-sensitive chars
  const launchScript = resolve(config.stateDir, 'launch-architect-cli.sh');

  let argsStr = '';
  if (args.length > 0) {
    argsStr = ' ' + args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  }

  writeFileSync(launchScript, `#!/bin/bash
cd "${config.projectRoot}"
exec claude --append-system-prompt "$(cat '${role.path}')"${argsStr}
`, { mode: 0o755 });

  logger.info('Creating new architect session...');

  // Create tmux session running the launch script
  await run(
    `tmux new-session -d -s "${SESSION_NAME}" -x 200 -y 50 -c "${config.projectRoot}" "${launchScript}"`
  );

  // Configure tmux session (same settings as start.ts)
  await run(`tmux set-option -t "${SESSION_NAME}" status off`);
  await run(`tmux set-option -t "${SESSION_NAME}" -g mouse on`);
  await run(`tmux set-option -t "${SESSION_NAME}" -g set-clipboard on`);
  await run(`tmux set-option -t "${SESSION_NAME}" -g allow-passthrough on`);

  // Copy selection to clipboard when mouse is released (pbcopy for macOS)
  await run(`tmux bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"`);
  await run(`tmux bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"`);

  // Attach to the session
  attachToSession(SESSION_NAME);
}

export interface ArchitectOptions {
  args?: string[];
}

/**
 * Start or attach to the architect tmux session
 */
export async function architect(options: ArchitectOptions = {}): Promise<void> {
  const args = options.args ?? [];

  // Check tmux is available
  if (!(await commandExists('tmux'))) {
    fatal('tmux not found. Install with: brew install tmux');
  }

  // Check if session already exists
  const sessionExists = await tmuxSessionExists(SESSION_NAME);

  if (sessionExists) {
    logger.info(`Attaching to existing session: ${SESSION_NAME}`);
    logger.info('Detach with Ctrl+B, D');
    attachToSession(SESSION_NAME);
  } else {
    await createAndAttach(args);
  }
}
