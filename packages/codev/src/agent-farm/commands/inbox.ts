// CLI handlers for `afx inbox` (Spec 1313).
//
// Lists *held* (undelivered) mailbox messages, shows one by id (including its body),
// and dismisses them. The mailbox lives in the user-global global.db that Tower owns,
// so — like `afx cron` — these handlers talk to the Tower API rather than opening the
// DB directly.
//
// The list is metadata-only (id, age, why-held reason, from→to, workspace): bodies are
// deliberately NOT surfaced in the list, and never travel through logs. `afx inbox show
// <id>` is the one surface that DOES display a body — legitimately, over the same local
// Tower connection that carries it (Spec 1313 Redaction rule: redaction covers logs/
// diagnostics/telemetry, not this local operator view). Dismiss is a soft transition (the
// row is marked `dismissed`, not deleted) and is authorized at the workspace-human trust
// level — any local operator may dismiss (or show) any held row (Spec 1313 decision 8).
//
// Spec 1967 (Decision 9's inbox rows): the list is in three groups, one per kind of held
// mail, each shown only there:
//   - waiting for a local agent: Spec 1313's held mail, as before;
//   - held for release: mail from another Tower that a human releases (`afx inbox release`,
//     a human's act, with the flag `porch approve` takes) or dismisses;
//   - waiting for a peer: mail this workspace sent to another Tower that waits here for a
//     route to it (Tower's outbox, `GET /api/peer/outbox`), with why the queues are paused
//     when they are. `afx inbox show` and `afx inbox dismiss` take its id, which is the id
//     `afx send` printed.

import type { InboxDismissResponse, InboxReleaseResponse, PeerOutboxMessage, PeerOutboxResponse, PeerQueuePause } from '@cluesmith/codev-types';
import { getTowerClient, DEFAULT_TOWER_PORT } from '../lib/tower-client.js';
import { logger, fatal } from '../utils/logger.js';
import { getConfig } from '../utils/config.js';
import { MAX_SENDER_ID_LENGTH } from '../utils/message-format.js';
import { olderTowerError } from '../utils/older-tower.js';
import { HUMAN_APPROVAL_FLAG } from '../peer/switch.js';
import { formatVerdict } from '@cluesmith/codev-sdk/hold-verdict';
import { lastPathSegment } from '../../lib/host-paths.js';

/** One held row as returned by GET /api/inbox — metadata only, never the body. */
interface InboxRow {
  id: string;
  workspacePath: string;
  toAgent: string;
  fromAgent: string | null;
  reason: string | null; // 'busy' | 'no-profile' | 'no-live-pty' | 'held-for-release' (Spec 1967)
  detail: string | null; // Issue #1482: 'user-text' | 'no-region-end' | 'no-composer-marker'; null for a non-gate hold
  escalated: boolean;
  createdAt: number; // epoch ms
  /**
   * Spec 1313 round 3: due time of a pre-due delayed (`--delay`) row; null = deliver-ASAP.
   * A row whose notBefore is still in the future is SCHEDULED (not stuck) — it is listed and
   * cancellable here, and rendered with its countdown.
   */
  notBefore: number | null;
  /** Spec 1967: for mail from another Tower, its sender as its header names it; absent from an older Tower. */
  remoteSender?: string | null;
  remoteOwnerEmail?: string | null;
}

interface InboxListOptions {
  /**
   * Workspace path to list. Defaults to the current workspace — `afx inbox` is
   * workspace-scoped (Spec 1313 decision 8), not Tower-wide. Tower normalizes this
   * to the same realpath form the mailbox stores, so the raw config workspace root
   * (or a `--workspace` path in any form) matches its held rows.
   */
  workspace?: string;
  port?: number;
}

interface InboxDismissOptions {
  port?: number;
}

interface InboxReleaseOptions {
  port?: number;
  /** `--a-human-explicitly-approved-this`: releasing remote mail is a human's act. */
  humanApproved?: boolean;
}

/**
 * A full mailbox row as GET /api/inbox/:id returns it — INCLUDING the body. Unlike the
 * list projection (metadata only), the single-row view carries the message content, so
 * `afx inbox show <id>` can display it.
 */
