/**
 * Receiving a message on a real Tower (Spec 1967, plan phase 6, layer B).
 *
 * Two built Towers on the stand-in relay over loopback; Tower b receives what the stand-in
 * forwards as from Tower a (`mbp`). What only a real Tower shows: the real render gate, the
 * real per-agent serializer and per-terminal lock, and the real terminal registry.
 *
 * - no grant: refused `no-grant`, nothing stored; the same statement again is not verified;
 *   a new statement after the grant is accepted;
 * - an inert architect (no agent profile) is held `no-profile`; a builder by its id whose
 *   composer renders clean is delivered, in the remote frame; a shell is refused;
 * - with the terminal lock held by an `--interrupt` still writing, the answer is `held`,
 *   `busy` within 5 seconds, while the interrupt is still on the wire; the message is
 *   delivered once the lock frees and the composer renders clean.
 *
 * The live terminals are echo terminals (`stty raw -echo; exec cat`): what is written to one
 * is what it renders, so a test draws the exact composer the gate classifies, as
 * `send-integration.e2e.test.ts` does. The claude one sits in a directory whose
 * `.builder-start.sh` names `claude`, which is how the gate recovers a wrapped builder's
 * profile. agy is not a harness a launch script can name, and the gate matches it by the
 * command's own name, so the agy one runs the echo program from an executable named `agy`.
 *
 * Phase 7 brings the peer listing from the cloud. Until then the grant routes find the
 * sending Tower in a listing this test writes into Tower b's own throwaway database.
 *
 * On demand, after `pnpm build`, never in porch's tests check:
 *
 *   pnpm exec vitest run --config vitest.e2e.config.ts \
 *     src/agent-farm/__tests__/peer-receive.e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { RingBuffer } from '../../terminal/ring-buffer.js';
import { writeListing } from '../peer/store.js';
import { INERT_SCRIPT, makeWorkspace, startTwoTowers, writeInertAgent, type TwoTowers } from './helpers/two-towers.js';
import { messagePayload } from './helpers/stand-in-relay.js';
import { waitFor } from './helpers/tower-test-utils.js';

const ESC = '\x1b';
const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`;
/** A clean claude composer: the marker and a dim placeholder only (send-integration.e2e). */
const CLAUDE_CLEAN = `${CLEAR_SCREEN}❯ ${ESC}[2mTry "fix the flaky test"${ESC}[0m\r\n${'─'.repeat(22)}\r\n`;
/** A clean agy composer: the captured idle screen the render gate's own tests classify clean. */
const AGY_CLEAN = (() => {
  const raw = readFileSync(fileURLToPath(new URL('./fixtures/gate/agy-idle.clean.txt', import.meta.url)), 'utf8');
  const ring = new RingBuffer(1000);
  ring.pushData(raw);
  return CLEAR_SCREEN + ring.getAll().join('\n');
})();

const BODY = 'CI is green on the tunnel branch';
const CLAUDE_BUILDER = 'builder-spir-777';
const AGY_BUILDER = 'builder-spir-778';

interface Answer {
  v: number;
  outcome: string;
  reason?: string;
  duplicate?: boolean;
}

interface MailRow {
  id: string;
  to_agent: string;
  status: string;
  reason: string | null;
  formatted_message: string;
  remote_tower_id: string | null;
  remote_message_id: string | null;
}

