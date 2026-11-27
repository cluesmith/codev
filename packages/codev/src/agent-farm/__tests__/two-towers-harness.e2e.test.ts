/**
 * The two-Tower harness, smoke test (Spec 1967, plan phase 2, layer B).
 *
 * Two built Towers, each with its own port, database, agent-farm directory, socket
 * directory and `HOME`, both connected over loopback to the stand-in relay with today's
 * handshake. A Tower before plan phase 5 sends no `peer` field and ignores `auth_ok`'s
 * `relay`; that it still connects is part of what this checks. One Tower is restarted with
 * its state intact (its database, cloud identity and directories), and both are stopped
 * leaving nothing behind.
 *
 * On demand, after `pnpm build`, never in porch's tests check (a `*.e2e.test.ts` is
 * excluded from the default config):
 *
 *   pnpm exec vitest run --config vitest.e2e.config.ts \
 *     src/agent-farm/__tests__/two-towers-harness.e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  freeLoopbackPorts,
  makeWorkspace,
  runCli,
  startTwoTowers,
  writeInertAgent,
  type HarnessTower,
  type TeardownReport,
  type TwoTowers,
} from './helpers/two-towers.js';
import { pidsNamingSocketDir, waitFor } from './helpers/tower-test-utils.js';

vi.mock('../lib/tower-client.js', async (importOriginal) =>
  (await import('./helpers/two-towers.js')).towerClientModuleFor(await importOriginal()),
);
vi.mock('../db/index.js', async (importOriginal) =>
  (await import('./helpers/two-towers.js')).dbModuleFor(await importOriginal()),
);

const { workspaceList } = await import('../commands/workspace-list.js');
const { send } = await import('../commands/send.js');

const BUILDER = 'builder-spir-7';

interface ListedWorkspace {
  path: string;
  running: boolean;
  agents: Array<{ kind: string; name: string; live: boolean }>;
}

/** `afx workspace list --json`, run as `agent` against `tower`. */
async function listWorkspaces(tower: HarnessTower, cwd: string, architect?: string): Promise<ListedWorkspace[]> {
  const run = await runCli(tower, { cwd, architect }, () => workspaceList({ json: true }));
  expect(run.exitCode, JSON.stringify(run)).toBeNull();
  return (JSON.parse(run.stdout.join('\n')) as { workspaces: ListedWorkspace[] }).workspaces;
}

/**
 * Whether the workspace runs with its `main` architect live, as Tower's address book says.
 * (`/api/status` leaves out workspaces under the temp directory, which these all are.)
 */
async function architectLive(tower: HarnessTower, workspacePath: string): Promise<boolean> {
  const run = await runCli(tower, { cwd: workspacePath, architect: 'main' }, () => workspaceList({ json: true }));
  if (run.exitCode !== null) return false;
  const workspaces = (JSON.parse(run.stdout.join('\n')) as { workspaces: ListedWorkspace[] }).workspaces;
  const listed = workspaces.find((w) => w.path === workspacePath);
  return Boolean(listed?.running && listed.agents.some((agent) => agent.kind === 'architect' && agent.name === 'main' && agent.live));
}

