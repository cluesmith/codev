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

import { getTowerClient, DEFAULT_TOWER_PORT } from '../lib/tower-client.js';
import { logger, fatal } from '../utils/logger.js';
import { getConfig } from '../utils/config.js';
import { MAX_SENDER_ID_LENGTH } from '../utils/message-format.js';
import { formatVerdict } from '@cluesmith/codev-sdk/hold-verdict';

/** One held row as returned by GET /api/inbox — metadata only, never the body. */
interface InboxRow {
  id: string;
  workspacePath: string;
  toAgent: string;
  fromAgent: string | null;
  reason: string | null; // 'busy' | 'no-profile' | 'no-live-pty'
  detail: string | null; // Issue #1482: 'user-text' | 'no-region-end' | 'no-composer-marker'; null for a non-gate hold
  escalated: boolean;
  createdAt: number; // epoch ms
  /**
   * Spec 1313 round 3: due time of a pre-due delayed (`--delay`) row; null = deliver-ASAP.
   * A row whose notBefore is still in the future is SCHEDULED (not stuck) — it is listed and
   * cancellable here, and rendered with its countdown.
   */
  notBefore: number | null;
  /**
   * Issue #1481: when this row's `--interrupt-after` force becomes armed; null on ordinary rows.
   * NOT a scheduling field — the row is deliverable now and is listed and counted like any other
   * held message. It only says the row will stop waiting at that instant.
   */
  interruptAt: number | null;
  /** Issue #1481: the force's audit state (`armed` while pending, then claimed/written/skipped). */
  interruptOutcome: string | null;
  /** Issue #1481: an ordinary write for this row may already have emitted bytes. */
  interruptPriorPartial: boolean;
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

/**
 * A full mailbox row as GET /api/inbox/:id returns it — INCLUDING the body. Unlike the
 * list projection (metadata only), the single-row view carries the message content, so
 * `afx inbox show <id>` can display it.
 */
interface InboxMessage {
  id: string;
  workspacePath: string;
  toAgent: string;
  fromAgent: string | null;
  fromWorkspace: string | null;
  status: string; // 'held' | 'delivered' | 'superseded' | 'dismissed'
  reason: string | null; // 'busy' | 'no-profile' | 'no-live-pty'
  detail: string | null; // Issue #1482: 'user-text' | 'no-region-end' | 'no-composer-marker'; null for a non-gate hold
  escalated: boolean;
  body: string;
  createdAt: number; // epoch ms
  notBefore: number | null; // epoch ms; due time of a pre-due delayed row (Spec 1313 round 3)
  interruptAt: number | null; // epoch ms; --interrupt-after deadline (Issue #1481); null on ordinary rows
  interruptOutcome: string | null; // Issue #1481: force audit state — never receipt
  interruptClaimedAt: number | null; // epoch ms the force claimed the row, immediately before its first byte
  interruptPriorPartial: boolean; // an ordinary write for this row may already have emitted bytes
  resolvedAt: number | null; // epoch ms; set once the row leaves `held`
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
 * One line explaining a force outcome, for `afx inbox show` (Issue #1481).
 *
 * The distinction every line here defends: what Tower DID versus what the agent RECEIVED. A
 * claimed or written force is evidence of the former only, and an operator reading this view is
 * usually trying to find out whether a message landed — so no wording may imply that it did.
 */
function describeInterruptOutcome(outcome: string): string {
  switch (outcome) {
    case 'armed':
      return 'waiting — if the row is still held at the deadline it will be force-delivered';
    case 'claimed':
      return 'claimed immediately before writing; the write outcome was never recorded (Tower stopped mid-force)';
    case 'claimed-degraded':
      return 'claimed while another write held the terminal; the write outcome was never recorded';
    case 'written-unverified':
      return 'Ctrl+C and the body were written and every byte accepted — NOT confirmed as read';
    case 'degraded-written-unverified':
      return 'written, but not serialized against a write already in flight — it may have interleaved';
    case 'failed':
      return 'a write was rejected by the terminal; the row is claimed, so the body will NOT be re-sent';
    case 'degraded-failed':
      return 'a write was rejected AND it was not serialized against a write already in flight';
    case 'skipped-offline':
      return 'no live writable session at the deadline — nothing was written; the message is still held';
    case 'skipped-session-replaced':
      return 'the target session was replaced while queued — nothing was written; the message is still held';
    case 'skipped-restart':
      return 'a Tower restart retired the force — nothing was written; the message is still held';
    default:
      return 'unrecognized force outcome';
  }
}

/**
 * One line explaining a gate detail, for `afx inbox show` (Issue #1482).
 *
 * The split that matters to an operator is "will this clear by itself?": `user-text` will (a
 * human is at the composer), the other two will not (the classifier cannot find a bounded
 * composer region at all, so no amount of waiting helps).
 */
function describeDetail(detail: string): string {
  switch (detail) {
    case 'user-text':
      return 'a draft or menu occupies the composer; a human is at the line and delivery resumes when it clears';
    case 'no-region-end':
      return 'the composer marker was found but nothing bounds the region below it (a partial frame, or dimensions that do not match the real terminal) — this will not clear on its own';
    case 'no-composer-marker':
      return 'no composer marker on screen at all (a boot/wrapper screen, a drifted app profile, or an unrenderable frame) — this will not clear on its own';
    default:
      return 'unrecognized gate detail';
  }
}

/**
 * `afx inbox` — list held messages for a workspace. Workspace-scoped per spec
 * decision 8: defaults to the current workspace (`getConfig().workspaceRoot`);
 * `--workspace <path>` lists a different one. Tower normalizes the path, so rows
 * enqueued under the workspace's realpath still match. A `!` after the reason marks
 * a row that has crossed the escalation age.
 */
export async function inboxList(options: InboxListOptions = {}): Promise<void> {
  const client = getTowerClient(options.port || DEFAULT_TOWER_PORT);

  // Decision 8: workspace-scoped. Default to the current workspace when no explicit
  // --workspace was given, so `afx inbox` shows this workspace's held mail — not
  // every workspace Tower knows about.
  const workspace = options.workspace ?? getConfig().workspaceRoot;
  const path = `/api/inbox?workspace=${encodeURIComponent(workspace)}`;

  const result = await client.request<InboxRow[]>(path);
  if (!result.ok) {
    fatal(result.error || 'Failed to fetch inbox');
  }

  const rows = result.data!;
  if (rows.length === 0) {
    logger.info('No held messages.');
    return;
  }

  logger.header(`Held messages (${rows.length})`);

  const now = Date.now();
  // Render the cells first so the FROM → TO column can be sized to its content
  // (issue #1478). That column exists to answer "who sent this, to whom?", and a
  // fixed 22-char slice cut long builder ids and `architect:<name>` senders
  // mid-name — silently rendering an identity the operator can't act on.
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
      fromTo: `${row.fromAgent ?? '?'} → ${row.toAgent}`,
      workspace: row.workspacePath.split('/').pop() || row.workspacePath,
    };
  });

