/**
 * The sending Tower's checks, and the send itself (Spec 1967, plan phase 8; contract section
 * 4, "What S checks before it calls, in this order"; Departures C12, C13, G14). The first
 * check that applies is the answer, and no call is made:
 *
 * 0. As text: an address naming an owner is not available yet (stage 3), and one naming this
 *    Tower's own name is a local address, to which none of what follows applies. (Text that
 *    is not an address never reaches here: the send route reads every address once, with
 *    the one shared parser, and refuses it as stage 1 does.)
 * 1. `remote-off`: remote messaging is off on this Tower.
 * 2. `not-connected`: this Tower has never connected to Codev Cloud.
 * 3. `not-registered`: its registration is marked deregistered (`deregistered_at`, #1871).
 * 4. `no-relay`: the cloud has no relay, as the peer list knows it (the TLS rule first).
 * 5. `option-not-allowed`: `--raw`, `--interrupt`, `--no-enter` or `--delay`.
 * 6. `too-large`: a body over 48 KiB once normalised (a body that is not valid text is
 *    refused here too, as `malformed`).
 * 7. `unknown-tower`: a name not in the peer list, or the cached one (C13).
 * 8. `builder-rule`: a builder naming an architect on another Tower, which is never its own.
 * 9. `rate-limited`: 50 messages already wait here for that peer.
 *
 * Then the message is persisted, with the exact payload bytes every retry sends, and queued
 * for its peer ({@link Outbox.enqueue}). The send is told its first answer, or at once that
 * it is held here when held mail for that peer is ahead of it.
 *
 * Resolving the name (7) may wait for the listing. Checks 1 to 4 are therefore read again
 * after it, and check 9 is counted in the same synchronous step as the insert, so two sends
 * at once cannot both take the last place. A key the cloud rejects with `401` refuses the
 * send as `not-registered`, as check 3 does (C12).
 *
 * Every refusal from check 1 on, and every relay call, is recorded (`records.ts`); check 0's
 * refusals are stage 1's and record nothing. No body is ever logged or recorded.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  PEER_MAX_BODY_BYTES,
  type AgentAddress,
  type PeerCloudRelay,
  type PeerHeldReason,
  type PeerWireAddress,
  type PeerWireSenderAddress,
} from '@cluesmith/codev-types';
import { formatAddress, tryFormatAddress } from '@cluesmith/codev-sdk/address';
import { crossWorkspaceBuilderErrorMessage } from '../utils/agent-names.js';
import { encodeMessagePayload, prepareRemoteBody, printableDetail, type ClassifiedAnswer, type SenderCheck } from './contract.js';
import type { FirstAnswer, Outbox } from './outbox.js';
import type { OwnRegistration, PeerList } from './peer-list.js';
import { recordOutbound, type OutboundFacts } from './records.js';
import { countHeldOutbox, insertOutbox } from './store.js';
import { isRemoteMessagingOn } from './switch.js';

/** The options a local send may carry; each is refused for a recipient on another Tower (C7). */
export interface PeerSendOptions {
  raw: boolean;
  interrupt: boolean;
  noEnter: boolean;
  delay: boolean;
}

const OPTION_FLAGS: ReadonlyArray<[keyof PeerSendOptions, string]> = [
  ['raw', '--raw'],
  ['interrupt', '--interrupt'],
  ['noEnter', '--no-enter'],
  ['delay', '--delay'],
];

/** Who sends, as the send route knows it on this Tower. */
export interface PeerSender {
  /** The sending workspace (the outbox row's, for the held counts). */
  workspacePath: string;
  /** The sender's local id; `null` when it has no agent identity. */
  agent: string | null;
  /**
   * The sender as the payload states it: `workspace` absent when the sending workspace has
   * no address name, and `null` when the sender has no agent identity (G7).
   */
  address: PeerWireSenderAddress | null;
  /** Whether the sender is a builder, which the builder rule asks. */
  isBuilder: boolean;
}

