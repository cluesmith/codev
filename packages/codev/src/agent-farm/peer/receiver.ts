/**
 * The receiving Tower's half of a relayed request (Spec 1967, contract section 5, steps 9 to
 * 16): what it does with a request the entry point verified (steps 1 to 8, in
 * `lib/tunnel-client.ts`). From there the statement is used up, whatever the outcome.
 *
 *  9. Accepted once: a second arrival is told the first message's current state.
 * 10. The switch.   11. The same owner.   12. The payload's rules.
 * 13. The recipient. 14. A grant (hold wins).   15. This Tower's limits.
 * 16. Persist, then one gate attempt as a local send makes, answered within the deadline.
 *
 * The deadline is the contract's: R answers within 5 seconds of receiving the body and never
 * makes C wait past it. An attempt that has not finished by then is answered with the
 * message's state at that moment (`held`, `busy` while it waits or writes) and runs on.
 *
 * Mailbox first (Spec 1313): the message is stored, with its accepted-once row, in one
 * transaction before any wait, so a missed deadline answers `held` and never loses mail. It
 * never writes a terminal: delivery is the mailbox's, through the render gate under the
 * per-agent then per-terminal locks. A body is never logged or recorded.
 *
 * Also here: whether held remote mail may still be delivered, asked at the delivery instant
 * and when the switch or a grant changes ({@link remoteMailAllowed}, {@link withdrawRemoteMail}).
 */

import type Database from 'better-sqlite3';
import type { AgentAddress, PeerStatement, PeerWireAddress, PeerWireSenderAddress } from '@cluesmith/codev-types';
import { formatAddress, tryFormatAddress } from '@cluesmith/codev-sdk/address';
import type { PeerRequestHandler, VerifiedPeerRequest } from '../lib/tunnel-client.js';
import { enqueueRemote, holdForRelease, listHeldRemote } from '../db/mailbox.js';
import type { DbMailbox } from '../db/types.js';
import { formatRemoteMessage, normalizeRemoteFrameBody, remoteReplyRoute, type RemoteOrigin } from '../utils/message-format.js';
import { encodeReceiverAnswer, readMessagePayload, type EncodedAnswer, type ReceiverAnswer } from './contract.js';
import { matchGrant, type GrantRecipient, type GrantWorld } from './grants.js';
import { recordInbound, recordUnanswered, type InboundFacts } from './records.js';
import { countUndeliveredAccepted, currentAnswer, duplicateAnswer, getAccepted, listGrants, type PeerAcceptedRow } from './store.js';
import { isRemoteMessagingOn } from './switch.js';

/** Where an arriving message's address points on this Tower (step 13). */
export type RecipientLookup =
  | { found: true; recipient: GrantRecipient }
  /** `no-such-agent`: nothing answers to it; `not-addressable`: a shell, which is never a recipient. */
  | { found: false; reason: 'no-such-agent' | 'not-addressable' };

/** This Tower's limits on mail from one peer (contract section 7; `peer.limits` in the config). */
export interface ReceiverLimits {
  acceptedPerPeerPerMinute: number;
  undeliveredPerPeer: number;
}

export type ReceiverLogLevel = 'INFO' | 'WARN' | 'ERROR';

/** What the receiver reads and calls; the live Tower's in `servers/tower-tunnel.ts`. */
export interface ReceiverDeps {
  db(): Database.Database;
  now(): number;
  world(): GrantWorld;
  /** Throws when the configured limits are invalid, which fails the request rather than guessing. */
  limits(): ReceiverLimits;
  resolveRecipient(address: PeerWireAddress): RecipientLookup;
  /**
   * One gate attempt for the agent, as a local send makes, if its turn on the per-agent
   * serializer comes within `ms`. Not started: the row stays held for the backstop.
   */
  deliverWithin(workspacePath: string, toAgent: string, ms: number): Promise<{ started: boolean }>;
  /** A held row appeared: refresh what shows held mail. */
  onHeldChanged(): void;
  log(level: ReceiverLogLevel, message: string): void;
}

const MINUTE_MS = 60_000;

/** The receiver as the entry point's handler. */
export function createReceiver(deps: ReceiverDeps): PeerRequestHandler {
  return (request) => receive(deps, request);
}

/** What the record and the log may say of a request: never its body. */
interface Known {
  facts: InboundFacts;
  /** For the log: the sending Tower and the message id, which are not secret. */
  label: string;
}

