/**
 * Spec 1967, phase 4: grants, and the settings they are enforced with.
 *
 * Layer A, pure functions over a hand-built world and an injected clock:
 *
 * 1. **The matcher** over a table of grants and recipients: default deny, exactly what each of
 *    Decision 4's four scopes covers, the front door resolved at the moment of asking, an
 *    architect grant following its name, and overlapping grants held if any holds.
 * 2. **What a grant request names**: the checks a grant makes when it is created, and how a
 *    grant reads back, including one that matches nothing now.
 * 3. **The peer a tower-ref names**, from the cached listing.
 * 4. **The peer settings**: defaults, and a record retention below 30 days used as 30, by the
 *    resolver and by the drainer's prune pass.
 */

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { PeerListingTower } from '@cluesmith/codev-types';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import * as store from '../peer/store.js';
import {
  describeGrant,
  frontDoorOf,
  grantCovers,
  matchGrant,
  peerNameOf,
  resolveGrantTargets,
  resolvePeerTower,
  type GrantRecipient,
  type GrantWorld,
} from '../peer/grants.js';
import { isRemoteMessagingOn, readSwitch, setSwitch } from '../peer/switch.js';
import { resolvePeerSettings } from '../../lib/config.js';
import { MailboxDrainer, type DeliveryPorts } from '../servers/mailbox-delivery.js';
import type { RegisteredWorkspace } from '../utils/workspace-address.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);

const CODEV = '/work/codev';
const OTHER = '/work/other';
const EMPTY = '/work/empty';
const STOPPED = '/work/stopped';
const PEER_A = '01JMBP000000000000000000AA';
const PEER_B = '01JDEVVM0000000000000000AA';
const PEER_C = '01JSTUDIO000000000000000AA';
const SELF = '01JSELF0000000000000000AAA';

/** A world whose workspaces and architects a test can change between calls. */
function makeWorld(initial: Record<string, string[]>, extra: { registered?: RegisteredWorkspace[]; running?: string[] } = {}) {
  const architects = new Map(Object.entries(initial));
  const registered: RegisteredWorkspace[] =
    extra.registered ?? [...architects.keys()].map((workspacePath) => ({ workspacePath, explicitName: null }));
  const world: GrantWorld & { architects: Map<string, string[]>; registered: RegisteredWorkspace[] } = {
    architects,
    registered,
    running: extra.running ?? [...architects.keys()].filter((p) => p !== STOPPED),
    architectsOf: (workspacePath: string) => architects.get(workspacePath) ?? [],
  };
  return world;
}

