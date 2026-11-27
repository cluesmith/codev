/**
 * `afx peer on|off|list|grants|grant|revoke|limits` (Spec 1967; approved spec Decision 9).
 *
 * The receiving Tower's own decisions about who may message whom, and the list of my other
 * Towers. Tower holds the switch, the grants and the peer list and makes every check; these
 * commands only ask it, and print what it answered.
 *
 * Two of them widen trust and are a human's: `afx peer on` and `afx peer grant` take
 * `--a-human-explicitly-approved-this`, the flag `porch approve` takes. Without it they
 * refuse before asking Tower, and Tower refuses again if asked. `off` and `revoke` only
 * narrow access and take no flag.
 *
 * Each command throws on a refusal, with the message to print; the CLI wrapper prints it
 * and exits non-zero.
 */

import type {
  PeerCloudRelay,
  PeerGrantChange,
  PeerGrantModeName,
  PeerGrantView,
  PeerListedTowerView,
  PeerSwitchReport,
  PeerSwitchResponse,
  PeerTowersResponse,
} from '@cluesmith/codev-types';
import type { PeerRouteResult, TowerClient as SdkTowerClient } from '@cluesmith/codev-sdk/tower-client';
import { getTowerClient } from '../lib/tower-client.js';
import { logger } from '../utils/logger.js';
import { olderTowerError } from '../utils/older-tower.js';
import { HUMAN_APPROVAL_FLAG } from '../peer/switch.js';

/** The Tower calls these commands make. */
export type PeerClient = Pick<
  SdkTowerClient,
  'getPeerSwitch' | 'setPeerSwitch' | 'getPeerGrants' | 'addPeerGrants' | 'revokePeerGrants' | 'getPeerLimits' | 'getPeerTowers'
>;

/** Where the commands print. */
export interface PeerOutput {
  success(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  line(text: string): void;
}

export interface PeerDeps {
  client: PeerClient;
  out: PeerOutput;
}

export interface PeerPortOption {
  port?: number;
}

function defaultDeps(options: PeerPortOption): PeerDeps {
  return {
    client: getTowerClient(options.port),
    out: {
      success: (m) => logger.success(m),
      info: (m) => logger.info(m),
      warn: (m) => logger.warn(m),
      line: (t) => console.log(t),
    },
  };
}

/** The answer, or the refusal as a thrown Error with words a person can act on. */
function answerOf<T>(outcome: PeerRouteResult<T>, lacks: string): T {
  if (outcome.ok) return outcome.result;
  if (outcome.notRunning) throw new Error('Tower is not running. Start it with: afx tower start');
  if (outcome.unknownRoute) throw new Error(olderTowerError(lacks));
  throw new Error(outcome.error);
}

/** How this Tower is named in what the commands print. */
function thisTower(towerName: string | null): string {
  return towerName ?? 'this Tower';
}

const GRANT_HINT = 'afx peer grant <tower> <recipients>';

function modeText(mode: PeerGrantModeName): string {
  return mode === 'hold' ? 'hold for release' : 'deliver';
}

/** A time as the commands print it. */
function at(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

// ===========================================================================
// afx peer on / off
// ===========================================================================

/**
 * What the commands add when a switch change could not be told to Codev Cloud now. The
 * usual case, a report under way, and the cases with nothing to tell, print nothing.
 */
function reportNote(report: PeerSwitchReport | null): string | null {
  switch (report) {
    case 'tunnel-down':
      return "This Tower's tunnel is down: Codev Cloud learns of the change when it reconnects.";
    case 'failed':
      return 'Codev Cloud could not be told of the change now (see the Tower log); it learns of it when the tunnel next connects.';
    case 'reporting':
    case 'not-connected':
    case 'no-relay':
    case null:
      return null;
  }
}

export interface PeerOnOptions extends PeerPortOption {
  humanApproved?: boolean;
}

export async function peerOn(options: PeerOnOptions, deps: PeerDeps = defaultDeps(options)): Promise<void> {
  if (options.humanApproved !== true) {
    throw new Error(`Turning remote messaging on is a human's decision. A human runs: afx peer on ${HUMAN_APPROVAL_FLAG}`);
  }
  const answer: PeerSwitchResponse = answerOf(
    await deps.client.setPeerSwitch({ state: 'on', humanApproved: true }),
    'has no remote-messaging switch',
  );
  const name = thisTower(answer.towerName);
  const grants =
    answer.grantCount === 0
      ? 'No Tower may message it yet. Allow one with: afx peer grant <tower> …'
      : `${answer.grantCount === 1 ? 'One grant applies' : `${answer.grantCount} grants apply`}: afx peer grants`;
  deps.out.success(
    answer.changed ? `Remote messaging is on for ${name}. ${grants}` : `Remote messaging was already on for ${name}. ${grants}`,
  );
  const note = reportNote(answer.cloudReport);
  if (note !== null) deps.out.info(note);
}

export async function peerOff(options: PeerPortOption, deps: PeerDeps = defaultDeps(options)): Promise<void> {
  const answer = answerOf(await deps.client.setPeerSwitch({ state: 'off' }), 'has no remote-messaging switch');
  const name = thisTower(answer.towerName);
  if (!answer.changed) {
    deps.out.success(`Remote messaging was already off for ${name}.`);
    return;
  }
  deps.out.success(`Remote messaging is off for ${name}. It sends nothing to other Towers and accepts nothing from them.`);
  const note = reportNote(answer.cloudReport);
  if (note !== null) deps.out.info(note);
}

// ===========================================================================
// afx peer list
// ===========================================================================

/** What one Tower may message here, as the list prints it: its grants, or nothing. */
function mayMessageText(tower: PeerListedTowerView): string {
  if (tower.mayMessage.length === 0) return 'nothing';
  return tower.mayMessage.map((g) => `${g.recipient} (${modeText(g.mode)})`).join(', ');
}

/** One line per Tower, in aligned columns: name, owner, the online hint, what it may message here. */
export function towerLines(towers: readonly PeerListedTowerView[]): string[] {
  const rows = towers.map((t) => [t.name, 'you', t.online ? 'online' : 'offline', `may message this Tower: ${mayMessageText(t)}`]);
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => (i < 3 ? c.padEnd(widths[i]) : c)).join('  '));
}

