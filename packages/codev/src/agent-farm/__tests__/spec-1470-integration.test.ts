/**
 * Spec 1470, Phase 8 — porch and the self-refresh orchestrator, driven together.
 *
 * ## Why this exists separately from the full-protocol simulation
 *
 * The plan asks for a simulation that drives "`next()` and the orchestrator
 * together with fake ports". The porch-side simulation drives only `next()`: on
 * a refresh task it records the task and asks for work again, exactly as a
 * compliant builder would. Codex pointed out what that leaves uncovered — it
 * would pass unchanged if every emitted refresh **failed its receipt check,
 * never scheduled a re-entry, or never cleared**, because nothing downstream of
 * the emission is ever executed.
 *
 * So this closes the loop: when porch emits a boundary, the orchestrator really
 * runs against behavioural fakes, and the assertions are about what it DID —
 * a clear sent, a re-entry scheduled, the challenge consumed — not that a task
 * with the right subject appeared.
 *
 * The fakes are the ones the Phase 3 unit tests use, imported rather than
 * re-declared, so this cannot drift into testing a differently-behaved double.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fsNode from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { next } from '../../commands/porch/next.js';
import { beginSelfRefresh, runSelfRefresh } from '../commands/reset/self.js';
import { STATE_FILE_NAME } from '../commands/reset/constants.js';
import { nonceMarker, stateFilePath } from '../commands/reset/receipt.js';
import {
  FakeClock,
  FakeFs,
  FakeGit,
  FakeTerminal,
  WORKTREE,
  makeContext,
} from './helpers/spec-1470-fakes.js';
import {
  PROJECT_ID,
  baseState,
  isRefreshTask,
  readState,
  spirLike,
  writeApprovedSpec,
  writeApprovingReviews,
  writePlan,
  writeProtocol,
  writeState,
} from '../../commands/porch/__tests__/helpers/spec-1470-fixture.js';

vi.mock('../../lib/config.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../lib/config.js')>();
  return {
    ...original,
    loadConfig: (_workspaceRoot: string) => ({
      porch: { consultation: { models: ['codex', 'claude'] } },
    }),
  };
});

vi.mock('../../lib/github.js', () => ({
  fetchIssue: vi.fn().mockResolvedValue(null),
}));

let root: string;
const PLAN_PHASES = ['phase_a', 'phase_b'];

beforeEach(() => {
  root = fsNode.mkdtempSync(path.join(tmpdir(), 'porch-1470-integ-'));
  fsNode.mkdirSync(path.join(root, 'codev'), { recursive: true });
});

/** One completed refresh, performed by the real orchestrator against fakes. */
interface PerformedRefresh {
  boundary: string;
  steps: string[];
  cleared: boolean;
  reentryDelaySeconds: number | null;
  challengeGone: boolean;
  failure: string | null;
}

/**
 * Drive porch, and when it emits a boundary, actually perform the refresh.
 *
 * `saveWriter` decides what the builder writes in response to the challenge —
 * the seam that lets the same driver exercise the honest path and the refusal
 * path without a second copy of the loop.
 */
async function driveWithRefresh(
  saveWriter: (nonce: string) => string | null,
): Promise<{ performed: PerformedRefresh[]; finalStatus: string; refreshTasks: number }> {
  const performed: PerformedRefresh[] = [];
  let refreshTasks = 0;
  let finalStatus = 'never-ran';

  for (let step = 0; step < 60; step++) {
    const response = await next(root, PROJECT_ID);
    finalStatus = response.status;
    if (response.status === 'complete' || response.status === 'verified') break;
    if (response.status === 'error') break;

    const state = readState(root);

    if (response.status === 'gate_pending') {
      const entry = Object.entries(state.gates).find(([, g]) => g.status !== 'approved');
      if (!entry) break;
      state.gates[entry[0]] = { ...state.gates[entry[0]], status: 'approved' };
      writeState(root, state);
      continue;
    }

    if (isRefreshTask(response)) {
      refreshTasks++;
      const boundary = (state.context_refreshes ?? []).slice(-1)[0]?.boundary ?? '(none)';

      // The real handshake, both halves, against behavioural fakes.
      const fs = new FakeFs();
      const clock = new FakeClock();
      const terminal = new FakeTerminal();
      const git = new FakeGit();

      const begun = beginSelfRefresh({ fs, clock, worktree: WORKTREE, boundary });
      const save = saveWriter(begun.nonce);
      if (save !== null) fs.write(stateFilePath(WORKTREE, STATE_FILE_NAME), save);

      const result = await runSelfRefresh({
        fs,
        clock,
        terminal,
        git,
        context: makeContext(),
        buildSpawnPrompt: () => 'FULL SPAWN PROMPT BODY',
        // Required: without it the assembly gate refuses (R3 is complete-or-throw)
        // and every refresh aborts at `assembly-failed`.
        buildResumeNotice: (id: string) => `## RESUME SESSION\n\nRun porch next for ${id}.`,
        expectedBoundary: boundary,
      });

      performed.push({
        boundary,
        // `.name`, not `.step`. The first draft guessed `.step`, every entry
        // came back `undefined`, and the two positive tests failed loudly —
        // while the refusal test PASSED, because `not.toContain('clear')` is
        // satisfied by a list of undefineds. Hence the positive floor added
        // there.
        steps: result.steps.map(x => x.name),
        cleared: terminal.raw.some(t => t.includes('/clear')),
        reentryDelaySeconds: terminal.scheduled[0]?.delaySeconds ?? null,
        challengeGone: !fs.exists(path.join(WORKTREE, '.builder-refresh-challenge')),
        // `failure` is a plain string union, not an object. Reading `.code` off
        // it silently yielded `undefined`, so the assertion meant to surface an
        // abort reported "no failure" while the run had aborted — the second
        // time in this file that guessing a shape produced a quietly wrong
        // reading rather than an error.
        failure: result.failure ?? null,
      });
      continue;
    }

    if (response.tasks?.some(t => t.subject.includes('consultation'))) {
      writeApprovingReviews(root, state.current_plan_phase ?? state.phase, state.iteration);
      continue;
    }

    const fresh = readState(root);
    fresh.build_complete = true;
    writeState(root, fresh);
  }

  return { performed, finalStatus, refreshTasks };
}

