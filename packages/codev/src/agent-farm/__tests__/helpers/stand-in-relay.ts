/**
 * A stand-in for Codev Cloud's side of the Tower-to-Tower wire contract (Spec 1967, plan
 * phase 2): the cloud we control, against which every later phase is tested.
 *
 * It implements C's half of the contract (the Wire Contract section of the spec, revision
 * 4) exactly, and it does so on its own: it takes the shapes and the protocol constants
 * from `codev-types` and computes everything else here, with `node:crypto`. It never
 * imports the Tower's contract module (`peer/contract.ts`). If it did, a misreading of the
 * contract there would be mirrored here and every test would still pass. A structural test
 * in `stand-in-relay.test.ts` holds that line.
 *
 * What it serves, on one loopback HTTP server:
 *
 * - `/tunnel` (section 1): the WebSocket handshake, `auth` → `auth_ok` with `relay` and a
 *   fresh 32-byte session secret per connection, then HTTP/2 over the socket with the
 *   stand-in as the client, as `mock-tunnel-server.ts` does;
 * - `POST /api/peer/relay` (section 4): the ten checks in order, the statement built from
 *   its own records (section 5), one forward down the recipient's tunnel and the checks of
 *   section 6 on the recipient's answer;
 * - `GET /api/peer/towers` (section 3) and `PUT /api/peer/state` (section 2);
 * - the limits of section 7, counted as section 7 says, in fixed one-minute windows on an
 *   injected clock.
 *
 * For tests it also records every call, counts the message relay calls in flight per
 * pair, originates forwarded requests itself (so a receiving Tower can be tested without a
 * sending one), and injects the faults later phases need. None of that is the contract.
 *
 * Two parts of C are left out, on purpose. There is no `/t/` browser proxy (section 9):
 * its barriers are C's second line, and what a receiving Tower must survive when they fail
 * is any request down its tunnel with any headers, which `tunnelRequest` sends. And calls
 * with a bad key are not rate limited: that number is C's, not the contract's [r16].
 *
 * Readings this stand-in takes where the contract leaves the order open (each is noted at
 * its code): within step 2, a malformed header is answered before an unsupported version;
 * a missing `x-codev-peer-version` is an unsupported version, a missing `x-codev-peer-to`
 * is malformed; on the switch-state report a bad body (400) is answered before the limits,
 * as the relay answers its header checks before its limits.
 */

import http from 'node:http';
import http2 from 'node:http2';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, createWebSocketStream } from 'ws';
import {
  PEER_MAX_ANSWER_BYTES,
  PEER_MAX_PAYLOAD_BYTES,
  PEER_MAX_STATEMENT_HEADER_BYTES,
  PEER_PROTOCOL_VERSION,
  PEER_RELAY_TIMEOUT_MS,
  type PeerCloudLimits,
  type PeerHandshake,
  type PeerListedSwitchState,
  type PeerListing,
  type PeerReceiverOutcome,
  type PeerRequestKind,
} from '@cluesmith/codev-types';

// ===========================================================================
// What C speaks
// ===========================================================================

/** The versions this stand-in relays and states. */
const RELAYED_VERSIONS: readonly number[] = [PEER_PROTOCOL_VERSION];

/** The forwarded request's one path (section 5). */
const ENTRY_PATH = '/__tower/peer';

/** The headers of the contract, written out here rather than taken from the Tower's module. */
const H = {
  version: 'x-codev-peer-version',
  kind: 'x-codev-peer-kind',
  to: 'x-codev-peer-to',
  requestId: 'x-codev-peer-request-id',
  statement: 'x-codev-peer-statement',
  mac: 'x-codev-peer-mac',
  outcome: 'x-codev-peer-outcome',
} as const;

/** R's five outcomes (section 6): the only values C passes through in `x-codev-peer-outcome`. */
const RECEIVER_OUTCOMES: ReadonlySet<string> = new Set<PeerReceiverOutcome>([
  'delivered',
  'held',
  'refused',
  'not-verified',
  'answered',
]);

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID_RULE = /^[A-Za-z0-9_-]{1,64}$/;
const SLUG_RULE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HANDLE_RULE = /^[a-z][a-z0-9-]{0,62}$/;
const STATEMENT_ID_RULE = /^[A-Za-z0-9_-]{22}$/;
const SHA256_HEX_RULE = /^[0-9a-f]{64}$/;
const MAX_EMAIL_BYTES = 254;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * The excluded code points of `fromOwnerEmail` (section 5), one entry per line of the
 * contract's list, as inclusive ranges.
 */
export const STAND_IN_EXCLUDED_EMAIL_CODE_POINTS: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

/** C's rate limits (section 7), per minute. The first three are the listing's `limits`. */
export interface StandInLimits extends PeerCloudLimits {
  listingPerTowerPerMinute: number;
  statePerTowerPerMinute: number;
  /** Every authenticated call to an `/api/peer/…` route from one Tower [r3-1]. */
  peerRoutesPerTowerPerMinute: number;
}

export const STAND_IN_LIMITS: Readonly<StandInLimits> = {
  messagesPerTowerPerMinute: 60,
  messagesPerPairPerMinute: 30,
  queriesPerPairPerMinute: 10,
  listingPerTowerPerMinute: 30,
  statePerTowerPerMinute: 30,
  peerRoutesPerTowerPerMinute: 600,
};

const WINDOW_MS = 60_000;

// ===========================================================================
// The statement (section 5), as C issues it
// ===========================================================================

/** The thirteen fields of a version-1 statement, in the order this stand-in writes them. */
export const STATEMENT_FIELDS = [
  'v',
  'kind',
  'toTowerId',
  'fromTowerId',
  'fromTowerSlug',
  'fromOwnerId',
  'fromOwnerHandle',
  'fromOwnerEmail',
  'sameOwner',
  'requestId',
  'issuedAt',
  'statementId',
  'payloadSha256',
] as const;

function isInteger(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

function hasExcludedCodePoint(text: string): boolean {
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (STAND_IN_EXCLUDED_EMAIL_CODE_POINTS.some(([lo, hi]) => cp >= lo && cp <= hi)) return true;
  }
  return false;
}

function isEmail(value: unknown): boolean {
  if (typeof value !== 'string' || hasLoneSurrogate(value) || hasExcludedCodePoint(value)) return false;
  const bytes = Buffer.byteLength(value, 'utf8');
  return bytes >= 1 && bytes <= MAX_EMAIL_BYTES;
}

/** Each field's rule, from the table of section 5. */
const FIELD_RULES: Record<(typeof STATEMENT_FIELDS)[number], (value: unknown) => boolean> = {
  v: (value) => isInteger(value, 1, MAX_SAFE),
  kind: (value) => value === 'message' || value === 'query',
  toTowerId: (value) => typeof value === 'string' && ID_RULE.test(value),
  fromTowerId: (value) => typeof value === 'string' && ID_RULE.test(value),
  fromTowerSlug: (value) => typeof value === 'string' && SLUG_RULE.test(value),
  fromOwnerId: (value) => typeof value === 'string' && ID_RULE.test(value),
  fromOwnerHandle: (value) => value === null || (typeof value === 'string' && HANDLE_RULE.test(value)),
  fromOwnerEmail: isEmail,
  sameOwner: (value) => typeof value === 'boolean',
  requestId: (value) => typeof value === 'string' && CANONICAL_UUID.test(value),
  issuedAt: (value) => isInteger(value, 1, MAX_SAFE),
  statementId: (value) => typeof value === 'string' && STATEMENT_ID_RULE.test(value),
  payloadSha256: (value) => typeof value === 'string' && SHA256_HEX_RULE.test(value),
};

