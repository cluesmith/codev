/**
 * The stand-in relay's conformance to C's half of the wire contract (Spec 1967, plan
 * phase 2, layer A).
 *
 * The stand-in is driven here as the real cloud would be: by a bare WebSocket and HTTP/2
 * client playing the receiving Tower (it authenticates on `/tunnel` and serves the
 * forwarded requests over the socket, as Tower's tunnel client does), and by raw HTTP
 * calls playing the sending Tower. No Tower process and no Tower code is involved, except
 * one cross-check that a statement the stand-in issues verifies under `peer/contract.ts`:
 * two independent readings of the contract agreeing is the point of that one.
 *
 * Every time-dependent rule runs on an injected clock.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import http from 'node:http';
import http2 from 'node:http2';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocket, createWebSocketStream } from 'ws';
import {
  StandInRelay,
  STATEMENT_FIELDS,
  issueStatement,
  messagePayload,
  queryPayload,
  statementFieldProblems,
  type StandInAccount,
  type StandInRelayOptions,
  type StandInTower,
} from './helpers/stand-in-relay.js';
import { waitFor } from './helpers/tower-test-utils.js';
import { verifyRelayedRequest } from '../peer/contract.js';

/** The start of a minute on C's clock, so window arithmetic reads plainly. */
const T0 = 29_401_667 * 60_000;

// ===========================================================================
// A bare receiving Tower: WebSocket + HTTP/2 server over it
// ===========================================================================

interface ReceivedRequest {
  method: string;
  path: string;
  headers: http2.IncomingHttpHeaders;
  body: Buffer;
}

type Handler = (stream: http2.ServerHttp2Stream, request: ReceivedRequest) => void;

interface FakeTower {
  authOk: Record<string, any>;
  received: ReceivedRequest[];
  handler: Handler;
  /** Streams R saw closed, in order (a reset by C included). */
  closedStreams: number;
  close(): Promise<void>;
}

function respond(stream: http2.ServerHttp2Stream, status: number, headers: Record<string, string>, body: string | Buffer): void {
  if (stream.destroyed) return;
  stream.respond({ ':status': status, ...headers });
  stream.end(body);
}

const DELIVERED = '{"v":1,"outcome":"delivered"}';
const answerDelivered: Handler = (stream) =>
  respond(stream, 200, { 'content-type': 'application/json', 'x-codev-peer-outcome': 'delivered' }, DELIVERED);

const STATES_V1 = { protocols: [1], remoteMessaging: 'on' };

