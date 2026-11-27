/**
 * The inbox, status and record surfaces on two real Towers (Spec 1967, plan phase 11, layer B).
 *
 * Two built Towers on the stand-in relay over loopback: Tower a (`mbp`) sends to Tower b
 * (`devvm`), which grants it everything, held for release. A set of sends leaves one message
 * of each kind:
 *
 * - on b, waiting for a local agent: a message to b's inert main architect, released by a
 *   human, which the gate then holds (`no-profile`);
 * - on b, held for release: a message to a builder whose terminal echoes;
 * - on a, waiting for a peer: a message sent while b was offline.
 *
 * Every command is the CLI's own, run in this process against one Tower or the other. What is
 * proven: `afx inbox` lists each kind in its own group, and only there, and never a body;
 * `afx inbox show` names a remote sender in full with its owner, and shows a message for a peer
 * with its body; `afx status` and the tower status show remote messaging; `afx inbox release`
 * needs the human flag and then delivers through the gate once the composer renders clean;
 * `afx inbox dismiss` stops a message waiting for a peer, which never reaches it even once it is
 * back, while the queue moves on; `afx peer list` shows the not-verifying mark while it is set
 * and drops it when it clears; and `afx peer log` shows a flood as counted lines, at both
 * ends, with no body in either Tower's output.
 *
 * On demand, after `pnpm build`, never in porch's tests check:
 *
 *   pnpm exec vitest run --config vitest.e2e.config.ts \
 *     src/agent-farm/__tests__/peer-surfaces.e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorkspace, runCli, startTwoTowers, writeInertAgent, type CliAgent, type CliRun, type HarnessTower, type TwoTowers } from './helpers/two-towers.js';
import { waitFor } from './helpers/tower-test-utils.js';

vi.mock('../lib/tower-client.js', async (importOriginal) =>
  (await import('./helpers/two-towers.js')).towerClientModuleFor(await importOriginal()),
);
vi.mock('../db/index.js', async (importOriginal) =>
  (await import('./helpers/two-towers.js')).dbModuleFor(await importOriginal()),
);

const { runAgentFarm } = await import('../cli.js');
const { renderRemoteMessagingLine, renderTowerRemoteMessaging } = await import('../commands/peer-status.js');
const { getTowerClient } = await import('../lib/tower-client.js');

const ESC = '\x1b';
const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`;
/** A clean claude composer: the marker and a dim placeholder only (send-integration.e2e). */
const CLAUDE_CLEAN = `${CLEAR_SCREEN}❯ ${ESC}[2mTry "fix the flaky test"${ESC}[0m\r\n${'─'.repeat(22)}\r\n`;

const BUILDER = 'builder-spir-1101';
const BODY = {
  atGate: 'surfaces: for a local agent 4c1e',
  forRelease: 'surfaces: held for release 9a2b',
  forPeer: 'surfaces: waiting for a peer 77d0',
};
const GROUPS = ['Waiting for a local agent', 'Held for release', 'Waiting for a peer'];

interface SendAnswer {
  mailboxId?: string;
  held?: boolean;
  reason?: string | null;
  refusedBy?: string;
  remote?: { peer: string; heldWhere?: string };
}

interface MailRow {
  id: string;
  status: string;
  reason: string | null;
  release_hold: number;
  remote_message_id: string | null;
}

/** Each group the CLI printed, from its header to the next one, by the group's title. */
function groupsOf(run: CliRun): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of run.stdout) {
    const title = GROUPS.find((group) => line.trim().startsWith(`${group} (`));
    if (title !== undefined) {
      current = [];
      groups.set(line.trim(), current);
    } else if (current !== null) {
      current.push(line);
    }
  }
  return groups;
}

/** The titles of the groups an id is listed in. */
function groupsListing(run: CliRun, id: string): string[] {
  return [...groupsOf(run)].filter(([, lines]) => lines.some((line) => line.includes(id))).map(([title]) => title);
}

/** The `×N` counts of the record lines that match `pattern`. */
function countedLines(run: CliRun, pattern: RegExp): number[] {
  return run.stdout.filter((line) => pattern.test(line)).map((line) => Number(/×(\d+)/.exec(line)?.[1] ?? '1'));
}

