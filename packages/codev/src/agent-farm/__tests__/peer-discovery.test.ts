/**
 * Discovery across Towers (Spec 1967, plan phase 10, layer A; approved spec Decision 6;
 * contract section 6, "From R, kind `query`").
 *
 * At the receiving Tower, through the real receiver over an in-memory global database and
 * an injected clock, with a hand-built set of workspaces and agents:
 *
 * - every grant scope lists exactly what it covers: one architect; a front door (the
 *   architect it reaches now); a workspace's architects; under `--all` every workspace's
 *   architects and builders by id. Never a shell, never a workspace without an address
 *   name, never an address that a message would not reach. Overlapping grants list each
 *   address once; a hold grant counts; grants that cover nothing now answer an empty list;
 * - the refusals, each storing nothing: no grant (`no-grant`), the switch off, another
 *   owner, a payload that does not fit, a clock out of range;
 * - the limit: the 11th answered query in a minute from one peer is `rate-limited`, with the
 *   seconds left in that minute; the next minute answers again; another peer, and refused
 *   queries, are not counted against it;
 * - an answer over 65 536 bytes is trimmed, in order, and marked `truncated`;
 * - the inbound record of each query, without addresses.
 *
 * At the sending Tower, `Sender.show` with a scripted cloud client and peer list:
 *
 * - the answer as `afx://<tower>/…` addresses, and the call it made: kind `query`, its own
 *   id, the query payload, not through the outbox;
 * - this Tower's own refusals, in order, with no call; checks 1 to 4 read again after the
 *   name resolves;
 * - every answer but `answered` refuses, never holds: an offline peer, an unreachable cloud,
 *   no answer, the cloud's ceiling `429`, the peer's `no-grant` (naming the command that
 *   adds one) and `rate-limited`, `not-verified`, a key the cloud rejects;
 * - an answer under a registration since replaced is refused;
 * - a query is not queued behind messages: with a message's relay call in flight to the
 *   peer through the real outbox, `afx peer show` is answered;
 * - the outbound record of each query.
 *
 * And `GET /api/peer/show` with `afx peer show`, through the SDK's own client.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { TowerClient } from '@cluesmith/codev-sdk/tower-client';
import { PEER_MAX_ANSWER_BYTES, type PeerCloudRelay, type PeerListingTower, type PeerStatement, type PeerWireAddress } from '@cluesmith/codev-types';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import { classifyRelayAnswer, encodeMessagePayload, encodeQueryPayload, type ClassifiedAnswer } from '../peer/contract.js';
import { QUERIES_PER_PEER_PER_MINUTE, type DiscoveryWorkspace } from '../peer/discovery.js';
import type { GrantWorld } from '../peer/grants.js';
import { Outbox } from '../peer/outbox.js';
import type { OwnRegistration, PeerNameResolution } from '../peer/peer-list.js';
import { createReceiver, type ReceiverDeps, type RecipientLookup } from '../peer/receiver.js';
import { Sender, type PeerShowResult } from '../peer/sender.js';
import * as store from '../peer/store.js';
import { setSwitch } from '../peer/switch.js';
import type { RelayCall, RelayRequest } from '../peer/cloud-client.js';
import type { VerifiedPeerRequest } from '../lib/tunnel-client.js';
import { createPeerRouteHandler, type PeerRouteDeps } from '../servers/peer-routes.js';
import { peerShow, shownLines, type PeerDeps } from '../commands/peer.js';
import { resolvePeerSettings } from '../../lib/config.js';
import { ManualClock } from './helpers/peer-cloud-fixtures.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** On a minute boundary, so the limit's window starts with the test. */
const T0 = Date.UTC(2026, 10, 21, 3, 34, 0, 0);
const DEVVM = '01JDEVVM0000000000000000AA';
const MBP = '01JMBP000000000000000000AA';
const STUDIO = '01JSTUDIO00000000000000AAA';
const CODEV = '/work/codev';
const NOTES = '/work/notes';
const UNNAMED = '/work/unnamed';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const utf8 = (text: string) => new TextEncoder().encode(text);

// ===========================================================================
// The receiving Tower (devvm)
// ===========================================================================

interface Listed {
  address: { workspace: string; kind: string; name: string };
  live: boolean;
}

interface Answer {
  v: number;
  outcome: string;
  reason?: string;
  retryAfterSec?: number;
  truncated?: boolean;
  addresses?: Listed[];
}

/**
 * devvm: `codev` with architects `main` and `local` and two builders (one with no live
 * terminal); `notes`, whose architect and builder have no live terminal; a workspace with no
 * address name. `codev` also has `shell-1`, which step 13 calls not addressable, and an
 * agent whose address resolves to someone else. As on a real Tower, step 13 finds no agent
 * in a workspace that is not running.
 */
class Receiving {
  readonly db = new Database(':memory:');
  readonly clock = { now: T0 };
  readonly architects = new Map<string, string[]>([
    [CODEV, ['main', 'local']],
    [NOTES, ['main']],
    [UNNAMED, ['main']],
  ]);
  readonly builders = new Map<string, string[]>([
    [CODEV, ['builder-spir-12', 'builder-spir-34']],
    [NOTES, ['builder-air-7']],
    [UNNAMED, []],
  ]);
  readonly live = new Set(['codev/main', 'codev/local', 'codev/builder-spir-12']);
  readonly world: GrantWorld = {
    registered: [
      { workspacePath: CODEV, explicitName: null },
      { workspacePath: NOTES, explicitName: null },
      { workspacePath: UNNAMED, explicitName: null },
    ],
    running: [CODEV, NOTES, UNNAMED],
    architectsOf: (workspacePath) => this.architects.get(workspacePath) ?? [],
  };
  /** Extra seats a test adds to `codev`, as the Tower would find them. */
  extraSeats: DiscoveryWorkspace['seats'][number][] = [];
  readonly logs: string[] = [];