export interface PeerSendRequest {
  /** The recipient, parsed once by the send route; it names a Tower. */
  to: AgentAddress;
  body: string;
  options: PeerSendOptions;
  from: PeerSender;
}

/** The recipient Tower, as it resolved. */
export interface PeerNamed {
  towerId: string;
  /** Its current name. */
  name: string;
}

/**
 * Why this Tower refused a send before any call: the check that applied, named as the
 * contract's order names it, or `malformed` for a body that is not valid text (check 6).
 */
export type SenderRefusalReason = SenderCheck | 'malformed';

/** What a send came to: delivered, held with where and why, or refused with the reason (Decision 5). */
export type PeerSendResult =
  /** The address names this Tower: the route resolves it as a local address. */
  | { outcome: 'local'; address: AgentAddress }
  | {
      outcome: 'refused';
      /** Who refused: this Tower's own checks, Codev Cloud, or the receiving Tower. */
      by: 'this-tower' | 'cloud' | 'peer';
      reason: string;
      /** For a person: what happened and, where this Tower knows it, what fixes it. */
      message: string;
      /** The receiving Tower's own words, made printable. */
      detail: string | null;
      retryAfterSec: number | null;
      /** Set when the message had been persisted before it was refused. */
      messageId: string | null;
      peer: PeerNamed | null;
    }
  | { outcome: 'delivered'; messageId: string; peer: PeerNamed; detail: string | null; duplicate: boolean }
  | {
      outcome: 'held';
      where: 'recipient';
      reason: PeerHeldReason;
      messageId: string;
      peer: PeerNamed;
      detail: string | null;
      duplicate: boolean;
    }
  | {
      outcome: 'held';
      where: 'this-tower';
      /** Why the queue for that peer holds. */
      reason: string;
      messageId: string;
      peer: PeerNamed;
      /** How many messages for that peer are held ahead of this one. */
      ahead: number;
    };

export interface SenderDeps {
  db(): Database.Database;
  now(): number;
  /** This Tower's registration, read on every send; `null` when it has none. */
  registration(): OwnRegistration | null;
  list: Pick<PeerList, 'relay' | 'resolve'>;
  outbox: Pick<Outbox, 'enqueue'>;
  /** The configured cap on mail waiting here for one peer; throws when it is invalid. */
  limits(): { waitingPerPeer: number };
  /** Default: a random UUID in canonical lower-case form. */
  newMessageId?: () => string;
  log(level: 'INFO' | 'WARN' | 'ERROR', message: string): void;
}

/** A refusal of this Tower's own, before the facts of the record are added. */
interface Refusal {
  reason: SenderRefusalReason;
  message: string;
}

const NOT_REGISTERED_MESSAGE =
  "This Tower's registration was removed from Codev Cloud, so it cannot send to another Tower. " +
  'A human registers it again with: afx tower connect --reauth';

function noRelayMessage(relay: PeerCloudRelay): string {
  return relay.why === 'insecure'
    ? "This Tower's Codev Cloud is plain HTTP, not HTTPS, so it has no relay: a message cannot reach another Tower through it."
    : 'This Codev Cloud has no relay: a message cannot reach another Tower through it.';
}

/** The sender's address as this Tower writes it, for the record and the row; `null` when it has none. */
function senderText(address: PeerWireSenderAddress | null): string | null {
  if (address === null) return null;
  const formatted = tryFormatAddress(address as AgentAddress);
  return formatted.ok ? formatted.text : null;
}

export class Sender {
  private readonly newMessageId: () => string;

  constructor(private readonly deps: SenderDeps) {
    this.newMessageId = deps.newMessageId ?? randomUUID;
  }

