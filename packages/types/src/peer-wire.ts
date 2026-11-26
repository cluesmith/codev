/**
 * The Tower-to-Tower wire contract, protocol version 1 (Spec 1967, Wire Contract section,
 * revision 4): its shapes and its constants, and nothing else.
 *
 * Only `packages/codev/src/agent-farm/peer/contract.ts` speaks the contract: it builds
 * and reads the headers, encodes and decodes the statement, the payload and the answer,
 * and maps a status to an outcome. This file holds what a second party needs to agree on
 * without importing that module: the test stand-in for Codev Cloud reads these shapes
 * and constants and computes everything else itself.
 *
 * Every name here is a wire value. Changing one is a change of the protocol.
 */

// ---------------------------------------------------------------------------
// Protocol constants (contract, "Protocol constants"). Fixed by version 1; not settings.
// ---------------------------------------------------------------------------

/** The protocol version this contract describes. */
export const PEER_PROTOCOL_VERSION = 1;
/** Every version this Tower speaks, in the order it prefers them. */
export const PEER_PROTOCOLS_SPOKEN: readonly number[] = [1];

/** The longest message `body`, as UTF-8 bytes (48 KiB). Checked by S and by R. */
export const PEER_MAX_BODY_BYTES = 49_152;
/** The longest payload S sends, C accepts and R reads, in bytes. */
export const PEER_MAX_PAYLOAD_BYTES = 102_400;
/** The longest encoded `x-codev-peer-statement` header value, in bytes. */
export const PEER_MAX_STATEMENT_HEADER_BYTES = 4_096;
/** The longest answer R gives and C passes back, in bytes. */
export const PEER_MAX_ANSWER_BYTES = 65_536;
/** The longest `detail` in an answer, in characters (code points). */
export const PEER_MAX_DETAIL_CHARS = 500;

/** How long C waits for R's complete answer. */
export const PEER_RELAY_TIMEOUT_MS = 15_000;
/** How soon R answers once it has the body. */
export const PEER_RECEIVER_ANSWER_MS = 5_000;
/** How long S waits for C's answer. */
export const PEER_SENDER_CALL_TIMEOUT_MS = 20_000;
/** How far `issuedAt`, and how far ahead `sentAt`, may be from R's clock (±5 minutes). */
export const PEER_FRESHNESS_MS = 300_000;
/** How long R remembers a used statement id. */
export const PEER_STATEMENT_ID_MEMORY_MS = 600_000;
/** A message's lifetime from its `sentAt` (30 days): after it the message is expired at S and refused by R. */
export const PEER_MESSAGE_LIFETIME_MS = 2_592_000_000;

// ---------------------------------------------------------------------------
// Section 1: the tunnel handshake.
// ---------------------------------------------------------------------------

/** The state of a Tower's remote-messaging switch, as it is stated on the wire. */
export type PeerSwitchState = 'on' | 'off';

/** The `peer` field a Tower adds to its `auth` message. Absent: the Tower does not speak the protocol. */
export interface PeerHandshake {
  protocols: number[];
  remoteMessaging: PeerSwitchState;
}

/**
 * The `relay` field of `auth_ok`: an object when the cloud has a relay, `null` when it
 * explicitly has none, absent on a cloud that predates the contract.
 */
export interface PeerRelayHandshake {
  protocols: number[];
  /** base64url of 32 CSPRNG bytes, new for every tunnel connection. Held in memory only. */
  sessionSecret: string;
}

// ---------------------------------------------------------------------------
// Section 2: the switch-state report (`PUT /api/peer/state`).
// ---------------------------------------------------------------------------

export interface PeerSwitchStateReport {
  remoteMessaging: PeerSwitchState;
}

// ---------------------------------------------------------------------------
// Section 3: the peer listing (`GET /api/peer/towers`).
// ---------------------------------------------------------------------------

/** What the listing says of another Tower's switch: `unknown` when it has never stated one. */
export type PeerListedSwitchState = PeerSwitchState | 'unknown';

export interface PeerListingTower {
  towerId: string;
  /** The Tower's current slug. */
  slug: string;
  /** A live session in C's memory now. Soft: a hint, never a promise. */
  online: boolean;
  /** What that Tower's live session stated, or its last session's (`[]` if none). */
  protocols: number[];
  remoteMessaging: PeerListedSwitchState;
}

/** C's own rate limits, approximate and C's to change. */
export interface PeerCloudLimits {
  messagesPerTowerPerMinute: number;
  messagesPerPairPerMinute: number;
  queriesPerPairPerMinute: number;
}

export interface PeerListing {
  v: number;
  /** `null` when this cloud has no relay. */
  relay: { protocols: number[] } | null;
  /** The caller's own Tower as C has it now. */
  self: { towerId: string; slug: string };
  limits: PeerCloudLimits;
  /** Every other Tower on the caller's account. */
  towers: PeerListingTower[];
}

// ---------------------------------------------------------------------------
// Section 4: the relay call, S → C.
// ---------------------------------------------------------------------------

/** What a relay call carries. */
export type PeerRequestKind = 'message' | 'query';

/** The four headers of a relay call, as S sends them and C reads them. */
export interface PeerRelayHeaders {
  'x-codev-peer-version': string;
  'x-codev-peer-kind': PeerRequestKind;
  /** R's Tower id. */
  'x-codev-peer-to': string;
  /** The message id or query id: a UUID chosen by S, in canonical lower-case form. */
  'x-codev-peer-request-id': string;
}

