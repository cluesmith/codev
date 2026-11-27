/**
 * Grants (Spec 1967; approved spec Decision 4, "Authorization"): which recipients on this
 * Tower a peer may message, and in which mode. Default deny: with no grant that covers a
 * recipient, the answer is refusal.
 *
 * A grant stores the peer Tower's id, the workspace's key and one of four scopes, so
 * renaming the Tower or the workspace changes nothing:
 *
 * | Scope | Covers | Written |
 * |---|---|---|
 * | `front-door` | the workspace's front door (`main`, else the first registered), resolved when mail arrives | `codev:architect` |
 * | `architect` | one architect, by name; it follows the name | `codev:architect:local` |
 * | `architects` | every architect of the workspace | `--workspace codev` |
 * | `all` | everything on this Tower: every architect and every builder | `--all` |
 *
 * A shell is never a recipient, under any grant.
 *
 * Three things live here, each a pure function of what it is handed:
 *
 * 1. **The matcher.** Given the recipient an arriving message resolved to (contract
 *    section 5, step 13), the grant that admits it, or none (step 14).
 * 2. **What a grant request names.** The checks a grant makes when it is created: the
 *    workspace is registered, a named architect exists, and only an architect, a front door,
 *    a workspace's architects or everything can be named. And how a grant reads back in
 *    `afx peer grants`, including the state of one that matches nothing now.
 * 3. **The peer a tower-ref names**, from the cached peer listing. Phase 7 adds fetching
 *    that listing; until it has been fetched, no tower-ref resolves.
 */

import type { AgentAddress, TowerRef } from '@cluesmith/codev-types';
import { parseAddress, parseTowerRef } from '@cluesmith/codev-sdk/address';
import {
  findWorkspaceByAddressName,
  isSameWorkspace,
  workspaceAddressName,
  type RegisteredWorkspace,
} from '../utils/workspace-address.js';
import type { CachedListing, PeerGrant, PeerGrantKey, PeerGrantMode, PeerTowerName } from './store.js';

// ===========================================================================
// The world a grant is read against
// ===========================================================================

/** What grants are checked against: this Tower's workspaces and architects, as they are now. */
export interface GrantWorld {
  /** Every workspace Tower has registered, with its explicit address name. */
  registered: readonly RegisteredWorkspace[];
  /** The workspaces running now, for the names they answer to. */
  running: readonly string[];
  /** A workspace's registered architects in front-door order: `main`, then by registration. */
  architectsOf(workspacePath: string): readonly string[];
}

/** The architect a workspace's front door reaches now (Decision 4, rule 3), or null if it has none. */
export function frontDoorOf(world: Pick<GrantWorld, 'architectsOf'>, workspacePath: string): string | null {
  return world.architectsOf(workspacePath)[0] ?? null;
}

// ===========================================================================
// 1. The matcher
// ===========================================================================

/** A recipient as an arriving message's address resolved to it on this Tower. */
export interface GrantRecipient {
  workspacePath: string;
  kind: 'architect' | 'builder' | 'shell';
  /** The architect's name, or the builder's or the shell's id. */
  name: string;
}

/**
 * Does `grant` cover `recipient` now? Asked of the world at this moment: the front door is
 * whichever architect it reaches now, and a grant that names architects covers only one
 * registered in its workspace, so a grant for an architect stops matching when it is
 * removed and applies again when the name returns. `all` covers whatever the address
 * resolved to, a shell excepted.
 */
export function grantCovers(
  grant: PeerGrant,
  recipient: GrantRecipient,
  world: Pick<GrantWorld, 'architectsOf'>,
): boolean {
  if (recipient.kind === 'shell') return false;
  if (grant.scope === 'all') return true;
  if (recipient.kind !== 'architect') return false;
  if (grant.workspacePath === null || !isSameWorkspace(grant.workspacePath, recipient.workspacePath)) return false;
  const architects = world.architectsOf(grant.workspacePath);
  if (!architects.includes(recipient.name)) return false;
  switch (grant.scope) {
    case 'architects':
      return true;
    case 'architect':
      return grant.architect === recipient.name;
    case 'front-door':
      return architects[0] === recipient.name;
  }
}

/** The grants that admit a message, and the mode it is given. */
export interface GrantMatch {
  mode: PeerGrantMode;
  grants: PeerGrant[];
}

/**
 * The grants that admit mail from `peerTowerId` to `recipient`, or null: no grant, no
 * delivery. Where several match, the mail is held for release if any of them holds it, so
 * one grant can keep mail out of a prompt that another would let in, and none can let in
 * what another holds.
 */
