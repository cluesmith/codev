/**
 * The `codev check` command group (Spec 1951): read-only checks an architect runs before a
 * merge, after it, and before cleanup.
 *
 * Exit codes: 0 clear, 1 needs attention, 2 the command failed. Commander's own exits are
 * mapped to the same scheme: `--help` exits 0, and every usage error (unknown option,
 * missing or extra argument, unknown subcommand) exits 2, not commander's default 1. With
 * `--json`, a usage error on a subcommand prints that subcommand's `ErrorReport` on stdout.
 * Commander's exits do not end the process here: they throw `CheckExit`, which carries the
 * writes still in flight, and the caller (cli.ts) awaits them before exiting.
 *
 * Subcommands are action handlers only. Commander's executable-subcommand form, which
 * spawns a program, is never used, so the runner stays the only subprocess path.
 */

import { Command, CommanderError } from 'commander';
import { checkDeploy, renderDeployHuman } from './deploy.js';
import { checkPr, renderPrHuman } from './pr.js';
import { renderErrorHuman, renderJson } from './render.js';
import type { CommandName, CommandResult, ErrorReport, Report } from './report.js';
import { checkWorktree, renderWorktreeHuman } from './worktree.js';

export interface CheckCliDeps {
  /**
   * End the process with this code once a command has run. Production never returns; tests
   * record the code and throw. Commander's own exits (help, usage errors) throw `CheckExit`.
   */
  exit: (code: number) => void;
  /** Write to stdout; resolves once the text is flushed, so a large `--json` survives the exit. */
  stdout: (text: string) => void | Promise<void>;
  stderr: (text: string) => void | Promise<void>;
  cwd: () => string;
  /** The arguments being parsed, to see whether a usage error should be reported as JSON. */
  argv: () => readonly string[];
  /** Extra environment for every subprocess (tests only). */
  env?: Record<string, string>;
  timeoutMs?: number;
}

function flushed(stream: NodeJS.WriteStream): (text: string) => Promise<void> {
  return (text) => new Promise((resolve) => stream.write(text, () => resolve()));
}

const PROCESS_DEPS: CheckCliDeps = {
  exit: (code) => process.exit(code),
  stdout: flushed(process.stdout),
  stderr: flushed(process.stderr),
  cwd: () => process.cwd(),
  argv: () => process.argv,
};

/**
 * Thrown in place of commander's exit (help, version, usage errors): the exit code, and the
 * writes still in flight, which must be flushed before the process exits.
 */
export class CheckExit extends Error {
  constructor(
    public readonly code: 0 | 2,
    private readonly writes: ReadonlyArray<Promise<void>>,
    public readonly commanderError: CommanderError,
  ) {
    super(commanderError.message);
    this.name = 'CheckExit';
  }

  /** Resolves once everything commander and the `--json` report wrote is flushed. */
  async flush(): Promise<void> {
    await Promise.all(this.writes);
  }
}

/** Commander's exit, mapped: help and version 0, anything else a usage error, 2. */
export function exitCodeForCommander(err: CommanderError): 0 | 2 {
  if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') return 0;
  if (err.code === 'commander.help') return err.exitCode === 0 ? 0 : 2;
  return 2;
}

export function buildCheckCommand(deps: CheckCliDeps = PROCESS_DEPS): Command {
  /** Writes commander made (help, usage errors), for `CheckExit` to flush. */
  const inFlight: Array<Promise<void>> = [];
  const track = (write: void | Promise<void>): void => {
    inFlight.push(Promise.resolve(write));
  };

  /**
   * The exit callback commander calls instead of `process.exit`. It must not return:
   * commander exits with its own code if it does, so it throws `CheckExit`.
   */
  const onCommanderExit = (command: CommandName | null) => (err: CommanderError): never => {
    const code = exitCodeForCommander(err);
    if (code === 2 && command !== null && deps.argv().includes('--json')) {
      const report: ErrorReport = { schema: 1, command, error: { message: err.message.replace(/^error: /, '') } };
      track(deps.stdout(renderJson(report)));
    }
    throw new CheckExit(code, [...inFlight], err);
  };

  const finish = async <R extends Report>(result: CommandResult<R>, json: boolean, human: (report: R) => string): Promise<void> => {
    const { report } = result;
    if ('error' in report) {
      if (json) await deps.stdout(renderJson(report));
      else await deps.stderr(renderErrorHuman(report));
    } else {
      await deps.stdout(json ? renderJson(report) : human(report));
    }
    deps.exit(result.exitCode);
  };

  const group = new Command('check')
    .description('Read-only checks: merge readiness of a PR, whether merged PRs reached the deploy branch, and whether a builder worktree can be removed (never merges, pushes, comments or deletes)')
    .configureOutput({ writeOut: (s) => track(deps.stdout(s)), writeErr: (s) => track(deps.stderr(s)) });
  group.exitOverride(onCommanderExit(null));

  const pr = group
    .command('pr <number>')
    .description('Merge readiness of PR <number>: exact head, state, forge mergeability, trial merge, CI on the code, attribution, watched files, linked issue, size, files to read')
    .option('--json', 'print one JSON object (schema 1) instead of the summary')
    .allowExcessArguments(false)
    .action(async (number: string, options: { json?: boolean }) => {
      const result = await checkPr(number, { cwd: deps.cwd(), env: deps.env, timeoutMs: deps.timeoutMs });
      await finish(result, options.json === true, renderPrHuman);
    });
  pr.exitOverride(onCommanderExit('pr'));

  const deploy = group
    .command('deploy <numbers...>')
    .description('Whether each merged PR reached the deploy branch (check.deploy.branch, else its base) and, with check.deploy.workflow, the latest green deploy run; without one, CI on the merge commit')
    .option('--json', 'print one JSON object (schema 1) instead of the summary')
    .action(async (numbers: string[], options: { json?: boolean }) => {
      const result = await checkDeploy(numbers, { cwd: deps.cwd(), env: deps.env, timeoutMs: deps.timeoutMs });
      await finish(result, options.json === true, renderDeployHuman);
    });
  deploy.exitOverride(onCommanderExit('deploy'));

  const worktree = group
    .command('worktree <target>')
    .description('Whether removing a builder worktree (builder id or path) and its local branch would lose data: uncommitted files, unpushed commits, keep-list ignored files; and whether its PR is finished')
    .option('--json', 'print one JSON object (schema 1) instead of the summary')
    .allowExcessArguments(false)
    .action(async (target: string, options: { json?: boolean }) => {
      const result = await checkWorktree(target, { cwd: deps.cwd(), env: deps.env, timeoutMs: deps.timeoutMs });
      await finish(result, options.json === true, renderWorktreeHuman);
    });
  worktree.exitOverride(onCommanderExit('worktree'));

  return group;
}
