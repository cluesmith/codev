/**
 * `afx peer show` across Towers, end to end (Spec 1967, plan phase 10, layer B).
 *
 * Two built Towers on the stand-in relay over loopback: Tower a (`mbp`) asks Tower b
 * (`devvm`) what runs there that a may message. Every query is the real path: the CLI's own
 * `afx peer show`, run in this process as a's main architect, a's route and sender, the
 * stand-in's relay, b's receiver and discovery over b's own workspaces and agents.
 *
 * b has a `codev` workspace with architects `main` and `local`, a builder and a shell, and
 * a `notes` workspace with its `main` architect. What is proven:
 *
 * - with no grant, the refusal names `no-grant` and the command that adds one, and exits 1;
 * - under each scope, exactly what it covers: one architect; a front door (the architect it
 *   reaches now); a workspace's architects; `--all`, every workspace's architects and
 *   builders by id, never the shell; a stopped workspace not at all (Spec 1940: "every
 *   active workspace"), as a message there is refused;
 * - every address printed is one `afx send` accepts, pasted as it is;
 * - an offline peer, and a peer whose switch is off, are refused, and nothing is held;
 * - a query is not queued behind messages: answered while a message to b is in flight;
 * - both Towers record every query.
 *
 * The stand-in's query limit is raised, so the number of queries this file makes in a
 * minute never decides an answer; b's own limit (10 answered a minute from one peer) is
 * proven on an injected clock in `peer-discovery.test.ts`, and this file stays under it.
 *
 * On demand, after `pnpm build`, never in porch's tests check:
 *
 *   pnpm exec vitest run --config vitest.e2e.config.ts \
 *     src/agent-farm/__tests__/peer-discovery.e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { INERT_SCRIPT, makeWorkspace, runCli, startTwoTowers, writeInertAgent, type HarnessTower, type TwoTowers } from './helpers/two-towers.js';
import { waitFor } from './helpers/tower-test-utils.js';

vi.mock('../lib/tower-client.js', async (importOriginal) =>
  (await import('./helpers/two-towers.js')).towerClientModuleFor(await importOriginal()),
);
vi.mock('../db/index.js', async (importOriginal) =>
  (await import('./helpers/two-towers.js')).dbModuleFor(await importOriginal()),
);

const { runAgentFarm } = await import('../cli.js');
// The column layout is pinned in peer-discovery.test.ts; here, which lines are printed.
const { shownLines } = await import('../commands/peer.js');
const lines = (...addresses: Array<[string, boolean]>) => shownLines(addresses.map(([address, live]) => ({ address, live })));

const BUILDER = 'builder-spir-1940';

interface RecordRow {
  direction: string;
  kind: string | null;
  peer_tower_id: string | null;
  message_id: string | null;
  to_address: string | null;
  payload_size: number | null;
  outcome: string;
  reason: string | null;
}

describe('Spec 1967 phase 10: afx peer show across Towers, end to end', () => {
  let towers: TwoTowers;
  let a: HarnessTower;
  let b: HarnessTower;
  let wsA: string;
  let wsB: string;
  let notesB: string;

  /** `afx peer show devvm`, as a's main architect, through the CLI's own command line. */
  const show = (tower = 'devvm') => runCli(a, { cwd: wsA, architect: 'main' }, () => runAgentFarm(['peer', 'show', tower]));

  const grant = async (recipients: Record<string, unknown>) => {
    const res = await b.json('POST', '/api/peer/grants', { tower: 'mbp', humanApproved: true, ...recipients });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  };

  const records = (tower: HarnessTower): RecordRow[] =>
    tower.readDb((db) => db.prepare("SELECT * FROM peer_records WHERE kind = 'query' ORDER BY id").all() as RecordRow[]);
  const outboxRows = () => a.readDb((db) => (db.prepare('SELECT COUNT(*) AS n FROM peer_outbox').get() as { n: number }).n);

  beforeAll(async () => {
    towers = await startTwoTowers({
      relay: {
        limits: {
          messagesPerTowerPerMinute: 10_000,
          messagesPerPairPerMinute: 10_000,
          queriesPerPairPerMinute: 10_000,
          listingPerTowerPerMinute: 10_000,
          statePerTowerPerMinute: 10_000,
          peerRoutesPerTowerPerMinute: 100_000,
        },
      },
    });
    ({ a, b } = towers);
    const inert = writeInertAgent(towers.root);
    wsA = makeWorkspace(join(towers.root, 'a', 'codev'), inert);
    wsB = makeWorkspace(join(towers.root, 'b', 'codev'), inert);
    notesB = makeWorkspace(join(towers.root, 'b', 'notes'), inert);
    await a.activate(wsA);
    await b.activate(wsB);
    await b.activate(notesB);
    await b.addArchitect(wsB, 'local');
    await b.addBuilder(wsB, BUILDER, 'spir-1940', 'main');
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
    for (const tower of [a, b]) {
      const on = await tower.json('PUT', '/api/peer/switch', { state: 'on', humanApproved: true });
      expect(on.status, JSON.stringify(on.body)).toBe(200);
    }
  }, 240_000);

  afterAll(async () => {
    await towers?.stop();
  }, 120_000);

  afterEach(async () => {
    // Every grant for mbp goes, so each case starts from none.
    await b.json('POST', '/api/peer/grants/revoke', { tower: 'mbp' });
  });

  it('with no grant: refused, naming the command that adds one, and exits 1', async () => {
    const run = await show();
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toEqual(['[error] Refused by devvm: mbp has no grant there. On devvm: afx peer grant mbp <recipients>']);
    expect(run.stdout).toEqual([]);
  });

  it('one architect: that architect alone', async () => {
    await grant({ addresses: ['codev:architect:local'] });
    const run = await show();
    expect(run.exitCode, JSON.stringify(run)).toBeNull();
    expect(run.stdout).toEqual(lines(['afx://devvm/codev:architect:local', true]));
  });

  it('a front door: the architect it reaches now', async () => {
    await grant({ addresses: ['codev:architect'] });
    expect((await show()).stdout).toEqual(lines(['afx://devvm/codev:architect:main', true]));
  });

  it("a workspace's architects: each of them, and no builder", async () => {
    await grant({ workspace: 'codev' });
    expect((await show()).stdout).toEqual(lines(['afx://devvm/codev:architect:main', true], ['afx://devvm/codev:architect:local', true]));
  });

  it('--all: every workspace\'s architects and builders by id, never the shell; each address is one afx send accepts', async () => {
    await grant({ all: true });
    const run = await show();
    expect(run.stdout).toEqual(
      lines(
        ['afx://devvm/codev:architect:main', true],
        ['afx://devvm/codev:architect:local', true],
        [`afx://devvm/codev:${BUILDER}`, true],
        ['afx://devvm/notes:architect:main', true],
      ),
    );

    // Pasted as printed: each is accepted by devvm (held there, as its terminals are inert).
    for (const line of run.stdout) {
      const to = line.split(/\s+/)[0];
      const sent = await a.json<{ held?: boolean; remote?: { heldWhere?: string }; error?: string }>('POST', '/api/send', {
        to,
        message: 'found with afx peer show',
        from: 'main',
        workspace: wsA,
        fromWorkspace: wsA,
      });
      expect(sent.status, `${to}: ${JSON.stringify(sent.body)}`).toBe(200);
      expect(sent.body.remote?.heldWhere, to).toBe('recipient');
    }
  });

  it('a stopped workspace is not listed, as a message there is refused: the listing and the receiver agree', async () => {
    await grant({ all: true });
    await b.deactivate(notesB);
    try {
      const run = await show();
      expect(run.exitCode, JSON.stringify(run)).toBeNull();
      expect(run.stdout.some((line) => line.includes('/notes:')), JSON.stringify(run.stdout)).toBe(false);
      const sent = await a.json<{ reason?: string; refusedBy?: string }>('POST', '/api/send', {
        to: 'afx://devvm/notes:architect:main',
        message: 'to a stopped workspace',
        from: 'main',
        workspace: wsA,
        fromWorkspace: wsA,
      });
      expect(sent.body, JSON.stringify(sent.body)).toMatchObject({ refusedBy: 'peer', reason: 'no-such-agent' });
    } finally {
      await b.activate(notesB);
    }
  });

  it('an offline peer is refused, and nothing is held', async () => {
    await grant({ all: true });
    const before = outboxRows();
    towers.relay.setOffline(b.towerId, true);
    try {
      const run = await show();
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toEqual([
        '[error] devvm is offline: it has no connection to Codev Cloud now. A query is never held: ask again when it is online.',
      ]);
      expect(outboxRows()).toBe(before);
    } finally {
      towers.relay.setOffline(b.towerId, false);
    }
  });

  it("a peer whose switch is off refuses, and says so", async () => {
    await grant({ all: true });
    expect((await b.json('PUT', '/api/peer/switch', { state: 'off' })).status).toBe(200);
    try {
      const run = await show();
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toEqual(['[error] Refused by devvm: remote messaging is off there.']);
    } finally {
      expect((await b.json('PUT', '/api/peer/switch', { state: 'on', humanApproved: true })).status).toBe(200);
    }
  });

  it('is not queued behind messages: answered while a message to devvm is in flight', async () => {
    await grant({ all: true });
    towers.relay.injectFault({ kind: 'answer-delay', ms: 4_000, to: b.towerId }, 1);
    const sending = a.json<{ held?: boolean }>('POST', '/api/send', {
      to: 'afx://devvm/codev:architect:main',
      message: 'a message the cloud is slow to answer',
      from: 'main',
      workspace: wsA,
      fromWorkspace: wsA,
    });
    const inFlight = await waitFor(async () => towers.relay.inFlight(a.towerId, b.towerId).now === 1, 10_000, 20);
    expect(inFlight).toBe(true);

    const started = Date.now();
    const run = await show();
    expect(run.exitCode, JSON.stringify(run)).toBeNull();
    expect(run.stdout[0]).toMatch(/^afx:\/\/devvm\/codev:architect:main\s+live$/);
    expect(Date.now() - started).toBeLessThan(3_000);
    // The message's call was still out when the query was answered.
    expect(towers.relay.inFlight(a.towerId, b.towerId).now).toBe(1);

    const sent = await sending;
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  });

  it('both Towers record every query, without addresses', async () => {
    await grant({ addresses: ['codev:architect:local'] });
    const before = { a: records(a).length, b: records(b).length };
    await show();
    const [outbound] = records(a).slice(before.a);
    const [inbound] = records(b).slice(before.b);
    expect(outbound).toMatchObject({ direction: 'outbound', kind: 'query', peer_tower_id: b.towerId, to_address: null, outcome: 'answered', reason: null });
    expect(inbound).toMatchObject({ direction: 'inbound', kind: 'query', peer_tower_id: a.towerId, to_address: null, outcome: 'answered', reason: null });
    expect(inbound.message_id).toBe(outbound.message_id);
    // The query's payload, `{"sentAt":…,"what":"addresses"}`, as sent and as received.
    expect(outbound.payload_size).toBeGreaterThan(0);
    expect(inbound.payload_size).toBe(outbound.payload_size);
  });
});
