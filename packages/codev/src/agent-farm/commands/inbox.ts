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

/** One held row as returned by GET /api/inbox — metadata only, never the body. */
interface InboxRow {
  id: string;
  workspacePath: string;
  toAgent: string;
  fromAgent: string | null;
  reason: string | null; // 'busy' | 'no-profile' | 'no-live-pty'
  escalated: boolean;
  createdAt: number; // epoch ms
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
  escalated: boolean;
  body: string;
  createdAt: number; // epoch ms
  resolvedAt: number | null; // epoch ms; set once the row leaves `held`
}

interface InboxShowOptions {
  port?: number;
}

/** Compact human age ("5s", "3m", "2h", "1d") from an epoch-ms timestamp. */
function formatAge(createdAt: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - createdAt) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
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

  const widths = [38, 6, 13, 22, 14];
  logger.row(['ID', 'AGE', 'REASON', 'FROM → TO', 'WORKSPACE'], widths);
  logger.row(
    ['─'.repeat(36), '─'.repeat(5), '─'.repeat(12), '─'.repeat(21), '─'.repeat(13)],
    widths,
  );

  const now = Date.now();
  for (const row of rows) {
    const wsName = row.workspacePath.split('/').pop() || row.workspacePath;
    const fromTo = `${row.fromAgent ?? '?'} → ${row.toAgent}`;
    const reason = `${row.reason ?? 'held'}${row.escalated ? '!' : ''}`;
    logger.row(
      [row.id, formatAge(row.createdAt, now), reason.slice(0, 13), fromTo.slice(0, 22), wsName.slice(0, 14)],
      widths,
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
  logger.kv('From → To', `${from} → ${row.toAgent}`);
  logger.kv('Workspace', row.workspacePath);
  logger.kv('Created', new Date(row.createdAt).toISOString());
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