/** The fields of a statement that do not fit their rule, by name; empty when all fit. */
export function statementFieldProblems(fields: Record<string, unknown>): string[] {
  return STATEMENT_FIELDS.filter((name) => !(name in fields) || !FIELD_RULES[name](fields[name]));
}

/** What C knows when it issues a statement: its records, the validated headers and its clock. */
export interface StatementInputs {
  kind: string;
  toTowerId: string;
  fromTowerId: string;
  fromTowerSlug: string;
  fromOwnerId: string;
  fromOwnerHandle: string | null;
  fromOwnerEmail: string;
  sameOwner: boolean;
  requestId: string;
  issuedAt: number;
  statementId: string;
}

export interface IssuedStatement {
  /** The statement bytes, exactly as the MAC covers them. */
  bytes: Buffer;
  /** `x-codev-peer-statement`: base64url of the bytes. */
  header: string;
  /** `x-codev-peer-mac`: base64url of HMAC-SHA-256 over the bytes under the session secret. */
  mac: string;
  fields: Record<(typeof STATEMENT_FIELDS)[number], unknown>;
}

export type IssueResult = ({ ok: true } & IssuedStatement) | { ok: false; problems: string[] };

/**
 * Issue a statement as C does at step 9 of section 4: every field from C's records or from
 * C itself, `payloadSha256` computed over exactly the bytes forwarded, serialised with
 * `JSON.stringify` (literal UTF-8, no duplicate keys) in the order of `STATEMENT_FIELDS`.
 * C never issues a statement with a field outside its rule, nor one whose encoded header
 * is over 4 096 bytes: either is `ok: false`, which the relay answers `500 cloud-error`.
 */
export function issueStatement(inputs: StatementInputs, payload: Uint8Array, secret: Uint8Array): IssueResult {
  const fields = {
    v: PEER_PROTOCOL_VERSION,
    kind: inputs.kind,
    toTowerId: inputs.toTowerId,
    fromTowerId: inputs.fromTowerId,
    fromTowerSlug: inputs.fromTowerSlug,
    fromOwnerId: inputs.fromOwnerId,
    fromOwnerHandle: inputs.fromOwnerHandle,
    fromOwnerEmail: inputs.fromOwnerEmail,
    sameOwner: inputs.sameOwner,
    requestId: inputs.requestId,
    issuedAt: inputs.issuedAt,
    statementId: inputs.statementId,
    payloadSha256: createHash('sha256').update(payload).digest('hex'),
  };
  const problems = statementFieldProblems(fields);
  if (problems.length > 0) return { ok: false, problems };
  const bytes = Buffer.from(JSON.stringify(fields), 'utf8');
  const header = bytes.toString('base64url');
  if (Buffer.byteLength(header, 'utf8') > PEER_MAX_STATEMENT_HEADER_BYTES) {
    return { ok: false, problems: ['statement header over 4 096 bytes'] };
  }
  const mac = createHmac('sha256', secret).update(bytes).digest('base64url');
  return { ok: true, bytes, header, mac, fields };
}

/** A fresh statement id: base64url of 16 CSPRNG bytes, canonical by construction. */
export function newStatementId(): string {
  return randomBytes(16).toString('base64url');
}

// ===========================================================================
// Records
// ===========================================================================

/** An account: the owner fields a statement states. */
export interface StandInAccount {
  ownerId: string;
  ownerHandle: string | null;
  ownerEmail: string;
}

/** A Tower's row. `protocols` and `remoteMessaging` are what its last session stated [r17]. */
export interface StandInTower {
  towerId: string;
  slug: string;
  /** The display name, as the owner typed it; `auth_ok.name`, used nowhere in the protocol. */
  name: string;
  apiKey: string;
  account: StandInAccount;
  protocols: number[];
  remoteMessaging: PeerListedSwitchState;
  /**
   * Owner fields written by `writeRecordUnchecked`, stated in place of the account's in the
   * statements this Tower sends only, so one direction of a pair can break while the other
   * stays healthy. Empty for a record C wrote by its rules.
   */
  ownerOverride: Partial<StandInAccount>;
}

/** A live tunnel session (section 1): one per Tower, replaced by a newer connection. */
export interface StandInSession {
  towerId: string;
  /** Counts sessions across the stand-in's life, so a reconnect is visible to a test. */
  seq: number;
  /** `null` when the `auth_ok` that opened it carried no relay. */
  secret: Buffer | null;
  /** What its `auth` stated; `[]` when it carried no (or a malformed) `peer`. */
  protocols: number[];
  remoteMessaging: PeerListedSwitchState;
  ws: WebSocket;
  h2: http2.ClientHttp2Session;
}

/** What a Tower's `auth` said of the protocol, as the stand-in read it. */
export interface StandInHandshake {
  towerId: string | null;
  at: number;
  /** `absent` for today's handshake; `malformed` for a `peer` treated as absent [r6]. */
  peer: 'absent' | 'malformed' | PeerHandshake;
}

export type StandInRoute = 'relay' | 'listing' | 'state';

/** Who produced an answer: C in its answer shape, R (a 200 passed through), or nobody's body. */
export type StandInAnswerSource = 'cloud' | 'receiver' | 'bodyless';

/** One forward down a recipient's tunnel. */
export interface StandInForward {
  toTowerId: string;
  /** The session the forward used. */
  sessionSeq: number;
  statementHeader: string;
  mac: string;
  /** The statement as issued: `null` for a raw request whose header was not a statement. */
  statement: Record<string, unknown> | null;
  payload: Buffer;
  /**
   * R's answer; `null` when none came (timeout or a dead stream). For an answer C refused
   * (`502 tower-error`), what had arrived when C stopped reading: the status and headers,
   * and the body read before its size went over the cap (empty when the headers failed).
   */
  answer: { status: number; headers: Record<string, string | string[]>; body: Buffer } | null;
}

/** One HTTP call to the stand-in, as it saw it. */
export interface StandInCall {
  seq: number;
  at: number;
  method: string;
  path: string;
  route: StandInRoute | 'other';
  /** The caller's Tower, once its key authenticated. */
  towerId: string | null;
  /** The relay call's four headers, as sent. */
  version?: string;
  kind?: string;
  to?: string;
  requestId?: string;
  payloadBytes: number | null;
  status: number;
  outcome: string | null;
  reason: string | null;
  answer: StandInAnswerSource;
  forward: StandInForward | null;
}

// ===========================================================================
// Faults
// ===========================================================================

