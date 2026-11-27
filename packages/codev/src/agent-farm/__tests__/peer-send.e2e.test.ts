/**
 * `afx send` across Towers, end to end (Spec 1967, plan phase 9, layer B).
 *
 * Two built Towers on the stand-in relay over loopback: Tower a (`mbp`) and Tower b
 * (`devvm`), on one account, each with a `codev` workspace. Every send is the real path:
 * the CLI's own `send` command run in this process as the agent in question (or, where a
 * case needs many sends at once, Tower's `POST /api/send` as the CLI calls it), Tower a's
 * route, its sender and outbox, the stand-in's relay, Tower b's receiver and mailbox.
 *
 * What is proven, in the plan's order:
 *
 * - the headline path in both directions, delivered through the real gate: each direction
 *   needs its own grant, and the reply command printed in the footer, sent unchanged, is
 *   delivered to the sender;
 * - a message for an offline peer is held at the sender, never in its mailbox (so neither
 *   the local drainer nor escalation touches it), and delivered once when the peer returns;
 * - order, and one message call at a time per peer under twenty concurrent sends;
 * - failures in flight (a lost answer, a stream reset, no answer, a deploy, a session that
 *   has just reconnected): the message arrives once;
 * - a refusal on retry ends refused; mixed versions refuse and hold nothing;
 * - the remote-only refusals, the names (`afx://<own slug>/…`, `afx://owner@…`), an
 *   explicitly named workspace, the waiting cap, a sender whose tunnel is down;
 * - a restart of the sending Tower with three messages waiting;
 * - every refusal exits non-zero through the CLI.
 *
 * The headline path is delivered through the real render gate, both ways: each Tower has a
 * `live` workspace whose architects run an echo program named `claude` (`stty raw -echo;
 * exec cat`), so the gate resolves claude's profile from the launch command, and the test
 * draws a clean claude composer before each send, as `send-integration.e2e.test.ts` does.
 * Everywhere else the architects are inert terminals, so the render gate holds what reaches
 * them as `no-profile`: the receiving Tower has accepted it, and the frame it would type is
 * on record in its mailbox, as `cross-workspace-addressing.e2e.test.ts` reads it. Two cases
 * need a receiving Tower that takes longer than the relay to answer; for those the
 * recipient is an echo terminal named `agy`, whose writes are paced line by line, given a
 * long body, and the stand-in's relay timeout is 3 seconds (the contract's is 15), shorter
 * than the receiving Tower's 5-second deadline.
 *
 * The stand-in's limits and each Tower's own per-peer limit are raised, so the number of
 * messages this file sends in a minute is never what decides an answer; the sending
 * Tower's waiting cap is left at its default of 50.
 *
 * On demand, after `pnpm build`, never in porch's tests check:
 *
 *   pnpm exec vitest run --config vitest.e2e.config.ts \
 *     src/agent-farm/__tests__/peer-send.e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RingBuffer } from '../../terminal/ring-buffer.js';
import {
  INERT_SCRIPT,
  makeWorkspace,
  runCli,
  startTwoTowers,
  writeInertAgent,
  type CliAgent,
  type HarnessTower,
  type TwoTowers,
} from './helpers/two-towers.js';
import { encodeWorkspacePath, waitFor } from './helpers/tower-test-utils.js';

vi.mock('../lib/tower-client.js', async (importOriginal) =>
  (await import('./helpers/two-towers.js')).towerClientModuleFor(await importOriginal()),
);
vi.mock('../db/index.js', async (importOriginal) =>
  (await import('./helpers/two-towers.js')).dbModuleFor(await importOriginal()),
);

const { send } = await import('../commands/send.js');
const { workspaceName } = await import('../commands/workspace-name.js');

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
const REPLY = 'Thanks, merging now';
const TO_B = 'afx://devvm/codev:architect';
const AGY_BUILDER = 'builder-spir-778';
const A_BUILDER = 'builder-spir-901';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
/** An 800-line body: about 8 seconds on the wire to agy, past the receiving Tower's deadline. */
const LONG = Array.from({ length: 800 }, (_, i) => `line ${i}`).join('\n');

interface OutboxRow {
  seq: number;
  message_id: string;
  peer_tower_id: string;
  state: string;
  last_outcome: string | null;
  last_reason: string | null;
  attempts: number;
}

