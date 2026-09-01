/**
 * Issue #1573 — the delivery write edge tells the truth about what landed.
 *
 * Two field bugs shared one disease: silent message loss with a success receipt at the
 * sender. #1564 saw a ~1,900-char architect→builder send arrive as its final ~30 characters;
 * #1521 saw leading bytes eaten by a composer still settling after a turn. Both printed
 * `[ok] Message delivered`. PIR #1365 closed the biggest trigger (a Tower-side
 * interrupt/escape landing mid-write); these tests pin the residuals it left open — the
 * RECEIVING terminal can still eat bytes, and before this change Tower could not tell.
 *
 * Three properties, in leverage order:
 *
 *   1. **Settle-before-write** — a clean gate verdict is not a licence to write into a screen
 *      that is still repainting.
 *   2. **Echo verification** — `markDelivered` requires evidence from the terminal, not just a
 *      write that returned true.
 *   3. **A bounded, harness-agnostic needle** — the header line, normalized, so the match
 *      survives what real TUIs do to a line they are merely displaying.
 *
 * The gate's own screen classification is covered by render-gate.test.ts, and the delivery
 * orchestration's other branches by send-delivery.test.ts; this file is scoped to the write
 * edge's honesty.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import * as mailbox from '../db/mailbox.js';
import {
  deliverAgentMail,
  echoNeedle,
  normalizeForEcho,
  SETTLE_BEFORE_WRITE_MS,
  type DeliveryPorts,
  type DeliverySession,
  type DeliveredBroadcast,
  type WriteAbort,
  type WriteResult,
} from '../servers/mailbox-delivery.js';
import { verifyEchoOnScreen } from '../servers/mailbox-wiring.js';
import { SessionScreen } from '../../terminal/session-screen.js';
import type { GateProfile, GateVerdict } from '../servers/render-gate.js';

const PROFILE: GateProfile = { app: 'claude', markerPattern: /^❯/, regionEndPatterns: [] };
const CLEAN: GateVerdict = { clean: true, detail: 'empty' };

/** The real formatted shape of an architect→builder send: a `###`-fenced header, then a body. */
const HEADER = '### [ARCHITECT INSTRUCTION | 2026-09-01T11:49:41.619Z] ###';
const FORMATTED = `${HEADER}\nplease review the plan\n###############################`;

const NOW = 1_000_000;

interface Harness {
  ports: DeliveryPorts;
  session: DeliverySession & { writes: string[] };
  broadcasts: DeliveredBroadcast[];
  logs: string[];
  /** Formatted messages the write port accepted (one entry per completed paced write). */
  writes: string[];
  /** What `verifyEcho` answers — false models a terminal that never showed the header. */
  echoVerified: boolean;
  /** Needles `verifyEcho` was asked about, in order. */
  needles: string[];
  /** Set by a test to run just before the in-lock precheck (models a race under the lock). */
  beforePrecheck: (() => void) | null;
  now: number;
}

function harness(overrides: Partial<DeliverySession> = {}): Harness {
  const writes: string[] = [];
  const logs: string[] = [];
  const broadcasts: DeliveredBroadcast[] = [];
  const sessionWrites: string[] = [];
  const session = {
    id: 'term-1573',
    bytesWritten: 42,
    // Quiet for far longer than the settle window unless a test says otherwise.
    lastDataAt: NOW - 10_000,
    info: { cols: 110, rows: 32 },
    command: 'claude',
    launchArgs: [] as string[],
    cwd: '/ws/a',
    writable: true,
    write: (data: string) => {
      sessionWrites.push(data);
      return true;
    },
    writes: sessionWrites,
    ...overrides,
  };
  const h: Harness = {
    session,
    broadcasts,
    logs,
    writes,
    echoVerified: true,
    needles: [],
    beforePrecheck: null,
    now: NOW,
    ports: {
      getSessionForAgent: () => h.session,
      resolveProfile: () => PROFILE,
      classify: () => Promise.resolve(CLEAN),
      writeMessage: (_s, formattedMessage, _noEnter, precheck): WriteResult => {
        h.beforePrecheck?.();
        const abort: WriteAbort | null = precheck();
        if (abort) return { status: 'aborted', abort };
        writes.push(formattedMessage);
        return { status: 'written' };
      },
      verifyEcho: (_s, needle) => {
        h.needles.push(needle);
        return Promise.resolve(h.echoVerified);
      },
      broadcast: (f) => broadcasts.push(f),
      onHeldStateChange: () => {},
      onEscalation: () => {},
      onLiveness: () => {},
      log: (m) => logs.push(m),
      now: () => h.now,
    },
  };
  return h;
}

