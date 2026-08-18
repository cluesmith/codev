/**
 * Spec 1470, Phase 3 — self-refresh orchestrator invariants.
 *
 * ## How these tests are written, and why it matters here more than anywhere
 *
 * Every assertion about a refusal checks the STEP LOG, not the return value.
 * The property being protected is "no `clear` step was ever appended", which is
 * strictly stronger than "an error was returned": a run could return a failure
 * having already sent the clear, and a return-value test would pass while a
 * builder's context lay destroyed.
 *
 * This project has already shipped five tests that passed without exercising
 * what they named. The code under test here ends in `/clear`, which has no undo,
 * so `expectNoClear()` is applied to every abort path without exception.
 *
 * Ports are fakes with no I/O, and the clock is virtual — the 2 s stability
 * window costs nothing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import {
  beginSelfRefresh,
  buildBoundarySaveRequest,
  challengeFilePath,
  didClear,
  formatSelfRefreshReport,
  reorientFilePath,
  runSelfRefresh,
  type SelfRefreshClockPort,
  type SelfRefreshFsPort,
  type SelfRefreshResult,
  type SelfGitPort,
  type SelfTerminalPort,
} from '../commands/reset/self.js';
import {
  CHALLENGE_FILE_NAME,
  DEFAULT_MIN_BYTES,
  DEFAULT_STABILITY_WINDOW_MS,
  REORIENT_FILE_NAME,
  STATE_FILE_NAME,
} from '../commands/reset/constants.js';
import { nonceMarker } from '../commands/reset/receipt.js';
import type { ResolvedBuilderContext } from '../commands/reset/context.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const WORKTREE = '/tmp/fake-worktree';
const NONCE = 'abc123def456';

class FakeFs implements SelfRefreshFsPort {
  files = new Map<string, string>();
  /** Paths whose write() should throw, to exercise the R1 failure. */
  failWrites = new Set<string>();
  /** Paths whose remove() should throw. */
  failRemoves = new Set<string>();

  sizeOf(path: string): number | null {
    const v = this.files.get(path);
    return v === undefined ? null : Buffer.byteLength(v, 'utf-8');
  }
  read(path: string): string | null {
    return this.files.get(path) ?? null;
  }
  write(path: string, content: string): void {
    if (this.failWrites.has(path)) throw new Error(`simulated write failure: ${path}`);
    this.files.set(path, content);
  }
  remove(path: string): void {
    if (this.failRemoves.has(path)) throw new Error(`simulated remove failure: ${path}`);
    this.files.delete(path);
  }
  exists(path: string): boolean {
    return this.files.has(path);
  }
}

class FakeClock implements SelfRefreshClockPort {
  t = 1_000;
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
}

class FakeTerminal implements SelfTerminalPort {
  scheduled: Array<{ message: string; delaySeconds: number }> = [];
  raw: string[] = [];
  failSchedule = false;
  failRaw = false;

  async scheduleReentry(message: string, delaySeconds: number): Promise<void> {
    if (this.failSchedule) throw new Error('simulated Tower unreachable');
    this.scheduled.push({ message, delaySeconds });
  }
  async sendRaw(text: string): Promise<void> {
    if (this.failRaw) throw new Error('simulated PTY write failure');
    this.raw.push(text);
  }
}

class FakeGit implements SelfGitPort {
  dirty = false;
  hasUncommittedTrackedChanges(): boolean {
    return this.dirty;
  }
}

function makeContext(overrides: Partial<ResolvedBuilderContext> = {}): ResolvedBuilderContext {
  return {
    builderId: 'spir-1470',
    worktree: WORKTREE,
    branch: 'builder/spir-1470',
    protocol: 'spir',
    protocolSource: 'status.yaml',
    mode: 'strict',
    modeSource: 'builder-prompt',
    harnessName: 'claude',
    harness: {} as ResolvedBuilderContext['harness'],
    porch: {
      projectId: '1470',
      projectName: 'automatic-builder-context-refr',
      phase: 'implement',
    } as ResolvedBuilderContext['porch'],
    specName: '1470-automatic-builder-context-refr',
    specPath: 'codev/specs/1470-automatic-builder-context-refr.md',
    planPath: 'codev/plans/1470-automatic-builder-context-refr.md',
    issueNumber: '1470',
    ...overrides,
  } as ResolvedBuilderContext;
}

