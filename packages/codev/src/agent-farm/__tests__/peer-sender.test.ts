/**
 * The sending Tower's checks (Spec 1967, plan phase 8, layer A; contract section 4, G14):
 * the first that applies is the answer and no call is made; then the message is persisted
 * with its exact payload and queued. A stand-in outbox records what is queued and answers
 * with a scripted first answer, so what is checked here is the sender's own part:
 *
 * - each check alone, and the order for each adjacent pair of checks;
 * - this Tower's own name is a local address, to which no check applies;
 * - not registered: `deregistered_at` refuses with no call, and a cloud's `401` the same way;
 * - the cap on waiting mail, counted in the same step as the insert;
 * - checks 1 to 4 read again after the name resolves;
 * - the persisted row and its payload; the first answer as the sender is told it;
 * - the record of each refusal.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { PEER_MAX_BODY_BYTES, type AgentAddress, type PeerCloudRelay, type PeerListingTower } from '@cluesmith/codev-types';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import { classifyRelayAnswer, SENDER_CHECK_ORDER, type ClassifiedAnswer } from '../peer/contract.js';
import type { FirstAnswer } from '../peer/outbox.js';
import type { OwnRegistration, PeerNameResolution } from '../peer/peer-list.js';
import { Sender, type PeerSendRequest, type PeerSendResult } from '../peer/sender.js';
import * as store from '../peer/store.js';
import { setSwitch } from '../peer/switch.js';

const T0 = Date.UTC(2026, 10, 21, 3, 34, 47, 452);
const SELF = '01JMBP000000000000000000AA';
const DEVVM = '01JDEVVM0000000000000000AA';
const WS = '/work/codev';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const utf8 = (text: string) => new TextEncoder().encode(text);

function fromR(body: Record<string, unknown>): ClassifiedAnswer {
  return classifyRelayAnswer(
    { answered: true, status: 200, contentType: 'application/json', outcomeHeader: body.outcome as string, body: utf8(JSON.stringify({ v: 1, ...body })) },
    { kind: 'message', relayStated: true },
  );
}

function fromC(status: number, body: Record<string, unknown>): ClassifiedAnswer {
  return classifyRelayAnswer(
    { answered: true, status, contentType: 'application/json', outcomeHeader: body.outcome as string, body: utf8(JSON.stringify({ v: 1, ...body })) },
    { kind: 'message', relayStated: true },
  );
}

const devvm: PeerListingTower = { towerId: DEVVM, slug: 'devvm', online: true, protocols: [1], remoteMessaging: 'on' };

class Fixture {
  readonly db = new Database(':memory:');
  now = T0;
  registration: OwnRegistration | null = { serverUrl: 'https://cloud.example', towerId: SELF, towerName: 'mbp', deregistered: false };
  relay: PeerCloudRelay = { state: 'available', why: null };
  waitingPerPeer = 50;
  /** Run while the name resolves, as the state might change while the listing is fetched. */
  duringResolve: (() => void) | null = null;
  readonly resolved: string[] = [];
  readonly queued: store.PeerOutboxRow[] = [];
  /** What the outbox tells the next send; by default, delivered. */
  first: (row: store.PeerOutboxRow) => FirstAnswer = () => ({ kind: 'resolved', state: 'accepted', answer: fromR({ outcome: 'delivered' }) });
  readonly logs: string[] = [];
  readonly sender: Sender;

  constructor() {
    this.db.exec(GLOBAL_SCHEMA);
    setSwitch(this.db, 'on', T0 - 1000);
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
          if (name === 'devvm') return { ok: true, tower: devvm, fresh: true };
          if (name === 'mbp-old') return { ok: false, reason: 'self' };
          if (name === 'devbox') return { ok: false, reason: 'unknown-tower', message: "No Tower named 'devbox': it is now named 'devvm'.", currentName: 'devvm' };
          return { ok: false, reason: 'unknown-tower', message: `No Tower named '${name}' is in this Tower's peer list.`, currentName: null };
        },
      },
      outbox: {
        enqueue: async (row) => {
          this.queued.push(row);
          return this.first(row);
        },
      },
      limits: () => ({ waitingPerPeer: this.waitingPerPeer }),
      log: (level, message) => this.logs.push(`${level} ${message}`),
    });
  }

  /** A held row for `peer`, as earlier sends would have left. */
  hold(peer = DEVVM): void {
    store.insertOutbox(
      this.db,
      {
        messageId: randomUUID(),
        peerTowerId: peer,
        toAddress: 'afx://devvm/codev:architect',
        fromAddress: null,
        payload: Buffer.from('{}'),
        sentAt: this.now,
        fromWorkspacePath: WS,
        fromAgent: null,
      },
      this.now,
    );
  }

  records(): store.PeerRecordRow[] {
    return store.listRecords(this.db).reverse();
  }
}