  async send(request: PeerSendRequest): Promise<PeerSendResult> {
    const { to } = request;
    if (to.tower === undefined) throw new Error('sender: a send to another Tower names its Tower');
    const { owner, tower, ...local } = to;

    // 0. The address as text.
    if (owner !== undefined) {
      return this.refused({
        reason: 'address',
        message:
          "Messaging another owner's Tower is not available in this version. " +
          'Between your own Towers, write afx://<tower>/<workspace>:<agent>.',
      });
    }
    if (this.deps.registration()?.towerName === tower) return { outcome: 'local', address: local };

    const toText = formatAddress(to);
    const fromText = senderText(request.from.address);
    const facts = (peerTowerId: string | null): OutboundFacts => ({
      at: this.deps.now(),
      peerTowerId,
      peerSlug: tower,
      messageId: null,
      fromAddress: fromText,
      toAddress: toText,
      payloadSize: null,
    });
    const refuse = (refusal: Refusal, peer: PeerNamed | null = null): PeerSendResult => {
      this.record(facts(peer?.towerId ?? null), refusal.reason);
      return this.refused(refusal, peer);
    };

    // 1 to 4. This Tower's own state.
    const state = this.stateRefusal();
    if (state !== null) return refuse(state);

    // 5. Options a remote recipient never honours.
    const flags = OPTION_FLAGS.filter(([option]) => request.options[option]).map(([, flag]) => flag);
    if (flags.length > 0) {
      return refuse({ reason: 'option-not-allowed', message: `${flags.join(', ')} cannot be used for a recipient on another Tower.` });
    }

    // 6. The body.
    const body = prepareRemoteBody(request.body);
    if (!body.ok) {
      return refuse(
        body.reason === 'too-large'
          ? { reason: 'too-large', message: `A message to another Tower is at most ${PEER_MAX_BODY_BYTES} bytes as UTF-8; this one is longer.` }
          : { reason: 'malformed', message: 'The message is not valid text: it contains an unpaired surrogate.' },
      );
    }

    // 7. The Tower's name, against the peer list (C13).
    const resolved = await this.deps.list.resolve(tower);
    if (!resolved.ok) {
      if (resolved.reason === 'self') return { outcome: 'local', address: local };
      return refuse({ reason: 'unknown-tower', message: resolved.message });
    }
    const peer: PeerNamed = { towerId: resolved.tower.towerId, name: resolved.tower.slug };

    // From here to the insert nothing waits: 1 to 4 again, 8, 9 and the insert are one step.
    const again = this.stateRefusal();
    if (again !== null) return refuse(again, peer);

    // 8. The builder rule: an architect on another Tower is never a builder's own.
    if (request.from.isBuilder && local.kind === 'architect' && local.name !== undefined) {
      if (request.from.agent === null) throw new Error('sender: a builder sends with its id');
      const frontDoor = formatAddress({ tower, workspace: local.workspace, kind: 'architect' });
      return refuse({ reason: 'builder-rule', message: crossWorkspaceBuilderErrorMessage(request.from.agent, frontDoor) }, peer);
    }

    // 9. The cap on mail waiting here for the peer.
    const db = this.deps.db();
    const cap = this.deps.limits().waitingPerPeer;
    const waiting = countHeldOutbox(db, peer.towerId);
    if (waiting >= cap) {
      return refuse(
        {
          reason: 'rate-limited',
          message: `${waiting} messages already wait on this Tower for ${peer.name}, the most it holds for one Tower. See them with: afx inbox`,
        },
        peer,
      );
    }

    const now = this.deps.now();
    const payload = encodeMessagePayload({
      sentAt: now,
      to: local as PeerWireAddress,
      from: request.from.address,
      body: body.body,
    });
    // The address came from the parser and the body passed check 6: only a sender address
    // that does not fit the payload's rules can fail here, which is the route's error.
    if (!payload.ok) throw new Error(`sender: the payload could not be built (${payload.reason})`);
    const row = insertOutbox(
      db,
      {
        messageId: this.newMessageId(),
        peerTowerId: peer.towerId,
        toAddress: toText,
        fromAddress: fromText,
        payload: payload.bytes,
        sentAt: now,
        fromWorkspacePath: request.from.workspacePath,
        fromAgent: request.from.agent,
      },
      now,
    );
    const first = await this.deps.outbox.enqueue(row);
    const words: RefusalWords = { own: this.deps.registration()?.towerName ?? 'this Tower', peer, recipient: local };
    return this.answered(first, row.messageId, words);
  }

