/**
 * The sending Tower's peer list (Spec 1967, contract section 3; Departures C13, G4 and G8).
 *
 * - **The cached listing.** Each listing the cloud gives is kept on disk (`peer/store.ts`)
 *   with every name each Tower has had. A send to a name in it resolves while the cloud is
 *   unreachable; a name not in it, after a refresh within the call budget, fails saying when
 *   the list was last refreshed; a Tower's former name fails naming its current one (C13).
 * - **This Tower's own name.** Each listing's `self.slug` is this Tower's current name, so a
 *   rename made in the cloud reaches it without a reconnect (G4). It is kept where
 *   `auth_ok.slug` is kept, the registration's `tower_name`.
 * - **Whether the cloud has a relay.** The TLS rule first (G8): a plain-HTTP cloud that is
 *   not on loopback has none. Then the latest of what the cloud stated (the last `auth_ok`,
 *   the last listing) or, for a cloud that never stated a relay, a `404` without the body.
 *
 * All of it belongs to one registration: the cloud's server URL and this Tower's id. After
 * this Tower registers with another account, Tower id or cloud, the cached listing, its
 * former names and the relay evidence are dropped before anything reads them.
 *
 * A send does not need this Tower's own tunnel: the listing and the relay are HTTPS calls.
 * Everything here is read per call, so a test drives it with a temporary database, the
 * stand-in relay and a hand-made registration.
 */

import type Database from 'better-sqlite3';
import { PEER_PROTOCOLS_SPOKEN, type PeerCloudRelay, type PeerListingTower, type PeerListProblem } from '@cluesmith/codev-types';
import { parseTowerRef } from '@cluesmith/codev-sdk/address';
import type { TunnelRelayStatus } from '../lib/tunnel-client.js';
import { isSecureCloud, type CloudClient, type ListingPurpose } from './cloud-client.js';
import type { CloudRouteFailureReason } from './contract.js';
import { listedWhen } from './grants.js';
import { forgetListingUnlessFor, listTowerNames, readListing, readListingRelay, writeListing, type CachedListing } from './store.js';

/** This Tower's registration with Codev Cloud, as the peer list needs it. */
export interface OwnRegistration {
  serverUrl: string;
  towerId: string;
  /** This Tower's own name, the cloud's slug for it; `null` if it has none yet. */
  towerName: string | null;
  /** The cloud removed this registration (issue #1871). */
  deregistered: boolean;
}

/** The registration a cached listing belongs to: the cloud's server URL and this Tower's id. */
export function listingScope(registration: Pick<OwnRegistration, 'serverUrl' | 'towerId'>): string {
  return `${registration.serverUrl.replace(/\/+$/, '')} ${registration.towerId}`;
}

export interface PeerListDeps {
  db: () => Database.Database;
  now: () => number;
  client: Pick<CloudClient, 'listTowers'>;
  /** This Tower's registration, read on every use; `null` when it has none. */
  registration: () => OwnRegistration | null;
  /** Make `slug` the name of this Tower (`towerId`), as `auth_ok.slug` does. */
  adoptOwnName: (towerId: string, slug: string) => void;
  log: (level: 'INFO' | 'WARN' | 'ERROR', message: string) => void;
}

/** What a refresh came to: the list as it now stands, and why it was not fetched, if it was not. */
export interface PeerListRefresh {
  fresh: boolean;
  problem: PeerListProblem | null;
  retryAfterSec: number | null;
  listing: CachedListing;
}

/** A Tower name a send names, resolved against the peer list. */
export type PeerNameResolution =
  | { ok: true; tower: PeerListingTower; fresh: boolean }
  /** The name is this Tower's own: the address is a local one. */
  | { ok: false; reason: 'self' }
  /** Not in the list. `currentName` is set when the name is a former name of a listed Tower. */
  | { ok: false; reason: 'unknown-tower'; message: string; currentName: string | null };

/** What the cloud last said of its relay, in the order it was said. */
interface RelayStatement {
  seq: number;
  relay: PeerCloudRelay;
}

const AVAILABLE: PeerCloudRelay = { state: 'available', why: null };
const UNKNOWN: PeerCloudRelay = { state: 'unknown', why: null };

function none(why: NonNullable<PeerCloudRelay['why']>): PeerCloudRelay {
  return { state: 'none', why };
}

/** A listing's `relay`: `null` states none; protocols must include one this Tower speaks. */
function relayOfListing(protocols: readonly number[] | null): PeerCloudRelay {
  if (protocols === null) return none('stated-none');
  return protocols.some((v) => PEER_PROTOCOLS_SPOKEN.includes(v)) ? AVAILABLE : none('unsupported');
}

/** An `auth_ok`'s relay, as the tunnel client took it; `null` when it says nothing (the protocol was not stated). */
function relayOfAuthOk(status: TunnelRelayStatus): PeerCloudRelay | null {
  switch (status) {
    case 'available':
      return AVAILABLE;
    case 'null':
      return none('stated-none');
    case 'absent':
      return none('old-cloud');
    case 'unsupported':
      return none('unsupported');
    case 'malformed':
      return none('malformed');
    case 'insecure':
      return none('insecure');
    case 'not-stated':
      return null;
  }
}