describe('#1573 settle-before-write', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
  });
  afterEach(() => db.close());

  function enqueue(): mailbox.DbMailboxRow | { id: string } {
    return mailbox.enqueue(
      db,
      { workspacePath: '/ws/a', toAgent: 'spir-1', body: 'hi', formattedMessage: FORMATTED },
      NOW,
    );
  }

  it('holds without writing when the screen produced output inside the settle window', async () => {
    // A clean gate verdict on a composer that repainted 1 ms ago is indistinguishable from one
    // idle for a minute — that is the #1521 window, where the leading bytes of
    // `[USER via VS Code]` were eaten by a composer still settling after a turn.
    const h = harness({ lastDataAt: NOW - (SETTLE_BEFORE_WRITE_MS - 1) });
    const row = enqueue();

    const out = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    expect(out).toEqual({ delivered: [], reason: 'busy' });
    expect(h.writes).toEqual([]);
    expect(h.session.writes).toEqual([]);
    const stored = mailbox.getById(db, row.id);
    expect(stored?.status).toBe('held');
    expect(stored?.reason).toBe('busy');
  });

  it('delivers once the screen has been quiet for the full settle window', async () => {
    const h = harness({ lastDataAt: NOW - SETTLE_BEFORE_WRITE_MS });
    const row = enqueue();

    const out = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    expect(out.delivered).toEqual([row.id]);
    expect(h.writes).toEqual([FORMATTED]);
    expect(mailbox.getById(db, row.id)?.status).toBe('delivered');
  });

  it('re-checks inside the per-terminal lock: output landing while the lock is waited on aborts the write', async () => {
    // The pre-lock check happens before the submission lock is acquired. A delivery that waited
    // behind another submission would otherwise write onto a screen that started painting while
    // it queued — the same race #1365 closed for lock-taking writers, applied to freshness.
    const h = harness();
    const row = enqueue();
    // Mutate the SAME session object the delivery captured — the in-lock precheck closes over
    // it, so replacing the harness's reference would prove nothing.
    let lastDataAt = NOW - 10_000;
    Object.defineProperty(h.session, 'lastDataAt', { get: () => lastDataAt });
    h.beforePrecheck = () => {
      lastDataAt = h.now - 1;
    };

    const out = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    expect(out).toEqual({ delivered: [], reason: 'busy' });
    expect(h.writes).toEqual([]);
    expect(mailbox.getById(db, row.id)?.status).toBe('held');
  });

  it('holds when the session carries no usable output timestamp rather than writing blind', async () => {
    // NaN fails every comparison, so an unknown screen age must be phrased as "not settled".
    // A fail-open here would be worse than no check at all: it would look like a guarantee.
    const h = harness({ lastDataAt: Number.NaN });
    enqueue();

    const out = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    expect(out).toEqual({ delivered: [], reason: 'busy' });
    expect(h.writes).toEqual([]);
  });
});

describe('#1573 echo verification before markDelivered', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
  });
  afterEach(() => db.close());

  function enqueue() {
    return mailbox.enqueue(
      db,
      { workspacePath: '/ws/a', toAgent: 'spir-1', body: 'hi', formattedMessage: FORMATTED },
      NOW,
    );
  }

  /**
   * THE CONTROL TEST for this issue. Every upstream signal says success — the gate was clean,
   * the paced write completed, every `session.write` returned true — and the terminal never
   * showed the message. Before this change that combination produced `delivered` plus a
   * broadcast, which is precisely the false receipt #1564 and #1521 were reported as.
   */
  it('a completed write whose header never reaches the screen is HELD, not delivered', async () => {
    const h = harness();
    h.echoVerified = false;
    const row = enqueue();

    const out = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    expect(out).toEqual({ delivered: [], reason: 'busy' });
    // The bytes DID go out — this is a hold for redelivery, not a claim that nothing happened.
    expect(h.writes).toEqual([FORMATTED]);
    const stored = mailbox.getById(db, row.id);
    expect(stored?.status).toBe('held');
    expect(stored?.reason).toBe('busy');
    // No delivery broadcast: the dashboard must not show a message the agent never saw.
    expect(h.broadcasts).toEqual([]);
    expect(h.logs.join('\n')).toContain('never appeared on the terminal');
  });

  it('a confirmed header marks the row delivered and broadcasts it', async () => {
    const h = harness();
    const row = enqueue();

    const out = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    expect(out.delivered).toEqual([row.id]);
    expect(mailbox.getById(db, row.id)?.status).toBe('delivered');
    expect(h.broadcasts).toHaveLength(1);
    // Verification asks about the HEADER line only — never the body, never the footer.
    expect(h.needles).toEqual([normalizeForEcho(HEADER)]);
  });

  it('a row held by a failed verification is redelivered by the next pass', async () => {
    // The hold is the whole safety argument: the direction of error becomes a duplicate
    // delivery the agent can see, never a silent loss the sender was told was a success.
    const h = harness();
    h.echoVerified = false;
    const row = enqueue();

    await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');
    expect(mailbox.getById(db, row.id)?.status).toBe('held');

    h.echoVerified = true;
    const out = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    expect(out.delivered).toEqual([row.id]);
    expect(h.writes).toEqual([FORMATTED, FORMATTED]);
    expect(mailbox.getById(db, row.id)?.status).toBe('delivered');
  });

  it('skips verification for a message too short to have a distinctive header', async () => {
    // A two-character raw send would match incidental screen text, so confirming it would be a
    // rubber stamp. Such sends keep the pre-#1573 behaviour instead of a fake guarantee.
    const h = harness();
    h.echoVerified = false;
    const row = mailbox.enqueue(
      db,
      { workspacePath: '/ws/a', toAgent: 'spir-1', body: 'y', formattedMessage: 'y' },
      NOW,
    );

    const out = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    expect(out.delivered).toEqual([row.id]);
    expect(h.needles).toEqual([]);
  });
});

