/**
 * Reset orchestrator — invariant tests (Spec 1273, phase 6).
 *
 * The reason these tests are shaped the way they are:
 *
 * Reset's safety properties are ORDERING properties, and ordering is the one
 * thing a "does it return the right value" test cannot see. A run that clears a
 * builder BEFORE saving its state and a run that clears it after both end with
 * `outcome: 'completed'`. Only the sequence distinguishes them.
 *
 * So almost every assertion here is over the **step log**, and the important
 * ones are assertions of ABSENCE — that `clear` never appears in an aborted
 * run, that `escalate-esc` never precedes `receipt-accepted`. A test that only
 * checks the happy path would pass against an implementation that clears first
 * and asks questions later.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runReset,
  ResetPreflightError,
  formatResetReport,
  type ClockPort,
  type ResetFsPort,
  type ResetStepName,
  type TerminalPort,
} from '../commands/reset/index.js';
import type { ResolvedBuilderContext } from '../commands/reset/context.js';
import { STATE_FILE_NAME, REORIENT_FILE_NAME } from '../commands/reset/constants.js';

// ============================================================================
// Harness
// ============================================================================

const WORKTREE = '/repo/.builders/aspir-1273';
const SPAWN_PROMPT = '# Builder prompt\n\nYou are implementing the feature.';

function makeContext(overrides: Partial<ResolvedBuilderContext> = {}): ResolvedBuilderContext {
  return {
    builderId: 'aspir-1273',
    worktree: WORKTREE,
    branch: 'builder/aspir-1273',
    protocol: 'aspir',
    protocolSource: 'status.yaml',
    mode: 'strict',
    modeSource: 'builder-prompt',
    harnessName: 'claude',
    harness: { supportsContextReset: true } as ResolvedBuilderContext['harness'],
    porch: {
      projectId: '1273',
      projectName: '1273-builder-context-reset-should-b',
      protocol: 'aspir',
      phase: 'implement',
      currentPlanPhase: 'phase_6',
      statusPath: `${WORKTREE}/codev/projects/1273-builder-context-reset-should-b/status.yaml`,
    },
    specName: '1273-builder-context-reset-should-b',
    specPath: 'codev/specs/1273-builder-context-reset-should-b.md',
    planPath: 'codev/plans/1273-builder-context-reset-should-b.md',
    issueNumber: '1273',
    ...overrides,
  };
}

/**
 * A clock that advances only when someone sleeps.
 *
 * Deterministic and instant: a 5-minute receipt timeout costs no wall-clock, so
 * the timeout paths are cheap enough to test exhaustively — which matters,
 * because the timeout paths are the ones that must NOT clear.
 */