/** A spawn prompt that satisfies R3's required markers. */
const buildSpawnPrompt = (): string => 'FULL SPAWN PROMPT BODY';
const buildResumeNotice = (id: string): string => `## RESUME SESSION\n\nRun porch next for ${id}.`;

const statePath = join(WORKTREE, STATE_FILE_NAME);
const challengePath = join(WORKTREE, CHALLENGE_FILE_NAME);
const reorientPath = join(WORKTREE, REORIENT_FILE_NAME);

/** A state file that passes the gate: carries the nonce and clears min-bytes. */
function goodSave(nonce = NONCE): string {
  return `${nonceMarker(nonce)}\n${'x'.repeat(DEFAULT_MIN_BYTES + 50)}`;
}

let fs: FakeFs;
let clock: FakeClock;
let terminal: FakeTerminal;
let git: FakeGit;

beforeEach(() => {
  fs = new FakeFs();
  clock = new FakeClock();
  terminal = new FakeTerminal();
  git = new FakeGit();
});

function run(overrides: Partial<Parameters<typeof runSelfRefresh>[0]> = {}) {
  return runSelfRefresh({
    fs,
    clock,
    terminal,
    git,
    context: makeContext(),
    buildSpawnPrompt,
    buildResumeNotice,
    ...overrides,
  });
}

/** Seed a valid challenge + a passing save. */
function seedHappyPath(nonce = NONCE, boundary = 'enter:review'): void {
  fs.write(challengePath, JSON.stringify({ nonce, issuedAt: 1, boundary }));
  fs.write(statePath, goodSave(nonce));
}

// ---------------------------------------------------------------------------
// The assertion this whole file is built around
// ---------------------------------------------------------------------------

/**
 * The clear never happened — by the log, by the terminal, and by the helper.
 *
 * Three independent witnesses on purpose. A step log is only evidence if it
 * matches what the ports actually saw.
 */
function expectNoClear(result: SelfRefreshResult): void {
  expect(result.steps.map(s => s.name)).not.toContain('clear');
  expect(didClear(result)).toBe(false);
  expect(terminal.raw).toHaveLength(0);
}

// ---------------------------------------------------------------------------
// begin
// ---------------------------------------------------------------------------