function relayNote(relay: PeerCloudRelay): string | null {
  if (relay.state !== 'none') return null;
  switch (relay.why) {
    case 'insecure':
      return "This Codev Cloud has no relay here: its server URL is plain http: on a host that is not this machine, so no peer call is made. Connect over https: with: afx tower connect --service <https://…>";
    case 'unsupported':
      return "This Codev Cloud's relay speaks no protocol version this Tower speaks: remote messaging is unavailable.";
    case 'malformed':
      return "This Codev Cloud's relay was not in the expected form: remote messaging is unavailable.";
    case 'stated-none':
    case 'old-cloud':
    case null:
      return 'This Codev Cloud has no relay: remote messaging is unavailable.';
  }
}

/** Why the list shown is not a fresh one, and what to do; `null` when it is fresh or recent enough. */
function listingNote(answer: PeerTowersResponse): string | null {
  const { problem, refreshedAt, retryAfterSec } = answer.listing;
  const from = refreshedAt === null ? 'and this Tower has not listed its peers yet' : `this is the list from ${at(refreshedAt)}`;
  const lastList = refreshedAt === null ? '' : `; the Towers above are from its last list, at ${at(refreshedAt)}`;
  switch (problem) {
    case 'not-connected':
      return `This Tower is not connected to Codev Cloud${lastList}. Connect it with: afx tower connect`;
    case 'not-registered':
      return `This Tower's registration was removed from Codev Cloud${lastList}. Register it again with: afx tower connect --reauth`;
    case 'registration-changed':
      return "This Tower's Codev Cloud registration changed while its peer list was fetched. List again: afx peer list";
    case 'unauthenticated':
      return `Codev Cloud refused this Tower's key; ${from}. Run: afx tower connect --reauth`;
    case 'cloud-unreachable':
      return `Codev Cloud is unreachable; ${from}.`;
    case 'rate-limited':
      return `Codev Cloud is limiting this Tower's calls; ${from}.${retryAfterSec === null ? '' : ` Try again in ${retryAfterSec} s.`}`;
    case 'bad-listing':
      return `Codev Cloud's peer list was not in the expected form (see the Tower log); ${from}.`;
    case 'no-relay':
    case 'recent':
    case null:
      return null;
  }
}

