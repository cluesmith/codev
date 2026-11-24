/**
 * Spec 1951 — the `codev check` command group: commander wiring and exit codes.
 *
 * Help exits 0, every usage error exits 2 (not commander's 1), and with `--json` a usage
 * error on a subcommand prints its `ErrorReport` on stdout. Parsed through `parseAsync`
 * with an injected exit, so nothing here ends the test process.
 */

import { CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCheckCommand, exitCodeForCommander } from '../index.js';
import { useFakeHome } from './helpers/fake-home.js';
import { createFixture, type Fixture } from './helpers/git-fixture.js';
import { prView, prViewOverride, pushBranch, writeConfig } from './helpers/pr-fixture.js';

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

async function runCli(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<Outcome> {
  const out: string[] = [];
  const err: string[] = [];
  let code: number | undefined;
  const group = buildCheckCommand({
    exit: (c) => {
      code = c;
      throw new Exited(c);
    },
    stdout: (s) => void out.push(s),
    stderr: (s) => void err.push(s),
    cwd: () => options.cwd ?? process.cwd(),
    argv: () => args,
    env: options.env,
    timeoutMs: 20_000,
  });
  try {
    await group.parseAsync(args, { from: 'user' });
  } catch (e) {
    // The exit callback rethrows commander's own error after recording the code.
    if (!(e instanceof Exited) && !(e instanceof CommanderError)) throw e;
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

  it.each([[['--help']], [['pr', '--help']], [['help', 'pr']]])('%j exits 0 and prints help on stdout', async (args) => {
    const outcome = await runCli(args);
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toMatch(/Usage: check/);
  });

  it('lists pr with its argument and --json', async () => {
    expect((await runCli(['--help'])).stdout).toMatch(/pr \[options\] <number>/);
    expect((await runCli(['pr', '--help'])).stdout).toMatch(/--json/);
  });

  it.each([
    ['no subcommand', []],
    ['an unknown subcommand', ['merge', '7']],
    ['a missing PR number', ['pr']],
    ['an extra argument', ['pr', '7', '8']],
    ['an unknown option', ['pr', '7', '--jsn']],
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
    const { head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'a' }]);
    forge.answer(prView(head));
    writeConfig(fx, { forge: { 'pr-view': forge.script } });
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
    expect(report.checks.map((c: { id: string }) => c.id)).toEqual(['head', 'attribution', 'trial-merge', 'watched', 'overlap', 'size', 'to-read']);
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