describe('Spec 1967 phase 11: the inbox, status and record surfaces on two Towers', () => {
  let towers: TwoTowers;
  let a: HarnessTower;
  let b: HarnessTower;
  let wsA: string;
  let wsB: string;
  let builderTerminal: string;
  /** Each message's id: on a, its message id; on b, its mailbox row's id. */
  const ids = { atGate: '', forRelease: '', forPeer: '' };

  const aMain = (): CliAgent => ({ cwd: wsA, architect: 'main' });
  const bMain = (): CliAgent => ({ cwd: wsB, architect: 'main' });
  const onA = (...args: string[]) => runCli(a, aMain(), () => runAgentFarm(args));
  const onB = (...args: string[]) => runCli(b, bMain(), () => runAgentFarm(args));

  const sendFromA = (to: string, message: string) =>
    a.json<SendAnswer>('POST', '/api/send', { to, message, from: 'architect:main', workspace: wsA, fromWorkspace: wsA });
  const mailOnB = (messageId: string): MailRow | undefined =>
    b.readDb((db) => db.prepare('SELECT * FROM mailbox WHERE remote_message_id = ?').get(messageId) as MailRow | undefined);
  const mailById = (id: string): MailRow =>
    b.readDb((db) => db.prepare('SELECT * FROM mailbox WHERE id = ?').get(id) as MailRow);
  const outboxState = (messageId: string): string | undefined =>
    a.readDb((db) => (db.prepare('SELECT state FROM peer_outbox WHERE message_id = ?').get(messageId) as { state: string } | undefined)?.state);
  const relayCallsFor = (messageId: string) => towers.relay.calls.filter((call) => call.route === 'relay' && call.requestId === messageId).length;
  const writePeerConfig = (tower: HarnessTower, acceptedPerPeerPerMinute: number) => {
    mkdirSync(join(tower.home, '.codev'), { recursive: true });
    writeFileSync(join(tower.home, '.codev', 'config.json'), JSON.stringify({ peer: { limits: { acceptedPerPeerPerMinute } } }));
  };

  /** Send from a's main architect, and wait until a's outbox has the peer's answer. */
  const sendAccepted = async (to: string, message: string): Promise<string> => {
    const sent = await sendFromA(to, message);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const id = sent.body.mailboxId!;
    expect(await waitFor(async () => outboxState(id) === 'accepted', 30_000, 50), `${id}: ${outboxState(id)}`).toBe(true);
    return id;
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
    for (const tower of [a, b]) writePeerConfig(tower, 10_000);

    const inert = writeInertAgent(towers.root);
    wsA = makeWorkspace(join(towers.root, 'a', 'codev'), inert);
    wsB = makeWorkspace(join(towers.root, 'b', 'codev'), inert);
    await a.activate(wsA);
    await b.activate(wsB);
    // On b, a builder whose terminal echoes, launched as claude: the gate delivers to it once
    // its composer renders clean (peer-receive.e2e's).
    const dir = join(wsB, '.builders', BUILDER);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.builder-start.sh'), '#!/bin/bash\nexec claude\n');
    const terminal = await b.json<{ id: string }>('POST', '/api/terminals', {
      command: 'sh',
      args: ['-c', 'stty raw -echo 2>/dev/null; exec cat'],
      cwd: dir,
      cols: 110,
      rows: 32,
      workspacePath: wsB,
      type: 'builder',
      roleId: BUILDER,
      persistent: true,
    });
    expect(terminal.status).toBe(201);
    builderTerminal = terminal.body.id;

    for (const tower of [a, b]) {
      const on = await tower.json('PUT', '/api/peer/switch', { state: 'on', humanApproved: true });
      expect(on.status, JSON.stringify(on.body)).toBe(200);
    }
    const granted = await b.json('POST', '/api/peer/grants', { tower: 'mbp', all: true, mode: 'hold', humanApproved: true });
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);

    // On b, waiting for a local agent: held for release, released by a human, then held by
    // the gate, as b's main architect has no agent profile.
    const atGate = await sendAccepted('afx://devvm/codev:architect:main', BODY.atGate);
    ids.atGate = mailOnB(atGate)!.id;
    const released = await b.json('POST', `/api/inbox/${ids.atGate}/release`, { humanApproved: true });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(await waitFor(async () => mailById(ids.atGate).reason === 'no-profile', 15_000, 50), JSON.stringify(mailById(ids.atGate))).toBe(true);

    // On b, held for release: a message to the builder.
    const forRelease = await sendAccepted(`afx://devvm/codev:${BUILDER}`, BODY.forRelease);
    ids.forRelease = mailOnB(forRelease)!.id;
    expect(mailById(ids.forRelease)).toMatchObject({ status: 'held', release_hold: 1 });

    // On a, waiting for a peer: sent while b is offline. b stays offline until the dismissal.
    towers.relay.setOffline(b.towerId, true);
    const forPeer = await sendFromA('afx://devvm/codev:architect:main', BODY.forPeer);
    expect(forPeer.body, JSON.stringify(forPeer.body)).toMatchObject({ held: true, reason: 'tower-offline', remote: { heldWhere: 'this-tower' } });
    ids.forPeer = forPeer.body.mailboxId!;
  }, 240_000);

  afterAll(async () => {
    await towers?.stop();
  }, 120_000);

  it('afx inbox lists each kind of held mail in its own group, and only there, and no body', async () => {
    const onBInbox = await onB('inbox');
    expect(onBInbox.exitCode, JSON.stringify(onBInbox)).toBeNull();
    expect([...groupsOf(onBInbox).keys()]).toEqual(['Waiting for a local agent (1)', 'Held for release (1)']);
    expect(groupsListing(onBInbox, ids.atGate)).toEqual(['Waiting for a local agent (1)']);
    expect(groupsListing(onBInbox, ids.forRelease)).toEqual(['Held for release (1)']);
    expect(onBInbox.stdout.join('\n')).toContain('afx://mbp/codev:architect:main (owner@example.com) → ' + BUILDER);

    const onAInbox = await onA('inbox');
    expect(onAInbox.exitCode, JSON.stringify(onAInbox)).toBeNull();
    expect([...groupsOf(onAInbox).keys()]).toEqual(['Waiting for a peer (1)']);
    const waiting = groupsOf(onAInbox).get('Waiting for a peer (1)')!.join('\n');
    expect(waiting).toContain(ids.forPeer);
    expect(waiting).toContain('tower-offline');
    // A peer that is offline pauses nothing: the queues run, and its next try is shown.
    expect(waiting).not.toContain('Not sent now');

    for (const body of Object.values(BODY)) {
      expect(onBInbox.stdout.join('\n')).not.toContain(body);
      expect(onAInbox.stdout.join('\n')).not.toContain(body);
    }
  }, 60_000);

  it("afx inbox show names a remote sender in full with its owner, and shows a message for a peer with its body", async () => {
    const shownOnB = (await onB('inbox', 'show', ids.forRelease)).stdout.join('\n');
    expect(shownOnB).toContain(`afx://mbp/codev:architect:main → ${BUILDER}`);
    expect(shownOnB).toContain('owner@example.com');
    expect(shownOnB).toContain(`afx inbox release ${ids.forRelease} --a-human-explicitly-approved-this`);
    expect(shownOnB).toContain(BODY.forRelease);

    const shownOnA = (await onA('inbox', 'show', ids.forPeer)).stdout.join('\n');
    expect(shownOnA).toContain('waiting for devvm (tower-offline)');
    expect(shownOnA).toContain('architect:main → afx://devvm/codev:architect:main');
    expect(shownOnA).toContain(BODY.forPeer);
  }, 60_000);

  it("the status line and the tower status show remote messaging on each Tower, with the workspace's counts", async () => {
    // `afx status`'s line, from each Tower's own overview of the workspace and its peer status.
    // (The whole `afx status` command is not run here: in this harness it does not find the
    // workspace active, since the temp directory's two spellings differ; see the thread.)
    const statusLine = async (tower: HarnessTower, agent: CliAgent, workspace: string) =>
      (
        await runCli(tower, agent, async () => {
          const client = getTowerClient();
          await renderRemoteMessagingLine(client, await client.getOverview(workspace));
        })
      ).stdout.join('\n');
    expect(await statusLine(a, aMain(), wsA)).toMatch(/Remote messaging:?\s+on · \d of 1 peers? online · 0 held for release · 1 waiting for a peer/);
    expect(await statusLine(b, bMain(), wsB)).toMatch(/Remote messaging:?\s+on · 1 of 1 peer online · 1 held for release · 0 waiting for a peer/);

    const tower = await runCli(a, aMain(), () => renderTowerRemoteMessaging(getTowerClient()));
    const printed = tower.stdout.join('\n');
    expect(printed).toMatch(/Name:?\s+mbp/);
    expect(printed).toMatch(/Remote messaging:?\s+on/);
  }, 60_000);

  it('afx inbox release needs the human flag; with it, the message is delivered through the gate once the composer renders clean', async () => {
    const refused = await onB('inbox', 'release', ids.forRelease);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr.join('\n')).toContain("Releasing a message is a human's decision.");
    expect(mailById(ids.forRelease)).toMatchObject({ status: 'held', release_hold: 1 });

    const released = await onB('inbox', 'release', ids.forRelease, '--a-human-explicitly-approved-this');
    expect(released.exitCode, JSON.stringify(released)).toBeNull();
    expect(released.stdout.join('\n')).toContain(`Released message ${ids.forRelease}`);
    expect(mailById(ids.forRelease).release_hold).toBe(0);

    const render = await b.fetch(`/api/terminals/${builderTerminal}/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: CLAUDE_CLEAN }),
    });
    expect(render.ok).toBe(true);
    const delivered = await waitFor(async () => mailById(ids.forRelease).status === 'delivered', 30_000, 200);
    expect(delivered, JSON.stringify(mailById(ids.forRelease))).toBe(true);

    // Delivered, it is held no longer: b lists only the message waiting for its main architect.
    expect([...groupsOf(await onB('inbox')).keys()]).toEqual(['Waiting for a local agent (1)']);
  }, 90_000);

  it('afx inbox dismiss stops a message waiting for a peer: it never reaches the peer once it is back, and the queue moves on', async () => {
    const callsBefore = relayCallsFor(ids.forPeer);
    const dismissed = await onA('inbox', 'dismiss', ids.forPeer);
    expect(dismissed.exitCode, JSON.stringify(dismissed)).toBeNull();
    expect(dismissed.stdout.join('\n')).toContain(`Dismissed message ${ids.forPeer} waiting for devvm: it will not be sent.`);
    expect(outboxState(ids.forPeer)).toBe('dismissed');

    towers.relay.setOffline(b.towerId, false);
    const after = await sendAccepted('afx://devvm/codev:architect:main', 'surfaces: sent after the dismissal');
    expect(mailOnB(after)).toBeDefined();
    expect(mailOnB(ids.forPeer)).toBeUndefined();
    expect(relayCallsFor(ids.forPeer)).toBe(callsBefore);
    expect([...groupsOf(await onA('inbox')).keys()]).toEqual([]);
  }, 90_000);

  it('afx peer list shows the not-verifying mark while it is set, and drops it when it clears', async () => {
    towers.relay.injectFault({ kind: 'wrong-secret', to: b.towerId });
    let id = '';
    try {
      const sent = await sendFromA('afx://devvm/codev:architect:main', 'surfaces: not verified at first');
      expect(sent.body, JSON.stringify(sent.body)).toMatchObject({ held: true, remote: { heldWhere: 'this-tower' } });
      id = sent.body.mailboxId!;
      const marked = await waitFor(
        async () => (await onA('peer', 'list')).stdout.some((line) => line.includes('! not verifying: its last')),
        30_000,
        200,
      );
      expect(marked).toBe(true);
      expect((await onA('peer', 'log', '--peer', 'devvm')).stdout[0]).toMatch(/^! devvm: not verifying/);
    } finally {
      towers.relay.clearFaults();
    }
    expect(await waitFor(async () => outboxState(id) === 'accepted', 30_000, 50)).toBe(true);
    const list = (await onA('peer', 'list')).stdout;
    expect(list.some((line) => line.includes('not verifying')), JSON.stringify(list)).toBe(false);
  }, 90_000);

  it("afx peer log shows a flood as counted lines at both ends, and no body in either Tower's output", async () => {
    // b accepts one message a minute from mbp now, which this file has most likely used already:
    // the flood is refused there for rate, and a fresh send so refused ends refused.
    writePeerConfig(b, 1);
    let refused = 0;
    try {
      for (let i = 0; i < 8; i++) {
        const sent = await sendFromA('afx://devvm/codev:architect:main', `surfaces: flood ${i}`);
        if (sent.body.reason === 'rate-limited') refused++;
      }
    } finally {
      writePeerConfig(b, 10_000);
    }
    expect(refused).toBeGreaterThanOrEqual(7);

    // A flood is counted, not stored: one line a minute for each Tower, or two if it crossed a
    // minute boundary, whose counts add up to the refusals.
    const logA = await onA('peer', 'log', '--peer', 'devvm', '--limit', '1000');
    const floodA = countedLines(logA, /^\S+ {2}out {2}request to devvm {2}refused \(rate-limited\) {2}×/);
    expect(floodA.length, JSON.stringify(logA.stdout)).toBeGreaterThanOrEqual(1);
    expect(floodA.length).toBeLessThanOrEqual(2);
    expect(floodA.reduce((sum, n) => sum + n, 0)).toBe(refused);

    const logB = await onB('peer', 'log', '--peer', 'mbp', '--limit', '1000');
    const floodB = countedLines(logB, /^\S+ {2}in {3}request from mbp {2}refused \(rate-limited\) {2}×/);
    expect(floodB.length, JSON.stringify(logB.stdout)).toBeGreaterThanOrEqual(1);
    expect(floodB.length).toBeLessThanOrEqual(2);
    expect(floodB.reduce((sum, n) => sum + n, 0)).toBe(refused);

    const everything = [...(await onA('peer', 'log', '--limit', '1000')).stdout, ...(await onB('peer', 'log', '--limit', '1000')).stdout].join('\n');
    for (const body of [...Object.values(BODY), 'surfaces: sent after the dismissal', 'surfaces: flood']) {
      expect(everything).not.toContain(body);
    }
  }, 120_000);
});
