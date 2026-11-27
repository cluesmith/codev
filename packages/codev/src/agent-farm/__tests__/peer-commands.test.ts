/**
 * Spec 1967, phase 4: `afx peer on|off|grants|grant|revoke|limits`, end to end in-process.
 *
 * Each command runs against the real peer route handler, served over HTTP on a loopback port
 * by a throwaway server, with a temporary database and a hand-built world of workspaces and
 * architects. The client is the SDK's own `TowerClient`, so the request and response types
 * are exercised as they cross the wire. Nothing here touches the live Tower or the real cloud.
 *
 * What is proven: a fresh install is off with no grants; turning remote messaging on and
 * adding a grant need the human flag, refuse without it, and change nothing then; neither is
 * accepted from the tunnel; `off` and `revoke` need no flag; a grant's mode defaults to
 * deliver, `--hold` holds, both together are refused, and `afx peer grants` shows the mode;
 * grants for an unregistered workspace or a missing architect are refused when made; a grant
 * whose architect has gone matches nothing and says so; and `afx peer limits` shows this
 * Tower's limits, with a short record retention used as 30 days.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { TowerClient } from '@cluesmith/codev-sdk/tower-client';
import type { PeerCloudRelay, PeerListingTower, PeerListProblem, PeerSwitchReport, PeerSwitchState } from '@cluesmith/codev-types';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import * as store from '../peer/store.js';
import { createPeerRouteHandler, type PeerRouteDeps } from '../servers/peer-routes.js';
import { peerGrant, peerGrants, peerLimits, peerList, peerOff, peerOn, peerRevoke, type PeerDeps } from '../commands/peer.js';
import { resolvePeerSettings, type CodevConfig } from '../../lib/config.js';
import type { RegisteredWorkspace } from '../utils/workspace-address.js';

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const CODEV = '/work/codev';
const OTHER = '/work/other';
const MBP = '01JMBP000000000000000000AA';
const DEVVM = '01JDEVVM0000000000000000AA';
/** The registration the harness's listings were fetched under (the cloud stub holds none to it). */
const FETCHED_FOR = 'https://cloud.example 01JSELF0000000000000000AAA';

/**
 * The cloud behind the routes, as a test sets it: what a refresh comes to (by default the
 * cached list, the cloud unreachable), the relay, the tunnel, and what a switch report does.
 * `peer-list.test.ts` runs the same routes against the stand-in relay.
 */
interface CloudStub {
  refreshProblem: PeerListProblem | null;
  retryAfterSec: number | null;
  /** Run before a refresh answers, as a fetched listing would be written. */
  onRefresh: (() => void) | null;
  refreshes: number;
  relay: PeerCloudRelay;
  tunnelUp: boolean;
  report: PeerSwitchReport | 'throws';
  reported: PeerSwitchState[];
  /** How many times the outbox was woken (Spec 1967, phase 9). */
  wakes: number;
}

interface Harness {
  cloud: CloudStub;
  logged: string[];
  db: Database.Database;
  architects: Map<string, string[]>;
  registered: RegisteredWorkspace[];
  config: { value: CodevConfig };
  printed: string[];
  deps: PeerDeps;
  client: TowerClient;
  port: number;
  /** Calls straight to the route, for what the CLI never sends. */
  raw(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }>;
  clock: { now: number };
}

let harness: Harness;
let server: http.Server;
let dir: string;

