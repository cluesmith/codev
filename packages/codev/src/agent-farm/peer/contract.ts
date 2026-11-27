/**
 * The Tower-to-Tower wire contract, protocol version 1 (Spec 1967, Wire Contract section,
 * revision 4). This is the ONE production module that speaks it:
 *
 * - the header names, and building and reading the relay headers;
 * - the tunnel handshake's fields, and the TLS rule for the cloud's transport;
 * - the statement: base64url, the MAC in constant time, R's steps 1 to 7, and the field
 *   rules of section 5 as one table, with the excluded code points written out as data;
 * - the payload: Decision 7's line endings and removals, literal UTF-8 serialisation, the
 *   field rules of section 4, and the payload hash;
 * - the answer: R's encoding, and S's reading of whatever comes back, including the mapping
 *   from an HTTP status to an outcome and who decided;
 * - the order of S's own refusals, as a list of named checks.
 *
 * No other production file builds a contract header, parses a statement or maps a status
 * to an outcome (a structural test enforces it), so a correction from the cloud is a
 * change to this file and its tests. The shapes and the constants are in
 * `@cluesmith/codev-types` (`peer-wire.ts`).
 *
 * Statement ids already seen (R's step 8) are session state and live with the tunnel
 * session, not here.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { isIPv4 } from 'node:net';
import {
  PEER_FRESHNESS_MS,
  PEER_MAX_ANSWER_BYTES,
  PEER_MAX_BODY_BYTES,
  PEER_MAX_DETAIL_CHARS,
  PEER_MAX_PAYLOAD_BYTES,
  PEER_MAX_STATEMENT_HEADER_BYTES,
  PEER_MESSAGE_LIFETIME_MS,
  PEER_PROTOCOL_VERSION,
  PEER_PROTOCOLS_SPOKEN,
  type PeerAnswer,
  type PeerAnswerReason,
  type PeerCloudRefusalReason,
  type PeerDiscoveredAddress,
  type PeerHandshake,
  type PeerHeldReason,
  type PeerMessagePayload,
  type PeerOutcome,
  type PeerQueryPayload,
  type PeerReceiverRefusalReason,
  type PeerRequestKind,
  type PeerStatement,
  type PeerSwitchState,
  type PeerUnavailableReason,
  type PeerWireAddress,
  type PeerWireSenderAddress,
} from '@cluesmith/codev-types';
import { isAddressComponent, MAX_ADDRESS_LENGTH, tryFormatAddress } from '@cluesmith/codev-sdk/address';

// ===========================================================================
// Names on the wire
// ===========================================================================

/** Every header this protocol adds. All start with `x-codev-peer-`; all are lower-case. */
export const PEER_HEADER = {
  version: 'x-codev-peer-version',
  kind: 'x-codev-peer-kind',
  to: 'x-codev-peer-to',
  requestId: 'x-codev-peer-request-id',
  statement: 'x-codev-peer-statement',
  mac: 'x-codev-peer-mac',
  outcome: 'x-codev-peer-outcome',
} as const;

/** The one path C forwards peer traffic to, down R's tunnel. Exactly this; no query. */
export const PEER_ENTRY_PATH = '/__tower/peer';

/** The media type of every payload and every answer. */
const JSON_MEDIA_TYPE = 'application/json';

/** The size of a session secret and of a MAC, in bytes. */
const SECRET_BYTES = 32;
const MAC_BYTES = 32;

// ===========================================================================
// Primitive rules
// ===========================================================================

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
const CLOUD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HANDLE_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATEMENT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
/** In a `u` regex a surrogate class matches only a surrogate that is not half of a pair. */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;
const MIN_EMAIL_BYTES = 1;
const MAX_EMAIL_BYTES = 254;

const utf8Encoder = new TextEncoder();
/** Refuses invalid UTF-8 and keeps a leading byte-order mark, so JSON.parse refuses it too. */
const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).length;
}

/** A JSON number that is an integer in the range every party can represent exactly. */
function isJsonInteger(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
}

function isWellFormedString(value: unknown): value is string {
  return typeof value === 'string' && !LONE_SURROGATE.test(value);
}

