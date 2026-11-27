/**
 * `afx peer on|off|list|grants|grant|revoke|limits|show|log` (Spec 1967; approved spec
 * Decisions 6 and 9).
 *
 * The receiving Tower's own decisions about who may message whom, the list of my other
 * Towers, what one of them lets this Tower message (`show`, which asks that Tower), and the
 * record of cross-Tower attempts (`log`, which never shows a body).
 * Tower holds the switch, the grants and the peer list and makes every check; these
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
  PeerLogEntry,
  PeerLogResponse,
  PeerMarkView,
  PeerShownAddress,
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
  | 'getPeerSwitch'
  | 'setPeerSwitch'
  | 'getPeerGrants'
  | 'addPeerGrants'
  | 'revokePeerGrants'
  | 'getPeerLimits'
  | 'getPeerTowers'
  | 'getPeerShow'
  | 'getPeerLog'
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
 * Released mail is the owner's decision about each message, so neither the switch nor a
 * grant takes it back (the architect's ruling, 2026-11-27T04:51Z). `off` and `revoke` say how
 * much of it still waits to be delivered, and how one is stopped. `null` when none waits.
 */
export function releasedWaitingNote(count: number, from: string): string | null {
  if (count === 0) return null;
  const what = count === 1 ? 'One message' : `${count} messages`;
  const verb = count === 1 ? 'was' : 'were';
  return `${what} ${from} ${verb} released by a human and still ${count === 1 ? 'waits' : 'wait'} to be delivered here: a release stands. Stop one with: afx inbox dismiss <id>`;
}

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
  const released = releasedWaitingNote(answer.releasedWaiting ?? 0, 'from other Towers');
  if (released !== null) deps.out.info(released);
}

// ===========================================================================
// afx peer list
// ===========================================================================

/** What one Tower may message here, as the list prints it: its grants, or nothing. */
function mayMessageText(tower: PeerListedTowerView): string {
  if (tower.mayMessage.length === 0) return 'nothing';
  return tower.mayMessage.map((g) => `${g.recipient} (${modeText(g.mode)})`).join(', ');
}

/** What a mark on a peer says, as `afx peer list` and `afx peer log` print it (G10, G12, G15). */
export function markText(mark: PeerMarkView): string {
  switch (mark.mark) {
    case 'not-verifying':
      return `not verifying: its last ${mark.run} messages from here were not verified there, since ${at(mark.since)}. The two Towers may disagree about the contract; this Tower keeps retrying at the capped interval.`;
    case 'cloud-error':
      return `cloud error: Codev Cloud failed the last ${mark.run} messages to it, since ${at(mark.since)}, as it cannot build a valid statement for this pair. This Tower keeps retrying at the capped interval.`;
    case 'clock-out-of-range':
      return `clock out of range: it refused a message from here as clock-skew at ${at(mark.lastAt)}. Its clock may be wrong (Codev Cloud's clock is the reference); this Tower keeps retrying.`;
  }
}

/** What R's clock surface says (G12): this Tower's own clock may be out of range. `null` when it is not. */
export function clockNote(clockSkewSince: number | null | undefined): string | null {
  if (clockSkewSince === null || clockSkewSince === undefined) return null;
  return `This Tower's clock may be out of range: it refused a request from another Tower as clock-skew at ${at(clockSkewSince)}, and Codev Cloud's clock is the reference. Check this machine's clock.`;
}

/** One line per Tower, in aligned columns: name, owner, the online hint, what it may message here. */
export function towerLines(towers: readonly PeerListedTowerView[]): string[] {
  const rows = towers.map((t) => [t.name, 'you', t.online ? 'online' : 'offline', `may message this Tower: ${mayMessageText(t)}`]);
  const widths = [0, 1, 2].map((i) => Math.max(0, ...rows.map((r) => r[i].length)));
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
  const lines = towerLines(answer.towers);
  answer.towers.forEach((tower, i) => {
    deps.out.line(lines[i]);
    // A mark shows while it is set: a Tower older than this CLI sends none.
    for (const mark of tower.marks ?? []) deps.out.line(`  ! ${markText(mark)}`);
  });
  if (answer.towers.length === 0 && answer.listing.refreshedAt !== null) deps.out.line('No other Towers are on your Codev Cloud account.');

  const notes = [listingNote(answer), relayNote(answer.relay)];
  if (answer.tunnel === 'down' && answer.listing.problem !== 'not-connected' && answer.listing.problem !== 'not-registered') {
    notes.push("This Tower's own tunnel is down: it can send, but cannot receive; mail for it waits at its senders.");
  }
  notes.push(clockNote(answer.clockSkewSince));
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
  } else {
    deps.out.success(`${tower} may no longer message ${recipientsText(answer.removed)} on this Tower.`);
  }
  const released = releasedWaitingNote(answer.releasedWaiting ?? 0, `from ${tower}`);
  if (released !== null) deps.out.info(released);
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