function makeClock(): ClockPort & { advance(ms: number): void } {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/**
 * A state file that appears after N polls, mimicking a builder that takes a
 * while to reach the request and then writes.
 */
function makeFs(script: {
  appearsAfterReads?: number;
  content?: (nonce: string) => string;
  bytes?: number;
  keepGrowing?: boolean;
}): ResetFsPort & { writes: Array<{ path: string; content: string }> } {
  const writes: Array<{ path: string; content: string }> = [];
  let reads = 0;
  const appearsAfter = script.appearsAfterReads ?? 0;
  let size = script.bytes ?? 5000;

  return {
    writes,
    read(path: string) {
      if (path.endsWith('.builder-state.md')) {
        reads++;
        if (reads <= appearsAfter) return null;
        return script.content ? script.content(CURRENT_NONCE.value) : `nonce ${CURRENT_NONCE.value}\nstate`;
      }
      return null;
    },
    sizeOf(path: string) {
      if (path.endsWith('.builder-state.md')) {
        if (reads < appearsAfter) return null;
        if (script.keepGrowing) size += 100;
        return size;
      }
      return null;
    },
    write(path: string, content: string) {
      writes.push({ path, content });
    },
  };
}

/**
 * The nonce is generated inside `runReset`, so a scripted state file cannot know
 * it up front. The orchestrator hands it to the builder via the save request;
 * this captures it from the message the terminal port receives, which is exactly
 * the channel a real builder would learn it through.
 */
const CURRENT_NONCE = { value: '' };

/**
 * What the terminal already contains before the clear: reset's own messages.
 *
 * Deliberately includes the save request's "CONTEXT RESET INCOMING" header,
 * because that string matches the confirmation pattern. If the window logic
 * regresses, these lines leak into the check and confirmation goes true for the
 * wrong reason — which is exactly the bug this models.
 */
const PRE_CLEAR_BUFFER = [
  'CONTEXT RESET INCOMING — save your working state now.',
  'Write your complete working state to .builder-state.md',
];

function makeTerminal(script: {
  exists?: boolean;
  /** Sequence of lastDataAt offsets relative to now; `undefined` = unobservable. */
  quietness?: Array<number | undefined>;
  recentOutput?: string;
} = {}): TerminalPort & {
  messages: string[];
  raw: string[];
  escapes: number;
} {
  const messages: string[] = [];
  const raw: string[] = [];
  let escapes = 0;
  const quietness = script.quietness ?? [];
  let observeCount = 0;

  const port = {
    messages,
    raw,
    get escapes() {
      return escapes;
    },
    async observe() {
      const idx = Math.min(observeCount, quietness.length - 1);
      observeCount++;
      if (script.exists === false) return { exists: false };
      if (quietness.length === 0) return { exists: true, lastDataAt: 0 };
      const entry = quietness[idx];
      return { exists: true, lastDataAt: entry };
    },
    async sendMessage(message: string) {
      messages.push(message);
      const match = message.match(/([0-9a-f]{12})/);
      if (match) CURRENT_NONCE.value = match[1];
    },
    async sendRaw(text: string) {
      raw.push(text);
    },
    async sendEscape() {
      escapes++;
    },
    readOutput: script.recentOutput !== undefined
      ? async () => {
          // `total` grows once the clear is sent, so the fresh-window slice is
          // exactly the scripted post-clear output. Before the clear it reports
          // the pre-existing buffer only.
          const post = script.recentOutput!.split('\n');
          return raw.includes('/clear')
            ? { lines: [...PRE_CLEAR_BUFFER, ...post], total: PRE_CLEAR_BUFFER.length + post.length }
            : { lines: [...PRE_CLEAR_BUFFER], total: PRE_CLEAR_BUFFER.length };
        }
      : undefined,
  };
  return port;
}

const spawnPort = () => SPAWN_PROMPT;
const resumePort = (id: string) => `## RESUME SESSION\n\nRun porch next for ${id}.\nIf porch reports "not found", run porch init.`;

/**
 * Quiescence observations old enough to count as quiet.
 *
 * The clock starts at 1_000_000 and `quietWindowMs` defaults to 1500, so a
 * `lastDataAt` of 0 is "silent since the epoch" — comfortably quiet.
 */
const QUIET: Array<number | undefined> = [0];

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    context: makeContext(),
    fs: makeFs({}),
    clock: makeClock(),
    terminal: makeTerminal({ quietness: QUIET }),
    buildSpawnPrompt: spawnPort,
    buildResumeNotice: resumePort,
    ...overrides,
  };
}

const names = (steps: Array<{ name: ResetStepName }>) => steps.map(s => s.name);

// ============================================================================
// Happy path
// ============================================================================

