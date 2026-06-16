/**
 * Architect command - start agent session with architect role in current terminal
 *
 * Spawns the configured architect command (default: claude) with the architect
 * role prompt injected via the configured harness provider. Runs directly in
 * the current shell with no Tower dependency.
 */

import { spawn } from 'node:child_process';
import { getConfig, getResolvedCommands } from '../utils/index.js';
import { buildArchitectArgs } from '../servers/tower-utils.js';

export interface ArchitectOptions {
  args?: string[];
}

/**
 * Start an architect session in the current terminal
 */
export async function architect(options: ArchitectOptions = {}): Promise<void> {
  const config = getConfig();
  const commands = getResolvedCommands();

  // Split command string into executable + initial args (supports e.g. "claude --dangerously-skip-permissions")
  const cmdParts = commands.architect.split(/\s+/);
  const cmd = cmdParts[0];

  // Inject the architect role + write any harness-specific context files
  // (e.g. Gemini's .gemini/settings.json) via the shared launch helper, so the
  // no-Tower path matches every Tower launch path (Issue #929).
  const baseArgs = [...cmdParts.slice(1), ...(options.args || [])];
  const { args: allArgs, env } = buildArchitectArgs(baseArgs, config.workspaceRoot);

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, allArgs, {
      stdio: 'inherit',
      cwd: config.workspaceRoot,
      env: { ...process.env, ...env },
    });

    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(`Architect command not found: ${cmd}. Check .codev/config.json shell.architect setting.`));
      } else {
        reject(err);
      }
    });

    child.on('close', (code) => {
      if (code === 0 || code === null) {
        resolve();
      } else {
        reject(new Error(`${commands.architect} exited with code ${code}`));
      }
    });
  });
}