/**
 * A fault the stand-in injects. Each is consumed by the calls it applies to, `times` of
 * them (by default every one until `clearFaults`).
 *
 * - `bodyless`: something in front of C answers an `/api/peer/…` call with this status and
 *   no body, before C sees it (section 6, "Answers without this body").
 * - `answer-late`: C forwards, R answers, and C answers `504 no-answer` as if R's answer
 *   had come after the relay timeout. R has acted; S never learns it.
 * - `reset-stream`: C forwards and resets the stream as soon as R starts answering, so
 *   no complete answer arrives (`504 no-answer`).
 * - `wrong-secret`: C MACs the statement with a secret that is not the session's.
 * - `replay-statement`: C forwards the last statement and MAC it issued to that Tower
 *   again, unchanged, instead of a new one.
 * - `answer-delay`: C holds R's answer this long before passing it on, so concurrent
 *   calls are seen in flight together.
 *
 * The forward faults take an optional recipient (`to`), and apply only at step 10.
 */
export type StandInFault =
  | { kind: 'bodyless'; status: number; route?: StandInRoute }
  | { kind: 'answer-late'; to?: string }
  | { kind: 'reset-stream'; to?: string }
  | { kind: 'wrong-secret'; to?: string }
  | { kind: 'replay-statement'; to?: string }
  | { kind: 'answer-delay'; ms: number; to?: string };

/**
 * The cloud's relay, as a mode: `relay` states one; `null` states `relay: null` (an
 * explicit "no relay"); `absent` is a cloud that predates the contract, with no `relay`
 * field and no `/api/peer/…` routes.
 */
export type StandInRelayMode = 'relay' | 'null' | 'absent';

export interface StandInRelayOptions {
  /** C's clock, epoch ms: the limits' windows and `issuedAt`. Default `Date.now`. */
  now?: () => number;
  /** How long C waits for R's complete answer. Default the contract's 15 000 ms. */
  relayTimeoutMs?: number;
  mode?: StandInRelayMode;
  limits?: Partial<StandInLimits>;
}

/** A request sent down a Tower's tunnel by the test, as anything in the cloud might. */
export interface TunnelRequest {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
}

export interface TunnelResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
}

/** A forwarded request the stand-in originates (no sending Tower involved). */
export interface ForwardOptions {
  /** The payload bytes. Default: a valid message from the stated sender's `codev` architect. */
  payload?: Uint8Array | string;
  kind?: PeerRequestKind;
  /** Default a fresh UUID. */
  requestId?: string;
  /** The sending Tower whose records the statement states. Default: another Tower on R's account. */
  fromTowerId?: string;
  /** Default C's clock. */
  issuedAt?: number;
  /**
   * Fields to change after the statement is built, without C's rules (a field set to
   * `undefined` is left out). For crafting statements C would never issue.
   */
  statement?: Record<string, unknown>;
  /** Statement bytes to send instead of the built ones. */
  statementBytes?: Uint8Array | string;
  /** MAC under this secret instead of the session's. */
  secret?: Uint8Array;
  /** An `x-codev-peer-mac` value to send as it is. */
  mac?: string;
  /** Headers to add, or with `undefined` to remove (e.g. the statement header). */
  headers?: Record<string, string | undefined>;
  path?: string;
  method?: string;
}

export interface ForwardResult extends TunnelResponse {
  method: string;
  path: string;
  /** Exactly the headers sent besides `:method` and `:path`. */
  sentHeaders: Record<string, string>;
  statementBytes: Buffer;
  payload: Buffer;
  /** R's answer body parsed as JSON; `undefined` when it is not JSON. */
  json: unknown;
}

/** A message payload as S writes one: `JSON.stringify`, so non-ASCII stays literal UTF-8. */
export function messagePayload(message: {
  sentAt: number;
  to: Record<string, string>;
  from?: Record<string, string> | null;
  body: string;
}): Buffer {
  return Buffer.from(
    JSON.stringify({ sentAt: message.sentAt, to: message.to, from: message.from ?? null, body: message.body }),
    'utf8',
  );
}

/** A discovery payload (kind `query`). */
export function queryPayload(sentAt: number): Buffer {
  return Buffer.from(JSON.stringify({ sentAt, what: 'addresses' }), 'utf8');
}

// ===========================================================================
// The stand-in
// ===========================================================================

interface Counter {
  window: number;
  count: number;
}

interface FaultEntry {
  fault: StandInFault;
  remaining: number;
}

type CloudBody = { outcome: 'refused' | 'unavailable'; reason: string; retryAfterSec?: number; supported?: number[] };

/** How one request down a tunnel ended. */
type TunnelResult =
  | { kind: 'answer'; response: TunnelResponse }
  /** An answer C refused; `response` is what had arrived when C stopped reading. */
  | { kind: 'unchecked'; response: TunnelResponse }
  | { kind: 'no-answer' };

class AnswerSent {
  constructor(readonly call: StandInCall) {}
}

export class StandInRelay {
  private readonly httpServer: http.Server;
  private readonly wss: WebSocketServer;
  private readonly now: () => number;
  private readonly relayTimeoutMs: number;
  private readonly limits: StandInLimits;
  private mode: StandInRelayMode;
  private readonly towers = new Map<string, StandInTower>();
  private readonly sessions = new Map<string, StandInSession>();
  private readonly sockets = new Set<WebSocket>();
  private counters = new Map<string, Counter>();
  private readonly inFlightNow = new Map<string, number>();
  private readonly inFlightMax = new Map<string, number>();
  /** The last statement forwarded per pair, keyed `<from>><to>`, for the `replay-statement` fault. */
  private readonly lastIssued = new Map<string, { header: string; mac: string; statement: Record<string, unknown> }>();
  /** Each Tower's slug as C last wrote it by its rules, for `restoreRecord`. */
  private readonly checkedSlugs = new Map<string, string>();
  private readonly offline = new Set<string>();
  private readonly noVersion = new Set<string>();
  private faults: FaultEntry[] = [];
  private sessionSeq = 0;
  private callSeq = 0;
  private nextTowerNumber = 1;

  /** Every HTTP call, oldest first. */
  readonly calls: StandInCall[] = [];
  /** Every forward down a tunnel, relayed or originated, oldest first. */
  readonly forwards: StandInForward[] = [];
  /** Every `auth` that named a key, oldest first. */
  readonly handshakes: StandInHandshake[] = [];
  port = 0;