describe('Spec 1273 — reset orchestrator: happy path', () => {
  it('runs request → receipt → quiescence → clear → re-orientation, in that order', async () => {
    const result = await runReset(baseOptions() as never);

    expect(result.outcome).toBe('completed');
    expect(names(result.steps)).toEqual([
      'resolve',
      'assemble',
      'write-reorient-file',
      'send-save-request',
      'receipt-accepted',
      'quiescent',
      'clear',
      'clear-unconfirmed',
      'send-reorientation',
    ]);
  });

  it('writes the long form to the worktree before anything is sent to the builder', async () => {
    const fs = makeFs({});
    const terminal = makeTerminal({ quietness: QUIET });
    const result = await runReset(baseOptions({ fs, terminal }) as never);

    expect(fs.writes).toHaveLength(1);
    expect(fs.writes[0].path).toBe(`${WORKTREE}/.builder-reorient.md`);
    expect(fs.writes[0].content).toContain(SPAWN_PROMPT);
    expect(result.outcome).toBe('completed');
  });

  it('delivers the inline frame as the final action', async () => {
    const terminal = makeTerminal({ quietness: QUIET });
    await runReset(baseOptions({ terminal }) as never);

    // Two messages: the save request, then the re-orientation.
    expect(terminal.messages).toHaveLength(2);
    expect(terminal.messages[0]).toContain('.builder-state.md');
    expect(terminal.messages[1]).toContain('CONTEXT RESET');
  });

  it('delivers /clear down the RAW channel, never the escape channel', async () => {
    // This is a regression test for a bug caught in review rather than in
    // production. Tower's escape route (`writeEscapeToSession`) writes a
    // hardcoded ESC and DISCARDS the message body, so wiring the clear to the
    // escape channel sends an interrupt instead of typing `/clear`. Every
    // observable signal would still look like success: the send returns ok, the
    // terminal goes quiet (an ESC ends the turn), the re-orientation arrives.
    // The only thing that would not happen is the reset.
    const terminal = makeTerminal({ quietness: QUIET });
    const result = await runReset(baseOptions({ terminal }) as never);

    expect(result.outcome).toBe('completed');
    expect(terminal.raw).toContain('/clear');
    expect(terminal.escapes).toBe(0);
  });

  it('does NOT count the echo of the typed /clear as confirmation', async () => {
    // The PTY echoes input, so `/clear` is guaranteed to appear in recent
    // output on every single run. Treating that as confirmation made the check
    // self-fulfilling — it reported "clear-confirmed" whether or not anything
    // was cleared. A false "confirmed" is worse than the earlier always-
    // unconfirmed bug, because the architect trusts it.
    const terminal = makeTerminal({ quietness: QUIET, recentOutput: '> /clear\n> ' });
    const result = await runReset(baseOptions({ terminal }) as never);

    expect(names(result.steps)).toContain('clear-unconfirmed');
    expect(names(result.steps)).not.toContain('clear-confirmed');
  });

  it('does NOT match reset\'s own save-request text still sitting in the buffer', async () => {
    // The save request opens with "CONTEXT RESET INCOMING", which matches the
    // confirmation pattern. It is in the buffer on every run because reset put
    // it there moments earlier. Scanning the whole buffer therefore confirmed
    // the clear using reset's own words — the second false-positive in this
    // check, after the echoed `/clear`.
    //
    // The fix is structural rather than a better regex: only output produced
    // AFTER the clear is considered, so anything reset wrote is excluded by
    // construction. PRE_CLEAR_BUFFER carries that exact header.
    const terminal = makeTerminal({ quietness: QUIET, recentOutput: '> ' });
    const result = await runReset(baseOptions({ terminal }) as never);

    expect(names(result.steps)).toContain('clear-unconfirmed');
    expect(names(result.steps)).not.toContain('clear-confirmed');
  });

  it('reports the clear as confirmed when the terminal echoes it', async () => {
    const terminal = makeTerminal({ quietness: QUIET, recentOutput: 'context cleared' });
    const result = await runReset(baseOptions({ terminal }) as never);

    expect(names(result.steps)).toContain('clear-confirmed');
    expect(names(result.steps)).not.toContain('clear-unconfirmed');
  });
});

// ============================================================================
// R1 — never clear without a saved re-orientation
// ============================================================================

describe('Spec 1273 — R1: no clear without a persisted re-orientation', () => {
  it('aborts before touching the builder when assembly fails', async () => {
    const terminal = makeTerminal({ quietness: QUIET });
    const fs = makeFs({});

    // A context with no branch cannot produce a complete frame (R3).
    await expect(
      runReset(baseOptions({
        context: makeContext({ branch: '' }),
        terminal,
        fs,
      }) as never),
    ).rejects.toThrow(ResetPreflightError);

    // The decisive assertions: nothing reached the builder, and nothing was
    // written. An assembly failure must leave the builder exactly as it was.
    expect(terminal.messages).toHaveLength(0);
    expect(terminal.raw).toHaveLength(0);
    expect(fs.writes).toHaveLength(0);
  });

  it('always orders assemble and write-reorient-file before clear', async () => {
    const result = await runReset(baseOptions() as never);
    const order = names(result.steps);

    expect(order.indexOf('assemble')).toBeLessThan(order.indexOf('clear'));
    expect(order.indexOf('write-reorient-file')).toBeLessThan(order.indexOf('clear'));
  });
});

