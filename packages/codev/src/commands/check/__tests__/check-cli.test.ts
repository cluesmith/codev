/**
 * Spec 1951 — the `codev check` command group: commander wiring and exit codes.
 *
 * Help exits 0, every usage error exits 2 (not commander's 1), and with `--json` a usage
 * error on a subcommand prints its `ErrorReport` on stdout. Parsed through `parseAsync`
 * with an injected exit, so nothing here ends the test process.
 */

import { CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCheckCommand, CheckExit, exitCodeForCommander } from '../index.js';
import { useFakeHome } from './helpers/fake-home.js';
import { createFixture, type Fixture } from './helpers/git-fixture.js';
import { mergedView, mergePr } from './helpers/deploy-fixture.js';
import { commitChecksOverride, passing, prView, prViewOverride, pushBranch, writeConfig } from './helpers/pr-fixture.js';

class Exited extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
  }
}

interface Outcome {
  code: number | undefined;
  stdout: string;
  stderr: string;
}

type Write = (text: string, sink: string[]) => void | Promise<void>;

const immediate: Write = (text, sink) => void sink.push(text);

/**
 * Parse as cli.ts does: a command's exit goes through `deps.exit`; commander's own (help,
 * usage errors) throw `CheckExit`, whose writes are awaited before the code counts.
 */
async function runCli(args: string[], options: { cwd?: string; env?: Record<string, string>; write?: Write } = {}): Promise<Outcome> {
  const write = options.write ?? immediate;
  const out: string[] = [];
  const err: string[] = [];
  let code: number | undefined;
  const group = buildCheckCommand({
    exit: (c) => {
      code = c;
      throw new Exited(c);
    },
    stdout: (s) => write(s, out),
    stderr: (s) => write(s, err),
    cwd: () => options.cwd ?? process.cwd(),
    argv: () => args,
    env: options.env,
    timeoutMs: 20_000,
  });
  try {
    await group.parseAsync(args, { from: 'user' });
  } catch (e) {
    if (e instanceof CheckExit) {
      await e.flush();
      code = e.code;
    } else if (!(e instanceof Exited)) {
      throw e;
    }
  }
  return { code, stdout: out.join(''), stderr: err.join('') };
}

useFakeHome();

describe('Spec 1951 — codev check: commander wiring', () => {
  it('maps commander exits: help and version 0, usage errors 2', () => {
    const e = (exitCode: number, code: string) => new CommanderError(exitCode, code, '');
    expect(exitCodeForCommander(e(0, 'commander.helpDisplayed'))).toBe(0);
    expect(exitCodeForCommander(e(0, 'commander.version'))).toBe(0);
    expect(exitCodeForCommander(e(0, 'commander.help'))).toBe(0);
    expect(exitCodeForCommander(e(1, 'commander.help'))).toBe(2);
    expect(exitCodeForCommander(e(1, 'commander.unknownOption'))).toBe(2);
    expect(exitCodeForCommander(e(1, 'commander.missingArgument'))).toBe(2);
  });

  it.each([[['--help']], [['pr', '--help']], [['help', 'pr']], [['deploy', '--help']]])('%j exits 0 and prints help on stdout', async (args) => {
    const outcome = await runCli(args);
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toMatch(/Usage: check/);
  });

  it('lists pr and deploy with their arguments and --json', async () => {
    const help = (await runCli(['--help'])).stdout;
    expect(help).toMatch(/pr \[options\] <number>/);
    expect(help).toMatch(/deploy \[options\] <numbers\.\.\.>/);
    expect((await runCli(['pr', '--help'])).stdout).toMatch(/--json/);
    expect((await runCli(['deploy', '--help'])).stdout).toMatch(/--json/);
  });

  it.each([
    ['no subcommand', []],
    ['an unknown subcommand', ['merge', '7']],
    ['a missing PR number', ['pr']],
    ['an extra argument', ['pr', '7', '8']],
    ['an unknown option', ['pr', '7', '--jsn']],
    ['deploy without a PR number', ['deploy']],
    ['an unknown deploy option', ['deploy', '7', '--jsn']],
  ])('%s is a usage error: exit 2', async (_name, args) => {
    const outcome = await runCli(args);
    expect(outcome.code).toBe(2);
    expect(outcome.stdout).toBe('');
    expect(outcome.stderr).not.toBe('');
  });

  it('with --json, a usage error prints the ErrorReport on stdout', async () => {
    const outcome = await runCli(['pr', '7', '--jsn', '--json']);
    expect(outcome.code).toBe(2);
    expect(JSON.parse(outcome.stdout)).toEqual({ schema: 1, command: 'pr', error: { message: expect.stringMatching(/^unknown option '--jsn'/) } });

    const deploy = await runCli(['deploy', '--json']);
    expect(deploy.code).toBe(2);
    expect(JSON.parse(deploy.stdout)).toEqual({ schema: 1, command: 'deploy', error: { message: expect.stringMatching(/^missing required argument 'numbers'/) } });
  });

  it('commander exits carry their writes: a slow stdout is flushed before the exit code is taken', async () => {
    const slow: Write = (text, sink) => new Promise((resolve) => setTimeout(() => resolve(void sink.push(text)), 20));
    const usage = await runCli(['pr', '7', '--jsn', '--json'], { write: slow });
    expect(usage.code).toBe(2);
    expect(JSON.parse(usage.stdout)).toMatchObject({ schema: 1, command: 'pr' });

    const help = await runCli(['pr', '--help'], { write: slow });
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/Usage: check pr/);
  });

  it('CheckExit carries commander\'s error and code', async () => {
    const group = buildCheckCommand({ exit: () => undefined, stdout: () => undefined, stderr: () => undefined, cwd: () => '.', argv: () => ['pr'] });
    const thrown = await group.parseAsync(['pr'], { from: 'user' }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(CheckExit);
    expect((thrown as CheckExit).code).toBe(2);
    expect((thrown as CheckExit).commanderError).toBeInstanceOf(CommanderError);
    expect((thrown as CheckExit).commanderError.code).toBe('commander.missingArgument');
  });

  it('an invalid PR number is exit 2: on stderr, or as the ErrorReport with --json', async () => {
    const human = await runCli(['pr', '12a']);
    expect(human).toMatchObject({ code: 2, stdout: '' });
    expect(human.stderr).toBe('codev check pr: invalid PR number "12a": expected a positive integer\n');

    const json = await runCli(['pr', '12a', '--json']);
    expect(json.code).toBe(2);
    expect(JSON.parse(json.stdout)).toEqual({
      schema: 1,
      command: 'pr',
      error: { message: 'invalid PR number "12a": expected a positive integer' },
    });
  });
});

