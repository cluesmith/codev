/**
 * The receiving Tower's record of what reached its entry point (Spec 1967, contract
 * section 8), and the clock surface read from it (gap G12).
 *
 * Two writers feed it:
 *
 * - the entry point's audit hook ({@link recordEntryEvent}), once for every request that
 *   stopped at steps 1 to 8. Before step 2 nothing about the sender is known, so the request
 *   is counted against its tunnel session with the sender unverified; after step 2 it is
 *   counted against the verified sending Tower;
 * - the receiver ({@link recordInbound}), once for every request it was handed.
 *
 * One row per attempt, except floods: requests that are not verified and requests refused as
 * rate limited are counted, one row per sender, outcome, reason and minute.
 *
 * Never a body, a statement, a MAC or a secret: no input here carries one.
 */

import type Database from 'better-sqlite3';
import type { PeerRequestKind } from '@cluesmith/codev-types';
import type { PeerEntryEvent } from '../lib/tunnel-client.js';
import type { ReceiverAnswer } from './contract.js';
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
 * Record one answer the receiver gave. A `rate-limited` refusal is a flood and is counted
 * against the sending Tower; every other answer is its own row.
 */
export function recordInbound(db: Database.Database, facts: InboundFacts, answer: ReceiverAnswer): void {
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