/** A send from the main architect of `codev` to devvm's local architect, with no option set. */
function request(change: Partial<PeerSendRequest> & { toChange?: Partial<AgentAddress> } = {}): PeerSendRequest {
  const { toChange, ...rest } = change;
  return {
    to: { tower: 'devvm', workspace: 'codev', kind: 'architect', name: 'local', ...toChange } as AgentAddress,
    body: 'Please review PR 42.',
    options: { raw: false, interrupt: false, noEnter: false, delay: false },
    from: { workspacePath: WS, agent: 'architect:main', address: { workspace: 'codev', kind: 'architect', name: 'main' }, isBuilder: false },
    ...rest,
  };
}

let f: Fixture;

beforeEach(() => {
  f = new Fixture();
});

afterEach(() => {
  f.db.close();
});

// ===========================================================================
// The checks, each alone and in order
// ===========================================================================

type Check = (typeof SENDER_CHECK_ORDER)[number];

/** What makes each check apply, to the fixture and to the request. */
const VIOLATE: Record<Check, (req: PeerSendRequest) => PeerSendRequest> = {
  address: (req) => ({ ...req, to: { ...req.to, owner: 'sam' } }),
  'remote-off': (req) => {
    setSwitch(f.db, 'off', f.now);
    return req;
  },
  'not-connected': (req) => {
    f.registration = null;
    return req;
  },
  'not-registered': (req) => {
    if (f.registration !== null) f.registration = { ...f.registration, deregistered: true };
    return req;
  },
  'no-relay': (req) => {
    f.relay = { state: 'none', why: 'stated-none' };
    return req;
  },
  'option-not-allowed': (req) => ({ ...req, options: { ...req.options, interrupt: true } }),
  'too-large': (req) => ({ ...req, body: 'a'.repeat(PEER_MAX_BODY_BYTES + 1) }),
  'unknown-tower': (req) => ({ ...req, to: { ...req.to, tower: 'nowhere' } }),
  'builder-rule': (req) => ({ ...req, from: { ...req.from, agent: 'spir-1967', address: { workspace: 'codev', kind: 'id', name: 'spir-1967' }, isBuilder: true } }),
  'rate-limited': (req) => {
    for (let i = 0; i < f.waitingPerPeer; i++) f.hold();
    return req;
  },
};

