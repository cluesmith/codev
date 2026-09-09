/**
 * Issue #1664 — a recipient that is producing output must NOT hold mail.
 *
 * Owner ruling: "If the AI is producing output it shouldn't wait. It should only wait if the
 * human is typing, because of the way queueing works." Claude Code and codex accept input
 * during a turn and queue it for the next one, so writing onto an EMPTY composer while the
 * agent streams is safe and is the intended behaviour.
 *
 * What used to happen instead: the delivery path proved "the composer has stopped being
 * painted" by requiring the WHOLE SCREEN to be free of output bytes for
 * `SETTLE_BEFORE_WRITE_MS`, and folded `bytesWritten` into the change token it re-checked
 * before writing. Measured on a real streaming claude PTY (the #1664 investigation): the screen
 * repainted a median of 8 times a second — mean interval 122 ms, and only 3 of 728 observed
 * seconds offered fewer than 4 repaints — while the composer region stayed byte-identical for
 * runs of 107 s, 60 s, 304 s, 81 s and 149 s. So the precondition was unobtainable for the
 * duration of a turn, and every hold was a detail-less `busy`, invisible to #1482's diagnostic
 * axis. Field cost over 24 h: 227 deliveries waited more than 2 s, mean 54 s, max 561 s.
 *
 * The fix scopes the question to the composer region. These tests pin, in order:
 *   1. the render-gate half, against a claude-shaped screen whose spinner repaints;
 *   2. the delivery half — streaming output does not hold, a composer redraw does;
 *   3. #1521's hazard, which is what the settle existed for, still holding;
 *   4. the new `composer-redraw` detail reaching every surface that carries a hold verdict.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

import { GLOBAL_SCHEMA } from '../db/schema.js';
import * as mailbox from '../db/mailbox.js';
import {
  deliverAgentMail,
  MailboxDrainer,
  SETTLE_BEFORE_WRITE_MS,
  MAX_COMPOSER_SAMPLE_GAP_MS,
  type DeliveryPorts,
  type DeliverySession,
  type DeliveredBroadcast,
} from '../servers/mailbox-delivery.js';
import { classifyBuffer, composerRegionFingerprint, type GateProfile } from '../servers/render-gate.js';
import { CLAUDE_PROFILE } from '../servers/gate-profiles.js';
import { SessionScreen } from '../../terminal/session-screen.js';
import { composerFingerprintForSession } from '../servers/mailbox-wiring.js';
import { formatVerdict, isUnverifiableVerdict } from '@cluesmith/codev-sdk/hold-verdict';
import type { MailboxGateDetail } from '../db/types.js';

const WS = '/ws/a';
const AGENT = 'spir-1';
const NOW = 1_000_000;
const COLS = 120;
const ROWS = 20;

// ---------------------------------------------------------------------------
// 1. The render gate: a claude-shaped screen whose SPINNER repaints
// ---------------------------------------------------------------------------

const ESC = '\x1b';
const RULE = '─'.repeat(COLS - 2);

/**
 * A claude working-screen, shaped like the real one measured for this issue: a transcript, the
 * spinner/token line, then the composer bracketed by two rules, then the status chrome.
 *
 * `spinner` is the only thing that varies between frames — exactly as it does live, where the
 * glyph rotates and the elapsed/token counters tick several times a second. `composer` is what
 * the human would have typed; empty is the case this issue is about.
 */
function claudeFrame(spinner: string, composer = ''): string {
  const rows = [
    '⏺ Let me trace how the directive is consumed into the model call.',
    '',
    `✽ ${spinner}`,
    '',
    RULE,
    `❯ ${composer}`,
    RULE,
    '  agent | builder/spir-1 | LC: 4m ago | Opus 5 | ctx 312k',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ];
  // Home, clear, paint, then park the cursor in the composer where claude leaves it.
  return (
    `${ESC}[H${ESC}[2J` +
    rows.join('\r\n') +
    `${ESC}[${6};${3 + composer.length}H`
  );
}

async function screenShowing(frame: string): Promise<SessionScreen> {
  const screen = new SessionScreen(COLS, ROWS);
  screen.feed(frame);
  await screen.read();
  return screen;
}

async function fingerprintOf(screen: SessionScreen, profile: GateProfile = CLAUDE_PROFILE): Promise<string | null> {
  const { term, cols, rows } = await screen.read();
  return composerRegionFingerprint(term, cols, rows, profile);
}

