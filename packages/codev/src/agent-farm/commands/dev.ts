/**
 * `afx dev <builder-id>` — start the worktree dev server for a builder.
 * `afx dev --stop`         — stop the currently running dev PTY.
 *
 * Design (see #689):
 * - One dev PTY runs at a time. Builder-to-builder swap prompts; main's
 *   dev is the user's responsibility (Codev never kills processes it
 *   didn't spawn).
 * - Uses the same ports/URLs as main by design — preserves OAuth
 *   callbacks, CORS allowlists, cookie scoping, webhook URLs.
 * - Cleanup is process-based: Tower's PTY kill signals the entire
 *   process group (SIGTERM → SIGKILL after 5s), the OS reclaims ports
 *   as a consequence. Codev never touches ports directly.
 */

import { createInterface } from 'node:readline';
import { logger } from '../utils/logger.js';
import { getConfig, getWorktreeConfig } from '../utils/index.js';
import { getTowerClient } from '../lib/tower-client.js';
import { createPtySession } from './spawn-worktree.js';
import { findBuilderById } from '../lib/builder-lookup.js';

export interface DevOptions {
  builderId?: string;
  stop?: boolean;
}

/** Time we'll wait for a killed dev PTY to disappear from listTerminals. */
const KILL_WAIT_TIMEOUT_MS = 7000;
const KILL_POLL_INTERVAL_MS = 200;
/** Grace delay after exit-confirmed, before spawning the replacement. */
const SWAP_GRACE_MS = 250;

export async function dev(options: DevOptions): Promise<void> {
  const client = getTowerClient();

  if (options.stop) {
    const existing = await findActiveDevTerminal(client);
    if (!existing) {
      logger.info('No Codev-managed dev server is running.');
      return;
    }
    const ok = await client.killTerminal(existing.id);
    if (!ok) throw new Error(`Failed to kill dev terminal ${existing.id}`);
    logger.success(`Stopped dev server (terminal ${existing.id})`);
    return;
  }

  if (!options.builderId) {
    throw new Error('Usage: afx dev <builder-id|main>  (or --stop)');
  }

  const config = getConfig();

  // Reserved target: `main` runs the dev server in the main workspace (the
  // default checkout), making it a Codev-managed, swappable PTY exactly like
  // a builder worktree. Resolved locally — deliberately NOT via
  // findBuilderById — so `main` never leaks into afx send/cleanup/status.
  const isMain = options.builderId.toLowerCase() === 'main';
  const builder: { id: string; worktree?: string } | null = isMain
    ? { id: 'main', worktree: config.workspaceRoot }
    : findBuilderById(options.builderId);
  if (!builder) {
    throw new Error(`No builder found matching "${options.builderId}". Try \`afx status\`.`);
  }
  if (!builder.worktree) {
    throw new Error(`Builder ${builder.id} has no worktree path on record — cannot start dev.`);
  }

  const { devCommand } = getWorktreeConfig(config.workspaceRoot);
  if (!devCommand) {
    throw new Error(
      'No worktree.devCommand configured in .codev/config.json. ' +
      'See "Runnable Worktrees" in CLAUDE.md for stack-specific recipes.',
    );
  }

  // Swap-detection: a dev PTY may already be running for another builder.
  const existing = await findActiveDevTerminal(client);
  if (existing) {
    if (existing.roleId === builder.id) {
      logger.info(`Dev server already running for ${builder.id}.`);
      logger.kv('Terminal', client.getTerminalWsUrl(existing.id));
      return;
    }
    const proceed = await promptYesNo(
      `Currently running dev for ${existing.roleId ?? existing.id}. ` +
      `Stop it and start ${builder.id}? [y/N] `,
    );
    if (!proceed) {
      logger.info('Aborted.');
      return;
    }
    await client.killTerminal(existing.id);
    await waitForTerminalGone(client, existing.id);
    await new Promise((r) => setTimeout(r, SWAP_GRACE_MS));
  }

  logger.info(`Starting dev server for ${builder.id} in ${builder.worktree}...`);
  const { terminalId } = await createPtySession(
    config,
    '/bin/sh',
    ['-lc', devCommand],
    builder.worktree,
    {
      workspacePath: config.workspaceRoot,
      type: 'dev',
      roleId: builder.id,
      label: `Dev: ${builder.id}`,
    },
  );

  logger.blank();
  logger.success(`Dev server spawned for ${builder.id}`);
  logger.kv('Terminal', client.getTerminalWsUrl(terminalId));
}

interface DevTerminal {
  id: string;
  roleId?: string;
}

/**
 * Return the current dev PTY, if any. Tower's TowerTerminal type from
 * listTerminals only includes id/label/pid; roleId is available via the
 * per-terminal `getTerminal` lookup. We list, filter to dev-typed by label
 * prefix ("Dev: ") as a fast path, then resolve roleId from the full record.
 */
async function findActiveDevTerminal(
  client: ReturnType<typeof getTowerClient>,
): Promise<DevTerminal | null> {
  const terminals = await client.listTerminals();
  // TowerTerminal doesn't expose `type` on listTerminals — fall back to
  // the "Dev: " label prefix we set on creation. Conservative: any future
  // dev consumer must use the same prefix.
  const candidates = terminals.filter((t) => t.label?.startsWith('Dev: '));
  if (candidates.length === 0) return null;
  // Pick the most recent (Tower returns newest first; we re-sort to be safe).
  const newest = [...candidates].sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1))[0];
  const roleId = newest.label.startsWith('Dev: ') ? newest.label.slice(5) : undefined;
  return { id: newest.id, roleId };
}

async function waitForTerminalGone(
  client: ReturnType<typeof getTowerClient>,
  terminalId: string,
): Promise<void> {
  const deadline = Date.now() + KILL_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const terminals = await client.listTerminals();
    if (!terminals.some((t) => t.id === terminalId)) return;
    await new Promise((r) => setTimeout(r, KILL_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Dev terminal ${terminalId} did not exit within ${KILL_WAIT_TIMEOUT_MS}ms. ` +
    'Check Tower or kill the process manually.',
  );
}

function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase().startsWith('y'));
    });
  });
}
