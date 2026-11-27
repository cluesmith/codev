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
 *
 * Also here, `afx peer show` ({@link Sender.show}, plan phase 10): a discovery query, made
 * through the same checks where they apply, as one relay call of its own, and never held.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  PEER_MAX_BODY_BYTES,
  type AgentAddress,
  type PeerCloudRelay,
  type PeerHeldReason,
  type PeerShownAddress,
  type PeerWireAddress,
  type PeerWireSenderAddress,
} from '@cluesmith/codev-types';
import { formatAddress, parseTowerRef, tryFormatAddress } from '@cluesmith/codev-sdk/address';
import { crossWorkspaceBuilderErrorMessage } from '../utils/agent-names.js';
import type { CloudClient } from './cloud-client.js';
import {
  encodeMessagePayload,
  encodeQueryPayload,
  prepareRemoteBody,
  printableDetail,
  type ClassifiedAnswer,
  type SenderCheck,
} from './contract.js';
import { OutboxStoppedError, type FirstAnswer, type Outbox } from './outbox.js';
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
  | {
      outcome: 'delivered';
      messageId: string;
      /** The body's length as stored and sent: UTF-8 bytes, once normalised (check 6). */
      bytes: number;
      peer: PeerNamed;
      detail: string | null;
      duplicate: boolean;
    }
  | {
      outcome: 'held';
      where: 'recipient';
      reason: PeerHeldReason;
      messageId: string;
      bytes: number;
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
      bytes: number;
      peer: PeerNamed;
      /** How many messages for that peer are held ahead of this one. */
      ahead: number;
    };

/**
 * What `afx peer show` came to (Decision 6): the peer's own answer, or a refusal with the
 * reason. A query is never held, so there is no third outcome: an offline peer, an
 * unreachable cloud and an answer that did not verify each refuse it.
 */
export type PeerShowResult =
  | {
      outcome: 'answered';
      peer: PeerNamed;
      /** As this Tower writes them, `afx://<peer>/<address>`, in the order the peer gave them. */
      addresses: PeerShownAddress[];
      truncated: boolean;
    }
  | {
      outcome: 'refused';
      /** Who refused: this Tower (its own checks, or nothing that speaks the contract answered), Codev Cloud, or the peer. */
      by: 'this-tower' | 'cloud' | 'peer';
      reason: string;
      /** For a person: what happened and, where this Tower knows it, what fixes it. */
      message: string;
      retryAfterSec: number | null;
      peer: PeerNamed | null;
    };

export interface SenderDeps {
  db(): Database.Database;
  now(): number;
  /** This Tower's registration, read on every send; `null` when it has none. */
  registration(): OwnRegistration | null;
  list: Pick<PeerList, 'relay' | 'resolve'>;
  outbox: Pick<Outbox, 'enqueue'>;
  /** The relay call a discovery query makes itself: it is not queued behind messages (contract section 4). */
  client: Pick<CloudClient, 'relay'>;
  /** The configured cap on mail waiting here for one peer; throws when it is invalid. */
  limits(): { waitingPerPeer: number };
  /** A message's or a query's id. Default: a random UUID in canonical lower-case form. */
  newMessageId?: () => string;
  log(level: 'INFO' | 'WARN' | 'ERROR', message: string): void;
}

/** A refusal of this Tower's own, before the facts of the record are added. */
interface Refusal {
  reason: SenderRefusalReason;
  message: string;
}

const NOT_CONNECTED_MESSAGE =
  'This Tower has never connected to Codev Cloud, so it cannot send to another Tower. Connect it with: afx tower connect';

const NOT_REGISTERED_MESSAGE =
  "This Tower's registration was removed from Codev Cloud, so it cannot send to another Tower. " +
  'A human registers it again with: afx tower connect --reauth';

/**
 * What the sender is told when its message is stored and held here but the outbox could not
 * take it: the outbox has stopped (Tower is shutting down), or its attempt failed in this
 * Tower. The message is sent once the outbox runs again, so it must not be sent twice.
 */
