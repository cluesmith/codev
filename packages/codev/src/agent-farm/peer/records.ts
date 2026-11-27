/**
 * Each Tower's record of its cross-Tower attempts (Spec 1967, contract section 8), and the
 * clock surface read from it (gap G12).
 *
 * At the receiving Tower, two writers feed it:
 *
 * - the entry point's audit hook ({@link recordEntryEvent}), once for every request that
 *   stopped at steps 1 to 8. Before step 2 nothing about the sender is known, so the request
 *   is counted against its tunnel session with the sender unverified; after step 2 it is
 *   counted against the verified sending Tower;
 * - the receiver ({@link recordInbound}), once for every request it was handed.
 *
 * At the sending Tower, one ({@link recordOutbound}): every relay call it makes, each retry
 * and each discovery query included, and every send or query it refuses before calling.
 *
 * One row per attempt, except floods: requests that are not verified (at the receiver) and
 * attempts refused as rate limited (at either end) are counted, one row per sender, outcome,
 * reason and minute. At the sending Tower the row is counted against the peer.
 *
 * Never a body, a statement, a MAC or a secret: no input here carries one.
 */

import type Database from 'better-sqlite3';
import type { PeerOutcome, PeerRequestKind } from '@cluesmith/codev-types';
import type { PeerEntryEvent } from '../lib/tunnel-client.js';
import type { ReceiverAnswer } from './contract.js';
import type { DiscoveryAnswer } from './discovery.js';
import { countAggregate, insertRecord } from './store.js';

/** What the receiver knows of a request it was handed, at the point it answered. */
export interface InboundFacts {
  at: number;
  kind: PeerRequestKind;
  /** The verified sending Tower, from the statement. */
  peerTowerId: string;
  peerSlug: string;
  messageId: string;
  /** Once the payload has parsed: the sender as the recipient would write it, and the recipient. */
  fromAddress: string | null;
  toAddress: string | null;
  payloadSize: number;
}

/**
 * Record one answer the receiver gave, to a message or a query. A `rate-limited` refusal is
 * a flood and is counted against the sending Tower; every other answer is its own row.
 */
export function recordInbound(db: Database.Database, facts: InboundFacts, answer: ReceiverAnswer | DiscoveryAnswer): void {
  const reason = 'reason' in answer ? answer.reason : null;
  if (answer.outcome === 'refused' && answer.reason === 'rate-limited') {
    countAggregate(db, {
      direction: 'inbound',
      at: facts.at,
      sender: { peerTowerId: facts.peerTowerId },
      outcome: 'refused',
      reason,
    });
    return;
  }
  insertRecord(db, {
    direction: 'inbound',
    at: facts.at,
    kind: facts.kind,
    peerTowerId: facts.peerTowerId,
    peerSlug: facts.peerSlug,
    tunnelSession: null,
    messageId: facts.messageId,
    fromAddress: facts.fromAddress,
    toAddress: facts.toAddress,
    payloadSize: facts.payloadSize,
    outcome: answer.outcome,
    reason,
  });
}

/**
 * Record a request the receiver was handed and could not answer: it failed, the tunnel
 * client reset the stream, and the cloud tells the sender `no-answer`.
 */
export function recordUnanswered(db: Database.Database, facts: InboundFacts): void {
  insertRecord(db, {
    direction: 'inbound',
    at: facts.at,
    kind: facts.kind,
    peerTowerId: facts.peerTowerId,
    peerSlug: facts.peerSlug,
    tunnelSession: null,
    messageId: facts.messageId,
    fromAddress: facts.fromAddress,
    toAddress: facts.toAddress,
    payloadSize: facts.payloadSize,
    outcome: 'unavailable',
    reason: 'no-answer',
  });
}

/**
 * The audit hook's writer: one event for every request at the entry point. A request handed
 * on is recorded by the receiver, which knows its outcome, so it is skipped here.
 *
 * - `not-verified` is a flood: counted against the verified sending Tower once step 2 has
 *   passed and its id fits its rule, else against the tunnel session.
 * - `unsupported-version` (step 3) and `clock-skew` (step 7) came from a genuine relay (the
 *   MAC verified) and are one row each; a `clock-skew` row is what the clock surface reads.
 */
