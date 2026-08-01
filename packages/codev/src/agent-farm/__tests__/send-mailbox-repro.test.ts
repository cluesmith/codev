/**
 * Spec 1313 — the #1265 corruption repro, proved against the REAL render-gate.
 *
 * Unlike send-delivery.test.ts (which injects the gate verdict to test the
 * orchestration branches), this wires the *actual* `classifyScreen` + the real
 * `resolveProfile` + the real `MailboxDrainer` against a flip-able session whose
 * rendered composer moves draft → clean. It is the automated proof of the spec's
 * central claim: **a message is only ever written to a render-verified empty
 * prompt, so it can never fuse with a draft and a draft can never be destroyed.**
 *
 * Deterministic and fast (no subprocess, no real agent), so it runs in the default
 * unit suite as a permanent regression guard. The subprocess HTTP path is covered
 * by send-integration.e2e.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import * as mailbox from '../db/mailbox.js';
import { RingBuffer } from '../../terminal/ring-buffer.js';
import {
  deliverAgentMail,
  MailboxDrainer,
  type DeliveryPorts,
  type DeliverySession,
  type DeliveredBroadcast,
} from '../servers/mailbox-delivery.js';
import { classifyScreen } from '../servers/render-gate.js';
import { resolveProfile } from '../servers/gate-profiles.js';

const COLS = 110;
const ROWS = 32;
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/** A clean claude composer: marker + a dim placeholder only (idle) → gate: clean. */
const CLEAN_SCREEN = screen(`❯ ${DIM}Try "fix the flaky test"${RESET}`, '──────────────────────');
/** An occupied claude composer: a half-typed draft at normal intensity → gate: busy. */
const DRAFT_TEXT = 'deploy the hotfix to prod';
const DRAFT_SCREEN = screen(`❯ ${RESET}${DRAFT_TEXT}`, '──────────────────────');

/** Build a raw \r\n-terminated screen from composer lines (mirrors render-gate.test). */
function screen(...lines: string[]): string {
  return lines.map((l) => l + '\r\n').join('');
}

/** A live session whose rendered composer can be flipped between draft and clean. */
function flipSession(command = 'claude'): DeliverySession & { setScreen(raw: string): void; writes: string[] } {
  const ring = new RingBuffer(1000);
  const writes: string[] = [];
  return {
    ringBuffer: ring,
    info: { cols: COLS, rows: ROWS },
    command,
    launchArgs: [],
    cwd: '/ws/a',
    write: (d: string) => {
      writes.push(d);
      return true;
    },
    writes,
    setScreen(raw: string) {
      ring.clear();
      ring.pushData(raw);
    },
  };
}

/** Delivery ports bound to the REAL gate + real profile resolution. */
function realGatePorts(
  session: DeliverySession | null,
  writes: Array<{ msg: string; noEnter: boolean }>,
  broadcasts: DeliveredBroadcast[],
): DeliveryPorts {
  return {
    getSessionForAgent: () => session,
    resolveProfile: (s) => resolveProfile({ command: s.command, args: s.launchArgs }),
    classify: (snap, prof) => classifyScreen(snap, prof),
    writeMessage: (_s, msg, noEnter) => {
      writes.push({ msg, noEnter });
    },
    broadcast: (f) => broadcasts.push(f),
    onHeldStateChange: () => {},
    onEscalation: () => {},
    log: () => {},
    now: () => 1000,
  };
}