export function heldOnFaultMessage(messageId: string, peer: string, stopping: boolean): string {
  const fault = stopping ? 'this Tower is stopping' : "a fault in this Tower, named in Tower's log";
  return (
    `Message stored and held on this Tower — mailbox id ${messageId} — but not sent to ${peer} now: ${fault}. ` +
    'It is sent when that clears. Do not send it again. See or dismiss it with: afx inbox'
  );
}

/** A send whose message is stored and held, but which the outbox could not take on. */
export class PeerSendHeldOnFaultError extends Error {
  constructor(
    readonly messageId: string,
    readonly peer: PeerNamed,
    readonly stopping: boolean,
  ) {
    super(heldOnFaultMessage(messageId, peer.name, stopping));
    this.name = 'PeerSendHeldOnFaultError';
  }
}

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
      kind: 'message',
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
    let first: FirstAnswer;
    try {
      first = await this.deps.outbox.enqueue(row);
    } catch (err) {
      // The row is stored and stays held: the outbox sends it once it runs again. Said so, in
      // the one place the message id is known, so the sender does not send it a second time.
      const stopping = err instanceof OutboxStoppedError;
      const kind = stopping ? 'stopped' : err instanceof Error ? err.constructor.name : typeof err;
      this.deps.log('ERROR', `Peer: message ${row.messageId} for ${peer.name} is stored and held; the outbox could not take it (${kind})`);
      throw new PeerSendHeldOnFaultError(row.messageId, peer, stopping);
    }
    const words: RefusalWords = { own: this.deps.registration()?.towerName ?? 'this Tower', peer, recipient: local };
    return this.answered(first, row.messageId, body.bytes, words);
  }

  /**
   * `afx peer show <tower>`: one discovery query, answered by the peer from its grants
   * (Decision 6). The message checks that apply come first, in their order: the name as
   * text (an owner is stage 3; this Tower's own name is not a peer), this Tower's own state
   * (1 to 4), and the name against the peer list (7). Then one relay call of kind `query`,
   * made here and not through the outbox, so it never waits behind messages for that peer.
   * Every answer but `answered` refuses it, with the reason: it is never held. Every query
   * from check 1 on is recorded, as a send is.
   */
  async show(text: string): Promise<PeerShowResult> {
    // 0. The name as text: refusals of stage 1's kind, recorded nowhere.
    const parsed = parseTowerRef(text);
    if (!parsed.ok) {
      return this.showRefused({ reason: 'address', message: `Cannot ask that Tower: ${parsed.error.message}. Expected ${parsed.error.expected}.` });
    }
    const { owner, tower } = parsed.ref;
    if (owner !== undefined) {
      return this.showRefused({
        reason: 'address',
        message: `Another owner's Tower (${owner}@${tower}) is not available in this version. Name one of your own Towers alone, as in: afx peer show ${tower}`,
      });
    }
    const self = (): PeerShowResult =>
      this.showRefused({ reason: 'address', message: `'${tower}' is this Tower. What runs here: afx workspace list` });
    if (this.deps.registration()?.towerName === tower) return self();

    const refuse = (refusal: Refusal, peer: PeerNamed | null = null): PeerShowResult => {
      this.recordQuery(peer?.towerId ?? null, tower, null, 'refused', refusal.reason);
      return this.showRefused(refusal, peer);
    };

    // 1 to 4.
    const state = this.stateRefusal();
    if (state !== null) return refuse(state);

    // 7.
    const resolved = await this.deps.list.resolve(tower);
    if (!resolved.ok) {
      if (resolved.reason === 'self') return self();
      return refuse({ reason: 'unknown-tower', message: resolved.message });
    }
    const peer: PeerNamed = { towerId: resolved.tower.towerId, name: resolved.tower.slug };
    const again = this.stateRefusal();
    if (again !== null) return refuse(again, peer);

    const asked = this.deps.registration();
    const payload = encodeQueryPayload(this.deps.now());
    if (!payload.ok) throw new Error(`sender: the query payload could not be built (${payload.reason})`);
    const queryId = this.newMessageId();
    const call = await this.deps.client.relay({ kind: 'query', toTowerId: peer.towerId, requestId: queryId, payload: payload.bytes });
    if (!call.called) {
      const refusal: Refusal =
        call.reason === 'insecure'
          ? { reason: 'no-relay', message: noRelayMessage({ state: 'none', why: 'insecure' }) }
          : { reason: 'not-connected', message: NOT_CONNECTED_MESSAGE };
      return refuse(refusal, peer);
    }
    const answer = call.answer;
    this.recordQuery(peer.towerId, peer.name, queryId, answer.outcome, answer.reason);

    // An answer under a registration since replaced came through the cloud this Tower has left.
    const current = this.deps.registration();
    if (asked === null || current === null || current.towerId !== asked.towerId || current.serverUrl !== asked.serverUrl) {
      return this.showRefused(
        {
          reason: 'registration-changed',
          message: `This Tower's Codev Cloud registration changed while ${peer.name} was asked. Ask again: afx peer show ${peer.name}`,
        },
        peer,
      );
    }

    if (answer.outcome === 'answered' && answer.answer !== null && answer.answer.outcome === 'answered') {
      // Every address fits the wire's rules; one too long to write with the Tower in front
      // could not be sent to, so it is left out, and the log says so.
      const addresses: PeerShownAddress[] = [];
      let unwritable = 0;
      for (const entry of answer.answer.addresses) {
        const text = tryFormatAddress({ ...(entry.address as AgentAddress), tower: peer.name });
        if (text.ok) addresses.push({ address: text.text, live: entry.live });
        else unwritable++;
      }
      if (unwritable > 0) {
        this.deps.log('WARN', `Peer: ${unwritable} address(es) in ${peer.name}'s answer to query ${queryId} cannot be written with its name in front; left out`);
      }
      return { outcome: 'answered', peer, addresses, truncated: answer.answer.truncated };
    }
    const own = this.deps.registration()?.towerName ?? 'this Tower';
    return queryRefusal(answer, own, peer);
  }

  /** A query this Tower refused: a check of its own, or an answer under a registration since replaced. */
  private showRefused(refusal: { reason: SenderRefusalReason | 'registration-changed'; message: string }, peer: PeerNamed | null = null): PeerShowResult {
    return { outcome: 'refused', by: 'this-tower', reason: refusal.reason, message: refusal.message, retryAfterSec: null, peer };
  }

  /** A query in the record: refused here, or its relay call and the answer. Its failure never changes the answer. */
  private recordQuery(peerTowerId: string | null, peerSlug: string, queryId: string | null, outcome: ClassifiedAnswer['outcome'], reason: string | null): void {
    try {
      recordOutbound(
        this.deps.db(),
        { at: this.deps.now(), kind: 'query', peerTowerId, peerSlug, messageId: queryId, fromAddress: null, toAddress: null, payloadSize: null },
        outcome,
        reason,
      );
    } catch (err) {
      this.deps.log('WARN', `Peer: a query to ${peerSlug} was not recorded (${err instanceof Error ? err.constructor.name : typeof err})`);
    }
  }

  /** Checks 1 to 4: this Tower's own state, read now. */
  private stateRefusal(): Refusal | null {
    const registration = this.deps.registration();
    if (!isRemoteMessagingOn(this.deps.db())) {
      const name = registration?.towerName ? ` (${registration.towerName})` : '';
      return { reason: 'remote-off', message: `Remote messaging is off on this Tower${name}. A human turns it on with: afx peer on` };
    }
    if (registration === null) return { reason: 'not-connected', message: NOT_CONNECTED_MESSAGE };
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
  private answered(first: FirstAnswer, messageId: string, bytes: number, words: RefusalWords): PeerSendResult {
    const { peer } = words;
    switch (first.kind) {
      case 'held':
        return { outcome: 'held', where: 'this-tower', reason: first.reason, messageId, bytes, peer, ahead: first.ahead };
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
        return fromAnswer(first.answer, messageId, bytes, words);
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
function fromAnswer(answer: ClassifiedAnswer, messageId: string, bytes: number, words: RefusalWords): PeerSendResult {
  const { peer } = words;
  const body = answer.answer;
  const detail = body?.detail === undefined ? null : printableDetail(body.detail);
  const duplicate = body?.duplicate === true;
  switch (answer.outcome) {
    case 'delivered':
      return { outcome: 'delivered', messageId, bytes, peer, detail, duplicate };
    case 'held':
      return { outcome: 'held', where: 'recipient', reason: answer.reason as PeerHeldReason, messageId, bytes, peer, detail, duplicate };
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

/**
 * A query's answer other than `answered`, as the refusal `afx peer show` prints (contract
 * section 6, "A discovery query is never held"). Who refused is read from the status, as for
 * a message: the peer (a 200), Codev Cloud (its own answers), or this Tower when nothing that
 * speaks the contract answered.
 */
function queryRefusal(answer: ClassifiedAnswer, own: string, peer: PeerNamed): PeerShowResult {
  const body = answer.answer;
  const retryAfterSec = body !== null && 'retryAfterSec' in body && body.retryAfterSec !== undefined ? body.retryAfterSec : null;
  const by: 'this-tower' | 'cloud' | 'peer' = answer.decidedBy === 'receiver' ? 'peer' : answer.decidedBy === 'cloud' ? 'cloud' : 'this-tower';
  const reason = answer.outcome === 'not-verified' ? 'not-verified' : (answer.reason ?? answer.outcome);
  const refused = (message: string, as: string = reason): PeerShowResult => ({
    outcome: 'refused',
    by,
    reason: as,
    message,
    retryAfterSec,
    peer,
  });
  const never = 'A query is never held: ask again';
  const name = peer.name;

  // A key the cloud rejects refuses as a deregistered registration does (C12).
  if (reason === 'unauthenticated') return refused(NOT_REGISTERED_MESSAGE, 'not-registered');
  if (reason === 'no-relay') return refused(noRelayMessage({ state: 'none', why: 'old-cloud' }));
  if (by === 'peer') {
    switch (reason) {
      case 'remote-off':
        return refused(`Refused by ${name}: remote messaging is off there.`);
      case 'no-grant':
        return refused(`Refused by ${name}: ${own} has no grant there. On ${name}: afx peer grant ${own} <recipients>`);
      case 'rate-limited':
        return refused(`Refused by ${name}: ${own} has asked it too often this minute${retryIn(retryAfterSec)}.`);
      case 'clock-skew':
        return refused(
          `Refused by ${name}: the clocks differ by more than 5 minutes (${name}'s, this Tower's or Codev Cloud's). Check the time on both machines.`,
        );
      case 'unsupported-version':
        return refused(`Refused by ${name}: it does not speak this Tower's version of remote messaging.`);
      case 'malformed':
        return refused(`Refused by ${name}: it could not read the query.`);
      case 'not-verified':
        return refused(`${name} could not verify the query, which happens when a connection to Codev Cloud was just replaced. ${never}.`);
      default:
        return refused(`Refused by ${name}: ${reason}.`);
    }
  }
  switch (reason) {
    case 'tower-offline':
      return refused(`${name} is offline: it has no connection to Codev Cloud now. ${never} when it is online.`);
    case 'cloud-unreachable':
      return refused(`Codev Cloud is unreachable, so ${name} was not asked. ${never} later.`);
    case 'no-answer':
      return refused(`${name} did not answer in time. ${never}.`);
    case 'tower-error':
      return refused(`${name}'s answer did not arrive in the expected form. ${never}.`);
    case 'cloud-error':
      return refused(`Codev Cloud could not relay the query (cloud-error). ${never} later.`);
    case 'unknown-tower':
      return refused(`Refused by Codev Cloud: ${name} is not one of your Towers there.`);
    case 'peer-unsupported':
      return refused(`Refused by Codev Cloud: ${name} does not speak remote messaging. Upgrade Codev on ${name}.`);
    case 'rate-limited':
      return refused(`Refused by Codev Cloud: too many queries from this Tower to ${name}${retryIn(retryAfterSec)}.`);
    case 'malformed':
      return refused("Refused by Codev Cloud: it could not read this Tower's call.");
    case 'unsupported-version':
      return refused("Refused by Codev Cloud: it does not relay this Tower's version of remote messaging.");
    default:
      return refused(`Refused by Codev Cloud: ${reason}.`);
  }
}
