/**
 * Running an agent CLI on this terminal and waiting for it to exit (Spec 1797). Shared by
 * `codev bootstrap-docs` and `codev adopt`'s conflict-merge session.
 */

import { commandLaunch } from './platform/command-launch.js';
import { resolveClaudeBin } from './claude-cli.js';

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
    const child = commandLaunch().spawn(launch.executable, launch.args, { stdio: 'inherit', cwd });
    child.on('error', err => resolve({ code: null, signal: null, error: err.message }));
    child.on('exit', (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    process.off('SIGINT', ignoreInterrupt);
  });
}

/**
 * Run an interactive `claude` session on this terminal with `prompt` and wait for it to exit:
 * the conflict-merge sessions of `codev update` and `codev adopt`. The binary is the one
 * `resolveClaudeBin()` resolves, so `CODEV_CLAUDE_BIN` applies and, under a test runner, the
 * #1912 guard refuses the developer's real install (#1922: a bare `spawn('claude')` started it
 * from the suites). Failing to resolve or start it is reported as `error`, never thrown.
 */
export async function runClaudeSession(prompt: string, cwd: string): Promise<AgentExit> {
  try {
    return await spawnAgentProcess({ executable: resolveClaudeBin(), args: [prompt] }, cwd);
  } catch (err) {
    return { code: null, signal: null, error: err instanceof Error ? err.message : String(err) };
  }
}
