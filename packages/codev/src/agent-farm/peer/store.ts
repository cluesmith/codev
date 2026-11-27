/**
 * Typed access to the Tower-to-Tower messaging tables (Spec 1967; schema in
 * `db/schema.ts` PEER_SCHEMA, migration v21).
 *
 * This is the only file that writes `peer_settings`, `peer_grants`, `peer_towers`,
 * `peer_tower_names`, `peer_outbox`, `peer_accepted` and `peer_records`. Like
 * `db/mailbox.ts`, every function takes an explicit `db` handle and a caller-supplied
 * epoch-ms `now`, and none opens a connection, logs, or holds state.
 *
 * Enumerated values carry no CHECK in SQLite (see PEER_SCHEMA), so this module is their
 * enforcement: a writer refuses a value outside its set, and a reader throws on a stored
 * value it does not recognise rather than passing it on.
 *
 * The one write to `peer_accepted` that is not made here directly is its mirror of a
 * remote mailbox row's state: `db/mailbox.ts` calls {@link insertAccepted} and
 * {@link mirrorAcceptedState} inside the same transaction as the mailbox write, so the
 * two can never disagree.
 */

import type Database from 'better-sqlite3';
import type { ReceiverAnswer } from './contract.js';
import {
  PEER_MESSAGE_LIFETIME_MS,
  type PeerCloudLimits,
  type PeerHeldReason,
  type PeerListedSwitchState,
  type PeerListingTower,
  type PeerOutcome,
  type PeerRequestKind,
  type PeerSwitchState,
} from '@cluesmith/codev-types';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** A Tower keeps its own record, and resolved outbox rows, for at least this long (contract section 8). */
export const PEER_MIN_RETENTION_DAYS = 30;

// ===========================================================================
// Value sets
// ===========================================================================

export const PEER_GRANT_SCOPES = ['front-door', 'architect', 'architects', 'all'] as const;
/**
 * What a grant covers (Decision 4): a workspace's front door (resolved when mail arrives),
 * one architect by name, every architect of a workspace, or everything on this Tower.
 */
export type PeerGrantScope = (typeof PEER_GRANT_SCOPES)[number];

export const PEER_GRANT_MODES = ['deliver', 'hold'] as const;
/** What happens to mail a grant admits: delivered, or held for release by a human. */
export type PeerGrantMode = (typeof PEER_GRANT_MODES)[number];

export const PEER_OUTBOX_STATES = ['held', 'accepted', 'refused', 'dismissed', 'expired'] as const;
/** A sender-side row: still waiting for its peer (`held`), or resolved one of four ways. */
export type PeerOutboxState = (typeof PEER_OUTBOX_STATES)[number];
/** The states that end a sender-side row. */
export type PeerOutboxResolvedState = Exclude<PeerOutboxState, 'held'>;

export const PEER_ACCEPTED_STATES = ['delivered', 'held', 'dismissed'] as const;
/** A message accepted here, as a duplicate of it is told. */
export type PeerAcceptedState = (typeof PEER_ACCEPTED_STATES)[number];

const HELD_REASONS: readonly PeerHeldReason[] = ['busy', 'no-profile', 'no-live-pty', 'held-for-release'];
const OUTCOMES: readonly PeerOutcome[] = ['delivered', 'held', 'refused', 'not-verified', 'answered', 'unavailable'];
const KINDS: readonly PeerRequestKind[] = ['message', 'query'];
const LISTED_SWITCH_STATES: readonly PeerListedSwitchState[] = ['on', 'off', 'unknown'];

export const PEER_RECORD_DIRECTIONS = ['outbound', 'inbound'] as const;
export type PeerRecordDirection = (typeof PEER_RECORD_DIRECTIONS)[number];

/**
 * A reason as the record and the outbox store it. Reasons come from answers (the contract's
 * sets) and from the sending Tower's own checks, so the store holds them to the shape every
 * one of them has, lower-case words joined by hyphens, rather than to one list.
 */
const REASON_TOKEN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`peer store: unrecognised ${what} ${JSON.stringify(value)}`);
}

function reasonToken(value: unknown, what: string): string | null {
  if (value === null) return null;
  if (typeof value === 'string' && REASON_TOKEN.test(value)) return value;
  throw new Error(`peer store: unrecognised ${what} ${JSON.stringify(value)}`);
}

function nonNegativeInt(value: unknown, what: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  throw new Error(`peer store: ${what} must be a non-negative integer, got ${JSON.stringify(value)}`);
}

function epochMs(value: unknown, what: string): number {
  return nonNegativeInt(value, `${what} (epoch ms)`);
}

function nonEmpty(value: unknown, what: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  throw new Error(`peer store: ${what} must be a non-empty string, got ${JSON.stringify(value)}`);
}

function protocolList(value: unknown, what: string): number[] {
  if (Array.isArray(value) && value.every((v) => Number.isSafeInteger(v) && v > 0)) return [...value];
  throw new Error(`peer store: ${what} must be an array of positive integers, got ${JSON.stringify(value)}`);
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`peer store: ${what} is not valid JSON`);
  }
}