function matches(pattern: RegExp): (value: unknown) => boolean {
  return (value) => typeof value === 'string' && pattern.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Is `text` a UUID in canonical lower-case form, as a request id must be? */
export function isCanonicalUuid(text: unknown): text is string {
  return typeof text === 'string' && UUID_PATTERN.test(text);
}

// ===========================================================================
// Code point lists (data, fixed by the contract; they do not follow a Unicode version)
// ===========================================================================

/** An inclusive range of code points. */
type CodePointRange = readonly [first: number, last: number];

/**
 * What Decision 7 removes from a remote body, after its line-ending rule has turned CR LF,
 * a lone CR, U+2028 and U+2029 into line feeds. Tab and line feed are kept.
 */
export const REMOTE_BODY_REMOVED_CODE_POINTS: readonly CodePointRange[] = [
  [0x0000, 0x0008], // C0 controls before tab
  [0x000b, 0x001f], // C0 controls after line feed
  [0x007f, 0x009f], // DEL and the C1 controls
  [0x00ad, 0x00ad], // soft hyphen
  [0x061c, 0x061c], // Arabic letter mark
  [0x180e, 0x180e], // Mongolian vowel separator
  [0x200b, 0x200f], // zero-width space, non-joiner, joiner, the two direction marks
  [0x202a, 0x202e], // the embedding and override controls
  [0x2060, 0x2064], // word joiner and the invisible operators
  [0x2066, 0x2069], // the isolate controls
  [0xfeff, 0xfeff], // byte-order mark, zero-width no-break space
];

/**
 * The excluded code points for `fromOwnerEmail` [r2-C], one entry per line of the
 * contract's list: Decision 7's removals plus the four it keeps or converts (tab, line
 * feed, U+2028, U+2029), because the value reaches a header line in stage 3. The same
 * list is what S strips from an answer's `detail` before printing it.
 */
export const EXCLUDED_CODE_POINTS: readonly CodePointRange[] = [
  [0x0000, 0x001f], // all C0 controls, tab and line feed included
  [0x007f, 0x009f], // DEL and the C1 controls
  [0x00ad, 0x00ad], // soft hyphen
  [0x061c, 0x061c], // Arabic letter mark
  [0x180e, 0x180e], // Mongolian vowel separator
  [0x200b, 0x200f], // zero-width space, non-joiner, joiner, the two direction marks
  [0x2028, 0x2029], // line separator, paragraph separator
  [0x202a, 0x202e], // the embedding and override controls
  [0x2060, 0x2064], // word joiner and the invisible operators
  [0x2066, 0x2069], // the isolate controls
  [0xfeff, 0xfeff], // byte-order mark, zero-width no-break space
];

function codePointClass(ranges: readonly CodePointRange[]): string {
  const hex = (codePoint: number) => `\\u{${codePoint.toString(16)}}`;
  return `[${ranges.map(([first, last]) => (first === last ? hex(first) : `${hex(first)}-${hex(last)}`)).join('')}]`;
}

const REMOVED_PATTERN = new RegExp(codePointClass(REMOTE_BODY_REMOVED_CODE_POINTS), 'gu');
const EXCLUDED_PATTERN = new RegExp(codePointClass(EXCLUDED_CODE_POINTS), 'u');
const EXCLUDED_PATTERN_GLOBAL = new RegExp(codePointClass(EXCLUDED_CODE_POINTS), 'gu');
const LINE_ENDINGS = /\r\n|\r|\u2028|\u2029/g;

/**
 * Decision 7's line-ending rule and removals, in that order. S applies them before it
 * serialises a payload; R applies them again (with its frame-marker rule) before storing.
 */
export function normalizeRemoteBody(text: string): string {
  return text.replace(LINE_ENDINGS, '\n').replace(REMOVED_PATTERN, '');
}

/** An answer's `detail`, made safe to print: no excluded code point, at most 500 characters. */
export function printableDetail(detail: string): string {
  return capCodePoints(detail.replace(EXCLUDED_PATTERN_GLOBAL, ''), PEER_MAX_DETAIL_CHARS);
}

/** Characters, as the contract counts them for `detail`, are code points. */
function codePointLength(text: string): number {
  return Array.from(text).length;
}

function capCodePoints(text: string, max: number): string {
  const codePoints = Array.from(text);
  return codePoints.length <= max ? text : codePoints.slice(0, max).join('');
}

// ===========================================================================
// base64url, the MAC and the hash
// ===========================================================================

/** RFC 4648 §5 base64url, without padding. */
export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url');
}

/**
 * Strict RFC 4648 §5 base64url without padding: only the alphabet, a possible length, and
 * the one canonical spelling of its bytes. `null` for anything else. (Node's own decoder
 * skips characters it does not know, which this must not.)
 */
export function decodeBase64Url(text: string): Uint8Array | null {
  if (!BASE64URL_PATTERN.test(text) || text.length % 4 === 1) return null;
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text) return null;
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The session secret from `auth_ok.relay.sessionSecret`: 32 bytes, or `null`. */
export function decodeSessionSecret(value: unknown): Uint8Array | null {
  if (typeof value !== 'string') return null;
  const bytes = decodeBase64Url(value);
  return bytes !== null && bytes.length === SECRET_BYTES ? bytes : null;
}

/** base64url of HMAC-SHA-256(key = secret, message = statement bytes): `x-codev-peer-mac`. */
export function computeStatementMac(secret: Uint8Array, statementBytes: Uint8Array): string {
  return createHmac('sha256', secret).update(statementBytes).digest('base64url');
}

/** The SHA-256 of exactly these bytes, lowercase hex: a statement's `payloadSha256`. */
export function payloadSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function macVerifies(secret: Uint8Array, statementBytes: Uint8Array, mac: Uint8Array): boolean {
  if (mac.length !== MAC_BYTES) return false;
  const expected = createHmac('sha256', secret).update(statementBytes).digest();
  return timingSafeEqual(expected, mac);
}

// ===========================================================================
// Section 1: the tunnel handshake, and the TLS rule
// ===========================================================================

/** The `peer` field of this Tower's `auth`: the versions it speaks, and its switch as it stands. */
export function buildPeerHandshake(remoteMessaging: PeerSwitchState): PeerHandshake {
  return { protocols: [...PEER_PROTOCOLS_SPOKEN], remoteMessaging };
}

/**
 * What an `auth_ok` says of a relay, read strictly. Whether the secret may be kept is the
 * TLS rule's ({@link isSecureCloudTransport}), applied by the tunnel client, which knows
 * the transport.
 *
 * - `absent`: no `relay` field, a cloud that predates the contract;
 * - `null`: `relay: null`, a cloud that explicitly has none;
 * - `malformed`: a `relay` that is not an object whose `protocols` is an array of positive
 *   integers and whose `sessionSecret` is 32 bytes in strict base64url;
 * - `unsupported`: a relay for no version this Tower speaks;
 * - `offered`: a relay this Tower can use, with the session's secret.
 */
export type RelayOffer =
  | { relay: 'absent' | 'null' | 'malformed' }
  | { relay: 'unsupported'; protocols: number[] }
  | { relay: 'offered'; protocols: number[]; secret: Uint8Array };

