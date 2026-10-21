/**
 * Running an agent CLI on this terminal and waiting for it to exit (Spec 1797). Shared by
 * `codev bootstrap-docs` and `codev adopt`'s conflict-merge session.
 */

import { spawn } from 'node:child_process';

export interface AgentLaunch {
  executable: string;
  args: string[];
}

export interface AgentExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the process could not be started at all. */
  error?: string;
}

/**
 * Run the agent on this terminal and wait for it to exit.
 *
 * Ctrl-C reaches the whole foreground process group, so while the agent owns the terminal
 * this process ignores SIGINT; otherwise interrupting the agent would kill the CLI before it
 * could report what the session changed.
 */
export function spawnAgentProcess(launch: AgentLaunch, cwd: string): Promise<AgentExit> {
  const ignoreInterrupt = (): void => {};
  process.on('SIGINT', ignoreInterrupt);
  return new Promise<AgentExit>(resolve => {
    const child = spawn(launch.executable, launch.args, { stdio: 'inherit', cwd });
    child.on('error', err => resolve({ code: null, signal: null, error: err.message }));
    child.on('exit', (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    process.off('SIGINT', ignoreInterrupt);
  });
}