  readonly deps: ReceiverDeps = {
    db: () => this.db,
    now: () => this.clock.now,
    world: () => this.world,
    limits: () => ({ acceptedPerPeerPerMinute: 30, undeliveredPerPeer: 50 }),
    resolveRecipient: (address) => this.lookup(address),
    discoverable: () => this.workspaces(),
    deliverWithin: async () => {
      throw new Error('a query makes no delivery attempt');
    },
    onHeldChanged: () => {
      throw new Error('a query holds nothing');
    },
    log: (level, message) => this.logs.push(`${level} ${message}`),
  };

  receiver = createReceiver(this.deps);

  constructor() {
    this.db.exec(GLOBAL_SCHEMA);
    setSwitch(this.db, 'on', T0 - MINUTE);
  }

  private nameOf(workspacePath: string): string | null {
    return workspacePath === CODEV ? 'codev' : workspacePath === NOTES ? 'notes' : null;
  }

  workspaces(): DiscoveryWorkspace[] {
    return [CODEV, NOTES, UNNAMED].map((workspacePath) => {
      const name = this.nameOf(workspacePath) ?? 'unnamed';
      const seat = (kind: 'architect' | 'builder', agent: string) => ({ kind, name: agent, live: this.live.has(`${name}/${agent}`) });
      return {
        workspacePath,
        addressName: this.nameOf(workspacePath),
        seats: [
          ...(this.architects.get(workspacePath) ?? []).map((a) => seat('architect', a)),
          ...(this.builders.get(workspacePath) ?? []).map((b) => seat('builder', b)),
          ...(workspacePath === CODEV ? this.extraSeats : []),
        ],
      };
    });
  }

  /** Step 13 on devvm. */
  lookup(address: PeerWireAddress): RecipientLookup {
    const workspacePath = address.workspace === 'codev' ? CODEV : address.workspace === 'notes' ? NOTES : null;
    if (workspacePath === null || !this.world.running.includes(workspacePath)) return { found: false, reason: 'no-such-agent' };
    if (address.kind === 'architect') {
      const architects = this.world.architectsOf(workspacePath);
      const name = address.name ?? architects[0];
      if (name === undefined || !architects.includes(name)) return { found: false, reason: 'no-such-agent' };
      return { found: true, recipient: { workspacePath, kind: 'architect', name } };
    }
    if (address.name === 'shell-1') return { found: false, reason: 'not-addressable' };
    // Resolves, but to another agent (a tail match), which discovery must not list as itself.
    if (address.name === 'spir-12') return { found: true, recipient: { workspacePath, kind: 'builder', name: 'builder-spir-12' } };
    if ((this.builders.get(workspacePath) ?? []).includes(address.name as string)) {
      return { found: true, recipient: { workspacePath, kind: 'builder', name: address.name as string } };
    }
    return { found: false, reason: 'no-such-agent' };
  }

  grant(key: Omit<store.PeerGrantKey, 'peerTowerId'>, mode: store.PeerGrantMode = 'deliver', peer = MBP): void {
    store.putGrant(this.db, { peerTowerId: peer, ...key, mode }, this.clock.now);
  }

  /** A verified query as the entry point hands it on. */
  query(options: { payload?: Uint8Array; statement?: Partial<PeerStatement>; sentAt?: number } = {}): VerifiedPeerRequest {
    let payload = options.payload;
    if (payload === undefined) {
      const encoded = encodeQueryPayload(options.sentAt ?? this.clock.now);
      if (!encoded.ok) throw new Error('query payload');
      payload = encoded.bytes;
    }
    const statement: PeerStatement = {
      v: 1,
      kind: 'query',
      toTowerId: DEVVM,
      fromTowerId: MBP,
      fromTowerSlug: 'mbp',
      fromOwnerId: 'usr_ana',
      fromOwnerHandle: null,
      fromOwnerEmail: 'ana@example.com',
      sameOwner: true,
      requestId: randomUUID(),
      issuedAt: this.clock.now,
      statementId: randomBytes(16).toString('base64url'),
      payloadSha256: createHash('sha256').update(payload).digest('hex'),
      ...options.statement,
    };
    return { sessionId: 'tunnel-session-1', receivedAt: this.clock.now, answerBy: this.clock.now + 5_000, statement, payload };
  }

  async ask(request: VerifiedPeerRequest = this.query()): Promise<{ answer: Answer; bytes: number; outcomeHeader: string }> {
    const encoded = await this.receiver(request);
    expect(encoded.status).toBe(200);
    const answer = JSON.parse(Buffer.from(encoded.body).toString('utf8')) as Answer;
    expect(encoded.headers['x-codev-peer-outcome']).toBe(answer.outcome);
    return { answer, bytes: encoded.body.length, outcomeHeader: encoded.headers['x-codev-peer-outcome'] };
  }

  async listed(request?: VerifiedPeerRequest): Promise<string[]> {
    const { answer } = await this.ask(request);
    expect(answer.outcome, JSON.stringify(answer)).toBe('answered');
    return (answer.addresses ?? []).map((a) => `${a.address.workspace}:${a.address.kind === 'id' ? '' : 'architect:'}${a.address.name} ${a.live ? 'live' : '-'}`);
  }