/** The `relay` field of an `auth_ok` message (section 1). A Tower infers a relay from nothing else. */
export function readRelayOffer(authOk: Readonly<Record<string, unknown>>): RelayOffer {
  if (!Object.hasOwn(authOk, 'relay')) return { relay: 'absent' };
  const relay = authOk.relay;
  if (relay === null) return { relay: 'null' };
  if (!isPlainObject(relay) || !Array.isArray(relay.protocols) || !relay.protocols.every((v) => isJsonInteger(v, 1))) {
    return { relay: 'malformed' };
  }
  const secret = decodeSessionSecret(relay.sessionSecret);
  if (secret === null) return { relay: 'malformed' };
  const protocols = [...(relay.protocols as number[])];
  if (!protocols.some((v) => PEER_PROTOCOLS_SPOKEN.includes(v))) return { relay: 'unsupported', protocols };
  return { relay: 'offered', protocols, secret };
}

/**
 * The contract's TLS rule: a Tower accepts a session secret only on a `wss:` tunnel, and
 * makes the calls of sections 2 to 4 only over `https:`, unless the cloud's host is a
 * loopback address (tests). A cloud reached any other way is treated as having no relay.
 */
export function isSecureCloudTransport(url: URL): boolean {
  return url.protocol === 'wss:' || url.protocol === 'https:' || isLoopbackHostname(url.hostname);
}

/**
 * `localhost`, an address in 127.0.0.0/8, or `::1`, as a parsed URL spells its host (the
 * parser has already turned `127.1` or `0x7f.0.0.1` into dotted-quad form). Anything else,
 * an IPv4-mapped IPv6 address included, is not loopback here: the rule fails closed.
 */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  return isIPv4(hostname) && hostname.startsWith('127.');
}

// ===========================================================================
// Strict JSON objects
// ===========================================================================

type JsonObjectResult = { ok: true; value: Record<string, unknown>; duplicateKeys: boolean } | { ok: false };

/**
 * Bytes that are valid UTF-8 and parse as one JSON object. Also reports whether any
 * object in it repeats a key, which JSON.parse silently resolves to the last one.
 */
function parseJsonObject(bytes: Uint8Array): JsonObjectResult {
  let text: string;
  let value: unknown;
  try {
    text = strictUtf8Decoder.decode(bytes);
    value = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (!isPlainObject(value)) return { ok: false };
  return { ok: true, value, duplicateKeys: hasDuplicateKeys(text) };
}

/**
 * Does any object in this text repeat a key (compared after unescaping)? The text has
 * already parsed as JSON, so a scan of its strings and brackets is enough.
 */
function hasDuplicateKeys(json: string): boolean {
  /** One entry per open bracket: the keys seen so far for an object, `null` for an array. */
  const open: Array<Set<string> | null> = [];
  let expectingKey = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (c === '"') {
      let end = i + 1;
      while (json[end] !== '"') end += json[end] === '\\' ? 2 : 1;
      const keys = open[open.length - 1];
      if (expectingKey && keys) {
        const key = JSON.parse(json.slice(i, end + 1)) as string;
        if (keys.has(key)) return true;
        keys.add(key);
        expectingKey = false;
      }
      i = end;
    } else if (c === '{') {
      open.push(new Set());
      expectingKey = true;
    } else if (c === '[') {
      open.push(null);
      expectingKey = false;
    } else if (c === '}' || c === ']') {
      open.pop();
      expectingKey = false;
    } else if (c === ',') {
      expectingKey = open.length > 0 && open[open.length - 1] !== null;
    }
  }
  return false;
}

// ===========================================================================
// Section 5: the statement's field rules, as one table
// ===========================================================================

function isStatementEmail(value: unknown): boolean {
  if (!isWellFormedString(value) || EXCLUDED_PATTERN.test(value)) return false;
  const bytes = utf8ByteLength(value);
  return bytes >= MIN_EMAIL_BYTES && bytes <= MAX_EMAIL_BYTES;
}

/** Every field of a version 1 statement, and the rule its value must fit. */
export const STATEMENT_FIELD_RULES: { readonly [Field in keyof PeerStatement]: (value: unknown) => boolean } = {
  v: (value) => isJsonInteger(value, 1),
  kind: (value) => value === 'message' || value === 'query',
  toTowerId: matches(CLOUD_ID_PATTERN),
  fromTowerId: matches(CLOUD_ID_PATTERN),
  fromTowerSlug: matches(SLUG_PATTERN),
  fromOwnerId: matches(CLOUD_ID_PATTERN),
  fromOwnerHandle: (value) => value === null || matches(HANDLE_PATTERN)(value),
  fromOwnerEmail: isStatementEmail,
  sameOwner: (value) => typeof value === 'boolean',
  requestId: matches(UUID_PATTERN),
  issuedAt: (value) => isJsonInteger(value, 1),
  statementId: matches(STATEMENT_ID_PATTERN),
  payloadSha256: matches(SHA256_HEX_PATTERN),
};

const STATEMENT_FIELDS = Object.keys(STATEMENT_FIELD_RULES) as Array<keyof PeerStatement>;

/** The statement's fields if every one is present and fits its rule; unknown fields are dropped. */
function readStatementFields(object: Record<string, unknown>): PeerStatement | null {
  for (const field of STATEMENT_FIELDS) {
    if (!Object.hasOwn(object, field) || !STATEMENT_FIELD_RULES[field](object[field])) return null;
  }
  const statement = {} as Record<keyof PeerStatement, unknown>;
  for (const field of STATEMENT_FIELDS) statement[field] = object[field];
  return statement as unknown as PeerStatement;
}