function tower(towerId: string, slug: string): PeerListingTower {
  return { towerId, slug, online: true, protocols: [1], remoteMessaging: 'on' };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'peer-commands-'));
  const db = new Database(join(dir, 'global.db'));
  db.exec(GLOBAL_SCHEMA);
  // This Tower has listed its peers once (phase 7 fetches the listing; here it is seeded).
  store.writeListing(db, { relay: { protocols: [1] }, limits: { messagesPerTowerPerMinute: 60, messagesPerPairPerMinute: 30, queriesPerPairPerMinute: 10 }, towers: [tower(MBP, 'mbp'), tower(DEVVM, 'devvm')], fetchedFor: FETCHED_FOR }, T0);

  const architects = new Map<string, string[]>([
    [CODEV, ['main', 'local']],
    [OTHER, ['main']],
  ]);
  const registered: RegisteredWorkspace[] = [
    { workspacePath: CODEV, explicitName: null },
    { workspacePath: OTHER, explicitName: null },
  ];
  const config = { value: {} as CodevConfig };
  const clock = { now: T0 + 60_000 };
  const cloud: CloudStub = {
    refreshProblem: 'cloud-unreachable',
    retryAfterSec: null,
    onRefresh: null,
    refreshes: 0,
    relay: { state: 'available', why: null },
    tunnelUp: true,
    report: 'reporting',
    reported: [],
    wakes: 0,
  };
  const logged: string[] = [];
  const deps: PeerRouteDeps = {
    db: () => db,
    now: () => clock.now,
    world: () => ({ registered, running: [CODEV, OTHER], architectsOf: (ws) => architects.get(ws) ?? [] }),
    ownTower: () => ({ name: 'ana-s-mbp', towerId: '01JSELF0000000000000000AAA' }),
    settings: () => resolvePeerSettings(config.value),
    cloud: () => ({
      scopeToRegistration: () => {},
      refreshListing: async () => {
        cloud.refreshes++;
        cloud.onRefresh?.();
        const fresh = cloud.refreshProblem === null;
        return { fresh, problem: cloud.refreshProblem, retryAfterSec: cloud.retryAfterSec, listing: store.readListing(db) };
      },
      relay: () => cloud.relay,
      tunnelUp: () => cloud.tunnelUp,
      reportSwitch: (state) => {
        if (cloud.report === 'throws') throw new Error('cloud-config.json is not valid JSON');
        cloud.reported.push(state);
        return cloud.report;
      },
      wakeOutbox: () => {
        cloud.wakes++;
      },
    }),
    log: (level, message) => logged.push(`${level} ${message}`),
  };
  const handler = createPeerRouteHandler(deps);
  server = http.createServer((req, res) => {
    void handler(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const client = new TowerClient({ host: '127.0.0.1', port });
  const printed: string[] = [];
  harness = {
    cloud,
    logged,
    db,
    architects,
    registered,
    config,
    printed,
    client,
    port,
    clock,
    deps: {
      client,
      out: {
        success: (m) => printed.push(`[ok] ${m}`),
        info: (m) => printed.push(`[info] ${m}`),
        warn: (m) => printed.push(`[warn] ${m}`),
        line: (t) => printed.push(t),
      },
    },
    async raw(method, path, body, headers = {}) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
  };
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  harness.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const HUMAN = { humanApproved: true } as const;

/** Run a command and return what it printed, or the refusal it threw. */
async function run(command: (deps: PeerDeps) => Promise<void>): Promise<{ printed: string[]; error: string | null }> {
  harness.printed.length = 0;
  try {
    await command(harness.deps);
    return { printed: [...harness.printed], error: null };
  } catch (err) {
    return { printed: [...harness.printed], error: (err as Error).message };
  }
}

describe('a fresh install', () => {
  it('is off, holds no grant, and says how to change either', async () => {
    expect(store.readRemoteMessaging(harness.db).state).toBe('off');
    const shown = await run((d) => peerGrants({}, d));
    expect(shown).toEqual({
      error: null,
      printed: [
        'Remote messaging: off — no grant applies until a human turns it on with: afx peer on',
        'No grants: no Tower may message this Tower. Allow one with: afx peer grant <tower> <recipients>',
      ],
    });
  });
});

describe('afx peer on / off', () => {
  it('refuses to turn remote messaging on without the human flag, before asking Tower, and changes nothing', async () => {
    const refused = await run((d) => peerOn({}, d));
    expect(refused.error).toBe(
      "Turning remote messaging on is a human's decision. A human runs: afx peer on --a-human-explicitly-approved-this",
    );
    expect(store.readRemoteMessaging(harness.db)).toEqual({ state: 'off', changedAt: null });
  });

  it('is refused by Tower too when the request does not carry the approval', async () => {
    for (const body of [{ state: 'on' }, { state: 'on', humanApproved: false }]) {
      const answer = await harness.raw('PUT', '/api/peer/switch', body);
      expect(answer.status).toBe(403);
      expect(answer.body.error).toBe('HUMAN_APPROVAL_REQUIRED');
    }
    expect(store.readRemoteMessaging(harness.db)).toEqual({ state: 'off', changedAt: null });
  });

  it('turns it on with the flag, as walkthrough step 2 prints, and says so when it already was', async () => {
    const on = await run((d) => peerOn(HUMAN, d));
    expect(on).toEqual({
      error: null,
      printed: ['[ok] Remote messaging is on for ana-s-mbp. No Tower may message it yet. Allow one with: afx peer grant <tower> …'],
    });
    expect(store.readRemoteMessaging(harness.db)).toEqual({ state: 'on', changedAt: harness.clock.now });

    harness.clock.now += 5000;
    const again = await run((d) => peerOn(HUMAN, d));
    expect(again.printed[0]).toContain('Remote messaging was already on for ana-s-mbp.');
    expect(store.readRemoteMessaging(harness.db).changedAt).toBe(T0 + 60_000);
  });

  // Spec 1967, phase 9: mail held here while the switch was off paused, and may leave now.
  it('wakes the outbox when, and only when, the switch turns on', async () => {
    await run((d) => peerOn(HUMAN, d));
    expect(harness.cloud.wakes).toBe(1);
    await run((d) => peerOn(HUMAN, d));
    await run((d) => peerOff({}, d));
    await run((d) => peerOff({}, d));
    expect(harness.cloud.wakes).toBe(1);
    await run((d) => peerOn(HUMAN, d));
    expect(harness.cloud.wakes).toBe(2);
  });

  it('turns it off with no flag, and says how many grants apply when turned back on', async () => {
    await run((d) => peerOn(HUMAN, d));
    expect(await run((d) => peerOff({}, d))).toEqual({
      error: null,
      printed: ['[ok] Remote messaging is off for ana-s-mbp. It sends nothing to other Towers and accepts nothing from them.'],
    });
    expect(store.readRemoteMessaging(harness.db).state).toBe('off');
    expect((await run((d) => peerOff({}, d))).printed).toEqual(['[ok] Remote messaging was already off for ana-s-mbp.']);

    await run((d) => peerGrant({ tower: 'mbp', addresses: ['codev:architect:local'], ...HUMAN }, d));
    expect((await run((d) => peerOn(HUMAN, d))).printed).toEqual([
      '[ok] Remote messaging is on for ana-s-mbp. One grant applies: afx peer grants',
    ]);
  });

  it('refuses turning it on through the tunnel, flag or no flag, and lets it be turned off that way', async () => {
    const tunnel = { 'x-codev-tunnel-proxy': '1' };
    const answer = await harness.raw('PUT', '/api/peer/switch', { state: 'on', humanApproved: true }, tunnel);
    expect(answer).toMatchObject({ status: 403, body: { error: 'NOT_OVER_TUNNEL' } });
    expect(store.readRemoteMessaging(harness.db).state).toBe('off');

    await run((d) => peerOn(HUMAN, d));
    expect((await harness.raw('PUT', '/api/peer/switch', { state: 'off' }, tunnel)).status).toBe(200);
    expect(store.readRemoteMessaging(harness.db).state).toBe('off');
  });

  it('takes any value of the tunnel marker as the tunnel', async () => {
    const answer = await harness.raw('PUT', '/api/peer/switch', { state: 'on', humanApproved: true }, { 'x-codev-tunnel-proxy': 'yes' });
    expect(answer).toMatchObject({ status: 403, body: { error: 'NOT_OVER_TUNNEL' } });
  });

  it('refuses a malformed switch request', async () => {
    expect((await harness.raw('PUT', '/api/peer/switch', { state: 'maybe' })).body.error).toBe('INVALID_PARAMS');
    expect((await harness.raw('PUT', '/api/peer/switch', ['on'])).body.error).toBe('INVALID_PARAMS');
    expect((await harness.raw('POST', '/api/peer/switch', { state: 'off' })).status).toBe(405);
  });
});

describe('afx peer grant', () => {
  it('refuses without the human flag, before asking Tower, and stores nothing', async () => {
    const refused = await run((d) => peerGrant({ tower: 'mbp', addresses: ['codev:architect:local'] }, d));
    expect(refused.error).toBe(
      "Adding a grant is a human's decision. A human runs: afx peer grant mbp … --a-human-explicitly-approved-this",
    );
    expect(store.listGrants(harness.db)).toEqual([]);
  });

  it('is refused by Tower too without the approval, and from the tunnel even with it', async () => {
    const request = { tower: 'mbp', addresses: ['codev:architect:local'] };
    expect(await harness.raw('POST', '/api/peer/grants', request)).toMatchObject({ status: 403, body: { error: 'HUMAN_APPROVAL_REQUIRED' } });
    expect(
      await harness.raw('POST', '/api/peer/grants', { ...request, humanApproved: true }, { 'x-codev-tunnel-proxy': '1' }),
    ).toMatchObject({ status: 403, body: { error: 'NOT_OVER_TUNNEL' } });
    expect(store.listGrants(harness.db)).toEqual([]);
  });

  it('adds a deliver grant by default, as walkthrough step 4 prints, and afx peer grants shows its mode', async () => {
    await run((d) => peerOn(HUMAN, d));
    const granted = await run((d) => peerGrant({ tower: 'mbp', addresses: ['codev:architect:local'], ...HUMAN }, d));
    expect(granted).toEqual({
      error: null,
      printed: ['[ok] mbp (your Tower) may message codev:architect:local on this Tower. Mail is delivered directly.'],
    });
    expect(store.listGrants(harness.db)).toMatchObject([
      { peerTowerId: MBP, scope: 'architect', workspacePath: CODEV, architect: 'local', mode: 'deliver' },
    ]);
    expect((await run((d) => peerGrants({}, d))).printed).toEqual([
      'Remote messaging: on',
      'TOWER  MAY MESSAGE            MODE',
      'mbp    codev:architect:local  deliver',
    ]);
  });

  it('adds a hold-for-release grant with --hold, and shows it', async () => {
    const granted = await run((d) => peerGrant({ tower: 'devvm', workspace: 'codev', hold: true, ...HUMAN }, d));
    expect(granted.printed[0]).toBe('[ok] devvm (your Tower) may message every architect in codev on this Tower. Mail is held for release.');
    expect(granted.printed[1]).toBe(
      '[info] Remote messaging is off on this Tower: nothing arrives until a human turns it on with: afx peer on',
    );
    expect(store.listGrants(harness.db)).toMatchObject([{ peerTowerId: DEVVM, scope: 'architects', mode: 'hold' }]);
    expect((await run((d) => peerGrants({ tower: 'devvm' }, d))).printed).toContain(
      'devvm  every architect in codev  hold for release',
    );
  });

  it('accepts --deliver as the default spelled out, and refuses --deliver with --hold, changing nothing', async () => {
    await run((d) => peerGrant({ tower: 'mbp', all: true, deliver: true, ...HUMAN }, d));
    expect(store.listGrants(harness.db)).toMatchObject([{ scope: 'all', mode: 'deliver' }]);
    const both = await run((d) => peerGrant({ tower: 'mbp', all: true, deliver: true, hold: true, ...HUMAN }, d));
    expect(both.error).toBe('Choose one mode: --deliver (the default) or --hold, not both.');
    expect(store.listGrants(harness.db)).toMatchObject([{ scope: 'all', mode: 'deliver' }]);
  });

  it('changes the mode of a grant that exists, and says when nothing changed', async () => {
    await run((d) => peerGrant({ tower: 'mbp', addresses: ['codev:architect'], ...HUMAN }, d));
    harness.clock.now += 1000;
    const held = await run((d) => peerGrant({ tower: 'mbp', addresses: ['codev:architect'], hold: true, ...HUMAN }, d));
    expect(held.printed[0]).toBe('[ok] mbp (your Tower) may still message codev:architect on this Tower. Mail is now held for release.');
    const [stored] = store.listGrants(harness.db);
    expect(stored).toMatchObject({ scope: 'front-door', mode: 'hold', createdAt: T0 + 60_000, updatedAt: T0 + 61_000 });
    const same = await run((d) => peerGrant({ tower: 'mbp', addresses: ['codev:architect'], hold: true, ...HUMAN }, d));
    expect(same.printed[0]).toBe('[ok] mbp (your Tower) already may message codev:architect on this Tower. Mail is held for release.');
  });

  it('adds several grants in one request, all or nothing', async () => {
    const refused = await run((d) =>
      peerGrant({ tower: 'mbp', addresses: ['codev:architect:local', 'codev:architect:ghost'], ...HUMAN }, d),
    );
    expect(refused.error).toContain("Architect 'ghost' is not registered in workspace 'codev'");
    expect(store.listGrants(harness.db)).toEqual([]);
    const both = await run((d) => peerGrant({ tower: 'mbp', addresses: ['codev:architect:local', 'other:architect'], ...HUMAN }, d));
    expect(both.printed[0]).toBe(
      '[ok] mbp (your Tower) may message codev:architect:local, other:architect on this Tower. Mail is delivered directly.',
    );
    expect(store.listGrants(harness.db)).toHaveLength(2);
  });

  it('refuses a grant for a workspace that is not registered, or an architect that does not exist', async () => {
    for (const options of [
      { addresses: ['nosuch:architect:main'] },
      { workspace: 'nosuch' },
      { addresses: ['codev:architect:ghost'] },
    ]) {
      const refused = await run((d) => peerGrant({ tower: 'mbp', ...options, ...HUMAN }, d));
      expect(refused.error).toMatch(/not registered|No workspace/);
    }
    expect(store.listGrants(harness.db)).toEqual([]);
  });

  it('refuses a builder, an unknown Tower, a former name, another owner\'s Tower and this Tower', async () => {
    const cases: Array<[Parameters<typeof peerGrant>[0], string]> = [
      [{ tower: 'mbp', addresses: ['codev:builder-spir-1'], ...HUMAN }, 'builders are covered only by --all'],
      [{ tower: 'nas', all: true, ...HUMAN }, "No Tower named 'nas' is in this Tower's peer list"],
      [{ tower: 'sam@studio', all: true, ...HUMAN }, 'Towers of other owners (sam@studio) are not available yet'],
      [{ tower: 'ana-s-mbp', all: true, ...HUMAN }, "'ana-s-mbp' is this Tower"],
      [{ tower: 'mbp', ...HUMAN }, 'Name what the Tower may message'],
    ];
    for (const [options, message] of cases) {
      expect((await run((d) => peerGrant(options, d))).error).toContain(message);
    }
    store.writeListing(harness.db, { relay: { protocols: [1] }, limits: { messagesPerTowerPerMinute: 60, messagesPerPairPerMinute: 30, queriesPerPairPerMinute: 10 }, towers: [tower(MBP, 'laptop')], fetchedFor: FETCHED_FOR }, T0 + 1);
    expect((await run((d) => peerGrant({ tower: 'mbp', all: true, ...HUMAN }, d))).error).toBe(
      "'mbp' is a former name of the Tower now called 'laptop'. Name it 'laptop'. (UNKNOWN_TOWER)",
    );
    expect(store.listGrants(harness.db)).toEqual([]);
  });
});

describe('a refusal that quotes the request', () => {
  it('replaces control, format and separator characters, and keeps letters of any script', async () => {
    const rlo = String.fromCodePoint(0x202e);
    const zwj = String.fromCodePoint(0x200d);
    const lineSeparator = String.fromCodePoint(0x2028);
    const cases = [
      { addresses: [`codev:architect:${rlo}niam`] },
      { workspace: `caf\u00e9${zwj}${lineSeparator}` },
    ];
    for (const recipients of cases) {
      const answer = await harness.raw('POST', '/api/peer/grants', { tower: 'mbp', humanApproved: true, ...recipients });
      expect(answer).toMatchObject({ status: 404, body: { error: 'NOT_FOUND' } });
      const message = answer.body.message as string;
      for (const unsafe of [rlo, zwj, lineSeparator]) expect(message).not.toContain(unsafe);
      expect(message).toContain('?');
    }
    const accented = await harness.raw('POST', '/api/peer/grants', { tower: 'mbp', humanApproved: true, workspace: 'caf\u00e9' });
    expect(accented.body.message).toContain('caf\u00e9');
    expect(store.listGrants(harness.db)).toEqual([]);
  });
});

describe('afx peer grants', () => {
  it('shows a grant whose architect has gone as matching nothing, and as applying again when the name returns', async () => {
    await run((d) => peerGrant({ tower: 'mbp', addresses: ['codev:architect:local'], ...HUMAN }, d));
    harness.architects.set(CODEV, ['main']);
    const gone = await run((d) => peerGrants({}, d));
    expect(gone.printed).toContain('mbp    codev:architect:local  deliver  matches nothing: architect local is not registered in codev');
    harness.architects.set(CODEV, ['main', 'local']);
    expect((await run((d) => peerGrants({}, d))).printed).toContain('mbp    codev:architect:local  deliver');
  });

  it('shows where a front door leads now, and that overlapping grants hold if any holds', async () => {
    await run((d) => peerGrant({ tower: 'mbp', addresses: ['codev:architect'], ...HUMAN }, d));
    await run((d) => peerGrant({ tower: 'mbp', all: true, hold: true, ...HUMAN }, d));
    const shown = (await run((d) => peerGrants({ tower: 'mbp' }, d))).printed;
    expect(shown).toContain('mbp    codev:architect (now main)  deliver');
    expect(shown).toContain('Where grants for one Tower overlap, its mail is held for release if any of them holds it.');
  });

  it('lists one Tower by name, and says when it has none', async () => {
    await run((d) => peerGrant({ tower: 'devvm', all: true, ...HUMAN }, d));
    expect((await run((d) => peerGrants({ tower: 'mbp' }, d))).printed[1]).toBe(
      'No grants for mbp: it may not message this Tower. Allow it with: afx peer grant mbp <recipients>',
    );
  });
});

describe('afx peer revoke', () => {
  beforeEach(async () => {
    await run((d) => peerGrant({ tower: 'mbp', addresses: ['codev:architect:local', 'codev:architect'], ...HUMAN }, d));
    await run((d) => peerGrant({ tower: 'devvm', all: true, ...HUMAN }, d));
  });

  it('removes one grant with no flag', async () => {
    expect(await run((d) => peerRevoke({ tower: 'mbp', addresses: ['codev:architect:local'] }, d))).toEqual({
      error: null,
      printed: ['[ok] mbp may no longer message codev:architect:local on this Tower.'],
    });
    expect(store.listGrants(harness.db, MBP)).toMatchObject([{ scope: 'front-door' }]);
  });

  it('removes every grant for a Tower when none is named, and leaves other Towers alone', async () => {
    expect((await run((d) => peerRevoke({ tower: 'mbp' }, d))).printed).toEqual([
      '[ok] Removed all 2 grants for mbp: it may no longer message this Tower.',
    ]);
    expect(store.listGrants(harness.db, MBP)).toEqual([]);
    expect(store.listGrants(harness.db, DEVVM)).toHaveLength(1);
    expect((await run((d) => peerRevoke({ tower: 'devvm', all: true }, d))).printed).toEqual([
      '[ok] devvm may no longer message everything on this Tower.',
    ]);
  });

  it('removes a grant whose architect has gone', async () => {
    harness.architects.set(CODEV, ['main']);
    expect((await run((d) => peerRevoke({ tower: 'mbp', addresses: ['codev:architect:local'] }, d))).error).toBeNull();
    expect(store.listGrants(harness.db, MBP)).toMatchObject([{ scope: 'front-door' }]);
  });

  it('finds the grants of a renamed Tower by its former name', async () => {
    store.writeListing(harness.db, { relay: { protocols: [1] }, limits: { messagesPerTowerPerMinute: 60, messagesPerPairPerMinute: 30, queriesPerPairPerMinute: 10 }, towers: [tower(MBP, 'laptop'), tower(DEVVM, 'devvm')], fetchedFor: FETCHED_FOR }, T0 + 1);
    expect((await run((d) => peerRevoke({ tower: 'mbp' }, d))).printed).toEqual([
      '[ok] Removed all 2 grants for laptop: it may no longer message this Tower.',
    ]);
  });

  it('says so when there is no such grant, and exits non-zero', async () => {
    expect((await run((d) => peerRevoke({ tower: 'mbp', workspace: 'other' }, d))).error).toBe(
      'mbp has no such grant on this Tower. Its grants: afx peer grants mbp (NOT_FOUND)',
    );
    await run((d) => peerRevoke({ tower: 'mbp' }, d));
    expect((await run((d) => peerRevoke({ tower: 'mbp' }, d))).error).toBe('mbp has no grant on this Tower. (NOT_FOUND)');
  });
});

describe('afx peer limits', () => {
  it("shows this Tower's own limits, the defaults on a fresh install", async () => {
    expect((await run((d) => peerLimits({}, d))).printed).toEqual([
      "This Tower's limits (set under peer.limits in ~/.codev/config.json):",
      '  Messages accepted from one peer   30 a minute',
      '  Undelivered from one peer         50',
      '  Waiting here for one peer         50',
      '  Record of attempts kept for       30 days (peer.recordRetentionDays, at least 30)',
      `Codev Cloud's limits (approximate, the cloud's to change; from its peer list at ${new Date(T0).toISOString()}):`,
      '  Messages from this Tower          60 a minute',
      '  Messages to one Tower             30 a minute',
      '  Discovery queries to one Tower    10 a minute',
    ]);
  });

  it('shows configured limits, and a record retention below 30 days as 30', async () => {
    harness.config.value = { peer: { limits: { acceptedPerPeerPerMinute: 12 }, recordRetentionDays: 7 } };
    const shown = (await run((d) => peerLimits({}, d))).printed;
    expect(shown[1]).toBe('  Messages accepted from one peer   12 a minute');
    expect(shown[4]).toBe('  Record of attempts kept for       30 days (peer.recordRetentionDays, at least 30)');
  });

  it('reports a malformed setting, naming it', async () => {
    harness.config.value = { peer: { limits: { waitingPerPeer: 0 } } };
    expect((await run((d) => peerLimits({}, d))).error).toContain('peer.limits.waitingPerPeer must be a whole number of at least 1');
  });
});

describe('afx peer list', () => {
  const ISO_T0 = new Date(T0).toISOString();

  it('prints the switch, then one line per Tower: the name, the owner, the online hint and what it may message here', async () => {
    harness.cloud.refreshProblem = null;
    store.writeListing(
      harness.db,
      {
        relay: { protocols: [1] },
        limits: { messagesPerTowerPerMinute: 60, messagesPerPairPerMinute: 30, queriesPerPairPerMinute: 10 },
        towers: [tower(DEVVM, 'devvm'), { ...tower(MBP, 'mbp'), online: false }],
        fetchedFor: FETCHED_FOR,
      },
      harness.clock.now,
    );
    await run((d) => peerGrant({ tower: 'mbp', addresses: ['codev:architect:local'], ...HUMAN }, d));
    await run((d) => peerGrant({ tower: 'mbp', workspace: 'other', hold: true, ...HUMAN }, d));
    expect(await run((d) => peerList({}, d))).toEqual({
      error: null,
      printed: [
        'Remote messaging: off — a human turns it on with: afx peer on',
        'devvm  you  online   may message this Tower: nothing',
        'mbp    you  offline  may message this Tower: codev:architect:local (deliver), every architect in other (hold for release)',
      ],
    });
    await run((d) => peerOn(HUMAN, d));
    expect((await run((d) => peerList({}, d))).printed[0]).toBe('Remote messaging: on');
  });

  it('says when the list is a cached one, and why, with what to do', async () => {
    const notes = async () => (await run((d) => peerList({}, d))).printed.filter((line) => line.startsWith('[info]'));
    harness.cloud.refreshProblem = 'cloud-unreachable';
    expect(await notes()).toEqual([`[info] Codev Cloud is unreachable; this is the list from ${ISO_T0}.`]);
    harness.cloud.refreshProblem = 'rate-limited';
    harness.cloud.retryAfterSec = 20;
    expect(await notes()).toEqual([`[info] Codev Cloud is limiting this Tower's calls; this is the list from ${ISO_T0}. Try again in 20 s.`]);
    harness.cloud.refreshProblem = 'unauthenticated';
    expect(await notes()).toEqual([`[info] Codev Cloud refused this Tower's key; this is the list from ${ISO_T0}. Run: afx tower connect --reauth`]);
    harness.cloud.refreshProblem = 'not-connected';
    harness.cloud.tunnelUp = false;
    // Not connected says so once; the tunnel being down follows from it.
    expect(await notes()).toEqual([
      `[info] This Tower is not connected to Codev Cloud; the Towers above are from its last list, at ${ISO_T0}. Connect it with: afx tower connect`,
    ]);
    harness.cloud.refreshProblem = 'not-registered';
    expect(await notes()).toEqual([
      `[info] This Tower's registration was removed from Codev Cloud; the Towers above are from its last list, at ${ISO_T0}. Register it again with: afx tower connect --reauth`,
    ]);
    harness.cloud.refreshProblem = 'registration-changed';
    harness.cloud.tunnelUp = true;
    expect(await notes()).toEqual(["[info] This Tower's Codev Cloud registration changed while its peer list was fetched. List again: afx peer list"]);
    harness.cloud.refreshProblem = 'recent';
    harness.cloud.tunnelUp = true;
    expect(await notes()).toEqual([]);
  });

  it('says when the cloud has no relay, and when this Tower can send but not receive', async () => {
    harness.cloud.refreshProblem = null;
    harness.cloud.relay = { state: 'none', why: 'stated-none' };
    harness.cloud.tunnelUp = false;
    const printed = (await run((d) => peerList({}, d))).printed;
    expect(printed.filter((line) => line.startsWith('[info]'))).toEqual([
      '[info] This Codev Cloud has no relay: remote messaging is unavailable.',
      "[info] This Tower's own tunnel is down: it can send, but cannot receive; mail for it waits at its senders.",
    ]);
    harness.cloud.relay = { state: 'none', why: 'insecure' };
    harness.cloud.tunnelUp = true;
    expect((await run((d) => peerList({}, d))).printed.at(-1)).toContain('its server URL is plain http: on a host that is not this machine');
  });

  it('says so when the account has no other Tower, and when this Tower has never listed its peers', async () => {
    harness.cloud.refreshProblem = null;
    store.writeListing(harness.db, { relay: { protocols: [1] }, limits: { messagesPerTowerPerMinute: 60, messagesPerPairPerMinute: 30, queriesPerPairPerMinute: 10 }, towers: [], fetchedFor: FETCHED_FOR }, harness.clock.now);
    expect((await run((d) => peerList({}, d))).printed).toEqual([
      'Remote messaging: off — a human turns it on with: afx peer on',
      'No other Towers are on your Codev Cloud account.',
    ]);
  });
});

describe('reporting a switch change to Codev Cloud', () => {
  it('reports each change, and only a change, with nothing more printed while the report is under way', async () => {
    expect((await run((d) => peerOn(HUMAN, d))).printed).toHaveLength(1);
    await run((d) => peerOn(HUMAN, d));
    expect((await run((d) => peerOff({}, d))).printed).toHaveLength(1);
    await run((d) => peerOff({}, d));
    expect(harness.cloud.reported).toEqual(['on', 'off']);
    const answer = await harness.raw('GET', '/api/peer/switch');
    expect(answer.body.cloudReport).toBeNull();
  });

  it('says the cloud learns of it on reconnect when the tunnel is down', async () => {
    harness.cloud.report = 'tunnel-down';
    expect((await run((d) => peerOn(HUMAN, d))).printed).toEqual([
      '[ok] Remote messaging is on for ana-s-mbp. No Tower may message it yet. Allow one with: afx peer grant <tower> …',
      "[info] This Tower's tunnel is down: Codev Cloud learns of the change when it reconnects.",
    ]);
  });

  it('keeps the change when the report cannot even start, and says so', async () => {
    harness.cloud.report = 'throws';
    const on = await harness.raw('PUT', '/api/peer/switch', { state: 'on', humanApproved: true });
    expect(on).toMatchObject({ status: 200, body: { state: 'on', changed: true, cloudReport: 'failed' } });
    expect(store.readRemoteMessaging(harness.db).state).toBe('on');
    expect(harness.logged).toContain('ERROR Peer: the switch change could not be reported to Codev Cloud: cloud-config.json is not valid JSON');
    expect((await run((d) => peerOff({}, d))).printed.at(-1)).toBe(
      '[info] Codev Cloud could not be told of the change now (see the Tower log); it learns of it when the tunnel next connects.',
    );
  });
});

describe('a grant naming a Tower that is not in the cached list', () => {
  it('refreshes the list once and finds a Tower new to it', async () => {
    harness.cloud.onRefresh = () =>
      store.writeListing(
        harness.db,
        {
          relay: { protocols: [1] },
          limits: { messagesPerTowerPerMinute: 60, messagesPerPairPerMinute: 30, queriesPerPairPerMinute: 10 },
          towers: [tower(MBP, 'mbp'), tower(DEVVM, 'devvm'), tower('01JSTUDIO00000000000000AA', 'studio')],
          fetchedFor: FETCHED_FOR,
        },
        harness.clock.now,
      );
    const granted = await run((d) => peerGrant({ tower: 'studio', addresses: ['codev:architect:local'], ...HUMAN }, d));
    expect(granted.error).toBeNull();
    expect(harness.cloud.refreshes).toBe(1);
    expect(store.listGrants(harness.db).map((g) => g.peerTowerId)).toEqual(['01JSTUDIO00000000000000AA']);
  });

  it('refuses a name still unknown after the refresh, and does not refresh for a listed one', async () => {
    const refused = await run((d) => peerGrant({ tower: 'nowhere', all: true, ...HUMAN }, d));
    expect(refused.error).toBe(`No Tower named 'nowhere' is in this Tower's peer list (its peer list was last refreshed ${new Date(T0).toISOString()}). (UNKNOWN_TOWER)`);
    expect(harness.cloud.refreshes).toBe(1);
    await run((d) => peerGrant({ tower: 'devvm', all: true, ...HUMAN }, d));
    expect(harness.cloud.refreshes).toBe(1);
  });
});

describe('talking to a Tower that cannot answer', () => {
  it('says Tower is not running when nothing listens, and that it is older when it has no peer routes', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const nothing = { ...harness.deps, client: new TowerClient({ host: '127.0.0.1', port }) };
    expect((await run(() => peerGrants({}, nothing))).error).toBe('Tower is not running. Start it with: afx tower start');

    const old = http.createServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    });
    await new Promise<void>((resolve) => old.listen(0, '127.0.0.1', resolve));
    const olderTower = { ...harness.deps, client: new TowerClient({ host: '127.0.0.1', port: (old.address() as AddressInfo).port }) };
    try {
      expect((await run(() => peerOff({}, olderTower))).error).toContain('The running Tower is older than this CLI: it has no remote-messaging switch.');
    } finally {
      await new Promise<void>((resolve) => old.close(() => resolve()));
    }
  });
});
