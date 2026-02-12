/**
 * Architect command - direct CLI access to architect role
 *
 * Provides terminal-first access to the architect session without
 * requiring the full dashboard. Uses tmux for session persistence.
 */

import { writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { getConfig, ensureDirectories } from '../utils/index.js';
import { logger, fatal } from '../utils/logger.js';
import { run, commandExists } from '../utils/shell.js';
import { findRolePromptPath } from '../utils/roles.js';

/**
 * Get session name based on project basename (matches Tower convention)
 */
function getSessionName(): string {
  const config = getConfig();
  return `architect-${basename(config.projectRoot)}`;
}

/**
 * Get layout session name based on project basename
 */
function getLayoutSessionName(): string {
  const config = getConfig();
  return `architect-layout-${basename(config.projectRoot)}`;
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
 * Shared session setup: write role file, create launch script, create tmux session, configure it.
 * Returns the launch script path for callers that need it.
 */
async function createSession(sessionName: string, args: string[]): Promise<void> {
  const config = getConfig();

  // Ensure state directory exists for launch script
  await ensureDirectories(config);

  // Load architect role
  const role = findRolePromptPath(config, 'architect');
  if (!role) {
    fatal('Architect role not found. Expected at: codev/roles/architect.md');
  }

  logger.info(`Loaded architect role (${role.source})`);

  // Write a minimal pointer - AI reads the full file
  const roleFile = resolve(config.stateDir, 'architect-role.md');
  const shortPointer = `You are an Architect. Read codev/roles/architect.md before starting work.
`;
  writeFileSync(roleFile, shortPointer, 'utf-8');

  // Create a launch script
  const launchScript = resolve(config.stateDir, 'launch-architect-cli.sh');

  let argsStr = '';
  if (args.length > 0) {
    argsStr = ' ' + args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  }

  writeFileSync(launchScript, `#!/bin/bash
cd "${config.projectRoot}"
exec claude --append-system-prompt "$(cat '${roleFile}')"${argsStr}
`, { mode: 0o755 });

  // Create tmux session running the launch script
  await run(
    `tmux new-session -d -s "${sessionName}" -x 200 -y 50 -c "${config.projectRoot}" "${launchScript}"`
  );

  // Configure tmux session
  await run(`tmux set-option -t "${sessionName}" status off`);
  await run(`tmux set-option -t "${sessionName}" -g mouse on`);
  await run(`tmux set-option -t "${sessionName}" -g set-clipboard on`);

  // Copy selection to clipboard when mouse is released (pbcopy for macOS)
  await run(`tmux bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"`);
  await run(`tmux bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"`);
}

/**
 * Create a new tmux session with the architect role and attach to it
 */
async function createAndAttach(args: string[]): Promise<void> {
  const sessionName = getSessionName();
  logger.info('Creating new architect session...');
  await createSession(sessionName, args);
  attachToSession(sessionName);
}

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
  const layoutName = getLayoutSessionName();
  logger.info('Creating layout session...');
  await createSession(layoutName, args);

  // Split right: create utility shell pane (40% width)
  await run(`tmux split-window -h -t "${layoutName}" -p 40 -c "${config.projectRoot}"`);

  // Focus back on architect pane (left)
  await run(`tmux select-pane -t "${layoutName}:0.0"`);

  logger.info('Layout: Architect (left) | Shell (right)');
  logger.info('Navigation: Ctrl+B ←/→ | Detach: Ctrl+B d');

  attachToSession(layoutName);
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
  const sessionName = useLayout ? getLayoutSessionName() : getSessionName();
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
