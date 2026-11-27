/**
 * Discovery at the receiving Tower (Spec 1967, plan phase 10; approved spec Decision 6;
 * contract section 6, "From R, kind `query`"): what runs on this Tower that a peer may
 * message, answered from that peer's grants. The receiver hands a verified query here
 * (contract section 5, steps 1 to 8, are the entry point's).
 *
 * The answer covers exactly what the asker's grants cover, through the matcher a message
 * meets at step 14: one architect, a workspace's architects (the front door's grant lists
 * the architect it reaches now, by name), or under `--all` every workspace's architects by
 * name and builders by id. Never a shell. Each address is also read back through step 13,
 * as a message to it would be, so an address listed is one a message to it gets past both
 * steps: the listing and the receiver cannot drift apart. `live` says whether the agent has
 * a live terminal; mail for one without is accepted and held.
 *
 * The steps, in the order a message meets them where they apply (a query stores nothing,
 * so step 9 does not):
 *
 * 10. The switch: otherwise `remote-off`.
 * 11. The same owner: otherwise `no-grant`.
 * 12. The payload's rules: `malformed`, `clock-skew`, `expired`.
 * 14. The peer holds a grant here: otherwise `no-grant`, and the asking Tower names the
 *     command that adds one (Departures, C8). A peer whose grants cover nothing now is
 *     answered, with no address.
 * 15. At most {@link QUERIES_PER_PEER_PER_MINUTE} answered queries from one peer a minute:
 *     otherwise `rate-limited`, with the seconds left in that minute.
 *
 * The answer is trimmed to the 65 536-byte cap and marked `truncated` by its encoder
 * (`encodeDiscoveryAnswer`).
 */

import type Database from 'better-sqlite3';
import type { PeerDiscoveredAddress, PeerStatement, PeerWireAddress } from '@cluesmith/codev-types';
import { isSameWorkspace } from '../utils/workspace-address.js';
import { isWireAddress, readQueryPayload, type ReceiverAnswer } from './contract.js';
import { matchGrant, type GrantWorld } from './grants.js';
import { listGrants, type PeerGrant } from './store.js';
import { isRemoteMessagingOn } from './switch.js';
import type { RecipientLookup } from './receiver.js';

/** The most discovery queries from one peer this Tower answers in a minute (contract section 7). */
export const QUERIES_PER_PEER_PER_MINUTE = 10;

const MINUTE_MS = 60_000;

/** One agent of a workspace on this Tower that discovery may list. A shell is never one. */
export interface DiscoverySeat {
  kind: 'architect' | 'builder';
  /** An architect's name, or a builder's id. */
  name: string;
  /** Whether it has a live terminal now. */
  live: boolean;
}

/** A workspace on this Tower, with the agents it has now. */
export interface DiscoveryWorkspace {
  workspacePath: string;
  /** The name an address reaches it by; `null` when it has none, and then nothing in it is listed. */
  addressName: string | null;
  /** Its architects in front-door order, then its builders. */
  seats: readonly DiscoverySeat[];
}

/** R's answer to a query it answers. Encoded by `encodeDiscoveryAnswer`, which trims it to the cap. */
export interface DiscoveryAnswer {
  outcome: 'answered';
  addresses: PeerDiscoveredAddress[];
}

/**
 * The answered queries of each peer in the current minute. In memory: a restart starts a
 * fresh minute for every peer, which lets a peer at most one more minute's worth, and the
 * cloud's own per-pair limit stands in front of it. Counted when a query is answered, in
 * the same synchronous step as the check, so two queries at once cannot both take the last
 * place.
 */
export class QueryLimit {
  private readonly windows = new Map<string, { minuteStart: number; answered: number }>();

  constructor(private readonly perMinute: number = QUERIES_PER_PEER_PER_MINUTE) {}

