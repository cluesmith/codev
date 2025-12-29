/**
 * Architect command - direct CLI access to architect role
 *
 * Provides terminal-first access to the architect session without
 * requiring the full dashboard. Uses tmux for session persistence.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { getConfig, ensureDirectories } from '../utils/index.js';
import { logger, fatal } from '../utils/logger.js';
import { run, commandExists } from '../utils/shell.js';
import { findRolePromptPath } from '../utils/roles.js';

const SESSION_NAME = 'af-architect';

// findRolePromptPath imported from ../utils/roles.js

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
  const role = findRolePromptPath(config, 'architect');
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

const LAYOUT_SESSION_NAME = 'af-layout';

/**
 * Create a two-pane tmux layout with architect and utility shell
 *
 * Layout:
 * ┌────────────────────────────────┬──────────────────────────────┐
 * │                                │                              │
 * │   Architect Session (60%)      │   Utility Shell (40%)        │
 * │                                │                              │
 * └────────────────────────────────┴──────────────────────────────┘
 */
async function createLayoutAndAttach(args: string[]): Promise<void> {
  const config = getConfig();

  // Ensure state directory exists for launch script
  await ensureDirectories(config);

  // Load architect role
  const role = findRolePromptPath(config, 'architect');
  if (!role) {
    fatal('Architect role not found. Expected at: codev/roles/architect.md');
  }

  logger.info(`Loaded architect role (${role.source})`);

  // Create launch script for architect
  const launchScript = resolve(config.stateDir, 'launch-architect-cli.sh');

  let argsStr = '';
  if (args.length > 0) {
    argsStr = ' ' + args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  }

  writeFileSync(launchScript, `#!/bin/bash
cd "${config.projectRoot}"
exec claude --append-system-prompt "$(cat '${role.path}')"${argsStr}
`, { mode: 0o755 });

  logger.info('Creating layout session...');

  // Create main session with architect pane (left, 70% width)
  await run(
    `tmux new-session -d -s "${LAYOUT_SESSION_NAME}" -x 200 -y 50 -c "${config.projectRoot}" "${launchScript}"`
  );

  // Configure tmux session
  await run(`tmux set-option -t "${LAYOUT_SESSION_NAME}" status off`);
  await run(`tmux set-option -t "${LAYOUT_SESSION_NAME}" -g mouse on`);
  await run(`tmux set-option -t "${LAYOUT_SESSION_NAME}" -g set-clipboard on`);
  await run(`tmux set-option -t "${LAYOUT_SESSION_NAME}" -g allow-passthrough on`);

  // Split right: create utility shell pane (40% width)
  await run(`tmux split-window -h -t "${LAYOUT_SESSION_NAME}" -p 40 -c "${config.projectRoot}"`);

  // Focus back on architect pane (left)
  await run(`tmux select-pane -t "${LAYOUT_SESSION_NAME}:0.0"`);

  logger.info('Layout: Architect (left) | Shell (right)');
  logger.info('Navigation: Ctrl+B ←/→ | Detach: Ctrl+B d');

  // Attach to the session
  attachToSession(LAYOUT_SESSION_NAME);
}

export interface ArchitectOptions {
  args?: string[];
  layout?: boolean;
}

/**
 * Start or attach to the architect tmux session
 */
export async function architect(options: ArchitectOptions = {}): Promise<void> {
  const args = options.args ?? [];
  const useLayout = options.layout ?? false;

  // Check dependencies
  if (!(await commandExists('tmux'))) {
    fatal('tmux not found. Install with: brew install tmux');
  }
  if (!(await commandExists('claude'))) {
    fatal('claude not found. Install with: npm install -g @anthropic-ai/claude-code');
  }

  // Determine which session to use
  const sessionName = useLayout ? LAYOUT_SESSION_NAME : SESSION_NAME;
  const sessionExists = await tmuxSessionExists(sessionName);

  if (sessionExists) {
    logger.info(`Attaching to existing session: ${sessionName}`);
    logger.info('Detach with Ctrl+B, D');
    attachToSession(sessionName);
  } else if (useLayout) {
    await createLayoutAndAttach(args);
  } else {
    await createAndAttach(args);
  }
}