  /** Nothing a query could leave: no mail, no accepted-once row. */
  stored(): number {
    const mail = this.db.prepare('SELECT COUNT(*) AS n FROM mailbox').get() as { n: number };
    const accepted = this.db.prepare('SELECT COUNT(*) AS n FROM peer_accepted').get() as { n: number };
    return mail.n + accepted.n;
  }

  records(): store.PeerRecordRow[] {
    return store.listRecords(this.db).reverse();
  }
}

describe('Spec 1967 phase 10: discovery at the receiving Tower', () => {
  let r: Receiving;
  beforeEach(() => {
    r = new Receiving();
  });
  afterEach(() => {
    r.db.close();
  });

  describe('what each grant covers', () => {
    it('one architect: that architect alone', async () => {
      r.grant({ scope: 'architect', workspacePath: CODEV, architect: 'local' });
      expect(await r.listed()).toEqual(['codev:architect:local live']);
    });

    it("a front door: the architect it reaches now, by name, which follows the front door", async () => {
      r.grant({ scope: 'front-door', workspacePath: CODEV, architect: null });
      expect(await r.listed()).toEqual(['codev:architect:main live']);
      r.architects.set(CODEV, ['local']);
      expect(await r.listed()).toEqual(['codev:architect:local live']);
    });

    it("a workspace's architects: each of them, in front-door order, and no builder", async () => {
      r.grant({ scope: 'architects', workspacePath: CODEV, architect: null });
      expect(await r.listed()).toEqual(['codev:architect:main live', 'codev:architect:local live']);
    });

    it('--all: every workspace\'s architects and builders by id, live or not, never a shell or an unnamed workspace', async () => {
      r.extraSeats = [{ kind: 'builder', name: 'shell-1', live: true }];
      r.grant({ scope: 'all', workspacePath: null, architect: null });
      expect(await r.listed()).toEqual([
        'codev:architect:main live',
        'codev:architect:local live',
        'codev:builder-spir-12 live',
        'codev:builder-spir-34 -',
        'notes:architect:main -',
        'notes:builder-air-7 -',
      ]);
    });

    it('nothing in a workspace a message would not reach: one stopped since the listing was read', async () => {
      r.grant({ scope: 'all', workspacePath: null, architect: null });
      (r.world.running as string[]).splice(r.world.running.indexOf(NOTES), 1);
      expect(await r.listed()).toEqual([
        'codev:architect:main live',
        'codev:architect:local live',
        'codev:builder-spir-12 live',
        'codev:builder-spir-34 -',
      ]);
    });

    it('never an address that a message would not reach as that agent', async () => {
      r.extraSeats = [
        { kind: 'builder', name: 'spir-12', live: true },
        { kind: 'architect', name: 'review', live: true },
        { kind: 'builder', name: 'Not-A-Component', live: true },
      ];
      r.grant({ scope: 'all', workspacePath: null, architect: null });
      const listed = await r.listed();
      expect(listed.some((a) => a.includes('spir-12') && !a.includes('builder-spir-12'))).toBe(false);
      expect(listed.some((a) => a.includes('review') || a.includes('Not-A-Component'))).toBe(false);
    });

    it('overlapping grants list each address once; a hold grant counts', async () => {
      r.grant({ scope: 'architect', workspacePath: CODEV, architect: 'main' }, 'hold');
      r.grant({ scope: 'architects', workspacePath: CODEV, architect: null });
      r.grant({ scope: 'front-door', workspacePath: NOTES, architect: null });
      expect(await r.listed()).toEqual(['codev:architect:main live', 'codev:architect:local live', 'notes:architect:main -']);
    });

    it('only the asking peer\'s grants', async () => {
      r.grant({ scope: 'all', workspacePath: null, architect: null }, 'deliver', STUDIO);
      r.grant({ scope: 'architect', workspacePath: CODEV, architect: 'local' });
      expect(await r.listed()).toEqual(['codev:architect:local live']);
    });

    it('grants that cover nothing now: answered, with no address', async () => {
      r.grant({ scope: 'architect', workspacePath: CODEV, architect: 'local' });
      r.architects.set(CODEV, ['main']);
      const { answer } = await r.ask();
      expect(answer).toEqual({ v: 1, outcome: 'answered', truncated: false, addresses: [] });
    });

    it('stores nothing, attempts no delivery, and records the query without addresses', async () => {
      r.grant({ scope: 'all', workspacePath: null, architect: null });
      const request = r.query();
      await r.ask(request);
      expect(r.stored()).toBe(0);
      const [record] = r.records();
      expect(record).toMatchObject({
        direction: 'inbound',
        kind: 'query',
        peerTowerId: MBP,
        peerSlug: 'mbp',
        messageId: request.statement.requestId,
        fromAddress: null,
        toAddress: null,
        outcome: 'answered',
        reason: null,
      });
      expect(r.logs.some((l) => l.includes(`query ${request.statement.requestId} from mbp: answered, 6 addresses`))).toBe(true);
    });
  });

  describe('refusals, each storing nothing', () => {
    it('no grant: no-grant (Departures, C8)', async () => {
      const { answer } = await r.ask();
      expect(answer).toEqual({ v: 1, outcome: 'refused', reason: 'no-grant' });
      expect(r.stored()).toBe(0);
      expect(r.records()[0]).toMatchObject({ kind: 'query', outcome: 'refused', reason: 'no-grant' });
    });

    it('the switch off: remote-off, before the grant is looked at', async () => {
      r.grant({ scope: 'all', workspacePath: null, architect: null });
      setSwitch(r.db, 'off', T0);
      expect((await r.ask()).answer).toEqual({ v: 1, outcome: 'refused', reason: 'remote-off' });
    });

    it('another owner: no-grant, whatever is granted', async () => {
      r.grant({ scope: 'all', workspacePath: null, architect: null });
      expect((await r.ask(r.query({ statement: { sameOwner: false } }))).answer).toEqual({ v: 1, outcome: 'refused', reason: 'no-grant' });
    });

    it('a payload that is not a query, or a sentAt out of range', async () => {
      r.grant({ scope: 'all', workspacePath: null, architect: null });
      const message = encodeMessagePayload({ sentAt: T0, to: { workspace: 'codev', kind: 'architect' }, from: null, body: 'hi' });
      if (!message.ok) throw new Error('message payload');
      const cases: Array<[Uint8Array | undefined, number | undefined, string]> = [
        [utf8(JSON.stringify({ sentAt: T0, what: 'workspaces' })), undefined, 'malformed'],
        [utf8(`{"sentAt":${T0},"what":"addresses","what":"addresses"}`), undefined, 'malformed'],
        [message.bytes, undefined, 'malformed'],
        [undefined, T0 + 5 * MINUTE + 1, 'clock-skew'],
        [undefined, T0 - 30 * 24 * 60 * MINUTE - 1, 'expired'],
      ];
      for (const [payload, sentAt, reason] of cases) {
        expect((await r.ask(r.query({ payload, sentAt }))).answer, reason).toEqual({ v: 1, outcome: 'refused', reason });
      }
      expect(r.stored()).toBe(0);
    });
  });

  describe(`the limit: ${QUERIES_PER_PEER_PER_MINUTE} answered queries a minute from one peer`, () => {
    beforeEach(() => {
      r.grant({ scope: 'architect', workspacePath: CODEV, architect: 'local' });
    });

    it('the 11th in a minute is rate-limited, with the seconds left in it; the next minute answers again', async () => {
      r.clock.now = T0 + 15 * SECOND;
      for (let i = 0; i < QUERIES_PER_PEER_PER_MINUTE; i++) expect((await r.ask()).answer.outcome).toBe('answered');
      r.clock.now = T0 + 20 * SECOND + 300;
      expect((await r.ask()).answer).toEqual({ v: 1, outcome: 'refused', reason: 'rate-limited', retryAfterSec: 40 });
      r.clock.now = T0 + MINUTE - 1;
      expect((await r.ask()).answer).toEqual({ v: 1, outcome: 'refused', reason: 'rate-limited', retryAfterSec: 1 });
      r.clock.now = T0 + MINUTE;
      expect((await r.ask()).answer.outcome).toBe('answered');
      // Refused queries in a minute are one counted row (Departures, C5).
      const limited = r.records().filter((row) => row.reason === 'rate-limited');
      expect(limited).toHaveLength(1);
      expect(limited[0]).toMatchObject({ aggregate: true, count: 2, peerTowerId: MBP });
    });

    it('per peer: another of my Towers has its own', async () => {
      r.grant({ scope: 'architect', workspacePath: CODEV, architect: 'local' }, 'deliver', STUDIO);
      for (let i = 0; i < QUERIES_PER_PEER_PER_MINUTE; i++) await r.ask();
      expect((await r.ask()).answer.reason).toBe('rate-limited');
      const fromStudio = r.query({ statement: { fromTowerId: STUDIO, fromTowerSlug: 'studio' } });
      expect((await r.ask(fromStudio)).answer.outcome).toBe('answered');
    });

    it('a refused query is not counted', async () => {
      setSwitch(r.db, 'off', T0);
      for (let i = 0; i < 20; i++) await r.ask();
      setSwitch(r.db, 'on', T0);
      for (let i = 0; i < QUERIES_PER_PEER_PER_MINUTE; i++) expect((await r.ask()).answer.outcome).toBe('answered');
      expect((await r.ask()).answer.reason).toBe('rate-limited');
    });

    it('a restart of the receiving Tower starts a fresh minute', async () => {
      for (let i = 0; i < QUERIES_PER_PEER_PER_MINUTE; i++) await r.ask();
      expect((await r.ask()).answer.reason).toBe('rate-limited');
      r.receiver = createReceiver(r.deps);
      expect((await r.ask()).answer.outcome).toBe('answered');
    });
  });

  describe('an answer over 65 536 bytes', () => {
    it('is trimmed, keeping the first addresses in order, and marked truncated', async () => {
      const ids = Array.from({ length: 1500 }, (_, i) => `builder-spir-${String(i).padStart(4, '0')}-a-long-enough-builder-name`);
      r.builders.set(CODEV, ids);
      r.grant({ scope: 'all', workspacePath: null, architect: null });
      const { answer, bytes } = await r.ask();
      expect(bytes).toBeLessThanOrEqual(PEER_MAX_ANSWER_BYTES);
      expect(answer.truncated).toBe(true);
      const names = (answer.addresses ?? []).map((a) => a.address.name);
      expect(names.length).toBeGreaterThan(100);
      expect(names.length).toBeLessThan(2 + ids.length);
      expect(names).toEqual(['main', 'local', ...ids].slice(0, names.length));
    });

    it('one that fits is not marked', async () => {
      r.grant({ scope: 'all', workspacePath: null, architect: null });
      expect((await r.ask()).answer.truncated).toBe(false);
    });
  });
});