describe('beginSelfRefresh', () => {
  it('writes a challenge carrying the nonce, and returns the save request', () => {
    const result = beginSelfRefresh({
      fs,
      clock,
      worktree: WORKTREE,
      boundary: 'enter:implement',
      makeNonce: () => NONCE,
    });

    expect(result.nonce).toBe(NONCE);
    expect(result.challengePath).toBe(challengePath);
    expect(result.statePath).toBe(statePath);

    const stored = JSON.parse(fs.read(challengePath)!);
    expect(stored.nonce).toBe(NONCE);
    expect(stored.boundary).toBe('enter:implement');

    // The request must carry the exact marker the gate later matches on.
    expect(result.saveRequest).toContain(nonceMarker(NONCE));
  });

  it('sends nothing and clears nothing', () => {
    beginSelfRefresh({ fs, clock, worktree: WORKTREE, makeNonce: () => NONCE });
    expect(terminal.raw).toHaveLength(0);
    expect(terminal.scheduled).toHaveLength(0);
  });

  it('overwrites a previous challenge, invalidating an earlier boundary nonce', () => {
    // This is what stops a stale .builder-state.md from a previous boundary
    // satisfying the gate without the builder writing anything.
    beginSelfRefresh({ fs, clock, worktree: WORKTREE, makeNonce: () => 'old-nonce' });
    beginSelfRefresh({ fs, clock, worktree: WORKTREE, makeNonce: () => 'new-nonce' });
    expect(JSON.parse(fs.read(challengePath)!).nonce).toBe('new-nonce');
  });
});

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe('happy path', () => {
  it('completes with the exact expected step order', async () => {
    seedHappyPath();

    const result = await run();

    expect(result.outcome).toBe('completed');
    expect(result.steps.map(s => s.name)).toEqual([
      'challenge-read',
      'worktree-checked',
      'receipt-accepted',
      'assemble',
      'reorient-written',
      'reentry-scheduled',
      'clear',
      'challenge-consumed',
    ]);
  });

  it('writes the re-orientation to disk BEFORE clearing (R1)', async () => {
    seedHappyPath();
    const result = await run();

    expect(fs.read(reorientPath)).toBeTruthy();
    const names = result.steps.map(s => s.name);
    expect(names.indexOf('reorient-written')).toBeLessThan(names.indexOf('clear'));
  });

  it('schedules the re-entry BEFORE clearing — the inversion of /arch-save', async () => {
    seedHappyPath();
    const result = await run();

    const names = result.steps.map(s => s.name);
    expect(names.indexOf('reentry-scheduled')).toBeLessThan(names.indexOf('clear'));
    expect(terminal.scheduled).toHaveLength(1);
  });

  it('delivers /clear as raw typed input, not as a message', async () => {
    // A `/clear` sent through the message channel arrives as literal text and
    // never executes.
    seedHappyPath();
    await run();

    expect(terminal.raw).toEqual(['/clear']);
    expect(terminal.scheduled[0].message).not.toBe('/clear');
  });

  it('consumes the challenge, so a second execute refuses', async () => {
    seedHappyPath();
    await run();
    expect(fs.exists(challengePath)).toBe(false);

    const second = await run();
    expect(second.outcome).toBe('aborted');
    expect(second.failure).toBe('no-challenge');
  });

  it('never writes status.yaml', async () => {
    seedHappyPath();
    await run();
    const touched = [...fs.files.keys()];
    expect(touched.some(p => p.includes('status.yaml'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Every abort path — each asserts NO CLEAR
// ---------------------------------------------------------------------------

describe('gate refusals never clear', () => {
  it('missing challenge → abort', async () => {
    fs.write(statePath, goodSave());
    const result = await run();

    expect(result.failure).toBe('no-challenge');
    expectNoClear(result);
  });

  it('malformed challenge JSON → abort', async () => {
    fs.write(challengePath, 'not json at all');
    fs.write(statePath, goodSave());
    const result = await run();

    expect(result.failure).toBe('no-challenge');
    expectNoClear(result);
  });

  it('challenge without a nonce → abort', async () => {
    fs.write(challengePath, JSON.stringify({ issuedAt: 1 }));
    fs.write(statePath, goodSave());
    const result = await run();

    expect(result.failure).toBe('no-challenge');
    expectNoClear(result);
  });

  it('dirty worktree → abort', async () => {
    seedHappyPath();
    git.dirty = true;
    const result = await run();

    expect(result.failure).toBe('dirty-worktree');
    expect(result.reason).toMatch(/uncommitted tracked changes/i);
    expectNoClear(result);
  });

  it('missing state file → abort naming the file', async () => {
    fs.write(challengePath, JSON.stringify({ nonce: NONCE, issuedAt: 1 }));
    const result = await run();

    expect(result.failure).toBe('receipt-rejected');
    expect(result.reason).toContain(statePath);
    expectNoClear(result);
  });

  it('state file under the minimum size → abort naming the size gate', async () => {
    fs.write(challengePath, JSON.stringify({ nonce: NONCE, issuedAt: 1 }));
    fs.write(statePath, `${nonceMarker(NONCE)}\ntiny`);
    const result = await run();

    expect(result.failure).toBe('receipt-rejected');
    expect(result.reason).toMatch(/stub|minimum/i);
    expectNoClear(result);
  });

  it('state file carrying a PREVIOUS boundary nonce → wrong-nonce, no clear', async () => {
    // The replay case the challenge handshake exists to prevent.
    fs.write(challengePath, JSON.stringify({ nonce: 'this-run-nonce', issuedAt: 2 }));
    fs.write(statePath, goodSave('an-older-nonce'));
    const result = await run();

    expect(result.failure).toBe('receipt-rejected');
    expect(result.reason).toMatch(/stale|nonce/i);
    expectNoClear(result);
  });

  it('state file still growing across the stability window → abort', async () => {
    fs.write(challengePath, JSON.stringify({ nonce: NONCE, issuedAt: 1 }));
    fs.write(statePath, goodSave());

    // Grow the file during the orchestrator's sleep, so the two observations
    // disagree exactly the way a mid-write save would.
    const originalSleep = clock.sleep.bind(clock);
    clock.sleep = async (ms: number) => {
      await originalSleep(ms);
      fs.write(statePath, `${goodSave()}${'y'.repeat(500)}`);
    };

    const result = await run();

    expect(result.failure).toBe('receipt-rejected');
    expect(result.reason).toMatch(/still being written|partial/i);
    expectNoClear(result);
  });

  it('re-orientation assembly failure → abort, no partial frame, no clear', async () => {
    seedHappyPath();
    // A context missing a required field makes assembleReorientation throw (R3).
    const result = await run({ context: makeContext({ branch: '' }) });

    expect(result.failure).toBe('assembly-failed');
    expectNoClear(result);
    expect(fs.exists(reorientPath)).toBe(false);
  });

  it('re-orientation write failure → abort, no clear (R1)', async () => {
    seedHappyPath();
    fs.failWrites.add(reorientPath);

    const result = await run();

    expect(result.failure).toBe('assembly-failed');
    expect(result.reason).toMatch(/R1/);
    expectNoClear(result);
  });

  it('re-entry scheduling rejected → abort, NO CLEAR', async () => {
    // The ordering that distinguishes this from /arch-save. If the schedule
    // fails after a clear, the builder is gone with nobody coming back.
    seedHappyPath();
    terminal.failSchedule = true;

    const result = await run();

    expect(result.failure).toBe('reentry-failed');
    expect(result.reason).toMatch(/NOT clearing/i);
    expectNoClear(result);
  });

  it('no abort path writes status.yaml', async () => {
    fs.write(challengePath, JSON.stringify({ nonce: NONCE, issuedAt: 1 }));
    const result = await run();

    expect(result.outcome).toBe('aborted');
    expect([...fs.files.keys()].some(p => p.includes('status.yaml'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The one failure AFTER the point of no return
// ---------------------------------------------------------------------------

describe('clear failure', () => {
  it('reports the harmless direction: re-entry queued, context intact', async () => {
    seedHappyPath();
    terminal.failRaw = true;

    const result = await run();

    expect(result.failure).toBe('clear-failed');
    // The clear step is NOT logged, because it never succeeded.
    expect(result.steps.map(s => s.name)).not.toContain('clear');
    // But the re-entry IS queued — this is the benign asymmetry.
    expect(terminal.scheduled).toHaveLength(1);
    expect(result.reason).toMatch(/context is intact/i);
  });
});

// ---------------------------------------------------------------------------
// Ordering invariants asserted over the log
// ---------------------------------------------------------------------------

describe('ordering invariants', () => {
  const scenarios: Array<{ name: string; setUp: () => void }> = [
    { name: 'no challenge', setUp: () => fs.write(statePath, goodSave()) },
    {
      name: 'dirty worktree',
      setUp: () => {
        seedHappyPath();
        git.dirty = true;
      },
    },
    {
      name: 'bad save',
      setUp: () => fs.write(challengePath, JSON.stringify({ nonce: NONCE, issuedAt: 1 })),
    },
    {
      name: 'schedule fails',
      setUp: () => {
        seedHappyPath();
        terminal.failSchedule = true;
      },
    },
  ];

  for (const s of scenarios) {
    it(`aborted run (${s.name}) contains no clear step`, async () => {
      s.setUp();
      const result = await run();
      expect(result.outcome).toBe('aborted');
      expectNoClear(result);
    });
  }

  it('clear is never preceded by a missing prerequisite', async () => {
    seedHappyPath();
    const result = await run();
    const names = result.steps.map(s => s.name);
    const clearIndex = names.indexOf('clear');

    expect(clearIndex).toBeGreaterThan(-1);
    for (const required of ['receipt-accepted', 'assemble', 'reorient-written', 'reentry-scheduled'] as const) {
      const i = names.indexOf(required);
      expect(i, `${required} must precede clear`).toBeGreaterThan(-1);
      expect(i).toBeLessThan(clearIndex);
    }
  });
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

describe('dry run', () => {
  it('verifies and assembles but sends nothing and consumes nothing', async () => {
    seedHappyPath();

    const result = await run({ dryRun: true });

    expect(result.steps.map(s => s.name)).toEqual([
      'challenge-read',
      'worktree-checked',
      'receipt-accepted',
      'assemble',
    ]);
    expectNoClear(result);
    expect(terminal.scheduled).toHaveLength(0);
    expect(fs.exists(reorientPath)).toBe(false);
    // The challenge survives, so the real run can still use it.
    expect(fs.exists(challengePath)).toBe(true);
    expect(result.payload).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The boundary-aware save request
// ---------------------------------------------------------------------------

describe('buildBoundarySaveRequest', () => {
  it('asks for pointers rather than a full working-state dump', () => {
    const request = buildBoundarySaveRequest(NONCE, statePath, 'enter:implement');

    expect(request).toContain(nonceMarker(NONCE));
    expect(request).toMatch(/Pointers, not prose/i);
    expect(request).toMatch(/Do not restate them/i);
    // The mid-phase request's instruction must NOT leak into a boundary save.
    expect(request).not.toMatch(/Do not summarise for brevity/i);
  });

  it('adds the cold-read exclusions at the review boundary only', () => {
    const review = buildBoundarySaveRequest(NONCE, statePath, 'enter:review');
    const other = buildBoundarySaveRequest(NONCE, statePath, 'enter:implement');

    expect(review).toMatch(/REVIEW BOUNDARY/);
    expect(review).toMatch(/any assessment of whether your implementation is correct/i);
    expect(review).toMatch(/defence|defense/i);

    expect(other).not.toMatch(/REVIEW BOUNDARY/);
  });

  it('always carries the residue artifacts cannot supply', () => {
    const request = buildBoundarySaveRequest(NONCE, statePath, 'enter:review');
    for (const item of ['Receipts', 'Deviations', 'Flaky', 'Deferred', 'Standing orders']) {
      expect(request).toContain(item);
    }
  });
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

describe('formatSelfRefreshReport', () => {
  it('states plainly that no clear was sent when a gate refused', async () => {
    fs.write(statePath, goodSave());
    const result = await run();

    const report = formatSelfRefreshReport(result);
    expect(report).toMatch(/ABORTED/);
    expect(report).toMatch(/No clear was sent\. Your context is intact\./);
  });

  it('reports the completed path with its step order', async () => {
    seedHappyPath();
    const result = await run();

    const report = formatSelfRefreshReport(result);
    expect(report).toMatch(/Context refresh complete/);
    expect(report).toMatch(/porch next/);
  });
});

// ---------------------------------------------------------------------------
// Path construction
// ---------------------------------------------------------------------------

describe('paths', () => {
  it('joins rather than concatenating, so a trailing slash is harmless', () => {
    expect(challengeFilePath('/a/b/')).toBe(challengeFilePath('/a/b'));
    expect(reorientFilePath('/a/b/')).toBe(reorientFilePath('/a/b'));
  });
});

// ---------------------------------------------------------------------------
// Stability window
// ---------------------------------------------------------------------------

describe('two-observation verification', () => {
  it('sleeps the stability window between observations', async () => {
    seedHappyPath();
    const before = clock.now();

    await run();

    // verifyReceipt can never return `accepted` on a first observation, so a
    // single read would abort every run. The sleep is load-bearing.
    expect(clock.now() - before).toBeGreaterThanOrEqual(DEFAULT_STABILITY_WINDOW_MS);
  });
});