  constructor(options: StandInRelayOptions = {}) {
    this.now = options.now ?? Date.now;
    this.relayTimeoutMs = options.relayTimeoutMs ?? PEER_RELAY_TIMEOUT_MS;
    this.limits = { ...STAND_IN_LIMITS, ...options.limits };
    this.mode = options.mode ?? 'relay';
    this.httpServer = http.createServer((req, res) => {
      this.handleHttp(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    this.httpServer.on('upgrade', (req, socket, head) => {
      if (req.url === '/tunnel') {
        this.wss.handleUpgrade(req, socket, head, (ws) => this.handleTunnel(ws));
      } else {
        socket.destroy();
      }
    });
  }

  /** The loopback URL a Tower's `cloud-config.json` names as `server_url`. */
  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.httpServer.address();
    if (!address || typeof address === 'string') throw new Error('stand-in relay: no address');
    this.port = address.port;
    return this.port;
  }

  async stop(): Promise<void> {
    this.dropTunnels();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    this.httpServer.closeAllConnections();
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
  }

  // -------------------------------------------------------------------------
  // Records
  // -------------------------------------------------------------------------

  addAccount(account: Partial<StandInAccount> = {}): StandInAccount {
    const ownerId = account.ownerId ?? `usr_${randomBytes(6).toString('hex')}`;
    const created: StandInAccount = {
      ownerId,
      ownerHandle: account.ownerHandle ?? null,
      ownerEmail: account.ownerEmail ?? `${ownerId}@example.com`,
    };
    if (!FIELD_RULES.fromOwnerId(created.ownerId)) throw new Error(`stand-in: owner id outside its rule: ${created.ownerId}`);
    if (!FIELD_RULES.fromOwnerHandle(created.ownerHandle)) throw new Error('stand-in: owner handle outside its rule');
    if (!FIELD_RULES.fromOwnerEmail(created.ownerEmail)) throw new Error('stand-in: owner email outside its rule');
    return created;
  }

  /** Register a Tower on an account. C enforces the slug rule on every write of a slug [r13]. */
  addTower(tower: { account: StandInAccount; slug: string; name?: string; towerId?: string; apiKey?: string }): StandInTower {
    const towerId = tower.towerId ?? `01JSTANDIN${String(this.nextTowerNumber++).padStart(16, '0')}`;
    if (!ID_RULE.test(towerId)) throw new Error(`stand-in: Tower id outside its rule: ${towerId}`);
    if (this.towers.has(towerId)) throw new Error(`stand-in: Tower id already registered: ${towerId}`);
    this.assertSlugFree(tower.account, tower.slug);
    const created: StandInTower = {
      towerId,
      slug: tower.slug,
      name: tower.name ?? tower.slug,
      apiKey: tower.apiKey ?? `ctk_${randomBytes(18).toString('base64url')}`,
      account: tower.account,
      protocols: [],
      remoteMessaging: 'unknown',
      ownerOverride: {},
    };
    this.towers.set(towerId, created);
    this.checkedSlugs.set(towerId, created.slug);
    return created;
  }

  tower(towerId: string): StandInTower {
    const tower = this.towers.get(towerId);
    if (!tower) throw new Error(`stand-in: no Tower ${towerId}`);
    return tower;
  }

  renameTower(towerId: string, slug: string): void {
    const tower = this.tower(towerId);
    this.assertSlugFree(tower.account, slug, towerId);
    tower.slug = slug;
    this.checkedSlugs.set(towerId, slug);
  }

  /** Move a Tower to another account; its per-pair counters stay as they were. */
  moveTower(towerId: string, account: StandInAccount): void {
    this.tower(towerId).account = account;
  }

  /** Replace a Tower's key. C closes its session, and with it the secret [r5]. */
  rotateKey(towerId: string): string {
    const tower = this.tower(towerId);
    tower.apiKey = `ctk_${randomBytes(18).toString('base64url')}`;
    this.dropTunnels(towerId);
    return tower.apiKey;
  }

  /**
   * Write a record without C's rules, so a statement built from it does not fit them: the
   * way to make step 9 answer `500 cloud-error`. The real cloud never holds such a record.
   * Only the statements this Tower sends change: owner fields go to its `ownerOverride`, not
   * to the account other Towers share, so its peers' statements to it stay as they were.
   */
  writeRecordUnchecked(towerId: string, patch: { slug?: string } & Partial<StandInAccount>): void {
    const tower = this.tower(towerId);
    if (patch.slug !== undefined) tower.slug = patch.slug;
    if (patch.ownerId !== undefined) tower.ownerOverride.ownerId = patch.ownerId;
    if (patch.ownerHandle !== undefined) tower.ownerOverride.ownerHandle = patch.ownerHandle;
    if (patch.ownerEmail !== undefined) tower.ownerOverride.ownerEmail = patch.ownerEmail;
  }

  /** Undo `writeRecordUnchecked`: the slug last written by C's rules, the account's owner fields. */
  restoreRecord(towerId: string): void {
    const tower = this.tower(towerId);
    tower.slug = this.checkedSlugs.get(towerId)!;
    tower.ownerOverride = {};
  }

  /** The owner fields a statement from this Tower states. */
  private ownerOf(tower: StandInTower): StandInAccount {
    return { ...tower.account, ...tower.ownerOverride };
  }

  private assertSlugFree(account: StandInAccount, slug: string, except?: string): void {
    if (!SLUG_RULE.test(slug)) throw new Error(`stand-in: slug outside its rule: ${slug}`);
    for (const other of this.towers.values()) {
      if (other.account === account && other.slug === slug && other.towerId !== except) {
        throw new Error(`stand-in: slug ${slug} already used on this account`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Sessions, modes and faults
  // -------------------------------------------------------------------------

  /** The Tower's live session, if it has one (whatever `setOffline` says). */
  session(towerId: string): StandInSession | null {
    return this.sessions.get(towerId) ?? null;
  }

  /** Sessions opened for this Tower over the stand-in's life. */
  sessionsOpened(towerId: string): number {
    return this.handshakes.filter((h) => h.towerId === towerId).length;
  }

  /** Treat a Tower as having no live session (step 7, and `online` in the listing). */
  setOffline(towerId: string, offline: boolean): void {
    if (offline) this.offline.add(towerId);
    else this.offline.delete(towerId);
  }

  /** Treat a Tower's sessions as stating no version (step 8, and `protocols` in the listing). */
  setStatesNoVersion(towerId: string, on: boolean): void {
    if (on) this.noVersion.add(towerId);
    else this.noVersion.delete(towerId);
  }

  /** Change the relay mode for later handshakes and calls. */
  setMode(mode: StandInRelayMode): void {
    this.mode = mode;
  }

  injectFault(fault: StandInFault, times = Number.POSITIVE_INFINITY): void {
    if (fault.kind === 'bodyless' && fault.status === 200) {
      throw new Error('stand-in: a bodyless answer is never 200; 200 means the recipient decided');
    }
    this.faults.push({ fault, remaining: times });
  }

  clearFaults(): void {
    this.faults = [];
  }

  /**
   * A deploy (f): every tunnel is dropped, and the in-memory limits are reset. Each Tower
   * reconnects on its own and gets a new secret.
   */
  deploy(): void {
    this.dropTunnels();
    this.counters = new Map();
  }

  /** Drop one Tower's tunnel, or every tunnel. The Tower reconnects on its own. */
  dropTunnels(towerId?: string): void {
    for (const session of [...this.sessions.values()]) {
      if (towerId !== undefined && session.towerId !== towerId) continue;
      this.sessions.delete(session.towerId);
      if (!session.h2.destroyed) session.h2.destroy();
      session.ws.terminate();
    }
    if (towerId === undefined) {
      for (const ws of this.sockets) ws.terminate();
      this.sockets.clear();
    }
  }

  private takeFault<K extends StandInFault['kind']>(
    kind: K,
    applies: (fault: Extract<StandInFault, { kind: K }>) => boolean,
  ): Extract<StandInFault, { kind: K }> | null {
    for (const entry of this.faults) {
      if (entry.remaining <= 0 || entry.fault.kind !== kind) continue;
      const fault = entry.fault as Extract<StandInFault, { kind: K }>;
      if (!applies(fault)) continue;
      entry.remaining--;
      return fault;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Counters (section 7): fixed one-minute windows on C's clock
  // -------------------------------------------------------------------------

  private count(key: string): number {
    const window = Math.floor(this.now() / WINDOW_MS);
    const counter = this.counters.get(key);
    if (!counter || counter.window !== window) {
      this.counters.set(key, { window, count: 1 });
      return 1;
    }
    counter.count++;
    return counter.count;
  }

  /** Seconds to the end of the current window [r18]. */
  private retryAfterSec(): number {
    const now = this.now();
    const end = (Math.floor(now / WINDOW_MS) + 1) * WINDOW_MS;
    return Math.max(1, Math.ceil((end - now) / 1000));
  }

  /** The per-pair counters C keeps now, by key (`message:<S>><R>`, `query:<S>><R>`). */
  pairCounters(): Map<string, number> {
    const pairs = new Map<string, number>();
    for (const [key, counter] of this.counters) {
      if (key.startsWith('pair:')) pairs.set(key.slice('pair:'.length), counter.count);
    }
    return pairs;
  }

  /** Message relay calls from S to R in flight now, and at most so far. */
  inFlight(fromTowerId: string, toTowerId: string): { now: number; max: number } {
    const key = `${fromTowerId}>${toTowerId}`;
    return { now: this.inFlightNow.get(key) ?? 0, max: this.inFlightMax.get(key) ?? 0 };
  }

  // -------------------------------------------------------------------------
  // Section 1: the tunnel handshake
  // -------------------------------------------------------------------------

  private handleTunnel(ws: WebSocket): void {
    this.sockets.add(ws);
    ws.on('error', () => {
      // A dropped tunnel is a test's business, not an error here.
    });
    ws.on('close', () => this.sockets.delete(ws));
    ws.once('message', (data: WebSocket.RawData) => {
      let message: { type?: unknown; apiKey?: unknown; peer?: unknown };
      try {
        message = JSON.parse(data.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'auth_error', reason: 'invalid_json' }));
        ws.close();
        return;
      }
      if (message === null || typeof message !== 'object' || message.type !== 'auth' || typeof message.apiKey !== 'string') {
        ws.send(JSON.stringify({ type: 'auth_error', reason: 'invalid_auth_message' }));
        ws.close();
        return;
      }
      const tower = this.towerByKey(message.apiKey);
      const peer = readPeerField(message);
      this.handshakes.push({ towerId: tower?.towerId ?? null, at: this.now(), peer });
      if (!tower) {
        ws.send(JSON.stringify({ type: 'auth_error', reason: 'invalid_api_key' }));
        ws.close();
        return;
      }
      this.openSession(ws, tower, peer);
    });
  }

  private openSession(ws: WebSocket, tower: StandInTower, peer: StandInHandshake['peer']): void {
    const previous = this.sessions.get(tower.towerId);
    if (previous) {
      this.sessions.delete(tower.towerId);
      if (!previous.h2.destroyed) previous.h2.destroy();
      previous.ws.terminate();
    }

    const stated = typeof peer === 'object' ? peer : null;
    // C records what the session stated, on the session and on the Tower's row [r17].
    tower.protocols = stated ? [...stated.protocols] : [];
    tower.remoteMessaging = stated ? stated.remoteMessaging : 'unknown';

    const secret = this.mode === 'relay' ? randomBytes(32) : null;
    ws.send(
      JSON.stringify({
        type: 'auth_ok',
        towerId: tower.towerId,
        slug: tower.slug,
        name: tower.name,
        ...(this.mode === 'relay' ? { relay: { protocols: [...RELAYED_VERSIONS], sessionSecret: secret!.toString('base64url') } } : {}),
        ...(this.mode === 'null' ? { relay: null } : {}),
      }),
    );

    // HTTP/2 over the socket, with C as the client (the tunnel's role reversal).
    const wsStream = createWebSocketStream(ws);
    wsStream.on('error', () => {
      // Torn down with the socket.
    });
    const h2 = http2.connect('http://localhost', { createConnection: () => wsStream as unknown as Duplex });
    h2.on('error', () => {
      // Torn down with the socket.
    });
    const session: StandInSession = {
      towerId: tower.towerId,
      seq: ++this.sessionSeq,
      secret,
      protocols: [...tower.protocols],
      remoteMessaging: tower.remoteMessaging,
      ws,
      h2,
    };
    this.sessions.set(tower.towerId, session);
    ws.on('close', () => {
      if (this.sessions.get(tower.towerId) === session) this.sessions.delete(tower.towerId);
      if (!h2.destroyed) h2.destroy();
    });
  }

  private towerByKey(apiKey: string): StandInTower | null {
    for (const tower of this.towers.values()) if (tower.apiKey === apiKey) return tower;
    return null;
  }

  private isOnline(towerId: string): StandInSession | null {
    const session = this.sessions.get(towerId);
    if (!session || this.offline.has(towerId) || session.h2.destroyed || session.h2.closed) return null;
    return session;
  }

  private statedProtocols(tower: StandInTower): number[] {
    if (this.noVersion.has(tower.towerId)) return [];
    return this.sessions.get(tower.towerId)?.protocols ?? tower.protocols;
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const path = new URL(req.url ?? '/', 'http://stand-in').pathname;
    const route: StandInRoute | 'other' =
      method === 'POST' && path === '/api/peer/relay'
        ? 'relay'
        : method === 'GET' && path === '/api/peer/towers'
          ? 'listing'
          : method === 'PUT' && path === '/api/peer/state'
            ? 'state'
            : 'other';
    const call: StandInCall = {
      seq: ++this.callSeq,
      at: this.now(),
      method,
      path,
      route,
      towerId: null,
      payloadBytes: null,
      status: 0,
      outcome: null,
      reason: null,
      answer: 'bodyless',
      forward: null,
    };
    this.calls.push(call);

    try {
      // An old cloud has no peer routes; a cloud with `relay: null` answers its listing only.
      if (route === 'other' || this.mode === 'absent' || (this.mode === 'null' && route !== 'listing')) {
        req.resume();
        this.bodyless(res, call, 404);
        return;
      }
      // Something in front of C (section 6): no body, whatever the call.
      const front = this.takeFault('bodyless', (fault) => fault.route === undefined || fault.route === route);
      if (front) {
        req.resume();
        this.bodyless(res, call, front.status);
        return;
      }
      if (route === 'relay') await this.handleRelay(req, res, call);
      else if (route === 'listing') this.handleListing(req, res, call);
      else await this.handleState(req, res, call);
    } catch (err) {
      if (!(err instanceof AnswerSent)) throw err;
    }
  }

  private bodyless(res: http.ServerResponse, call: StandInCall, status: number): void {
    call.status = status;
    call.answer = 'bodyless';
    res.writeHead(status, { 'content-length': '0' });
    res.end();
  }

  /** C's answer shape (section 6). C never answers 200 [r3]. */
  private cloudAnswer(res: http.ServerResponse, call: StandInCall, status: number, body: CloudBody): never {
    if (status === 200) throw new Error('stand-in: C never answers 200 itself');
    const json = JSON.stringify({ v: PEER_PROTOCOL_VERSION, ...body });
    call.status = status;
    call.outcome = body.outcome;
    call.reason = body.reason;
    call.answer = 'cloud';
    res.writeHead(status, {
      'content-type': 'application/json',
      [H.outcome]: body.outcome,
      'content-length': String(Buffer.byteLength(json)),
    });
    res.end(json);
    throw new AnswerSent(call);
  }

  /** Step 1, on every route: the key authenticates. C tells a keyless caller nothing more. */
  private authenticate(req: http.IncomingMessage, res: http.ServerResponse, call: StandInCall): StandInTower {
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    const tower = match ? this.towerByKey(match[1]) : null;
    if (!tower) {
      req.resume();
      this.cloudAnswer(res, call, 401, { outcome: 'refused', reason: 'unauthenticated' });
    }
    call.towerId = tower.towerId;
    return tower;
  }

  private rateLimited(req: http.IncomingMessage, res: http.ServerResponse, call: StandInCall): never {
    req.resume();
    return this.cloudAnswer(res, call, 429, { outcome: 'refused', reason: 'rate-limited', retryAfterSec: this.retryAfterSec() });
  }

  /** Read a body up to `cap` bytes; `null` when it is longer (the rest is drained, not kept). */
  private readBody(req: http.IncomingMessage, cap: number): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let length = 0;
      let over = false;
      req.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > cap) over = true;
        if (!over) chunks.push(chunk);
      });
      req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  // -------------------------------------------------------------------------
  // Section 4: the relay call
  // -------------------------------------------------------------------------

  private async handleRelay(req: http.IncomingMessage, res: http.ServerResponse, call: StandInCall): Promise<void> {
    const header = (name: string): string | undefined => {
      const value = req.headers[name];
      return typeof value === 'string' ? value : undefined;
    };
    call.version = header(H.version);
    call.kind = header(H.kind);
    call.to = header(H.to);
    call.requestId = header(H.requestId);

    // Step 1.
    const sender = this.authenticate(req, res, call);

    // Counted once it authenticates [r11]: the ceiling for every call, the per-Tower
    // message limit for a message and for a call whose kind is not valid [r2-B].
    const peerRoutes = this.count(`peer-routes:${sender.towerId}`);
    const countsAsMessage = call.kind !== 'query';
    const messages = countsAsMessage ? this.count(`messages:${sender.towerId}`) : 0;

    const flightKey = call.kind === 'message' && call.to !== undefined ? `${sender.towerId}>${call.to}` : null;
    if (flightKey) {
      const now = (this.inFlightNow.get(flightKey) ?? 0) + 1;
      this.inFlightNow.set(flightKey, now);
      this.inFlightMax.set(flightKey, Math.max(now, this.inFlightMax.get(flightKey) ?? 0));
      res.on('close', () => this.inFlightNow.set(flightKey, (this.inFlightNow.get(flightKey) ?? 1) - 1));
    }

    // Step 2. Malformed before an unsupported version: the stand-in's reading of the order.
    const kind = call.kind;
    if (
      call.requestId === undefined ||
      !CANONICAL_UUID.test(call.requestId) ||
      (kind !== 'message' && kind !== 'query') ||
      call.to === undefined ||
      call.to === '' ||
      call.to === sender.towerId ||
      req.headers['content-encoding'] !== undefined
    ) {
      req.resume();
      this.cloudAnswer(res, call, 400, { outcome: 'refused', reason: 'malformed' });
    }
    const version = call.version !== undefined && /^[1-9][0-9]*$/.test(call.version) ? Number(call.version) : null;
    if (version === null || !RELAYED_VERSIONS.includes(version)) {
      req.resume();
      this.cloudAnswer(res, call, 400, { outcome: 'refused', reason: 'unsupported-version', supported: [...RELAYED_VERSIONS] });
    }

    // Step 3: from Content-Length, and again while reading.
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) > PEER_MAX_PAYLOAD_BYTES) {
      req.resume();
      this.cloudAnswer(res, call, 413, { outcome: 'refused', reason: 'too-large' });
    }
    const payload = await this.readBody(req, PEER_MAX_PAYLOAD_BYTES);
    if (payload === null) this.cloudAnswer(res, call, 413, { outcome: 'refused', reason: 'too-large' });
    call.payloadBytes = payload.length;

    // Step 4: the per-Tower limits. Queries are limited per pair only [r11].
    if (peerRoutes > this.limits.peerRoutesPerTowerPerMinute) this.rateLimited(req, res, call);
    if (countsAsMessage && messages > this.limits.messagesPerTowerPerMinute) this.rateLimited(req, res, call);

    // Step 5: another Tower of S's account. No per-pair counter exists before this passes.
    const recipient = this.towers.get(call.to);
    if (!recipient || recipient.account !== sender.account) {
      this.cloudAnswer(res, call, 404, { outcome: 'refused', reason: 'unknown-tower' });
    }

    // Step 6: the per-pair limit for the kind, counted whatever the outcome after it.
    const pairCount = this.count(`pair:${kind}:${sender.towerId}>${recipient.towerId}`);
    const pairLimit = kind === 'message' ? this.limits.messagesPerPairPerMinute : this.limits.queriesPerPairPerMinute;
    if (pairCount > pairLimit) this.rateLimited(req, res, call);

    // Step 7: a live session. C reads the session entry once and uses it for the forward.
    const session = this.isOnline(recipient.towerId);
    if (!session) this.cloudAnswer(res, call, 503, { outcome: 'unavailable', reason: 'tower-offline' });

    // Step 8: that session stated this version.
    if (this.noVersion.has(recipient.towerId) || !session.protocols.includes(version)) {
      this.cloudAnswer(res, call, 409, { outcome: 'refused', reason: 'peer-unsupported' });
    }

    // Step 9: a statement whose every field fits its rule. A session opened without a relay
    // has no secret to MAC with, which is C unable to build a statement too.
    const issued =
      session.secret === null
        ? null
        : issueStatement(
            {
              kind,
              toTowerId: recipient.towerId,
              fromTowerId: sender.towerId,
              fromTowerSlug: sender.slug,
              fromOwnerId: this.ownerOf(sender).ownerId,
              fromOwnerHandle: this.ownerOf(sender).ownerHandle,
              fromOwnerEmail: this.ownerOf(sender).ownerEmail,
              sameOwner: true,
              requestId: call.requestId,
              issuedAt: this.now(),
              statementId: newStatementId(),
            },
            payload,
            session.secret,
          );
    if (!issued || !issued.ok) this.cloudAnswer(res, call, 500, { outcome: 'unavailable', reason: 'cloud-error' });

    // Step 10: forward once, and return R's answer.
    await this.relayForward(res, call, session, issued, payload);
  }

  private async relayForward(
    res: http.ServerResponse,
    call: StandInCall,
    session: StandInSession,
    issued: IssuedStatement,
    payload: Buffer,
  ): Promise<void> {
    const to = session.towerId;
    const forTo = (fault: { to?: string }) => fault.to === undefined || fault.to === to;
    let statementHeader = issued.header;
    let mac = issued.mac;
    let statement: Record<string, unknown> = issued.fields;
    const pair = `${String(issued.fields.fromTowerId)}>${to}`;
    const replay = this.takeFault('replay-statement', forTo);
    const previous = this.lastIssued.get(pair);
    if (replay && previous) {
      ({ header: statementHeader, mac, statement } = previous);
    } else if (this.takeFault('wrong-secret', forTo)) {
      mac = createHmac('sha256', randomBytes(32)).update(issued.bytes).digest('base64url');
    }
    this.lastIssued.set(pair, { header: statementHeader, mac, statement });

    // A session gone before anything is sent is `tower-offline` [r8].
    if (session.h2.destroyed || session.h2.closed || this.sessions.get(to) !== session) {
      this.cloudAnswer(res, call, 503, { outcome: 'unavailable', reason: 'tower-offline' });
    }

    const forward: StandInForward = {
      toTowerId: to,
      sessionSeq: session.seq,
      statementHeader,
      mac,
      statement,
      payload,
      answer: null,
    };
    this.forwards.push(forward);
    call.forward = forward;

    const late = this.takeFault('answer-late', forTo);
    const reset = this.takeFault('reset-stream', forTo);
    const delay = this.takeFault('answer-delay', forTo);
    const result = await this.sendDownTunnel(session, {
      method: 'POST',
      path: ENTRY_PATH,
      headers: { 'content-type': 'application/json', [H.statement]: statementHeader, [H.mac]: mac },
      body: payload,
      resetOnResponse: reset !== null,
      answerCap: PEER_MAX_ANSWER_BYTES,
    });

    if (result.kind !== 'no-answer') forward.answer = result.response;
    if (late || result.kind === 'no-answer') {
      this.cloudAnswer(res, call, 504, { outcome: 'unavailable', reason: 'no-answer' });
    }
    if (result.kind === 'unchecked') {
      this.cloudAnswer(res, call, 502, { outcome: 'unavailable', reason: 'tower-error' });
    }

    // What C checks of R's answer [r4]: done in `sendDownTunnel` as it read it.
    const answer = result.response;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay.ms));
    const outcome = answer.headers[H.outcome] as string;
    call.status = 200;
    call.outcome = outcome;
    call.reason = null;
    call.answer = 'receiver';
    res.writeHead(200, {
      'content-type': answer.headers['content-type'] as string,
      [H.outcome]: outcome,
      'content-length': String(answer.body.length),
    });
    res.end(answer.body);
  }

  /**
   * One request down a session's tunnel. With `answerCap`, R's answer is checked as C checks
   * it (section 6): status 200, media type `application/json` without parameters, a body of
   * at most the cap, and one of R's five outcomes; anything else is `unchecked`. No complete
   * answer within the relay timeout, or a stream that dies first, is `no-answer`.
   */
  private sendDownTunnel(
    session: StandInSession,
    request: {
      method: string;
      path: string;
      headers: Record<string, string>;
      body?: Uint8Array;
      resetOnResponse?: boolean;
      answerCap?: number;
    },
  ): Promise<TunnelResult> {
    return new Promise((resolve) => {
      let settled = false;
      const chunks: Buffer[] = [];
      let length = 0;
      let status = 0;
      const headers: Record<string, string | string[]> = {};
      let stream: http2.ClientHttp2Stream;
      const finish = (outcome: TunnelResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // A complete answer leaves the stream to close on its own; anything else is C
        // walking away from it, and R sees the stream reset.
        if (outcome.kind !== 'answer' && !stream.closed) stream.close(http2.constants.NGHTTP2_CANCEL);
        resolve(outcome);
      };
      const timer = setTimeout(() => finish({ kind: 'no-answer' }), this.relayTimeoutMs);
      try {
        stream = session.h2.request({ ':method': request.method, ':path': request.path, ...request.headers });
      } catch {
        clearTimeout(timer);
        resolve({ kind: 'no-answer' });
        return;
      }
      stream.on('response', (responseHeaders) => {
        status = Number(responseHeaders[':status']);
        for (const [name, value] of Object.entries(responseHeaders)) {
          if (!name.startsWith(':') && value !== undefined) headers[name] = value as string | string[];
        }
        if (request.resetOnResponse) {
          finish({ kind: 'no-answer' });
          return;
        }
        if (request.answerCap !== undefined && !answerHeadersPass(status, headers)) {
          finish({ kind: 'unchecked', response: { status, headers, body: Buffer.alloc(0) } });
        }
      });
      stream.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (request.answerCap !== undefined && length > request.answerCap) {
          finish({ kind: 'unchecked', response: { status, headers, body: Buffer.concat(chunks) } });
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => {
        finish({ kind: 'answer', response: { status, headers, body: Buffer.concat(chunks) } });
      });
      stream.on('close', () => finish({ kind: 'no-answer' }));
      stream.on('error', () => finish({ kind: 'no-answer' }));
      stream.end(request.body === undefined ? undefined : Buffer.from(request.body));
    });
  }

  // -------------------------------------------------------------------------
  // Section 3: the listing
  // -------------------------------------------------------------------------

  private handleListing(req: http.IncomingMessage, res: http.ServerResponse, call: StandInCall): void {
    req.resume();
    const caller = this.authenticate(req, res, call);
    // The ceiling before the route's own limit [r3-1].
    if (this.count(`peer-routes:${caller.towerId}`) > this.limits.peerRoutesPerTowerPerMinute) this.rateLimited(req, res, call);
    if (this.count(`listing:${caller.towerId}`) > this.limits.listingPerTowerPerMinute) this.rateLimited(req, res, call);

    const listing: PeerListing = {
      v: PEER_PROTOCOL_VERSION,
      relay: this.mode === 'relay' ? { protocols: [...RELAYED_VERSIONS] } : null,
      self: { towerId: caller.towerId, slug: caller.slug },
      limits: {
        messagesPerTowerPerMinute: this.limits.messagesPerTowerPerMinute,
        messagesPerPairPerMinute: this.limits.messagesPerPairPerMinute,
        queriesPerPairPerMinute: this.limits.queriesPerPairPerMinute,
      },
      towers: [...this.towers.values()]
        .filter((tower) => tower.account === caller.account && tower.towerId !== caller.towerId)
        .map((tower) => ({
          towerId: tower.towerId,
          slug: tower.slug,
          online: this.isOnline(tower.towerId) !== null,
          protocols: [...this.statedProtocols(tower)],
          remoteMessaging: tower.remoteMessaging,
        })),
    };
    const json = JSON.stringify(listing);
    call.status = 200;
    call.answer = 'cloud';
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(json)) });
    res.end(json);
  }

  // -------------------------------------------------------------------------
  // Section 2: the switch-state report
  // -------------------------------------------------------------------------

  private async handleState(req: http.IncomingMessage, res: http.ServerResponse, call: StandInCall): Promise<void> {
    const caller = this.authenticate(req, res, call);
    const peerRoutes = this.count(`peer-routes:${caller.towerId}`);
    const reports = this.count(`state:${caller.towerId}`);

    // A bad body before the limits: the stand-in's reading, as the relay checks its headers
    // before its limits.
    const body = await this.readBody(req, 4_096);
    let state: unknown;
    try {
      state = body === null ? undefined : (JSON.parse(body.toString('utf8')) as { remoteMessaging?: unknown }).remoteMessaging;
    } catch {
      state = undefined;
    }
    // "A body that is not this object" is 400; a field it does not know is ignored, as
    // receivers do everywhere in the contract (section 0), so `{"remoteMessaging":"on",
    // "later":true}` is a report of "on".
    if (state !== 'on' && state !== 'off') this.cloudAnswer(res, call, 400, { outcome: 'refused', reason: 'malformed' });

    if (peerRoutes > this.limits.peerRoutesPerTowerPerMinute) this.rateLimited(req, res, call);
    if (reports > this.limits.statePerTowerPerMinute) this.rateLimited(req, res, call);

    caller.remoteMessaging = state;
    const session = this.sessions.get(caller.towerId);
    if (session) session.remoteMessaging = state;
    call.status = 204;
    call.answer = 'cloud';
    res.writeHead(204);
    res.end();
  }

  // -------------------------------------------------------------------------
  // Requests the stand-in originates
  // -------------------------------------------------------------------------

  /**
   * Send any request down a Tower's live tunnel, as anything in the cloud might (the `/t/`
   * proxy with whatever headers, for instance). No check of C's applies.
   */
  async tunnelRequest(towerId: string, request: TunnelRequest): Promise<TunnelResponse> {
    const session = this.sessions.get(towerId);
    if (!session) throw new Error(`stand-in: Tower ${towerId} has no live session`);
    const result = await this.sendDownTunnel(session, {
      method: request.method ?? 'GET',
      path: request.path,
      headers: request.headers ?? {},
      body: typeof request.body === 'string' ? Buffer.from(request.body, 'utf8') : request.body,
    });
    if (result.kind !== 'answer') throw new Error(`stand-in: no answer from ${towerId} on ${request.path}`);
    return result.response;
  }

  /**
   * Originate a forwarded request to R (section 5) without a sending Tower: a statement
   * built from the stated sender's records and MACed under R's session secret, unless the
   * options craft something else. R's answer comes back as it was given, unchecked.
   */
  async forward(toTowerId: string, options: ForwardOptions = {}): Promise<ForwardResult> {
    const recipient = this.tower(toTowerId);
    const session = this.sessions.get(toTowerId);
    if (!session) throw new Error(`stand-in: Tower ${toTowerId} has no live session`);
    const sender = options.fromTowerId
      ? this.tower(options.fromTowerId)
      : [...this.towers.values()].find((t) => t.account === recipient.account && t.towerId !== toTowerId);
    if (!sender) throw new Error(`stand-in: no other Tower on ${toTowerId}'s account to state as the sender`);
    const issuedAt = options.issuedAt ?? this.now();
    const payload = Buffer.from(
      options.payload ??
        messagePayload({
          sentAt: issuedAt,
          to: { workspace: 'codev', kind: 'architect' },
          from: { workspace: 'codev', kind: 'architect', name: 'main' },
          body: 'a message the stand-in originated',
        }),
    );

    const fields: Record<string, unknown> = {
      v: PEER_PROTOCOL_VERSION,
      kind: options.kind ?? 'message',
      toTowerId,
      fromTowerId: sender.towerId,
      fromTowerSlug: sender.slug,
      fromOwnerId: this.ownerOf(sender).ownerId,
      fromOwnerHandle: this.ownerOf(sender).ownerHandle,
      fromOwnerEmail: this.ownerOf(sender).ownerEmail,
      sameOwner: sender.account === recipient.account,
      requestId: options.requestId ?? randomUUID(),
      issuedAt,
      statementId: newStatementId(),
      payloadSha256: createHash('sha256').update(payload).digest('hex'),
    };
    for (const [name, value] of Object.entries(options.statement ?? {})) {
      if (value === undefined) delete fields[name];
      else fields[name] = value;
    }
    const statementBytes =
      options.statementBytes !== undefined ? Buffer.from(options.statementBytes) : Buffer.from(JSON.stringify(fields), 'utf8');
    const secret = options.secret ?? session.secret ?? randomBytes(32);
    const sentHeaders: Record<string, string> = {
      'content-type': 'application/json',
      [H.statement]: statementBytes.toString('base64url'),
      [H.mac]: options.mac ?? createHmac('sha256', secret).update(statementBytes).digest('base64url'),
    };
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (value === undefined) delete sentHeaders[name];
      else sentHeaders[name] = value;
    }
    return this.sendForward(session, {
      method: options.method ?? 'POST',
      path: options.path ?? ENTRY_PATH,
      headers: sentHeaders,
      statementBytes,
      statement: options.statementBytes === undefined ? fields : null,
      payload,
    });
  }

  /**
   * Send a forward the stand-in sent before again, byte for byte, down R's CURRENT session:
   * a replayed statement, or (after a reconnect) one from an earlier session.
   */
  async replay(previous: ForwardResult, toTowerId: string): Promise<ForwardResult> {
    const session = this.sessions.get(toTowerId);
    if (!session) throw new Error(`stand-in: Tower ${toTowerId} has no live session`);
    return this.sendForward(session, {
      method: previous.method,
      path: previous.path,
      headers: previous.sentHeaders,
      statementBytes: previous.statementBytes,
      statement: null,
      payload: previous.payload,
    });
  }

  private async sendForward(
    session: StandInSession,
    request: {
      method: string;
      path: string;
      headers: Record<string, string>;
      statementBytes: Buffer;
      statement: Record<string, unknown> | null;
      payload: Buffer;
    },
  ): Promise<ForwardResult> {
    const forward: StandInForward = {
      toTowerId: session.towerId,
      sessionSeq: session.seq,
      statementHeader: request.headers[H.statement] ?? '',
      mac: request.headers[H.mac] ?? '',
      statement: request.statement,
      payload: request.payload,
      answer: null,
    };
    this.forwards.push(forward);
    const result = await this.sendDownTunnel(session, {
      method: request.method,
      path: request.path,
      headers: request.headers,
      body: request.payload,
    });
    if (result.kind !== 'answer') throw new Error(`stand-in: no answer from ${session.towerId} to an originated forward`);
    forward.answer = result.response;
    let json: unknown;
    try {
      json = JSON.parse(result.response.body.toString('utf8'));
    } catch {
      json = undefined;
    }
    return {
      ...result.response,
      method: request.method,
      path: request.path,
      sentHeaders: { ...request.headers },
      statementBytes: request.statementBytes,
      payload: request.payload,
      json,
    };
  }
}

