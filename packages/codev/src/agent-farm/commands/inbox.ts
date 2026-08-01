// CLI handlers for `afx inbox` (Spec 1313, Phase 7).
//
// Lists *held* (undelivered) mailbox messages and dismisses them. The mailbox lives
// in the user-global global.db that Tower owns, so — like `afx cron` — these handlers
// talk to the Tower API rather than opening the DB directly.
//
// The list is metadata-only (id, age, why-held reason, from→to, workspace). Message
// bodies are deliberately NOT surfaced here: the spec's indicator/list is count-and-
// metadata only, and bodies never travel through logs or list views. Dismiss is a
// soft transition (the row is marked `dismissed`, not deleted) and is authorized at
// the workspace-human trust level — any local operator may dismiss any held row
// (Spec 1313 decision 8).

import { getTowerClient, DEFAULT_TOWER_PORT } from '../lib/tower-client.js';
import { logger, fatal } from '../utils/logger.js';

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
  /** Scope to a single workspace path; default lists every held row Tower-wide. */
  workspace?: string;
  port?: number;
}

interface InboxDismissOptions {
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
 * `afx inbox` — list held messages. Workspace-wide by default (each row shows its
 * workspace); `--workspace <path>` scopes to one workspace (decision 8's
 * workspace-scoping). A `!` after the reason marks a row that has crossed the
 * escalation age.
 */
export async function inboxList(options: InboxListOptions = {}): Promise<void> {
  const client = getTowerClient(options.port || DEFAULT_TOWER_PORT);

  let path = '/api/inbox';
  if (options.workspace) {
    path += `?workspace=${encodeURIComponent(options.workspace)}`;
  }

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
  logger.info('Dismiss with: afx inbox dismiss <id>');
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