  const fromToHeader = 'FROM → TO';
  // Sized to content, so a long-but-legitimate agent id is never cut mid-name (issue
  // #1478 — the old fixed 22 silently truncated them). The ceiling is defence in depth,
  // not the old truncation returning: `POST /api/send` now refuses a sender longer than
  // MAX_SENDER_ID_LENGTH, so a pair of valid ids cannot reach it, and rows persisted
  // before that check existed cannot make every row in the table pad to their width.
  const maxFromToWidth = MAX_SENDER_ID_LENGTH * 2 + ' → '.length;
  const shown = cells.map((c) =>
    c.fromTo.length > maxFromToWidth ? `${c.fromTo.slice(0, maxFromToWidth - 1)}…` : c.fromTo,
  );
  const fromToWidth = Math.max(fromToHeader.length, ...shown.map((c) => c.length)) + 2;
  // REASON is 20 wide, not 13 (Issue #1482): it carries the gate detail as a `reason:detail`
  // sub-code, and `busy:no-region-end` (18) has to fit. Only `busy:no-composer-marker` truncates,
  // and it stays unambiguous at 20 (`busy:no-composer-ma…`).
  const widths = [38, 6, 20, fromToWidth, 14];
  logger.row(['ID', 'AGE', 'REASON', fromToHeader, 'WORKSPACE'], widths);
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

