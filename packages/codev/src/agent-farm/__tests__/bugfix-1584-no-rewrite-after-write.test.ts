/**
 * Issue #1584 — a completed write is NEVER written again.
 *
 * The 3.3.2 field failure (#1583): one `afx send --file` message was re-injected into a
 * builder's prompt dozens of times, byte-identical. #1573 had made a failed echo-verification
 * return `hold('busy')` AFTER the paced write completed, so the row went back into the
 * drainer's held set and every later clean-prompt pass re-wrote the whole message. No attempt
 * cap existed anywhere in the module, and `busy` holds are excluded from `isClassifierStuck`,
 * so the loop was silent. It was self-sustaining in the common case: a recipient that starts
 * responding immediately scrolls the header out of the sampled mirror, verification fails, the
 * message is re-injected, the recipient responds again.
 *
 * The contract this file pins: once `writeMessage` returns `written`, the row is at-least-once
 * delivered. It is marked `delivered` whatever the echo says — flagged `escalated` and reported
 * `verified: false` when the echo could not confirm — and no later pass may write it again.
 *
 * `bugfix-1573-delivery-verification.test.ts` keeps the settle-before-write and needle
 * properties, which this change does not touch.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import * as mailbox from '../db/mailbox.js';
import {
  MailboxDrainer,
  deliverAgentMail,
  echoNeedle,
  type DeliveryPorts,
  type DeliverySession,
  type DeliveredBroadcast,
  type LivenessInfo,
  type UnverifiedDeliveryInfo,
  type WriteAbort,
  type WriteResult,
} from '../servers/mailbox-delivery.js';
import { watchEchoOnScreen } from '../servers/mailbox-wiring.js';
import { SessionScreen } from '../../terminal/session-screen.js';
import type { GateProfile, GateVerdict } from '../servers/render-gate.js';
import { formatArchitectToBuilderMessage } from '../utils/message-format.js';

const PROFILE: GateProfile = { app: 'claude', markerPattern: /^❯/, regionEndPatterns: [] };
const CLEAN: GateVerdict = { clean: true, detail: 'empty' };

/** A long-ish body, as in the field report: a `--file` send is what looped. */
const FORMATTED = formatArchitectToBuilderMessage(
  'spir-1',
  Array.from({ length: 60 }, (_, i) => `plan line ${i}`).join('\n'),
);
const HEADER = FORMATTED.split('\n', 1)[0];

const NOW = 2_000_000;

interface Harness {
  ports: DeliveryPorts;
  session: DeliverySession;
  broadcasts: DeliveredBroadcast[];
  logs: { message: string; level?: string }[];
  /** Formatted messages the write port accepted — one entry per completed paced write. */
  writes: string[];
  /** What every echo watch answers. */
  echoVerified: boolean;
  /** How many times a watch's `verify()` was consulted, across all watches. */
  verifyCalls: number;
  /** Unverified-delivery notices raised through the port. */
  notices: UnverifiedDeliveryInfo[];
  /** Liveness escalations raised through the port (must stay empty — issue item 4). */
  liveness: LivenessInfo[];
  /** The row's DB status at the moment `verify()` was first consulted. */
  statusAtVerify: string | undefined;
}

function harness(): Harness {
  const h: Harness = {
    session: {
      id: 'term-1584',
      bytesWritten: 7,
      lastDataAt: NOW - 10_000,
      info: { cols: 110, rows: 32 },
      command: 'claude',
      launchArgs: [],
      cwd: '/ws/a',
      writable: true,
      write: () => true,
    },
    broadcasts: [],
    logs: [],
    writes: [],
    echoVerified: false,
    verifyCalls: 0,
    notices: [],
    liveness: [],
    statusAtVerify: undefined,
    ports: {
      getSessionForAgent: () => h.session,
      resolveProfile: () => PROFILE,
      classify: () => Promise.resolve(CLEAN),
      writeMessage: (_s, formattedMessage, _noEnter, precheck): WriteResult => {
        const abort: WriteAbort | null = precheck();
        if (abort) return { status: 'aborted', abort };
        h.writes.push(formattedMessage);
        return { status: 'written' };
      },
      watchEcho: () =>
        Promise.resolve({
          verify: () => {
            h.verifyCalls++;
            return Promise.resolve(h.echoVerified);
          },
        }),
      broadcast: (f) => h.broadcasts.push(f),
      onHeldStateChange: () => {},
      onEscalation: () => {},
      onLiveness: (info) => h.liveness.push(info),
      onUnverifiedDelivery: (info) => h.notices.push(info),
      log: (message, level) => h.logs.push({ message, level }),
      now: () => NOW,
    },
  };
  return h;
}