  /** One answer for `peer` now, or the seconds until its next minute starts. */
  take(peer: string, now: number): { ok: true } | { ok: false; retryAfterSec: number } {
    const minuteStart = Math.floor(now / MINUTE_MS) * MINUTE_MS;
    // Only this minute's counts are kept: the map holds at most one entry per peer that asked.
    for (const [key, window] of this.windows) if (window.minuteStart !== minuteStart) this.windows.delete(key);
    const window = this.windows.get(peer) ?? { minuteStart, answered: 0 };
    if (window.answered >= this.perMinute) {
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((minuteStart + MINUTE_MS - now) / 1000)) };
    }
    window.answered++;
    this.windows.set(peer, window);
    return { ok: true };
  }
}

/** The wire address of a seat, `workspace` in front. */
function addressOf(seat: DiscoverySeat, workspace: string): PeerWireAddress {
  return seat.kind === 'architect' ? { workspace, kind: 'architect', name: seat.name } : { workspace, kind: 'id', name: seat.name };
}

/**
 * Every address on this Tower that `grants` let `peerTowerId` message now, in the order of
 * `workspaces` and their seats. An address is listed only if it fits the wire's address
 * rules, a message to it resolves here to that very agent (step 13), and a grant covers that
 * agent (step 14). Hold grants count: mail they cover is accepted and held for release.
 */
export function discoverAddresses(input: {
  grants: readonly PeerGrant[];
  peerTowerId: string;
  workspaces: readonly DiscoveryWorkspace[];
  world: Pick<GrantWorld, 'architectsOf'>;
  resolveRecipient(address: PeerWireAddress): RecipientLookup;
}): PeerDiscoveredAddress[] {
  const found: PeerDiscoveredAddress[] = [];
  const listed = new Set<string>();
  for (const workspace of input.workspaces) {
    if (workspace.addressName === null) continue;
    for (const seat of workspace.seats) {
      const address = addressOf(seat, workspace.addressName);
      if (!isWireAddress(address)) continue;
      const lookup = input.resolveRecipient(address);
      if (!lookup.found) continue;
      const { recipient } = lookup;
      const same =
        isSameWorkspace(recipient.workspacePath, workspace.workspacePath) && recipient.kind === seat.kind && recipient.name === seat.name;
      if (!same || matchGrant(input.grants, input.peerTowerId, recipient, input.world) === null) continue;
      const key = JSON.stringify(address);
      if (listed.has(key)) continue;
      listed.add(key);
      found.push({ address, live: seat.live });
    }
  }
  return found;
}

/** What answering a query reads. */
export interface DiscoveryDeps {
  db(): Database.Database;
  now(): number;
  world(): GrantWorld;
  /** This Tower's workspaces and their agents now. */
  workspaces(): readonly DiscoveryWorkspace[];
  resolveRecipient(address: PeerWireAddress): RecipientLookup;
  limit: QueryLimit;
}

/** A verified query, as the receiver holds it. */
export interface VerifiedQuery {
  statement: PeerStatement;
  payload: Uint8Array;
  receivedAt: number;
}

/** Steps 10 to 15 for a query, then the answer. Synchronous: nothing waits, and nothing is stored. */
export function answerQuery(deps: DiscoveryDeps, request: VerifiedQuery): ReceiverAnswer | DiscoveryAnswer {
  const { statement } = request;
  const db = deps.db();
  const peer = statement.fromTowerId;

  if (!isRemoteMessagingOn(db)) return { outcome: 'refused', reason: 'remote-off' };
  if (!statement.sameOwner) return { outcome: 'refused', reason: 'no-grant' };

  const read = readQueryPayload(request.payload, request.receivedAt);
  if (!read.ok) return { outcome: 'refused', reason: read.reason };

  const grants = listGrants(db, peer);
  if (grants.length === 0) return { outcome: 'refused', reason: 'no-grant' };

  const taken = deps.limit.take(peer, deps.now());
  if (!taken.ok) return { outcome: 'refused', reason: 'rate-limited', retryAfterSec: taken.retryAfterSec };

  return {
    outcome: 'answered',
    addresses: discoverAddresses({
      grants,
      peerTowerId: peer,
      workspaces: deps.workspaces(),
      world: deps.world(),
      resolveRecipient: (address) => deps.resolveRecipient(address),
    }),
  };
}