/** The peer list problem a failed listing call is. */
function problemOf(reason: CloudRouteFailureReason): PeerListProblem {
  switch (reason) {
    case 'unauthenticated':
    case 'rate-limited':
    case 'bad-listing':
    case 'no-relay':
    case 'cloud-unreachable':
      return reason;
    case 'malformed':
      // C answers `400 malformed` to the switch-state report only; a listing call never earns it.
      throw new Error('peer list: the listing route answered malformed, which it never does');
  }
}

/** Why the list a refusal depends on may be out of date, for its message; empty when it is not. */
function staleBecause(problem: PeerListProblem | null): string {
  switch (problem) {
    case 'cloud-unreachable':
      return '; Codev Cloud is unreachable';
    case 'rate-limited':
      return "; Codev Cloud is limiting this Tower's calls";
    case 'unauthenticated':
      return "; Codev Cloud refused this Tower's key";
    case 'bad-listing':
      return "; Codev Cloud's latest list was not in the expected form";
    case 'registration-changed':
      return "; this Tower's registration changed while its list was fetched";
    case 'no-relay':
      return '; this Codev Cloud has no relay';
    case 'not-connected':
      return '; this Tower is not connected to Codev Cloud';
    case 'not-registered':
      return "; this Tower's registration was removed from Codev Cloud";
    case 'recent':
    case null:
      return '';
  }
}

/** Is `name` written exactly as a Tower name? A caller resolves only a name an address parser took. */
function isTowerName(name: string): boolean {
  const parsed = parseTowerRef(name);
  return parsed.ok && parsed.ref.owner === undefined && parsed.ref.tower === name;
}

export class PeerList {
  /** Statements made in this process count from 1; a listing cached before it started counts as 0. */
  private seq = 0;
  private listingSeq = 0;
  private authOk: (RelayStatement & { status: TunnelRelayStatus }) | null = null;
  private oldCloud: RelayStatement | null = null;
  /** The registration `authOk` and `oldCloud` were noted under. */
  private evidenceScope: string | null = null;

  constructor(private readonly deps: PeerListDeps) {}

  /**
   * This Tower's registration, with the cache and the relay evidence held to it: what was
   * noted or fetched under another registration is dropped first. Without a registration
   * nothing is dropped, since nothing can be sent until there is one.
   */
  private scoped(): OwnRegistration | null {
    const registration = this.deps.registration();
    if (registration === null) return null;
    const scope = listingScope(registration);
    if (this.evidenceScope !== scope) {
      this.authOk = null;
      this.oldCloud = null;
      this.evidenceScope = scope;
    }
    if (forgetListingUnlessFor(this.deps.db(), scope)) {
      this.deps.log('INFO', "Peer: this Tower's Codev Cloud registration changed; the peer list cached for the previous one is dropped");
    }
    return registration;
  }

  /** Hold the cache to this Tower's current registration, before anything reads it directly. */
  scopeToRegistration(): void {
    this.scoped();
  }

  // -------------------------------------------------------------------------
  // Whether the cloud has a relay
  // -------------------------------------------------------------------------

  /** The tunnel's `auth_ok` stated (or did not state) a relay. */
  noteAuthOk(status: TunnelRelayStatus): void {
    this.scoped();
    const relay = relayOfAuthOk(status);
    this.authOk = relay === null ? null : { seq: ++this.seq, relay, status };
  }

  /**
   * A call to one of the cloud's peer routes answered `404` without the body, which, from a
   * cloud that has never stated a relay, means it has none (an old cloud).
   */
  noteNoRelay(): void {
    if (!this.relayStated()) this.oldCloud = { seq: ++this.seq, relay: none('old-cloud') };
  }

  /**
   * Has this cloud stated a relay: did its last `auth_ok` carry a `relay` object, or its
   * last listing a non-null `relay`? It decides what an answer without the body means.
   */
  relayStated(): boolean {
    this.scoped();
    const auth = this.authOk?.status;
    if (auth === 'available' || auth === 'unsupported' || auth === 'insecure') return true;
    const listing = readListingRelay(this.deps.db());
    return listing.refreshedAt !== null && listing.relayProtocols !== null;
  }

  /** Whether the cloud has a relay, as this Tower knows it now. */
  relay(): PeerCloudRelay {
    const registration = this.scoped();
    if (registration !== null && !isSecureCloud(registration.serverUrl)) return none('insecure');
    const statements: RelayStatement[] = [];
    const listing = readListingRelay(this.deps.db());
    if (listing.refreshedAt !== null) statements.push({ seq: this.listingSeq, relay: relayOfListing(listing.relayProtocols) });
    if (this.authOk !== null) statements.push(this.authOk);
    if (this.oldCloud !== null) statements.push(this.oldCloud);
    if (statements.length === 0) return UNKNOWN;
    return statements.reduce((latest, s) => (s.seq > latest.seq ? s : latest)).relay;
  }

  // -------------------------------------------------------------------------
  // The listing
  // -------------------------------------------------------------------------