/**
 * An address in a payload: stage 1's structured address without `tower` or `owner`.
 * `kind: 'architect'` without a `name` is the workspace's front door; `kind: 'id'` is a
 * builder by its id. Every component fits stage 1's component rule.
 */
export type PeerWireAddress =
  | { workspace: string; kind: 'architect'; name?: string }
  | { workspace: string; kind: 'id'; name: string };

/** The sender's address in a payload: as {@link PeerWireAddress}, with `workspace` optional. */
export type PeerWireSenderAddress =
  | { workspace?: string; kind: 'architect'; name?: string }
  | { workspace?: string; kind: 'id'; name: string };

/** The payload of kind `message`: the envelope the message id belongs to. */
export interface PeerMessagePayload {
  /** S's send time, epoch ms, fixed across retries. The 30-day lifetime runs from it. */
  sentAt: number;
  /** The recipient, as R would write it locally. */
  to: PeerWireAddress;
  /** S's statement of the sender; `null` when the sender has no agent identity. */
  from: PeerWireSenderAddress | null;
  body: string;
}

/** The payload of kind `query` (discovery). */
export interface PeerQueryPayload {
  sentAt: number;
  what: 'addresses';
}

// ---------------------------------------------------------------------------
// Section 5: the forwarded request, C → R.
// ---------------------------------------------------------------------------

/** The two headers C adds when it forwards a relay call down R's tunnel. */
export interface PeerForwardedHeaders {
  /** base64url of the statement bytes. */
  'x-codev-peer-statement': string;
  /** base64url of HMAC-SHA-256(key = decoded session secret, message = statement bytes). */
  'x-codev-peer-mac': string;
}

/** The statement C issues for one forward, as R reads it once its MAC has verified. */
export interface PeerStatement {
  v: number;
  kind: PeerRequestKind;
  toTowerId: string;
  fromTowerId: string;
  /** S's slug at the moment of issue. */
  fromTowerSlug: string;
  fromOwnerId: string;
  /** Always `null` until accounts have handles (stage 3). */
  fromOwnerHandle: string | null;
  fromOwnerEmail: string;
  /** Always `true` in stage 2. */
  sameOwner: boolean;
  /** Copied from S's validated `x-codev-peer-request-id`. */
  requestId: string;
  /** When C issued the statement, epoch ms. */
  issuedAt: number;
  /** base64url of 16 random bytes, new for every statement. */
  statementId: string;
  /** SHA-256 of exactly the bytes C forwards, lowercase hex. */
  payloadSha256: string;
}

// ---------------------------------------------------------------------------
// Section 6: answers.
// ---------------------------------------------------------------------------

/** The outcomes R gives, always with status 200. */
export type PeerReceiverOutcome = 'delivered' | 'held' | 'refused' | 'not-verified' | 'answered';
/** The outcomes C gives, never with status 200. */
export type PeerCloudOutcome = 'refused' | 'unavailable';
export type PeerOutcome = PeerReceiverOutcome | PeerCloudOutcome;

/** Why R holds a message it has accepted. */
export type PeerHeldReason = 'busy' | 'no-profile' | 'no-live-pty' | 'held-for-release';

/** Why R refuses a request. */
export type PeerReceiverRefusalReason =
  | 'remote-off'
  | 'no-grant'
  | 'no-such-agent'
  | 'not-addressable'
  | 'rate-limited'
  | 'too-large'
  | 'expired'
  | 'clock-skew'
  | 'unsupported-version'
  | 'mismatch'
  | 'dismissed'
  | 'malformed';

/** Why C refuses a relay call. */
export type PeerCloudRefusalReason =
  | 'malformed'
  | 'unsupported-version'
  | 'unauthenticated'
  | 'unknown-tower'
  | 'peer-unsupported'
  | 'too-large'
  | 'rate-limited';

/** Why C could not reach R, or R's answer failed C's checks. */
export type PeerUnavailableReason = 'cloud-error' | 'tower-error' | 'tower-offline' | 'no-answer';

export type PeerAnswerReason =
  | PeerHeldReason
  | PeerReceiverRefusalReason
  | PeerCloudRefusalReason
  | PeerUnavailableReason;

/** One discovery result: an agent the asker's grant covers. */
export interface PeerDiscoveredAddress {
  address: PeerWireAddress;
  /** Whether the agent has a live terminal. */
  live: boolean;
}

/** Fields an answer may carry whatever its outcome. */
interface PeerAnswerBase {
  /** The protocol version of the answer. */
  v: number;
  /** For a person, between Towers of one owner. Only in a 200. */
  detail?: string;
  /** `true` when this answers a second arrival of an accepted message. Only in a 200. */
  duplicate?: boolean;
}

/** One answer shape, from R or from C. Who decided is the status, never the body. */
export type PeerAnswer =
  | (PeerAnswerBase & { outcome: 'delivered' })
  | (PeerAnswerBase & { outcome: 'held'; reason: PeerHeldReason })
  | (PeerAnswerBase & {
      outcome: 'refused';
      reason: PeerReceiverRefusalReason | PeerCloudRefusalReason;
      /** Seconds until the sender may try again; only with `rate-limited`. */
      retryAfterSec?: number;
      /** The versions the answering party speaks; with `unsupported-version`. */
      supported?: number[];
    })
  | (PeerAnswerBase & { outcome: 'not-verified' })
  | (PeerAnswerBase & {
      outcome: 'answered';
      addresses: PeerDiscoveredAddress[];
      /** `true` when R trimmed `addresses` to fit the answer cap. */
      truncated: boolean;
    })
  | (PeerAnswerBase & { outcome: 'unavailable'; reason: PeerUnavailableReason });