// ===========================================================================
// The sending Tower (mbp)
// ===========================================================================

function answerOf(status: number, body: Record<string, unknown>, kind: 'query' | 'message' = 'query'): ClassifiedAnswer {
  return classifyRelayAnswer(
    { answered: true, status, contentType: 'application/json', outcomeHeader: body.outcome as string, body: utf8(JSON.stringify({ v: 1, ...body })) },
    { kind, relayStated: true },
  );
}

const devvmListed: PeerListingTower = { towerId: DEVVM, slug: 'devvm', online: true, protocols: [1], remoteMessaging: 'on' };

class Sending {
  readonly db = new Database(':memory:');
  now = T0;
  registration: OwnRegistration | null = { serverUrl: 'https://cloud.example', towerId: MBP, towerName: 'mbp', deregistered: false };
  relay: PeerCloudRelay = { state: 'available', why: null };
  duringResolve: (() => void) | null = null;
  duringCall: (() => void) | null = null;
  readonly resolved: string[] = [];
  readonly calls: RelayRequest[] = [];
  readonly enqueued: string[] = [];
  /** What the next call comes to. */
  next: () => RelayCall = () => ({
    called: true,
    answer: answerOf(200, {
      outcome: 'answered',
      truncated: false,
      addresses: [
        { address: { workspace: 'codev', kind: 'architect', name: 'local' }, live: true },
        { address: { workspace: 'codev', kind: 'id', name: 'builder-spir-1940' }, live: false },
      ],
    }),
  });
  readonly logs: string[] = [];
  readonly sender: Sender;