describe("the sending Tower's checks (section 4, G14)", () => {
  it('the contract names ten checks, address first and the cap last', () => {
    expect(SENDER_CHECK_ORDER).toEqual([
      'address', 'remote-off', 'not-connected', 'not-registered', 'no-relay',
      'option-not-allowed', 'too-large', 'unknown-tower', 'builder-rule', 'rate-limited',
    ]);
  });

  it('with none applying, the message is persisted and queued', async () => {
    const result = await f.sender.send(request());
    expect(result).toMatchObject({ outcome: 'delivered', peer: { towerId: DEVVM, name: 'devvm' } });
    expect(f.queued).toHaveLength(1);
  });

  for (const check of SENDER_CHECK_ORDER) {
    it(`${check} alone: refused by this Tower with that reason, nothing persisted, no call`, async () => {
      const result = await f.sender.send(VIOLATE[check](request()));
      expect(result).toMatchObject({ outcome: 'refused', by: 'this-tower', reason: check, messageId: null });
      expect((result as { message: string }).message.length).toBeGreaterThan(0);
      expect(f.queued).toEqual([]);
      expect(store.listHeldOutbox(f.db).length).toBe(check === 'rate-limited' ? f.waitingPerPeer : 0);
    });
  }

  for (let i = 0; i + 1 < SENDER_CHECK_ORDER.length; i++) {
    const [first, second] = [SENDER_CHECK_ORDER[i], SENDER_CHECK_ORDER[i + 1]];
    it(`${first} before ${second}`, async () => {
      // Applied later-check first, so a pair that cannot both hold (no registration, and
      // one marked deregistered) is left as the earlier check makes it.
      const req = VIOLATE[first](VIOLATE[second](request()));
      expect(await f.sender.send(req)).toMatchObject({ outcome: 'refused', reason: first });
    });
  }

  it('every check before the name is answered without asking the peer list', async () => {
    for (const check of SENDER_CHECK_ORDER.slice(0, 7)) {
      const g = f;
      f = new Fixture();
      g.db.close();
      await f.sender.send(VIOLATE[check](request()));
      expect(f.resolved, check).toEqual([]);
    }
  });

  it('a body that is not valid text is refused at the place of the size check', async () => {
    const lone = request({ body: 'half a pair: \uD83D' });
    expect(await f.sender.send(lone)).toMatchObject({ outcome: 'refused', reason: 'malformed' });
    const alsoUnknown = request({ body: 'half a pair: \uD83D', toChange: { tower: 'nowhere' } });
    expect(await f.sender.send(alsoUnknown)).toMatchObject({ reason: 'malformed' });
    expect(f.resolved).toEqual([]);
  });

  it('a body of exactly 48 KiB is sent; the size is counted as UTF-8 once normalised', async () => {
    expect(await f.sender.send(request({ body: 'a'.repeat(PEER_MAX_BODY_BYTES) }))).toMatchObject({ outcome: 'delivered' });
    const crlf = 'a\r\n'.repeat(PEER_MAX_BODY_BYTES / 2);
    expect(await f.sender.send(request({ body: crlf }))).toMatchObject({ outcome: 'delivered' });
    expect(await f.sender.send(request({ body: 'é'.repeat(PEER_MAX_BODY_BYTES / 2 + 1) }))).toMatchObject({ reason: 'too-large' });
  });

  it('each option is refused by name', async () => {
    const all = request({ options: { raw: true, interrupt: true, noEnter: true, delay: true } });
    expect(await f.sender.send(all)).toMatchObject({
      reason: 'option-not-allowed',
      message: '--raw, --interrupt, --no-enter, --delay cannot be used for a recipient on another Tower.',
    });
  });

  it('an unknown Tower is refused in the peer list\'s own words, naming its current name', async () => {
    expect(await f.sender.send(request({ toChange: { tower: 'devbox' } }))).toMatchObject({
      reason: 'unknown-tower',
      message: "No Tower named 'devbox': it is now named 'devvm'.",
    });
  });

  it('the walkthrough\'s remote-off message names this Tower and the command', async () => {
    setSwitch(f.db, 'off', f.now);
    expect(await f.sender.send(request())).toMatchObject({
      message: 'Remote messaging is off on this Tower (mbp). A human turns it on with: afx peer on',
    });
  });

  it('no relay says why: a plain-HTTP cloud, or one with none', async () => {
    f.relay = { state: 'none', why: 'insecure' };
    expect(((await f.sender.send(request())) as { message: string }).message).toMatch(/plain HTTP/);
    f.relay = { state: 'unknown', why: null };
    expect(await f.sender.send(request())).toMatchObject({ outcome: 'delivered' });
  });
});

// ===========================================================================
// The address as text
// ===========================================================================

