/**
 * What the local surfaces show of the peer tables (Spec 1967, plan phase 11; Decision 9's inbox,
 * status and record rows): mail waiting on this Tower for a peer, the record of cross-Tower
 * attempts, and the marks on peers. The routes behind `afx inbox`, `afx peer log`,
 * `afx peer list`, `afx status` and the overview's counts read through here, so each is worded
 * and counted once.
 *
 * Nothing here shows a body except {@link outboxMessageBody}, which backs `afx inbox show <id>`:
 * the one local view that legitimately shows a body, as it does for a mailbox row.
 */

import type Database from 'better-sqlite3';
import {
  PEER_MESSAGE_LIFETIME_MS,
  type PeerLogEntry,
  type PeerMarkView,
  type PeerOutboxMessage,
} from '@cluesmith/codev-types';
import { normalizeWorkspacePath } from '../utils/workspace-path.js';
import { readMessagePayload } from './contract.js';
import { peerNameOf } from './grants.js';
import { outboxHoldReason, readPeerMarks, type Outbox, type PeerMark } from './outbox.js';
import {
  getOutboxMany,
  listHeldOutbox,
  listRecords,
  listTowerNames,
  readListing,
  type PeerOutboxRow,
  type PeerRecordRow,
} from './store.js';

/** What a view of the outbox asks of the live queue. */
export type OutboxQueueView = Pick<Outbox, 'inFlightFor'>;

/** A Tower id's name now: its current name, else the name it was last seen under, else `null`. */
export type PeerNamer = (towerId: string) => string | null;

/** Read the cached names once, for a view of many rows. */
export function peerNamer(db: Database.Database): PeerNamer {
  const listing = readListing(db);
  const names = listTowerNames(db);
  return (towerId) => peerNameOf(towerId, listing, names);
}

// ===========================================================================
// Mail waiting for a peer
// ===========================================================================

/**
 * The messages sent from this workspace that wait on this Tower for a peer, oldest first.
 * The sending workspace is stored as the send gave it, so both sides are compared in their
 * canonical form, as the mailbox's own workspace paths are.
 */
export function heldOutboxForWorkspace(db: Database.Database, workspacePath: string): PeerOutboxRow[] {
  const target = normalizeWorkspacePath(workspacePath);
  const canonical = new Map<string, string>();
  return listHeldOutbox(db).filter((row) => {
    let path = canonical.get(row.fromWorkspacePath);
    if (path === undefined) {
      path = normalizeWorkspacePath(row.fromWorkspacePath);
      canonical.set(row.fromWorkspacePath, path);
    }
    return path === target;
  });
}

/** How many messages from this workspace wait on this Tower for a peer (`OverviewData.waitingForPeerCount`). */
export function countWaitingForPeer(db: Database.Database, workspacePath: string): number {
  return heldOutboxForWorkspace(db, workspacePath).length;
}

/** Why a row reads as it does: why a held one waits; for an ended one, a refusal's reason or the state. */
function outboxReason(row: PeerOutboxRow): string {
  if (row.state === 'held') return outboxHoldReason(row);
  if (row.state === 'refused') return row.lastReason ?? 'refused';
  return row.state;
}

/**
 * The message at the head of each peer's queue: the one its queue sends next. Read once for a
 * view of many rows. Every peer's held rows come in acceptance order, as each peer's own do, so
 * the first row seen for a peer is the head of its queue.
 */
export function queueHeads(db: Database.Database): ReadonlySet<string> {
  const heads = new Map<string, string>();
  for (const row of listHeldOutbox(db)) {
    if (!heads.has(row.peerTowerId)) heads.set(row.peerTowerId, row.messageId);
  }
  return new Set(heads.values());
}

/**
 * One message waiting for (or once waiting for) a peer, as `afx inbox` and `afx inbox show`
 * report it. A view of many rows reads the names and the queue heads once and passes them in.
 */