describe('#1664 render gate — the composer region, not the whole screen', () => {
  it('fingerprints an empty composer identically across spinner repaints, while the screen changes', async () => {
    // The heart of the bug: everything the whole-screen signal reacts to lives ABOVE the
    // composer. Measured live, 1500 consecutive real repaint frames moved the whole-screen hash
    // 1242 times and the composer region 4 times.
    const screen = await screenShowing(claudeFrame('Bunning… (17m 7s · ↓ 70.5k tokens)'));
    const first = await fingerprintOf(screen);
    expect(first).not.toBeNull();

    const seen = new Set<string>();
    for (const spinner of [
      'Bunning… (17m 8s · ↓ 70.6k tokens)',
      'Simmering… (17m 9s · ↓ 71.0k tokens)',
      'Thinking… (17m 10s · ↓ 71.4k tokens · thinking some more)',
    ]) {
      screen.feed(claudeFrame(spinner));
      const { term, cols, rows } = await screen.read();
      // The composer stays a verified-empty prompt throughout…
      expect(classifyBuffer(term, cols, rows, CLAUDE_PROFILE)).toEqual({ clean: true, detail: 'empty' });
      // …and its fingerprint does not move, even though the frame did.
      seen.add(composerRegionFingerprint(term, cols, rows, CLAUDE_PROFILE) as string);
    }
    expect([...seen]).toEqual([first]);
  });

  it('moves the fingerprint when the COMPOSER itself changes', async () => {
    const screen = await screenShowing(claudeFrame('Bunning… (17m 7s)'));
    const empty = await fingerprintOf(screen);

    screen.feed(claudeFrame('Bunning… (17m 8s)', 'a draft the human started'));
    expect(await fingerprintOf(screen)).not.toBe(empty);
  });

  it('moves the fingerprint on a resize that reflows the same characters', async () => {
    const screen = await screenShowing(claudeFrame('Bunning… (17m 7s)'));
    const before = await fingerprintOf(screen);

    screen.resize(COLS - 20, ROWS);
    expect(await fingerprintOf(screen)).not.toBe(before);
  });

  it('is null when no composer region can be located — indeterminate, never stable', async () => {
    const screen = await screenShowing(`${ESC}[H${ESC}[2Jinstalling dependencies…`);
    expect(await fingerprintOf(screen)).toBeNull();
  });

  it('peek() reads the same region read() does, so the in-lock precheck cannot disagree with the gate', async () => {
    const screen = await screenShowing(claudeFrame('Bunning… (17m 7s)'));
    const flushed = await fingerprintOf(screen);
    const view = screen.peek();
    expect(view).not.toBeNull();
    const peeked = composerRegionFingerprint(view!.term, COLS, ROWS, CLAUDE_PROFILE);
    expect(peeked).toBe(flushed);
  });

  it('peek() REFUSES a grid that has unparsed output — a redraw must not hide in the parse queue', async () => {
    // CMAP round 2 (codex). `feed()` queues an asynchronous xterm parse. Output arriving after
    // the stable sample and immediately before the in-lock precheck is therefore in the queue
    // and NOT in the grid — so a fingerprint taken from that grid would compare EQUAL to the
    // pre-write sample and permit the write, straight into the redraw. That is the corruption
    // race the retired `bytesWritten` comparison used to catch, and refusing to answer while
    // any byte is unparsed is what replaces it.
    const screen = await screenShowing(claudeFrame('Bunning… (17m 7s)'));
    const stable = await fingerprintOf(screen);
    expect(stable).not.toBeNull();

    // A composer-changing frame lands. Deliberately NOT awaited — this models the precheck
    // running in the same tick the bytes arrived.
    screen.feed(claudeFrame('Bunning… (17m 8s)', 'a draft the human started'));

    expect(screen.hasUnparsedOutput).toBe(true);
    expect(screen.peek()).toBeNull();

    // Once parsed, it answers again — and says the composer moved.
    await screen.read();
    expect(screen.hasUnparsedOutput).toBe(false);
    expect(await fingerprintOf(screen)).not.toBe(stable);
  });

  it('the production fingerprint binding passes that refusal through as null (→ hold)', async () => {
    // The delivery path never sees a SessionScreen; it sees this port. A `null` here is what
    // makes the refusal a HOLD rather than a silently stale comparison.
    const screen = await screenShowing(claudeFrame('Bunning… (17m 7s)'));
    const session = { gateScreen: screen } as unknown as DeliverySession;
    expect(composerFingerprintForSession(session, CLAUDE_PROFILE)).not.toBeNull();

    screen.feed(claudeFrame('Bunning… (17m 8s)', 'a draft the human started'));

    expect(composerFingerprintForSession(session, CLAUDE_PROFILE)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. The delivery path
// ---------------------------------------------------------------------------

interface Harness {
  ports: DeliveryPorts;
  writes: string[];
  /** The composer region as the delivery path reads it — tests move this to model a redraw. */
  fingerprint: string | null;
  /** Epoch ms of the recipient's last output byte. A streaming agent keeps this at `now`. */
  lastDataAt: number;
  now: number;
}

function harness(): Harness {
  const h: Harness = {
    writes: [],
    fingerprint: 'empty-composer',
    // A STREAMING recipient: it emitted output this very millisecond, so the whole-screen
    // settle can never pass. This is the state a working claude is in ~8 times a second.
    lastDataAt: NOW,
    now: NOW,
    ports: null as unknown as DeliveryPorts,
  };
  const session: DeliverySession = {
    id: 'term-1664',
    bytesWritten: 0,
    get lastDataAt() {
      return h.lastDataAt;
    },
    inputSeq: 0,
    lastInputAt: 0, // nobody has typed at this terminal
    info: { cols: COLS, rows: ROWS },
    command: 'claude',
    launchArgs: [],
    cwd: WS,
    writable: true,
    write: () => true,
  };
  h.ports = {
    getSessionForAgent: () => session,
    resolveProfile: () => CLAUDE_PROFILE,
    classify: async () => {
      await Promise.resolve(); // a real classify awaits the mirror's parser flush
      return { clean: true, detail: 'empty' };
    },
    composerFingerprint: () => h.fingerprint,
    writeMessage: (_s, msg, _noEnter, precheck) => {
      const abort = precheck();
      if (abort) return { status: 'aborted', abort };
      h.writes.push(msg);
      return { status: 'written' };
    },
    watchEcho: () => Promise.resolve({ verify: () => Promise.resolve(true) }),
    broadcast: () => {},
    onHeldStateChange: () => {},
    onEscalation: () => {},
    onLiveness: () => {},
    log: () => {},
    now: () => h.now,
  };
  return h;
}

describe('#1664 delivery — a recipient producing output does not hold mail', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
  });
  afterEach(() => db.close());

  function enqueue(): mailbox.DbMailboxRow {
    return mailbox.enqueue(db, {
      workspacePath: WS,
      toAgent: AGENT,
      body: 'ping',
      formattedMessage: '### [ARCHITECT INSTRUCTION] ###\nping',
      now: NOW,
    });
  }

  it('THE REGRESSION: delivers to an agent that is streaming, once its composer has held still', async () => {
    // Without the fix this row waits for the turn to end — mean 54 s, max 561 s in the field —
    // because `lastDataAt` is never `SETTLE_BEFORE_WRITE_MS` old while the spinner runs. With
    // it, the first pass records the composer and the second delivers, the composer never
    // having moved. The recipient is producing output throughout.
    const h = harness();
    const row = enqueue();

    const first = await deliverAgentMail(h.ports, db, WS, AGENT);
    expect(first.delivered).toEqual([]);
    expect(first.reason).toBe('busy');
    expect(first.detail).toBe('composer-redraw');
    // Self-clearing on a known interval, so the drainer can arm a re-drain rather than making
    // the row wait for the 1.5 s backstop.
    expect(first.retryAfterMs).toBe(SETTLE_BEFORE_WRITE_MS);

    h.now = NOW + SETTLE_BEFORE_WRITE_MS;
    h.lastDataAt = h.now; // still streaming — output landed this millisecond too

    const second = await deliverAgentMail(h.ports, db, WS, AGENT);
    expect(second.delivered).toEqual([row.id]);
    expect(h.writes).toHaveLength(1);
    expect(mailbox.getById(db, row.id)?.status).toBe('delivered');
  });

  it('holds for as long as the COMPOSER keeps moving, however quiet the rest of the screen is', async () => {
    // The mirror image, and the property #1521 needs: a composer that is being repainted is
    // never written into, no matter how many passes it takes. (A composer redraw is itself
    // output, so the whole-screen fast path cannot fire underneath it — the fake keeps
    // `lastDataAt` honest about that.)
    const h = harness();
    enqueue();

    for (let i = 0; i < 4; i++) {
      h.fingerprint = `composer redraw ${i}`;
      h.now = NOW + i * 10_000; // each pass is an eternity after the last
      h.lastDataAt = h.now; // …and the repaint that moved the composer IS output, so never quiet
      const out = await deliverAgentMail(h.ports, db, WS, AGENT);
      expect(out.delivered).toEqual([]);
      expect(out.detail).toBe('composer-redraw');
    }
    expect(h.writes).toEqual([]);
  });

  it('restarts the stability clock when the composer went UNOBSERVED for too long', async () => {
    // Two equal fingerprints far apart in time prove nothing: between them the composer could
    // have redrawn and come back, which is #1521's window. An agent with no held mail is not
    // sampled at all, so a stale sample must never authorise an immediate write.
    const h = harness();
    enqueue();

    const first = await deliverAgentMail(h.ports, db, WS, AGENT);
    expect(first.delivered).toEqual([]);

    // …a long silence in the sampling, and the SAME fingerprint comes back.
    h.now = NOW + 10 * 60_000;
    h.lastDataAt = h.now;
    const stale = await deliverAgentMail(h.ports, db, WS, AGENT);
    expect(stale.delivered).toEqual([]);
    expect(stale.detail).toBe('composer-redraw');

    // A fresh pair of observations a settle apart does deliver.
    h.now += SETTLE_BEFORE_WRITE_MS;
    h.lastDataAt = h.now;
    expect((await deliverAgentMail(h.ports, db, WS, AGENT)).delivered).toHaveLength(1);
  });

  it('does not reuse a pre-write observation for the NEXT delivery — our own write moved the composer', async () => {
    // CMAP round 1 (codex). A delivery's own bytes are a composer change we know happened: the
    // body lands on the line, the Enter submits it, the TUI paints a fresh prompt. If the
    // pre-write sample survives, a second delivery arriving well inside
    // MAX_COMPOSER_SAMPLE_GAP_MS — and finding the same empty-composer fingerprint — would be
    // authorised to write immediately into the redraw following our own submit. That is #1521's
    // window, reopened, and the gap bound cannot catch it because the reuse is inside the gap.
    const h = harness();
    enqueue();

    // First delivery: two samples a settle apart, then it writes.
    await deliverAgentMail(h.ports, db, WS, AGENT);
    h.now = NOW + SETTLE_BEFORE_WRITE_MS;
    h.lastDataAt = h.now;
    expect((await deliverAgentMail(h.ports, db, WS, AGENT)).delivered).toHaveLength(1);
    expect(h.writes).toHaveLength(1);

    // A second message, well inside the gap window, onto a composer whose fingerprint has
    // come back to what it was before our write.
    enqueue();
    h.now += 400;
    h.lastDataAt = h.now;

    const out = await deliverAgentMail(h.ports, db, WS, AGENT);

    expect(out.delivered).toEqual([]);
    expect(out.detail).toBe('composer-redraw');
    expect(h.writes).toHaveLength(1); // still just the first message

    // It delivers on the next clean pair of observations, as any first-time row does.
    h.now += SETTLE_BEFORE_WRITE_MS;
    h.lastDataAt = h.now;
    expect((await deliverAgentMail(h.ports, db, WS, AGENT)).delivered).toHaveLength(1);
  });

  it('discards the stability sample when a pass classifies NOT clean — that is evidence of movement', async () => {
    // CMAP round 1 (claude). clean → not-clean → clean-with-the-same-fingerprint. The middle
    // pass watched the composer move (a draft, a dialog, a mid-repaint frame); keeping the
    // first sample would let the third pass claim the region held still across exactly the
    // interval we saw it change.
    const h = harness();
    enqueue();

    await deliverAgentMail(h.ports, db, WS, AGENT); // clean: records the sample
    const clean = h.ports.classify;
    h.ports = {
      ...h.ports,
      classify: () => Promise.resolve({ clean: false, reason: 'busy', detail: 'no-region-end' }),
    };
    h.now = NOW + 100;
    h.lastDataAt = h.now;
    expect((await deliverAgentMail(h.ports, db, WS, AGENT)).detail).toBe('no-region-end');

    // Back to clean, same fingerprint, past the settle measured from the FIRST sample.
    h.ports = { ...h.ports, classify: clean };
    h.now = NOW + SETTLE_BEFORE_WRITE_MS + 100;
    h.lastDataAt = h.now;

    const out = await deliverAgentMail(h.ports, db, WS, AGENT);

    expect(out.delivered).toEqual([]);
    expect(out.detail).toBe('composer-redraw');
    expect(h.writes).toEqual([]);
  });

  it('holds at exactly MAX_COMPOSER_SAMPLE_GAP_MS + 1 and delivers at exactly the bound', async () => {
    // Pins the boundary itself, so the constant cannot drift silently in either direction.
    for (const [gap, shouldDeliver] of [
      [MAX_COMPOSER_SAMPLE_GAP_MS, true],
      [MAX_COMPOSER_SAMPLE_GAP_MS + 1, false],
    ] as const) {
      const h = harness();
      const row = enqueue();
      await deliverAgentMail(h.ports, db, WS, AGENT); // first observation
      h.now = NOW + gap;
      h.lastDataAt = h.now; // still streaming, so only region stability can carry the write

      const out = await deliverAgentMail(h.ports, db, WS, AGENT);

      expect(out.delivered).toEqual(shouldDeliver ? [row.id] : []);
      if (!shouldDeliver) expect(out.detail).toBe('composer-redraw');
      mailbox.dismiss(db, row.id);
    }
  });

  it('delivers on the FIRST pass to an idle agent — the whole-screen quiet is still a proof', async () => {
    // The original #1573 signal is strictly stronger than region stability (no output at all
    // means the composer cannot have moved), so it is kept as a fast path: an idle recipient
    // must not pay for a second sample it does not need.
    const h = harness();
    h.lastDataAt = NOW - SETTLE_BEFORE_WRITE_MS;
    const row = enqueue();

    const out = await deliverAgentMail(h.ports, db, WS, AGENT);

    expect(out.delivered).toEqual([row.id]);
  });

  it('holds when no composer region can be located, even if the screen is quiet', async () => {
    // A `null` fingerprint is indeterminate, and indeterminate is not-clean — the same
    // direction the classifier fails in.
    const h = harness();
    h.lastDataAt = NOW - SETTLE_BEFORE_WRITE_MS;
    h.fingerprint = null;
    enqueue();

    const out = await deliverAgentMail(h.ports, db, WS, AGENT);

    expect(out.delivered).toEqual([]);
    expect(out.detail).toBe('composer-redraw');
    expect(h.writes).toEqual([]);
  });

  it('still holds for a HUMAN at the line while the same agent streams', async () => {
    // The invariant the owner's ruling is scoped by: output is not a reason to wait, a person
    // is. A draft makes the classifier answer `user-text`, unchanged by this issue.
    const h = harness();
    h.ports = {
      ...h.ports,
      classify: () => Promise.resolve({ clean: false, reason: 'busy', detail: 'user-text' }),
    };
    const row = enqueue();

    const out = await deliverAgentMail(h.ports, db, WS, AGENT);

    expect(out.delivered).toEqual([]);
    expect(out.detail).toBe('user-text');
    expect(mailbox.getById(db, row.id)?.detail).toBe('user-text');
  });

  it('still holds on recent INPUT while the same agent streams', async () => {
    // The other human-side hold (#1473). A keystroke that has not been echoed yet moves no
    // pixel, so only the input clock sees it — and it must keep holding.
    const h = harness();
    const session = h.ports.getSessionForAgent(WS, AGENT) as DeliverySession;
    const typedAt: DeliverySession = { ...session, lastInputAt: NOW, get lastDataAt() { return h.lastDataAt; } };
    h.ports = { ...h.ports, getSessionForAgent: () => typedAt };
    enqueue();
    // Move past the output settle so the composer side is satisfied outright and the only
    // thing left that can hold is the input clock, which has not run its 300 ms yet.
    h.now = NOW + SETTLE_BEFORE_WRITE_MS;

    const out = await deliverAgentMail(h.ports, db, WS, AGENT);

    expect(out.delivered).toEqual([]);
    expect(out.detail).toBe('recent-input');
    expect(h.writes).toEqual([]);
  });

  it('aborts inside the per-terminal lock when the composer redraws while the lock is waited on', async () => {
    // #1521's exact window: the composer repainting at turn end, caught at the last moment the
    // delivery can still decline. The pre-lock stability check cannot see a change that lands
    // while another submission holds the terminal.
    const h = harness();
    h.lastDataAt = NOW - SETTLE_BEFORE_WRITE_MS;
    const row = enqueue();
    h.ports = {
      ...h.ports,
      writeMessage: (_s, _msg, _noEnter, precheck) => {
        h.fingerprint = 'the composer repainted while we queued';
        const abort = precheck();
        if (abort) return { status: 'aborted', abort };
        h.writes.push(_msg);
        return { status: 'written' };
      },
    };

    const out = await deliverAgentMail(h.ports, db, WS, AGENT);

    expect(out.delivered).toEqual([]);
    expect(out.detail).toBe('composer-redraw');
    expect(h.writes).toEqual([]);
    expect(mailbox.getById(db, row.id)?.status).toBe('held');
  });

  it('does NOT abort inside the lock for output that leaves the composer alone', async () => {
    const h = harness();
    h.lastDataAt = NOW - SETTLE_BEFORE_WRITE_MS;
    const row = enqueue();
    h.ports = {
      ...h.ports,
      writeMessage: (_s, msg, _noEnter, precheck) => {
        h.lastDataAt = h.now; // a spinner frame landed while we held the lock
        const abort = precheck();
        if (abort) return { status: 'aborted', abort };
        h.writes.push(msg);
        return { status: 'written' };
      },
    };

    const out = await deliverAgentMail(h.ports, db, WS, AGENT);

    expect(out.delivered).toEqual([row.id]);
    expect(h.writes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. The drainer's one-shot re-drain
// ---------------------------------------------------------------------------

describe('#1664 drainer — the composer-redraw hold retries on its own interval', () => {
  let db: Database.Database;
  let drainer: MailboxDrainer;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
    drainer = new MailboxDrainer();
    vi.useFakeTimers();
  });
  afterEach(() => {
    drainer.stop();
    vi.useRealTimers();
    db.close();
  });

  it('arms a re-drain for a composer-redraw hold, without counting it as a human typing', async () => {
    // The retry timer is shared with #1473's input settle, but the streak diagnostic beside it
    // is not: its warning says the terminal "has held on recent terminal input continuously",
    // which is a false statement about a repainting composer.
    const h = harness();
    mailbox.enqueue(db, {
      workspacePath: WS,
      toAgent: AGENT,
      body: 'ping',
      formattedMessage: 'ping',
      now: NOW,
    });
    drainer.start(h.ports, db);

    await drainer.scheduleDrain(WS, AGENT);

    expect(drainer.pendingInputRetries).toEqual([`${WS}\0${AGENT}`]);
    expect(drainer.inputHoldStreaks.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. The detail reaches every surface
// ---------------------------------------------------------------------------

describe('#1664 the composer-redraw detail is a first-class hold verdict', () => {
  it('renders through the shared formatter as busy:composer-redraw', () => {
    expect(formatVerdict('busy', 'composer-redraw')).toBe('busy:composer-redraw');
  });

  it('is self-clearing, so it never escalates as a can’t-verify verdict', () => {
    // The allow-list in `isUnverifiableVerdict` names only the two details that never clear on
    // their own. A repainting composer clears one settle after it stops.
    expect(isUnverifiableVerdict('busy', 'composer-redraw')).toBe(false);
    expect(isUnverifiableVerdict('busy', 'no-region-end')).toBe(true);
  });

  it('is a value the mailbox column’s type admits', () => {
    // `MailboxGateDetail` is the enforcement — the DB column carries no CHECK constraint — so
    // this assignment failing to compile is the real assertion.
    const detail: MailboxGateDetail = 'composer-redraw';
    expect(detail).toBe('composer-redraw');
  });

  it('is persisted onto the held row, so afx inbox and the send response can read it', () => {
    const db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
    try {
      const row = mailbox.enqueue(db, {
        workspacePath: WS,
        toAgent: AGENT,
        body: 'ping',
        formattedMessage: 'ping',
        now: NOW,
      });
      mailbox.setHeldVerdict(db, row.id, 'busy', 'composer-redraw', NOW);
      const stored = mailbox.getById(db, row.id);
      expect(stored?.detail).toBe('composer-redraw');
      expect(formatVerdict(stored?.reason, stored?.detail)).toBe('busy:composer-redraw');
    } finally {
      db.close();
    }
  });
});

// A broadcast frame is never emitted for a hold, so the SSE payload is exercised by the
// escalation path's own suite; this file's contract with it is the shared `MailboxGateDetail`
// type, pinned above.
export type { DeliveredBroadcast };