describe('the address as text (check 0)', () => {
  it("this Tower's own name is a local address: none of the checks applies", async () => {
    setSwitch(f.db, 'off', f.now);
    f.relay = { state: 'none', why: 'stated-none' };
    const result = await f.sender.send(request({ toChange: { tower: 'mbp' }, options: { raw: true, interrupt: false, noEnter: false, delay: false } }));
    expect(result).toEqual({ outcome: 'local', address: { workspace: 'codev', kind: 'architect', name: 'local' } });
    expect(f.resolved).toEqual([]);
    expect(f.records()).toEqual([]);
  });

  it('a name the peer list knows as this Tower is local too', async () => {
    expect(await f.sender.send(request({ toChange: { tower: 'mbp-old' } }))).toEqual({
      outcome: 'local',
      address: { workspace: 'codev', kind: 'architect', name: 'local' },
    });
    expect(f.queued).toEqual([]);
  });

  it("an owner's Tower is refused as stage 1 refuses it, before this Tower's state, and not recorded", async () => {
    setSwitch(f.db, 'off', f.now);
    const result = await f.sender.send(request({ toChange: { owner: 'sam' } }));
    expect(result).toMatchObject({ outcome: 'refused', reason: 'address', message: expect.stringMatching(/not available in this version/) });
    expect(f.records()).toEqual([]);
  });

  it('an address that names no Tower is not a send to another Tower', async () => {
    await expect(f.sender.send(request({ toChange: { tower: undefined } }))).rejects.toThrow(/names its Tower/);
  });
});

// ===========================================================================
// Not registered (C12)
// ===========================================================================

describe('not registered (C12, #1871)', () => {
  it('a registration marked deregistered is refused with no call, telling the human how to register again', async () => {
    f.registration = { ...(f.registration as OwnRegistration), deregistered: true };
    const result = await f.sender.send(request());
    expect(result).toMatchObject({ outcome: 'refused', by: 'this-tower', reason: 'not-registered' });
    expect((result as { message: string }).message).toMatch(/afx tower connect --reauth/);
    expect(f.queued).toEqual([]);
  });

  it("a key the cloud rejects with 401 refuses the same way, as the cloud's answer", async () => {
    f.first = () => ({ kind: 'resolved', state: 'refused', answer: fromC(401, { outcome: 'refused', reason: 'unauthenticated' }) });
    const result = await f.sender.send(request());
    expect(result).toMatchObject({ outcome: 'refused', by: 'cloud', reason: 'not-registered' });
    expect((result as { message: string }).message).toMatch(/afx tower connect --reauth/);
    expect((result as { messageId: string }).messageId).toMatch(UUID);
  });
});

// ===========================================================================
// The cap, and the state read again after the name
// ===========================================================================

describe('the cap on waiting mail, and the state after the name resolves', () => {
  it('one under the cap is queued; at the cap it is refused, and the refusal counted per minute', async () => {
    f.waitingPerPeer = 3;
    f.hold();
    f.hold();
    f.first = () => ({ kind: 'held', reason: 'tower-offline', answer: null, ahead: 2 });
    expect(await f.sender.send(request())).toMatchObject({ outcome: 'held', where: 'this-tower', ahead: 2 });
    expect(await f.sender.send(request())).toMatchObject({
      outcome: 'refused',
      reason: 'rate-limited',
      message: '3 messages already wait on this Tower for devvm, the most it holds for one Tower. See them with: afx inbox',
    });
    await f.sender.send(request());
    const counted = f.records().filter((r) => r.reason === 'rate-limited');
    expect(counted).toMatchObject([{ aggregate: true, count: 2, peerTowerId: DEVVM, direction: 'outbound', outcome: 'refused' }]);
  });

  it('the cap is per peer: mail waiting for another Tower does not count', async () => {
    f.waitingPerPeer = 1;
    f.hold('01JSTUDIO000000000000000AA');
    expect(await f.sender.send(request())).toMatchObject({ outcome: 'delivered' });
  });

  it('two sends at once for the last place: one is queued, the other refused', async () => {
    f.waitingPerPeer = 1;
    f.first = () => ({ kind: 'held', reason: 'tower-offline', answer: null, ahead: 0 });
    const results = await Promise.all([f.sender.send(request()), f.sender.send(request())]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['held', 'refused']);
    expect(store.countHeldOutbox(f.db, DEVVM)).toBe(1);
  });

  const changes: Array<[string, () => void, string]> = [
    ['the switch turned off', () => setSwitch(f.db, 'off', f.now), 'remote-off'],
    ['the registration removed', () => (f.registration = null), 'not-connected'],
    ['the registration marked deregistered', () => (f.registration = { ...(f.registration as OwnRegistration), deregistered: true }), 'not-registered'],
    ['the relay found missing', () => (f.relay = { state: 'none', why: 'old-cloud' }), 'no-relay'],
  ];
  for (const [name, change, reason] of changes) {
    it(`${name} while the name resolved: refused as ${reason}, nothing persisted`, async () => {
      f.duringResolve = change;
      expect(await f.sender.send(request())).toMatchObject({ outcome: 'refused', reason, peer: { towerId: DEVVM } });
      expect(store.listHeldOutbox(f.db)).toEqual([]);
    });
  }
});