async function receive(deps: ReceiverDeps, request: VerifiedPeerRequest): Promise<EncodedAnswer> {
  const { statement } = request;
  const known: Known = {
    facts: {
      at: request.receivedAt,
      kind: statement.kind,
      peerTowerId: statement.fromTowerId,
      peerSlug: statement.fromTowerSlug,
      messageId: statement.requestId,
      fromAddress: null,
      toAddress: null,
      payloadSize: request.payload.length,
    },
    label: `${statement.kind} ${statement.requestId} from ${statement.fromTowerSlug}`,
  };
  let answer: ReceiverAnswer;
  try {
    answer = await decide(deps, request, known);
  } catch (err) {
    // The tunnel client resets the stream, and the cloud tells the sender `no-answer`; the
    // sender holds the message and retries, and step 9 answers the retry if it was stored.
    deps.log('ERROR', `Peer: ${known.label} failed (${errorKind(err)}); not answered`);
    guarded(deps, known, () => recordUnanswered(deps.db(), known.facts));
    throw err;
  }
  guarded(deps, known, () => recordInbound(deps.db(), known.facts, answer));
  deps.log('INFO', `Peer: ${known.label}${known.facts.toAddress ? ` → ${known.facts.toAddress}` : ''}: ${describe(answer)}`);
  return encodeReceiverAnswer(answer);
}

/** Steps 9 to 16. Everything up to the persist is synchronous, so two arrivals never interleave there. */
async function decide(deps: ReceiverDeps, request: VerifiedPeerRequest, known: Known): Promise<ReceiverAnswer> {
  const { statement } = request;
  const db = deps.db();
  const peer = statement.fromTowerId;

  // Discovery is plan phase 10's, which replaces this branch; no build ships without it.
  if (statement.kind === 'query') return { outcome: 'refused', reason: 'no-grant' };

  // 9. Accepted once. A row past its 30-day lifetime is one the prune has yet to remove: a
  // message that old is refused as expired at step 12, whether or not the prune has run.
  const accepted = getAccepted(db, peer, statement.requestId);
  if (accepted !== null && accepted.expiresAt > request.receivedAt) return answerForArrival(accepted, statement);

  // 10, 11.
  if (!isRemoteMessagingOn(db)) return { outcome: 'refused', reason: 'remote-off' };
  if (!statement.sameOwner) return { outcome: 'refused', reason: 'no-grant' };

  // 12. A `sentAt` ahead of this clock is recorded as `clock-skew`, which the clock surface reads.
  const read = readMessagePayload(request.payload, request.receivedAt);
  if (!read.ok) return { outcome: 'refused', reason: read.reason };
  const payload = read.payload;
  known.facts.fromAddress = remoteAddressText(statement.fromTowerSlug, payload.from);
  known.facts.toAddress = formatAddress(payload.to as AgentAddress);

  // 13, 14.
  const lookup = deps.resolveRecipient(payload.to);
  if (!lookup.found) return { outcome: 'refused', reason: lookup.reason };
  const { recipient } = lookup;
  const match = matchGrant(listGrants(db, peer), peer, recipient, deps.world());
  if (match === null) return { outcome: 'refused', reason: 'no-grant' };

  // 15.
  const limits = deps.limits();
  const now = deps.now();
  const minuteStart = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  if (acceptedSince(db, peer, minuteStart) >= limits.acceptedPerPeerPerMinute) {
    return { outcome: 'refused', reason: 'rate-limited', retryAfterSec: Math.max(1, Math.ceil((minuteStart + MINUTE_MS - now) / 1000)) };
  }
  if (countUndeliveredAccepted(db, peer) >= limits.undeliveredPerPeer) {
    return { outcome: 'refused', reason: 'rate-limited' };
  }

  // 16. Persist: the accepted-once row first, then the mailbox row, in one transaction.
  const body = normalizeRemoteFrameBody(payload.body);
  const origin: RemoteOrigin = { towerSlug: statement.fromTowerSlug, sender: payload.from };
  const releaseHold = match.mode === 'hold';
  const stored = enqueueRemote(
    db,
    {
      workspacePath: recipient.workspacePath,
      toAgent: recipient.name,
      body,
      formattedMessage: formatRemoteMessage(origin, recipient.name, remoteReplyRoute(origin, recipient.kind === 'architect'), body),
      reason: null,
      releaseHold,
      remote: {
        sender: { towerId: peer, towerSlug: statement.fromTowerSlug, address: payload.from },
        messageId: statement.requestId,
        ownerEmail: statement.fromOwnerEmail,
        payloadSha256: statement.payloadSha256,
        sentAt: payload.sentAt,
      },
    },
    now,
  );
  // Another arrival of this message committed between step 9 and here.
  if (!stored.accepted) return answerForArrival(stored.existing, statement);
  deps.onHeldChanged();
  if (releaseHold) return { outcome: 'held', reason: 'held-for-release' };

  // One gate attempt, if the agent's turn comes within what is left of the deadline. The
  // answer is that attempt's outcome if it finishes by the deadline. If not (it is still
  // writing, or its turn never came), the answer is the message's state at the deadline and the
  // attempt runs on. One that fails leaves the row held, as a local send's does.
  const msLeft = Math.max(0, request.answerBy - deps.now());
  const attempt = deps.deliverWithin(recipient.workspacePath, recipient.name, msLeft).then(
    (outcome) => {
      if (!outcome.started) deps.log('INFO', `Peer: ${known.label}: the agent was busy past the deadline; held for the backstop`);
    },
    (err: unknown) => {
      deps.log('ERROR', `Peer: ${known.label}: the delivery attempt failed (${errorKind(err)}); the message stays held`);
    },
  );
  if (!(await settlesWithin(attempt, msLeft))) {
    deps.log('INFO', `Peer: ${known.label}: the delivery was still running at the deadline; answered with its state then`);
  }
  const current = getAccepted(db, peer, statement.requestId);
  if (current === null) throw new Error('receiver: an accepted message has no accepted-once row');
  return currentAnswer(current);
}