describe('Spec 1967 phase 2: two Towers against the stand-in relay', () => {
  let towers: TwoTowers;
  /** `<root>/a/codev`, on Tower a. */
  let codevA: string;
  /** `<root>/b/codev-cloud`, on Tower b, with a builder. */
  let cloudB: string;
  let builderWorktree: string;

  beforeAll(async () => {
    towers = await startTwoTowers();
    const inert = writeInertAgent(towers.root);
    codevA = makeWorkspace(join(towers.root, 'a', 'codev'), inert);
    cloudB = makeWorkspace(join(towers.root, 'b', 'codev-cloud'), inert);
    await towers.a.activate(codevA);
    await towers.b.activate(cloudB);
    builderWorktree = await towers.b.addBuilder(cloudB, BUILDER, 'spir-7', 'main');
  }, 180_000);

  afterAll(async () => {
    await towers?.stop();
  }, 120_000);

  it("starts two Towers on their own ports, databases and directories, both connected to the stand-in with today's handshake", async () => {
    const { relay, a, b } = towers;
    expect(a.port).not.toBe(b.port);
    expect(new Set([a.dbPath, a.agentFarmDir, a.socketDir, a.home, b.dbPath, b.agentFarmDir, b.socketDir, b.home]).size).toBe(8);

    for (const tower of [a, b]) {
      expect(await tower.tunnelStatus()).toMatchObject({
        registered: true,
        state: 'connected',
        towerId: tower.towerId,
        towerName: tower.slug,
      });
      // Today's Tower states nothing of the protocol, and connects anyway.
      expect(relay.handshakes.filter((h) => h.towerId === tower.towerId).map((h) => h.peer)).toEqual(['absent']);
      expect(relay.session(tower.towerId)?.secret).toHaveLength(32);
      // It took its name from auth_ok's slug, which is the one it was registered with.
      const config = JSON.parse(readFileSync(join(tower.agentFarmDir, 'cloud-config.json'), 'utf8'));
      expect(config).toMatchObject({ tower_id: tower.towerId, tower_name: tower.slug, server_url: relay.url });
      expect(config.deregistered_at).toBeUndefined();
      // Its shellpers use the harness's socket directory: what makes the teardown check mean something.
      expect(pidsNamingSocketDir(tower.socketDir).length).toBeGreaterThan(0);
    }

    // Each sees the other in the listing: online, stating no version yet.
    const listing = await fetch(`${relay.url}/api/peer/towers`, { headers: { authorization: `Bearer ${a.record.apiKey}` } });
    expect(((await listing.json()) as { towers: unknown[] }).towers).toEqual([
      { towerId: b.towerId, slug: b.slug, online: true, protocols: [], remoteMessaging: 'unknown' },
    ]);
  });

  it('runs the CLI against either Tower, switching the port and the database per call', async () => {
    const onA = await listWorkspaces(towers.a, codevA, 'main');
    expect(onA.map((w) => w.path)).toEqual([codevA]);

    // As b's builder: its identity is read from b's database, so a wrong database fails here.
    const onB = await listWorkspaces(towers.b, builderWorktree);
    expect(onB.map((w) => w.path)).toEqual([cloudB]);
    expect(onB[0].agents.map((agent) => `${agent.kind}:${agent.name}`)).toEqual(['architect:main', `builder:${BUILDER}`]);
  });

  it('restarts one Tower with its state intact: the same port, database and cloud identity, and a new tunnel session', async () => {
    const { relay, a } = towers;
    const port = a.port;
    const dbPath = a.dbPath;
    const secretBefore = relay.session(a.towerId)?.secret;
    // State to find again after the restart: mail Tower stored for an agent.
    const body = 'kept across a restart of this Tower';
    const sent = await runCli(a, { cwd: codevA, architect: 'main' }, () => send({ builder: 'architect', message: body }));
    expect(sent.exitCode, JSON.stringify(sent)).toBeNull();
    const mailIds = () =>
      a.readDb((db) => (db.prepare('SELECT id FROM mailbox WHERE body = ?').all(body) as Array<{ id: string }>).map((row) => row.id));
    const before = mailIds();
    expect(before).toHaveLength(1);

    await a.restart();
    await a.waitForTunnel();

    expect(a.port).toBe(port);
    expect(a.dbPath).toBe(dbPath);
    expect(a.handles).toHaveLength(2);
    expect(mailIds()).toEqual(before);
    const status = await a.tunnelStatus();
    expect(status).toMatchObject({ registered: true, state: 'connected', towerId: a.towerId, towerName: a.slug });
    expect(relay.sessionsOpened(a.towerId)).toBe(2);
    expect(relay.session(a.towerId)?.secret?.equals(secretBefore!)).toBe(false);
    // Tower ends the terminals of temp-directory workspaces on a restart (see
    // HarnessTower.restart); activating the workspace again brings its architect back.
    await a.activate(codevA);
    expect(await waitFor(() => architectLive(a, codevA), 30_000, 250)).toBe(true);
    // The other Tower was not touched.
    expect(relay.sessionsOpened(towers.b.towerId)).toBe(1);
  }, 120_000);

  it('stops both Towers leaving no process, socket or directory behind', async () => {
    const report = await towers.stop();
    expect(report).toEqual({ processes: [], shellpers: [], paths: [], relayListening: false });
  }, 120_000);
});

describe('Spec 1967: the harness keeps to its own Towers', () => {
  const clean: TeardownReport = { processes: [], shellpers: [], paths: [], relayListening: false };

  it('two harnesses started at once get four distinct ports, each answered by its own Tower', async () => {
    const pairs = await Promise.allSettled([startTwoTowers(), startTwoTowers()]);
    const reports: TeardownReport[] = [];
    try {
      expect(pairs.map((pair) => (pair.status === 'fulfilled' ? 'started' : String(pair.reason)))).toEqual(['started', 'started']);
      const towers = pairs.flatMap((pair) => (pair.status === 'fulfilled' ? [pair.value.a, pair.value.b] : []));
      expect(new Set(towers.map((tower) => tower.port)).size).toBe(4);
      for (const tower of towers) {
        // Each port answers as the Tower whose credentials that harness wrote.
        expect(await tower.tunnelStatus()).toMatchObject({ state: 'connected', towerId: tower.towerId, towerName: tower.slug });
      }
    } finally {
      for (const pair of pairs) if (pair.status === 'fulfilled') reports.push(await pair.value.stop());
    }
    expect(reports).toEqual([clean, clean]);
  }, 180_000);

  it('a Tower whose port another process holds fails the start, naming the port, instead of using what answers there', async () => {
    const first = await startTwoTowers();
    let report: TeardownReport | null = null;
    try {
      const [free] = await freeLoopbackPorts(1);
      const taken = first.a.port;
      await expect(startTwoTowers({ ports: [taken, free] })).rejects.toThrow(
        new RegExp(`process started for port ${taken} exited \\(code 1\\) before it was listening`),
      );
      // The Tower that holds the port is untouched.
      expect(await first.a.tunnelStatus()).toMatchObject({ state: 'connected', towerId: first.a.towerId });
    } finally {
      report = await first.stop();
    }
    expect(report).toEqual(clean);
  }, 180_000);
});