interface MailRow {
  n: number;
  id: string;
  workspace_path: string;
  to_agent: string;
  status: string;
  reason: string | null;
  formatted_message: string;
  remote_tower_id: string | null;
  remote_message_id: string | null;
}

interface SendAnswer {
  ok?: boolean;
  error?: string;
  message?: string;
  reason?: string | null;
  mailboxId?: string;
  delivered?: boolean;
  held?: boolean;
  remote?: { peer: string; heldWhere?: string; ahead?: number; duplicate?: boolean };
  refusedBy?: string;
}

describe('Spec 1967 phase 9: afx send across Towers, end to end', () => {
  let towers: TwoTowers;
  let a: HarnessTower;
  let b: HarnessTower;
  let wsA: string;
  let wsB: string;
  let notesB: string;
  /** `<root>/a/live` and `<root>/b/live`: workspaces whose architects the gate delivers to. */
  let liveA: string;
  let liveB: string;
  let builderWorktree: string;
  let agyTerminal: string;

  const aMain = (): CliAgent => ({ cwd: wsA, architect: 'main' });
  const bMain = (): CliAgent => ({ cwd: wsB, architect: 'main' });

  const outbox = (): OutboxRow[] =>
    a.readDb((db) => db.prepare('SELECT * FROM peer_outbox ORDER BY seq').all() as OutboxRow[]);
  const outboxRow = (id: string) => outbox().find((row) => row.message_id === id);
  const heldForB = () => outbox().filter((row) => row.peer_tower_id === b.towerId && row.state === 'held');
  const mailOn = (tower: HarnessTower): MailRow[] =>
    tower.readDb((db) => db.prepare('SELECT rowid AS n, * FROM mailbox ORDER BY rowid').all() as MailRow[]);
  const remoteMail = (tower: HarnessTower) => mailOn(tower).filter((row) => row.remote_tower_id !== null);
  const mailFor = (tower: HarnessTower, id: string) => remoteMail(tower).filter((row) => row.remote_message_id === id);
  const acceptedOn = (tower: HarnessTower, id: string) =>
    tower.readDb((db) => db.prepare('SELECT * FROM peer_accepted WHERE message_id = ?').all(id));
  const relayCalls = (id?: string) =>
    towers.relay.calls.filter((call) => call.route === 'relay' && (id === undefined || call.requestId === id));
  const forwardsFor = (id: string) => towers.relay.forwards.filter((forward) => forward.statement?.requestId === id);

  /** Until the outbox row is resolved as `state`. */
  const resolved = async (id: string, state: 'accepted' | 'refused' = 'accepted', timeoutMs = 30_000) => {
    const ok = await waitFor(async () => outboxRow(id)?.state === state, timeoutMs, 100);
    expect(ok, `${id}: ${JSON.stringify(outboxRow(id))}`).toBe(true);
  };

  /** `POST /api/send` on Tower a, as the CLI calls it, from one of its codev architects. */
  const sendFromA = (from: string, to: string, message = BODY, options?: Record<string, unknown>) =>
    a.json<SendAnswer>('POST', '/api/send', {
      to,
      message,
      from,
      workspace: wsA,
      fromWorkspace: wsA,
      ...(options ? { options } : {}),
    });

  const grant = async (tower: HarnessTower, peer: string) => {
    const res = await tower.json('POST', '/api/peer/grants', { tower: peer, all: true, humanApproved: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  };

  /** What Tower a's peer list says of its cloud's relay. */
  const relayState = async () =>
    (await a.json<{ relay: { state: string } }>('GET', '/api/peer/towers')).body.relay.state;

  const render = async (terminalId: string, screen: string, tower: HarnessTower = b) => {
    const res = await tower.fetch(`/api/terminals/${terminalId}/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: screen }),
    });
    expect(res.ok).toBe(true);
    // Past the input settle (#1473): the write route is an external writer.
    await new Promise((resolve) => setTimeout(resolve, 600));
  };

  /** The terminal of a running workspace's `main` architect, from its dashboard state. */
  const mainArchitectTerminal = async (tower: HarnessTower, workspacePath: string): Promise<string> => {
    const state = await tower.json<{ architects: Array<{ name: string; terminalId?: string }> }>(
      'GET',
      `/workspace/${encodeWorkspacePath(workspacePath)}/api/state`,
    );
    const terminalId = state.body.architects.find((architect) => architect.name === 'main')?.terminalId;
    if (!terminalId) throw new Error(`no main architect terminal in ${workspacePath}: ${JSON.stringify(state.body.architects)}`);
    return terminalId;
  };

  beforeAll(async () => {
    towers = await startTwoTowers({
      relay: {
        relayTimeoutMs: 3_000,
        limits: {
          messagesPerTowerPerMinute: 10_000,
          messagesPerPairPerMinute: 10_000,
          listingPerTowerPerMinute: 10_000,
          statePerTowerPerMinute: 10_000,
          peerRoutesPerTowerPerMinute: 100_000,
        },
      },
    });
    ({ a, b } = towers);
    // Each Tower reads its peer settings from its own home on every call.
    for (const tower of [a, b]) {
      mkdirSync(join(tower.home, '.codev'), { recursive: true });
      writeFileSync(join(tower.home, '.codev', 'config.json'), JSON.stringify({ peer: { limits: { acceptedPerPeerPerMinute: 10_000 } } }));
    }

    const inert = writeInertAgent(towers.root);
    wsA = makeWorkspace(join(towers.root, 'a', 'codev'), inert);
    wsB = makeWorkspace(join(towers.root, 'b', 'codev'), inert);
    // A directory name with a space is not an address name: this workspace is reached only
    // by the name it is given.
    notesB = makeWorkspace(join(towers.root, 'b', 'Team Notes'), inert);
    // An architect command is split on whitespace and given further arguments by Tower:
    // one executable named claude that ignores them.
    const echoDir = join(towers.root, 'claude-echo');
    mkdirSync(echoDir, { recursive: true });
    const claudeEcho = join(echoDir, 'claude');
    writeFileSync(claudeEcho, '#!/bin/sh\nstty raw -echo 2>/dev/null; exec cat\n', { mode: 0o755 });
    liveA = makeWorkspace(join(towers.root, 'a', 'live'), claudeEcho);
    liveB = makeWorkspace(join(towers.root, 'b', 'live'), claudeEcho);
    await a.activate(wsA);
    await a.activate(liveA);
    await b.activate(wsB);
    await b.activate(notesB);
    await b.activate(liveB);
    await a.addArchitect(wsA, 'review');
    builderWorktree = await a.addBuilder(wsA, A_BUILDER, 'spir-901', 'main');

    for (const tower of [a, b]) {
      const on = await tower.json('PUT', '/api/peer/switch', { state: 'on', humanApproved: true });
      expect(on.status, JSON.stringify(on.body)).toBe(200);
    }

    // On b: a shell, and a builder whose terminal echoes and is named agy (phase 6's).
    const shell = await b.json('POST', '/api/terminals', {
      command: '/bin/sh',
      args: ['-c', INERT_SCRIPT],
      cwd: wsB,
      cols: 80,
      rows: 24,
      workspacePath: wsB,
      type: 'shell',
      roleId: 'shell-1',
      persistent: true,
    });
    expect(shell.status).toBe(201);
    const dir = join(wsB, '.builders', AGY_BUILDER);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agy'), '#!/bin/sh\nstty raw -echo 2>/dev/null; exec cat\n', { mode: 0o755 });
    const agy = await b.json<{ id: string }>('POST', '/api/terminals', {
      command: join(dir, 'agy'),
      args: [],
      cwd: dir,
      cols: 110,
      rows: 32,
      workspacePath: wsB,
      type: 'builder',
      roleId: AGY_BUILDER,
      persistent: true,
    });
    expect(agy.status).toBe(201);
    agyTerminal = agy.body.id;
  }, 240_000);

  afterAll(async () => {
    await towers?.stop();
  }, 120_000);

  // -------------------------------------------------------------------------
  // The headline path
  // -------------------------------------------------------------------------

  it('the headline path, in both directions: each needs its own grant, and the footer reply is delivered to the sender', async () => {
    const liveMainA: CliAgent = { cwd: liveA, architect: 'main' };
    const liveMainB: CliAgent = { cwd: liveB, architect: 'main' };
    const delivered = (tower: HarnessTower, workspacePath: string) =>
      remoteMail(tower).filter((row) => row.workspace_path === workspacePath && row.status === 'delivered');

    // mbp → devvm, before devvm grants anything: refused there, exiting non-zero.
    const before = await runCli(a, liveMainA, () => send({ builder: 'afx://devvm/live:architect', message: BODY }));
    expect(before.exitCode).toBe(1);
    expect(before.stderr).toEqual([
      '[error] Refused by devvm: mbp has no grant there for live:architect. On devvm: afx peer grant mbp live:architect',
    ]);
    expect(remoteMail(b)).toEqual([]);

    // With the grant, and devvm's architect at a clean prompt: delivered through the gate.
    await grant(b, 'mbp');
    await render(await mainArchitectTerminal(b, liveB), CLAUDE_CLEAN, b);
    const sent = await runCli(a, liveMainA, () => send({ builder: 'afx://devvm/live:architect', message: BODY }));
    expect(sent.exitCode, JSON.stringify(sent)).toBeNull();
    expect(sent.result).toBe('delivered');
    expect(sent.stdout.at(-1)).toBe(`[ok] Message delivered to afx://devvm/live:architect (${Buffer.byteLength(BODY)} bytes)`);

    const [arrived] = delivered(b, liveB);
    expect(arrived).toMatchObject({ to_agent: 'main', remote_tower_id: a.towerId });
    expect(outboxRow(arrived.remote_message_id!)).toMatchObject({ state: 'accepted', last_outcome: 'delivered', attempts: 1 });
    const frame = arrived.formatted_message.split('\n');
    expect(frame[0]).toMatch(/^### \[REMOTE, your Tower · afx:\/\/mbp\/live:architect:main → main \| \S+Z\] ###$/);
    expect(frame[1]).toBe(BODY);
    // An architect recipient may send to any agent: the reply names the sender itself
    // (Decision 7). A builder's footer names the front door (phase 6's case).
    expect(frame[2]).toBe('###############################  (reply: afx send afx://mbp/live:architect:main "…")');

    // devvm → mbp with the footer's command as printed: refused until mbp grants devvm.
    const replyTo = /\(reply: afx send (\S+) "…"\)$/.exec(frame[2])![1];
    const refused = await runCli(b, liveMainB, () => send({ builder: replyTo, message: REPLY }));
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toEqual([
      '[error] Refused by mbp: devvm has no grant there for live:architect:main. On mbp: afx peer grant devvm live:architect:main',
    ]);

    await grant(a, 'devvm');
    await render(await mainArchitectTerminal(a, liveA), CLAUDE_CLEAN, a);
    const replied = await runCli(b, liveMainB, () => send({ builder: replyTo, message: REPLY }));
    expect(replied.exitCode, JSON.stringify(replied)).toBeNull();
    expect(replied.result).toBe('delivered');
    expect(replied.stdout.at(-1)).toBe(`[ok] Message delivered to ${replyTo} (${Buffer.byteLength(REPLY)} bytes)`);
    const [back] = delivered(a, liveA);
    expect(back).toMatchObject({ to_agent: 'main', remote_tower_id: b.towerId });
    expect(back.formatted_message.split('\n')).toEqual([
      expect.stringMatching(/^### \[REMOTE, your Tower · afx:\/\/devvm\/live:architect:main → main \| \S+Z\] ###$/),
      REPLY,
      '###############################  (reply: afx send afx://devvm/live:architect:main "…")',
    ]);
  }, 120_000);

  it('a workspace reached by the name it was given: afx://devvm/<name>:architect', async () => {
    const named = await runCli(b, { cwd: notesB, architect: 'main' }, () => workspaceName({ name: 'notes' }));
    expect(named.exitCode, JSON.stringify(named)).toBeNull();

    const sent = await runCli(a, aMain(), () => send({ builder: 'afx://devvm/notes:architect', message: 'For the notes workspace' }));
    expect(sent.exitCode, JSON.stringify(sent)).toBeNull();
    const id = UUID.exec(sent.stdout.at(-1)!)![0];
    expect(mailFor(b, id)).toMatchObject([{ workspace_path: notesB, to_agent: 'main', status: 'held' }]);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Names and the remote-only refusals
  // -------------------------------------------------------------------------

  it("afx://<own slug>/… resolves on this Tower, with no call; afx://owner@… is refused, exiting non-zero", async () => {
    const calls = relayCalls().length;
    const own = await runCli(a, aMain(), () => send({ builder: 'afx://mbp/codev:architect:review', message: 'To myself, the long way' }));
    expect(own.exitCode, JSON.stringify(own)).toBeNull();
    expect(mailOn(a).at(-1)).toMatchObject({ workspace_path: wsA, to_agent: 'review', remote_tower_id: null });

    const owner = await runCli(a, aMain(), () => send({ builder: 'afx://sam@devvm/codev:architect', message: BODY }));
    expect(owner.exitCode).toBe(1);
    expect(owner.stderr).toEqual([
      "[error] Messaging another owner's Tower is not available in this version. " +
        'Between your own Towers, write afx://<tower>/<workspace>:<agent>.',
    ]);
    expect(relayCalls()).toHaveLength(calls);
  }, 60_000);

  it('the four options are refused for a recipient on another Tower, with no call and nothing stored', async () => {
    const calls = relayCalls().length;
    const stored = outbox().length;
    for (const [flag, options] of [
      ['--raw', { raw: true }],
      ['--interrupt', { interrupt: true }],
      ['--no-enter', { noEnter: true }],
      ['--delay', { delay: 30 }],
    ] as const) {
      const run = await runCli(a, aMain(), () => send({ builder: TO_B, message: BODY, ...options }));
      expect(run.exitCode, flag).toBe(1);
      expect(run.stderr, flag).toEqual([`[error] ${flag} cannot be used for a recipient on another Tower.`]);
    }
    expect(relayCalls()).toHaveLength(calls);
    expect(outbox()).toHaveLength(stored);
  }, 60_000);

  it("a builder naming another Tower's architect is refused with no call; a shell on another Tower is refused there", async () => {
    const calls = relayCalls().length;
    const builder = await runCli(a, { cwd: builderWorktree }, () => send({ builder: 'afx://devvm/codev:architect:main', message: BODY }));
    expect(builder.exitCode).toBe(1);
    expect(builder.stderr).toEqual([
      `[error] builder ${A_BUILDER} may only address its own spawning architect; ` +
        'reach that workspace through its front door: afx send afx://devvm/codev:architect "…"',
    ]);
    expect(relayCalls()).toHaveLength(calls);

    const shell = await runCli(a, aMain(), () => send({ builder: 'afx://devvm/codev:shell-1', message: BODY }));
    expect(shell.exitCode).toBe(1);
    expect(shell.stderr).toEqual(['[error] Refused by devvm: codev:shell-1 cannot be messaged from another Tower (a shell never can).']);
    expect(remoteMail(b).filter((row) => row.to_agent === 'shell-1')).toEqual([]);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Offline, order, concurrency
  // -------------------------------------------------------------------------

  it('offline, then online: held at the sender, never in its mailbox, then delivered once', async () => {
    towers.relay.setOffline(b.towerId, true);
    const mailBefore = mailOn(a).length;
    const sent = await runCli(a, aMain(), () => send({ builder: TO_B, message: 'Sent while devvm sleeps' }));
    expect(sent.exitCode, JSON.stringify(sent)).toBeNull();
    expect(sent.result).toBe('held');
    const line = sent.stdout.at(-1)!;
    expect(line).toMatch(new RegExp(`^\\[info\\] Message held on this Tower \\(tower-offline\\) — mailbox id ${UUID.source}\\. It is sent when devvm returns\\.$`));
    const id = UUID.exec(line)![0];

    // Retried while offline, and still held; nothing in the sender's mailbox, so the local
    // drainer never sees it and nothing escalates it.
    const retried = await waitFor(async () => (outboxRow(id)?.attempts ?? 0) >= 3, 15_000, 50);
    expect(retried, JSON.stringify(outboxRow(id))).toBe(true);
    expect(outboxRow(id)).toMatchObject({ state: 'held', last_reason: 'tower-offline' });
    expect(mailOn(a)).toHaveLength(mailBefore);
    expect(mailFor(b, id)).toEqual([]);

    towers.relay.setOffline(b.towerId, false);
    await resolved(id);
    expect(mailFor(b, id)).toHaveLength(1);
    expect(acceptedOn(b, id)).toHaveLength(1);
    expect(relayCalls(id).filter((call) => call.status === 200)).toHaveLength(1);
    expect(mailOn(a)).toHaveLength(mailBefore);
  }, 90_000);

  it('order: three to an offline peer arrive in order, and a fourth sent as it returns arrives after them', async () => {
    towers.relay.setOffline(b.towerId, true);
    const ids: string[] = [];
    for (const [i, text] of ['first', 'second', 'third'].entries()) {
      const res = await sendFromA('architect:main', TO_B, `In order: ${text}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ held: true, reason: 'tower-offline', remote: { peer: 'devvm', heldWhere: 'this-tower', ahead: i } });
      ids.push(res.body.mailboxId!);
    }
    towers.relay.setOffline(b.towerId, false);
    const fourth = await sendFromA('architect:main', TO_B, 'In order: fourth');
    expect(fourth.status, JSON.stringify(fourth.body)).toBe(200);
    ids.push(fourth.body.mailboxId!);

    for (const id of ids) await resolved(id);
    const arrived = remoteMail(b).filter((row) => ids.includes(row.remote_message_id!));
    expect(arrived.map((row) => row.remote_message_id)).toEqual(ids);
  }, 90_000);

  it('twenty concurrent sends by two agents arrive in acceptance order, one message call at a time', async () => {
    towers.relay.injectFault({ kind: 'answer-delay', ms: 40, to: b.towerId });
    towers.relay.resetInFlight();
    try {
      const answers = await Promise.all(
        Array.from({ length: 20 }, (_, i) => sendFromA(i % 2 === 0 ? 'architect:main' : 'architect:review', TO_B, `Concurrent ${i}`)),
      );
      for (const answer of answers) expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      const ids = answers.map((answer) => answer.body.mailboxId!);
      for (const id of ids) await resolved(id);

      const acceptance = outbox().filter((row) => ids.includes(row.message_id)).map((row) => row.message_id);
      expect(acceptance).toHaveLength(20);
      const arrival = remoteMail(b).filter((row) => ids.includes(row.remote_message_id!)).map((row) => row.remote_message_id);
      expect(arrival).toEqual(acceptance);
      expect(towers.relay.inFlight(a.towerId, b.towerId).max).toBe(1);
    } finally {
      towers.relay.clearFaults();
    }
  }, 120_000);

  // -------------------------------------------------------------------------
  // Failures in flight
  // -------------------------------------------------------------------------

  describe('failures in flight: the message arrives once', () => {
    it('a lost answer: the receiving Tower acted, the cloud answered no-answer; the retry is a duplicate', async () => {
      towers.relay.injectFault({ kind: 'answer-late', to: b.towerId }, 1);
      const sent = await sendFromA('architect:main', TO_B, 'Its answer is lost');
      expect(sent.body).toMatchObject({ held: true, reason: 'no-answer', remote: { heldWhere: 'this-tower' } });
      const id = sent.body.mailboxId!;
      await resolved(id);
      expect(relayCalls(id).map((call) => call.status)).toEqual([504, 200]);
      expect(JSON.parse(forwardsFor(id)[1].answer!.body.toString('utf8'))).toMatchObject({ duplicate: true });
      expect(mailFor(b, id)).toHaveLength(1);
      expect(acceptedOn(b, id)).toHaveLength(1);
    }, 60_000);

    it('a stream reset before the answer is complete', async () => {
      towers.relay.injectFault({ kind: 'reset-stream', to: b.towerId }, 1);
      const sent = await sendFromA('architect:main', TO_B, 'Its stream is reset');
      expect(sent.body).toMatchObject({ held: true, reason: 'no-answer' });
      const id = sent.body.mailboxId!;
      await resolved(id);
      expect(relayCalls(id).map((call) => call.status)).toEqual([504, 200]);
      expect(mailFor(b, id)).toHaveLength(1);
    }, 60_000);

    it('no answer: the receiving Tower is still writing when the relay times out', async () => {
      await render(agyTerminal, AGY_CLEAN);
      const asked = Date.now();
      const sent = await sendFromA('architect:main', `afx://devvm/codev:${AGY_BUILDER}`, LONG);
      expect(sent.body).toMatchObject({ held: true, reason: 'no-answer', remote: { heldWhere: 'this-tower' } });
      // The stand-in's relay timeout, not the receiving Tower's deadline.
      expect(Date.now() - asked).toBeLessThan(4_900);
      const id = sent.body.mailboxId!;
      await resolved(id, 'accepted', 60_000);
      const delivered = await waitFor(async () => mailFor(b, id)[0]?.status === 'delivered', 30_000, 200);
      expect(delivered, JSON.stringify(mailFor(b, id))).toBe(true);
      expect(mailFor(b, id)).toHaveLength(1);
      expect(acceptedOn(b, id)).toHaveLength(1);
    }, 120_000);

    it('a deploy mid-send: the tunnels drop and the secrets change; the retry is a new statement for the same message', async () => {
      await render(agyTerminal, AGY_CLEAN);
      const sessionBefore = towers.relay.session(b.towerId)!.seq;
      const sending = sendFromA('architect:main', `afx://devvm/codev:${AGY_BUILDER}`, LONG);
      const inFlight = await waitFor(async () => towers.relay.inFlight(a.towerId, b.towerId).now === 1, 10_000, 10);
      expect(inFlight).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      towers.relay.deploy();

      const sent = await sending;
      expect(sent.body).toMatchObject({ held: true, remote: { heldWhere: 'this-tower' } });
      const id = sent.body.mailboxId!;
      await a.waitForTunnel();
      await b.waitForTunnel();
      await resolved(id, 'accepted', 60_000);

      const forwards = forwardsFor(id);
      expect(forwards[0].sessionSeq).toBe(sessionBefore);
      expect(forwards.at(-1)!.sessionSeq).toBeGreaterThan(sessionBefore);
      expect(new Set(forwards.map((forward) => forward.statement!.statementId)).size).toBe(forwards.length);
      expect(new Set(forwards.map((forward) => forward.payload.toString('base64'))).size).toBe(1);
      const delivered = await waitFor(async () => mailFor(b, id)[0]?.status === 'delivered', 30_000, 200);
      expect(delivered, JSON.stringify(mailFor(b, id))).toBe(true);
      expect(mailFor(b, id)).toHaveLength(1);
      expect(acceptedOn(b, id)).toHaveLength(1);
    }, 150_000);

    it('a session that has just reconnected', async () => {
      const before = towers.relay.session(b.towerId)!.seq;
      towers.relay.dropTunnels(b.towerId);
      const back = await waitFor(async () => (towers.relay.session(b.towerId)?.seq ?? before) > before, 30_000, 5);
      expect(back).toBe(true);
      const sent = await sendFromA('architect:main', TO_B, 'Sent as devvm reconnects');
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      const id = sent.body.mailboxId!;
      await resolved(id);
      expect(forwardsFor(id).at(-1)!.sessionSeq).toBe(towers.relay.session(b.towerId)!.seq);
      expect(mailFor(b, id)).toHaveLength(1);
      expect(acceptedOn(b, id)).toHaveLength(1);
      await b.waitForTunnel();
    }, 90_000);
  });

  // -------------------------------------------------------------------------
  // Refusals on retry, mixed versions, the tunnel down
  // -------------------------------------------------------------------------

  it('a message refused on retry, its grant removed meanwhile, ends refused', async () => {
    towers.relay.setOffline(b.towerId, true);
    const sent = await sendFromA('architect:main', TO_B, 'Its grant goes while it waits');
    expect(sent.body).toMatchObject({ held: true, reason: 'tower-offline' });
    const id = sent.body.mailboxId!;
    const revoked = await b.json('POST', '/api/peer/grants/revoke', { tower: 'mbp' });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    towers.relay.setOffline(b.towerId, false);

    await resolved(id, 'refused');
    expect(outboxRow(id)).toMatchObject({ last_outcome: 'refused', last_reason: 'no-grant' });
    expect(mailFor(b, id)).toEqual([]);
    await grant(b, 'mbp');
  }, 60_000);

  it('a sender whose own tunnel is down still sends', async () => {
    const handshakes = () => towers.relay.handshakes.filter((h) => h.towerId === a.towerId);
    const before = handshakes().length;
    towers.relay.dropTunnels(a.towerId);
    const down = await waitFor(async () => (await a.tunnelStatus()).state !== 'connected', 10_000, 20);
    expect(down).toBe(true);

    const sent = await sendFromA('architect:main', TO_B, 'Sent with my own tunnel down');
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body).toMatchObject({ held: true, reason: 'no-profile', remote: { heldWhere: 'recipient' } });
    const [call] = relayCalls(sent.body.mailboxId!);

    await a.waitForTunnel();
    // The call was made before the tunnel came back: no auth from a had arrived since the drop.
    const reconnect = handshakes()[before];
    expect(reconnect).toBeDefined();
    expect(call.at).toBeLessThan(reconnect.at);
  }, 60_000);

  it('mixed versions: a peer that does not speak the protocol, and a cloud with no relay, are refused and not held', async () => {
    const held = heldForB().length;
    towers.relay.setStatesNoVersion(b.towerId, true);
    try {
      const run = await runCli(a, aMain(), () => send({ builder: TO_B, message: 'To a Tower too old' }));
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toEqual(['[error] Refused by Codev Cloud: devvm does not speak remote messaging. Upgrade Codev on devvm.']);
      expect(heldForB()).toHaveLength(held);
    } finally {
      towers.relay.setStatesNoVersion(b.towerId, false);
    }

    try {
      for (const mode of ['null', 'absent'] as const) {
        towers.relay.setMode(mode);
        towers.relay.dropTunnels(a.towerId);
        await a.waitForTunnel();
        expect(await relayState(), mode).toBe('none');
        const calls = relayCalls().length;
        const run = await runCli(a, aMain(), () => send({ builder: TO_B, message: 'Through a cloud with no relay' }));
        expect(run.exitCode, mode).toBe(1);
        expect(run.stderr, mode).toEqual(['[error] This Codev Cloud has no relay: a message cannot reach another Tower through it.']);
        expect(relayCalls(), mode).toHaveLength(calls);
        expect(heldForB(), mode).toHaveLength(held);
      }
    } finally {
      towers.relay.setMode('relay');
      towers.relay.dropTunnels(a.towerId);
      await a.waitForTunnel();
    }
    expect(await relayState()).toBe('available');
    const again = await sendFromA('architect:main', TO_B, 'Through a relay again');
    expect(again.body).toMatchObject({ held: true, remote: { heldWhere: 'recipient' } });
  }, 120_000);

  // -------------------------------------------------------------------------
  // A restart of the sending Tower, and the waiting cap
  // -------------------------------------------------------------------------

  it('the sending Tower restarts with three waiting: they resume in order, each accepted once', async () => {
    towers.relay.setOffline(b.towerId, true);
    const ids: string[] = [];
    for (const text of ['one', 'two', 'three']) {
      const res = await sendFromA('architect:main', TO_B, `Across a restart: ${text}`);
      expect(res.body).toMatchObject({ held: true, reason: 'tower-offline' });
      ids.push(res.body.mailboxId!);
    }

    await a.restart();
    await a.waitForTunnel();
    // Its terminals went with the restart (temp-dir workspaces); its mail did not.
    await a.activate(wsA);
    expect(ids.map((id) => outboxRow(id)?.state)).toEqual(['held', 'held', 'held']);

    towers.relay.resetInFlight();
    towers.relay.setOffline(b.towerId, false);
    for (const id of ids) await resolved(id);
    const arrived = remoteMail(b).filter((row) => ids.includes(row.remote_message_id!));
    expect(arrived.map((row) => row.remote_message_id)).toEqual(ids);
    for (const id of ids) {
      expect(acceptedOn(b, id), id).toHaveLength(1);
      expect(relayCalls(id).filter((call) => call.status === 200), id).toHaveLength(1);
    }
    expect(towers.relay.inFlight(a.towerId, b.towerId).max).toBe(1);
  }, 120_000);

  it('with 50 waiting for a peer, the next send is refused, exiting non-zero, and stores nothing', async () => {
    towers.relay.setOffline(b.towerId, true);
    const already = heldForB().length;
    for (let i = already; i < 50; i++) {
      const res = await sendFromA('architect:main', TO_B, `Waiting ${i}`);
      expect(res.body, String(i)).toMatchObject({ held: true, remote: { heldWhere: 'this-tower' } });
    }
    expect(heldForB()).toHaveLength(50);
    const stored = outbox().length;

    const run = await runCli(a, aMain(), () => send({ builder: TO_B, message: 'One too many' }));
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toEqual([
      '[error] 50 messages already wait on this Tower for devvm, the most it holds for one Tower. See them with: afx inbox',
    ]);
    expect(outbox()).toHaveLength(stored);
  }, 120_000);

  it('records every send without its body', () => {
    const records = a.readDb(
      (db) => db.prepare("SELECT * FROM peer_records WHERE direction = 'outbound'").all() as Array<{ outcome: string; reason: string | null }>,
    );
    expect(records.map((r) => `${r.outcome}${r.reason ? ` ${r.reason}` : ''}`)).toEqual(
      expect.arrayContaining(['refused no-grant', 'refused option-not-allowed', 'refused builder-rule', 'refused no-relay', 'refused rate-limited']),
    );
    expect(JSON.stringify(records)).not.toContain(BODY);
    expect([...a.output, ...b.output].join('')).not.toContain(BODY);
  });

  it('stops both Towers leaving no process, socket or directory behind', async () => {
    expect(await towers.stop()).toEqual({ processes: [], shellpers: [], paths: [], relayListening: false });
  }, 120_000);
});