// ===========================================================================
// afx peer show
// ===========================================================================

export interface PeerShowOptions extends PeerPortOption {
  tower: string;
}

/** One address a line, ready to paste, then whether its agent has a live terminal. */
export function shownLines(addresses: readonly PeerShownAddress[]): string[] {
  const width = Math.max(0, ...addresses.map((a) => a.address.length));
  return addresses.map((a) => `${a.address.padEnd(width)}  ${a.live ? 'live' : 'not live'}`);
}

/**
 * `afx peer show <tower>`: what runs on one of my other Towers that this Tower may message,
 * as that Tower answered from its grants (Decision 6). A refusal, an offline peer or an
 * unreachable cloud included, is thrown with its words: a query is never held.
 */
export async function peerShow(options: PeerShowOptions, deps: PeerDeps = defaultDeps(options)): Promise<void> {
  const answer = answerOf(await deps.client.getPeerShow(options.tower), 'cannot ask another Tower what runs there');
  const tower = answer.tower.name;
  if (answer.addresses.length === 0) {
    deps.out.line(`Nothing on ${tower} that this Tower may message now.`);
  } else {
    for (const line of shownLines(answer.addresses)) deps.out.line(line);
  }
  if (answer.truncated) {
    deps.out.info(`${tower} trimmed its answer to fit the 65 536-byte limit: some addresses there are not shown.`);
  }
}

// ===========================================================================
// afx peer log
// ===========================================================================

export interface PeerLogOptions extends PeerPortOption {
  /** Only the attempts to and from this Tower (a tower-ref). */
  tower?: string;
  limit?: number;
}

/** Who and what an entry is about, as the log prints it. */
function entrySubject(entry: PeerLogEntry): string {
  const arrow = entry.direction === 'outbound' ? `to ${entry.peer ?? '?'}` : `from ${entry.peer ?? (entry.tunnelSession === null ? '?' : 'an unverified sender')}`;
  const kind = entry.kind ?? 'request';
  const route = entry.from !== null || entry.to !== null ? `  ${entry.from ?? '?'} → ${entry.to ?? '?'}` : '';
  return `${kind} ${arrow}${route}`;
}

/** The outcome an entry records, with its reason. */
function entryOutcome(entry: PeerLogEntry): string {
  return entry.reason === null ? entry.outcome : `${entry.outcome} (${entry.reason})`;
}

/**
 * One line for one row of the record. A flood (an aggregate row) is one counted line, never one
 * line per attempt. An outbound message also says what the message itself came to, so an
 * answer this Tower did not use (its registration changed during the call) is seen beside
 * what the message did. No line carries a body: the record keeps none.
 */
export function logLine(entry: PeerLogEntry): string {
  const when = at(entry.at);
  const parts = [when, entry.direction === 'outbound' ? 'out' : 'in ', entrySubject(entry), entryOutcome(entry)];
  if (entry.aggregate) parts.push(`×${entry.count} until ${at(entry.lastAt)}`);
  if (entry.messageId !== null) parts.push(`id ${entry.messageId}`);
  if (entry.payloadSize !== null) parts.push(`${entry.payloadSize} B`);
  if (entry.message !== null) parts.push(`message now: ${entry.message.state}${entry.message.state === 'held' ? ` (${entry.message.reason})` : ''}`);
  return parts.join('  ');
}

/**
 * `afx peer log [--peer <tower>]`: the record of cross-Tower attempts, newest first, with the
 * marks set now (G10, G12, G15). Bodies are never in the record, so never here.
 */
export async function peerLog(options: PeerLogOptions, deps: PeerDeps = defaultDeps(options)): Promise<void> {
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error(`'--limit' must be a whole number from 1: got ${String(options.limit)}.`);
  }
  const answer: PeerLogResponse = answerOf(
    await deps.client.getPeerLog({ tower: options.tower, limit: options.limit }),
    'keeps no record of cross-Tower attempts it can show',
  );
  for (const mark of answer.marks) deps.out.line(`! ${mark.peer}: ${markText(mark)}`);
  const clock = clockNote(answer.clockSkewSince);
  if (clock !== null) deps.out.line(`! ${clock}`);
  if (answer.entries.length === 0) {
    deps.out.line(options.tower === undefined ? 'No cross-Tower attempts recorded.' : `No cross-Tower attempts recorded with ${options.tower}.`);
    return;
  }
  for (const entry of answer.entries) deps.out.line(logLine(entry));
  if (answer.truncated) deps.out.info(`Older attempts are not shown. Show more with: afx peer log --limit <count>`);
}