// ===========================================================================
// Section 5: R's checks, steps 1 to 7
// ===========================================================================

/** A request at `POST /__tower/peer`, as the tunnel client read it. */
export interface RelayedRequest {
  /** The `x-codev-peer-statement` header: absent, or repeated, fails step 1. */
  statementHeader: string | string[] | undefined;
  /** The `x-codev-peer-mac` header. */
  macHeader: string | string[] | undefined;
  /** The body as read. A reader that stops past the cap passes what it read, over the cap. */
  body: Uint8Array;
  /** The decoded secret of the session this arrived on; `null` when its `auth_ok` carried no relay. */
  sessionSecret: Uint8Array | null;
  /** R's own Tower id. */
  receiverTowerId: string;
  /** R's clock, epoch ms. */
  now: number;
}

/**
 * R's verdict on steps 1 to 7 of section 5. Step 8 (a statement id seen in the last 10
 * minutes) is the caller's, against its session's memory, and only after `verified`.
 *
 * What each verdict may tell a record: nothing about the sender before step 2 has passed;
 * the sending Tower's id once the MAC has verified (if that field fits its rule); the
 * whole statement once step 4 has passed.
 */
export type RelayVerification =
  | { verdict: 'verified'; statement: PeerStatement }
  | { verdict: 'not-verified'; step: 1 | 2 }
  | { verdict: 'not-verified'; step: 4; fromTowerId: string | null }
  | { verdict: 'not-verified'; step: 5 | 6; statement: PeerStatement }
  | {
      verdict: 'refused';
      step: 3;
      reason: 'unsupported-version';
      supported: readonly number[];
      fromTowerId: string | null;
    }
  | { verdict: 'refused'; step: 7; reason: 'clock-skew'; statement: PeerStatement };