function cloudLimits(value: unknown): PeerCloudLimits {
  const v = value as Record<string, unknown> | null;
  const field = (name: keyof PeerCloudLimits): number => {
    const n = v?.[name];
    if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) return n;
    throw new Error(`peer store: listing limit ${name} must be a non-negative integer, got ${JSON.stringify(n)}`);
  };
  if (typeof v !== 'object' || v === null) throw new Error('peer store: listing limits must be an object');
  return {
    messagesPerTowerPerMinute: field('messagesPerTowerPerMinute'),
    messagesPerPairPerMinute: field('messagesPerPairPerMinute'),
    queriesPerPairPerMinute: field('queriesPerPairPerMinute'),
  };
}

// ===========================================================================
// peer_settings: the switch, and the cached listing's own fields
// ===========================================================================

interface DbPeerSettings {
  id: 1;
  remote_messaging: number;
  remote_messaging_changed_at: number | null;
  listing_refreshed_at: number | null;
  listing_relay_protocols: string | null;
  listing_limits: string | null;
  listing_scope: string | null;
}

function readSettingsRow(db: Database.Database): DbPeerSettings | null {
  return (db.prepare('SELECT * FROM peer_settings WHERE id = 1').get() as DbPeerSettings | undefined) ?? null;
}

export interface RemoteMessagingSetting {
  state: PeerSwitchState;
  /** When a human last turned it on or off; `null` if never. */
  changedAt: number | null;
}

/**
 * The receiving Tower's switch. Off unless a human has turned it on: with no settings row
 * (a fresh install, or one just upgraded by migration v21) it reads as off.
 */
export function readRemoteMessaging(db: Database.Database): RemoteMessagingSetting {
  const row = readSettingsRow(db);
  if (!row) return { state: 'off', changedAt: null };
  if (row.remote_messaging !== 0 && row.remote_messaging !== 1) {
    throw new Error(`peer store: unrecognised remote_messaging ${JSON.stringify(row.remote_messaging)}`);
  }
  return { state: row.remote_messaging === 1 ? 'on' : 'off', changedAt: row.remote_messaging_changed_at };
}

/** Turn the switch on or off. Only phase 4's human-only command reaches this. */
export function writeRemoteMessaging(db: Database.Database, state: PeerSwitchState, now: number): void {
  const value = oneOf(state, ['on', 'off'] as const, 'switch state') === 'on' ? 1 : 0;
  db.prepare(
    `INSERT INTO peer_settings (id, remote_messaging, remote_messaging_changed_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET remote_messaging = excluded.remote_messaging,
                                   remote_messaging_changed_at = excluded.remote_messaging_changed_at`,
  ).run(value, epochMs(now, 'now'));
}

// ===========================================================================
// peer_towers, peer_tower_names: the cached listing
// ===========================================================================

/** The listing fields the cache keeps (the caller's own `self` is kept with the Tower's name, #1871). */
export interface ListingToCache {
  relay: { protocols: number[] } | null;
  limits: PeerCloudLimits;
  towers: readonly PeerListingTower[];
  /**
   * The registration the listing was fetched under (`listingScope` in `peer/peer-list.ts`):
   * the cloud's server URL and this Tower's id. A cache for another is not this Tower's.
   */
  fetchedFor: string;
}

export interface CachedListing {
  /** When the cached listing was fetched; `null` if this Tower has never listed its peers. */
  refreshedAt: number | null;
  /** The relay the last listing stated: its protocols, or `null` when it stated none (or never listed). */
  relayProtocols: number[] | null;
  /** The cloud's own limits as the last listing gave them; `null` if never listed. */
  limits: PeerCloudLimits | null;
  towers: PeerListingTower[];
}

interface DbPeerTower {
  tower_id: string;
  slug: string;
  online: number;
  protocols: string;
  remote_messaging: string;
}

function toListingTower(row: DbPeerTower): PeerListingTower {
  return {
    towerId: row.tower_id,
    slug: row.slug,
    online: row.online === 1,
    protocols: protocolList(parseJson(row.protocols, 'peer_towers.protocols'), 'peer_towers.protocols'),
    remoteMessaging: oneOf(row.remote_messaging, LISTED_SWITCH_STATES, 'listed switch state'),
  };
}

/**
 * Replace the cached listing with a newly fetched one, in one transaction: the Tower rows
 * are replaced wholesale, every slug seen is added to (or refreshed in) the former-names
 * table, which is never pruned while the registration stays the same, and the listing's
 * own fields, time and registration are stored. A listing for another registration than
 * the cached one starts the former names afresh.
 */