/** Connect as a Tower. `peer` is the `auth` message's `peer` field; `'absent'` leaves it out. */
async function connectFake(relay: StandInRelay, apiKey: string, peer: unknown = STATES_V1): Promise<FakeTower> {
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/tunnel`, { perMessageDeflate: false });
  const fake: FakeTower = {
    authOk: {},
    received: [],
    handler: answerDelivered,
    closedStreams: 0,
    close: async () => {
      ws.terminate();
    },
  };
  await new Promise<void>((resolve, reject) => {
    ws.once('error', reject);
    ws.once('open', () => ws.send(JSON.stringify({ type: 'auth', apiKey, ...(peer === 'absent' ? {} : { peer }) })));
    // The H2 preface follows `auth_ok` at once, so the server must be in place before
    // this handler returns, as in Tower's tunnel client.
    ws.once('message', (data) => {
      fake.authOk = JSON.parse(data.toString());
      if (fake.authOk.type === 'auth_ok') {
        const socketStream = createWebSocketStream(ws);
        socketStream.on('error', () => {});
        const server = http2.createServer();
        server.on('session', (session) => session.on('error', () => {}));
        server.on('stream', (stream, headers) => {
          const chunks: Buffer[] = [];
          stream.on('error', () => {});
          stream.on('close', () => fake.closedStreams++);
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => {
            const request = {
              method: String(headers[':method']),
              path: String(headers[':path']),
              headers,
              body: Buffer.concat(chunks),
            };
            fake.received.push(request);
            fake.handler(stream, request);
          });
        });
        server.emit('connection', socketStream);
      }
      resolve();
    });
  });
  return fake;
}

const secretOf = (fake: FakeTower) => Buffer.from(fake.authOk.relay.sessionSecret, 'base64url');
const macUnder = (secret: Buffer, statementHeader: string) =>
  createHmac('sha256', secret).update(Buffer.from(statementHeader, 'base64url')).digest('base64url');
const statementOf = (request: ReceivedRequest) =>
  JSON.parse(Buffer.from(String(request.headers['x-codev-peer-statement']), 'base64url').toString('utf8'));

// ===========================================================================
// A bare sending Tower: raw HTTP
// ===========================================================================

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  json: any;
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
afterAll(() => agent.destroy());

function call(
  relay: StandInRelay,
  method: string,
  path: string,
  options: { key?: string; headers?: Record<string, string>; body?: Uint8Array | string; chunked?: boolean } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      ...(options.key !== undefined ? { authorization: `Bearer ${options.key}` } : {}),
      ...options.headers,
    };
    const body = options.body === undefined ? undefined : Buffer.from(options.body);
    if (body && !options.chunked) headers['content-length'] = String(body.length);
    const req = http.request({ host: '127.0.0.1', port: relay.port, method, path, headers, agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const replyBody = Buffer.concat(chunks);
        let json: unknown;
        try {
          json = JSON.parse(replyBody.toString('utf8'));
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: replyBody, json });
      });
    });
    req.on('error', reject);
    if (body && options.chunked) {
      // No Content-Length: the size is only known while reading.
      const half = Math.floor(body.length / 2);
      req.write(body.subarray(0, half));
      req.write(body.subarray(half));
    } else if (body) {
      req.write(body);
    }
    req.end();
  });
}

interface RelayCall {
  kind?: string | null;
  to?: string | null;
  requestId?: string | null;
  version?: string | null;
  payload?: Uint8Array | string;
  headers?: Record<string, string>;
  chunked?: boolean;
}

const PAYLOAD = messagePayload({
  sentAt: T0,
  to: { workspace: 'codev', kind: 'architect', name: 'local' },
  from: { workspace: 'codev', kind: 'architect', name: 'main' },
  body: 'CI is green on the tunnel branch',
});

/** `POST /api/peer/relay` with the four headers; `null` leaves one out. */
function relayCall(relay: StandInRelay, key: string | undefined, request: RelayCall): Promise<Reply> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...request.headers };
  const set = (name: string, value: string | null | undefined, fallback: string) => {
    if (value !== null) headers[name] = value ?? fallback;
  };
  set('x-codev-peer-version', request.version, '1');
  set('x-codev-peer-kind', request.kind, 'message');
  set('x-codev-peer-to', request.to, 'nowhere');
  set('x-codev-peer-request-id', request.requestId, randomUUID());
  return call(relay, 'POST', '/api/peer/relay', { key, headers, body: request.payload ?? PAYLOAD, chunked: request.chunked });
}

/** What C answers in its own shape: the status and the body, with the outcome header checked. */
function cloudAnswer(reply: Reply): { status: number; body: Record<string, unknown> } {
  expect(reply.headers['content-type']).toBe('application/json');
  expect(reply.headers['x-codev-peer-outcome']).toBe(reply.json?.outcome);
  return { status: reply.status, body: reply.json };
}

// ===========================================================================
// Fixtures
// ===========================================================================

let clock = T0;
let relay: StandInRelay;
let ana: StandInAccount;
let bob: StandInAccount;
let mbp: StandInTower;
let devvm: StandInTower;
let spare: StandInTower;
let bobTower: StandInTower;
const fakes: FakeTower[] = [];

async function startRelay(options: StandInRelayOptions = {}): Promise<void> {
  relay = new StandInRelay({ now: () => clock, ...options });
  await relay.start();
  ana = relay.addAccount({ ownerId: 'usr_ana', ownerEmail: 'ana@example.com' });
  bob = relay.addAccount({ ownerId: 'usr_bob', ownerEmail: 'bob@example.com' });
  mbp = relay.addTower({ account: ana, slug: 'ana-s-mbp', name: "Ana's MBP", towerId: '01JMBP000000000000000000AA' });
  devvm = relay.addTower({ account: ana, slug: 'devvm', name: 'Dev VM', towerId: '01JDEVVM0000000000000000AA' });
  spare = relay.addTower({ account: ana, slug: 'spare', towerId: '01JSPARE000000000000000AA' });
  bobTower = relay.addTower({ account: bob, slug: 'bobs-tower', towerId: '01JBOB0000000000000000000A' });
}

async function connect(tower: StandInTower, peer: unknown = STATES_V1): Promise<FakeTower> {
  const fake = await connectFake(relay, tower.apiKey, peer);
  fakes.push(fake);
  return fake;
}

async function disconnect(fake: FakeTower, tower: StandInTower): Promise<void> {
  await fake.close();
  expect(await waitFor(async () => relay.session(tower.towerId) === null, 5_000, 10)).toBe(true);
}

beforeEach(async () => {
  clock = T0;
  await startRelay();
});

afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.close();
  await relay.stop();
});

/** Send `count` message calls from mbp to recipients that are no Tower of the account. */
async function messagesToNowhere(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const reply = await relayCall(relay, mbp.apiKey, { to: `made-up-${i}` });
    expect(reply.status).toBe(404);
  }
}

// ===========================================================================
// Section 1: the tunnel handshake
// ===========================================================================

describe('section 1: the tunnel handshake', () => {
  it("answers auth with the Tower's id, slug and display name, and a relay with a new 32-byte secret per connection", async () => {
    const first = await connect(devvm);
    expect(first.authOk).toMatchObject({
      type: 'auth_ok',
      towerId: devvm.towerId,
      slug: 'devvm',
      name: 'Dev VM',
      relay: { protocols: [1] },
    });
    const secret = first.authOk.relay.sessionSecret as string;
    // Strict base64url: the one canonical spelling of exactly 32 bytes.
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
    expect(Buffer.from(secret, 'base64url').toString('base64url')).toBe(secret);

    await disconnect(first, devvm);
    const second = await connect(devvm);
    expect(second.authOk.relay.sessionSecret).not.toBe(secret);
    expect(relay.sessionsOpened(devvm.towerId)).toBe(2);
  });

  it('closes the session, and with it the secret, when the key is replaced; the old key no longer authenticates [r5]', async () => {
    const before = await connect(mbp);
    const oldKey = mbp.apiKey;
    const newKey = relay.rotateKey(mbp.towerId);
    expect(newKey).not.toBe(oldKey);
    expect(await waitFor(async () => relay.session(mbp.towerId) === null, 5_000, 10)).toBe(true);
    expect(cloudAnswer(await relayCall(relay, devvm.apiKey, { to: mbp.towerId })).body.reason).toBe('tower-offline');
    expect((await call(relay, 'GET', '/api/peer/towers', { key: oldKey })).status).toBe(401);
    expect((await call(relay, 'GET', '/api/peer/towers', { key: newKey })).status).toBe(200);
    const after = await connect(mbp);
    expect(after.authOk.type).toBe('auth_ok');
    expect(after.authOk.relay.sessionSecret).not.toBe(before.authOk.relay.sessionSecret);
    expect(relay.sessionsOpened(mbp.towerId)).toBe(2);
  });

  it("records what a session states on the Tower's row too, so the listing shows it while the Tower is offline", async () => {
    const fake = await connect(devvm, { protocols: [1], remoteMessaging: 'on' });
    const listed = async () => (await call(relay, 'GET', '/api/peer/towers', { key: mbp.apiKey })).json.towers[0];
    expect(await listed()).toEqual({ towerId: devvm.towerId, slug: 'devvm', online: true, protocols: [1], remoteMessaging: 'on' });

    await disconnect(fake, devvm);
    expect(await listed()).toEqual({ towerId: devvm.towerId, slug: 'devvm', online: false, protocols: [1], remoteMessaging: 'on' });
  });

  it("treats today's handshake, and a malformed peer field, as a Tower that does not speak the protocol, and still connects", async () => {
    const malformed: unknown[] = [
      'yes',
      null,
      [],
      { protocols: '1', remoteMessaging: 'on' },
      { protocols: [0], remoteMessaging: 'on' },
      { protocols: [1.5], remoteMessaging: 'on' },
      { protocols: [1], remoteMessaging: 'maybe' },
      { protocols: [1] },
    ];
    for (const peer of ['absent', ...malformed]) {
      const fake = await connect(devvm, peer);
      expect(fake.authOk.type, JSON.stringify(peer)).toBe('auth_ok');
      expect(relay.handshakes.at(-1)?.peer, JSON.stringify(peer)).toBe(peer === 'absent' ? 'absent' : 'malformed');
      const listing = (await call(relay, 'GET', '/api/peer/towers', { key: mbp.apiKey })).json;
      expect(listing.towers[0], JSON.stringify(peer)).toMatchObject({ online: true, protocols: [], remoteMessaging: 'unknown' });
      await disconnect(fake, devvm);
    }
  });

  it('refuses a key it does not know', async () => {
    const fake = await connectFake(relay, 'ctk_not-a-key');
    fakes.push(fake);
    expect(fake.authOk).toEqual({ type: 'auth_error', reason: 'invalid_api_key' });
  });

  it('states relay: null, or (an old cloud) no relay at all, as its mode says', async () => {
    relay.setMode('null');
    const withNull = await connect(devvm);
    expect(withNull.authOk).toMatchObject({ type: 'auth_ok', relay: null });
    await disconnect(withNull, devvm);

    relay.setMode('absent');
    const old = await connect(devvm);
    expect(old.authOk.type).toBe('auth_ok');
    expect('relay' in old.authOk).toBe(false);
  });
});

// ===========================================================================
// Section 11: the shared vectors, with the stand-in as the issuing side
// ===========================================================================

interface VectorCase {
  name: string;
  secret: string;
  statement: string;
  mac: string;
  payload: string;
  verdict: 'verified' | 'not-verified' | 'refused';
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../types/fixtures/peer-contract-vectors.json', import.meta.url)), 'utf8'),
) as { cases: VectorCase[] };

/** A case's statement as a JSON object, or `null` when its bytes are not one. */
function parsedStatement(c: VectorCase): Record<string, any> | null {
  try {
    const parsed = JSON.parse(Buffer.from(c.statement, 'base64url').toString('utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

describe('section 11: the shared vectors, with the stand-in as the issuing side', () => {
  it("builds every verified case written in its own serialisation, statement and MAC byte for byte, from the case's secret, records and payload", () => {
    const issuedNames: string[] = [];
    for (const c of vectors.cases.filter((v) => v.verdict === 'verified')) {
      const statement = parsedStatement(c);
      const text = Buffer.from(c.statement, 'base64url').toString('utf8');
      // C writes its thirteen fields with JSON.stringify, in its order. A case written any
      // other way (keys reversed, an unknown field, `1.0`) is one another issuer could make.
      if (!statement || JSON.stringify(Object.keys(statement)) !== JSON.stringify(STATEMENT_FIELDS)) continue;
      if (JSON.stringify(statement) !== text) continue;

      const result = issueStatement(
        {
          kind: statement.kind,
          toTowerId: statement.toTowerId,
          fromTowerId: statement.fromTowerId,
          fromTowerSlug: statement.fromTowerSlug,
          fromOwnerId: statement.fromOwnerId,
          fromOwnerHandle: statement.fromOwnerHandle,
          fromOwnerEmail: statement.fromOwnerEmail,
          sameOwner: statement.sameOwner,
          requestId: statement.requestId,
          issuedAt: statement.issuedAt,
          statementId: statement.statementId,
        },
        Buffer.from(c.payload, 'base64url'),
        Buffer.from(c.secret, 'base64url'),
      );
      expect(result.ok, c.name).toBe(true);
      if (!result.ok) continue;
      expect(result.header, c.name).toBe(c.statement);
      expect(result.mac, c.name).toBe(c.mac);
      issuedNames.push(c.name);
    }
    expect(issuedNames).toContain('the worked case of section 11: a message, verified');
    // 42 of the 47 verified cases today; the other five are written as C does not write.
    expect(issuedNames.length).toBeGreaterThanOrEqual(42);
  });

  it('its own field rules refuse every statement the vectors decide at step 4, and pass every verified one', () => {
    let refused = 0;
    let passed = 0;
    for (const c of vectors.cases) {
      const statement = parsedStatement(c);
      if (!statement) continue;
      if (c.verdict === 'verified') {
        expect(statementFieldProblems(statement), c.name).toEqual([]);
        passed++;
      } else if (/\(step 4( before step \d)?\)$/.test(c.name) && !/given twice/.test(c.name)) {
        // A key given twice is invisible once parsed; JSON.parse keeps the last.
        expect(statementFieldProblems(statement), c.name).not.toEqual([]);
        refused++;
      }
    }
    // Every verified case, and the 73 step-4 cases whose duplicate key is not the point.
    expect(passed).toBe(vectors.cases.filter((c) => c.verdict === 'verified').length);
    expect(refused).toBeGreaterThanOrEqual(73);
  });
});

// ===========================================================================
// Section 4: the relay call and the order of C's checks
// ===========================================================================

describe("section 4: C's checks, in order", () => {
  it('step 1 before step 2: a caller without a valid key learns nothing about its headers', async () => {
    for (const key of [undefined, 'ctk_unknown']) {
      const malformed = cloudAnswer(await relayCall(relay, key, { to: devvm.towerId, requestId: 'not-a-uuid' }));
      const wellFormed = cloudAnswer(await relayCall(relay, key, { to: devvm.towerId }));
      expect(malformed).toEqual({ status: 401, body: { v: 1, outcome: 'refused', reason: 'unauthenticated' } });
      expect(wellFormed).toEqual(malformed);
    }
  });

  it('step 2: the request id, the kind, the recipient, Content-Encoding and the version', async () => {
    const malformed: RelayCall[] = [
      { requestId: null },
      { requestId: '6F1C2A9E-3B4D-4C5E-8F60-718293A4B5C6' },
      { requestId: '{6f1c2a9e-3b4d-4c5e-8f60-718293a4b5c6}' },
      { requestId: '6f1c2a9e3b4d4c5e8f60718293a4b5c6' },
      { kind: null },
      { kind: 'Message' },
      { kind: 'note' },
      { to: null },
      { to: '' },
      { to: mbp.towerId },
      { headers: { 'content-encoding': 'identity' } },
      { headers: { 'content-encoding': 'gzip' } },
    ];
    for (const request of malformed) {
      const answer = cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId, ...request }));
      expect(answer, JSON.stringify(request)).toEqual({ status: 400, body: { v: 1, outcome: 'refused', reason: 'malformed' } });
    }
    for (const version of [null, '2', '0', '01', 'one', '1.0']) {
      const answer = cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId, version }));
      expect(answer, String(version)).toEqual({
        status: 400,
        body: { v: 1, outcome: 'refused', reason: 'unsupported-version', supported: [1] },
      });
    }
    // Both wrong: the stand-in answers the malformed header first (its reading of the order).
    expect(cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId, kind: 'note', version: '2' })).body.reason).toBe(
      'malformed',
    );
  });

  it('step 2 before step 3: malformed headers on an oversized payload', async () => {
    const answer = await relayCall(relay, mbp.apiKey, { to: devvm.towerId, requestId: 'x', payload: Buffer.alloc(102_401) });
    expect(cloudAnswer(answer).body).toMatchObject({ outcome: 'refused', reason: 'malformed' });
  });

  it('step 3: at most 102 400 bytes, from Content-Length and again while reading', async () => {
    await connect(devvm);
    const atCap = await relayCall(relay, mbp.apiKey, { to: devvm.towerId, payload: Buffer.alloc(102_400, 0x61) });
    expect(atCap.status).toBe(200);
    for (const chunked of [false, true]) {
      const over = await relayCall(relay, mbp.apiKey, { to: devvm.towerId, payload: Buffer.alloc(102_401, 0x61), chunked });
      expect(cloudAnswer(over), `chunked: ${chunked}`).toEqual({ status: 413, body: { v: 1, outcome: 'refused', reason: 'too-large' } });
    }
    expect(relay.forwards).toHaveLength(1);
  });

  it('step 3 before step 4: an oversized payload once the per-Tower limit has tripped', async () => {
    await messagesToNowhere(60);
    const over = await relayCall(relay, mbp.apiKey, { to: devvm.towerId, payload: Buffer.alloc(102_401) });
    expect(cloudAnswer(over).status).toBe(413);
    expect(cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).status).toBe(429);
  });

  it('step 4 before step 5: the per-Tower limit, for a recipient that is no Tower of the account', async () => {
    await messagesToNowhere(60);
    const answer = cloudAnswer(await relayCall(relay, mbp.apiKey, { to: 'made-up-again' }));
    expect(answer).toEqual({ status: 429, body: { v: 1, outcome: 'refused', reason: 'rate-limited', retryAfterSec: 60 } });
  });

  it('step 5 before step 6: a recipient that has left the account, after its per-pair counter tripped', async () => {
    await connect(devvm);
    for (let i = 0; i < 30; i++) expect((await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).status).toBe(200);
    relay.moveTower(devvm.towerId, bob);
    const answer = cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId }));
    expect(answer).toEqual({ status: 404, body: { v: 1, outcome: 'refused', reason: 'unknown-tower' } });
    relay.moveTower(devvm.towerId, ana);
    expect(cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).body.reason).toBe('rate-limited');
  });

  it('step 6 before step 7: the per-pair limit for a recipient that has gone offline', async () => {
    await connect(devvm);
    for (let i = 0; i < 30; i++) expect((await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).status).toBe(200);
    relay.setOffline(devvm.towerId, true);
    const answer = cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId }));
    expect(answer).toEqual({ status: 429, body: { v: 1, outcome: 'refused', reason: 'rate-limited', retryAfterSec: 60 } });
  });

  it('step 7 before step 8: no live session, for a Tower whose last session stated no version', async () => {
    const fake = await connect(devvm, 'absent');
    await disconnect(fake, devvm);
    const answer = cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId }));
    expect(answer).toEqual({ status: 503, body: { v: 1, outcome: 'unavailable', reason: 'tower-offline' } });
  });

  it('step 8 before step 9: a session that states no version, from a sender whose record does not fit', async () => {
    await connect(devvm, 'absent');
    relay.writeRecordUnchecked(mbp.towerId, { slug: 'Ana_MBP' });
    const answer = cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId }));
    expect(answer).toEqual({ status: 409, body: { v: 1, outcome: 'refused', reason: 'peer-unsupported' } });
  });

  it('step 9 before step 10: a record outside its rule is 500 cloud-error, and nothing is forwarded', async () => {
    const fake = await connect(devvm);
    const outside: Array<{ slug?: string; ownerEmail?: string; ownerId?: string; ownerHandle?: string }> = [
      { slug: 'Ana_MBP' },
      { ownerEmail: `ana${String.fromCodePoint(0x202e)}@example.com` },
      { ownerEmail: `${'a'.repeat(250)}@x.yz` },
      { ownerId: 'usr ana' },
      { ownerHandle: 'Ana' },
    ];
    for (const patch of outside) {
      relay.writeRecordUnchecked(mbp.towerId, patch);
      const answer = cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId }));
      expect(answer, JSON.stringify(patch)).toEqual({ status: 500, body: { v: 1, outcome: 'unavailable', reason: 'cloud-error' } });
      relay.restoreRecord(mbp.towerId);
    }
    expect(fake.received).toEqual([]);
  });

  it('a record written unchecked breaks only the statements its own Tower sends, until restored', async () => {
    const toDevvm = await connect(devvm);
    const toMbp = await connect(mbp);
    relay.renameTower(mbp.towerId, 'ana-laptop');
    relay.writeRecordUnchecked(mbp.towerId, { slug: 'Ana_Laptop', ownerHandle: 'Ana' });
    expect(cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).body.reason).toBe('cloud-error');
    // The other direction of the pair, and the account the two share, are untouched.
    expect((await relayCall(relay, devvm.apiKey, { to: mbp.towerId })).status).toBe(200);
    expect(statementOf(toMbp.received[0])).toMatchObject({ fromTowerId: devvm.towerId, fromOwnerId: 'usr_ana', fromOwnerHandle: null });
    expect(ana.ownerHandle).toBeNull();

    relay.restoreRecord(mbp.towerId);
    expect((await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).status).toBe(200);
    expect(statementOf(toDevvm.received[0])).toMatchObject({ fromTowerSlug: 'ana-laptop', fromOwnerHandle: null });
  });

  it('step 8: a live session that states another version, or none, is 409 peer-unsupported', async () => {
    const other = await connect(devvm, { protocols: [2], remoteMessaging: 'on' });
    expect(cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).status).toBe(409);
    await disconnect(other, devvm);
    await connect(devvm);
    expect((await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).status).toBe(200);
    relay.setStatesNoVersion(devvm.towerId, true);
    expect(cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).body.reason).toBe('peer-unsupported');
  });
});

// ===========================================================================
// Section 7: what counts
// ===========================================================================

describe('section 7: limits, and what counts', () => {
  it("unknown-tower counts against the sender's per-Tower limit and never touches a per-pair counter", async () => {
    const elsewhere = cloudAnswer(await relayCall(relay, mbp.apiKey, { to: bobTower.towerId }));
    const nowhere = cloudAnswer(await relayCall(relay, mbp.apiKey, { to: 'no-such-tower' }));
    // The same answer whether or not the Tower exists on another account.
    expect(elsewhere).toEqual({ status: 404, body: { v: 1, outcome: 'refused', reason: 'unknown-tower' } });
    expect(nowhere).toEqual(elsewhere);
    expect(cloudAnswer(await relayCall(relay, mbp.apiKey, { to: bobTower.towerId, kind: 'query', payload: queryPayload(T0) })).status).toBe(
      404,
    );
    // Two message calls above, and 58 more: the per-Tower limit of 60 is reached.
    await messagesToNowhere(58);
    expect(relay.pairCounters().size).toBe(0);
    expect(cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).body.reason).toBe('rate-limited');
    expect(relay.pairCounters().size).toBe(0);
  }, 20_000);

  it('a call whose kind is not valid counts as a message', async () => {
    await connect(devvm);
    for (let i = 0; i < 60; i++) {
      const answer = await relayCall(relay, mbp.apiKey, { to: devvm.towerId, kind: i === 0 ? null : 'note' });
      expect(answer.status).toBe(400);
    }
    expect(cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).body.reason).toBe('rate-limited');
    expect(relay.forwards).toEqual([]);
  }, 20_000);

  it('queries are limited per pair only: they do not count against the per-Tower message limit', async () => {
    await connect(devvm);
    for (let i = 0; i < 60; i++) {
      expect((await relayCall(relay, mbp.apiKey, { to: `made-up-${i}`, kind: 'query', payload: queryPayload(T0) })).status).toBe(404);
    }
    expect((await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).status).toBe(200);
  }, 20_000);

  it('every authenticated call to an /api/peer/… route counts toward the 600 a minute, and query calls to made-up recipients hit it at step 4', async () => {
    for (let i = 0; i < 10; i++) expect((await call(relay, 'GET', '/api/peer/towers', { key: mbp.apiKey })).status).toBe(200);
    for (let i = 0; i < 10; i++) {
      const report = await call(relay, 'PUT', '/api/peer/state', { key: mbp.apiKey, body: '{"remoteMessaging":"on"}' });
      expect(report.status).toBe(204);
    }
    for (let i = 0; i < 580; i++) {
      const answer = await relayCall(relay, mbp.apiKey, { to: `made-up-${i}`, kind: 'query', payload: queryPayload(T0) });
      expect(answer.status).toBe(404);
    }
    // A caller without a key is not counted against the Tower.
    expect((await relayCall(relay, undefined, { to: 'made-up', kind: 'query' })).status).toBe(401);

    const ceiling = cloudAnswer(await relayCall(relay, mbp.apiKey, { to: 'made-up-601', kind: 'query', payload: queryPayload(T0) }));
    expect(ceiling).toEqual({ status: 429, body: { v: 1, outcome: 'refused', reason: 'rate-limited', retryAfterSec: 60 } });
    expect(cloudAnswer(await call(relay, 'GET', '/api/peer/towers', { key: mbp.apiKey })).body.reason).toBe('rate-limited');
    // Other Towers have their own ceilings.
    expect((await call(relay, 'GET', '/api/peer/towers', { key: devvm.apiKey })).status).toBe(200);
    expect(relay.pairCounters().size).toBe(0);

    clock = T0 + 60_000;
    expect((await relayCall(relay, mbp.apiKey, { to: 'made-up-602', kind: 'query', payload: queryPayload(T0) })).status).toBe(404);
  }, 30_000);

  it('per pair: 30 message calls and 10 query calls a minute, counted whatever the outcome after step 5', async () => {
    relay.setOffline(devvm.towerId, true);
    for (let i = 0; i < 30; i++) {
      expect(cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).body.reason).toBe('tower-offline');
    }
    for (let i = 0; i < 10; i++) {
      const answer = await relayCall(relay, mbp.apiKey, { to: devvm.towerId, kind: 'query', payload: queryPayload(T0) });
      expect(cloudAnswer(answer).body.reason).toBe('tower-offline');
    }
    expect(relay.pairCounters()).toEqual(
      new Map([
        [`message:${mbp.towerId}>${devvm.towerId}`, 30],
        [`query:${mbp.towerId}>${devvm.towerId}`, 10],
      ]),
    );
    expect(cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).body.reason).toBe('rate-limited');
    const query = await relayCall(relay, mbp.apiKey, { to: devvm.towerId, kind: 'query', payload: queryPayload(T0) });
    expect(cloudAnswer(query).body.reason).toBe('rate-limited');
    // Another recipient on the account has its own counter.
    expect(cloudAnswer(await relayCall(relay, mbp.apiKey, { to: spare.towerId })).body.reason).toBe('tower-offline');
  }, 20_000);

  it("fixed one-minute windows on C's clock, with retryAfterSec the time left in the window; a deploy resets them", async () => {
    relay.setOffline(devvm.towerId, true);
    for (let i = 0; i < 30; i++) await relayCall(relay, mbp.apiKey, { to: devvm.towerId });
    clock = T0 + 15_500;
    expect(cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).body).toMatchObject({
      reason: 'rate-limited',
      retryAfterSec: 45,
    });
    clock = T0 + 59_999;
    expect(cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).body.retryAfterSec).toBe(1);
    clock = T0 + 60_000;
    expect(cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).body.reason).toBe('tower-offline');

    for (let i = 0; i < 29; i++) await relayCall(relay, mbp.apiKey, { to: devvm.towerId });
    expect(cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).body.reason).toBe('rate-limited');
    relay.deploy();
    expect(cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).body.reason).toBe('tower-offline');
  }, 20_000);
});

// ===========================================================================
// Sections 5 and 6: the forward and R's answer
// ===========================================================================

describe('sections 5 and 6: the forward, and what C checks of the answer', () => {
  it("forwards POST /__tower/peer with the payload bytes untouched, and a statement from its own records that verifies under the session's secret", async () => {
    const fake = await connect(devvm);
    // Not JSON and not UTF-8: C never parses the payload.
    const payload = Buffer.concat([Buffer.from('{"body":"caf'), Buffer.from([0xc3, 0xa9, 0xff, 0x00]), Buffer.from('"}')]);
    const requestId = '6f1c2a9e-3b4d-4c5e-8f60-718293a4b5c6';
    clock = T0 + 123;
    const reply = await relayCall(relay, mbp.apiKey, { to: devvm.towerId, requestId, payload });
    expect(reply.status).toBe(200);

    expect(fake.received).toHaveLength(1);
    const [forwarded] = fake.received;
    expect(forwarded.method).toBe('POST');
    expect(forwarded.path).toBe('/__tower/peer');
    expect(forwarded.headers['content-type']).toBe('application/json');
    expect(forwarded.body.equals(payload)).toBe(true);
    // No routing header of S's call reaches R: everything R learns is in the statement.
    expect(Object.keys(forwarded.headers).filter((name) => name.startsWith('x-codev-peer-')).sort()).toEqual([
      'x-codev-peer-mac',
      'x-codev-peer-statement',
    ]);

    const statementHeader = String(forwarded.headers['x-codev-peer-statement']);
    expect(Buffer.byteLength(statementHeader)).toBeLessThanOrEqual(4_096);
    expect(String(forwarded.headers['x-codev-peer-mac'])).toBe(macUnder(secretOf(fake), statementHeader));
    const statement = statementOf(forwarded);
    expect(Object.keys(statement)).toEqual([...STATEMENT_FIELDS]);
    expect(statement).toEqual({
      v: 1,
      kind: 'message',
      toTowerId: devvm.towerId,
      fromTowerId: mbp.towerId,
      fromTowerSlug: 'ana-s-mbp',
      fromOwnerId: 'usr_ana',
      fromOwnerHandle: null,
      fromOwnerEmail: 'ana@example.com',
      sameOwner: true,
      requestId,
      issuedAt: T0 + 123,
      statementId: statement.statementId,
      payloadSha256: createHash('sha256').update(payload).digest('hex'),
    });
    expect(statement.statementId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(statement.statementId, 'base64url').toString('base64url')).toBe(statement.statementId);

    // The Tower's own reading of the contract agrees (the one use of contract.ts here).
    const verdict = verifyRelayedRequest({
      statementHeader,
      macHeader: String(forwarded.headers['x-codev-peer-mac']),
      body: forwarded.body,
      sessionSecret: secretOf(fake),
      receiverTowerId: devvm.towerId,
      now: T0 + 500,
    });
    expect(verdict.verdict).toBe('verified');
  });

  it("states the sender's current slug, a query's kind, and a new statement id for each forward of one message", async () => {
    const fake = await connect(devvm);
    const requestId = randomUUID();
    await relayCall(relay, mbp.apiKey, { to: devvm.towerId, requestId });
    relay.renameTower(mbp.towerId, 'ana-laptop');
    await relayCall(relay, mbp.apiKey, { to: devvm.towerId, requestId });
    await relayCall(relay, mbp.apiKey, { to: devvm.towerId, kind: 'query', payload: queryPayload(T0) });

    const [first, second, query] = fake.received.map(statementOf);
    expect(first.fromTowerSlug).toBe('ana-s-mbp');
    expect(second.fromTowerSlug).toBe('ana-laptop');
    expect(second.requestId).toBe(first.requestId);
    expect(second.statementId).not.toBe(first.statementId);
    expect(query.kind).toBe('query');
  });

  it("passes R's 200 through unchanged: the status, the two headers and the body, which it never parses", async () => {
    const fake = await connect(devvm);
    const bodies = ['not json at all', '{"v":1,"outcome":"held","reason":"busy"}', ''];
    for (const body of bodies) {
      fake.handler = (stream) =>
        respond(stream, 200, { 'content-type': 'application/json; charset=utf-8', 'x-codev-peer-outcome': 'held' }, body);
      const reply = await relayCall(relay, mbp.apiKey, { to: devvm.towerId });
      expect(reply.status).toBe(200);
      expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(reply.headers['x-codev-peer-outcome']).toBe('held');
      expect(reply.body.toString('utf8')).toBe(body);
    }
    for (const outcome of ['delivered', 'held', 'refused', 'not-verified', 'answered']) {
      fake.handler = (stream) => respond(stream, 200, { 'content-type': 'Application/JSON', 'x-codev-peer-outcome': outcome }, '{}');
      expect((await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).headers['x-codev-peer-outcome']).toBe(outcome);
    }
  });

  it("answers 502 tower-error when R's answer fails a check: its status, media type, size or outcome header", async () => {
    const fake = await connect(devvm);
    const json = { 'content-type': 'application/json', 'x-codev-peer-outcome': 'delivered' };
    const failing: Array<[string, Handler]> = [
      ['status 500', (s) => respond(s, 500, json, DELIVERED)],
      ['status 201', (s) => respond(s, 201, json, DELIVERED)],
      ['text/plain', (s) => respond(s, 200, { ...json, 'content-type': 'text/plain' }, DELIVERED)],
      ['application/jsonx', (s) => respond(s, 200, { ...json, 'content-type': 'application/jsonx' }, DELIVERED)],
      ['no media type', (s) => respond(s, 200, { 'x-codev-peer-outcome': 'delivered' }, DELIVERED)],
      ['no outcome header', (s) => respond(s, 200, { 'content-type': 'application/json' }, DELIVERED)],
      ["C's outcome", (s) => respond(s, 200, { ...json, 'x-codev-peer-outcome': 'unavailable' }, DELIVERED)],
      ['65 537 bytes', (s) => respond(s, 200, json, Buffer.alloc(65_537, 0x20))],
    ];
    for (const [name, handler] of failing) {
      fake.handler = handler;
      const answer = cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId }));
      expect(answer, name).toEqual({ status: 502, body: { v: 1, outcome: 'unavailable', reason: 'tower-error' } });
      // What R said is kept on the forward, as far as C read it.
      const said = relay.forwards.at(-1)!.answer;
      expect(said?.status, name).toBe(name === 'status 500' ? 500 : name === 'status 201' ? 201 : 200);
      expect(said!.body.length, name).toBeLessThanOrEqual(65_536);
    }
    expect(relay.forwards.find((f) => f.answer?.headers['content-type'] === 'text/plain')).toBeDefined();
    fake.handler = (s) => respond(s, 200, json, Buffer.alloc(65_536, 0x20));
    const atCap = await relayCall(relay, mbp.apiKey, { to: devvm.towerId });
    expect(atCap.status).toBe(200);
    expect(atCap.body).toHaveLength(65_536);
  });

  it('answers 504 no-answer when R gives no complete answer within the relay timeout, or its stream dies first', async () => {
    await relay.stop();
    await startRelay({ relayTimeoutMs: 300 });
    const fake = await connect(devvm);

    fake.handler = () => {
      // R never answers.
    };
    const started = Date.now();
    const silent = cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId }));
    expect(silent).toEqual({ status: 504, body: { v: 1, outcome: 'unavailable', reason: 'no-answer' } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    // C walked away from the stream: R sees it closed.
    expect(await waitFor(async () => fake.closedStreams === 1, 2_000, 10)).toBe(true);

    fake.handler = (stream) => {
      stream.respond({ ':status': 200, 'content-type': 'application/json', 'x-codev-peer-outcome': 'delivered' });
      stream.write('{"v":1,');
      stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
    };
    expect(cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).body.reason).toBe('no-answer');

    fake.handler = (stream) => stream.close(http2.constants.NGHTTP2_REFUSED_STREAM);
    expect(cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).body.reason).toBe('no-answer');
  });

  it("uses the secret and the connection of R's current session: after a reconnect, the new secret", async () => {
    const before = await connect(devvm);
    await relayCall(relay, mbp.apiKey, { to: devvm.towerId });
    await disconnect(before, devvm);
    const after = await connect(devvm);
    await relayCall(relay, mbp.apiKey, { to: devvm.towerId });

    expect(before.received).toHaveLength(1);
    expect(after.received).toHaveLength(1);
    const header = String(after.received[0].headers['x-codev-peer-statement']);
    expect(String(after.received[0].headers['x-codev-peer-mac'])).toBe(macUnder(secretOf(after), header));
    expect(String(after.received[0].headers['x-codev-peer-mac'])).not.toBe(macUnder(secretOf(before), header));
  });

  it('never answers a relay call with 200 itself: every 200 is R deciding', async () => {
    const fake = await connect(devvm);
    await relayCall(relay, undefined, { to: devvm.towerId });
    await relayCall(relay, mbp.apiKey, { to: devvm.towerId, kind: 'note' });
    await relayCall(relay, mbp.apiKey, { to: 'made-up' });
    await relayCall(relay, mbp.apiKey, { to: devvm.towerId });
    relay.setOffline(devvm.towerId, true);
    await relayCall(relay, mbp.apiKey, { to: devvm.towerId });
    relay.setOffline(devvm.towerId, false);
    fake.handler = (s) => respond(s, 200, { 'content-type': 'text/plain', 'x-codev-peer-outcome': 'delivered' }, 'x');
    await relayCall(relay, mbp.apiKey, { to: devvm.towerId });

    const relayCalls = relay.calls.filter((c) => c.route === 'relay');
    expect(relayCalls.map((c) => [c.status, c.answer])).toEqual([
      [401, 'cloud'],
      [400, 'cloud'],
      [404, 'cloud'],
      [200, 'receiver'],
      [503, 'cloud'],
      [502, 'cloud'],
    ]);
  });
});

// ===========================================================================
// Faults
// ===========================================================================

describe('faults the stand-in injects', () => {
  it('a Tower offline: 503 tower-offline at step 7, and online: false in the listing, while its tunnel stays up', async () => {
    const fake = await connect(devvm);
    relay.setOffline(devvm.towerId, true);
    expect(cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).status).toBe(503);
    expect((await call(relay, 'GET', '/api/peer/towers', { key: mbp.apiKey })).json.towers[0].online).toBe(false);
    relay.setOffline(devvm.towerId, false);
    expect((await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).status).toBe(200);
    expect(fake.received).toHaveLength(1);
  });

  it('a forward held past the relay timeout: R acts on it, and S is told 504 no-answer', async () => {
    const fake = await connect(devvm);
    relay.injectFault({ kind: 'answer-late' }, 1);
    const late = cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId }));
    expect(late).toEqual({ status: 504, body: { v: 1, outcome: 'unavailable', reason: 'no-answer' } });
    expect(fake.received).toHaveLength(1);
    expect(relay.forwards[0].answer?.status).toBe(200);
    expect((await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).status).toBe(200);
  });

  it('a stream reset before the answer is complete: 504 no-answer, and R sees its stream reset', async () => {
    const fake = await connect(devvm);
    fake.handler = (stream) => {
      stream.respond({ ':status': 200, 'content-type': 'application/json', 'x-codev-peer-outcome': 'delivered' });
      stream.write('{"v":1,');
      setTimeout(() => stream.end('"outcome":"delivered"}'), 100);
    };
    relay.injectFault({ kind: 'reset-stream', to: devvm.towerId }, 1);
    expect(cloudAnswer(await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).body.reason).toBe('no-answer');
    expect(fake.received).toHaveLength(1);
    expect(await waitFor(async () => fake.closedStreams === 1, 2_000, 10)).toBe(true);
  });

  it('a deploy: every tunnel dropped, and each reconnect gets a new secret', async () => {
    const r = await connect(devvm);
    const s = await connect(mbp);
    relay.deploy();
    expect(await waitFor(async () => relay.session(devvm.towerId) === null && relay.session(mbp.towerId) === null, 5_000, 10)).toBe(
      true,
    );
    const r2 = await connect(devvm);
    const s2 = await connect(mbp);
    expect(r2.authOk.relay.sessionSecret).not.toBe(r.authOk.relay.sessionSecret);
    expect(s2.authOk.relay.sessionSecret).not.toBe(s.authOk.relay.sessionSecret);
  });

  it('an old cloud: no relay field, and 404 without a body on every peer route', async () => {
    relay.setMode('absent');
    const fake = await connect(devvm);
    expect('relay' in fake.authOk).toBe(false);
    const replies = [
      await relayCall(relay, mbp.apiKey, { to: devvm.towerId }),
      await call(relay, 'GET', '/api/peer/towers', { key: mbp.apiKey }),
      await call(relay, 'PUT', '/api/peer/state', { key: mbp.apiKey, body: '{"remoteMessaging":"on"}' }),
    ];
    for (const reply of replies) {
      expect(reply.status).toBe(404);
      expect(reply.body).toHaveLength(0);
      expect(reply.headers['content-type']).toBeUndefined();
      expect(reply.headers['x-codev-peer-outcome']).toBeUndefined();
    }
    expect(fake.received).toEqual([]);
  });

  it('relay: null: stated in auth_ok and in the listing, and no relay route', async () => {
    relay.setMode('null');
    await connect(devvm);
    const listing = await call(relay, 'GET', '/api/peer/towers', { key: mbp.apiKey });
    expect(listing.status).toBe(200);
    expect(listing.json.relay).toBeNull();
    const reply = await relayCall(relay, mbp.apiKey, { to: devvm.towerId });
    expect(reply.status).toBe(404);
    expect(reply.body).toHaveLength(0);
  });

  it('bodyless 401, 403, 404, 429 and 5xx from something in front of C, each consumed once', async () => {
    await connect(devvm);
    for (const status of [401, 403, 404, 429, 500, 502, 503, 504]) {
      relay.injectFault({ kind: 'bodyless', status }, 1);
      const reply = await relayCall(relay, mbp.apiKey, { to: devvm.towerId });
      expect(reply.status).toBe(status);
      expect(reply.body).toHaveLength(0);
      expect(reply.headers['content-type']).toBeUndefined();
      expect((await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).status).toBe(200);
    }
    relay.injectFault({ kind: 'bodyless', status: 503, route: 'listing' });
    expect((await call(relay, 'GET', '/api/peer/towers', { key: mbp.apiKey })).status).toBe(503);
    expect((await relayCall(relay, mbp.apiKey, { to: devvm.towerId })).status).toBe(200);
    relay.clearFaults();
    expect((await call(relay, 'GET', '/api/peer/towers', { key: mbp.apiKey })).status).toBe(200);
    expect(() => relay.injectFault({ kind: 'bodyless', status: 200 })).toThrow(/never 200/);
  });

  it('a MAC made with a wrong secret, and a statement replayed', async () => {
    const fake = await connect(devvm);
    relay.injectFault({ kind: 'wrong-secret' }, 1);
    await relayCall(relay, mbp.apiKey, { to: devvm.towerId });
    const wrong = fake.received[0];
    const header = String(wrong.headers['x-codev-peer-statement']);
    expect(String(wrong.headers['x-codev-peer-mac'])).not.toBe(macUnder(secretOf(fake), header));

    const requestId = randomUUID();
    await relayCall(relay, mbp.apiKey, { to: devvm.towerId, requestId });
    relay.injectFault({ kind: 'replay-statement' }, 1);
    await relayCall(relay, mbp.apiKey, { to: devvm.towerId, requestId });
    const [, original, replayed] = fake.received;
    expect(replayed.headers['x-codev-peer-statement']).toBe(original.headers['x-codev-peer-statement']);
    expect(replayed.headers['x-codev-peer-mac']).toBe(original.headers['x-codev-peer-mac']);
    expect(String(original.headers['x-codev-peer-mac'])).toBe(macUnder(secretOf(fake), String(original.headers['x-codev-peer-statement'])));
  });

  it("replays the pair's own last statement, never another sender's to the same recipient", async () => {
    const fake = await connect(devvm);
    await relayCall(relay, spare.apiKey, { to: devvm.towerId });
    await relayCall(relay, mbp.apiKey, { to: devvm.towerId });
    relay.injectFault({ kind: 'replay-statement', to: devvm.towerId }, 1);
    await relayCall(relay, spare.apiKey, { to: devvm.towerId });
    const [fromSpare, fromMbp, replayed] = fake.received;
    expect(statementOf(fromMbp).fromTowerId).toBe(mbp.towerId);
    expect(replayed.headers['x-codev-peer-statement']).toBe(fromSpare.headers['x-codev-peer-statement']);
    expect(statementOf(replayed).fromTowerId).toBe(spare.towerId);
  });

  it('holds an answer on request, so concurrent message calls to one peer are seen in flight together', async () => {
    await connect(devvm);
    relay.injectFault({ kind: 'answer-delay', ms: 150 });
    await Promise.all([1, 2, 3].map(() => relayCall(relay, mbp.apiKey, { to: devvm.towerId })));
    expect(relay.inFlight(mbp.towerId, devvm.towerId)).toEqual({ now: 0, max: 3 });
    // Queries are not message calls; another pair is another count.
    await relayCall(relay, mbp.apiKey, { to: devvm.towerId, kind: 'query', payload: queryPayload(T0) });
    expect(relay.inFlight(devvm.towerId, mbp.towerId)).toEqual({ now: 0, max: 0 });
  });
});

// ===========================================================================
// Sections 3 and 2: the listing and the switch-state report
// ===========================================================================

describe('section 3: the listing', () => {
  it("lists every other Tower of the caller's account and only those, with self, the relay and C's limits", async () => {
    await connect(devvm);
    const listing = await call(relay, 'GET', '/api/peer/towers', { key: mbp.apiKey });
    expect(listing.status).toBe(200);
    expect(listing.headers['content-type']).toBe('application/json');
    expect(listing.json).toEqual({
      v: 1,
      relay: { protocols: [1] },
      self: { towerId: mbp.towerId, slug: 'ana-s-mbp' },
      limits: { messagesPerTowerPerMinute: 60, messagesPerPairPerMinute: 30, queriesPerPairPerMinute: 10 },
      towers: [
        { towerId: devvm.towerId, slug: 'devvm', online: true, protocols: [1], remoteMessaging: 'on' },
        { towerId: spare.towerId, slug: 'spare', online: false, protocols: [], remoteMessaging: 'unknown' },
      ],
    });
    relay.renameTower(mbp.towerId, 'ana-laptop');
    expect((await call(relay, 'GET', '/api/peer/towers', { key: mbp.apiKey })).json.self.slug).toBe('ana-laptop');
    expect(() => relay.renameTower(mbp.towerId, 'devvm')).toThrow(/already used/);
    expect(() => relay.renameTower(mbp.towerId, 'Ana_Laptop')).toThrow(/outside its rule/);
  });

  it('answers 401 without a valid key, and 429 past 30 a minute', async () => {
    expect(cloudAnswer(await call(relay, 'GET', '/api/peer/towers')).body.reason).toBe('unauthenticated');
    for (let i = 0; i < 30; i++) expect((await call(relay, 'GET', '/api/peer/towers', { key: mbp.apiKey })).status).toBe(200);
    expect(cloudAnswer(await call(relay, 'GET', '/api/peer/towers', { key: mbp.apiKey })).body).toEqual({
      v: 1,
      outcome: 'refused',
      reason: 'rate-limited',
      retryAfterSec: 60,
    });
  });
});

describe('section 2: the switch-state report', () => {
  it("answers 204 and records the switch on the Tower's row and its session, ignoring a field it does not know (section 0)", async () => {
    await connect(mbp, { protocols: [1], remoteMessaging: 'off' });
    const mbpAsListed = async () => (await call(relay, 'GET', '/api/peer/towers', { key: devvm.apiKey })).json.towers[0];
    expect((await mbpAsListed()).remoteMessaging).toBe('off');
    const on = await call(relay, 'PUT', '/api/peer/state', { key: mbp.apiKey, body: '{"remoteMessaging":"on","later":true}' });
    expect(on.status).toBe(204);
    expect(on.body).toHaveLength(0);
    expect((await mbpAsListed()).remoteMessaging).toBe('on');
    expect(relay.session(mbp.towerId)?.remoteMessaging).toBe('on');
    // The contract gives this body no size limit, so a long one is still a report.
    const long = `{"remoteMessaging":"off","later":"${'x'.repeat(20_000)}"}`;
    expect(long.length).toBeGreaterThan(4_096);
    expect((await call(relay, 'PUT', '/api/peer/state', { key: mbp.apiKey, body: long })).status).toBe(204);
    expect((await mbpAsListed()).remoteMessaging).toBe('off');
  });

  it('answers a body that is not the report 400 malformed, a caller without a key 401, and past 30 a minute 429', async () => {
    for (const body of ['not json', '[]', '{}', 'null', '"on"', '{"remoteMessaging":"maybe"}', '{"remoteMessaging":true}', '']) {
      const reply = await call(relay, 'PUT', '/api/peer/state', { key: mbp.apiKey, body });
      expect(cloudAnswer(reply), body).toEqual({ status: 400, body: { v: 1, outcome: 'refused', reason: 'malformed' } });
    }
    expect(cloudAnswer(await call(relay, 'PUT', '/api/peer/state', { body: '{"remoteMessaging":"on"}' })).status).toBe(401);
    for (let i = 0; i < 22; i++) {
      expect((await call(relay, 'PUT', '/api/peer/state', { key: mbp.apiKey, body: '{"remoteMessaging":"on"}' })).status).toBe(204);
    }
    const over = await call(relay, 'PUT', '/api/peer/state', { key: mbp.apiKey, body: '{"remoteMessaging":"off"}' });
    expect(cloudAnswer(over).body.reason).toBe('rate-limited');
    expect(relay.tower(mbp.towerId).remoteMessaging).toBe('on');
  });
});

// ===========================================================================
// Requests the stand-in originates, and the records it keeps
// ===========================================================================

describe('forwards the stand-in originates (no sending Tower)', () => {
  it("builds a statement from the stated sender's records, MACed under R's secret, and replays one byte for byte", async () => {
    const fake = await connect(devvm);
    const sent = await relay.forward(devvm.towerId, { fromTowerId: mbp.towerId });
    expect(sent.status).toBe(200);
    expect(sent.json).toEqual({ v: 1, outcome: 'delivered' });
    const [received] = fake.received;
    expect(received.path).toBe('/__tower/peer');
    const header = String(received.headers['x-codev-peer-statement']);
    expect(String(received.headers['x-codev-peer-mac'])).toBe(macUnder(secretOf(fake), header));
    expect(statementOf(received)).toMatchObject({ fromTowerId: mbp.towerId, fromTowerSlug: 'ana-s-mbp', sameOwner: true });
    expect(statementFieldProblems(statementOf(received))).toEqual([]);

    await relay.replay(sent, devvm.towerId);
    expect(fake.received[1].headers['x-codev-peer-statement']).toBe(header);
    expect(fake.received[1].headers['x-codev-peer-mac']).toBe(received.headers['x-codev-peer-mac']);
    expect(fake.received[1].body.equals(received.body)).toBe(true);

    // From an earlier session: the same bytes, which no longer verify under the new secret.
    await disconnect(fake, devvm);
    const next = await connect(devvm);
    await relay.replay(sent, devvm.towerId);
    expect(String(next.received[0].headers['x-codev-peer-mac'])).not.toBe(macUnder(secretOf(next), header));
  });

  it('crafts what C would never send: changed fields, raw bytes, another secret, missing headers, another path', async () => {
    const fake = await connect(devvm);
    await relay.forward(devvm.towerId, { statement: { v: 2, fromOwnerHandle: undefined } });
    const changed = statementOf(fake.received[0]);
    expect(changed.v).toBe(2);
    expect('fromOwnerHandle' in changed).toBe(false);

    await relay.forward(devvm.towerId, { statementBytes: '[1,2]', mac: 'not-a-mac' });
    expect(Buffer.from(String(fake.received[1].headers['x-codev-peer-statement']), 'base64url').toString()).toBe('[1,2]');
    expect(fake.received[1].headers['x-codev-peer-mac']).toBe('not-a-mac');

    await relay.forward(devvm.towerId, { headers: { 'x-codev-peer-mac': undefined }, path: '/__tower/peer?x=1', method: 'PUT' });
    expect(fake.received[2]).toMatchObject({ method: 'PUT', path: '/__tower/peer?x=1' });
    expect(fake.received[2].headers['x-codev-peer-mac']).toBeUndefined();

    // As the /t/ proxy might: any path, any headers.
    const proxied = await relay.tunnelRequest(devvm.towerId, {
      method: 'POST',
      path: '/api/send',
      headers: { 'x-codev-peer-statement': 'abc', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(proxied.status).toBe(200);
    expect(fake.received[3]).toMatchObject({ method: 'POST', path: '/api/send' });
    expect(fake.received[3].headers['x-codev-peer-statement']).toBe('abc');
  });
});

describe('records', () => {
  it('records every call: route, caller, headers, payload size and answer, and never 200 from C on the relay route', async () => {
    await connect(devvm);
    const requestId = randomUUID();
    await relayCall(relay, mbp.apiKey, { to: devvm.towerId, requestId });
    await call(relay, 'GET', '/api/peer/towers', { key: mbp.apiKey });
    await call(relay, 'POST', '/api/tower/metadata', { body: '{}' });
    expect(relay.calls.map(({ route, towerId, status, answer }) => ({ route, towerId, status, answer }))).toEqual([
      { route: 'relay', towerId: mbp.towerId, status: 200, answer: 'receiver' },
      { route: 'listing', towerId: mbp.towerId, status: 200, answer: 'cloud' },
      { route: 'other', towerId: null, status: 404, answer: 'bodyless' },
    ]);
    expect(relay.calls[0]).toMatchObject({
      version: '1',
      kind: 'message',
      to: devvm.towerId,
      requestId,
      payloadBytes: PAYLOAD.length,
      outcome: 'delivered',
    });
    expect(relay.calls[0].forward?.payload.equals(PAYLOAD)).toBe(true);
  });
});

// ===========================================================================
// Structure
// ===========================================================================

describe('structure', () => {
  it("stand-in-relay.ts does not import the Tower's contract module, or any production peer module", () => {
    const source = readFileSync(fileURLToPath(new URL('./helpers/stand-in-relay.ts', import.meta.url)), 'utf8');
    const imports = [...source.matchAll(/^import[^;]*?from\s+'([^']+)'/gms)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((path) => /contract|\/peer\//.test(path))).toEqual([]);
    // Nor at run time.
    expect(source).not.toMatch(/import\(\s*['"`][^'"`]*(contract|\/peer\/)/);
    expect(source).not.toMatch(/require\(/);
  });
});