describe('Spec 1313 — #1265 repro against the real render-gate', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
  });
  afterEach(() => db.close());

  function enqueue(body = 'ship it', formatted = '[architect] ship it') {
    return mailbox.enqueue(
      db,
      { workspacePath: '/ws/a', toAgent: 'spir-1', body, formattedMessage: formatted },
      1000,
    );
  }

  it('draft in composer → send holds (busy), the draft is never touched; after the line clears it delivers', async () => {
    const session = flipSession();
    const writes: Array<{ msg: string; noEnter: boolean }> = [];
    const broadcasts: DeliveredBroadcast[] = [];
    const ports = realGatePorts(session, writes, broadcasts);
    const row = enqueue('ship it', '[architect] ship it');

    // 1. A draft occupies the composer → the real gate classifies it busy → HOLD.
    session.setScreen(DRAFT_SCREEN);
    const held = await deliverAgentMail(ports, db, '/ws/a', 'spir-1');
    expect(held).toEqual({ delivered: [], reason: 'busy' });
    expect(writes).toHaveLength(0); // nothing written onto the occupied line
    expect(mailbox.getById(db, row.id)?.status).toBe('held');
    expect(mailbox.getById(db, row.id)?.reason).toBe('busy');

    // 2. The user submits; the composer renders clean → the SAME held row delivers.
    session.setScreen(CLEAN_SCREEN);
    const delivered = await deliverAgentMail(ports, db, '/ws/a', 'spir-1');
    expect(delivered.delivered).toEqual([row.id]);
    expect(mailbox.getById(db, row.id)?.status).toBe('delivered');

    // 3. Corruption-free by construction: the only thing ever written is the message
    //    body — never fused with, and never destroying, the draft.
    expect(writes).toEqual([{ msg: '[architect] ship it', noEnter: false }]);
    expect(writes.map((w) => w.msg).join('')).not.toContain(DRAFT_TEXT);
  });

  it('menu/picker/wrapper (no composer marker) holds busy, then delivers once a real prompt renders', async () => {
    const session = flipSession();
    const writes: Array<{ msg: string; noEnter: boolean }> = [];
    const ports = realGatePorts(session, writes, []);
    const row = enqueue();

    // A marker-less screen (slash menu / boot / relaunch) is never clean.
    session.setScreen(screen('  /help    show help', '  /clear   clear the conversation', '  /model   pick a model'));
    expect((await deliverAgentMail(ports, db, '/ws/a', 'spir-1')).reason).toBe('busy');
    expect(writes).toHaveLength(0);

    session.setScreen(CLEAN_SCREEN);
    expect((await deliverAgentMail(ports, db, '/ws/a', 'spir-1')).delivered).toEqual([row.id]);
  });

  it('an unknown app (no profile) holds no-profile, never guessing a write', async () => {
    const session = flipSession('/bin/bash'); // wrapper shell — no measured profile
    const writes: Array<{ msg: string; noEnter: boolean }> = [];
    const ports = realGatePorts(session, writes, []);
    enqueue();
    session.setScreen(CLEAN_SCREEN); // even a clean-looking screen: no profile → hold
    expect((await deliverAgentMail(ports, db, '/ws/a', 'spir-1')).reason).toBe('no-profile');
    expect(writes).toHaveLength(0);
  });

  it('restart recovery: held rows survive and a fresh drainer redelivers them on a clean gate', async () => {
    // Persist a held row, then simulate a Tower restart by pointing a brand-new
    // drainer at the SAME database file (in-memory handle stands in for global.db).
    const first = enqueue('survive me', '[architect] survive me');
    // Pre-restart the line was busy, so it stayed held.
    const session = flipSession();
    session.setScreen(DRAFT_SCREEN);
    const w1: Array<{ msg: string; noEnter: boolean }> = [];
    await deliverAgentMail(realGatePorts(session, w1, []), db, '/ws/a', 'spir-1');
    expect(mailbox.getById(db, first.id)?.status).toBe('held');

    // "Restart": new drainer, same db, and now the prompt is clean.
    session.setScreen(CLEAN_SCREEN);
    const w2: Array<{ msg: string; noEnter: boolean }> = [];
    const broadcasts: DeliveredBroadcast[] = [];
    const drainer = new MailboxDrainer({ intervalMs: 999999 });
    drainer.start(realGatePorts(session, w2, broadcasts), db);
    await drainer.tick();
    drainer.stop();

    expect(mailbox.getById(db, first.id)?.status).toBe('delivered');
    expect(w2).toEqual([{ msg: '[architect] survive me', noEnter: false }]);
    expect(broadcasts).toHaveLength(1);
  });

  it('respawn drain: a NEW terminal for the same agent drains its predecessor\'s held mail', async () => {
    const row = enqueue('for whoever is live', '[architect] for whoever is live');
    // Predecessor terminal is gone at delivery time.
    const goneWrites: Array<{ msg: string; noEnter: boolean }> = [];
    expect((await deliverAgentMail(realGatePorts(null, goneWrites, []), db, '/ws/a', 'spir-1')).reason).toBe('no-live-pty');
    expect(goneWrites).toHaveLength(0);

    // A respawned terminal (new session) appears with a clean prompt → it drains
    // the row addressed to the AGENT, not the dead terminal.
    const respawned = flipSession();
    respawned.setScreen(CLEAN_SCREEN);
    const writes: Array<{ msg: string; noEnter: boolean }> = [];
    expect((await deliverAgentMail(realGatePorts(respawned, writes, []), db, '/ws/a', 'spir-1')).delivered).toEqual([row.id]);
    expect(writes).toEqual([{ msg: '[architect] for whoever is live', noEnter: false }]);
  });
});
