/**
 * `afx reset` → `afx refresh` rename — Issue #1489.
 *
 * The rename exists because "reset" reads as "throw work away", which is the
 * opposite of what this command guarantees: every gate aborts *without*
 * clearing. So the canonical spelling is `refresh`, and `reset` survives one
 * release as an alias that announces its own deprecation.
 *
 * Both halves of that need pinning. An alias that silently works is one nobody
 * migrates off; an alias that stops working is a breaking change nobody
 * announced. These tests hold the alias to exactly one behaviour: identical run,
 * one line of notice, on stderr.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));

vi.mock('../commands/reset.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../commands/reset.js')>();
  return { ...actual, refresh: mockRefresh };
});

describe('Issue #1489 — the deprecation notice', () => {
  it('names both spellings and says the alias is going away', async () => {
    const { RESET_ALIAS_NOTICE } = await import('../commands/reset.js');

    expect(RESET_ALIAS_NOTICE).toBe(
      'afx reset has been renamed to afx refresh; this alias will be removed in a future release',
    );
  });

  it('goes to stderr, so it cannot contaminate the run report on stdout', async () => {
    // The report is what an architect reads (and occasionally pipes) to decide
    // whether the builder was cleared. A deprecation line in that stream is
    // noise at best and a parse break at worst.
    const { warnResetAlias, RESET_ALIAS_NOTICE } = await import('../commands/reset.js');

    const errWrites: string[] = [];
    const outWrites: string[] = [];
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
      errWrites.push(String(chunk));
      return true;
    });
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      outWrites.push(String(chunk));
      return true;
    });
    try {
      warnResetAlias();
    } finally {
      // Collected into arrays rather than asserted off the spies: `mockRestore`
      // clears recorded calls as well as restoring the original.
      err.mockRestore();
      out.mockRestore();
    }

    expect(errWrites).toEqual([`${RESET_ALIAS_NOTICE}\n`]);
    expect(outWrites).toEqual([]);
  });
});

describe('Issue #1489 — CLI surface', () => {
  let stderr: string[];
  let restore: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRefresh.mockResolvedValue(undefined);
    stderr = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
      stderr.push(String(chunk));
      return true;
    });
    restore = () => spy.mockRestore();
  });

  afterEach(() => restore());

  it('runs the refresh command under its canonical name, silently', async () => {
    const { runAgentFarm } = await import('../cli.js');

    await runAgentFarm(['refresh', '1273', '--note', 'rebase first']);

    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockRefresh.mock.calls[0][0]).toMatchObject({
      builder: '1273',
      note: 'rebase first',
    });
    expect(stderr.join('')).not.toMatch(/renamed/);
  });

  it('still runs under the deprecated `reset` spelling, with the same arguments', async () => {
    const { runAgentFarm } = await import('../cli.js');

    await runAgentFarm(['reset', '1273', '--note', 'rebase first']);

    // Identical call, not a degraded one: the alias is a spelling, not a mode.
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockRefresh.mock.calls[0][0]).toMatchObject({
      builder: '1273',
      note: 'rebase first',
    });
  });

  it('prints the deprecation notice once when the alias is used', async () => {
    const { runAgentFarm } = await import('../cli.js');
    const { RESET_ALIAS_NOTICE } = await import('../commands/reset.js');

    await runAgentFarm(['reset', '1273']);

    const emitted = stderr.filter(line => line.includes(RESET_ALIAS_NOTICE));
    expect(emitted).toHaveLength(1);
  });

  it('forwards every safety-gate flag through the alias unchanged', async () => {
    // The alias shares one action body with the canonical command. If it ever
    // grows its own copy, the flag validation that guards R2/R4 could drift on
    // one side and silently disable a gate for whoever still types `reset`.
    const { runAgentFarm } = await import('../cli.js');

    await runAgentFarm([
      'reset',
      '1273',
      '--dry-run',
      '--interrupt-first',
      '--mode',
      'soft',
      '--timeout',
      '600',
      '--min-bytes',
      '2000',
      '--quiet-window',
      '3000',
    ]);

    expect(mockRefresh.mock.calls[0][0]).toMatchObject({
      builder: '1273',
      dryRun: true,
      interruptFirst: true,
      mode: 'soft',
      timeout: 600,
      minBytes: 2000,
      quietWindow: 3000,
    });
  });

  it('lists refresh as a command and marks reset deprecated in --help', async () => {
    // Help text is where the next architect learns which spelling to type.
    const { runAgentFarm } = await import('../cli.js');
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      out.push(String(chunk));
      return true;
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);

    try {
      await runAgentFarm(['--help']);
    } catch {
      // Commander exits after printing help.
    } finally {
      spy.mockRestore();
      exit.mockRestore();
    }

    const help = out.join('');
    expect(help).toMatch(/^\s+refresh \[options\] \[builder\]/m);
    expect(help).toMatch(/^\s+reset \[options\] \[builder\]/m);
    // The canonical spelling must come first, so a skim lands on it.
    expect(help.indexOf('refresh [options]')).toBeLessThan(help.indexOf('reset [options]'));
    expect(help).toMatch(/\[deprecated\] Alias for 'afx refresh'/);
  });
});
