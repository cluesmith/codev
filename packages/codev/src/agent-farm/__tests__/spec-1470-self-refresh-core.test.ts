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
  AUTOMATIC_REENTRY_MARKER,
  beginSelfRefresh,
  didClearConfirmed,
  parseChallenge,
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
  MAX_NONCE_HEX_CHARS,
  MIN_ALLOWED_MIN_BYTES,
  MIN_ALLOWED_REENTRY_DELAY_SECONDS,
  MIN_ALLOWED_STABILITY_WINDOW_MS,
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
  const names = result.steps.map(s => s.name);
  // BOTH names. `clear-attempted` without `clear` means the send threw and the
  // clear may still have landed — checking only the confirmed step would let a
  // "no clear happened" assertion pass over an ambiguous, possibly-cleared
  // builder.
  expect(names).not.toContain('clear');
  expect(names).not.toContain('clear-attempted');
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
      'challenge-marked',
      'clear-attempted',
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

  it('schedules the frame that IDENTIFIES ITSELF as an automatic refresh', async () => {
    // Asserts the WIRING, not the builder function. Testing
    // buildAutomaticReentryFrame() in isolation passes even when
    // runSelfRefresh schedules the bare inline frame instead — verified by
    // mutation: removing the wrapper left 103 tests green until this existed.
    //
    // The stake: a builder cannot tell its own scheduled message from an
    // architect's, because the harness renders self-sends as
    // [ARCHITECT INSTRUCTION]. Without the marker a refreshed builder may read
    // its own re-orientation as a new order.
    seedHappyPath();
    await run();

    expect(terminal.scheduled).toHaveLength(1);
    expect(terminal.scheduled[0].message).toContain(AUTOMATIC_REENTRY_MARKER);
    expect(terminal.scheduled[0].message).toMatch(/not an architect instruction/i);
    // And it still carries the re-orientation itself.
    expect(terminal.scheduled[0].message).toMatch(/porch next/);
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
    // Both are well-formed 12-char hex — the rejection must come from the
    // MISMATCH, not from the format guard, or this test stops testing replay.
    fs.write(challengePath, JSON.stringify({ nonce: 'aaaa1111bbbb', issuedAt: 2 }));
    fs.write(statePath, goodSave('cccc2222dddd'));
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

    // Distinct from assembly-failed: the frame built fine, the disk refused it.
    expect(result.failure).toBe('reorient-write-failed');
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
  it('records the ATTEMPT even though the send threw, and does not claim safety', async () => {
    // The failure this models: sendRaw can succeed on the wire and still throw.
    // A log written only on success would claim no clear happened about a
    // context that may no longer exist.
    seedHappyPath();
    terminal.failRaw = true;

    const result = await run();

    expect(result.failure).toBe('clear-failed');
    const names = result.steps.map(s => s.name);
    expect(names).toContain('clear-attempted');
    expect(names).not.toContain('clear');
    // didClear() reads the ambiguous case as UNSAFE.
    expect(didClear(result)).toBe(true);
    expect(didClearConfirmed(result)).toBe(false);
    // The re-entry is queued either way, so both outcomes recover.
    expect(terminal.scheduled).toHaveLength(1);
    // Must NOT assert the context survived — we cannot know.
    expect(result.reason).toMatch(/MAY still have landed/i);
    expect(result.reason).not.toMatch(/context is intact/i);
  });

  it('the report warns rather than reassuring after an attempt', async () => {
    seedHappyPath();
    terminal.failRaw = true;
    const report = formatSelfRefreshReport(await run());
    expect(report).toMatch(/may have landed/i);
    expect(report).not.toMatch(/Your context is intact/);
  });
});

// ---------------------------------------------------------------------------
// Malformed challenge data must not bypass the freshness gate
// ---------------------------------------------------------------------------

