/**
 * Architect command - start Claude session with architect role in current terminal
 *
 * Spawns the configured architect command (default: claude) with the architect
 * role prompt appended as a system prompt. Runs directly in the current shell
 * with no Tower dependency.
 */

import { spawn } from 'node:child_process';
import { getConfig, getResolvedCommands } from '../utils/index.js';
import { loadRolePrompt } from '../utils/roles.js';

export interface ArchitectOptions {
  args?: string[];
}

/**
 * Start an architect Claude session in the current terminal
 */
export async function architect(options: ArchitectOptions = {}): Promise<void> {
  const config = getConfig();
  const commands = getResolvedCommands();

  const args = [...(options.args || [])];

  // Load and inject the architect role prompt
  const role = loadRolePrompt(config, 'architect');
  if (role) {
    args.push('--append-system-prompt', role.content);
  }

  const cmd = commands.architect;

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      cwd: config.workspaceRoot,
      shell: true,
    });

    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(`Architect command not found: ${cmd}. Check af-config.json or install claude.`));
      } else {
        reject(err);
      }
    });

    child.on('close', (code) => {
      if (code === 0 || code === null) {
        resolve();
      } else {
        reject(new Error(`${cmd} exited with code ${code}`));
      }
    });
  });
}