  /** Checks 1 to 4: this Tower's own state, read now. */
  private stateRefusal(): Refusal | null {
    const registration = this.deps.registration();
    if (!isRemoteMessagingOn(this.deps.db())) {
      const name = registration?.towerName ? ` (${registration.towerName})` : '';
      return { reason: 'remote-off', message: `Remote messaging is off on this Tower${name}. A human turns it on with: afx peer on` };
    }
    if (registration === null) {
      return {
        reason: 'not-connected',
        message: 'This Tower has never connected to Codev Cloud, so it cannot send to another Tower. Connect it with: afx tower connect',
      };
    }
    if (registration.deregistered) return { reason: 'not-registered', message: NOT_REGISTERED_MESSAGE };
    const relay = this.deps.list.relay();
    if (relay.state === 'none') return { reason: 'no-relay', message: noRelayMessage(relay) };
    return null;
  }

  private refused(refusal: Refusal, peer: PeerNamed | null = null): PeerSendResult {
    return {
      outcome: 'refused',
      by: 'this-tower',
      reason: refusal.reason,
      message: refusal.message,
      detail: null,
      retryAfterSec: null,
      messageId: null,
      peer,
    };
  }

  /** A refusal before any call, in the record. Its failure never changes the answer. */
  private record(facts: OutboundFacts, reason: SenderRefusalReason): void {
    try {
      recordOutbound(this.deps.db(), facts, 'refused', reason);
    } catch (err) {
      this.deps.log('WARN', `Peer: a refused send to ${facts.peerSlug} was not recorded (${err instanceof Error ? err.constructor.name : typeof err})`);
    }
  }

  /** The first answer, as the sender is told it. */
  private answered(first: FirstAnswer, messageId: string, words: RefusalWords): PeerSendResult {
    const { peer } = words;
    switch (first.kind) {
      case 'held':
        return { outcome: 'held', where: 'this-tower', reason: first.reason, messageId, peer, ahead: first.ahead };
      case 'ended':
        return {
          outcome: 'refused',
          by: 'this-tower',
          reason: first.state,
          message: 'The message expired on this Tower before it could be sent.',
          detail: null,
          retryAfterSec: null,
          messageId,
          peer,
        };
      case 'resolved':
        return fromAnswer(first.answer, messageId, words);
    }
  }
}

/** What a refusal by Codev Cloud or the receiving Tower names, in words for a person. */
interface RefusalWords {
  /** This Tower's name, as its peers know it; "this Tower" while it has none. */
  own: string;
  peer: PeerNamed;
  /** The recipient, as the receiving Tower writes it locally. */
  recipient: AgentAddress;
}

function retryIn(retryAfterSec: number | null): string {
  return retryAfterSec === null ? '' : `; try again in ${retryAfterSec} s`;
}

/**
 * The receiving Tower's refusal, for a person (the stage 2 walkthrough's skipped-step
 * table). Full reasons are shown because both Towers are the owner's (Decision 5). A
 * grant cannot name a builder, so a builder is reached only under `--all`.
 */