function singleHeader(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function verifiedFromTowerId(object: Record<string, unknown> | null): string | null {
  const value = object?.fromTowerId;
  return STATEMENT_FIELD_RULES.fromTowerId(value) ? (value as string) : null;
}

/** Steps 1 to 7 of section 5, in order. Stores nothing and keeps no state. */
export function verifyRelayedRequest(request: RelayedRequest): RelayVerification {
  // Step 1: both headers, once each; the statement header and the body within their caps.
  const statementHeader = singleHeader(request.statementHeader);
  const macHeader = singleHeader(request.macHeader);
  if (
    statementHeader === null ||
    macHeader === null ||
    utf8ByteLength(statementHeader) > PEER_MAX_STATEMENT_HEADER_BYTES ||
    request.body.length > PEER_MAX_PAYLOAD_BYTES
  ) {
    return { verdict: 'not-verified', step: 1 };
  }

  // Step 2: the MAC verifies, in constant time, under this session's secret.
  const statementBytes = decodeBase64Url(statementHeader);
  const mac = decodeBase64Url(macHeader);
  if (
    request.sessionSecret === null ||
    statementBytes === null ||
    mac === null ||
    !macVerifies(request.sessionSecret, statementBytes, mac)
  ) {
    return { verdict: 'not-verified', step: 2 };
  }

  // Step 3: a JSON object whose `v` is a version this Tower speaks.
  const parsed = parseJsonObject(statementBytes);
  if (!parsed.ok || !PEER_PROTOCOLS_SPOKEN.includes(parsed.value.v as number)) {
    return {
      verdict: 'refused',
      step: 3,
      reason: 'unsupported-version',
      supported: PEER_PROTOCOLS_SPOKEN,
      fromTowerId: verifiedFromTowerId(parsed.ok ? parsed.value : null),
    };
  }

  // Step 4: every field present and fitting its rule, and no key given twice.
  const statement = parsed.duplicateKeys ? null : readStatementFields(parsed.value);
  if (statement === null) {
    return { verdict: 'not-verified', step: 4, fromTowerId: verifiedFromTowerId(parsed.value) };
  }

  // Step 5: addressed to this Tower.
  if (statement.toTowerId !== request.receiverTowerId) {
    return { verdict: 'not-verified', step: 5, statement };
  }

  // Step 6: the body is the one the statement was issued for.
  if (payloadSha256(request.body) !== statement.payloadSha256) {
    return { verdict: 'not-verified', step: 6, statement };
  }

  // Step 7: issued within 5 minutes of this Tower's clock, either way (inclusive).
  if (Math.abs(statement.issuedAt - request.now) > PEER_FRESHNESS_MS) {
    return { verdict: 'refused', step: 7, reason: 'clock-skew', statement };
  }

  return { verdict: 'verified', statement };
}

// ===========================================================================
// Section 4: the payload
// ===========================================================================

/**
 * An address in a payload, read off the wire: stage 1's structured address without
 * `tower` or `owner`, every component fitting the component rule, and a text form that
 * reads back as itself within stage 1's length limit. Returns a fresh object holding only
 * the address's own fields, or `null`.
 */
function readWireAddress(value: unknown, workspaceRequired: true): PeerWireAddress | null;
function readWireAddress(value: unknown, workspaceRequired: false): PeerWireSenderAddress | null;
function readWireAddress(value: unknown, workspaceRequired: boolean): PeerWireSenderAddress | null {
  if (!isPlainObject(value) || Object.hasOwn(value, 'tower') || Object.hasOwn(value, 'owner')) return null;
  const isComponent = (part: unknown): part is string => typeof part === 'string' && isAddressComponent(part);
  const { workspace, kind, name } = value;

  if (workspace === undefined) {
    if (workspaceRequired) return null;
  } else if (!isComponent(workspace)) {
    return null;
  }
  const location = workspace === undefined ? {} : { workspace };

  let address: PeerWireSenderAddress;
  if (kind === 'architect' && name === undefined) {
    address = { ...location, kind: 'architect' };
  } else if (kind === 'architect' && isComponent(name)) {
    address = { ...location, kind: 'architect', name };
  } else if (kind === 'id' && isComponent(name)) {
    address = { ...location, kind: 'id', name };
  } else {
    return null;
  }

  const text = tryFormatAddress(address);
  return text.ok && text.text.length <= MAX_ADDRESS_LENGTH ? address : null;
}

/** Is this a recipient address a payload may carry (`workspace` required)? */
export function isWireAddress(value: unknown): value is PeerWireAddress {
  return readWireAddress(value, true) !== null;
}

/**
 * A sender address as a payload may carry it (`workspace` optional), read as a fresh object
 * holding only its own fields, or `null` when it does not fit. The mailbox stores a remote
 * row's sender through this, so it holds no value the payload reader would not.
 */
export function readWireSenderAddress(value: unknown): PeerWireSenderAddress | null {
  return readWireAddress(value, false);
}

/** Why a message body cannot be sent. */
export type RemoteBodyResult = { ok: true; body: string; bytes: number } | { ok: false; reason: 'malformed' | 'too-large' };

/**
 * A body as S sends it: valid Unicode, normalised by Decision 7, and at most 48 KiB as
 * UTF-8 once normalised. S's check 6 (`too-large`) is this.
 */
export function prepareRemoteBody(body: string): RemoteBodyResult {
  if (!isWellFormedString(body)) return { ok: false, reason: 'malformed' };
  const normalized = normalizeRemoteBody(body);
  const bytes = utf8ByteLength(normalized);
  if (bytes > PEER_MAX_BODY_BYTES) return { ok: false, reason: 'too-large' };
  return { ok: true, body: normalized, bytes };
}

/** A payload ready for the relay call: these exact bytes are stored and resent on every retry. */
export interface EncodedPayload {
  bytes: Uint8Array;
  sha256: string;
}

export type PayloadEncodeResult = ({ ok: true } & EncodedPayload) | { ok: false; reason: 'malformed' | 'too-large' };

/**
 * Serialise the payload of kind `message`. JSON.stringify writes every non-ASCII character
 * as literal UTF-8 and escapes only `"`, `\` and U+0000 to U+001F; with the body already
 * well-formed and normalised, every escape costs at most two bytes, so any legal body fits
 * the payload cap.
 */
export function encodeMessagePayload(message: {
  sentAt: number;
  to: PeerWireAddress;
  from: PeerWireSenderAddress | null;
  body: string;
}): PayloadEncodeResult {
  const to = readWireAddress(message.to, true);
  const from = message.from === null ? null : readWireAddress(message.from, false);
  if (!isJsonInteger(message.sentAt, 0) || to === null || (message.from !== null && from === null)) {
    return { ok: false, reason: 'malformed' };
  }
  const body = prepareRemoteBody(message.body);
  if (!body.ok) return body;

  const payload: PeerMessagePayload = { sentAt: message.sentAt, to, from, body: body.body };
  return finishPayload(JSON.stringify(payload));
}

/** Serialise the payload of kind `query`. */
export function encodeQueryPayload(sentAt: number): PayloadEncodeResult {
  if (!isJsonInteger(sentAt, 0)) return { ok: false, reason: 'malformed' };
  const payload: PeerQueryPayload = { sentAt, what: 'addresses' };
  return finishPayload(JSON.stringify(payload));
}

function finishPayload(json: string): PayloadEncodeResult {
  const bytes = utf8Encoder.encode(json);
  if (bytes.length > PEER_MAX_PAYLOAD_BYTES) return { ok: false, reason: 'too-large' };
  return { ok: true, bytes, sha256: payloadSha256(bytes) };
}

/** R's step 12: what a payload's rules can refuse it for. */
export type PayloadRefusalReason = 'malformed' | 'clock-skew' | 'expired' | 'too-large';
export type PayloadReadResult<Payload> = { ok: true; payload: Payload } | { ok: false; reason: PayloadRefusalReason };

/** `sentAt` against R's clock: at most 5 minutes ahead, at most 30 days behind (both inclusive). */
function sentAtRefusal(sentAt: number, now: number): 'clock-skew' | 'expired' | null {
  if (sentAt - now > PEER_FRESHNESS_MS) return 'clock-skew';
  if (now - sentAt > PEER_MESSAGE_LIFETIME_MS) return 'expired';
  return null;
}

/**
 * R's step 12 for kind `message`: the payload parses and fits section 4's field rules
 * (otherwise `malformed`), then `sentAt` is not too far ahead (`clock-skew`) nor too old
 * (`expired`), then the body is at most 48 KiB (`too-large`). The body is returned as
 * received; R normalises it with its frame rules before storing it.
 */
export function readMessagePayload(bytes: Uint8Array, now: number): PayloadReadResult<PeerMessagePayload> {
  const parsed = parseJsonObject(bytes);
  if (!parsed.ok || parsed.duplicateKeys) return { ok: false, reason: 'malformed' };
  const { sentAt, to: rawTo, from: rawFrom, body } = parsed.value;
  const to = readWireAddress(rawTo, true);
  const from = rawFrom === null ? null : readWireAddress(rawFrom, false);
  if (
    !isJsonInteger(sentAt, 0) ||
    to === null ||
    (rawFrom !== null && from === null) ||
    !isWellFormedString(body)
  ) {
    return { ok: false, reason: 'malformed' };
  }
  const refusal = sentAtRefusal(sentAt, now);
  if (refusal !== null) return { ok: false, reason: refusal };
  if (utf8ByteLength(body) > PEER_MAX_BODY_BYTES) return { ok: false, reason: 'too-large' };
  return { ok: true, payload: { sentAt, to, from, body } };
}

/** R's step 12 for kind `query`. */
export function readQueryPayload(bytes: Uint8Array, now: number): PayloadReadResult<PeerQueryPayload> {
  const parsed = parseJsonObject(bytes);
  if (!parsed.ok || parsed.duplicateKeys) return { ok: false, reason: 'malformed' };
  const { sentAt, what } = parsed.value;
  if (!isJsonInteger(sentAt, 0) || what !== 'addresses') return { ok: false, reason: 'malformed' };
  const refusal = sentAtRefusal(sentAt, now);
  if (refusal !== null) return { ok: false, reason: refusal };
  return { ok: true, payload: { sentAt, what } };
}

// ===========================================================================
// Section 4: the relay call's headers
// ===========================================================================

/** The headers of a relay call, other than `Authorization`, which the cloud client adds. */
export function buildRelayRequestHeaders(request: {
  kind: PeerRequestKind;
  toTowerId: string;
  requestId: string;
}): Record<string, string> {
  if (!isCanonicalUuid(request.requestId)) {
    throw new Error('A relay request id must be a UUID in canonical lower-case form.');
  }
  return {
    'content-type': JSON_MEDIA_TYPE,
    [PEER_HEADER.version]: String(PEER_PROTOCOL_VERSION),
    [PEER_HEADER.kind]: request.kind,
    [PEER_HEADER.to]: request.toTowerId,
    [PEER_HEADER.requestId]: request.requestId,
  };
}

export type RelayHeadersReadResult =
  | { ok: true; version: number; kind: PeerRequestKind; toTowerId: string; requestId: string }
  | { ok: false; reason: 'malformed' | 'unsupported-version' };

/**
 * A relay call's headers read as C's step 2 reads them (lower-case header names, as Node
 * gives them). The `x-codev-peer-to` check against the caller's own Tower is C's, which
 * knows who called.
 */
export function readRelayRequestHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): RelayHeadersReadResult {
  const requestId = singleHeader(headers[PEER_HEADER.requestId]);
  const kind = singleHeader(headers[PEER_HEADER.kind]);
  const toTowerId = singleHeader(headers[PEER_HEADER.to]);
  const version = singleHeader(headers[PEER_HEADER.version]);
  if (
    !isCanonicalUuid(requestId) ||
    (kind !== 'message' && kind !== 'query') ||
    toTowerId === null ||
    headers['content-encoding'] !== undefined
  ) {
    return { ok: false, reason: 'malformed' };
  }
  const spoken = PEER_PROTOCOLS_SPOKEN.find((v) => String(v) === version);
  if (spoken === undefined) return { ok: false, reason: 'unsupported-version' };
  return { ok: true, version: spoken, kind, toTowerId, requestId };
}