function setup(): void {
  writeProtocol(root, spirLike());
  writeApprovedSpec(root);
  writePlan(root, PLAN_PHASES, true);
  writeState(root, baseState({ phase: 'specify' }));
}

describe('porch emission composed with the real orchestrator', () => {
  it('every emitted boundary actually clears and schedules a re-entry', async () => {
    setup();
    const { performed, refreshTasks, finalStatus } = await driveWithRefresh(
      nonce => `${nonceMarker(nonce)}\n\n${'Receipts, deviations, standing orders. '.repeat(60)}`,
    );

    fsNode.writeFileSync('/tmp/integ-diag.json', JSON.stringify(performed, null, 2));
    expect(finalStatus).toBe('complete');
    expect(performed.length, 'no refresh was performed').toBeGreaterThan(0);
    expect(performed.length).toBe(refreshTasks);

    for (const r of performed) {
      // These four are what the porch-only simulation cannot see. Each would
      // stay green there while being false.
      expect(r.failure, `${r.boundary}: aborted`).toBeNull();
      expect(r.steps, `${r.boundary}: receipt not accepted`).toContain('receipt-accepted');
      expect(r.steps, `${r.boundary}: nothing cleared`).toContain('clear');
      expect(r.cleared, `${r.boundary}: no /clear reached the terminal`).toBe(true);
      expect(r.reentryDelaySeconds, `${r.boundary}: no re-entry scheduled`).toBe(15);
      expect(r.challengeGone, `${r.boundary}: challenge left on disk`).toBe(true);
    }
  });

  it('schedules the re-entry BEFORE it clears, at every boundary', async () => {
    // The ordering the whole design rests on, asserted over composed runs rather
    // than a constructed one: clear-then-schedule can strand a builder with no
    // route back.
    setup();
    const { performed } = await driveWithRefresh(
      nonce => `${nonceMarker(nonce)}\n\n${'Receipts and standing orders. '.repeat(60)}`,
    );

    expect(performed.length).toBeGreaterThan(0);
    for (const r of performed) {
      expect(r.steps.indexOf('reentry-scheduled')).toBeLessThan(r.steps.indexOf('clear-attempted'));
    }
  });

  it('a refused refresh clears nothing, and porch still completes the protocol', async () => {
    // The fail-safe, composed: the builder writes a stub, every refresh is
    // rejected, and the project must still finish. A refresh must never be able
    // to wedge a protocol.
    setup();
    const { performed, finalStatus } = await driveWithRefresh(() => 'too short');

    expect(performed.length).toBeGreaterThan(0);
    for (const r of performed) {
      // Proves the run actually reached the gate rather than producing an empty
      // step log that would satisfy every negative below.
      expect(r.steps, `${r.boundary}: never even read the challenge`).toContain('challenge-read');
      expect(r.steps, `${r.boundary}: cleared on a rejected save`).not.toContain('clear');
      expect(r.cleared).toBe(false);
      expect(r.reentryDelaySeconds, `${r.boundary}: scheduled a re-entry it never earned`).toBeNull();
    }
    expect(finalStatus, 'a refused refresh must not wedge the protocol').toBe('complete');
  });
});