function peerRefusalMessage(reason: string, retryAfterSec: number | null, words: RefusalWords): string {
  const { own, recipient } = words;
  const peer = words.peer.name;
  const to = formatAddress(recipient);
  const why = ((): string => {
    switch (reason) {
      case 'remote-off':
        return 'remote messaging is off there.';
      case 'no-grant': {
        const target = recipient.kind === 'architect' ? to : '--all';
        return `${own} has no grant there for ${to}. On ${peer}: afx peer grant ${own} ${target}`;
      }
      case 'no-such-agent':
        return `it has no agent ${to}.`;
      case 'not-addressable':
        return `${to} cannot be messaged from another Tower (a shell never can).`;
      case 'rate-limited':
        return retryAfterSec === null
          ? `too many messages from ${own} wait there undelivered.`
          : `${own} has sent it too many messages this minute${retryIn(retryAfterSec)}.`;
      case 'too-large':
        return 'the message is too large.';
      case 'expired':
        return 'the message was sent more than 30 days ago.';
      case 'clock-skew':
        return `the clocks differ by more than 5 minutes (${peer}'s, this Tower's or Codev Cloud's). Check the time on both machines.`;
      case 'unsupported-version':
        return "it does not speak this Tower's version of remote messaging.";
      case 'mismatch':
        return 'it holds a different message under the same id.';
      case 'dismissed':
        return 'the message was dismissed there.';
      case 'malformed':
        return 'it could not read the message.';
      default:
        return `${reason}.`;
    }
  })();
  return `Refused by ${peer}: ${why}`;
}

/** Codev Cloud's refusal, for a person (contract section 6, the answers from C). */
function cloudRefusalMessage(reason: string, retryAfterSec: number | null, words: RefusalWords): string {
  const peer = words.peer.name;
  const why = ((): string => {
    switch (reason) {
      case 'unknown-tower':
        return `${peer} is not one of your Towers there.`;
      case 'peer-unsupported':
        return `${peer} does not speak remote messaging. Upgrade Codev on ${peer}.`;
      case 'rate-limited':
        return `too many messages from this Tower${retryIn(retryAfterSec)}.`;
      case 'too-large':
        return 'the message is too large.';
      case 'malformed':
        return "it could not read this Tower's call.";
      case 'unsupported-version':
        return "it does not relay this Tower's version of remote messaging.";
      default:
        return `${reason}.`;
    }
  })();
  return `Refused by Codev Cloud: ${why}`;
}

/** An answer that resolved the row, as the sender is told it. */
function fromAnswer(answer: ClassifiedAnswer, messageId: string, words: RefusalWords): PeerSendResult {
  const { peer } = words;
  const body = answer.answer;
  const detail = body?.detail === undefined ? null : printableDetail(body.detail);
  const duplicate = body?.duplicate === true;
  switch (answer.outcome) {
    case 'delivered':
      return { outcome: 'delivered', messageId, peer, detail, duplicate };
    case 'held':
      return { outcome: 'held', where: 'recipient', reason: answer.reason as PeerHeldReason, messageId, peer, detail, duplicate };
    case 'refused': {
      const by = answer.decidedBy === 'receiver' ? 'peer' : 'cloud';
      const retryAfterSec = body !== null && 'retryAfterSec' in body && body.retryAfterSec !== undefined ? body.retryAfterSec : null;
      // A key the cloud rejects refuses as a deregistered registration does (C12).
      if (answer.reason === 'unauthenticated') {
        return { outcome: 'refused', by, reason: 'not-registered', message: NOT_REGISTERED_MESSAGE, detail, retryAfterSec, messageId, peer };
      }
      const reason = answer.reason ?? 'refused';
      const message =
        reason === 'no-relay'
          ? noRelayMessage({ state: 'none', why: 'old-cloud' })
          : by === 'peer'
            ? peerRefusalMessage(reason, retryAfterSec, words)
            : cloudRefusalMessage(reason, retryAfterSec, words);
      return { outcome: 'refused', by, reason, message, detail, retryAfterSec, messageId, peer };
    }
    case 'not-verified':
    case 'unavailable':
    case 'answered':
      throw new Error(`sender: an answer of ${answer.outcome} does not resolve a message`);
  }
}