// ===========================================================================
// Section 6: answers, as R writes them
// ===========================================================================

/** An answer ready to go back down the tunnel. R always answers 200. */
export interface EncodedAnswer {
  status: 200;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** R's answers, without `v`, which encoding adds. */
export type ReceiverAnswer =
  | { outcome: 'delivered'; duplicate?: boolean; detail?: string }
  | { outcome: 'held'; reason: PeerHeldReason; duplicate?: boolean; detail?: string }
  | {
      outcome: 'refused';
      reason: Exclude<PeerReceiverRefusalReason, 'unsupported-version' | 'rate-limited'>;
      detail?: string;
      duplicate?: boolean;
    }
  | {
      outcome: 'refused';
      reason: 'rate-limited';
      /** The seconds left in the per-peer minute; omitted when the undelivered cap tripped. */
      retryAfterSec?: number;
      detail?: string;
    }
  | { outcome: 'refused'; reason: 'unsupported-version'; supported: readonly number[]; detail?: string }
  | { outcome: 'not-verified' };

function encodeAnswerJson(outcome: PeerOutcome, json: string): EncodedAnswer {
  const body = utf8Encoder.encode(json);
  if (body.length > PEER_MAX_ANSWER_BYTES) {
    throw new Error(`A peer answer of ${body.length} bytes exceeds the ${PEER_MAX_ANSWER_BYTES}-byte cap.`);
  }
  return {
    status: 200,
    headers: { 'content-type': JSON_MEDIA_TYPE, [PEER_HEADER.outcome]: outcome },
    body,
  };
}

/** Encode one of R's answers to a message (or a refusal of a query). `detail` is capped at 500 characters. */
export function encodeReceiverAnswer(answer: ReceiverAnswer): EncodedAnswer {
  const out: Record<string, unknown> = { v: PEER_PROTOCOL_VERSION, ...answer };
  if (typeof out.detail === 'string') out.detail = capCodePoints(out.detail, PEER_MAX_DETAIL_CHARS);
  return encodeAnswerJson(answer.outcome, JSON.stringify(out));
}

/**
 * Encode R's answer to a discovery query. An address that does not fit section 4's rules
 * cannot be reached from another Tower and is left out (S would refuse the whole answer
 * over it). If the rest do not fit the answer cap, as many as fit are kept, in order, and
 * `truncated` is `true`.
 */
export function encodeDiscoveryAnswer(addresses: readonly PeerDiscoveredAddress[]): EncodedAnswer {
  const entries: string[] = [];
  for (const entry of addresses) {
    const address = readWireAddress(entry.address, true);
    if (address !== null) entries.push(JSON.stringify({ address, live: entry.live }));
  }
  const answerWith = (truncated: boolean, kept: string[]) =>
    `{"v":${PEER_PROTOCOL_VERSION},"outcome":"answered","truncated":${truncated},"addresses":[${kept.join(',')}]}`;

  let json = answerWith(false, entries);
  if (utf8ByteLength(json) > PEER_MAX_ANSWER_BYTES) {
    // Budgeted against the untruncated envelope: then not every address can fit, so
    // `truncated: true` always means at least one was left out.
    let budget = PEER_MAX_ANSWER_BYTES - utf8ByteLength(answerWith(false, []));
    const kept: string[] = [];
    for (const entry of entries) {
      const cost = utf8ByteLength(entry) + (kept.length > 0 ? 1 : 0);
      if (cost > budget) break;
      kept.push(entry);
      budget -= cost;
    }
    json = answerWith(true, kept);
  }
  return encodeAnswerJson('answered', json);
}

// ===========================================================================
// Section 6: answers, as S reads them
// ===========================================================================

const HELD_REASONS: readonly PeerHeldReason[] = ['busy', 'no-profile', 'no-live-pty', 'held-for-release'];
const RECEIVER_REFUSAL_REASONS: readonly PeerReceiverRefusalReason[] = [
  'remote-off',
  'no-grant',
  'no-such-agent',
  'not-addressable',
  'rate-limited',
  'too-large',
  'expired',
  'clock-skew',
  'unsupported-version',
  'mismatch',
  'dismissed',
  'malformed',
];

/** The outcomes R may give, by the kind of request. */
const RECEIVER_OUTCOMES: Readonly<Record<PeerRequestKind, readonly PeerOutcome[]>> = {
  message: ['delivered', 'held', 'refused', 'not-verified'],
  query: ['answered', 'refused', 'not-verified'],
};

/**
 * C's answers, by HTTP status: the outcome and the reasons each status may carry. A
 * non-200 that is not in this table, or whose body does not fit its row, is an answer
 * without the body.
 */
const CLOUD_ANSWERS: Readonly<
  Record<number, { outcome: 'refused' | 'unavailable'; reasons: ReadonlyArray<PeerCloudRefusalReason | PeerUnavailableReason> }>
> = {
  400: { outcome: 'refused', reasons: ['malformed', 'unsupported-version'] },
  401: { outcome: 'refused', reasons: ['unauthenticated'] },
  404: { outcome: 'refused', reasons: ['unknown-tower'] },
  409: { outcome: 'refused', reasons: ['peer-unsupported'] },
  413: { outcome: 'refused', reasons: ['too-large'] },
  429: { outcome: 'refused', reasons: ['rate-limited'] },
  500: { outcome: 'unavailable', reasons: ['cloud-error'] },
  502: { outcome: 'unavailable', reasons: ['tower-error'] },
  503: { outcome: 'unavailable', reasons: ['tower-offline'] },
  504: { outcome: 'unavailable', reasons: ['no-answer'] },
};

/** What came back from a relay call, as the cloud client saw it. */
export type RelayCallResult =
  /** No answer at all: a connection error, or nothing within S's 20-second call timeout. */
  | { answered: false }
  | {
      answered: true;
      status: number;
      contentType: string | undefined;
      /** The `x-codev-peer-outcome` header. */
      outcomeHeader: string | undefined;
      body: Uint8Array;
    };

/** S's own reasons for an answer it could not read as the contract's. */
export type PeerLocalAnswerReason = 'cloud-unreachable' | 'no-relay';

/**
 * A relay call's answer as S must act on it. `decidedBy` is read from the status only:
 * `receiver` for a 200 that fits the answer shape, `cloud` for a non-200 carrying the
 * contract's body for its status, and `none` when nothing that speaks the contract
 * answered (no answer, an answer without the body, or a 200 that does not fit).
 */
export interface ClassifiedAnswer {
  decidedBy: 'receiver' | 'cloud' | 'none';
  /** The HTTP status, or `null` when there was no answer. */
  status: number | null;
  outcome: PeerOutcome;
  reason: PeerAnswerReason | PeerLocalAnswerReason | null;
  /** The validated body, when the answer carried the contract's. */
  answer: PeerAnswer | null;
}

function isMediaTypeJson(contentType: string | undefined): boolean {
  return contentType?.split(';')[0].trim().toLowerCase() === JSON_MEDIA_TYPE;
}

/** Who an answer's status says decided, which fixes the outcomes and fields its body may have. */
type AnswerSource = { decidedBy: 'receiver'; kind: PeerRequestKind } | { decidedBy: 'cloud'; status: number };

function allowedReasons(source: AnswerSource, outcome: PeerOutcome): readonly string[] {
  if (source.decidedBy === 'cloud') return CLOUD_ANSWERS[source.status]?.reasons ?? [];
  if (outcome === 'held') return HELD_REASONS;
  if (outcome === 'refused') return RECEIVER_REFUSAL_REASONS;
  return [];
}

function allowedOutcomes(source: AnswerSource): readonly PeerOutcome[] {
  if (source.decidedBy === 'receiver') return RECEIVER_OUTCOMES[source.kind];
  const row = CLOUD_ANSWERS[source.status];
  return row ? [row.outcome] : [];
}

/**
 * The body of an answer if it fits section 6's shape for its source, else `null`: the
 * media type, the cap, `v`, an outcome the source may give that matches the outcome
 * header, a reason where the outcome needs one, and the type (and, for `detail`, the
 * 500-character limit) of every known field present. Unknown fields, fields that go with
 * a reason the outcome does not have, and fields only a 200 carries (`detail`,
 * `duplicate`) when C answered, are dropped.
 */
function readAnswerBody(call: Extract<RelayCallResult, { answered: true }>, source: AnswerSource): PeerAnswer | null {
  if (!isMediaTypeJson(call.contentType) || call.body.length > PEER_MAX_ANSWER_BYTES) return null;
  const parsed = parseJsonObject(call.body);
  if (!parsed.ok || parsed.duplicateKeys) return null;
  const body = parsed.value;

  const outcome = body.outcome as PeerOutcome;
  if (body.v !== PEER_PROTOCOL_VERSION || !allowedOutcomes(source).includes(outcome) || call.outcomeHeader !== outcome) {
    return null;
  }
  const out: Record<string, unknown> = { v: body.v, outcome };

  const reasons = allowedReasons(source, outcome);
  if (reasons.length > 0) {
    if (!reasons.includes(body.reason as string)) return null;
    out.reason = body.reason;
  }
  // Fields that go with a reason are read only with the reason the outcome accepted.
  if (out.reason === 'rate-limited' && body.retryAfterSec !== undefined) {
    if (!isJsonInteger(body.retryAfterSec, 0)) return null;
    out.retryAfterSec = body.retryAfterSec;
  }
  if (out.reason === 'unsupported-version') {
    const supported = body.supported;
    if (!Array.isArray(supported) || !supported.every((v) => isJsonInteger(v, 1))) return null;
    out.supported = [...supported];
  }
  if (source.decidedBy === 'receiver') {
    if (body.detail !== undefined) {
      if (typeof body.detail !== 'string' || codePointLength(body.detail) > PEER_MAX_DETAIL_CHARS) return null;
      out.detail = body.detail;
    }
    if (body.duplicate !== undefined) {
      if (typeof body.duplicate !== 'boolean') return null;
      out.duplicate = body.duplicate;
    }
  }
  if (outcome === 'answered') {
    if (typeof body.truncated !== 'boolean' || !Array.isArray(body.addresses)) return null;
    const addresses: PeerDiscoveredAddress[] = [];
    for (const entry of body.addresses) {
      const address = isPlainObject(entry) ? readWireAddress(entry.address, true) : null;
      if (address === null || typeof entry.live !== 'boolean') return null;
      addresses.push({ address, live: entry.live });
    }
    out.addresses = addresses;
    out.truncated = body.truncated;
  }
  return out as unknown as PeerAnswer;
}

function reasonOf(answer: PeerAnswer): PeerAnswerReason | null {
  return 'reason' in answer ? answer.reason : null;
}

/** No answer, or one that did not carry the contract's body, once it is known to be held. */
function cloudUnreachable(status: number | null): ClassifiedAnswer {
  return { decidedBy: 'none', status, outcome: 'unavailable', reason: 'cloud-unreachable', answer: null };
}

/**
 * Section 6 from S's side: who decided, and what. Who decided comes from the status
 * alone. `relayStated` is whether this cloud has ever stated a relay (its last `auth_ok`
 * carried a `relay` object, or its last listing a non-null `relay`); it decides what a
 * `404` without the body means.
 */
export function classifyRelayAnswer(
  call: RelayCallResult,
  context: { kind: PeerRequestKind; relayStated: boolean },
): ClassifiedAnswer {
  if (!call.answered) return cloudUnreachable(null);

  if (call.status === 200) {
    const answer = readAnswerBody(call, { decidedBy: 'receiver', kind: context.kind });
    if (answer === null) {
      // R's status with a body that does not fit: treated as `tower-error`, and held.
      return { decidedBy: 'none', status: 200, outcome: 'unavailable', reason: 'tower-error', answer: null };
    }
    return { decidedBy: 'receiver', status: 200, outcome: answer.outcome, reason: reasonOf(answer), answer };
  }

  const answer = readAnswerBody(call, { decidedBy: 'cloud', status: call.status });
  if (answer !== null) {
    return { decidedBy: 'cloud', status: call.status, outcome: answer.outcome, reason: reasonOf(answer), answer };
  }
  // An answer without the body. Before the cloud has ever stated a relay, a 404 means it
  // has none; anything else, and everything once a relay has been stated, is held.
  if (!context.relayStated && call.status === 404) {
    return { decidedBy: 'none', status: 404, outcome: 'refused', reason: 'no-relay', answer: null };
  }
  return cloudUnreachable(call.status);
}

// ===========================================================================
// Section 4: the order of S's own refusals
// ===========================================================================

/**
 * S's checks before it calls, in the contract's order. The first that applies is the
 * answer, and no call is made; after the last, S persists the message and queues it.
 *
 * - `address`: the address as text, unchanged from stage 1 (malformed, or naming an owner);
 * - `remote-off`, `not-connected`, `not-registered`, `no-relay`: this Tower's own state;
 * - `option-not-allowed`: `--raw`, `--interrupt`, `--no-enter` or `--delay`;
 * - `too-large`: the body over 48 KiB ({@link prepareRemoteBody});
 * - `unknown-tower`: a slug not in the peer list (or the cached one);
 * - `builder-rule`: a builder naming an architect that is not its own;
 * - `rate-limited`: 50 messages already waiting for that peer.
 */
export const SENDER_CHECK_ORDER = [
  'address',
  'remote-off',
  'not-connected',
  'not-registered',
  'no-relay',
  'option-not-allowed',
  'too-large',
  'unknown-tower',
  'builder-rule',
  'rate-limited',
] as const;

export type SenderCheck = (typeof SENDER_CHECK_ORDER)[number];