describe('#1573 echo needle', () => {
  it('normalizes away everything a TUI can do to a line it is displaying', () => {
    // Measured against live harnesses 2026-09-01: claude echoes the header verbatim into its
    // composer, then re-renders it markdown-stripped once submitted; codex keeps the fences.
    const needle = echoNeedle(FORMATTED);
    const claudeComposer = `❯ ${HEADER}`;
    const claudeSubmitted = '  [ARCHITECT INSTRUCTION | 2026-09-01T11:49:41.619Z]';
    const wrappedAcrossRows = '> ### [ARCHITECT INSTRUCTION |\n  2026-09-01T11:49:41.619Z] ###';

    expect(needle).not.toBe('');
    for (const rendered of [claudeComposer, claudeSubmitted, wrappedAcrossRows]) {
      expect(normalizeForEcho(rendered)).toContain(needle);
    }
  });

  it('is the FIRST line, never the tail', () => {
    // #1564's message arrived as its final ~30 characters, so a footer needle would have
    // certified the exact corruption this check exists to catch.
    const needle = echoNeedle(FORMATTED);
    expect(normalizeForEcho('###############################')).not.toContain(needle);
  });

  it('returns empty for a body with no distinctive first line', () => {
    expect(echoNeedle('ok')).toBe('');
    expect(echoNeedle('y\nmore text follows here')).toBe('');
  });
});

describe('#1573 verifyEchoOnScreen against a real screen mirror', () => {
  /** A session double carrying a real `SessionScreen`, which is what the binding reads. */
  function sessionWithScreen(screen: SessionScreen | null): DeliverySession {
    return { gateScreen: screen } as unknown as DeliverySession;
  }

  it('finds the header claude echoes into its composer', async () => {
    const screen = new SessionScreen(110, 32);
    screen.feed(`❯ ${HEADER}\r\nplease review the plan\r\n`);

    await expect(verifyEchoOnScreen(sessionWithScreen(screen), echoNeedle(FORMATTED))).resolves.toBe(true);
    screen.dispose();
  });

  it('finds the markdown-stripped header claude renders after the message is submitted', async () => {
    // The measured post-submit form: the `###` fences are consumed as an H3, so an exact-line
    // match would fail on every short claude delivery — the common case.
    const screen = new SessionScreen(110, 32);
    screen.feed('  [ARCHITECT INSTRUCTION | 2026-09-01T11:49:41.619Z]\r\n  please review the plan\r\n');

    await expect(verifyEchoOnScreen(sessionWithScreen(screen), echoNeedle(FORMATTED))).resolves.toBe(true);
    screen.dispose();
  });

  it('finds a header that scrolled out of the viewport into scrollback', async () => {
    // A long message pushes its own header off the top while it is still being typed; the only
    // place it survives is scrollback, so the scan must reach past the viewport.
    const screen = new SessionScreen(110, 32);
    screen.feed(`❯ ${HEADER}\r\n`);
    screen.feed(Array.from({ length: 200 }, (_, i) => `body line ${i}`).join('\r\n') + '\r\n');

    await expect(verifyEchoOnScreen(sessionWithScreen(screen), echoNeedle(FORMATTED))).resolves.toBe(true);
    screen.dispose();
  });

  it('reports false for a terminal that never showed the header, and for a session with no mirror', async () => {
    const screen = new SessionScreen(110, 32);
    screen.feed('❯ \r\n────────────────────\r\n');

    await expect(verifyEchoOnScreen(sessionWithScreen(screen), echoNeedle(FORMATTED))).resolves.toBe(false);
    // No mirror means no output has ever been rendered, so nothing can have been echoed.
    await expect(verifyEchoOnScreen(sessionWithScreen(null), echoNeedle(FORMATTED))).resolves.toBe(false);
    screen.dispose();
  });

  it('returns as soon as the header appears, without waiting out its budget', async () => {
    const screen = new SessionScreen(110, 32);
    screen.feed(`❯ ${HEADER}\r\n`);

    const started = Date.now();
    await verifyEchoOnScreen(sessionWithScreen(screen), echoNeedle(FORMATTED));

    // The full budget is 600ms; a hit on the first read must not pay any of it.
    expect(Date.now() - started).toBeLessThan(200);
    screen.dispose();
  });
});