/** A second arrival (step 9): its current state, or `mismatch` for a different payload. */
function answerForArrival(accepted: PeerAcceptedRow, statement: PeerStatement): ReceiverAnswer {
  if (accepted.payloadSha256 !== statement.payloadSha256) return { outcome: 'refused', reason: 'mismatch' };
  return duplicateAnswer(accepted);
}

/** Messages from `peer` accepted here since `since` (the per-minute limit's count). */
function acceptedSince(db: Database.Database, peer: string, since: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM peer_accepted WHERE peer_tower_id = ? AND accepted_at >= ?')
    .get(peer, since) as { n: number };
  return row.n;
}

/** The sender as the recipient writes it, `afx://<tower>/<address>`, or null when it has none. */
function remoteAddressText(towerSlug: string, sender: PeerWireSenderAddress | null): string | null {
  if (sender === null || sender.workspace === undefined) return null;
  const formatted = tryFormatAddress({ ...(sender as AgentAddress), tower: towerSlug });
  return formatted.ok ? formatted.text : null;
}

function describe(answer: ReceiverAnswer): string {
  const parts: string[] = [answer.outcome];
  if ('reason' in answer) parts.push(answer.reason);
  if ('duplicate' in answer && answer.duplicate) parts.push('duplicate');
  return parts.join(', ');
}

/** A record write never changes the answer: its failure is logged by class. */
function guarded(deps: ReceiverDeps, known: Known, write: () => void): void {
  try {
    write();
  } catch (err) {
    deps.log('WARN', `Peer: ${known.label} not recorded (${errorKind(err)})`);
  }
}

/** Whether `work` settles within `ms`: false at the deadline, with `work` left running. */
async function settlesWithin(work: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true as const), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** An error as a log line may name it: its class only, since a message could quote a value. */
function errorKind(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err;
}

// ===========================================================================
// Permission over held remote mail
// ===========================================================================

/**
 * May this remote row be delivered now? Yes if its owner released it: what the owner does with
 * a message already in the mailbox is their own decision, which the switch and the grants do
 * not take back (spec 1940, Withdrawal). Otherwise only while the switch is on and a grant for
 * its sending Tower covers its recipient in `deliver` mode: hold wins, so a covering hold grant
 * makes the answer no. The recipient's kind is read from the world: a name among the
 * workspace's architects is an architect; anything else is a builder, which only an `all`
 * grant covers, and that is also the answer for an architect since removed.
 */
export function remoteMailAllowed(
  db: Database.Database,
  world: GrantWorld,
  mail: Pick<DbMailbox, 'workspace_path' | 'to_agent' | 'remote_tower_id' | 'released_at'>,
): boolean {
  if (mail.remote_tower_id === null) throw new Error('receiver: a local row has no remote permission to check');
  if (mail.released_at !== null) return true;
  if (!isRemoteMessagingOn(db)) return false;
  const recipient: GrantRecipient = {
    workspacePath: mail.workspace_path,
    kind: world.architectsOf(mail.workspace_path).includes(mail.to_agent) ? 'architect' : 'builder',
    name: mail.to_agent,
  };
  const match = matchGrant(listGrants(db, mail.remote_tower_id), mail.remote_tower_id, recipient, world);
  return match !== null && match.mode === 'deliver';
}

/**
 * Withdrawal (eager, by the owner's ruling): move every held remote row that may no longer
 * be delivered to held for release, one peer's when `peerTowerId` is given. Called in the
 * transaction that turns the switch off or changes a grant. Turning the switch on again
 * releases nothing: a human releases mail held for release. A row the owner released is never
 * moved back ({@link remoteMailAllowed}). Returns how many rows moved.
 */
export function withdrawRemoteMail(db: Database.Database, world: GrantWorld, now: number, peerTowerId?: string): number {
  let moved = 0;
  for (const row of listHeldRemote(db, peerTowerId)) {
    if (!remoteMailAllowed(db, world, row) && holdForRelease(db, row.id, now)) moved++;
  }
  return moved;
}