  constructor() {
    this.db.exec(GLOBAL_SCHEMA);
    setSwitch(this.db, 'on', T0 - MINUTE);
    this.sender = new Sender({
      db: () => this.db,
      now: () => this.now,
      registration: () => this.registration,
      list: {
        relay: () => this.relay,
        resolve: async (name): Promise<PeerNameResolution> => {
          this.resolved.push(name);
          await new Promise((resolve) => setImmediate(resolve));
          this.duringResolve?.();
          if (name === 'devvm') return { ok: true, tower: devvmListed, fresh: true };
          if (name === 'mbp-old') return { ok: false, reason: 'self' };
          return { ok: false, reason: 'unknown-tower', message: `No Tower named '${name}' is in this Tower's peer list.`, currentName: null };
        },
      },
      outbox: {
        enqueue: async (row) => {
          this.enqueued.push(row.messageId);
          throw new Error('a query is not queued');
        },
      },
      client: {
        relay: async (request) => {
          this.calls.push(request);
          await new Promise((resolve) => setImmediate(resolve));
          this.duringCall?.();
          return this.next();
        },
      },
      limits: () => ({ waitingPerPeer: 50 }),
      log: (level, message) => this.logs.push(`${level} ${message}`),
    });
  }

  show(tower = 'devvm'): Promise<PeerShowResult> {
    return this.sender.show(tower);
  }

  records(): store.PeerRecordRow[] {
    return store.listRecords(this.db).reverse();
  }

  outboxRows(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM peer_outbox').get() as { n: number }).n;
  }
}