/**
 * `afx peer list`: whether remote messaging is on here, then each of my other Towers with
 * the online hint and what it may message here. It works whatever the switch says, so the
 * owner can see what turning it on will involve.
 */
export async function peerList(options: PeerPortOption, deps: PeerDeps = defaultDeps(options)): Promise<void> {
  const answer = answerOf(await deps.client.getPeerTowers(), 'has no peer list');
  deps.out.line(answer.remoteMessaging === 'on' ? 'Remote messaging: on' : 'Remote messaging: off — a human turns it on with: afx peer on');
  for (const line of towerLines(answer.towers)) deps.out.line(line);
  if (answer.towers.length === 0 && answer.listing.refreshedAt !== null) deps.out.line('No other Towers are on your Codev Cloud account.');

  const notes = [listingNote(answer), relayNote(answer.relay)];
  if (answer.tunnel === 'down' && answer.listing.problem !== 'not-connected' && answer.listing.problem !== 'not-registered') {
    notes.push("This Tower's own tunnel is down: it can send, but cannot receive; mail for it waits at its senders.");
  }
  for (const note of notes) if (note !== null) deps.out.info(note);
}

// ===========================================================================
// afx peer grants
// ===========================================================================

export interface PeerGrantsOptions extends PeerPortOption {
  tower?: string;
}

function towerLabel(grant: PeerGrantView): string {
  return grant.peerName ?? grant.peerTowerId;
}

/** The lines a set of grants prints as, one grant a line, in a fixed layout. */
export function grantLines(grants: readonly PeerGrantView[]): string[] {
  const rows = grants.map((g) => [
    towerLabel(g),
    g.reaches === null ? g.recipient : `${g.recipient} (now ${g.reaches})`,
    modeText(g.mode),
    g.matchesNothing === null ? '' : `matches nothing: ${g.matchesNothing}`,
  ]);
  const header = ['TOWER', 'MAY MESSAGE', 'MODE', ''];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const format = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [format(header), ...rows.map(format)];
}

export async function peerGrants(options: PeerGrantsOptions, deps: PeerDeps = defaultDeps(options)): Promise<void> {
  const answer = answerOf(await deps.client.getPeerGrants(options.tower), 'has no grants');
  deps.out.line(
    answer.remoteMessaging === 'on'
      ? 'Remote messaging: on'
      : 'Remote messaging: off — no grant applies until a human turns it on with: afx peer on',
  );
  if (answer.grants.length === 0) {
    deps.out.line(
      options.tower === undefined
        ? `No grants: no Tower may message this Tower. Allow one with: ${GRANT_HINT}`
        : `No grants for ${options.tower}: it may not message this Tower. Allow it with: afx peer grant ${options.tower} <recipients>`,
    );
    return;
  }
  for (const line of grantLines(answer.grants)) deps.out.line(line);
  const mixed = new Set(
    answer.grants
      .map((g) => g.peerTowerId)
      .filter((id) => {
        const modes = new Set(answer.grants.filter((g) => g.peerTowerId === id).map((g) => g.mode));
        return modes.size > 1;
      }),
  );
  if (mixed.size > 0) {
    deps.out.line('Where grants for one Tower overlap, its mail is held for release if any of them holds it.');
  }
}

// ===========================================================================
// afx peer grant / revoke
// ===========================================================================

export interface PeerRecipientOptions {
  addresses?: string[];
  workspace?: string;
  all?: boolean;
}

export interface PeerGrantOptions extends PeerPortOption, PeerRecipientOptions {
  tower: string;
  deliver?: boolean;
  hold?: boolean;
  humanApproved?: boolean;
}

/** `codev:architect:local, codev:architect:review`, `every architect in codev`, `everything`. */
function recipientsText(grants: readonly PeerGrantView[]): string {
  return grants.map((g) => g.recipient).join(', ');
}

function modeSentence(mode: PeerGrantModeName): string {
  return mode === 'hold' ? 'Mail is held for release.' : 'Mail is delivered directly.';
}

function recipientsOf(options: PeerRecipientOptions): PeerRecipientOptions {
  const recipients: PeerRecipientOptions = {};
  if (options.addresses !== undefined && options.addresses.length > 0) recipients.addresses = options.addresses;
  if (options.workspace !== undefined) recipients.workspace = options.workspace;
  if (options.all === true) recipients.all = true;
  return recipients;
}

