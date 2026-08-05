/**
 * PIR #982 — behavioral tests for `resolveBuilderTerminal`, the bounded-retry
 * resolve that absorbs Tower's transient session-registry window.
 *
 * The helper is vscode-free (deps injected), so these are real behavioral
 * tests with an instrumented `sleep` — no vscode mock, no real wall-clock
 * delay — mirroring the `builder-row.ts` testing pattern.
 */

import { describe, it, expect } from 'vitest';
import { backoffDelayMs } from '@cluesmith/codev-sdk/reconnect-policy';
import {
  resolveBuilderTerminal,
  mainCheckoutRoot,
  TERMINAL_RESOLVE_ATTEMPTS,
  type ResolvableBuilder,
} from '../terminal-resolve.js';

interface TestBuilder extends ResolvableBuilder {
  name: string;
}

/** A no-op sleep that records the delays it was asked to wait. */
function recordingSleep() {
  const delays: number[] = [];
  return { sleep: async (ms: number) => { delays.push(ms); }, delays };
}

describe('resolveBuilderTerminal', () => {
  it('opens immediately when the first lookup has a live terminal (happy path)', async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    const outcome = await resolveBuilderTerminal<TestBuilder>(
      '982',
      async () => { calls++; return [{ id: 'builder-pir-982', name: 'pir-982', terminalId: 'term-1' }]; },
      { sleep },
    );

    expect(outcome).toEqual({
      kind: 'ok',
      builder: { id: 'builder-pir-982', name: 'pir-982', terminalId: 'term-1' },
      terminalId: 'term-1',
    });
    expect(calls).toBe(1);      // no retry needed
    expect(delays).toEqual([]); // never slept on the happy path
  });

  it('self-heals: a transient miss followed by a live session resolves to ok', async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    const outcome = await resolveBuilderTerminal<TestBuilder>(
      '982',
      async () => {
        calls++;
        // Attempt 1: builder present but session not yet bound (terminalId absent).
        if (calls === 1) { return [{ id: 'builder-pir-982', name: 'pir-982' }]; }
        // Attempt 2: Tower's rehydrate/reconnect completed — terminal is live.
        return [{ id: 'builder-pir-982', name: 'pir-982', terminalId: 'term-9' }];
      },
      { sleep },
    );

    expect(outcome.kind).toBe('ok');
    expect(calls).toBe(2);
    expect(delays).toHaveLength(1); // slept once, between the two attempts
  });

  it('also self-heals when the builder is absent entirely on the first attempt (spawn race)', async () => {
    const { sleep } = recordingSleep();
    let calls = 0;
    const outcome = await resolveBuilderTerminal<TestBuilder>(
      '982',
      async () => {
        calls++;
        if (calls === 1) { return []; } // not registered in /api/state yet
        return [{ id: 'builder-pir-982', name: 'pir-982', terminalId: 'term-3' }];
      },
      { sleep },
    );

    expect(outcome.kind).toBe('ok');
    expect(calls).toBe(2);
  });

  it('returns missing after exhausting all attempts (persistent — recovery path)', async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    const outcome = await resolveBuilderTerminal<TestBuilder>(
      '982',
      async () => { calls++; return [{ id: 'builder-pir-982', name: 'pir-982' }]; },
      { sleep },
    );

    expect(outcome.kind).toBe('missing');
    expect(calls).toBe(TERMINAL_RESOLVE_ATTEMPTS);     // tried the full budget
    expect(delays).toHaveLength(TERMINAL_RESOLVE_ATTEMPTS - 1); // no sleep after the last attempt
  });

  it('uses the shared backoffDelayMs curve with interactive-tuned params', async () => {
    const { sleep, delays } = recordingSleep();
    await resolveBuilderTerminal<TestBuilder>(
      '982',
      async () => [{ id: 'builder-pir-982', name: 'pir-982' }], // always miss
      { sleep },
    );

    // Delays must equal the shared curve at base 150 / cap 800 for attempts 0..N-2.
    const expected = Array.from({ length: TERMINAL_RESOLVE_ATTEMPTS - 1 }, (_, i) =>
      backoffDelayMs(i, { baseMs: 150, capMs: 800 }),
    );
    expect(delays).toEqual(expected);
    expect(expected[0]).toBe(150); // sanity: snappy first retry, not the 1s reconnect default
  });

  it('short-circuits to ambiguous without retrying when the id tail matches >1 builder', async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    const outcome = await resolveBuilderTerminal<TestBuilder>(
      '5',
      async () => {
        calls++;
        return [
          { id: 'builder-spir-5', name: 'spir-5' },
          { id: 'builder-bugfix-5', name: 'bugfix-5' },
        ];
      },
      { sleep },
    );

    expect(outcome.kind).toBe('ambiguous');
    if (outcome.kind === 'ambiguous') { expect(outcome.matches).toHaveLength(2); }
    expect(calls).toBe(1);      // ambiguity is stable — no point retrying
    expect(delays).toEqual([]);
  });

  it('respects an overridden attempt count', async () => {
    const { sleep } = recordingSleep();
    let calls = 0;
    const outcome = await resolveBuilderTerminal<TestBuilder>(
      '982',
      async () => { calls++; return []; },
      { sleep, attempts: 2 },
    );

    expect(outcome.kind).toBe('missing');
    expect(calls).toBe(2);
  });
});

describe('mainCheckoutRoot', () => {
  it('returns a normal main-checkout path unchanged', () => {
    expect(mainCheckoutRoot('/Users/me/repos/codev')).toBe('/Users/me/repos/codev');
  });

  it('strips a trailing /.builders/<id> worktree segment back to the main root', () => {
    // The recover command must run from the main checkout even when VSCode is
    // rooted at a worktree window (PIR #982 — the codex review finding).
    expect(mainCheckoutRoot('/Users/me/repos/codev/.builders/pir-982')).toBe('/Users/me/repos/codev');
  });

  it('tolerates a trailing slash on the worktree path', () => {
    expect(mainCheckoutRoot('/Users/me/repos/codev/.builders/spir-153/')).toBe('/Users/me/repos/codev');
  });

  it('does not strip when .builders is not the leaf segment', () => {
    // Only a worktree-rooted window (leaf == .builders/<id>) should be rewritten;
    // a deeper path is left alone rather than guessed at.
    const deep = '/Users/me/repos/codev/.builders/pir-982/packages/vscode';
    expect(mainCheckoutRoot(deep)).toBe(deep);
  });

  it('handles Windows-style separators', () => {
    expect(mainCheckoutRoot('C:\\repos\\codev\\.builders\\pir-982')).toBe('C:\\repos\\codev');
  });
});