describe('challenge shape validation', () => {
  /**
   * The bypass this closes, spelled out because it is not obvious:
   *
   *   `{"nonce": []}` survives a truthiness check — `![]` is `false` — and is
   *   then handed to `verifyReceipt`, whose `content.includes(nonce)` coerces
   *   the array to `''`. `String.includes('')` is TRUE for every string, so the
   *   freshness gate does not weaken, it inverts: any file over the size floor
   *   passes as a fresh save, and the builder clears on arbitrary content.
   */
  it('refuses an array nonce, which would otherwise match every file', async () => {
    // Prove the coercion is real before asserting we defend against it.
    expect(![]).toBe(false);
    expect('any file contents'.includes([] as unknown as string)).toBe(true);

    fs.write(challengePath, JSON.stringify({ nonce: [], issuedAt: 1 }));
    fs.write(statePath, `no nonce anywhere\n${'x'.repeat(DEFAULT_MIN_BYTES + 50)}`);

    const result = await run();

    expect(result.failure).toBe('no-challenge');
    expect(result.reason).toMatch(/lowercase hex/i);
    expectNoClear(result);
  });

  it.each([
    ['numeric nonce', { nonce: 12345, issuedAt: 1 }],
    ['object nonce', { nonce: {}, issuedAt: 1 }],
    ['null nonce', { nonce: null, issuedAt: 1 }],
    ['empty-string nonce', { nonce: '', issuedAt: 1 }],
  ])('refuses a %s', async (_label, challenge) => {
    fs.write(challengePath, JSON.stringify(challenge));
    fs.write(statePath, goodSave());

    const result = await run();

    expect(result.failure).toBe('no-challenge');
    expectNoClear(result);
  });

  it('refuses a non-finite issuedAt, which no age bound can reject', async () => {
    // Every comparison with NaN is false, so `age > max` never fires.
    expect(NaN > 1000).toBe(false);

    fs.write(challengePath, '{"nonce":"abc123def456","issuedAt":"yesterday"}');
    fs.write(statePath, goodSave());

    const result = await run();

    expect(result.failure).toBe('no-challenge');
    expect(result.reason).toMatch(/non-finite issuedAt/i);
    expectNoClear(result);
  });

  it('refuses a challenge issued in the future, whose age is negative', async () => {
    fs.write(
      challengePath,
      JSON.stringify({ nonce: NONCE, issuedAt: clock.now() + 10 * 60 * 60 * 1000 }),
    );
    fs.write(statePath, goodSave());

    const result = await run();

    expect(result.failure).toBe('no-challenge');
    expect(result.reason).toMatch(/issued in the future/i);
    expectNoClear(result);
  });

  it('refuses a bare JSON null without throwing', async () => {
    // `JSON.parse('null')` succeeds and returns null; reading `.nonce` off it
    // would be an uncaught TypeError rather than a named abort.
    fs.write(challengePath, 'null');
    fs.write(statePath, goodSave());

    const result = await run();

    expect(result.failure).toBe('no-challenge');
    expectNoClear(result);
  });

  it('refuses a JSON array', async () => {
    fs.write(challengePath, '[]');
    fs.write(statePath, goodSave());
    const result = await run();
    expect(result.failure).toBe('no-challenge');
    expectNoClear(result);
  });

  it('refuses a SHORT nonce, which would match almost any file', async () => {
    // "a" is non-empty, so length alone is not the guard — `content.includes("a")`
    // is true for nearly every state file ever written. A nonce short enough to
    // collide proves nothing about freshness.
    expect('any ordinary save file'.includes('a')).toBe(true);

    fs.write(challengePath, JSON.stringify({ nonce: 'a', issuedAt: 1 }));
    fs.write(statePath, `a stale save with no marker\n${'x'.repeat(DEFAULT_MIN_BYTES + 50)}`);

    const result = await run();

    expect(result.failure).toBe('no-challenge');
    expect(result.reason).toMatch(/lowercase hex/i);
    expectNoClear(result);
  });

  it.each([
    ['non-hex characters', 'zzzzzzzzzzzz'],
    ['uppercase hex', 'ABC123DEF456'],
    ['too short by one', 'abc123def45'],
    // Anchor cases: without ^...$ these all contain a valid 12-hex run, so they
    // pin the anchors rather than the character class.
    ['a trailing newline', 'abc123def456\n'],
    ['a leading space', ' abc123def456'],
    ['trailing text', 'abc123def456 OR ANYTHING'],
    ['a leading prefix', 'x abc123def456'],
  ])('refuses a nonce with %s', async (_label, nonce) => {
    fs.write(challengePath, JSON.stringify({ nonce, issuedAt: 1 }));
    fs.write(statePath, `${nonceMarker(nonce)}\n${'x'.repeat(DEFAULT_MIN_BYTES + 50)}`);

    const result = await run();

    expect(result.failure).toBe('no-challenge');
    expectNoClear(result);
  });

  it('accepts a LONGER nonce, so the format can grow', () => {
    // A floor, not an exact length: a future generateNonce with more entropy
    // must not be rejected by a validator pinned to today's width.
    const parsed = parseChallenge(
      JSON.stringify({ nonce: 'abcdef0123456789abcdef', issuedAt: 500 }),
      1000,
    );
    expect(parsed.ok).toBe(true);
  });

  it('accepts a well-formed challenge', () => {
    const parsed = parseChallenge(
      JSON.stringify({ nonce: NONCE, issuedAt: 500, boundary: 'enter:review' }),
      1000,
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.challenge.nonce).toBe(NONCE);
      expect(parsed.challenge.boundary).toBe('enter:review');
    }
  });

  it('tolerates clock skew rather than failing on it', () => {
    // A timestamp a few seconds ahead is an ordinary clock adjustment, not an
    // attack; failing there would make the gate flaky for no safety gain.
    const parsed = parseChallenge(JSON.stringify({ nonce: NONCE, issuedAt: 1_030 }), 1_000);
    expect(parsed.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The stability gate cannot be disabled
// ---------------------------------------------------------------------------

describe('safety parameters', () => {
  /**
   * Every parameter here TUNES A GATE, so an invalid value does not degrade the
   * run — it disables a protection while everything still reports success.
   * `minBytes: 0` accepts an empty save; `challengeMaxAgeMs: NaN` makes every
   * expiry comparison false; a non-positive window collapses the two-observation
   * stability check into one read.
   */
  const params = [
    'minBytes',
    'stabilityWindowMs',
    'reentryDelaySeconds',
    'challengeMaxAgeMs',
  ] as const;
  const badValues = [0, -1, NaN, Infinity];

  for (const param of params) {
    for (const value of badValues) {
      it(`refuses ${param} = ${value}`, async () => {
        seedHappyPath();
        const result = await run({ [param]: value });

        expect(result.failure, `${param}=${value} must be refused`).toBe('invalid-parameters');
        expectNoClear(result);
      });
    }
  }

  // Positive but INSANE: validity is not sanity, and each of these neuters the
  // gate it configures while still reporting success.
  it.each([
    ['minBytes', 1, MIN_ALLOWED_MIN_BYTES],
    ['stabilityWindowMs', 1, MIN_ALLOWED_STABILITY_WINDOW_MS],
    ['reentryDelaySeconds', 0.001, MIN_ALLOWED_REENTRY_DELAY_SECONDS],
  ])('refuses a positive-but-too-small %s (%s)', async (param, value) => {
    seedHappyPath();
    const result = await run({ [param]: value });

    expect(result.failure).toBe('invalid-parameters');
    expectNoClear(result);
  });

  it('validates parameters BEFORE reading any state', async () => {
    // Without this, Gate 0 could drift below the challenge read and every other
    // parameter test would still pass — they all seed a valid challenge first.
    // With no challenge on disk, a parameter error must still win.
    const result = await run({ minBytes: 0 });

    expect(result.failure).toBe('invalid-parameters');
    expect(result.steps).toHaveLength(0);
    expectNoClear(result);
  });

  it('a parameter error touches nothing at all', async () => {
    seedHappyPath();
    const result = await run({ minBytes: 0 });

    expect(result.steps).toHaveLength(0);
    expect(fs.exists(reorientPath)).toBe(false);
    expect(terminal.scheduled).toHaveLength(0);
    // The challenge is left intact for a corrected retry.
    expect(fs.read(challengePath)).toBeTruthy();
  });

  it('uses the MONOTONIC reading, so a wall-clock jump cannot spoof the gap', async () => {
    // An NTP step forward inside the window would make Date.now()'s delta
    // satisfy the check when no real time passed — spoofing the measurement
    // that replaced an asserted value.
    seedHappyPath();
    let wall = 1_000;
    const spoofing = {
      now: () => {
        wall += 10 * 60 * 1000; // every wall read jumps ten minutes forward
        return wall;
      },
      sleep: async () => {
        /* no real time passes */
      },
      monotonicNow: () => 5_000, // monotonic clock is honest: no gap
    };

    const result = await run({ clock: spoofing });

    expect(result.outcome).toBe('aborted');
    expect(result.failure).toBe('receipt-rejected');
    expectNoClear(result);
  });

  it('measures the elapsed gap rather than assuming it', async () => {
    // A clock whose sleep does not advance time must NOT yield a stable
    // verdict: the two reads would be back to back while claiming a gap.
    seedHappyPath();
    const frozen = {
      now: () => 1_000,
      sleep: async () => {
        /* deliberately advances nothing */
      },
    };

    const result = await run({ clock: frozen });

    expect(result.outcome).toBe('aborted');
    expect(result.failure).toBe('receipt-rejected');
    expectNoClear(result);
  });
});

// ---------------------------------------------------------------------------
// The save must ANSWER the request, not echo it
// ---------------------------------------------------------------------------

describe('echoed save request', () => {
  it('refuses a state file that is the save request copied back', async () => {
    // The highest-value finding of the ad-hoc review, and not an adversarial
    // case: the request text itself contains the marker and runs ~2KB, so
    // `cp <request> .builder-state.md` cleared every gate — nonce present, over
    // the size floor, stable. Agents echo their instructions routinely.
    //
    // The request already says the file "MUST begin with this exact line". This
    // asserts we enforce what we ask for.
    const begun = beginSelfRefresh({
      fs,
      clock,
      worktree: WORKTREE,
      boundary: 'enter:review',
      makeNonce: () => NONCE,
    });

    // Sanity: the request really would have passed the old gate.
    expect(begun.saveRequest).toContain(NONCE);
    expect(Buffer.byteLength(begun.saveRequest, 'utf-8')).toBeGreaterThan(DEFAULT_MIN_BYTES);

    fs.write(statePath, begun.saveRequest);

    const result = await run({ expectedBoundary: 'enter:review' });

    expect(result.failure).toBe('receipt-rejected');
    expect(result.reason).toMatch(/first line|echoed/i);
    expectNoClear(result);
  });

  it('refuses a stale save with the new nonce merely appended', async () => {
    seedHappyPath();
    fs.write(statePath, `${'old content '.repeat(200)}\n${nonceMarker(NONCE)}`);

    const result = await run({ expectedBoundary: 'enter:review' });

    expect(result.failure).toBe('receipt-rejected');
    expectNoClear(result);
  });

  it('still accepts a marker whose spacing differs, on the first line', async () => {
    // Freshness is proved by the nonce token; rejecting a real save over comment
    // spacing would discard work that cost the builder real effort.
    fs.write(challengePath, JSON.stringify({ nonce: NONCE, issuedAt: 1 }));
    fs.write(statePath, `<!--codev-reset:${NONCE}-->\n${'x'.repeat(DEFAULT_MIN_BYTES + 50)}`);

    const result = await run();

    expect(result.outcome).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// Nonce bounds
// ---------------------------------------------------------------------------

describe('nonce ceiling', () => {
  it('refuses a nonce long enough to satisfy the size floor by itself', async () => {
    // Without a ceiling, a multi-kilobyte nonce makes the SUBSTANCE gate
    // meaningless: a file containing only the marker already clears minBytes.
    const huge = 'a'.repeat(MAX_NONCE_HEX_CHARS + 1);
    fs.write(challengePath, JSON.stringify({ nonce: huge, issuedAt: 1 }));
    fs.write(statePath, `${nonceMarker(huge)}\n`);

    const result = await run();

    expect(result.failure).toBe('no-challenge');
    expectNoClear(result);
  });

  it('accepts a nonce at the ceiling', () => {
    const parsed = parseChallenge(
      JSON.stringify({ nonce: 'a'.repeat(MAX_NONCE_HEX_CHARS), issuedAt: 500 }),
      1000,
    );
    expect(parsed.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The challenge is single-use even when tidying fails
// ---------------------------------------------------------------------------

describe('challenge burn', () => {
  it('marks the challenge consumed BEFORE clearing', async () => {
    seedHappyPath();
    const result = await run();
    const names = result.steps.map(s => s.name);
    expect(names.indexOf('challenge-marked')).toBeLessThan(names.indexOf('clear-attempted'));
  });

  it('refuses to clear when the challenge cannot be marked', async () => {
    // Marking is a write, and it happens while aborting is still free. An
    // unburnable challenge could be replayed into a SECOND clear.
    seedHappyPath();
    fs.failWrites.add(challengePath);

    const result = await run();

    expect(result.failure).toBe('challenge-burn-failed');
    expect(result.reason).toMatch(/could not mark the refresh challenge/i);
    // Must disclose the already-queued re-entry: a retry would queue a second.
    expect(result.reason).toMatch(/ALREADY QUEUED/);
    expectNoClear(result);
  });

  it('a challenge left on disk by a failed delete cannot be replayed', async () => {
    // The precise hole: delete fails after a successful clear, so the file and
    // the verified save both survive. Without the pre-clear mark, a second
    // execute would sail through every gate and clear again.
    seedHappyPath();
    fs.failRemoves.add(challengePath);

    const first = await run();
    expect(first.outcome).toBe('completed');
    expect(fs.read(challengePath)).toBeTruthy(); // delete really did fail

    terminal.raw = [];
    const second = await run();

    expect(second.outcome).toBe('aborted');
    expect(second.failure).toBe('no-challenge');
    expect(second.reason).toMatch(/already consumed/i);
    expectNoClear(second);
  });

  it('a completed refresh is not failed by a delete that could not run', async () => {
    seedHappyPath();
    fs.failRemoves.add(challengePath);
    const result = await run();
    expect(result.outcome).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// A challenge is for ONE boundary at ONE moment
// ---------------------------------------------------------------------------

describe('challenge scope', () => {
  it('refuses a challenge issued for a different boundary', async () => {
    // An execute that aborted at boundary A leaves its challenge behind. The
    // builder commits, works on, and reaches boundary B — where the stale
    // challenge plus a stale save would otherwise pass.
    seedHappyPath(NONCE, 'enter:implement');

    const result = await run({ expectedBoundary: 'enter:review' });

    expect(result.failure).toBe('no-challenge');
    expect(result.reason).toMatch(/does not carry across boundaries/i);
    expectNoClear(result);
  });

  it('accepts a challenge whose boundary matches', async () => {
    seedHappyPath(NONCE, 'enter:review');
    const result = await run({ expectedBoundary: 'enter:review' });
    expect(result.outcome).toBe('completed');
  });

  it('refuses a challenge older than the age bound', async () => {
    fs.write(challengePath, JSON.stringify({ nonce: NONCE, issuedAt: 0 }));
    fs.write(statePath, goodSave());
    clock.t = 10 * 60 * 60 * 1000; // ten hours later

    const result = await run();

    expect(result.failure).toBe('no-challenge');
    expect(result.reason).toMatch(/old \(limit/i);
    expectNoClear(result);
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

    expect(result.outcome).toBe('dry-run');
    expect(result.failure).toBeUndefined();
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
    // The floor must be stated: a save under it loses a refresh that is never
    // retried, and the builder cannot know that from the request otherwise.
    expect(request).toContain(String(DEFAULT_MIN_BYTES));
    expect(request).toMatch(/AT MOST ONCE/);
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
    // "attempted", not "sent": the report distinguishes a clear that was never
    // tried from one whose send threw ambiguously.
    expect(report).toMatch(/No clear was attempted\. Your context is intact\./);
  });

  it('reports a dry run as a rehearsal, not an abort', async () => {
    seedHappyPath();
    const report = formatSelfRefreshReport(await run({ dryRun: true }));
    // Narrowed deliberately: a dry run stops before the reorient write, Tower
    // scheduling, the challenge rewrite, the clear and the deletion, so it
    // cannot claim the refresh "would proceed".
    expect(report).toMatch(/passed all non-mutating preflight checks/i);
    expect(report).not.toMatch(/WOULD proceed/i);
    expect(report).not.toMatch(/ABORTED/);
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