// ============================================================================
// R2 — never clear without a verified receipt
// ============================================================================

describe('Spec 1273 — R2: no clear without a verified save-state receipt', () => {
  const failureCases: Array<{ label: string; fs: () => ResetFsPort }> = [
    {
      label: 'the file never appears',
      fs: () => makeFs({ appearsAfterReads: 10_000 }),
    },
    {
      label: 'the file carries a stale nonce',
      fs: () => makeFs({ content: () => 'nonce deadbeefcafe\nstale state from a previous reset' }),
    },
    {
      label: 'the file is a stub below the size floor',
      fs: () => makeFs({ bytes: 120 }),
    },
    {
      label: 'the file is still being written',
      fs: () => makeFs({ keepGrowing: true }),
    },
  ];

  for (const { label, fs } of failureCases) {
    it(`aborts with NO clear when ${label}`, async () => {
      const terminal = makeTerminal({ quietness: QUIET });
      const result = await runReset(
        baseOptions({ fs: fs(), terminal, receiptTimeoutMs: 10_000 }) as never,
      );

      expect(result.outcome).toBe('aborted');
      expect(names(result.steps)).not.toContain('clear');
      expect(names(result.steps)).not.toContain('send-reorientation');
      expect(terminal.raw).not.toContain('/clear');
      // The abort must name the gate, not just say "failed".
      expect(result.abortReason).toMatch(/receipt not verified/i);
    });
  }

  it('names the specific gate so the architect can tell a stub from silence', async () => {
    const stub = await runReset(
      baseOptions({ fs: makeFs({ bytes: 120 }), receiptTimeoutMs: 10_000 }) as never,
    );
    const silent = await runReset(
      baseOptions({ fs: makeFs({ appearsAfterReads: 10_000 }), receiptTimeoutMs: 10_000 }) as never,
    );

    expect(stub.abortReason).toMatch(/stub, not a working-state save/);
    expect(silent.abortReason).toMatch(/never written/);
    expect(stub.abortReason).not.toEqual(silent.abortReason);
  });
});

// ============================================================================
// R4 — never clear a builder mid-turn
// ============================================================================

describe('Spec 1273 — R4: no clear while the builder is mid-turn', () => {
  it('escalates exactly once, then aborts without clearing if still busy', async () => {
    const clock = makeClock();
    // Always "just emitted output" — never quiet, however long we wait.
    const terminal = makeTerminal({ quietness: [clock.now()] });
    vi.spyOn(terminal, 'observe').mockImplementation(async () => ({
      exists: true,
      lastDataAt: clock.now(),
    }));

    const result = await runReset(
      baseOptions({
        clock,
        terminal,
        quiesceTimeoutMs: 5_000,
        quiescePostEscalationTimeoutMs: 3_000,
      }) as never,
    );

    expect(result.outcome).toBe('aborted');
    expect(names(result.steps)).not.toContain('clear');
    // EXACTLY one ESC. A second escalation would be an unbounded retry against
    // a builder that has already ignored one.
    expect(terminal.escapes).toBe(1);
    // And the ESC went down the ESCAPE channel, never the raw one.
    expect(terminal.raw).not.toContain('\x1b');
    expect(result.abortReason).toMatch(/still mid-turn/i);
  });

  it('never escalates before the receipt is accepted', async () => {
    const clock = makeClock();
    const terminal = makeTerminal({});
    vi.spyOn(terminal, 'observe').mockImplementation(async () => ({
      exists: true,
      lastDataAt: clock.now(),
    }));

    const result = await runReset(
      baseOptions({ clock, terminal, quiesceTimeoutMs: 5_000, quiescePostEscalationTimeoutMs: 3_000 }) as never,
    );

    const order = names(result.steps);
    // The ordering that matters: an ESC before the receipt could interrupt the
    // very save being requested, destroying the thing reset exists to preserve.
    expect(order.indexOf('receipt-accepted')).toBeGreaterThan(-1);
    expect(order.indexOf('escalate-esc')).toBeGreaterThan(order.indexOf('receipt-accepted'));
  });

  it('refuses to clear when the Tower cannot report lastDataAt', async () => {
    // An older Tower omits the field. Treating undefined as 0 would compute an
    // age of decades and clear a busy builder instantly — the exact R4 breach
    // phase 2 exists to prevent.
    const terminal = makeTerminal({ quietness: [undefined] });
    const result = await runReset(baseOptions({ terminal }) as never);

    expect(result.outcome).toBe('aborted');
    expect(names(result.steps)).not.toContain('clear');
    expect(result.abortReason).toMatch(/lastDataAt/);
  });

  it('distinguishes a vanished terminal from an old Tower that omits lastDataAt', async () => {
    // Both surface as "no lastDataAt", but they need opposite responses: one is
    // "upgrade Tower", the other is "your builder's terminal died, here is where
    // its saved state lives". Conflating them sends the architect to check a
    // version number while the builder is gone.
    let alive = true;
    const terminal = makeTerminal({});
    vi.spyOn(terminal, 'observe').mockImplementation(async () => {
      if (!alive) return { exists: false };
      alive = false; // dies right after the receipt is accepted
      return { exists: true, lastDataAt: 0 };
    });

    const result = await runReset(baseOptions({ terminal }) as never);

    expect(result.outcome).toBe('aborted');
    expect(names(result.steps)).not.toContain('clear');
    expect(result.abortReason).toMatch(/lost its terminal/);
    // Explicitly NOT the old-Tower diagnosis.
    expect(result.abortReason).not.toMatch(/lastDataAt/);
    // And it points at the state file, which outlives the terminal.
    expect(result.abortReason).toMatch(/\.builder-state\.md/);
  });

  it('clears once the terminal goes quiet after being busy', async () => {
    const clock = makeClock();
    let busy = true;
    const terminal = makeTerminal({});
    vi.spyOn(terminal, 'observe').mockImplementation(async () => {
      const observation = { exists: true, lastDataAt: busy ? clock.now() : 0 };
      busy = false; // quiet from the second observation onward
      return observation;
    });

    const result = await runReset(baseOptions({ clock, terminal }) as never);

    expect(result.outcome).toBe('completed');
    expect(names(result.steps)).toContain('clear');
    expect(terminal.escapes).toBe(0);
  });
});