describe('#1584 a completed write is never re-written', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
  });
  afterEach(() => db.close());

  function enqueue() {
    return mailbox.enqueue(
      db,
      { workspacePath: '/ws/a', toAgent: 'spir-1', body: 'the plan', formattedMessage: FORMATTED },
      NOW,
    );
  }

  /**
   * THE CONTROL TEST for this issue: it fails on 3.3.2, where the first pass returned
   * `hold('busy')` and the drainer tick wrote a second byte-identical copy.
   */
  it('writes exactly once when the terminal never shows the header, and the drainer adds nothing', async () => {
    const h = harness(); // echoVerified: false — the mirror never shows the header
    const row = enqueue();

    const out = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    expect(out).toEqual({ delivered: [row.id], reason: null, verified: false });
    expect(h.writes).toEqual([FORMATTED]);
    const stored = mailbox.getById(db, row.id);
    expect(stored?.status).toBe('delivered');
    expect(stored?.status).not.toBe('held');
    expect(stored?.escalated).toBe(1);

    // A real backstop tick, the thing that actually re-injected in the field.
    const drainer = new MailboxDrainer({ intervalMs: 999_999 });
    drainer.start(h.ports, db);
    await drainer.tick();
    await drainer.tick();
    drainer.stop();

    expect(h.writes).toEqual([FORMATTED]);
  });

  it('logs the unconfirmed delivery at WARN so an operator can find it after the fact', async () => {
    const h = harness();
    const row = enqueue();

    await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    const warn = h.logs.find((l) => l.level === 'WARN');
    expect(warn).toBeDefined();
    expect(warn?.message).toContain('delivered-unverified');
    expect(warn?.message).toContain(row.id.slice(0, 8));
    expect(warn?.message).toContain('spir-1');
    expect(warn?.message).toContain(h.session.id);
    // The needle length, so a too-short/mangled needle is diagnosable from the log alone.
    expect(warn?.message).toContain(`${echoNeedle(FORMATTED).length} chars`);
  });

  it('spends at most two verify windows and writes no bytes between them', async () => {
    // The extra window is the concession to a slow renderer. It must stay a LOOK, never a retry:
    // an unbounded number of windows would just move the latency, and a re-write would restore
    // the loop.
    const h = harness();
    enqueue();

    await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    expect(h.verifyCalls).toBe(2);
    expect(h.writes).toHaveLength(1);
  });

  it('still broadcasts the delivery — the bytes did reach the PTY', async () => {
    const h = harness();
    enqueue();

    await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    expect(h.broadcasts).toHaveLength(1);
    expect(h.broadcasts[0].to).toEqual({ project: 'a', agent: 'spir-1' });
  });

  it('leaves the verified path exactly as it was: delivered, verified, not flagged', async () => {
    const h = harness();
    h.echoVerified = true;
    const row = enqueue();

    const out = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    expect(out).toEqual({ delivered: [row.id], reason: null, verified: true });
    expect(h.verifyCalls).toBe(1); // no second window when the first one confirms
    expect(mailbox.getById(db, row.id)?.escalated).toBe(0);
  });

  it('a PRE-write hold still holds — this change touches nothing before the write', async () => {
    const h = harness();
    h.ports.classify = () => Promise.resolve({ clean: false, reason: 'busy', detail: 'user-text' });
    const row = enqueue();

    const out = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    expect(out.delivered).toEqual([]);
    expect(h.writes).toEqual([]);
    expect(mailbox.getById(db, row.id)?.status).toBe('held');
  });

  /**
   * DURABILITY of the point of no return (CMAP round 1 — Codex). Committing the row only AFTER
   * verification would leave it `held` for up to ~1.2 s: a Tower crash or restart inside that
   * window, and the next drainer tick re-writes the message. The commit must therefore precede
   * every await that follows the write, which this pins by reading the row's status from the
   * database at the instant `verify()` is first consulted.
   */
  it('commits the row to delivered BEFORE it starts verifying', async () => {
    const h = harness();
    const row = enqueue();
    h.ports.watchEcho = () =>
      Promise.resolve({
        verify: () => {
          h.verifyCalls++;
          h.statusAtVerify ??= mailbox.getById(db, row.id)?.status;
          return Promise.resolve(false);
        },
      });

    await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    expect(h.statusAtVerify).toBe('delivered');
  });

  it('treats a verification that THROWS as unconfirmed, not as a delivery failure', async () => {
    // A rejection used to propagate out of the delivery pass, leaving the row `held` — the same
    // re-writable state the hold did. The bytes are already out, so the only honest answer is
    // "could not confirm".
    const h = harness();
    h.ports.watchEcho = () =>
      Promise.resolve({ verify: () => Promise.reject(new Error('screen read failed')) });
    const row = enqueue();

    const out = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    expect(out).toEqual({ delivered: [row.id], reason: null, verified: false });
    const stored = mailbox.getById(db, row.id);
    expect(stored?.status).toBe('delivered');
    expect(stored?.escalated).toBe(1);
    expect(h.logs.some((l) => l.level === 'WARN' && l.message.includes('screen read failed'))).toBe(true);

    const drainer = new MailboxDrainer({ intervalMs: 999_999 });
    drainer.start(h.ports, db);
    await drainer.tick();
    drainer.stop();

    expect(h.writes).toEqual([FORMATTED]);
  });

  it('raises a human-visible notice, since a delivered row is invisible to every held surface', async () => {
    // `afx inbox`, the held-count indicator and heldSummaryForWorkspace all filter on `held`, so
    // the escalated flag alone reaches nobody. An interactive send learns this from
    // `verified: false`; a cron or backstop delivery has no sender waiting (CMAP round 1 — Codex).
    const h = harness();
    const row = enqueue();

    await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    expect(h.notices).toEqual([
      { workspacePath: '/ws/a', toAgent: 'spir-1', mailboxId: row.id, terminalId: 'term-1584' },
    ]);
    expect(mailbox.heldSummaryForWorkspace(db, '/ws/a', NOW).total).toBe(0);
  });

  it('raises no notice when verification confirms', async () => {
    const h = harness();
    h.echoVerified = true;
    enqueue();

    await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    expect(h.notices).toEqual([]);
  });

  /**
   * Issue item 4, confirmed rather than assumed. `isClassifierStuck` excludes `busy`, which is
   * what kept the old loop silent. There is no longer a busy-hold after a completed write, so a
   * repeated unverified delivery must never accumulate a streak or raise liveness telemetry —
   * the reason is `null` on every pass, because every pass is a delivery.
   */
  it('never accumulates a not-clean streak for unverified deliveries', async () => {
    const h = harness();
    const drainer = new MailboxDrainer({ intervalMs: 999_999 });
    drainer.start(h.ports, db);

    for (let i = 0; i < 12; i++) {
      mailbox.enqueue(
        db,
        { workspacePath: '/ws/a', toAgent: 'spir-1', body: `m${i}`, formattedMessage: FORMATTED },
        NOW,
      );
      await drainer.tick();
    }
    drainer.stop();

    // Twelve messages, twelve writes — one each, never a repeat.
    expect(h.writes).toHaveLength(12);
    // LIVENESS_STREAK_THRESHOLD is 10; a busy-hold streak would have crossed it by now.
    expect(h.liveness).toEqual([]);
  });

  /**
   * The field trigger, against the REAL screen mirror rather than a boolean: the recipient
   * starts responding at once, and its output pushes the header out of the retained buffer, so
   * the post-write count is not greater than the pre-write one. On 3.3.2 this is the input that
   * produced the loop; here it must produce one write and a flagged delivery.
   */
  it('an immediate responder that scrolls the header away is delivered once, not re-injected', async () => {
    const screen = new SessionScreen(110, 32);
    const needle = echoNeedle(FORMATTED);
    const h = harness();
    h.ports.watchEcho = (_s, n) => watchEchoOnScreen({ gateScreen: screen } as unknown as DeliverySession, n);
    h.ports.writeMessage = (_s, formattedMessage, _noEnter, precheck): WriteResult => {
      const abort: WriteAbort | null = precheck();
      if (abort) return { status: 'aborted', abort };
      h.writes.push(formattedMessage);
      // The header is echoed, then the recipient's own response buries it past the mirror's
      // retention before verification ever samples.
      screen.feed(`❯ ${HEADER}\r\n`);
      screen.feed(Array.from({ length: 2000 }, (_, i) => `assistant response line ${i}`).join('\r\n') + '\r\n');
      return { status: 'written' };
    };
    const row = enqueue();

    const out = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    expect(needle).not.toBe('');
    expect(h.writes).toEqual([FORMATTED]);
    expect(out.delivered).toEqual([row.id]);
    expect(mailbox.getById(db, row.id)?.status).toBe('delivered');

    const drainer = new MailboxDrainer({ intervalMs: 999_999 });
    drainer.start(h.ports, db);
    await drainer.tick();
    drainer.stop();

    expect(h.writes).toEqual([FORMATTED]);
    screen.dispose();
  });
});