function grant(overrides: Partial<store.PeerGrant> & Pick<store.PeerGrant, 'scope'>): store.PeerGrant {
  return {
    peerTowerId: PEER_A,
    workspacePath: overrides.scope === 'all' ? null : CODEV,
    architect: null,
    mode: 'deliver',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

const architect = (workspacePath: string, name: string): GrantRecipient => ({ workspacePath, kind: 'architect', name });
const builder = (workspacePath: string, name: string): GrantRecipient => ({ workspacePath, kind: 'builder', name });
const shell = (workspacePath: string, name: string): GrantRecipient => ({ workspacePath, kind: 'shell', name });

// ===========================================================================
// 1. The matcher
// ===========================================================================

describe('the matcher', () => {
  const world = makeWorld({ [CODEV]: ['main', 'review'], [OTHER]: ['local'], [EMPTY]: [] });
  const grants: store.PeerGrant[] = [
    grant({ scope: 'front-door' }),
    grant({ scope: 'architect', architect: 'review', mode: 'hold' }),
    grant({ scope: 'architects', workspacePath: OTHER }),
    grant({ peerTowerId: PEER_B, scope: 'all' }),
  ];

  it('refuses every recipient when there is no grant at all (default deny)', () => {
    for (const recipient of [architect(CODEV, 'main'), architect(OTHER, 'local'), builder(CODEV, 'builder-spir-1'), shell(CODEV, 'shell-1')]) {
      expect(matchGrant([], PEER_A, recipient, world)).toBeNull();
    }
  });

  it('refuses a peer that holds no grant, whatever other peers hold', () => {
    expect(matchGrant(grants, PEER_C, architect(CODEV, 'main'), world)).toBeNull();
    expect(matchGrant(grants, PEER_C, builder(CODEV, 'builder-spir-1'), world)).toBeNull();
  });

  // Each row: recipient, and which of the four grants above covers it.
  const table: Array<[string, GrantRecipient, string | null, Array<store.PeerGrantScope>]> = [
    ['the front door (main) under peer A', architect(CODEV, 'main'), PEER_A, ['front-door']],
    ['a named architect under peer A', architect(CODEV, 'review'), PEER_A, ['architect']],
    ['an architect of a workspace granted whole', architect(OTHER, 'local'), PEER_A, ['architects']],
    ['a builder under peer A (no grant covers builders but --all)', builder(CODEV, 'builder-spir-1'), PEER_A, []],
    ['an architect of a workspace peer A has no grant in', architect(EMPTY, 'ghost'), PEER_A, []],
    ['a builder under --all', builder(CODEV, 'builder-spir-1'), PEER_B, ['all']],
    ['an architect under --all', architect(OTHER, 'local'), PEER_B, ['all']],
    ['a shell under --all', shell(CODEV, 'shell-1'), PEER_B, []],
    ['a shell where peer A has every architect', shell(OTHER, 'shell-1'), PEER_A, []],
  ];
  for (const [label, recipient, peer, scopes] of table) {
    it(`covers exactly what Decision 4 says: ${label}`, () => {
      const covering = grants.filter((g) => g.peerTowerId === peer && grantCovers(g, recipient, world)).map((g) => g.scope);
      expect(covering).toEqual(scopes);
      const match = matchGrant(grants, peer as string, recipient, world);
      if (scopes.length === 0) expect(match).toBeNull();
      else expect(match?.grants.map((g) => g.scope)).toEqual(scopes);
    });
  }

  it('gives a match the mode of its grant', () => {
    expect(matchGrant(grants, PEER_A, architect(CODEV, 'main'), world)?.mode).toBe('deliver');
    expect(matchGrant(grants, PEER_A, architect(CODEV, 'review'), world)?.mode).toBe('hold');
  });

  it('holds mail for release when any of several matching grants holds it, in either order', () => {
    const overlapping = [grant({ scope: 'all', mode: 'deliver' }), grant({ scope: 'architect', architect: 'main', mode: 'hold' })];
    for (const order of [overlapping, [...overlapping].reverse()]) {
      const match = matchGrant(order, PEER_A, architect(CODEV, 'main'), world);
      expect(match?.mode).toBe('hold');
      expect(match?.grants).toHaveLength(2);
    }
    // The hold covers only main; review is still delivered under --all.
    expect(matchGrant(overlapping, PEER_A, architect(CODEV, 'review'), world)?.mode).toBe('deliver');
  });

  it('matches a workspace by its key, in any spelling that key accepts', () => {
    const g = grant({ scope: 'architects', workspacePath: CODEV });
    expect(grantCovers(g, architect(CODEV, 'main'), world)).toBe(true);
    expect(grantCovers(g, architect(`${CODEV}-2`, 'main'), world)).toBe(false);
  });

  it('resolves the front door when mail arrives: it follows the default architect when main is removed', () => {
    const live = makeWorld({ [CODEV]: ['main', 'review', 'third'] });
    const frontDoor = grant({ scope: 'front-door' });
    expect(frontDoorOf(live, CODEV)).toBe('main');
    expect(grantCovers(frontDoor, architect(CODEV, 'main'), live)).toBe(true);
    expect(grantCovers(frontDoor, architect(CODEV, 'review'), live)).toBe(false);

    live.architects.set(CODEV, ['review', 'third']); // main removed: the first registered is the front door
    expect(grantCovers(frontDoor, architect(CODEV, 'review'), live)).toBe(true);
    expect(grantCovers(frontDoor, architect(CODEV, 'third'), live)).toBe(false);

    live.architects.set(CODEV, ['main', 'review', 'third']); // main back: the front door is main again
    expect(grantCovers(frontDoor, architect(CODEV, 'main'), live)).toBe(true);
    expect(grantCovers(frontDoor, architect(CODEV, 'review'), live)).toBe(false);

    live.architects.set(CODEV, []); // no architect: the front door reaches nobody
    expect(frontDoorOf(live, CODEV)).toBeNull();
    expect(grantCovers(frontDoor, architect(CODEV, 'main'), live)).toBe(false);
  });

  it('lets an architect grant follow the name: it stops matching when the architect is removed, and applies again when the name returns', () => {
    const live = makeWorld({ [CODEV]: ['main', 'review'] });
    const named = grant({ scope: 'architect', architect: 'review' });
    expect(grantCovers(named, architect(CODEV, 'review'), live)).toBe(true);
    live.architects.set(CODEV, ['main']);
    expect(grantCovers(named, architect(CODEV, 'review'), live)).toBe(false);
    expect(describeGrant(named, live).matchesNothing).toBe('architect review is not registered in codev');
    live.architects.set(CODEV, ['main', 'review']);
    expect(grantCovers(named, architect(CODEV, 'review'), live)).toBe(true);
    expect(describeGrant(named, live).matchesNothing).toBeNull();
  });

  it('covers every architect of a workspace under --workspace, as they come and go, and no builder', () => {
    const live = makeWorld({ [CODEV]: ['main'] });
    const whole = grant({ scope: 'architects' });
    expect(grantCovers(whole, architect(CODEV, 'main'), live)).toBe(true);
    expect(grantCovers(whole, architect(CODEV, 'late'), live)).toBe(false);
    live.architects.set(CODEV, ['main', 'late']);
    expect(grantCovers(whole, architect(CODEV, 'late'), live)).toBe(true);
    expect(grantCovers(whole, builder(CODEV, 'builder-spir-1'), live)).toBe(false);
  });
});

// ===========================================================================
// 2. What a grant request names, and how a grant reads back
// ===========================================================================

describe('what a grant request names', () => {
  const world = makeWorld(
    { [CODEV]: ['main', 'review'], [OTHER]: ['local'], [STOPPED]: ['main'] },
    {
      registered: [
        { workspacePath: CODEV, explicitName: null },
        { workspacePath: OTHER, explicitName: 'tools' },
        { workspacePath: STOPPED, explicitName: null },
      ],
    },
  );

  const targets = (input: Parameters<typeof resolveGrantTargets>[0], purpose: 'grant' | 'revoke' = 'grant') =>
    resolveGrantTargets(input, world, purpose);

  it('reads a named architect, a front door and its `arch` alias', () => {
    expect(targets({ addresses: ['codev:architect:review'] })).toEqual({
      ok: true,
      targets: [{ scope: 'architect', workspacePath: CODEV, architect: 'review' }],
    });
    for (const text of ['codev:architect', 'codev:arch', '  CODEV:Architect ']) {
      expect(targets({ addresses: [text] })).toEqual({
        ok: true,
        targets: [{ scope: 'front-door', workspacePath: CODEV, architect: null }],
      });
    }
  });

  it('reads --workspace as every architect, and --all as everything', () => {
    expect(targets({ workspace: 'codev' })).toEqual({ ok: true, targets: [{ scope: 'architects', workspacePath: CODEV, architect: null }] });
    expect(targets({ all: true })).toEqual({ ok: true, targets: [{ scope: 'all', workspacePath: null, architect: null }] });
  });

  it('reads several addresses, once each', () => {
    const read = targets({ addresses: ['codev:architect:main', 'tools:architect:local', 'codev:architect:main'] });
    expect(read).toEqual({
      ok: true,
      targets: [
        { scope: 'architect', workspacePath: CODEV, architect: 'main' },
        { scope: 'architect', workspacePath: OTHER, architect: 'local' },
      ],
    });
  });

  it('accepts a workspace that is registered but not running', () => {
    expect(targets({ addresses: ['stopped:architect:main'] })).toEqual({
      ok: true,
      targets: [{ scope: 'architect', workspacePath: STOPPED, architect: 'main' }],
    });
  });

  it('names a workspace by its explicit name, and not by the basename that name replaced', () => {
    expect(targets({ workspace: 'tools' })).toMatchObject({ ok: true, targets: [{ workspacePath: OTHER }] });
    const byBasename = targets({ workspace: 'other' });
    expect(byBasename).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(!byBasename.ok && byBasename.message).toContain("addressed as 'tools'");
  });

  it('refuses a grant for a workspace that is not registered', () => {
    for (const input of [{ addresses: ['nosuch:architect:main'] }, { workspace: 'nosuch' }]) {
      const read = targets(input);
      expect(read).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      expect(!read.ok && read.message).toContain('No workspace with that name or directory name is registered');
    }
  });

  it('refuses a grant for an architect that does not exist, naming those that do', () => {
    const read = targets({ addresses: ['codev:architect:ghost'] });
    expect(read).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(!read.ok && read.message).toBe("Architect 'ghost' is not registered in workspace 'codev'. Architects there: main, review.");
  });

  it('refuses the whole request when one address is refused', () => {
    expect(targets({ addresses: ['codev:architect:main', 'codev:architect:ghost'] })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('refuses two workspaces that share a basename, as ambiguous', () => {
    const twins = makeWorld({ '/a/codev': ['main'], '/b/codev': ['main'] });
    const read = resolveGrantTargets({ workspace: 'codev' }, twins, 'grant');
    expect(read).toMatchObject({ ok: false, code: 'AMBIGUOUS' });
  });

  it('refuses a builder or a shell, pointing at --all', () => {
    const read = targets({ addresses: ['codev:builder-spir-1'] });
    expect(read).toMatchObject({ ok: false, code: 'NOT_GRANTABLE' });
    expect(!read.ok && read.message).toContain('builders are covered only by --all');
  });

  it('refuses an address that leaves this Tower, one with no workspace, and one that does not parse', () => {
    expect(targets({ addresses: ['afx://mbp/codev:architect'] })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    const bare = targets({ addresses: ['architect:main'] });
    expect(bare).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(!bare.ok && bare.message).toContain('<workspace>:architect:main');
    expect(targets({ addresses: ['codev::architect'] })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
  });

  it('needs exactly one way of naming recipients', () => {
    expect(targets({})).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(targets({ addresses: [] })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(targets({ addresses: ['codev:architect'], all: true })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(targets({ workspace: 'codev', all: true })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
  });

  it('for a revocation, names every grant when nothing is named, and does not need the architect to exist', () => {
    expect(targets({}, 'revoke')).toEqual({ ok: true, targets: null });
    expect(targets({ addresses: ['codev:architect:ghost'] }, 'revoke')).toEqual({
      ok: true,
      targets: [{ scope: 'architect', workspacePath: CODEV, architect: 'ghost' }],
    });
  });
});

describe('how a grant reads back', () => {
  it('says what each scope covers, and where a front door leads now', () => {
    const world = makeWorld({ [CODEV]: ['main', 'review'] });
    expect(describeGrant(grant({ scope: 'front-door' }), world)).toEqual({
      workspaceName: 'codev',
      recipient: 'codev:architect',
      reaches: 'main',
      matchesNothing: null,
    });
    expect(describeGrant(grant({ scope: 'architect', architect: 'review' }), world).recipient).toBe('codev:architect:review');
    expect(describeGrant(grant({ scope: 'architects' }), world).recipient).toBe('every architect in codev');
    expect(describeGrant(grant({ scope: 'all' }), world)).toEqual({
      workspaceName: null,
      recipient: 'everything',
      reaches: null,
      matchesNothing: null,
    });
  });

  it('says why a grant matches nothing: its workspace is gone, or has no architect', () => {
    const world = makeWorld({ [CODEV]: [] });
    expect(describeGrant(grant({ scope: 'front-door' }), world).matchesNothing).toBe('codev has no architect');
    expect(describeGrant(grant({ scope: 'architects' }), world).matchesNothing).toBe('codev has no architect');
    const gone = grant({ scope: 'architect', workspacePath: '/work/removed', architect: 'main' });
    expect(describeGrant(gone, world)).toMatchObject({
      workspaceName: null,
      recipient: '/work/removed:architect:main',
      matchesNothing: 'workspace /work/removed is no longer registered on this Tower',
    });
  });

  it('names a workspace that has no address name by its path', () => {
    const twins = makeWorld({ '/a/codev': ['main'], '/b/codev': ['main'] });
    const described = describeGrant(grant({ scope: 'front-door', workspacePath: '/a/codev' }), twins);
    expect(described.workspaceName).toBeNull();
    expect(described.recipient).toBe('/a/codev:architect');
    expect(described.matchesNothing).toBeNull();
  });
});

// ===========================================================================
// 3. The peer a tower-ref names
// ===========================================================================

describe('the peer a tower-ref names', () => {
  const tower = (towerId: string, slug: string): PeerListingTower => ({
    towerId,
    slug,
    online: true,
    protocols: [1],
    remoteMessaging: 'on',
  });
  const listing: store.CachedListing = {
    refreshedAt: T0,
    relayProtocols: [1],
    limits: null,
    towers: [tower(PEER_A, 'mbp'), tower(PEER_B, 'devvm')],
  };
  const names: store.PeerTowerName[] = [
    { towerId: PEER_A, slug: 'mbp', firstSeenAt: T0, lastSeenAt: T0 },
    { towerId: PEER_A, slug: 'old-laptop', firstSeenAt: T0 - 9 * DAY, lastSeenAt: T0 - 5 * DAY },
    { towerId: PEER_C, slug: 'studio', firstSeenAt: T0 - 9 * DAY, lastSeenAt: T0 - 2 * DAY },
  ];
  const own = { name: 'ana-s-mbp', towerId: SELF };

  it('resolves a current name to the Tower id, whatever case it is typed in', () => {
    expect(resolvePeerTower('devvm', listing, names, own, 'grant')).toEqual({ ok: true, towerId: PEER_B, name: 'devvm' });
    expect(resolvePeerTower(' MBP ', listing, names, own, 'grant')).toEqual({ ok: true, towerId: PEER_A, name: 'mbp' });
  });

  it('refuses a former name for a grant, naming the current one; accepts it to find an existing grant', () => {
    const forGrant = resolvePeerTower('old-laptop', listing, names, own, 'grant');
    expect(forGrant).toMatchObject({ ok: false, code: 'UNKNOWN_TOWER' });
    expect(!forGrant.ok && forGrant.message).toBe("'old-laptop' is a former name of the Tower now called 'mbp'. Name it 'mbp'.");
    expect(resolvePeerTower('old-laptop', listing, names, own, 'existing')).toEqual({ ok: true, towerId: PEER_A, name: 'mbp' });
  });

  it('finds a Tower no longer listed by the last name it had, only to find an existing grant', () => {
    const forGrant = resolvePeerTower('studio', listing, names, own, 'grant');
    expect(forGrant).toMatchObject({ ok: false, code: 'UNKNOWN_TOWER' });
    expect(!forGrant.ok && forGrant.message).toContain('no longer in');
    expect(resolvePeerTower('studio', listing, names, own, 'existing')).toEqual({ ok: true, towerId: PEER_C, name: 'studio' });
    expect(peerNameOf(PEER_C, listing, names)).toBe('studio');
    expect(peerNameOf('01JNEVERSEEN00000000000000', listing, names)).toBeNull();
  });

  it('refuses a name it has never seen, saying when the peer list was refreshed', () => {
    const unknown = resolvePeerTower('nas', listing, names, own, 'grant');
    expect(unknown).toMatchObject({ ok: false, code: 'UNKNOWN_TOWER' });
    expect(!unknown.ok && unknown.message).toBe(
      `No Tower named 'nas' is in this Tower's peer list (its peer list was last refreshed ${new Date(T0).toISOString()}).`,
    );
    const never = resolvePeerTower('nas', { refreshedAt: null, relayProtocols: null, limits: null, towers: [] }, [], own, 'grant');
    expect(!never.ok && never.message).toContain('this Tower has not listed its peers yet');
  });

  it("refuses another owner's Tower as not available yet (stage 3)", () => {
    const other = resolvePeerTower('sam@studio', listing, names, own, 'grant');
    expect(other).toMatchObject({ ok: false, code: 'NOT_AVAILABLE' });
    expect(!other.ok && other.message).toContain("named alone, as in 'studio'");
  });

  it('refuses this Tower itself, by its name or by a listing that shows its id', () => {
    expect(resolvePeerTower('ana-s-mbp', listing, names, own, 'grant')).toMatchObject({ ok: false, code: 'NOT_A_PEER' });
    const listsSelf = { ...listing, towers: [...listing.towers, tower(SELF, 'me')] };
    expect(resolvePeerTower('me', listsSelf, names, own, 'grant')).toMatchObject({ ok: false, code: 'NOT_A_PEER' });
  });

  it('refuses text that is not a Tower name', () => {
    for (const text of ['', 'afx://mbp', 'mbp/codev:architect', 'MB_P', 'a@b@c']) {
      expect(resolvePeerTower(text, listing, names, own, 'grant')).toMatchObject({ ok: false });
    }
    expect(resolvePeerTower('afx://mbp', listing, names, own, 'grant')).toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('quotes refused text back as printable ASCII, cut short, never as the terminal bytes it carried', () => {
    const esc = String.fromCodePoint(0x1b);
    const bel = String.fromCodePoint(0x07);
    const hostile = `${esc}]0;owned${bel}${esc}[2J${'z'.repeat(200)}`;
    const tower = resolvePeerTower(hostile, listing, names, own, 'grant');
    const world = makeWorld({ [CODEV]: ['main'] });
    const address = resolveGrantTargets({ addresses: [`codev:${hostile}`] }, world, 'grant');
    const named = resolveGrantTargets({ addresses: [`codev:architect:${hostile}`] }, world, 'revoke');
    const workspace = resolveGrantTargets({ workspace: hostile }, world, 'grant');
    for (const refused of [address, named, workspace]) {
      expect(refused).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
      expect(!refused.ok && refused.message).toContain('contains a control character');
    }
    // A format character is not a control character, so it reaches the refusal for a builder
    // address, which quotes the address printable as well.
    const rlo = String.fromCodePoint(0x202e);
    const builderAddress = resolveGrantTargets({ addresses: [`codev:builder-${rlo}x`] }, world, 'grant');
    expect(builderAddress).toMatchObject({ ok: false, code: 'NOT_GRANTABLE' });
    expect(!builderAddress.ok && builderAddress.message).toMatch(/^[\x20-\x7e]*$/);
    for (const refused of [tower, address, named, workspace]) {
      expect(refused.ok).toBe(false);
      const message = refused.ok ? '' : refused.message;
      expect(message).toMatch(/^[\x20-\x7e]*$/);
      expect(message).not.toContain('z'.repeat(100));
      expect(message).toContain('...');
    }
  });

  it('refuses a former name two Towers have had, as ambiguous', () => {
    const shared: store.PeerTowerName[] = [
      { towerId: PEER_A, slug: 'box', firstSeenAt: T0, lastSeenAt: T0 },
      { towerId: PEER_C, slug: 'box', firstSeenAt: T0, lastSeenAt: T0 },
    ];
    expect(resolvePeerTower('box', listing, shared, own, 'existing')).toMatchObject({ ok: false, code: 'AMBIGUOUS' });
  });
});

// ===========================================================================
// 4. The switch, and the peer settings
// ===========================================================================

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(GLOBAL_SCHEMA);
  dbs.push(db);
  return db;
}

describe('the switch', () => {
  it('is off on a fresh install, turns on and off, and changes nothing when asked for the state it is in', () => {
    const db = freshDb();
    expect(readSwitch(db)).toEqual({ state: 'off', changedAt: null });
    expect(isRemoteMessagingOn(db)).toBe(false);
    // Off already: asking for off writes nothing, so it has still never been changed.
    expect(setSwitch(db, 'off', T0)).toEqual({ state: 'off', changed: false, changedAt: null });
    expect(setSwitch(db, 'on', T0 + 1000)).toEqual({ state: 'on', changed: true, changedAt: T0 + 1000 });
    expect(isRemoteMessagingOn(db)).toBe(true);
    expect(setSwitch(db, 'on', T0 + 2000)).toEqual({ state: 'on', changed: false, changedAt: T0 + 1000 });
    expect(readSwitch(db)).toEqual({ state: 'on', changedAt: T0 + 1000 });
  });
});

describe('the peer settings', () => {
  it('defaults to the approved spec: 30 a minute, 50 undelivered, 50 waiting, records kept 30 days', () => {
    expect(resolvePeerSettings({})).toEqual({
      limits: { acceptedPerPeerPerMinute: 30, undeliveredPerPeer: 50, waitingPerPeer: 50 },
      recordRetentionDays: 30,
    });
  });

  it('takes each configured value, and uses a record retention below 30 days as 30', () => {
    expect(
      resolvePeerSettings({ peer: { limits: { acceptedPerPeerPerMinute: 10, undeliveredPerPeer: 5 }, recordRetentionDays: 90 } }),
    ).toEqual({ limits: { acceptedPerPeerPerMinute: 10, undeliveredPerPeer: 5, waitingPerPeer: 50 }, recordRetentionDays: 90 });
    for (const days of [7, 0, -3, 29.9]) {
      expect(resolvePeerSettings({ peer: { recordRetentionDays: days } }).recordRetentionDays).toBe(30);
    }
  });

  it('refuses a malformed value, naming its key', () => {
    const bad = (peer: unknown) => () => resolvePeerSettings({ peer } as Parameters<typeof resolvePeerSettings>[0]);
    expect(bad({ limits: { acceptedPerPeerPerMinute: 0 } })).toThrow('peer.limits.acceptedPerPeerPerMinute');
    expect(bad({ limits: { undeliveredPerPeer: 2.5 } })).toThrow('peer.limits.undeliveredPerPeer');
    expect(bad({ limits: { waitingPerPeer: '50' } })).toThrow('peer.limits.waitingPerPeer');
    expect(bad({ recordRetentionDays: 'forever' })).toThrow('peer.recordRetentionDays');
  });

  it("is used by the drainer's prune pass, which keeps 30 days of records when told to keep 7", () => {
    const db = freshDb();
    const record = (ageDays: number) =>
      store.insertRecord(db, {
        direction: 'outbound',
        at: T0 - ageDays * DAY,
        kind: 'message',
        peerTowerId: PEER_A,
        peerSlug: 'mbp',
        tunnelSession: null,
        messageId: null,
        fromAddress: null,
        toAddress: null,
        payloadSize: 10,
        outcome: 'delivered',
        reason: null,
      });
    record(8);
    record(29);
    record(31);
    const drainer = new MailboxDrainer({ intervalMs: 60_000, peerRecordRetentionDays: 7 });
    drainer.start({ now: () => T0 } as unknown as DeliveryPorts, db); // the boot prune
    drainer.stop();
    expect(store.listRecords(db).map((r) => Math.round((T0 - r.at) / DAY)).sort((a, b) => a - b)).toEqual([8, 29]);
  });
});