interface InboxMessage {
  kind?: 'mailbox';
  id: string;
  workspacePath: string;
  toAgent: string;
  fromAgent: string | null;
  fromWorkspace: string | null;
  status: string; // 'held' | 'delivered' | 'superseded' | 'dismissed'
  reason: string | null; // 'busy' | 'no-profile' | 'no-live-pty' | 'held-for-release' (Spec 1967)
  detail: string | null; // Issue #1482: 'user-text' | 'no-region-end' | 'no-composer-marker'; null for a non-gate hold
  escalated: boolean;
  body: string;
  createdAt: number; // epoch ms
  notBefore: number | null; // epoch ms; due time of a pre-due delayed row (Spec 1313 round 3)
  resolvedAt: number | null; // epoch ms; set once the row leaves `held`
  /** Spec 1967: for mail from another Tower, its sender's full address and its owner, and when a human released it. */
  remoteSender?: string | null;
  remoteOwnerEmail?: string | null;
  releasedAt?: number | null;
}

/** `GET /api/inbox/:id` for a message for another Tower (Spec 1967), in any state. */
interface InboxOutboxMessage extends PeerOutboxMessage {
  kind: 'outbox';
  /** Why no mail leaves now, for a held message; `null` otherwise. */
  paused: PeerQueuePause | null;
  body: string;
}

interface InboxShowOptions {
  port?: number;
}

