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

  const cmd = commands.architect;

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      cwd: config.workspaceRoot,
      shell: true,
      env: { ...process.env, ...env },
    });

    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(`Architect command not found: ${cmd}. Check .codev/config.json or install claude.`));
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