export function matchGrant(
  grants: readonly PeerGrant[],
  peerTowerId: string,
  recipient: GrantRecipient,
  world: Pick<GrantWorld, 'architectsOf'>,
): GrantMatch | null {
  const covering = grants.filter((g) => g.peerTowerId === peerTowerId && grantCovers(g, recipient, world));
  if (covering.length === 0) return null;
  return { mode: covering.some((g) => g.mode === 'hold') ? 'hold' : 'deliver', grants: covering };
}

// ===========================================================================
// 2. What a grant request names, and how a grant reads back
// ===========================================================================

/** A grant's recipients, without the peer: what a request names. */
export type GrantTarget = Omit<PeerGrantKey, 'peerTowerId'>;

/** A refusal, with the code the route answers and words a person can act on. */
export interface GrantRefusal {
  ok: false;
  code: 'INVALID_PARAMS' | 'NOT_GRANTABLE' | 'NOT_FOUND' | 'AMBIGUOUS';
  message: string;
}

/** The recipients of a request as `afx peer grant` and `afx peer revoke` name them. */
export interface GrantRecipientsInput {
  addresses?: readonly string[];
  workspace?: string;
  all?: boolean;
}

const GRANTABLE =
  'A grant names one architect (codev:architect:<name>), a workspace\'s front door (codev:architect), ' +
  'every architect in a workspace (--workspace codev), or everything on this Tower (--all)';

function refuse(code: GrantRefusal['code'], message: string): GrantRefusal {
  return { ok: false, code, message };
}

const MAX_SHOWN_LENGTH = 64;
/** C0 controls, DEL and C1 controls: the bytes a terminal acts on. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Text that failed to parse, made safe to quote in a refusal: printable ASCII only, and cut
 * short (the rule the shared address parser quotes by). A refusal travels in an HTTP body and
 * is printed on a terminal, and the text is whatever the request carried.
 */
function shown(text: string): string {
  const printable = text.replace(/[^\x20-\x7e]/g, '?');
  return printable.length > MAX_SHOWN_LENGTH ? `${printable.slice(0, MAX_SHOWN_LENGTH)}...` : printable;
}

/** The registered workspace a name refers to. A grant may name a workspace that is not running. */
function lookUpWorkspace(written: string, world: GrantWorld): { ok: true; workspacePath: string } | GrantRefusal {
  // Every registered workspace counts here, running or not: a grant is for a workspace Tower
  // has registered (Decision 4), and it applies whenever that workspace runs.
  const found = findWorkspaceByAddressName(
    written,
    world.registered,
    world.registered.map((w) => w.workspacePath),
  );
  if (!found.ok) return refuse(found.code, found.message);
  return { ok: true, workspacePath: found.workspacePath };
}

/** One address of a request, read as the grant it names. */
function targetOfAddress(
  text: string,
  world: GrantWorld,
  checkArchitect: boolean,
): { ok: true; target: GrantTarget } | GrantRefusal {
  const parsed = parseAddress(text);
  if (!parsed.ok) {
    return refuse('INVALID_PARAMS', `'${shown(text)}' is not an address: ${parsed.error.message}. ${GRANTABLE}.`);
  }
  const address: AgentAddress = parsed.address;
  if (address.tower !== undefined) {
    return refuse(
      'INVALID_PARAMS',
      `'${shown(text)}' leaves this Tower. A grant names recipients on this Tower, written as local addresses (codev:architect:<name>).`,
    );
  }
  if (address.workspace === undefined) {
    return refuse('INVALID_PARAMS', `'${shown(text)}' names no workspace. Write it with the workspace in front: <workspace>:${shown(text)}.`);
  }
  if (address.kind !== 'architect') {
    return refuse(
      'NOT_GRANTABLE',
      `'${shown(text)}' is not an architect. ${GRANTABLE}; builders are covered only by --all.`,
    );
  }
  const workspace = lookUpWorkspace(address.workspace, world);
  if (!workspace.ok) return workspace;
  if (address.name === undefined) {
    return { ok: true, target: { scope: 'front-door', workspacePath: workspace.workspacePath, architect: null } };
  }
  if (checkArchitect && !world.architectsOf(workspace.workspacePath).includes(address.name)) {
    const names = world.architectsOf(workspace.workspacePath);
    return refuse(
      'NOT_FOUND',
      `Architect '${address.name}' is not registered in workspace '${address.workspace}'. ` +
        (names.length === 0 ? 'It has no architect.' : `Architects there: ${names.join(', ')}.`),
    );
  }
  return { ok: true, target: { scope: 'architect', workspacePath: workspace.workspacePath, architect: address.name } };
}

/** Same key? */
function sameTarget(a: GrantTarget, b: GrantTarget): boolean {
  if (a.scope !== b.scope || a.architect !== b.architect) return false;
  if (a.workspacePath === null || b.workspacePath === null) return a.workspacePath === b.workspacePath;
  return isSameWorkspace(a.workspacePath, b.workspacePath);
}