  /** The list as last fetched. */
  cached(): CachedListing {
    this.scoped();
    return readListing(this.deps.db());
  }

  /**
   * Fetch the listing, within the call budget, and keep it. On any failure the cached list
   * stands and the answer says why. An answer is not used when the registration changed
   * while the call was out, nor a listing whose `self` is not this Tower.
   */
  async refresh(purpose: ListingPurpose = 'on-demand'): Promise<PeerListRefresh> {
    const db = this.deps.db();
    const fromCache = (problem: PeerListProblem, retryAfterSec: number | null = null): PeerListRefresh => ({
      fresh: false,
      problem,
      retryAfterSec,
      listing: readListing(db),
    });
    const registration = this.scoped();
    if (registration === null) return fromCache('not-connected');
    if (registration.deregistered) return fromCache('not-registered');
    const scope = listingScope(registration);

    const call = await this.deps.client.listTowers(purpose);
    // Read again before the answer is read at all: an answer, or a failure, under the
    // registration the call was made with says nothing of one written while it was out.
    const current = this.scoped();
    if (current === null || listingScope(current) !== scope) {
      this.deps.log('INFO', "Peer: this Tower's Codev Cloud registration changed while its peer list was fetched; that answer is not used");
      return fromCache('registration-changed');
    }
    if (!call.called) {
      if (call.reason === 'budget') return fromCache('recent');
      return fromCache(call.reason === 'insecure' ? 'no-relay' : 'not-connected');
    }
    const answer = call.answer;
    if (!answer.ok) {
      if (answer.reason === 'no-relay') this.noteNoRelay();
      if (answer.reason === 'bad-listing') {
        this.deps.log('WARN', `Peer: Codev Cloud's peer list was not in the expected form (${answer.problem}); the cached list stands`);
      }
      return fromCache(problemOf(answer.reason), answer.retryAfterSec);
    }
    const { listing } = answer;
    if (listing.self.towerId !== current.towerId) {
      this.deps.log('WARN', "Peer: Codev Cloud's peer list is for another Tower (its self is not this Tower's id); the cached list stands");
      return fromCache('bad-listing');
    }
    writeListing(
      db,
      { relay: listing.relay, limits: listing.limits, towers: listing.towers, fetchedFor: listingScope(current) },
      this.deps.now(),
    );
    this.listingSeq = ++this.seq;
    if (listing.self.slug !== current.towerName) this.deps.adoptOwnName(listing.self.towerId, listing.self.slug);
    return { fresh: true, problem: null, retryAfterSec: null, listing: readListing(db) };
  }

  // -------------------------------------------------------------------------
  // Resolving a Tower name (C13)
  // -------------------------------------------------------------------------

  /**
   * The Tower a send names. A name in the cached list resolves without a call, so a send
   * resolves while the cloud is unreachable. A name that is not a current name there is
   * looked up again after a refresh (within the call budget), since the Tower may be new or
   * renamed. `name` is a Tower name as the address parser took it.
   */
  async resolve(name: string): Promise<PeerNameResolution> {
    if (!isTowerName(name)) throw new Error('peer list: resolve takes a Tower name the address parser accepted');
    const isSelf = () => this.deps.registration()?.towerName === name;
    if (isSelf()) return { ok: false, reason: 'self' };
    const cachedTower = this.cached().towers.find((t) => t.slug === name);
    if (cachedTower !== undefined) return { ok: true, tower: cachedTower, fresh: false };

    const refresh = await this.refresh('on-demand');
    // The refresh may have taught this Tower its own new name.
    if (isSelf()) return { ok: false, reason: 'self' };
    const listed = refresh.listing.towers.find((t) => t.slug === name);
    if (listed !== undefined) return { ok: true, tower: listed, fresh: refresh.fresh };
    return this.unknown(name, refresh);
  }

  private unknown(name: string, refresh: PeerListRefresh): PeerNameResolution {
    const ownId = this.deps.registration()?.towerId ?? null;
    const formerOf = [
      ...new Set(
        listTowerNames(this.deps.db())
          .filter((n) => n.slug === name && n.towerId !== ownId)
          .map((n) => n.towerId),
      ),
    ];
    const when = `${listedWhen(refresh.listing)}${staleBecause(refresh.problem)}`;
    const unknown = (message: string, currentName: string | null = null): PeerNameResolution => ({
      ok: false,
      reason: 'unknown-tower',
      message,
      currentName,
    });
    if (formerOf.length === 1) {
      const now = refresh.listing.towers.find((t) => t.towerId === formerOf[0]);
      return now === undefined
        ? unknown(`'${name}' was the name of a Tower that is no longer in this Tower's peer list (${when}).`)
        : unknown(`'${name}' is a former name of the Tower now called '${now.slug}'. Name it '${now.slug}'.`, now.slug);
    }
    if (formerOf.length > 1) {
      return unknown(`'${name}' has been the name of ${formerOf.length} Towers, and is none of them now (${when}). Name the one you mean by its current name.`);
    }
    return unknown(`No Tower named '${name}' is in this Tower's peer list (${when}).`);
  }
}