/** Compact human duration ("5s", "3m", "2h", "1d") from a millisecond delta. */
function formatDuration(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Compact human age ("5s", "3m", "2h", "1d") from an epoch-ms timestamp. */
function formatAge(createdAt: number, now: number): string {
  return formatDuration(now - createdAt);
}

/**
 * Fit `text` into `width`, marking a cut with an ellipsis rather than silently losing the tail
 * (Issue #1482). The REASON column's values are now compound (`busy:no-composer-marker`), and a
 * bare `.slice()` would render one of them as a shorter value that reads like a DIFFERENT
 * verdict. The ellipsis is one character, so the visible prefix is `width - 1`.
 */
function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

/**
 * One line explaining a gate detail, for `afx inbox show` (Issue #1482).
 *
 * The split that matters to an operator is "will this clear by itself?": `user-text`,
 * `recent-input` and `composer-redraw` will (something outside the gate is writing to the
 * terminal, or the composer is mid-repaint, and it stops),
 * the other two will not (the classifier cannot find a bounded composer region at all, so no
 * amount of waiting helps).
 *
 * Every value the gate can persist needs a case here. `recent-input` was missing for exactly
 * one release of this feature: the LIST view rendered `busy:recent-input` correctly through the
 * shared formatter while `inbox show` — the view an operator opens *because* they want the
 * explanation — answered 'unrecognized gate detail' for the one hold class Issue #1473 exists
 * to make diagnosable. A default arm that reads as a bug report is not a safe place to land.
 */
function describeDetail(detail: string): string {
  switch (detail) {
    case 'user-text':
      return 'a draft or menu occupies the composer; a human is at the line and delivery resumes when it clears';
    case 'recent-input':
      return 'the terminal received input moments ago — a keystroke, a click, or an interrupt/escape write; the composer is empty but too recently touched to write onto, and delivery resumes about a third of a second after the input stops';
    case 'composer-redraw':
      return 'the composer is empty but its rendered region moved a moment ago — a turn-end redraw, a rotating placeholder, a resize, or an interrupt clearing the line; delivery resumes about a quarter second after it stops moving (the recipient simply producing output is not a hold)';
    case 'no-region-end':
      return 'the composer marker was found but nothing bounds the region below it (a partial frame, or dimensions that do not match the real terminal) — this will not clear on its own';
    case 'no-composer-marker':
      return 'no composer marker on screen at all (a boot/wrapper screen, a drifted app profile, or an unrenderable frame) — this will not clear on its own';
    default:
      return 'unrecognized gate detail';
  }
}

/** The answer an older Tower gives to a route it does not have: its catch-all 404, which carries no code. */
function isUnknownRoute(result: { status: number; errorCode?: string }): boolean {
  return result.status === 404 && result.errorCode === undefined;
}

/** Who sent a held row, as the list writes it: a remote sender as its header names it, else the agent. */
function senderOf(row: InboxRow): string {
  if (row.remoteSender) return row.remoteOwnerEmail ? `${row.remoteSender} (${row.remoteOwnerEmail})` : row.remoteSender;
  return row.fromAgent ?? '?';
}

/**
 * Fit each `FROM → TO` cell under one ceiling and size the column to its widest (issue #1478).
 * That column exists to answer "who sent this, to whom?", and a fixed 22-char slice cut long
 * builder ids and `architect:<name>` senders mid-name — silently rendering an identity the
 * operator can't act on. The ceiling is defence in depth, not the old truncation returning:
 * `POST /api/send` refuses a sender longer than MAX_SENDER_ID_LENGTH, so a pair of valid ids
 * cannot reach it, and rows persisted before that check existed cannot make every row in the
 * table pad to their width.
 */
function fromToColumn(cells: readonly string[]): { shown: string[]; width: number } {
  const header = 'FROM → TO';
  const ceiling = MAX_SENDER_ID_LENGTH * 2 + ' → '.length;
  const shown = cells.map((c) => (c.length > ceiling ? `${c.slice(0, ceiling - 1)}…` : c));
  return { shown, width: Math.max(header.length, ...shown.map((c) => c.length)) + 2 };
}

/** Group 1: mail waiting for a local agent, in Spec 1313's table. */
function renderWaitingForLocalAgent(rows: readonly InboxRow[], now: number): void {
  logger.header(`Waiting for a local agent (${rows.length})`);
  const cells = rows.map((row) => {
    // Spec 1313 round 3: a pre-due delayed (`--delay`) row is SCHEDULED, not stuck — render
    // its due countdown ("→15s") in the AGE column and "scheduled" as the reason, so a delayed
    // send that is simply waiting for its due time is not mistaken for a starving held message.
    const preDue = row.notBefore != null && row.notBefore > now;
    return {
      id: row.id,
      age: preDue ? `→${formatDuration(row.notBefore! - now)}` : formatAge(row.createdAt, now),
      reason: preDue
        ? 'scheduled'
        : `${formatVerdict(row.reason, row.detail)}${row.escalated ? '!' : ''}`,
      fromTo: `${senderOf(row)} → ${row.toAgent}`,
      workspace: lastPathSegment(row.workspacePath) || row.workspacePath,
    };
  });
  const { shown, width: fromToWidth } = fromToColumn(cells.map((c) => c.fromTo));
  // REASON is 20 wide, not 13 (Issue #1482): it carries the gate detail as a `reason:detail`
  // sub-code, and `busy:no-region-end` (18) has to fit. Only `busy:no-composer-marker` truncates,
  // and it stays unambiguous at 20 (`busy:no-composer-ma…`).
  const widths = [38, 6, 20, fromToWidth, 14];
  logger.row(['ID', 'AGE', 'REASON', 'FROM → TO', 'WORKSPACE'], widths);
  logger.row(
    ['─'.repeat(36), '─'.repeat(5), '─'.repeat(19), '─'.repeat(fromToWidth - 1), '─'.repeat(13)],
    widths,
  );
  cells.forEach((cell, i) => {
    logger.row(
      [cell.id, cell.age, truncate(cell.reason, 20), shown[i], cell.workspace.slice(0, 14)],
      widths,
    );
  });
}

/** Group 2: mail from another Tower held for a human's release, with the two commands that end the hold. */
function renderHeldForRelease(rows: readonly InboxRow[], now: number): void {
  logger.header(`Held for release (${rows.length})`);
  const { shown, width: fromToWidth } = fromToColumn(rows.map((row) => `${senderOf(row)} → ${row.toAgent}`));
  const widths = [38, 6, fromToWidth];
  logger.row(['ID', 'AGE', 'FROM → TO'], widths);
  logger.row(['─'.repeat(36), '─'.repeat(5), '─'.repeat(fromToWidth - 1)], widths);
  rows.forEach((row, i) => logger.row([row.id, formatAge(row.createdAt, now), shown[i]], widths));
  logger.info(`Release one (a human's decision): afx inbox release <id> ${HUMAN_APPROVAL_FLAG}   ·   Dismiss: afx inbox dismiss <id>`);
}

/** Why no mail for another Tower leaves now, and what changes it. */
export function pauseWords(pause: PeerQueuePause): string {
  switch (pause) {
    case 'remote-off':
      return 'Not sent now: remote messaging is off on this Tower. A human turns it on with: afx peer on';
    case 'not-connected':
      return 'Not sent now: this Tower is not connected to Codev Cloud. Connect it with: afx tower connect';
    case 'not-registered':
      return "Not sent now: this Tower's registration was removed from Codev Cloud. Register it again with: afx tower connect --reauth";
    case 'no-relay':
      return 'Not sent now: this Codev Cloud has no relay, so nothing can reach another Tower through it.';
  }
}

/** When a message for a peer is tried next, as the list writes it. */
function nextTryOf(message: PeerOutboxMessage, paused: boolean, now: number): string {
  if (message.inFlight) return 'sending now';
  if (paused || message.nextAttemptAt === null) return '—';
  return message.nextAttemptAt > now ? `in ${formatDuration(message.nextAttemptAt - now)}` : 'now';
}

/** Group 3: mail this workspace sent to other Towers that waits here, and why it is paused when it is. */
function renderWaitingForPeer(outbox: PeerOutboxResponse, now: number): void {
  const { messages, paused } = outbox;
  logger.header(`Waiting for a peer (${messages.length})`);
  const { shown, width: fromToWidth } = fromToColumn(messages.map((m) => `${m.fromAgent ?? '?'} → ${m.to}`));
  const widths = [38, 6, 20, fromToWidth, 12];
  logger.row(['ID', 'AGE', 'REASON', 'FROM → TO', 'NEXT TRY'], widths);
  logger.row(['─'.repeat(36), '─'.repeat(5), '─'.repeat(19), '─'.repeat(fromToWidth - 1), '─'.repeat(11)], widths);
  messages.forEach((m, i) => {
    logger.row([m.id, formatAge(m.sentAt, now), truncate(m.reason, 20), shown[i], nextTryOf(m, paused !== null, now)], widths);
  });
  if (paused !== null) logger.info(pauseWords(paused));
}

/**
 * `afx inbox` — list held messages for a workspace, in three groups (Spec 1967): waiting for
 * a local agent, held for release, waiting for a peer. Workspace-scoped per spec decision 8:
 * defaults to the current workspace (`getConfig().workspaceRoot`); `--workspace <path>` lists a
 * different one. Tower normalizes the path, so rows enqueued under the workspace's realpath
 * still match. A `!` after the reason marks a row that has crossed the escalation age.
 */
export async function inboxList(options: InboxListOptions = {}): Promise<void> {
  const client = getTowerClient(options.port || DEFAULT_TOWER_PORT);

  // Decision 8: workspace-scoped. Default to the current workspace when no explicit
  // --workspace was given, so `afx inbox` shows this workspace's held mail — not
  // every workspace Tower knows about.
  const workspace = options.workspace ?? getConfig().workspaceRoot;
  const query = `workspace=${encodeURIComponent(workspace)}`;

  const result = await client.request<InboxRow[]>(`/api/inbox?${query}`);
  if (!result.ok) {
    fatal(result.error || 'Failed to fetch inbox');
  }
  const rows = result.data!;

  // Spec 1967: mail waiting here for a peer. A Tower older than this CLI has none to list,
  // and says so rather than leaving the group silently out.
  let outbox: PeerOutboxResponse | null = null;
  const peerResult = await client.request<PeerOutboxResponse>(`/api/peer/outbox?${query}`);
  if (peerResult.ok) {
    outbox = peerResult.data!;
  } else if (!isUnknownRoute(peerResult)) {
    fatal(peerResult.error || 'Failed to fetch the mail waiting for a peer');
  }

  // The two kinds of mailbox row: held for release is its own group, and only there.
  const forRelease = rows.filter((row) => row.reason === 'held-for-release');
  const forAgent = rows.filter((row) => row.reason !== 'held-for-release');
  const forPeer = outbox?.messages ?? [];

  if (forAgent.length + forRelease.length + forPeer.length === 0) {
    logger.info('No held messages.');
  } else {
    const now = Date.now();
    if (forAgent.length > 0) renderWaitingForLocalAgent(forAgent, now);
    if (forRelease.length > 0) renderHeldForRelease(forRelease, now);
    if (outbox !== null && forPeer.length > 0) renderWaitingForPeer(outbox, now);
    logger.blank();
    logger.info('Show a message body: afx inbox show <id>   ·   Dismiss: afx inbox dismiss <id>');
  }
  if (outbox === null) logger.warn(olderTowerError('lists no mail waiting for a peer'));
}

/**
 * `afx inbox show <id>` — display a single mailbox row INCLUDING its body. This is the
 * one CLI surface that legitimately surfaces a message body: the Spec 1313 Redaction rule
 * bars bodies from logs/diagnostics/telemetry, not from this local operator view, which
 * travels over the same local Tower connection the message already uses. Works on a row of
 * ANY status (held / delivered / superseded / dismissed) so an operator can inspect or
 * audit by id — the list, by contrast, is held-only and metadata-only. Friendly error if
 * the id names no row.
 */
export async function inboxShow(id: string, options: InboxShowOptions = {}): Promise<void> {
  const client = getTowerClient(options.port || DEFAULT_TOWER_PORT);

  const result = await client.request<InboxMessage | InboxOutboxMessage>(`/api/inbox/${encodeURIComponent(id)}`);
  if (!result.ok) {
    fatal(result.error || `Failed to fetch '${id}'`);
  }

  const shown = result.data!;
  if (shown.kind === 'outbox') {
    showOutboxMessage(shown);
    return;
  }
  const row = shown;
  // Spec 1967: mail from another Tower names its sender's full address, and its owner.
  const from = row.remoteSender
    ? row.remoteSender
    : row.fromWorkspace ? `${row.fromAgent ?? '?'} (${row.fromWorkspace})` : row.fromAgent ?? '?';

  logger.header(`Message ${row.id}`);
  logger.kv('Status', `${row.status}${row.escalated ? ' (escalated)' : ''}`);
  logger.kv('Reason', row.reason ?? '—');
  if (row.reason === 'held-for-release' && row.status === 'held') {
    logger.kv('Release', `a human's decision: afx inbox release ${row.id} ${HUMAN_APPROVAL_FLAG}`);
  }
  // Issue #1482: spelled out rather than shown as the list's `reason:detail` sub-code, because
  // this is the view an operator opens when the sub-code is the thing they do not understand.
  if (row.detail) logger.kv('Detail', `${row.detail} — ${describeDetail(row.detail)}`);
  logger.kv('From → To', `${from} → ${row.toAgent}`);
  if (row.remoteOwnerEmail) logger.kv('Owner', row.remoteOwnerEmail);
  logger.kv('Workspace', row.workspacePath);
  logger.kv('Created', new Date(row.createdAt).toISOString());
  if (row.releasedAt) logger.kv('Released', new Date(row.releasedAt).toISOString());
  // Spec 1313 round 3: a still-scheduled delayed (`--delay`) row shows its due time and
  // countdown; a delayed row already past its due time is deliverable and needs no annotation.
  if (row.notBefore != null && row.status === 'held') {
    const now = Date.now();
    const label = row.notBefore > now ? `${new Date(row.notBefore).toISOString()} (in ${formatDuration(row.notBefore - now)})` : `${new Date(row.notBefore).toISOString()} (due)`;
    logger.kv('Scheduled', label);
  }
  if (row.resolvedAt) {
    logger.kv('Resolved', new Date(row.resolvedAt).toISOString());
  }

  // The message body is raw user content — print it verbatim, with no [info] prefix or
  // indent. This is the deliberate, spec-sanctioned exception to redaction: bodies surface
  // only here (and on the live terminal), never in logs.
  logger.header('Body');
  console.log(row.body);
}

/** A time and how far it is from now: `2026-11-27T10:00:00.000Z (in 40s)`, `(3m ago)`. */
function when(at: number, now: number): string {
  const iso = new Date(at).toISOString();
  return at > now ? `${iso} (in ${formatDuration(at - now)})` : `${iso} (${formatDuration(now - at)} ago)`;
}

/** What a message for another Tower came to, or why it waits. */
function outboxStatus(message: InboxOutboxMessage): string {
  switch (message.state) {
    case 'held':
      return message.inFlight ? `waiting for ${message.peerName ?? 'its peer'} (${message.reason}); being sent now` : `waiting for ${message.peerName ?? 'its peer'} (${message.reason})`;
    case 'accepted':
      return `accepted by ${message.peerName ?? 'its peer'} (${message.lastOutcome ?? 'accepted'})`;
    case 'refused':
      return `refused (${message.reason})`;
    case 'dismissed':
      return 'dismissed on this Tower; it was not sent';
    case 'expired':
      return 'expired: not accepted within its 30-day lifetime';
  }
}

/** `afx inbox show <id>` for a message for another Tower (Spec 1967). Its body is ours, so it shows as a mailbox row's does. */
function showOutboxMessage(message: InboxOutboxMessage): void {
  const now = Date.now();
  logger.header(`Message ${message.id}`);
  logger.kv('Status', outboxStatus(message));
  logger.kv('From → To', `${message.fromAgent ?? '?'} → ${message.to}`);
  logger.kv('Workspace', message.workspacePath);
  logger.kv('Sent', new Date(message.sentAt).toISOString());
  logger.kv('Attempts', message.attempts);
  if (message.state === 'held') {
    logger.kv('Expires', when(message.expiresAt, now));
    if (message.paused !== null) logger.kv('Paused', pauseWords(message.paused));
    else if (message.nextAttemptAt !== null && !message.inFlight) logger.kv('Next try', when(message.nextAttemptAt, now));
  }
  if (message.resolvedAt !== null) logger.kv('Resolved', new Date(message.resolvedAt).toISOString());
  logger.header('Body');
  console.log(message.body);
}

/**
 * `afx inbox release <id>` (Spec 1967): a human releases one message from another Tower held
 * for release. It becomes ordinary held mail and is delivered through the gate, as soon as
 * its agent's prompt is clear. A trust-widening act, so it takes the flag `porch approve`
 * takes, and refuses before asking Tower without it; Tower refuses again if asked.
 */
export async function inboxRelease(id: string, options: InboxReleaseOptions = {}): Promise<void> {
  if (options.humanApproved !== true) {
    fatal(`Releasing a message is a human's decision. A human runs: afx inbox release ${id} ${HUMAN_APPROVAL_FLAG}`);
  }
  const client = getTowerClient(options.port || DEFAULT_TOWER_PORT);

  const result = await client.request<InboxReleaseResponse>(`/api/inbox/${encodeURIComponent(id)}/release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ humanApproved: true }),
  });
  if (!result.ok) {
    if (isUnknownRoute(result)) fatal(olderTowerError('cannot release a message'));
    fatal(result.error || `Failed to release '${id}'`);
  }

  const released = result.data!;
  logger.success(`Released message ${released.id}: it is delivered to ${released.toAgent} through the gate, once that agent's prompt is clear.`);
}

/**
 * `afx inbox dismiss <id>` — mark a held row dismissed. Soft transition (auditable,
 * pruned later); never delivers the message. Returns a friendly error if the id does
 * not name a currently-held row. Spec 1967: also mail held for release, and a message
 * waiting for a peer, which is then never sent; one whose relay call is in flight is
 * refused, since its answer decides it.
 */
export async function inboxDismiss(id: string, options: InboxDismissOptions = {}): Promise<void> {
  const client = getTowerClient(options.port || DEFAULT_TOWER_PORT);

  const result = await client.request<InboxDismissResponse>(
    `/api/inbox/${encodeURIComponent(id)}/dismiss`,
    { method: 'POST' },
  );
  if (!result.ok) {
    fatal(result.error || `Failed to dismiss '${id}'`);
  }

  const dismissed = result.data;
  if (dismissed?.kind === 'outbox') {
    logger.success(`Dismissed message ${id} waiting for ${dismissed.peer ?? 'its peer'}: it will not be sent.`);
    return;
  }
  logger.success(`Dismissed held message ${id}`);
}