// ============================================================================
// Preflight refusals
// ============================================================================

describe('Spec 1273 — preflight refusals happen before any write', () => {
  it('aborts loudly on a harness with no in-session reset, naming the harness', async () => {
    const terminal = makeTerminal({ quietness: QUIET });
    const fs = makeFs({});

    await expect(
      runReset(baseOptions({
        context: makeContext({
          harnessName: 'codex',
          harness: { supportsContextReset: false } as ResolvedBuilderContext['harness'],
        }),
        terminal,
        fs,
      }) as never),
    ).rejects.toThrow(/codex/);

    expect(terminal.messages).toHaveLength(0);
    expect(terminal.raw).toHaveLength(0);
    expect(fs.writes).toHaveLength(0);
  });

  it('aborts on a non-writable terminal BEFORE writing the re-orientation file', async () => {
    // #1198: a session whose shellper connection died reports status 'running'
    // while dropping every write. Without this check the command writes
    // .builder-reorient.md into the worktree, sends a save request into a void,
    // and then fails — having already touched the builder for a reset that
    // could never proceed. The plan's contract is validate-before-touch.
    const fs = makeFs({});
    const terminal = makeTerminal({ quietness: QUIET });
    vi.spyOn(terminal, 'observe').mockResolvedValue({
      exists: true,
      lastDataAt: 0,
      writable: false,
    });

    await expect(runReset(baseOptions({ terminal, fs }) as never)).rejects.toThrow(
      /not accepting input/,
    );

    expect(fs.writes).toHaveLength(0);
    expect(terminal.messages).toHaveLength(0);
    expect(terminal.raw).toHaveLength(0);
  });

  it('proceeds when writability is unreported, since that failure is loud', async () => {
    // Deliberate asymmetry with lastDataAt. An unobservable TURN STATE fails
    // silently and destructively (clear a builder mid-turn), so it refuses. An
    // unobservable WRITE PATH fails loudly and harmlessly (the send throws), so
    // an older Tower is not blocked from resetting.
    const terminal = makeTerminal({ quietness: QUIET });
    vi.spyOn(terminal, 'observe').mockResolvedValue({ exists: true, lastDataAt: 0 });

    const result = await runReset(baseOptions({ terminal }) as never);
    expect(result.outcome).toBe('completed');
  });

  it('aborts when the builder has no live terminal', async () => {
    const fs = makeFs({});
    await expect(
      runReset(baseOptions({ terminal: makeTerminal({ exists: false }), fs }) as never),
    ).rejects.toThrow(/no live terminal/);
    expect(fs.writes).toHaveLength(0);
  });

  it('refuses a state-file override that escapes the worktree', async () => {
    const terminal = makeTerminal({ quietness: QUIET });
    await expect(
      runReset(baseOptions({ terminal, stateFileName: '../../../etc/evil.md' }) as never),
    ).rejects.toThrow(/outside the builder's worktree/);
    expect(terminal.messages).toHaveLength(0);
  });
});

// ============================================================================
// --dry-run, --note / --file, --interrupt-first
// ============================================================================

describe('Spec 1273 — CLI-facing behaviour', () => {
  it('--dry-run exposes the save request so the command can print it', async () => {
    // The command surface prints `result.saveRequest`. When the orchestrator
    // kept the request internal, `--dry-run` printed an empty line under a
    // "save request" header — the contract said "print the save request and
    // both payload parts" and one of the three was silently blank.
    const result = await runReset(baseOptions({ dryRun: true }) as never);

    expect(result.saveRequest).toBeTruthy();
    expect(result.saveRequest).toContain('.builder-state.md');
    // The nonce must be in the request: it is what the R2 gate later verifies,
    // so a request without it describes a save that could never be accepted.
    expect(result.saveRequest).toContain(result.nonce);
  });

  it('sends the builder exactly the save request the dry run advertised', async () => {
    // Guards the gap between "what --dry-run showed" and "what a real run
    // sends". A dry run is only useful as a preview if it previews the real
    // thing.
    const dry = await runReset(baseOptions({ dryRun: true }) as never);
    const terminal = makeTerminal({ quietness: QUIET });
    const live = await runReset(baseOptions({ terminal }) as never);

    // Nonces differ per run, so compare the request with the nonce factored out.
    const shape = (text: string, nonce: string) => text.split(nonce).join('<NONCE>');
    expect(shape(terminal.messages[0], live.nonce)).toBe(shape(dry.saveRequest, dry.nonce));
  });

  it('--dry-run performs ZERO writes to the builder', async () => {
    const fs = makeFs({});
    const terminal = makeTerminal({ quietness: QUIET });
    const result = await runReset(baseOptions({ fs, terminal, dryRun: true }) as never);

    expect(result.outcome).toBe('dry-run');
    expect(terminal.messages).toHaveLength(0);
    expect(terminal.raw).toHaveLength(0);
    // Not even the long-form file: a dry run must not alter the worktree either.
    expect(fs.writes).toHaveLength(0);
    // But it still proves assembly succeeded — that is the point of the run.
    expect(result.payload?.inline).toContain('CONTEXT RESET');
  });

  it('places the addendum in the delivered payload', async () => {
    const terminal = makeTerminal({ quietness: QUIET });
    await runReset(baseOptions({ terminal, addendum: 'Ignore the stale PR comment.' }) as never);

    expect(terminal.messages[1]).toContain('Ignore the stale PR comment.');
  });

  it('--interrupt-first sends ESC before the save request, not after', async () => {
    const terminal = makeTerminal({ quietness: QUIET });
    const result = await runReset(baseOptions({ terminal, interruptFirst: true }) as never);

    const order = names(result.steps);
    expect(order.indexOf('interrupt-first')).toBeLessThan(order.indexOf('send-save-request'));
    expect(terminal.escapes).toBe(1);
  });

  it('sends no pre-emptive ESC by default', async () => {
    const terminal = makeTerminal({ quietness: QUIET });
    const result = await runReset(baseOptions({ terminal }) as never);

    expect(names(result.steps)).not.toContain('interrupt-first');
    // The only raw write on the happy path is the clear itself, and no ESC.
    expect(terminal.raw).toEqual(['/clear']);
    expect(terminal.escapes).toBe(0);
  });
});

// ============================================================================
// Scenario 14a — the wedged builder (the incident this feature came from)
// ============================================================================

describe('Spec 1273 scenario 14a — a wedged builder recovers via --interrupt-first', () => {
  /**
   * Simulates the failure this whole feature exists for.
   *
   * A builder chains foreground waits inside one turn. Every `afx send` —
   * including the save request — queues UNREAD until the turn ends, so the
   * state file never appears and the terminal never goes quiet. ESC ends the
   * turn; the queued messages then process. Verified in production (shannon,
   * 2026-07-27): a builder wedged 45+ minutes resumed within two minutes of
   * receiving ESC.
   *
   * The wedge is modelled at the only place it is observable to reset: the
   * builder does not act on messages, and its terminal keeps emitting. The ESC
   * is what flips both.
   */
  function makeWedgedBuilder(clock: ReturnType<typeof makeClock>) {
    let awake = false;
    let nonce = '';
    const raw: string[] = [];
    const messages: string[] = [];
    let escapes = 0;

    const terminal: TerminalPort & { raw: string[]; messages: string[]; escapes: number } = {
      raw,
      messages,
      get escapes() {
        return escapes;
      },
      async observe() {
        // Mid-turn the PTY emits continuously; once the turn ends it falls silent.
        return { exists: true, lastDataAt: awake ? 0 : clock.now() };
      },
      async sendMessage(message: string) {
        messages.push(message);
        // A wedged builder RECEIVES the message but never reads it — the whole
        // point of the wedge. The nonce is only learned once awake.
        if (awake) {
          const match = message.match(/([0-9a-f]{12})/);
          if (match) nonce = match[1];
        }
      },
      async sendRaw(text: string) {
        raw.push(text);
      },
      async sendEscape() {
        escapes++;
        awake = true;
        // The queued save request now processes: re-read what was already sent.
        for (const m of messages) {
          const match = m.match(/([0-9a-f]{12})/);
          if (match) nonce = match[1];
        }
      },
    };

    const fs: ResetFsPort & { writes: Array<{ path: string; content: string }> } = {
      writes: [],
      read(path: string) {
        if (!path.endsWith('.builder-state.md')) return null;
        return nonce ? `nonce ${nonce}\nworking state, written for a cold reader` : null;
      },
      sizeOf(path: string) {
        if (!path.endsWith('.builder-state.md')) return null;
        return nonce ? 5000 : null;
      },
      write(path: string, content: string) {
        this.writes.push({ path, content });
      },
    };

    return { terminal, fs };
  }

  it('completes the full flow when --interrupt-first breaks the turn', async () => {
    const clock = makeClock();
    const { terminal, fs } = makeWedgedBuilder(clock);

    const result = await runReset(
      baseOptions({
        clock,
        terminal,
        fs,
        interruptFirst: true,
        receiptTimeoutMs: 60_000,
        quiesceTimeoutMs: 20_000,
      }) as never,
    );

    expect(result.outcome).toBe('completed');
    const order = names(result.steps);
    // The ESC precedes the save request — that ordering is what makes the
    // request readable at all.
    expect(order.indexOf('interrupt-first')).toBeLessThan(order.indexOf('send-save-request'));
    expect(order).toContain('receipt-accepted');
    expect(order).toContain('clear');
    expect(terminal.raw).toContain('/clear');
  });

  it('aborts without clearing when the same builder is reset WITHOUT the flag', async () => {
    // The control case, and the more important half: it proves the flag is what
    // made the difference rather than the harness being permissive. Same wedged
    // builder, no --interrupt-first — the request is never read, the receipt
    // never verifies, and nothing is cleared.
    const clock = makeClock();
    const { terminal, fs } = makeWedgedBuilder(clock);

    const result = await runReset(
      baseOptions({ clock, terminal, fs, receiptTimeoutMs: 20_000 }) as never,
    );

    expect(result.outcome).toBe('aborted');
    expect(names(result.steps)).not.toContain('clear');
    expect(terminal.raw).not.toContain('/clear');
    expect(terminal.escapes).toBe(0);
    // And the abort message points at the recovery, so an architect hitting
    // this learns the flag exists at the moment they need it.
    expect(result.abortReason).toMatch(/--interrupt-first/);
  });
});

// ============================================================================
// Timing parameters cannot be used to switch a gate off
// ============================================================================

describe('Spec 1273 — a bad timing parameter aborts, it does not weaken a gate', () => {
  // Each of these does not merely misconfigure the run — it disables a specific
  // invariant while the run still reports success. That is the failure mode the
  // whole step-log design exists to make impossible, so it must not be
  // reachable through a number.
  const cases: Array<{ label: string; option: string; value: number; gate: string }> = [
    { label: 'a negative quiet window', option: 'quietWindowMs', value: -1, gate: 'R4' },
    { label: 'a zero quiet window', option: 'quietWindowMs', value: 0, gate: 'R4' },
    { label: 'a negative minimum size', option: 'minBytes', value: -1, gate: 'R2' },
    { label: 'a NaN receipt timeout', option: 'receiptTimeoutMs', value: NaN, gate: 'R2' },
    { label: 'an infinite receipt timeout', option: 'receiptTimeoutMs', value: Infinity, gate: 'R2' },
    { label: 'a zero quiesce timeout', option: 'quiesceTimeoutMs', value: 0, gate: 'R4' },
  ];

  for (const { label, option, value, gate } of cases) {
    it(`rejects ${label} (${gate}) before touching the builder`, async () => {
      const terminal = makeTerminal({ quietness: QUIET });
      const fs = makeFs({});

      await expect(
        runReset(baseOptions({ terminal, fs, [option]: value }) as never),
      ).rejects.toThrow(ResetPreflightError);

      expect(terminal.messages).toHaveLength(0);
      expect(terminal.raw).toHaveLength(0);
      expect(fs.writes).toHaveLength(0);
    });
  }

  it('would otherwise let a negative quiet window pass quiescence instantly', async () => {
    // Demonstrates WHY the guard matters rather than only that it fires. With a
    // permanently-busy terminal and no guard, `now - lastDataAt >= -1` is always
    // true, so R4 would be satisfied without the builder ever going quiet.
    const clock = makeClock();
    const terminal = makeTerminal({});
    vi.spyOn(terminal, 'observe').mockImplementation(async () => ({
      exists: true,
      lastDataAt: clock.now(),
    }));

    await expect(
      runReset(baseOptions({ clock, terminal, quietWindowMs: -1 }) as never),
    ).rejects.toThrow(/quietWindowMs/);

    // Never cleared, because the run never started.
    expect(terminal.raw).not.toContain('/clear');
  });
});

// ============================================================================
// Cross-module coupling: afx cleanup's scaffold classification
// ============================================================================

describe('Spec 1273 — reset artifacts do not make a worktree look dirty', () => {
  it('both artifact names match afx cleanup\'s scaffold pattern', () => {
    // `cleanup.ts` classifies untracked files as scaffold with this pattern.
    // It is duplicated here deliberately: the coupling is by CONVENTION (a
    // filename prefix), not by a shared symbol, so nothing would fail if a
    // future rename dropped the prefix. The consequence would be quiet and
    // annoying — every reset builder's worktree reported dirty, blocking
    // cleanup — so it is worth a test that fails loudly instead.
    const scaffoldPattern = /^\?\? \.builder-/;

    expect(scaffoldPattern.test(`?? ${STATE_FILE_NAME}`)).toBe(true);
    expect(scaffoldPattern.test(`?? ${REORIENT_FILE_NAME}`)).toBe(true);
  });

  it('writes the long form only to a .builder- prefixed path', async () => {
    const fs = makeFs({});
    await runReset(baseOptions({ fs }) as never);

    for (const write of fs.writes) {
      expect(write.path.split('/').pop()).toMatch(/^\.builder-/);
    }
  });
});

// ============================================================================
// Reporting
// ============================================================================

describe('Spec 1273 — the report carries evidence, not reassurance', () => {
  it('reports the accepted state-file size rather than a bare tick', async () => {
    const result = await runReset(baseOptions() as never);
    const report = formatResetReport(result);

    expect(report).toContain('receipt-accepted');
    expect(report).toMatch(/receipt-accepted — \d+ bytes/);
  });

  it('states plainly that the context was NOT cleared on an abort', async () => {
    const result = await runReset(
      baseOptions({ fs: makeFs({ bytes: 120 }), receiptTimeoutMs: 10_000 }) as never,
    );
    const report = formatResetReport(result);

    expect(report).toContain('ABORTED');
    expect(report).toContain('was NOT cleared');
  });
});