/**
 * The grants a request names: exactly one of addresses, `--workspace` or `--all`.
 *
 * - `grant`: every check a grant makes when it is created. The workspace must be registered
 *   and a named architect must exist (Decision 4); a builder, a shell or an address on
 *   another Tower is refused.
 * - `revoke`: the same reading, without the architect check, so a grant whose architect has
 *   gone can still be removed. With none of the three it returns `null`: every grant for the
 *   peer.
 */
export function resolveGrantTargets(
  input: GrantRecipientsInput,
  world: GrantWorld,
  purpose: 'grant' | 'revoke',
): { ok: true; targets: GrantTarget[] | null } | GrantRefusal {
  const addresses = input.addresses ?? [];
  const forms = [addresses.length > 0, input.workspace !== undefined, input.all === true].filter(Boolean).length;
  if (forms > 1) {
    return refuse('INVALID_PARAMS', 'Name recipients one way: addresses, --workspace <name>, or --all.');
  }
  if (forms === 0) {
    if (purpose === 'revoke') return { ok: true, targets: null };
    return refuse('INVALID_PARAMS', `Name what the Tower may message. ${GRANTABLE}.`);
  }
  if (input.all === true) return { ok: true, targets: [{ scope: 'all', workspacePath: null, architect: null }] };
  // No workspace, architect or id has a control character in its name. Refusing one here
  // keeps every refusal below free of terminal bytes, whatever it quotes from the request.
  for (const text of input.workspace !== undefined ? [input.workspace] : addresses) {
    if (CONTROL_CHARACTER.test(text)) {
      return refuse('INVALID_PARAMS', `'${shown(text)}' contains a control character, which no recipient's name has.`);
    }
  }
  if (input.workspace !== undefined) {
    const workspace = lookUpWorkspace(input.workspace, world);
    if (!workspace.ok) return workspace;
    return { ok: true, targets: [{ scope: 'architects', workspacePath: workspace.workspacePath, architect: null }] };
  }
  const targets: GrantTarget[] = [];
  for (const text of addresses) {
    const read = targetOfAddress(text, world, purpose === 'grant');
    if (!read.ok) return read;
    if (!targets.some((t) => sameTarget(t, read.target))) targets.push(read.target);
  }
  return { ok: true, targets };
}

/** Does `grant` have this key (its peer aside)? */
export function grantHasTarget(grant: PeerGrant, target: GrantTarget): boolean {
  return sameTarget(grant, target);
}

/** How a grant reads back: what it covers, for a person, and whether it covers anyone now. */
export interface GrantDescription {
  /** The name its workspace is addressed by now; null for `all`, or when the workspace has none. */
  workspaceName: string | null;
  /** `codev:architect:local`, `codev:architect`, `every architect in codev`, `everything`. */
  recipient: string;
  /** For a front-door grant, the architect it reaches now. */
  reaches: string | null;
  /** Why it matches nothing now; null when it applies. */
  matchesNothing: string | null;
}

/**
 * Read a grant against this Tower as it is now (Decision 4, "When the recipient is not
 * there"): a grant whose workspace or architect has gone is kept, matches nothing, and says
 * why; it applies again when the same workspace or name returns.
 */
export function describeGrant(grant: PeerGrant, world: GrantWorld): GrantDescription {
  if (grant.scope === 'all') {
    return { workspaceName: null, recipient: 'everything', reaches: null, matchesNothing: null };
  }
  const workspacePath = grant.workspacePath as string;
  // A workspace that is no longer registered has no name that reaches it: it is shown by path.
  const registered = world.registered.some((w) => isSameWorkspace(w.workspacePath, workspacePath));
  const workspaceName = registered ? workspaceAddressName(workspacePath, world.registered, world.running).name : null;
  const label = workspaceName ?? workspacePath;
  const recipient =
    grant.scope === 'front-door'
      ? `${label}:architect`
      : grant.scope === 'architect'
        ? `${label}:architect:${grant.architect as string}`
        : `every architect in ${label}`;

  if (!registered) {
    return { workspaceName, recipient, reaches: null, matchesNothing: `workspace ${label} is no longer registered on this Tower` };
  }
  const architects = world.architectsOf(workspacePath);
  if (grant.scope === 'architect' && !architects.includes(grant.architect as string)) {
    return {
      workspaceName,
      recipient,
      reaches: null,
      matchesNothing: `architect ${grant.architect as string} is not registered in ${label}`,
    };
  }
  if (architects.length === 0) {
    return { workspaceName, recipient, reaches: null, matchesNothing: `${label} has no architect` };
  }
  return { workspaceName, recipient, reaches: grant.scope === 'front-door' ? architects[0] : null, matchesNothing: null };
}