describe('Spec 1967 phase 10: afx peer show at the sending Tower', () => {
  let s: Sending;
  beforeEach(() => {
    s = new Sending();
  });
  afterEach(() => {
    s.db.close();
  });

  it('answers with the peer\'s addresses, written with its name in front, from one query call of its own', async () => {
    expect(await s.show()).toEqual({
      outcome: 'answered',
      peer: { towerId: DEVVM, name: 'devvm' },
      addresses: [
        { address: 'afx://devvm/codev:architect:local', live: true },
        { address: 'afx://devvm/codev:builder-spir-1940', live: false },
      ],
      truncated: false,
    });
    expect(s.calls).toHaveLength(1);
    const [call] = s.calls;
    expect(call.kind).toBe('query');
    expect(call.toTowerId).toBe(DEVVM);
    expect(call.requestId).toMatch(UUID);
    expect(JSON.parse(Buffer.from(call.payload).toString('utf8'))).toEqual({ sentAt: T0, what: 'addresses' });
    expect(s.enqueued).toEqual([]);
    expect(s.outboxRows()).toBe(0);
    expect(s.records()).toEqual([
      expect.objectContaining({
        direction: 'outbound',
        kind: 'query',
        peerTowerId: DEVVM,
        peerSlug: 'devvm',
        messageId: call.requestId,
        toAddress: null,
        payloadSize: call.payload.length,
        outcome: 'answered',
        reason: null,
      }),
    ]);
    expect(call.payload.length).toBe(Buffer.byteLength(`{"sentAt":${T0},"what":"addresses"}`));
  });

  it('passes on a truncated answer', async () => {
    s.next = () => ({ called: true, answer: answerOf(200, { outcome: 'answered', truncated: true, addresses: [] }) });
    expect(await s.show()).toMatchObject({ outcome: 'answered', addresses: [], truncated: true });
  });

  describe("this Tower's own refusals: no call", () => {
    it('the name as text: not a Tower name, another owner, this Tower; none recorded, none looked up', async () => {
      const cases: Array<[string, RegExp]> = [
        ['devvm/codev', /^Cannot ask that Tower: .*not an address\. Expected /],
        ['sam@studio', /^Another owner's Tower \(sam@studio\) is not available in this version\. .*afx peer show studio$/],
        ['mbp', /^'mbp' is this Tower\. What runs here: afx workspace list$/],
      ];
      for (const [text, words] of cases) {
        const shown = await s.show(text);
        expect(shown, text).toMatchObject({ outcome: 'refused', by: 'this-tower', reason: 'address', peer: null });
        if (shown.outcome === 'refused') expect(shown.message).toMatch(words);
      }
      expect(s.resolved).toEqual([]);
      expect(s.calls).toEqual([]);
      expect(s.records()).toEqual([]);
    });

    it('a name the list knows as this Tower is this Tower too', async () => {
      expect(await s.show('mbp-old')).toMatchObject({ outcome: 'refused', reason: 'address' });
      expect(s.calls).toEqual([]);
    });

    it('each of checks 1 to 4, then an unknown Tower, in that order, each recorded', async () => {
      const cases: Array<[string, () => void, RegExp]> = [
        ['remote-off', () => setSwitch(s.db, 'off', T0), /^Remote messaging is off on this Tower \(mbp\)\. A human turns it on with: afx peer on$/],
        ['not-connected', () => (s.registration = null), /afx tower connect$/],
        ['not-registered', () => (s.registration = { ...s.registration!, deregistered: true }), /afx tower connect --reauth$/],
        ['no-relay', () => (s.relay = { state: 'none', why: 'stated-none' }), /has no relay/],
      ];
      for (const [reason, apply, words] of cases) {
        s.db.close();
        s = new Sending();
        apply();
        const shown = await s.show();
        expect(shown, reason).toMatchObject({ outcome: 'refused', by: 'this-tower', reason, peer: null });
        if (shown.outcome === 'refused') expect(shown.message).toMatch(words);
        expect(s.calls).toEqual([]);
        expect(s.records()[0]).toMatchObject({ kind: 'query', outcome: 'refused', reason, messageId: null, payloadSize: null });
      }
      s.db.close();
      s = new Sending();
      expect(await s.show('devbox')).toMatchObject({ outcome: 'refused', reason: 'unknown-tower', message: "No Tower named 'devbox' is in this Tower's peer list." });
      expect(s.calls).toEqual([]);
      expect(s.records()[0]).toMatchObject({ kind: 'query', peerSlug: 'devbox', reason: 'unknown-tower' });
    });

    it('checks 1 to 4 again once the name has resolved', async () => {
      s.duringResolve = () => setSwitch(s.db, 'off', T0);
      expect(await s.show()).toMatchObject({ outcome: 'refused', reason: 'remote-off', peer: { towerId: DEVVM, name: 'devvm' } });
      expect(s.calls).toEqual([]);
    });

    it('the cloud client makes no call: not connected, or a plain-HTTP cloud', async () => {
      s.next = () => ({ called: false, reason: 'not-connected' });
      expect(await s.show()).toMatchObject({ outcome: 'refused', reason: 'not-connected' });
      s.next = () => ({ called: false, reason: 'insecure' });
      expect(await s.show()).toMatchObject({ outcome: 'refused', reason: 'no-relay', message: expect.stringContaining('plain HTTP') });
    });
  });

  describe('every answer but answered refuses: a query is never held', () => {
    const cases: Array<[string, () => RelayCall, Partial<Extract<PeerShowResult, { outcome: 'refused' }>>, RegExp]> = [
      [
        'an offline peer',
        () => ({ called: true, answer: answerOf(503, { outcome: 'unavailable', reason: 'tower-offline' }) }),
        { by: 'cloud', reason: 'tower-offline' },
        /^devvm is offline: it has no connection to Codev Cloud now\. A query is never held: ask again when it is online\.$/,
      ],
      [
        'an unreachable cloud',
        () => ({ called: true, answer: classifyRelayAnswer({ answered: false }, { kind: 'query', relayStated: true }) }),
        { by: 'this-tower', reason: 'cloud-unreachable' },
        /^Codev Cloud is unreachable, so devvm was not asked\. A query is never held: ask again later\.$/,
      ],
      [
        'no answer in time',
        () => ({ called: true, answer: answerOf(504, { outcome: 'unavailable', reason: 'no-answer' }) }),
        { by: 'cloud', reason: 'no-answer' },
        /^devvm did not answer in time\. A query is never held: ask again\.$/,
      ],
      [
        "the cloud's ceiling",
        () => ({ called: true, answer: answerOf(429, { outcome: 'refused', reason: 'rate-limited', retryAfterSec: 20 }) }),
        { by: 'cloud', reason: 'rate-limited', retryAfterSec: 20 },
        /^Refused by Codev Cloud: too many queries from this Tower to devvm; try again in 20 s\.$/,
      ],
      [
        "the peer's no-grant",
        () => ({ called: true, answer: answerOf(200, { outcome: 'refused', reason: 'no-grant' }) }),
        { by: 'peer', reason: 'no-grant' },
        /^Refused by devvm: mbp has no grant there\. On devvm: afx peer grant mbp <recipients>$/,
      ],
      [
        "the peer's limit",
        () => ({ called: true, answer: answerOf(200, { outcome: 'refused', reason: 'rate-limited', retryAfterSec: 40 }) }),
        { by: 'peer', reason: 'rate-limited', retryAfterSec: 40 },
        /^Refused by devvm: mbp has asked it too often this minute; try again in 40 s\.$/,
      ],
      [
        'the peer switched off',
        () => ({ called: true, answer: answerOf(200, { outcome: 'refused', reason: 'remote-off' }) }),
        { by: 'peer', reason: 'remote-off' },
        /^Refused by devvm: remote messaging is off there\.$/,
      ],
      [
        'not verified',
        () => ({ called: true, answer: answerOf(200, { outcome: 'not-verified' }) }),
        { by: 'peer', reason: 'not-verified' },
        /could not verify the query.*A query is never held: ask again\.$/,
      ],
      [
        'a key the cloud rejects',
        () => ({ called: true, answer: answerOf(401, { outcome: 'refused', reason: 'unauthenticated' }) }),
        { by: 'cloud', reason: 'not-registered' },
        /afx tower connect --reauth$/,
      ],
      [
        'a peer that does not speak the protocol',
        () => ({ called: true, answer: answerOf(409, { outcome: 'refused', reason: 'peer-unsupported' }) }),
        { by: 'cloud', reason: 'peer-unsupported' },
        /Upgrade Codev on devvm\.$/,
      ],
      [
        'a cloud without the relay',
        () => ({ called: true, answer: classifyRelayAnswer({ answered: true, status: 404, contentType: 'text/html', outcomeHeader: undefined, body: utf8('Not Found') }, { kind: 'query', relayStated: false }) }),
        { by: 'this-tower', reason: 'no-relay' },
        /has no relay/,
      ],
      [
        "an answer that is not the contract's",
        () => ({ called: true, answer: answerOf(200, { outcome: 'answered', truncated: false }) }),
        { by: 'this-tower', reason: 'tower-error' },
        /^devvm's answer did not arrive in the expected form\./,
      ],
    ];
    for (const [name, next, expected, words] of cases) {
      it(name, async () => {
        s.next = next;
        const shown = await s.show();
        expect(shown).toMatchObject({ outcome: 'refused', retryAfterSec: null, peer: { towerId: DEVVM, name: 'devvm' }, ...expected });
        if (shown.outcome === 'refused') expect(shown.message).toMatch(words);
        expect(s.calls).toHaveLength(1);
        expect(s.outboxRows()).toBe(0);
        expect(s.enqueued).toEqual([]);
      });
    }

    it('each call is recorded with its answer; a rate-limited one is counted', async () => {
      s.next = cases[0][1];
      await s.show();
      s.next = cases[3][1];
      await s.show();
      await s.show();
      const rows = s.records();
      expect(rows[0]).toMatchObject({
        kind: 'query',
        outcome: 'unavailable',
        reason: 'tower-offline',
        messageId: s.calls[0].requestId,
        payloadSize: s.calls[0].payload.length,
      });
      expect(rows[1]).toMatchObject({ aggregate: true, count: 2, outcome: 'refused', reason: 'rate-limited', peerTowerId: DEVVM });
    });
  });

  it('an answer under a registration since replaced is refused', async () => {
    s.duringCall = () => (s.registration = { ...s.registration!, towerId: '01JMBPNEW000000000000000AA' });
    expect(await s.show()).toMatchObject({
      outcome: 'refused',
      reason: 'registration-changed',
      message: "This Tower's Codev Cloud registration changed while devvm was asked. Ask again: afx peer show devvm",
    });
  });

  it('is not queued behind messages: answered while a message relay call to the peer is in flight', async () => {
    const clock = new ManualClock(T0);
    const db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
    setSwitch(db, 'on', T0 - MINUTE);
    const registration: OwnRegistration = { serverUrl: 'https://cloud.example', towerId: MBP, towerName: 'mbp', deregistered: false };
    let releaseMessage: (call: RelayCall) => void = () => {};
    const kinds: string[] = [];
    const client = {
      relay: (request: RelayRequest): Promise<RelayCall> => {
        kinds.push(request.kind);
        if (request.kind === 'message') return new Promise((resolve) => (releaseMessage = resolve));
        return Promise.resolve({ called: true, answer: answerOf(200, { outcome: 'answered', truncated: false, addresses: [] }) });
      },
    };
    const list = {
      relay: (): PeerCloudRelay => ({ state: 'available', why: null }),
      resolve: async (): Promise<PeerNameResolution> => ({ ok: true, tower: devvmListed, fresh: true }),
      refresh: async () => ({ fresh: false, problem: null, retryAfterSec: null, listing: store.readListing(db) }),
      noteNoRelay: () => {},
    };
    const outbox = new Outbox({ db: () => db, now: () => clock.now, timers: clock.timers, client, list, registration: () => registration, log: () => {} });
    outbox.start();
    const sender = new Sender({
      db: () => db,
      now: () => clock.now,
      registration: () => registration,
      list,
      outbox,
      client,
      limits: () => ({ waitingPerPeer: 50 }),
      log: () => {},
    });
    try {
      const sent = sender.send({
        to: { tower: 'devvm', workspace: 'codev', kind: 'architect' },
        body: 'CI is green on the tunnel branch',
        options: { raw: false, interrupt: false, noEnter: false, delay: false },
        from: { workspacePath: CODEV, agent: 'main', address: { workspace: 'codev', kind: 'architect', name: 'main' }, isBuilder: false },
      });
      for (let i = 0; i < 5 && kinds.length === 0; i++) await new Promise((resolve) => setImmediate(resolve));
      expect(kinds).toEqual(['message']);

      expect(await sender.show('devvm')).toMatchObject({ outcome: 'answered', addresses: [] });
      expect(kinds).toEqual(['message', 'query']);

      releaseMessage({ called: true, answer: answerOf(200, { outcome: 'delivered' }, 'message') });
      expect(await sent).toMatchObject({ outcome: 'delivered' });
    } finally {
      outbox.stop();
      db.close();
    }
  });
});

// ===========================================================================
// GET /api/peer/show and afx peer show
// ===========================================================================

describe('Spec 1967 phase 10: GET /api/peer/show and afx peer show', () => {
  let server: http.Server;
  let db: Database.Database;
  let next: PeerShowResult;
  const asked: string[] = [];
  let printed: string[];
  let deps: PeerDeps;
  let port: number;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
    asked.length = 0;
    next = {
      outcome: 'answered',
      peer: { towerId: DEVVM, name: 'devvm' },
      addresses: [
        { address: 'afx://devvm/codev:architect:local', live: true },
        { address: 'afx://devvm/codev:builder-spir-1940', live: false },
      ],
      truncated: false,
    };
    const routeDeps: PeerRouteDeps = {
      db: () => db,
      now: () => T0,
      world: () => ({ registered: [], running: [], architectsOf: () => [] }),
      ownTower: () => ({ name: 'mbp', towerId: MBP }),
      settings: () => resolvePeerSettings({}),
      cloud: () => ({
        scopeToRegistration: () => {},
        refreshListing: async () => ({ fresh: false, problem: 'cloud-unreachable', retryAfterSec: null, listing: store.readListing(db) }),
        relay: () => ({ state: 'available', why: null }),
        reportSwitch: () => 'reporting',
        tunnelUp: () => true,
        wakeOutbox: () => {},
        outbox: () => ({ inFlightFor: () => null, pausedBecause: () => null }),
        show: async (tower) => {
          asked.push(tower);
          return next;
        },
      }),
      log: () => {},
    };
    const handler = createPeerRouteHandler(routeDeps);
    server = http.createServer((req, res) => {
      void handler(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    printed = [];
    deps = {
      client: new TowerClient({ host: '127.0.0.1', port }),
      out: {
        success: (m) => printed.push(`[ok] ${m}`),
        info: (m) => printed.push(`[info] ${m}`),
        warn: (m) => printed.push(`[warn] ${m}`),
        line: (t) => printed.push(t),
      },
    };
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  const raw = async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('the route: 200 with the answer, the tower-ref passed as written', async () => {
    expect(await raw('/api/peer/show?tower=devvm')).toEqual({
      status: 200,
      body: { tower: { towerId: DEVVM, name: 'devvm' }, addresses: next.outcome === 'answered' ? next.addresses : [], truncated: false },
    });
    expect(asked).toEqual(['devvm']);
  });

  it('the route: a refusal is a 403 REMOTE_REFUSED, its words made printable', async () => {
    next = {
      outcome: 'refused',
      by: 'peer',
      reason: 'no-grant',
      message: 'Refused by devvm: mbp has no grant there.\u001b[2J',
      retryAfterSec: null,
      peer: { towerId: DEVVM, name: 'devvm' },
    };
    expect(await raw('/api/peer/show?tower=devvm')).toEqual({
      status: 403,
      body: {
        error: 'REMOTE_REFUSED',
        message: 'Refused by devvm: mbp has no grant there.?[2J',
        refusedBy: 'peer',
        reason: 'no-grant',
        retryAfterSec: null,
        peer: 'devvm',
      },
    });
  });

  it('the route: no tower named is a 400, and only GET is allowed', async () => {
    expect(await raw('/api/peer/show')).toMatchObject({ status: 400, body: { error: 'INVALID_PARAMS' } });
    const post = await fetch(`http://127.0.0.1:${port}/api/peer/show?tower=devvm`, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(asked).toEqual([]);
  });

  it('afx peer show: one address a line, ready to paste, then live or not', async () => {
    await peerShow({ tower: 'devvm' }, deps);
    expect(printed).toEqual(['afx://devvm/codev:architect:local    live', 'afx://devvm/codev:builder-spir-1940  not live']);
    expect(shownLines([{ address: 'afx://devvm/codev:architect:local', live: true }])).toEqual(['afx://devvm/codev:architect:local  live']);
  });

  it('afx peer show: nothing to message, and a trimmed answer, say so', async () => {
    next = { outcome: 'answered', peer: { towerId: DEVVM, name: 'devvm' }, addresses: [], truncated: true };
    await peerShow({ tower: 'devvm' }, deps);
    expect(printed).toEqual([
      'Nothing on devvm that this Tower may message now.',
      '[info] devvm trimmed its answer to fit the 65 536-byte limit: some addresses there are not shown.',
    ]);
  });

  it('afx peer show: a refusal throws its words, which the CLI prints before exiting 1', async () => {
    next = {
      outcome: 'refused',
      by: 'cloud',
      reason: 'tower-offline',
      message: 'devvm is offline: it has no connection to Codev Cloud now. A query is never held: ask again when it is online.',
      retryAfterSec: null,
      peer: { towerId: DEVVM, name: 'devvm' },
    };
    await expect(peerShow({ tower: 'devvm' }, deps)).rejects.toThrow(
      /^devvm is offline: it has no connection to Codev Cloud now\. A query is never held: ask again when it is online\.$/,
    );
    expect(printed).toEqual([]);
  });

  it('the SDK: a refusal carries REMOTE_REFUSED and the words', async () => {
    next = { outcome: 'refused', by: 'this-tower', reason: 'remote-off', message: 'Remote messaging is off on this Tower (mbp).', retryAfterSec: null, peer: null };
    const result = await new TowerClient({ host: '127.0.0.1', port }).getPeerShow('devvm');
    expect(result).toMatchObject({ ok: false, status: 403, errorCode: 'REMOTE_REFUSED', error: 'Remote messaging is off on this Tower (mbp).' });
  });
});