export async function peerGrant(options: PeerGrantOptions, deps: PeerDeps = defaultDeps(options)): Promise<void> {
  if (options.humanApproved !== true) {
    throw new Error(`Adding a grant is a human's decision. A human runs: afx peer grant ${options.tower} … ${HUMAN_APPROVAL_FLAG}`);
  }
  if (options.deliver === true && options.hold === true) {
    throw new Error('Choose one mode: --deliver (the default) or --hold, not both.');
  }
  const mode: PeerGrantModeName = options.hold === true ? 'hold' : 'deliver';
  const answer = answerOf(
    await deps.client.addPeerGrants({ tower: options.tower, ...recipientsOf(options), mode, humanApproved: true }),
    'has no grants',
  );
  const tower = answer.tower.name;
  const by = (kind: PeerGrantChange['change']) => answer.changes.filter((c) => c.change === kind).map((c) => c.grant);
  const added = by('added');
  const changed = by('mode-changed');
  const unchanged = by('unchanged');
  if (added.length > 0) {
    deps.out.success(`${tower} (your Tower) may message ${recipientsText(added)} on this Tower. ${modeSentence(mode)}`);
  }
  if (changed.length > 0) {
    deps.out.success(`${tower} (your Tower) may still message ${recipientsText(changed)} on this Tower. ${modeSentence(mode).replace('is ', 'is now ')}`);
  }
  if (unchanged.length > 0) {
    deps.out.success(`${tower} (your Tower) already may message ${recipientsText(unchanged)} on this Tower. ${modeSentence(mode)}`);
  }
  for (const grant of answer.changes.map((c) => c.grant)) {
    if (grant.matchesNothing !== null) deps.out.warn(`${grant.recipient} matches nothing now: ${grant.matchesNothing}.`);
  }
  if (answer.remoteMessaging === 'off') {
    deps.out.info('Remote messaging is off on this Tower: nothing arrives until a human turns it on with: afx peer on');
  }
}

export interface PeerRevokeOptions extends PeerPortOption, PeerRecipientOptions {
  tower: string;
}

export async function peerRevoke(options: PeerRevokeOptions, deps: PeerDeps = defaultDeps(options)): Promise<void> {
  const recipients = recipientsOf(options);
  const answer = answerOf(await deps.client.revokePeerGrants({ tower: options.tower, ...recipients }), 'has no grants');
  const tower = answer.tower.name;
  if (Object.keys(recipients).length === 0) {
    const count = answer.removed.length;
    deps.out.success(`Removed ${count === 1 ? 'the grant' : `all ${count} grants`} for ${tower}: it may no longer message this Tower.`);
    return;
  }
  deps.out.success(`${tower} may no longer message ${recipientsText(answer.removed)} on this Tower.`);
}

// ===========================================================================
// afx peer limits
// ===========================================================================

export async function peerLimits(options: PeerPortOption, deps: PeerDeps = defaultDeps(options)): Promise<void> {
  const answer = answerOf(await deps.client.getPeerLimits(), 'has no peer limits');
  const { tower, cloud } = answer;
  deps.out.line("This Tower's limits (set under peer.limits in ~/.codev/config.json):");
  deps.out.line(`  Messages accepted from one peer   ${tower.acceptedPerPeerPerMinute} a minute`);
  deps.out.line(`  Undelivered from one peer         ${tower.undeliveredPerPeer}`);
  deps.out.line(`  Waiting here for one peer         ${tower.waitingPerPeer}`);
  deps.out.line(`  Record of attempts kept for       ${answer.recordRetentionDays} days (peer.recordRetentionDays, at least 30)`);
  if (cloud === null) {
    deps.out.line("Codev Cloud's limits: not known yet. This Tower learns them from its peer list: afx peer list");
    return;
  }
  deps.out.line(`Codev Cloud's limits (approximate, the cloud's to change; from its peer list at ${at(cloud.listedAt)}):`);
  deps.out.line(`  Messages from this Tower          ${cloud.limits.messagesPerTowerPerMinute} a minute`);
  deps.out.line(`  Messages to one Tower             ${cloud.limits.messagesPerPairPerMinute} a minute`);
  deps.out.line(`  Discovery queries to one Tower    ${cloud.limits.queriesPerPairPerMinute} a minute`);
}