/** Status, media type and outcome header of R's answer, as C checks them [r4] [r2-D]. */
function answerHeadersPass(status: number, headers: Record<string, string | string[]>): boolean {
  const contentType = headers['content-type'];
  const outcome = headers[H.outcome];
  return (
    status === 200 &&
    typeof contentType === 'string' &&
    contentType.split(';')[0].trim().toLowerCase() === 'application/json' &&
    typeof outcome === 'string' &&
    RECEIVER_OUTCOMES.has(outcome)
  );
}

/** The `peer` field of an `auth` (section 1). Malformed is treated as absent [r6]. */
function readPeerField(message: { peer?: unknown }): StandInHandshake['peer'] {
  if (!('peer' in message) || message.peer === undefined) return 'absent';
  const peer = message.peer as { protocols?: unknown; remoteMessaging?: unknown } | null;
  if (
    peer === null ||
    typeof peer !== 'object' ||
    Array.isArray(peer) ||
    !Array.isArray(peer.protocols) ||
    !peer.protocols.every((p) => typeof p === 'number' && Number.isSafeInteger(p) && p > 0) ||
    (peer.remoteMessaging !== 'on' && peer.remoteMessaging !== 'off')
  ) {
    return 'malformed';
  }
  return { protocols: [...(peer.protocols as number[])], remoteMessaging: peer.remoteMessaging };
}