describe('Spec 1951 — codev check pr through the CLI', { timeout: 30_000 }, () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = createFixture();
    const forge = prViewOverride(fx);
    const ci = commitChecksOverride(fx);
    ci.answerAll(passing(2));
    const { head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'a' }]);
    forge.answer(prView(head));
    writeConfig(fx, { forge: { 'pr-view': forge.script, 'commit-checks': ci.script } });
  });

  afterEach(() => {
    fx.cleanup();
  });

  it('prints the summary and exits with the verdict', async () => {
    const outcome = await runCli(['pr', '7'], { cwd: fx.main, env: fx.env });
    expect(outcome.code).toBe(0);
    expect(outcome.stdout.split('\n')[0]).toBe('CLEAR  PR #7 — ready to recommend');
    expect(outcome.stderr).toBe('');
  });

  it('--json prints exactly one PrReport object', async () => {
    const outcome = await runCli(['pr', '7', '--json'], { cwd: fx.main, env: fx.env });
    expect(outcome.code).toBe(0);
    const report = JSON.parse(outcome.stdout);
    expect(report).toMatchObject({ schema: 1, command: 'pr', verdict: 'clear', pr: { number: 7 } });
    expect(report.checks.map((c: { id: string }) => c.id)).toEqual([
      'head', 'state', 'forge', 'attribution', 'trial-merge', 'checks', 'watched', 'linked-issue', 'overlap', 'size', 'to-read',
    ]);
  });
});

describe('Spec 1951 — codev check deploy through the CLI', { timeout: 30_000 }, () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = createFixture();
    const forge = prViewOverride(fx);
    const ci = commitChecksOverride(fx);
    const pr = mergePr(fx, 8);
    forge.answerFor(8, mergedView(pr));
    ci.answer(pr.merge, passing(2));
    writeConfig(fx, { forge: { 'pr-view': forge.script, 'commit-checks': ci.script } });
  });

  afterEach(() => {
    fx.cleanup();
  });

  it('prints the summary and exits with the verdict', async () => {
    const outcome = await runCli(['deploy', '8'], { cwd: fx.main, env: fx.env });
    expect(outcome.code).toBe(0);
    expect(outcome.stdout.split('\n')[0]).toBe('CLEAR  #8 on main; checks on the merge commit passed');
    expect(outcome.stderr).toBe('');
  });

  it('--json prints exactly one DeployReport object', async () => {
    const outcome = await runCli(['deploy', '8', '--json'], { cwd: fx.main, env: fx.env });
    expect(outcome.code).toBe(0);
    const report = JSON.parse(outcome.stdout);
    expect(report).toMatchObject({ schema: 1, command: 'deploy', verdict: 'clear', deployBranch: null, workflow: null, prs: [{ number: 8 }] });
    expect(report.prs[0].checks.map((c: { id: string }) => c.id)).toEqual(['merged', 'on-branch', 'deploy-run', 'merge-checks']);
  });

  it('an invalid PR number is exit 2 naming it', async () => {
    const outcome = await runCli(['deploy', '8', '12a'], { cwd: fx.main, env: fx.env });
    expect(outcome).toMatchObject({ code: 2, stdout: '' });
    expect(outcome.stderr).toBe('codev check deploy: invalid PR number "12a": expected a positive integer\n');
  });
});

describe('Spec 1951 — codev --help lists check', () => {
  let exit: ReturnType<typeof vi.spyOn>;
  let write: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Exited(code ?? 0);
    }) as typeof process.exit);
    write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    exit.mockRestore();
    write.mockRestore();
  });

  it('registers the group on the codev program', async () => {
    const { run } = await import('../../../cli.js');
    await expect(run(['--help'])).rejects.toThrow(Exited);
    const printed = write.mock.calls.map((call: unknown[]) => String(call[0])).join('');
    expect(printed).toMatch(/\n {2}check +Read-only checks/);
  });
});