  // Issue #1481: a `--interrupt-after` row is ordinary held mail in every column above — which
  // is exactly right, and exactly why it needs saying separately: nothing in the table
  // distinguishes a row that will wait forever from one that is about to interrupt a turn. The
  // columns are left alone (they are already sized to their content) and the fact is stated
  // below them instead.
  const armed = rows.filter((r) => r.interruptOutcome === 'armed' && r.interruptAt != null);
  if (armed.length > 0) {
    const when = armed
      .map((r) => `${r.id.slice(0, 8)}… ${r.interruptAt! > now ? `in ${formatDuration(r.interruptAt! - now)}` : 'now'}`)
      .join(', ');
    logger.blank();
    logger.warn(
      `${armed.length} of these will be FORCE-delivered if still held (Ctrl+C, then the message, ` +
        `no render gate): ${when}. Cancel one with 'afx inbox dismiss <id>'.`,
    );
  }
  const skipped = rows.filter((r) => r.interruptOutcome?.startsWith('skipped-'));
  if (skipped.length > 0) {
    logger.blank();
    logger.info(
      `${skipped.length} had a --interrupt-after deadline whose force was skipped ` +
        `(${[...new Set(skipped.map((r) => r.interruptOutcome))].join(', ')}); they now wait for a clear ` +
        `prompt like ordinary mail.`,
    );
  }

  logger.blank();
  logger.info('Show a message body: afx inbox show <id>   ·   Dismiss: afx inbox dismiss <id>');
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

  const result = await client.request<InboxMessage>(`/api/inbox/${encodeURIComponent(id)}`);
  if (!result.ok) {
    fatal(result.error || `Failed to fetch '${id}'`);
  }

  const row = result.data!;
  const from = row.fromWorkspace ? `${row.fromAgent ?? '?'} (${row.fromWorkspace})` : row.fromAgent ?? '?';

  logger.header(`Message ${row.id}`);
  logger.kv('Status', `${row.status}${row.escalated ? ' (escalated)' : ''}`);
  logger.kv('Reason', row.reason ?? '—');
  // Issue #1482: spelled out rather than shown as the list's `reason:detail` sub-code, because
  // this is the view an operator opens when the sub-code is the thing they do not understand.
  if (row.detail) logger.kv('Detail', `${row.detail} — ${describeDetail(row.detail)}`);
  logger.kv('From → To', `${from} → ${row.toAgent}`);
  logger.kv('Workspace', row.workspacePath);
  logger.kv('Created', new Date(row.createdAt).toISOString());
  // Spec 1313 round 3: a still-scheduled delayed (`--delay`) row shows its due time and
  // countdown; a delayed row already past its due time is deliverable and needs no annotation.
  if (row.notBefore != null && row.status === 'held') {
    const now = Date.now();
    const label = row.notBefore > now ? `${new Date(row.notBefore).toISOString()} (in ${formatDuration(row.notBefore - now)})` : `${new Date(row.notBefore).toISOString()} (due)`;
    logger.kv('Scheduled', label);
  }
  // Issue #1481: the bounded-patience deadline and what the force did with it. Reported as
  // separate facts — deadline, outcome, claim time, prior-partial — rather than one summary
  // word, because collapsing them is how "we claimed this row" comes to read as "the agent got
  // this message".
  if (row.interruptAt != null) {
    const now = Date.now();
    const due =
      row.interruptOutcome === 'armed' && row.interruptAt > now
        ? `${new Date(row.interruptAt).toISOString()} (in ${formatDuration(row.interruptAt - now)})`
        : new Date(row.interruptAt).toISOString();
    logger.kv('Force after', due);
    if (row.interruptOutcome) {
      logger.kv('Force outcome', `${row.interruptOutcome} — ${describeInterruptOutcome(row.interruptOutcome)}`);
    }
    if (row.interruptClaimedAt != null) {
      logger.kv('Force claimed', new Date(row.interruptClaimedAt).toISOString());
    }
  }
  if (row.interruptPriorPartial) {
    logger.warn(
      'An earlier ordinary write for this message may already have put bytes on the terminal, so ' +
        'some or all of its effects may exist twice.',
    );
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

/**
 * `afx inbox dismiss <id>` — mark a held row dismissed. Soft transition (auditable,
 * pruned later); never delivers the message. Returns a friendly error if the id does
 * not name a currently-held row.
 */
export async function inboxDismiss(id: string, options: InboxDismissOptions = {}): Promise<void> {
  const client = getTowerClient(options.port || DEFAULT_TOWER_PORT);

  const result = await client.request<{ ok: boolean }>(
    `/api/inbox/${encodeURIComponent(id)}/dismiss`,
    { method: 'POST' },
  );
  if (!result.ok) {
    fatal(result.error || `Failed to dismiss '${id}'`);
  }

  logger.success(`Dismissed held message ${id}`);
}