// ===========================================================================
// The builder rule
// ===========================================================================

describe('the builder rule for remote addresses', () => {
  const builder = { workspacePath: WS, agent: 'spir-1967', address: { workspace: 'codev', kind: 'id' as const, name: 'spir-1967' }, isBuilder: true };

  it("a builder naming an architect on another Tower is refused, told that Tower's front door", async () => {
    const result = await f.sender.send(request({ from: builder }));
    expect(result).toMatchObject({
      outcome: 'refused',
      reason: 'builder-rule',
      message: 'builder spir-1967 may only address its own spawning architect; reach that workspace through its front door: afx send afx://devvm/codev:architect "…"',
    });
  });

  it("a builder reaches the front door, and another Tower's builders", async () => {
    expect(await f.sender.send(request({ from: builder, toChange: { name: undefined } }))).toMatchObject({ outcome: 'delivered' });
    expect(await f.sender.send(request({ from: builder, toChange: { kind: 'id', name: 'spir-12' } }))).toMatchObject({ outcome: 'delivered' });
  });

  it('an architect naming an architect on another Tower is not a builder', async () => {
    expect(await f.sender.send(request())).toMatchObject({ outcome: 'delivered' });
  });
});

// ===========================================================================
// The row, and the answer
// ===========================================================================

describe('the persisted message and the answer the sender is told', () => {
  it('the row holds the exact payload: sentAt, the recipient as R writes it, the sender, the normalised body', async () => {
    await f.sender.send(request({ body: 'line one\r\nline two' }));
    const [row] = f.queued;
    expect(row).toMatchObject({
      peerTowerId: DEVVM,
      toAddress: 'afx://devvm/codev:architect:local',
      fromAddress: 'codev:architect:main',
      sentAt: T0,
      fromWorkspacePath: WS,
      fromAgent: 'architect:main',
      state: 'held',
      attempts: 0,
    });
    expect(row.messageId).toMatch(UUID);
    expect(JSON.parse(Buffer.from(row.payload).toString('utf8'))).toEqual({
      sentAt: T0,
      to: { workspace: 'codev', kind: 'architect', name: 'local' },
      from: { workspace: 'codev', kind: 'architect', name: 'main' },
      body: 'line one\nline two',
    });
    expect(store.getOutbox(f.db, row.messageId)?.payload.equals(row.payload)).toBe(true);
  });

  it('a sender with no agent identity, or a workspace with no address name, is stated as such', async () => {
    await f.sender.send(request({ from: { workspacePath: WS, agent: null, address: null, isBuilder: false } }));
    await f.sender.send(request({ from: { workspacePath: WS, agent: 'architect:main', address: { kind: 'architect', name: 'main' }, isBuilder: false } }));
    const payloads = f.queued.map((row) => JSON.parse(Buffer.from(row.payload).toString('utf8')) as { from: unknown });
    expect(payloads.map((p) => p.from)).toEqual([null, { kind: 'architect', name: 'main' }]);
    expect(f.queued.map((row) => row.fromAddress)).toEqual([null, 'architect:main']);
  });

  const told: Array<[string, () => FirstAnswer, Partial<PeerSendResult> & Record<string, unknown>]> = [
    ['delivered', () => ({ kind: 'resolved', state: 'accepted', answer: fromR({ outcome: 'delivered' }) }), { outcome: 'delivered', detail: null, duplicate: false }],
    [
      'delivered as a duplicate',
      () => ({ kind: 'resolved', state: 'accepted', answer: fromR({ outcome: 'delivered', duplicate: true }) }),
      { outcome: 'delivered', duplicate: true },
    ],
    [
      'held at the recipient',
      () => ({ kind: 'resolved', state: 'accepted', answer: fromR({ outcome: 'held', reason: 'held-for-release', detail: 'waiting for a human' }) }),
      { outcome: 'held', where: 'recipient', reason: 'held-for-release', detail: 'waiting for a human' },
    ],
    [
      'held on this Tower',
      () => ({ kind: 'held', reason: 'tower-offline', answer: null, ahead: 3 }),
      { outcome: 'held', where: 'this-tower', reason: 'tower-offline', ahead: 3 },
    ],
    [
      'refused by the peer, in its own words made printable',
      () => ({ kind: 'resolved', state: 'refused', answer: fromR({ outcome: 'refused', reason: 'no-grant', detail: 'no grant\u001b[31m for mbp' }) }),
      { outcome: 'refused', by: 'peer', reason: 'no-grant', detail: 'no grant[31m for mbp', message: null },
    ],
    [
      'refused by the cloud for rate, with when to try again',
      () => ({ kind: 'resolved', state: 'refused', answer: fromC(429, { outcome: 'refused', reason: 'rate-limited', retryAfterSec: 12 }) }),
      { outcome: 'refused', by: 'cloud', reason: 'rate-limited', retryAfterSec: 12 },
    ],
    ['expired before its first attempt', () => ({ kind: 'ended', state: 'expired' }), { outcome: 'refused', by: 'this-tower', reason: 'expired' }],
  ];
  for (const [name, first, expected] of told) {
    it(`${name}`, async () => {
      f.first = first;
      const result = await f.sender.send(request());
      expect(result).toMatchObject({ ...expected, peer: { towerId: DEVVM, name: 'devvm' } });
      expect((result as { messageId: string }).messageId).toBe(f.queued[0].messageId);
    });
  }
});

// ===========================================================================
// The record
// ===========================================================================

describe('the record of each refusal before a call', () => {
  it('names the peer as written, the addresses, and no message id or size; the peer id once it resolved', async () => {
    setSwitch(f.db, 'off', f.now);
    await f.sender.send(request());
    setSwitch(f.db, 'on', f.now);
    await f.sender.send(request({ from: { ...request().from, isBuilder: true, agent: 'spir-1967' } }));
    expect(f.records()).toMatchObject([
      {
        direction: 'outbound',
        kind: 'message',
        peerTowerId: null,
        peerSlug: 'devvm',
        messageId: null,
        fromAddress: 'codev:architect:main',
        toAddress: 'afx://devvm/codev:architect:local',
        payloadSize: null,
        outcome: 'refused',
        reason: 'remote-off',
        aggregate: false,
      },
      { peerTowerId: DEVVM, reason: 'builder-rule' },
    ]);
  });

  it('no body is ever recorded or logged', async () => {
    const body = 'the secret plan is 7c1e52aa';
    setSwitch(f.db, 'off', f.now);
    await f.sender.send(request({ body }));
    expect(JSON.stringify(f.records())).not.toContain('secret plan');
    expect(f.logs.join('\n')).not.toContain('secret plan');
  });
});