export function writeListing(db: Database.Database, listing: ListingToCache, now: number): void {
  const at = epochMs(now, 'now');
  const scope = nonEmpty(listing.fetchedFor, 'listing registration');
  const relay = listing.relay === null ? null : JSON.stringify(protocolList(listing.relay.protocols, 'relay protocols'));
  const limits = JSON.stringify(cloudLimits(listing.limits));
  const towers = listing.towers.map((t) => ({
    tower_id: nonEmpty(t.towerId, 'tower id'),
    slug: nonEmpty(t.slug, 'tower slug'),
    online: t.online === true ? 1 : 0,
    protocols: JSON.stringify(protocolList(t.protocols, 'tower protocols')),
    remote_messaging: oneOf(t.remoteMessaging, LISTED_SWITCH_STATES, 'listed switch state'),
  }));
  db.transaction(() => {
    if (readListingScope(db) !== scope) db.prepare('DELETE FROM peer_tower_names').run();
    db.prepare('DELETE FROM peer_towers').run();
    const insertTower = db.prepare(
      'INSERT INTO peer_towers (tower_id, slug, online, protocols, remote_messaging) VALUES (@tower_id, @slug, @online, @protocols, @remote_messaging)',
    );
    const noteName = db.prepare(
      `INSERT INTO peer_tower_names (tower_id, slug, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(tower_id, slug) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    );
    for (const tower of towers) {
      insertTower.run(tower);
      noteName.run(tower.tower_id, tower.slug, at, at);
    }
    db.prepare(
      `INSERT INTO peer_settings (id, listing_refreshed_at, listing_relay_protocols, listing_limits, listing_scope) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET listing_refreshed_at = excluded.listing_refreshed_at,
                                     listing_relay_protocols = excluded.listing_relay_protocols,
                                     listing_limits = excluded.listing_limits,
                                     listing_scope = excluded.listing_scope`,
    ).run(at, relay, limits, scope);
  })();
}

function readListingScope(db: Database.Database): string | null {
  return readSettingsRow(db)?.listing_scope ?? null;
}

/**
 * Drop the cached listing and every former name, in one transaction, unless they were
 * fetched under the registration `scope`: after this Tower registers with another account,
 * Tower id or cloud, the previous registration's Towers are not its peers. Grants are a
 * human's and stay. Returns whether anything was dropped.
 */
export function forgetListingUnlessFor(db: Database.Database, scope: string): boolean {
  nonEmpty(scope, 'listing registration');
  return db.transaction((): boolean => {
    if (readListingScope(db) === scope) return false;
    const towers = db.prepare('DELETE FROM peer_towers').run().changes;
    const names = db.prepare('DELETE FROM peer_tower_names').run().changes;
    const listing = db
      .prepare(
        `UPDATE peer_settings SET listing_refreshed_at = NULL, listing_relay_protocols = NULL, listing_limits = NULL, listing_scope = NULL
         WHERE id = 1 AND (listing_refreshed_at IS NOT NULL OR listing_scope IS NOT NULL)`,
      )
      .run().changes;
    return towers + names + listing > 0;
  })();
}

/** The cached listing's time and stated relay, without its Towers (read on every relay decision). */
export function readListingRelay(db: Database.Database): Pick<CachedListing, 'refreshedAt' | 'relayProtocols'> {
  return listingRelayOf(readSettingsRow(db));
}

function listingRelayOf(settings: DbPeerSettings | null): Pick<CachedListing, 'refreshedAt' | 'relayProtocols'> {
  return {
    refreshedAt: settings?.listing_refreshed_at ?? null,
    relayProtocols:
      settings?.listing_relay_protocols == null
        ? null
        : protocolList(parseJson(settings.listing_relay_protocols, 'listing relay'), 'listing relay'),
  };
}

/** The cached listing, as the last {@link writeListing} left it. */
export function readListing(db: Database.Database): CachedListing {
  const settings = readSettingsRow(db);
  const towers = (db.prepare('SELECT * FROM peer_towers ORDER BY slug, tower_id').all() as DbPeerTower[]).map(toListingTower);
  return {
    ...listingRelayOf(settings),
    limits: settings?.listing_limits == null ? null : cloudLimits(parseJson(settings.listing_limits, 'listing limits')),
    towers,
  };
}

export interface PeerTowerName {
  towerId: string;
  slug: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

/** Every slug a Tower has been listed under, current and former; all Towers when `towerId` is omitted. */
export function listTowerNames(db: Database.Database, towerId?: string): PeerTowerName[] {
  const rows = (
    towerId === undefined
      ? db.prepare('SELECT * FROM peer_tower_names ORDER BY tower_id, first_seen_at, slug').all()
      : db.prepare('SELECT * FROM peer_tower_names WHERE tower_id = ? ORDER BY first_seen_at, slug').all(towerId)
  ) as Array<{ tower_id: string; slug: string; first_seen_at: number; last_seen_at: number }>;
  return rows.map((r) => ({ towerId: r.tower_id, slug: r.slug, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at }));
}

// ===========================================================================
// peer_grants
// ===========================================================================

/** Which grant: the peer, and what it covers. */
export interface PeerGrantKey {
  peerTowerId: string;
  scope: PeerGrantScope;
  /** The workspace key (`normalizeWorkspacePath`); `null` exactly when the scope is `all`. */
  workspacePath: string | null;
  /** The architect's name; set exactly when the scope is `architect`. */
  architect: string | null;
}

export interface PeerGrant extends PeerGrantKey {
  mode: PeerGrantMode;
  createdAt: number;
  updatedAt: number;
}

interface DbPeerGrant {
  peer_tower_id: string;
  workspace_path: string;
  scope: string;
  architect: string;
  mode: string;
  created_at: number;
  updated_at: number;
}

/** The stored form of a key: '' stands for "none" in the two columns the primary key needs non-null. */
function grantKeyColumns(key: PeerGrantKey): { peer_tower_id: string; workspace_path: string; scope: PeerGrantScope; architect: string } {
  const scope = oneOf(key.scope, PEER_GRANT_SCOPES, 'grant scope');
  const peer = nonEmpty(key.peerTowerId, 'grant peer Tower id');
  if ((scope === 'all') !== (key.workspacePath === null)) {
    throw new Error(`peer store: a grant has a workspace exactly when its scope is not 'all' (scope ${scope})`);
  }
  if ((scope === 'architect') !== (key.architect !== null)) {
    throw new Error(`peer store: a grant names an architect exactly when its scope is 'architect' (scope ${scope})`);
  }
  return {
    peer_tower_id: peer,
    workspace_path: key.workspacePath === null ? '' : nonEmpty(key.workspacePath, 'grant workspace'),
    scope,
    architect: key.architect === null ? '' : nonEmpty(key.architect, 'grant architect'),
  };
}

function toGrant(row: DbPeerGrant): PeerGrant {
  const scope = oneOf(row.scope, PEER_GRANT_SCOPES, 'grant scope');
  return {
    peerTowerId: row.peer_tower_id,
    scope,
    workspacePath: scope === 'all' ? null : row.workspace_path,
    architect: scope === 'architect' ? row.architect : null,
    mode: oneOf(row.mode, PEER_GRANT_MODES, 'grant mode'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Add a grant, or change the mode of the one with this key (its creation time is kept).
 * The checks a human's command makes first (the workspace is registered, the architect
 * exists) are phase 4's; this enforces only the key's shape.
 */
export function putGrant(db: Database.Database, grant: PeerGrantKey & { mode: PeerGrantMode }, now: number): PeerGrant {
  const key = grantKeyColumns(grant);
  const mode = oneOf(grant.mode, PEER_GRANT_MODES, 'grant mode');
  const at = epochMs(now, 'now');
  db.prepare(
    `INSERT INTO peer_grants (peer_tower_id, workspace_path, scope, architect, mode, created_at, updated_at)
     VALUES (@peer_tower_id, @workspace_path, @scope, @architect, @mode, @at, @at)
     ON CONFLICT(peer_tower_id, workspace_path, scope, architect) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
  ).run({ ...key, mode, at });
  const row = db
    .prepare('SELECT * FROM peer_grants WHERE peer_tower_id = @peer_tower_id AND workspace_path = @workspace_path AND scope = @scope AND architect = @architect')
    .get(key) as DbPeerGrant;
  return toGrant(row);
}

/** Remove one grant. Returns true if it existed. */
export function removeGrant(db: Database.Database, key: PeerGrantKey): boolean {
  const info = db
    .prepare('DELETE FROM peer_grants WHERE peer_tower_id = @peer_tower_id AND workspace_path = @workspace_path AND scope = @scope AND architect = @architect')
    .run(grantKeyColumns(key));
  return info.changes > 0;
}

/** Every grant, or a peer's, in a stable order. With none, this Tower admits no remote mail. */
export function listGrants(db: Database.Database, peerTowerId?: string): PeerGrant[] {
  const rows = (
    peerTowerId === undefined
      ? db.prepare('SELECT * FROM peer_grants ORDER BY peer_tower_id, workspace_path, scope, architect').all()
      : db.prepare('SELECT * FROM peer_grants WHERE peer_tower_id = ? ORDER BY workspace_path, scope, architect').all(peerTowerId)
  ) as DbPeerGrant[];
  return rows.map(toGrant);
}

// ===========================================================================
// peer_outbox: mail waiting at the sending Tower
// ===========================================================================

export interface PeerOutboxRow {
  /** Acceptance order: the per-peer queue sends a peer's held rows in ascending `seq`. */
  seq: number;
  messageId: string;
  peerTowerId: string;
  toAddress: string;
  /** The exact payload bytes; every retry sends these unchanged. */
  payload: Buffer;
  sentAt: number;
  fromWorkspacePath: string;
  fromAgent: string | null;
  state: PeerOutboxState;
  lastOutcome: PeerOutcome | null;
  lastReason: string | null;
  attempts: number;
  nextAttemptAt: number | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

interface DbPeerOutbox {
  seq: number;
  message_id: string;
  peer_tower_id: string;
  to_address: string;
  payload: Buffer;
  sent_at: number;
  from_workspace_path: string;
  from_agent: string | null;
  state: string;
  last_outcome: string | null;
  last_reason: string | null;
  attempts: number;
  next_attempt_at: number | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
}

function toOutbox(row: DbPeerOutbox): PeerOutboxRow {
  return {
    seq: row.seq,
    messageId: row.message_id,
    peerTowerId: row.peer_tower_id,
    toAddress: row.to_address,
    payload: row.payload,
    sentAt: row.sent_at,
    fromWorkspacePath: row.from_workspace_path,
    fromAgent: row.from_agent,
    state: oneOf(row.state, PEER_OUTBOX_STATES, 'outbox state'),
    lastOutcome: row.last_outcome === null ? null : oneOf(row.last_outcome, OUTCOMES, 'outbox outcome'),
    lastReason: reasonToken(row.last_reason, 'outbox reason'),
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

export interface OutboxInsert {
  messageId: string;
  peerTowerId: string;
  toAddress: string;
  payload: Uint8Array;
  sentAt: number;
  fromWorkspacePath: string;
  fromAgent: string | null;
}

/** Persist a message for a peer as `held`, due at once. Returns the stored row. */
export function insertOutbox(db: Database.Database, input: OutboxInsert, now: number): PeerOutboxRow {
  const at = epochMs(now, 'now');
  if (!(input.payload instanceof Uint8Array) || input.payload.length === 0) {
    throw new Error('peer store: an outbox payload must be non-empty bytes');
  }
  const info = db
    .prepare(
      `INSERT INTO peer_outbox (message_id, peer_tower_id, to_address, payload, sent_at, from_workspace_path, from_agent,
                                state, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'held', 0, ?, ?, ?)`,
    )
    .run(
      nonEmpty(input.messageId, 'message id'),
      nonEmpty(input.peerTowerId, 'peer Tower id'),
      nonEmpty(input.toAddress, 'recipient address'),
      Buffer.from(input.payload),
      epochMs(input.sentAt, 'sentAt'),
      nonEmpty(input.fromWorkspacePath, 'sending workspace'),
      input.fromAgent === null ? null : nonEmpty(input.fromAgent, 'sending agent'),
      at,
      at,
      at,
    );
  return toOutbox(db.prepare('SELECT * FROM peer_outbox WHERE seq = ?').get(info.lastInsertRowid) as DbPeerOutbox);
}

export function getOutbox(db: Database.Database, messageId: string): PeerOutboxRow | null {
  const row = db.prepare('SELECT * FROM peer_outbox WHERE message_id = ?').get(messageId) as DbPeerOutbox | undefined;
  return row ? toOutbox(row) : null;
}

/** Held rows, a peer's or every peer's, in acceptance order. */
export function listHeldOutbox(db: Database.Database, peerTowerId?: string): PeerOutboxRow[] {
  const rows = (
    peerTowerId === undefined
      ? db.prepare("SELECT * FROM peer_outbox WHERE state = 'held' ORDER BY seq").all()
      : db.prepare("SELECT * FROM peer_outbox WHERE peer_tower_id = ? AND state = 'held' ORDER BY seq").all(peerTowerId)
  ) as DbPeerOutbox[];
  return rows.map(toOutbox);
}

/** How many messages wait at this Tower for one peer (the sender's per-peer cap counts these). */
export function countHeldOutbox(db: Database.Database, peerTowerId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM peer_outbox WHERE peer_tower_id = ? AND state = 'held'")
    .get(peerTowerId) as { n: number };
  return row.n;
}

/**
 * Note an attempt that left a row held: its answer, and when to try again. Held rows only.
 * Returns true if a held row was updated.
 */
export function recordOutboxAttempt(
  db: Database.Database,
  messageId: string,
  attempt: { outcome: PeerOutcome; reason: string | null; nextAttemptAt: number },
  now: number,
): boolean {
  const info = db
    .prepare(
      `UPDATE peer_outbox SET attempts = attempts + 1, last_outcome = ?, last_reason = ?, next_attempt_at = ?, updated_at = ?
       WHERE message_id = ? AND state = 'held'`,
    )
    .run(
      oneOf(attempt.outcome, OUTCOMES, 'outbox outcome'),
      reasonToken(attempt.reason, 'outbox reason'),
      epochMs(attempt.nextAttemptAt, 'next attempt time'),
      epochMs(now, 'now'),
      messageId,
    );
  return info.changes > 0;
}

/**
 * End a held row: `accepted` (the peer took it, delivered or held there), `refused`,
 * `dismissed` (by a human, before it was sent) or `expired` (its lifetime ran out).
 * `outcome` and `reason` are the answer that ended it, and replace the last answer's pair
 * (a `null` reason included). When no answer ended it (a dismissal, an expiry), both are
 * `null` and the last answer's pair is kept. Only a held row can be resolved, so a resolved
 * row never changes again. Returns true if it was resolved.
 */
export function resolveOutbox(
  db: Database.Database,
  messageId: string,
  resolution: { state: PeerOutboxResolvedState; outcome: PeerOutcome | null; reason: string | null; attempted: boolean },
  now: number,
): boolean {
  const state = oneOf(resolution.state, PEER_OUTBOX_STATES, 'outbox state');
  if (state === 'held') throw new Error("peer store: resolveOutbox ends a row; 'held' is not a resolution");
  if (resolution.outcome === null && resolution.reason !== null) {
    throw new Error('peer store: a resolution with no answer has no reason either');
  }
  const answered = resolution.outcome === null ? 0 : 1;
  const at = epochMs(now, 'now');
  const info = db
    .prepare(
      `UPDATE peer_outbox SET state = ?, attempts = attempts + ?,
              last_outcome = CASE WHEN ? = 1 THEN ? ELSE last_outcome END,
              last_reason = CASE WHEN ? = 1 THEN ? ELSE last_reason END,
              next_attempt_at = NULL, updated_at = ?, resolved_at = ?
       WHERE message_id = ? AND state = 'held'`,
    )
    .run(
      state,
      resolution.attempted ? 1 : 0,
      answered,
      resolution.outcome === null ? null : oneOf(resolution.outcome, OUTCOMES, 'outbox outcome'),
      answered,
      reasonToken(resolution.reason, 'outbox reason'),
      at,
      at,
      messageId,
    );
  return info.changes > 0;
}

// ===========================================================================
// peer_accepted: accepted once, at the receiving Tower
// ===========================================================================

export interface PeerAcceptedRow {
  peerTowerId: string;
  messageId: string;
  payloadSha256: string;
  mailboxId: string;
  state: PeerAcceptedState;
  /** With `held`, the reason a duplicate is told; otherwise `null`. */
  reason: PeerHeldReason | null;
  /** `sentAt` plus the 30-day lifetime: the row is kept until then, whatever the mailbox retention. */
  expiresAt: number;
  acceptedAt: number;
  updatedAt: number;
}

interface DbPeerAccepted {
  peer_tower_id: string;
  message_id: string;
  payload_sha256: string;
  mailbox_id: string;
  state: string;
  reason: string | null;
  expires_at: number;
  accepted_at: number;
  updated_at: number;
}

function toAccepted(row: DbPeerAccepted): PeerAcceptedRow {
  const { state, reason } = checkedState(row.state, row.reason);
  return {
    peerTowerId: row.peer_tower_id,
    messageId: row.message_id,
    payloadSha256: row.payload_sha256,
    mailboxId: row.mailbox_id,
    state,
    reason,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    updatedAt: row.updated_at,
  };
}

/**
 * A state and reason as a duplicate is told them: a reason with `held` and only with `held`,
 * since a `held` answer always carries one. Checked on every write and every read, so a row
 * that breaks it fails where it is written, not when a duplicate arrives.
 */
function checkedState(state: unknown, reason: unknown): { state: PeerAcceptedState; reason: PeerHeldReason | null } {
  const s = oneOf(state, PEER_ACCEPTED_STATES, 'accepted state');
  const r = reason === null ? null : oneOf(reason, HELD_REASONS, 'accepted reason');
  if (s !== 'held' && r !== null) throw new Error(`peer store: an accepted message that is ${s} has no reason`);
  if (s === 'held' && r === null) throw new Error('peer store: an accepted message that is held needs its reason');
  return { state: s, reason: r };
}

export interface AcceptedInsert {
  peerTowerId: string;
  messageId: string;
  payloadSha256: string;
  mailboxId: string;
  /** The payload's send time; the row expires 30 days after it. */
  sentAt: number;
  state: PeerAcceptedState;
  reason: PeerHeldReason | null;
}

/**
 * Insert the accepted-once row for a message. Called only by `enqueueRemote` in
 * `db/mailbox.ts`, first, inside the transaction that also inserts the mailbox row.
 * Returns false, writing nothing, when a row for this peer and message id already exists:
 * the primary key is what decides a race between two arrivals of one message.
 */
export function insertAccepted(db: Database.Database, row: AcceptedInsert, now: number): boolean {
  const at = epochMs(now, 'now');
  const { state, reason } = checkedState(row.state, row.reason);
  if (!/^[0-9a-f]{64}$/.test(row.payloadSha256)) {
    throw new Error('peer store: payloadSha256 must be 64 lower-case hex digits');
  }
  const info = db
    .prepare(
      `INSERT INTO peer_accepted (peer_tower_id, message_id, payload_sha256, mailbox_id, state, reason, expires_at, accepted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(peer_tower_id, message_id) DO NOTHING`,
    )
    .run(
      nonEmpty(row.peerTowerId, 'peer Tower id'),
      nonEmpty(row.messageId, 'message id'),
      row.payloadSha256,
      nonEmpty(row.mailboxId, 'mailbox id'),
      state,
      reason,
      epochMs(row.sentAt, 'sentAt') + PEER_MESSAGE_LIFETIME_MS,
      at,
      at,
    );
  return info.changes > 0;
}

export function getAccepted(db: Database.Database, peerTowerId: string, messageId: string): PeerAcceptedRow | null {
  const row = db
    .prepare('SELECT * FROM peer_accepted WHERE peer_tower_id = ? AND message_id = ?')
    .get(peerTowerId, messageId) as DbPeerAccepted | undefined;
  return row ? toAccepted(row) : null;
}

/**
 * An accepted message's current state as an answer, from this row alone, so it holds after
 * the mailbox row has been pruned. A dismissed message is refused as `dismissed`. The first
 * arrival is answered with it once its gate attempt is over.
 */
export function currentAnswer(row: PeerAcceptedRow): Extract<ReceiverAnswer, { outcome: 'delivered' | 'held' }> | { outcome: 'refused'; reason: 'dismissed' } {
  switch (row.state) {
    case 'delivered':
      return { outcome: 'delivered' };
    case 'held':
      // checkedState refuses a held row without a reason on write and on read.
      if (row.reason === null) throw new Error(`peer store: accepted message ${row.messageId} is held with no reason`);
      return { outcome: 'held', reason: row.reason };
    case 'dismissed':
      return { outcome: 'refused', reason: 'dismissed' };
  }
}

/**
 * What a second arrival of an accepted message is told (contract section 5, step 9, same
 * payload hash): the first message's {@link currentAnswer}, marked as a duplicate.
 */
export function duplicateAnswer(row: PeerAcceptedRow): ReceiverAnswer {
  return { ...currentAnswer(row), duplicate: true };
}

/** Messages from one peer accepted here and not yet delivered or dismissed (the receiver's per-peer cap). */
export function countUndeliveredAccepted(db: Database.Database, peerTowerId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM peer_accepted WHERE peer_tower_id = ? AND state = 'held'")
    .get(peerTowerId) as { n: number };
  return row.n;
}

/**
 * Mirror a change of remote mailbox rows into their accepted-once rows: one statement over
 * exactly the mailbox ids given, all moving to the same state. Called only by the writers in
 * `db/mailbox.ts`, inside the transaction of the mailbox write, with the ids that write
 * actually changed. A row already in this state and reason is left alone, so a change that a
 * duplicate would not be told about (a gate detail moving under the same reason) rewrites
 * nothing. A mailbox id with no accepted row is skipped: that row expired and was pruned, and
 * a retry of its message is refused as expired. Returns how many accepted rows changed.
 */
export function mirrorAcceptedState(
  db: Database.Database,
  mailboxIds: readonly string[],
  state: PeerAcceptedState,
  reason: PeerHeldReason | null,
  now: number,
): number {
  if (mailboxIds.length === 0) return 0;
  const checked = checkedState(state, reason);
  const info = db
    .prepare(
      `UPDATE peer_accepted SET state = ?, reason = ?, updated_at = ?
       WHERE mailbox_id IN (SELECT value FROM json_each(?)) AND (state IS NOT ? OR reason IS NOT ?)`,
    )
    .run(checked.state, checked.reason, epochMs(now, 'now'), JSON.stringify(mailboxIds), checked.state, checked.reason);
  return info.changes;
}

// ===========================================================================
// peer_records: every cross-Tower attempt, without bodies
// ===========================================================================

/** One attempt, as either end records it. No field carries a body, statement, MAC or secret. */
export interface PeerRecordInput {
  direction: PeerRecordDirection;
  at: number;
  kind: PeerRequestKind | null;
  /** The other Tower: at the sender, the recipient; at the receiver, the verified sender. */
  peerTowerId: string | null;
  peerSlug: string | null;
  /** At the receiver, before the MAC has verified: the tunnel session it arrived on. */
  tunnelSession: string | null;
  messageId: string | null;
  fromAddress: string | null;
  toAddress: string | null;
  payloadSize: number | null;
  outcome: PeerOutcome;
  reason: string | null;
}

/** A flooded attempt, counted rather than stored (Departures, C5). */
export interface PeerAggregateInput {
  direction: PeerRecordDirection;
  at: number;
  /** Who it is counted against: a Tower, or (unverified, at the receiver) a tunnel session. */
  sender: { peerTowerId: string } | { tunnelSession: string };
  outcome: PeerOutcome;
  reason: string | null;
}

export interface PeerRecordRow extends PeerRecordInput {
  id: number;
  /** For an aggregate row, its minute's last attempt (`at` is the first); otherwise equal to `at`. */
  lastAt: number;
  count: number;
  aggregate: boolean;
}

interface DbPeerRecord {
  id: number;
  direction: string;
  first_at: number;
  last_at: number;
  count: number;
  aggregate_key: string | null;
  kind: string | null;
  peer_tower_id: string | null;
  peer_slug: string | null;
  tunnel_session: string | null;
  message_id: string | null;
  from_address: string | null;
  to_address: string | null;
  payload_size: number | null;
  outcome: string;
  reason: string | null;
}

function toRecord(row: DbPeerRecord): PeerRecordRow {
  return {
    id: row.id,
    direction: oneOf(row.direction, PEER_RECORD_DIRECTIONS, 'record direction'),
    at: row.first_at,
    lastAt: row.last_at,
    count: row.count,
    aggregate: row.aggregate_key !== null,
    kind: row.kind === null ? null : oneOf(row.kind, KINDS, 'record kind'),
    peerTowerId: row.peer_tower_id,
    peerSlug: row.peer_slug,
    tunnelSession: row.tunnel_session,
    messageId: row.message_id,
    fromAddress: row.from_address,
    toAddress: row.to_address,
    payloadSize: row.payload_size,
    outcome: oneOf(row.outcome, OUTCOMES, 'record outcome'),
    reason: reasonToken(row.reason, 'record reason'),
  };
}

/** Record one attempt as its own row. */
export function insertRecord(db: Database.Database, record: PeerRecordInput): number {
  const at = epochMs(record.at, 'record time');
  const info = db
    .prepare(
      `INSERT INTO peer_records (direction, first_at, last_at, count, aggregate_key, kind, peer_tower_id, peer_slug, tunnel_session,
                                 message_id, from_address, to_address, payload_size, outcome, reason)
       VALUES (?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      oneOf(record.direction, PEER_RECORD_DIRECTIONS, 'record direction'),
      at,
      at,
      record.kind === null ? null : oneOf(record.kind, KINDS, 'record kind'),
      record.peerTowerId,
      record.peerSlug,
      record.tunnelSession,
      record.messageId,
      record.fromAddress,
      record.toAddress,
      record.payloadSize === null ? null : nonNegativeInt(record.payloadSize, 'payload size'),
      oneOf(record.outcome, OUTCOMES, 'record outcome'),
      reasonToken(record.reason, 'record reason'),
    );
  return Number(info.lastInsertRowid);
}

/**
 * Count one flooded attempt: the row for its direction, sender, outcome, reason and minute
 * gains one, keeping the first and last times; the first attempt of a minute creates it.
 */
export function countAggregate(db: Database.Database, attempt: PeerAggregateInput): void {
  const at = epochMs(attempt.at, 'record time');
  const direction = oneOf(attempt.direction, PEER_RECORD_DIRECTIONS, 'record direction');
  const outcome = oneOf(attempt.outcome, OUTCOMES, 'record outcome');
  const reason = reasonToken(attempt.reason, 'record reason');
  const peerTowerId = 'peerTowerId' in attempt.sender ? nonEmpty(attempt.sender.peerTowerId, 'sender Tower id') : null;
  const tunnelSession = 'tunnelSession' in attempt.sender ? nonEmpty(attempt.sender.tunnelSession, 'tunnel session') : null;
  const minute = Math.floor(at / MINUTE_MS) * MINUTE_MS;
  const key = JSON.stringify([direction, peerTowerId, tunnelSession, outcome, reason, minute]);
  db.prepare(
    `INSERT INTO peer_records (direction, first_at, last_at, count, aggregate_key, peer_tower_id, tunnel_session, outcome, reason)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
     ON CONFLICT(aggregate_key) WHERE aggregate_key IS NOT NULL
     DO UPDATE SET count = count + 1, first_at = MIN(first_at, excluded.first_at), last_at = MAX(last_at, excluded.last_at)`,
  ).run(direction, at, at, key, peerTowerId, tunnelSession, outcome, reason);
}

/** The record, newest first; a peer's when `peerTowerId` is given. */
export function listRecords(db: Database.Database, options: { peerTowerId?: string; limit?: number } = {}): PeerRecordRow[] {
  const limit = options.limit ?? 1000;
  const rows = (
    options.peerTowerId === undefined
      ? db.prepare('SELECT * FROM peer_records ORDER BY last_at DESC, id DESC LIMIT ?').all(limit)
      : db.prepare('SELECT * FROM peer_records WHERE peer_tower_id = ? ORDER BY last_at DESC, id DESC LIMIT ?').all(options.peerTowerId, limit)
  ) as DbPeerRecord[];
  return rows.map(toRecord);
}

// ===========================================================================
// Prune
// ===========================================================================

export interface PeerPruneResult {
  /** The retention actually used: the one asked for, raised to 30 days. */
  retentionDays: number;
  records: number;
  outbox: number;
  accepted: number;
}

/**
 * Remove what the peer tables no longer need to keep. The retention asked for is raised to
 * {@link PEER_MIN_RETENTION_DAYS}, since a Tower keeps its record for at least 30 days.
 * Removes record rows, ordinary and aggregate, last touched before the retention; resolved
 * outbox rows resolved before it; and accepted-once rows past their own expiry, which does
 * not depend on the retention. A held outbox row is never removed.
 */
export function prunePeerStorage(db: Database.Database, retentionDays: number, now: number): PeerPruneResult {
  if (!Number.isFinite(retentionDays)) {
    throw new Error(`peer store: retention must be a number of days, got ${JSON.stringify(retentionDays)}`);
  }
  const days = Math.max(PEER_MIN_RETENTION_DAYS, retentionDays);
  const at = epochMs(now, 'now');
  const cutoff = at - days * DAY_MS;
  return db.transaction(() => ({
    retentionDays: days,
    records: db.prepare('DELETE FROM peer_records WHERE last_at < ?').run(cutoff).changes,
    outbox: db
      .prepare("DELETE FROM peer_outbox WHERE state != 'held' AND resolved_at IS NOT NULL AND resolved_at < ?")
      .run(cutoff).changes,
    accepted: db.prepare('DELETE FROM peer_accepted WHERE expires_at < ?').run(at).changes,
  }))();
}