export function recordEntryEvent(db: Database.Database, event: PeerEntryEvent): void {
  switch (event.outcome) {
    case 'handed-on':
      return;
    case 'not-verified':
      countAggregate(db, {
        direction: 'inbound',
        at: event.at,
        sender: event.fromTowerId === null ? { tunnelSession: event.sessionId } : { peerTowerId: event.fromTowerId },
        outcome: 'not-verified',
        reason: null,
      });
      return;
    case 'unsupported-version':
    case 'clock-skew':
      insertRecord(db, {
        direction: 'inbound',
        at: event.at,
        kind: event.kind,
        peerTowerId: event.fromTowerId,
        peerSlug: null,
        tunnelSession: event.fromTowerId === null ? event.sessionId : null,
        messageId: event.requestId,
        fromAddress: null,
        toAddress: null,
        payloadSize: null,
        outcome: 'refused',
        reason: event.outcome,
      });
      return;
  }
}

// ===========================================================================
// The sending Tower's record
// ===========================================================================

/** What the sending Tower knows of one outbound attempt. */
export interface OutboundFacts {
  at: number;
  /** A message, or a discovery query (`afx peer show`). */
  kind: PeerRequestKind;
  /** The recipient Tower, once its name has resolved; `null` for a send refused before that. */
  peerTowerId: string | null;
  /** The recipient Tower as the address names it. */
  peerSlug: string;
  /** Set once the message has been persisted; a query's id once it is made. */
  messageId: string | null;
  /** The sender as this Tower writes it; `null` when it has no address, and for a query. */
  fromAddress: string | null;
  /** The recipient's full address; `null` for a query, which names a Tower only. */
  toAddress: string | null;
  /** The payload's size in bytes, once it has been built. */
  payloadSize: number | null;
}

/**
 * Record one outbound attempt: a relay call and its answer, or a send or a query this Tower
 * refused before calling. An attempt refused as rate limited, by the cloud, by the receiving Tower
 * or by this Tower's own cap on mail waiting for the peer, is a flood and is counted against
 * the peer; every other attempt is its own row.
 */
export function recordOutbound(db: Database.Database, facts: OutboundFacts, outcome: PeerOutcome, reason: string | null): void {
  if (reason === 'rate-limited' && facts.peerTowerId !== null) {
    countAggregate(db, { direction: 'outbound', at: facts.at, sender: { peerTowerId: facts.peerTowerId }, outcome, reason });
    return;
  }
  insertRecord(db, {
    direction: 'outbound',
    at: facts.at,
    kind: facts.kind,
    peerTowerId: facts.peerTowerId,
    peerSlug: facts.peerSlug,
    tunnelSession: null,
    messageId: facts.messageId,
    fromAddress: facts.fromAddress,
    toAddress: facts.toAddress,
    payloadSize: facts.payloadSize,
    outcome,
    reason,
  });
}

// ===========================================================================
// The clock surface (G12)
// ===========================================================================

/** How long one relayed request refused as `clock-skew` keeps the clock surface raised. */
export const CLOCK_SKEW_SURFACE_MS = 10 * 60_000;

/**
 * The clock surface: the last time, within {@link CLOCK_SKEW_SURFACE_MS} of `now`, that this
 * Tower refused a relayed request as `clock-skew` (at step 7, or a payload `sentAt` ahead of
 * its clock), or `null` when none was. Read from the record, which both refusals are written
 * to, so it holds across a restart and has no state of its own. Phases 11 and 12 show it.
 */
export function clockSkewSince(db: Database.Database, now: number): number | null {
  const row = db
    .prepare(
      `SELECT MAX(last_at) AS at FROM peer_records
       WHERE direction = 'inbound' AND outcome = 'refused' AND reason = 'clock-skew' AND last_at >= ?`,
    )
    .get(now - CLOCK_SKEW_SURFACE_MS) as { at: number | null };
  return row.at;
}