export function outboxMessageView(
  db: Database.Database,
  row: PeerOutboxRow,
  queue: OutboxQueueView,
  nameOf: PeerNamer = peerNamer(db),
  heads: ReadonlySet<string> = queueHeads(db),
): PeerOutboxMessage {
  const next = row.state === 'held' && heads.has(row.messageId);
  return {
    id: row.messageId,
    to: row.toAddress,
    peerTowerId: row.peerTowerId,
    peerName: nameOf(row.peerTowerId),
    fromAgent: row.fromAgent,
    workspacePath: row.fromWorkspacePath,
    sentAt: row.sentAt,
    expiresAt: row.sentAt + PEER_MESSAGE_LIFETIME_MS,
    state: row.state,
    reason: outboxReason(row),
    lastOutcome: row.lastOutcome,
    attempts: row.attempts,
    nextAttemptAt: next ? row.nextAttemptAt : null,
    inFlight: queue.inFlightFor(row.peerTowerId) === row.messageId,
    resolvedAt: row.resolvedAt,
  };
}

/**
 * The body of a message for a peer, as stored and sent. Its payload was written by this
 * Tower's own sender, so one that does not read back means the database is damaged: that
 * throws rather than show something else. Read as at its own send time, so an expired
 * message's body still shows.
 */
export function outboxMessageBody(row: PeerOutboxRow): string {
  const read = readMessagePayload(row.payload, row.sentAt);
  if (!read.ok) throw new Error(`peer surfaces: the stored payload of message ${row.messageId} does not read back (${read.reason})`);
  return read.payload.body;
}

// ===========================================================================
// Marks
// ===========================================================================

export function markView(mark: PeerMark): PeerMarkView {
  return { mark: mark.mark, run: mark.run, since: mark.since, lastAt: mark.lastAt };
}

/** The marks set now, by peer. */
export function marksByPeer(db: Database.Database): Map<string, PeerMarkView[]> {
  const byPeer = new Map<string, PeerMarkView[]>();
  for (const mark of readPeerMarks(db)) {
    const list = byPeer.get(mark.peerTowerId) ?? [];
    list.push(markView(mark));
    byPeer.set(mark.peerTowerId, list);
  }
  return byPeer;
}

// ===========================================================================
// The record
// ===========================================================================

/**
 * Text from the record made safe to print: an inbound row's addresses come from another
 * Tower's payload, which the receiver has validated, and the CLI prints them on a terminal.
 * Control and format characters and line separators become `?` all the same.
 */
function printable(text: string | null): string | null {
  return text === null ? null : text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '?');
}

/** Does this record row name a message this Tower sent, whose own state the log shows beside it? */
function namesSentMessage(record: PeerRecordRow): record is PeerRecordRow & { messageId: string } {
  return record.direction === 'outbound' && record.kind === 'message' && record.messageId !== null;
}

/**
 * One row of the record as `afx peer log` shows it. An outbound message also carries its own
 * state here now, so an answer the outbox did not use (a registration that changed while it
 * was sent) shows beside what the message did. `sent` holds those messages, read once for
 * the whole view.
 */
export function logEntryView(record: PeerRecordRow, nameOf: PeerNamer, sent: ReadonlyMap<string, PeerOutboxRow>): PeerLogEntry {
  let message: PeerLogEntry['message'] = null;
  if (namesSentMessage(record)) {
    const row = sent.get(record.messageId);
    if (row !== undefined) message = { state: row.state, reason: outboxReason(row) };
  }
  const peer = record.peerTowerId === null ? record.peerSlug : (nameOf(record.peerTowerId) ?? record.peerSlug ?? record.peerTowerId);
  return {
    direction: record.direction,
    at: record.at,
    lastAt: record.lastAt,
    count: record.count,
    aggregate: record.aggregate,
    kind: record.kind,
    peer: printable(peer),
    peerTowerId: record.peerTowerId,
    tunnelSession: record.tunnelSession,
    messageId: record.messageId,
    from: printable(record.fromAddress),
    to: printable(record.toAddress),
    payloadSize: record.payloadSize,
    outcome: record.outcome,
    reason: record.reason,
    message,
  };
}

/** The record, newest first, at most `limit` rows, a peer's when `peerTowerId` is given; and whether older rows exist. */
export function readLog(
  db: Database.Database,
  options: { peerTowerId?: string; limit: number },
): { entries: PeerLogEntry[]; truncated: boolean } {
  const records = listRecords(db, { peerTowerId: options.peerTowerId, limit: options.limit + 1 });
  const nameOf = peerNamer(db);
  const shown = records.slice(0, options.limit);
  const sent = getOutboxMany(db, [...new Set(shown.filter(namesSentMessage).map((record) => record.messageId))]);
  return { entries: shown.map((record) => logEntryView(record, nameOf, sent)), truncated: records.length > options.limit };
}