// ===========================================================================
// 3. The peer a tower-ref names
// ===========================================================================

/** This Tower's own identity with Codev Cloud, when it has one. */
export interface OwnTower {
  name: string | null;
  towerId: string | null;
}

/** A peer as a tower-ref resolved to it. */
export interface ResolvedPeer {
  ok: true;
  towerId: string;
  /** The name it is listed under now, or, for a Tower no longer listed, the last one it had. */
  name: string;
}

export interface PeerRefusal {
  ok: false;
  code: 'INVALID_PARAMS' | 'NOT_AVAILABLE' | 'NOT_A_PEER' | 'UNKNOWN_TOWER' | 'AMBIGUOUS';
  message: string;
}

function refusePeer(code: PeerRefusal['code'], message: string): PeerRefusal {
  return { ok: false, code, message };
}

/** When the cached listing was fetched, for a refusal that depends on it. */
function listedWhen(listing: CachedListing): string {
  return listing.refreshedAt === null
    ? 'this Tower has not listed its peers yet'
    : `its peer list was last refreshed ${new Date(listing.refreshedAt).toISOString()}`;
}

/**
 * The name a Tower id is known by: its current slug if it is listed, else the slug it was
 * last seen under, else null.
 */
export function peerNameOf(towerId: string, listing: CachedListing, names: readonly PeerTowerName[]): string | null {
  const listed = listing.towers.find((t) => t.towerId === towerId);
  if (listed) return listed.slug;
  const seen = names.filter((n) => n.towerId === towerId).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  return seen[0]?.slug ?? null;
}

/**
 * The peer a tower-ref names, from the cached listing (Decision 2: grants hold the Tower's
 * id, so a rename changes nothing).
 *
 * - `grant`: the Tower's current name only. A former name is refused naming the current
 *   one, so a grant is never made to a Tower its owner did not mean.
 * - `existing`: a current name, or a name the Tower has had, so a grant to a Tower that has
 *   been renamed or is no longer listed can still be listed and removed.
 *
 * Another owner's Tower (`sam@studio`) is stage 3 and not available; this Tower's own name
 * is not a peer.
 */
export function resolvePeerTower(
  text: string,
  listing: CachedListing,
  names: readonly PeerTowerName[],
  own: OwnTower,
  purpose: 'grant' | 'existing',
): ResolvedPeer | PeerRefusal {
  const parsed = parseTowerRef(text);
  if (!parsed.ok) {
    return refusePeer('INVALID_PARAMS', `'${shown(text)}' is not a Tower name: ${parsed.error.message}. Expected ${parsed.error.expected}.`);
  }
  const ref: TowerRef = parsed.ref;
  if (ref.owner !== undefined) {
    return refusePeer(
      'NOT_AVAILABLE',
      `Towers of other owners (${ref.owner}@${ref.tower}) are not available yet. A grant is for one of your own Towers, named alone, as in '${ref.tower}'.`,
    );
  }
  if (own.name !== null && ref.tower === own.name) {
    return refusePeer('NOT_A_PEER', `'${ref.tower}' is this Tower. A grant lets another of your Towers message this one.`);
  }

  const current = listing.towers.find((t) => t.slug === ref.tower);
  if (current) {
    if (own.towerId !== null && current.towerId === own.towerId) {
      return refusePeer('NOT_A_PEER', `'${ref.tower}' is this Tower. A grant lets another of your Towers message this one.`);
    }
    return { ok: true, towerId: current.towerId, name: current.slug };
  }

  const formerIds = [...new Set(names.filter((n) => n.slug === ref.tower).map((n) => n.towerId))].filter(
    (id) => id !== own.towerId,
  );
  if (formerIds.length > 1) {
    return refusePeer('AMBIGUOUS', `'${ref.tower}' has been the name of ${formerIds.length} Towers; name the one you mean by its current name.`);
  }
  if (formerIds.length === 1) {
    const towerId = formerIds[0];
    const now = listing.towers.find((t) => t.towerId === towerId);
    if (purpose === 'existing') return { ok: true, towerId, name: now?.slug ?? ref.tower };
    return refusePeer(
      'UNKNOWN_TOWER',
      now
        ? `'${ref.tower}' is a former name of the Tower now called '${now.slug}'. Name it '${now.slug}'.`
        : `'${ref.tower}' was the name of a Tower that is no longer in this Tower's peer list.`,
    );
  }
  return refusePeer('UNKNOWN_TOWER', `No Tower named '${ref.tower}' is in this Tower's peer list (${listedWhen(listing)}).`);
}
