/**
 * Architect command - start agent session with architect role in current terminal
 *
 * Spawns the configured architect command (default: claude) with the architect
 * role prompt injected via the configured harness provider. Runs directly in
 * the current shell with no Tower dependency.
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getConfig, getResolvedCommands, getArchitectHarness } from '../utils/index.js';
import { loadRolePrompt } from '../utils/roles.js';

export interface ArchitectOptions {
  args?: string[];
}

/**
 * Start an architect session in the current terminal
 */
export async function architect(options: ArchitectOptions = {}): Promise<void> {
  const config = getConfig();
  const commands = getResolvedCommands();

  const args = [...(options.args || [])];
  let env: Record<string, string> = {};

  // Load and inject the architect role prompt via harness
  const role = loadRolePrompt(config, 'architect');
  if (role) {
    const roleFilePath = resolve(config.workspaceRoot, '.architect-role.md');
    writeFileSync(roleFilePath, role.content);

    const harness = getArchitectHarness(config.workspaceRoot);
    const injection = harness.buildRoleInjection(role.content, roleFilePath);
    args.push(...injection.args);
    env = injection.env;
  }

  // Split command string into executable + initial args (supports e.g. "claude --dangerously-skip-permissions")
  const cmdParts = commands.architect.split(/\s+/);
  const cmd = cmdParts[0];
  const allArgs = [...cmdParts.slice(1), ...args];

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