describe('Spec 1967 phase 6: receiving a message on a real Tower', () => {
  let towers: TwoTowers;
  let ws: string;
  let claudeTerminal: string;
  let agyTerminal: string;

  const to = (address: Record<string, string>, body = BODY) =>
    messagePayload({ sentAt: Date.now(), to: address, from: { workspace: 'codev', kind: 'architect', name: 'main' }, body });

  const forward = async (payload: Buffer, requestId?: string) => {
    const result = await towers.relay.forward(towers.b.towerId, { payload, requestId });
    expect(result.status).toBe(200);
    return { ...result, answer: result.json as Answer, requestId: (JSON.parse(result.statementBytes.toString('utf8')) as { requestId: string }).requestId };
  };

  const mail = (): MailRow[] =>
    towers.b.readDb((db) => db.prepare('SELECT * FROM mailbox WHERE remote_tower_id IS NOT NULL ORDER BY created_at, id').all() as MailRow[]);
  const mailFor = (requestId: string) => mail().filter((row) => row.remote_message_id === requestId);
  const acceptedFor = (requestId: string) =>
    towers.b.readDb((db) => db.prepare('SELECT * FROM peer_accepted WHERE message_id = ?').all(requestId));

  /**
   * A shellper-backed echo terminal in its own directory: for claude, a `sh` whose
   * `.builder-start.sh` names `claude`; for agy, an executable named `agy`.
   */
  const echoTerminal = async (roleId: string, agent: 'claude' | 'agy'): Promise<string> => {
    const dir = join(ws, '.builders', roleId);
    mkdirSync(dir, { recursive: true });
    const echo = 'stty raw -echo 2>/dev/null; exec cat';
    let launch: { command: string; args: string[] };
    if (agent === 'claude') {
      writeFileSync(join(dir, '.builder-start.sh'), '#!/bin/bash\nexec claude\n');
      launch = { command: 'sh', args: ['-c', echo] };
    } else {
      writeFileSync(join(dir, 'agy'), `#!/bin/sh\n${echo}\n`, { mode: 0o755 });
      launch = { command: join(dir, 'agy'), args: [] };
    }
    const res = await towers.b.json<{ id: string }>('POST', '/api/terminals', {
      ...launch,
      cwd: dir,
      cols: 110,
      rows: 32,
      workspacePath: ws,
      type: 'builder',
      roleId,
      persistent: true,
    });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const render = async (terminalId: string, screen: string) => {
    const res = await towers.b.fetch(`/api/terminals/${terminalId}/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: screen }),
    });
    expect(res.ok).toBe(true);
    // Past the input settle (#1473): the write route is an external writer.
    await new Promise((resolve) => setTimeout(resolve, 600));
  };

  beforeAll(async () => {
    towers = await startTwoTowers();
    const { a, b, root } = towers;
    ws = makeWorkspace(join(root, 'b', 'codev'), writeInertAgent(root));
    await b.activate(ws);

    // The listing phase 7 will fetch: Tower a, online, on protocol 1.
    const db = new Database(b.dbPath);
    try {
      writeListing(
        db,
        {
          relay: { protocols: [1] },
          limits: { messagesPerTowerPerMinute: 60, messagesPerPairPerMinute: 30, queriesPerPairPerMinute: 10 },
          towers: [{ towerId: a.towerId, slug: a.slug, online: true, protocols: [1], remoteMessaging: 'off' }],
        },
        Date.now(),
      );
    } finally {
      db.close();
    }

    const on = await b.json('PUT', '/api/peer/switch', { state: 'on', humanApproved: true });
    expect(on.status).toBe(200);

    claudeTerminal = await echoTerminal(CLAUDE_BUILDER, 'claude');
    agyTerminal = await echoTerminal(AGY_BUILDER, 'agy');
    const shell = await b.json('POST', '/api/terminals', {
      command: '/bin/sh',
      args: ['-c', INERT_SCRIPT],
      cwd: ws,
      cols: 80,
      rows: 24,
      workspacePath: ws,
      type: 'shell',
      roleId: 'shell-1',
      persistent: true,
    });
    expect(shell.status).toBe(201);
  }, 180_000);

  afterAll(async () => {
    await towers?.stop();
  }, 120_000);

  it('without a grant: refused no-grant, nothing stored; the statement is then used up; a new one after the grant is accepted', async () => {
    const payload = to({ workspace: 'codev', kind: 'architect' });
    const first = await forward(payload);
    expect(first.answer).toEqual({ v: 1, outcome: 'refused', reason: 'no-grant' });
    expect(mailFor(first.requestId)).toEqual([]);
    expect(acceptedFor(first.requestId)).toEqual([]);

    expect((await towers.relay.replay(first, towers.b.towerId)).json).toEqual({ v: 1, outcome: 'not-verified' });

    const grant = await towers.b.json('POST', '/api/peer/grants', { tower: towers.a.slug, all: true, humanApproved: true });
    expect(grant.status, JSON.stringify(grant.body)).toBe(200);

    // The inert architect has no agent profile: accepted, and held for it.
    const retry = await forward(payload, first.requestId);
    expect(retry.answer).toEqual({ v: 1, outcome: 'held', reason: 'no-profile' });
    const [row] = mailFor(first.requestId);
    expect(row).toMatchObject({ to_agent: 'main', status: 'held', reason: 'no-profile' });
    expect(row.formatted_message.split('\n')[0]).toMatch(/^### \[REMOTE, your Tower · afx:\/\/mbp\/codev:architect:main → main \| /);
    expect(acceptedFor(first.requestId)).toHaveLength(1);

    // The same message again is its duplicate.
    expect((await forward(payload, first.requestId)).answer).toEqual({ v: 1, outcome: 'held', reason: 'no-profile', duplicate: true });
  }, 60_000);

  it('delivers to a builder by its id through the real gate, in the remote frame', async () => {
    await render(claudeTerminal, CLAUDE_CLEAN);
    const sent = await forward(to({ workspace: 'codev', kind: 'id', name: CLAUDE_BUILDER }));
    expect(sent.answer).toEqual({ v: 1, outcome: 'delivered' });
    const [row] = mailFor(sent.requestId);
    expect(row.status).toBe('delivered');
    expect(row.formatted_message.split('\n')).toEqual([
      expect.stringMatching(/^### \[REMOTE, your Tower · afx:\/\/mbp\/codev:architect:main → builder-spir-777 \| \S+Z\] ###$/),
      BODY,
      '###############################  (reply: afx send afx://mbp/codev:architect "…")',
    ]);
  }, 60_000);

  it('refuses a shell as not-addressable and an unknown agent as no-such-agent, storing nothing', async () => {
    for (const [name, reason] of [
      ['shell-1', 'not-addressable'],
      ['builder-gone', 'no-such-agent'],
    ] as const) {
      const sent = await forward(to({ workspace: 'codev', kind: 'id', name }));
      expect(sent.answer, name).toEqual({ v: 1, outcome: 'refused', reason });
      expect(mailFor(sent.requestId)).toEqual([]);
      expect(acceptedFor(sent.requestId)).toEqual([]);
    }
  }, 60_000);

  it('with the terminal lock held by an interrupt still writing, answers held busy within 5 s; delivers once it frees', async () => {
    await render(agyTerminal, AGY_CLEAN);
    // agy is paced line by line (10 ms a line): 800 lines hold the terminal lock for ~8 s.
    // The interrupt route answers only once its write is complete, so `interrupted` is the
    // moment the lock freed.
    let interrupted = 0;
    const interrupt = towers.b
      .json('POST', '/api/send', {
        to: AGY_BUILDER,
        message: Array.from({ length: 800 }, (_, i) => `line ${i}`).join('\n'),
        from: 'architect',
        workspace: ws,
        fromWorkspace: ws,
        options: { interrupt: true },
      })
      .then((res) => {
        interrupted = Date.now();
        return res;
      });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const asked = Date.now();
    const sent = await forward(to({ workspace: 'codev', kind: 'id', name: AGY_BUILDER }));
    const answered = Date.now();
    expect(sent.answer).toEqual({ v: 1, outcome: 'held', reason: 'busy' });
    expect(answered - asked).toBeLessThan(5_000);
    expect(interrupted, 'the interrupt had finished before the answer: the lock was not held').toBe(0);

    expect((await interrupt).status).toBe(200);
    expect(mailFor(sent.requestId)).toMatchObject([{ status: 'held', reason: 'busy' }]);

    await render(agyTerminal, AGY_CLEAN);
    const delivered = await waitFor(async () => mailFor(sent.requestId)[0]?.status === 'delivered', 30_000, 200);
    expect(delivered, JSON.stringify(mailFor(sent.requestId))).toBe(true);
  }, 90_000);

  it('records every answer without its body', () => {
    const records = towers.b.readDb((db) => db.prepare("SELECT * FROM peer_records WHERE direction = 'inbound'").all() as Array<{ outcome: string; reason: string | null }>);
    expect(records.map((r) => `${r.outcome}${r.reason ? ` ${r.reason}` : ''}`)).toEqual(
      expect.arrayContaining(['refused no-grant', 'held no-profile', 'delivered', 'refused not-addressable', 'held busy', 'not-verified']),
    );
    expect(JSON.stringify(records)).not.toContain(BODY);
    expect([...towers.a.output, ...towers.b.output].join('')).not.toContain(BODY);
  });

  it('stops both Towers leaving no process, socket or directory behind', async () => {
    expect(await towers.stop()).toEqual({ processes: [], shellpers: [], paths: [], relayListening: false });
  }, 120_000);
});
