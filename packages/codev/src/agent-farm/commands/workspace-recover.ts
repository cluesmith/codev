// workspace recover — revive builders whose shellper died (e.g. machine reboot).
// Issue #829. Dry-run by default; --apply actually respawns.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';

import { getConfig } from '../utils/index.js';
import { logger } from '../utils/logger.js';
import { buildAgentName, stripLeadingZeros } from '../utils/agent-names.js';
import { processExists, getTerminalSessionsForWorkspace } from '../servers/tower-terminals.js';
import { closeGlobalDb } from '../db/index.js';
import { lookupBuilderSpawningArchitect } from '../state.js';
import { listAllProjects } from '../../commands/porch/state.js';
import type { ProjectState } from '../../commands/porch/types.js';
import type { DbTerminalSession } from '../servers/tower-types.js';
import { confirm } from '../../lib/cli-prompts.js';

const TERMINAL_PHASES = new Set(['verified', 'complete']);
const DEFAULT_MAX_AGE_DAYS = 7;

// Protocols that `afx spawn <id> --resume --protocol <name>` can revive cleanly:
// issue-driven families with a positional issue arg and a stable worktree layout.
// `experiment` / `maintain` / `task` / bare protocol-mode builders can't be
// resumed by ID through spawn.ts and are skipped with `unsupported_protocol`.
// (Legacy `spider` is also excluded — it was retired long ago, and any stray
// project still carrying that protocol value should be treated as unsupported.)
const REVIVABLE_PROTOCOLS = new Set(['spir', 'aspir', 'air', 'pir', 'bugfix']);

export interface WorkspaceRecoverOptions {
  apply?: boolean;
  maxAge?: number;
  includeStale?: boolean;
  yes?: boolean;
}

export type IneligibleReason =
  | 'terminal'
  | 'unsupported_protocol'
  | 'worktree_missing'
  | 'shellper_alive'
  | 'stale';

export type EligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: IneligibleReason };

export interface EligibilityInputs {
  state: ProjectState;
  builderInfo: BuilderInfo | null;
  sessions: DbTerminalSession[];
  worktreeExists: boolean;
  ageDays: number;
  maxAgeDays: number;
  includeStale: boolean;
  isProcessAlive: (pid: number) => boolean;
  socketExists: (socket: string) => boolean;
}

/**
 * Liveness rule per row (Gemini cmap finding):
 *   - shellper_pid known + alive → ALIVE
 *   - shellper_pid known + dead  → DEAD (socket is ignored; the OS doesn't clean
 *                                   ~/.codev/run/ on reboot, so a stale socket
 *                                   would otherwise falsely mark the row alive
 *                                   and defeat the primary recovery use case)
 *   - shellper_pid null + socket file exists → ALIVE (legacy / pre-PID rows)
 *   - shellper_pid null + no socket → DEAD
 */
function isSessionAlive(
  session: DbTerminalSession,
  isProcessAlive: (pid: number) => boolean,
  socketExists: (socket: string) => boolean,
): boolean {
  if (session.shellper_pid !== null) {
    return isProcessAlive(session.shellper_pid);
  }
  return session.shellper_socket !== null && socketExists(session.shellper_socket);
}

/**
 * Pure predicate — no I/O. All filesystem and process probes happen in the
 * caller and are passed in via `isProcessAlive` and `socketExists`. This keeps
 * the predicate trivially unit-testable.
 *
 * On terminal_sessions and the "no row" case:
 *   Tower's reconciliation deletes terminal_sessions rows whose shellper can't
 *   be reconnected (tower-terminals.ts:485-711). That runs on Tower startup,
 *   which is exactly what happens between a machine reboot and the user
 *   invoking `workspace recover`. By the time recovery runs, the rows for
 *   dead builders have already been pruned. So "no matching session row"
 *   is the COMMON case for any builder that needs revival — not a reason to
 *   skip. The row is only useful here as a positive "still alive" signal.
 *
 * Predicate order (cheap structural checks first):
 *   1. terminal phase
 *   2. unsupported protocol family
 *   3. worktree missing on disk
 *   4. any matching session row is alive  → known still running, leave alone
 *   5. stale (older than maxAge, unless includeStale)
 *   6. otherwise → revive
 */
export function evaluateEligibility(inputs: EligibilityInputs): EligibilityResult {
  const {
    state, builderInfo, sessions, worktreeExists, ageDays, maxAgeDays, includeStale,
    isProcessAlive, socketExists,
  } = inputs;

  if (TERMINAL_PHASES.has(state.phase)) {
    return { eligible: false, reason: 'terminal' };
  }
  if (builderInfo === null) {
    return { eligible: false, reason: 'unsupported_protocol' };
  }
  if (!worktreeExists) {
    return { eligible: false, reason: 'worktree_missing' };
  }
  // If ANY matching session looks alive, treat the builder as alive. Duplicates
  // can occur when a prior recovery left a dead row behind (terminal_sessions
  // has no UNIQUE constraint on role_id) — the cautious read is "alive."
  if (sessions.some(s => isSessionAlive(s, isProcessAlive, socketExists))) {
    return { eligible: false, reason: 'shellper_alive' };
  }
  if (!includeStale && ageDays > maxAgeDays) {
    return { eligible: false, reason: 'stale' };
  }
  return { eligible: true };
}

export interface BuilderInfo {
  builderId: string;
  issueArg: string;
  cliProtocol: string;
  /**
   * The architect recorded in global.db as having spawned this builder
   * (Issue #1140). Null for legacy / pre-Spec-755 rows with no recorded
   * value, or when no builders row exists. `deriveBuilderInfo` is pure and
   * always sets null; `deriveBuilderInfoWithArchitect` enriches from the DB.
   */
  spawnedByArchitect: string | null;
}

/**
 * Derive the inputs needed to invoke `afx spawn <issueArg> --resume --protocol <cliProtocol>`
 * and the SQLite `role_id` to look up the builder's terminal session.
 *
 * Returns null for protocols that cannot be cleanly resumed via the spawn CLI
 * (experiment/maintain/task/legacy spider/etc) — callers should skip those
 * projects with an `unsupported_protocol` reason.
 */
export function deriveBuilderInfo(state: ProjectState): BuilderInfo | null {
  if (!REVIVABLE_PROTOCOLS.has(state.protocol)) {
    return null;
  }
  if (state.protocol === 'bugfix') {
    const numericId = state.id.replace(/^bugfix-/, '');
    return {
      builderId: buildAgentName('bugfix', numericId),
      issueArg: numericId,
      cliProtocol: 'bugfix',
      spawnedByArchitect: null,
    };
  }
  return {
    builderId: buildAgentName('spec', state.id, state.protocol),
    issueArg: stripLeadingZeros(state.id),
    cliProtocol: state.protocol,
    spawnedByArchitect: null,
  };
}

/**
 * Enrich the derived builder info with the spawning-architect name recorded in
 * global.db (Issue #1140). Without this, respawned builders inherit the
 * recovery shell's CODEV_ARCHITECT_NAME and every builder in a sibling-architect
 * workspace gets reattributed to whichever architect ran `workspace recover`.
 *
 * The lookup is injected so the function stays unit-testable without a real
 * database, matching `evaluateEligibility`'s isProcessAlive/socketExists style.
 * A three-valued lookup result (string / null legacy row / undefined no row)
 * collapses to string-or-null: both null and undefined mean "no recorded
 * architect" and fall back to the caller's env at respawn time.
 */
export function deriveBuilderInfoWithArchitect(
  state: ProjectState,
  lookupArchitect: (builderId: string) => string | null | undefined,
): BuilderInfo | null {
  const base = deriveBuilderInfo(state);
  if (base === null) return null;
  return { ...base, spawnedByArchitect: lookupArchitect(base.builderId) ?? null };
}

/**
 * Resolve the builder's worktree path on disk, handling both the Spec-653
 * ID-only layout and the legacy title-suffixed form.
 *
 * Returns null when the project's protocol isn't revivable (no defined worktree
 * naming) or when no matching directory exists.
 */
export function resolveWorktreePath(buildersDir: string, state: ProjectState): string | null {
  const info = deriveBuilderInfo(state);
  if (info === null) return null;

  const idOnlyName = `${info.cliProtocol}-${info.issueArg}`;
  const idOnlyPath = join(buildersDir, idOnlyName);
  if (existsSync(idOnlyPath) && existsSync(join(idOnlyPath, '.git'))) {
    return idOnlyPath;
  }

  if (!existsSync(buildersDir)) return null;
  const prefix = `${info.cliProtocol}-${info.issueArg}-`;
  for (const entry of readdirSync(buildersDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const candidate = join(buildersDir, entry.name);
    if (existsSync(join(candidate, '.git'))) return candidate;
  }
  return null;
}

export function formatRelativeAge(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms) || ms < 0) return '—';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  // Round UP rather than down so the label aligns with --max-age semantics:
  // anything strictly older than 24h prints as "2d ago" (not "1d ago"), so
  // a row labelled "1d ago" is actually within --max-age 1 (≤ 24h exact).
  // Use ms rather than the floored `hours` to preserve sub-hour precision —
  // 24h + 1s must ceil to 2 days, not 1.
  const days = Math.ceil(ms / 86_400_000);
  return `${days}d ago`;
}

function reasonLabel(reason: IneligibleReason): string {
  switch (reason) {
    case 'terminal': return 'terminal';
    case 'unsupported_protocol': return 'unsupported protocol';
    case 'worktree_missing': return 'worktree missing';
    case 'shellper_alive': return 'shellper alive';
    case 'stale': return 'stale';
  }
}

interface RecoverRow {
  state: ProjectState;
  builderInfo: BuilderInfo | null;
  worktreePath: string | null;
  eligibility: EligibilityResult;
  ageDays: number;
}

function printPreview(rows: RecoverRow[]): void {
  const widths = [6, 9, 12, 14, 10, 20];
  logger.row(['ID', 'PROTOCOL', 'PHASE', 'UPDATED', 'STATUS', 'REASON'], widths);
  logger.row(['─'.repeat(6), '─'.repeat(9), '─'.repeat(12), '─'.repeat(14), '─'.repeat(10), '─'.repeat(20)], widths);
  for (const row of rows) {
    const status = row.eligibility.eligible
      ? chalk.green('revive')
      : chalk.gray('skip');
    const reason = row.eligibility.eligible ? '—' : reasonLabel(row.eligibility.reason);
    logger.row(
      [
        row.state.id,
        row.state.protocol,
        row.state.phase,
        formatRelativeAge(row.state.updated_at),
        status,
        reason,
      ],
      widths,
    );
  }
}

/**
 * Build the child environment for the respawn invocation (Issue #1140).
 *
 * spawn.ts derives the new builder row's `spawned_by_architect` from
 * CODEV_ARCHITECT_NAME, so the recorded architect must be forced into the
 * child env or the respawned builder gets reattributed to the recovery
 * shell's architect. When no architect was recorded (legacy rows), the base
 * env passes through untouched, which reproduces the pre-fix behavior for
 * those rows only (spawn.ts still defaults absent/blank values to 'main').
 */
export function respawnEnv(
  spawnedByArchitect: string | null,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (spawnedByArchitect === null) {
    return baseEnv;
  }
  return { ...baseEnv, CODEV_ARCHITECT_NAME: spawnedByArchitect };
}

async function respawnBuilder(info: BuilderInfo): Promise<void> {
  // Use the current node binary and CLI entry point so the respawn invocation
  // matches the install method this command was started under (npm global,
  // npx, dev script, etc.) instead of relying on PATH lookup of 'afx'.
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [process.argv[1], 'spawn', info.issueArg, '--resume', '--protocol', info.cliProtocol],
      { stdio: 'inherit', env: respawnEnv(info.spawnedByArchitect, process.env) },
    );
    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`afx spawn exited with code ${code}`));
    });
  });
}

export async function workspaceRecover(options: WorkspaceRecoverOptions = {}): Promise<void> {
  const config = getConfig();
  const maxAgeDays = options.maxAge ?? DEFAULT_MAX_AGE_DAYS;
  const includeStale = options.includeStale ?? false;
  const apply = options.apply ?? false;

  logger.header(`Workspace Recover${apply ? '' : ' (dry-run)'}`);
  logger.kv('Workspace', config.workspaceRoot);
  if (!includeStale) logger.kv('Max age', `${maxAgeDays} day(s)`);
  logger.blank();

  const projects = listAllProjects(config.workspaceRoot, {
    onParseError: (statusPath, err) => {
      logger.debug(`Skipped unparseable ${statusPath}: ${err instanceof Error ? err.message : String(err)}`);
    },
  });
  if (projects.length === 0) {
    logger.info('No porch projects found.');
    return;
  }

  // All global.db reads (terminal sessions + per-builder architect lookups)
  // happen inside this try so the connection is closed before any child
  // `afx spawn` process is launched.
  let allRows: RecoverRow[];
  try {
    const sessions = getTerminalSessionsForWorkspace(config.workspaceRoot);
    // role_id has no UNIQUE constraint in the schema, so collect every matching
    // row per builder id rather than collapsing to last-write-wins.
    const sessionsByRoleId = new Map<string, DbTerminalSession[]>();
    for (const s of sessions) {
      if (s.type !== 'builder' || !s.role_id) continue;
      const bucket = sessionsByRoleId.get(s.role_id);
      if (bucket) bucket.push(s);
      else sessionsByRoleId.set(s.role_id, [s]);
    }

    allRows = projects.map(({ state }) => {
      const builderInfo = deriveBuilderInfoWithArchitect(
        state,
        (builderId) => lookupBuilderSpawningArchitect(builderId, config.workspaceRoot),
      );
      const matchingSessions = builderInfo ? sessionsByRoleId.get(builderInfo.builderId) ?? [] : [];
      const worktreePath = resolveWorktreePath(config.buildersDir, state);
      const ageDays = (Date.now() - Date.parse(state.updated_at)) / 86_400_000;
      const eligibility = evaluateEligibility({
        state, builderInfo,
        sessions: matchingSessions,
        worktreeExists: worktreePath !== null,
        ageDays, maxAgeDays, includeStale,
        isProcessAlive: processExists,
        socketExists: existsSync,
      });
      return { state, builderInfo, worktreePath, eligibility, ageDays };
    });
  } finally {
    closeGlobalDb();
  }

  // By default the preview hides projects beyond the recency window — for a
  // large workspace the stale tail dominates the table and obscures the few
  // rows the operator actually cares about. --include-stale shows everything.
  const visibleRows = includeStale
    ? allRows
    : allRows.filter(r => r.ageDays <= maxAgeDays);
  const hiddenStaleCount = allRows.length - visibleRows.length;

  printPreview(visibleRows);
  if (hiddenStaleCount > 0) {
    logger.blank();
    logger.info(`${hiddenStaleCount} project(s) older than ${maxAgeDays} day(s) hidden. Pass --include-stale to show them.`);
  }

  const eligible = allRows.filter(
    (r): r is RecoverRow & { builderInfo: BuilderInfo; eligibility: { eligible: true } } =>
      r.eligibility.eligible && r.builderInfo !== null,
  );
  logger.blank();
  if (hiddenStaleCount > 0) {
    logger.kv('Eligible', `${eligible.length} / ${visibleRows.length} visible (${allRows.length} scanned)`);
  } else {
    logger.kv('Eligible', `${eligible.length} / ${allRows.length}`);
  }

  if (eligible.length === 0) {
    logger.info(apply ? 'Nothing to revive.' : 'Nothing would be revived.');
    return;
  }

  if (!apply) {
    logger.info(`Run with --apply to respawn ${eligible.length} builder(s).`);
    return;
  }

  if (!options.yes) {
    const proceed = await confirm(`Proceed to respawn ${eligible.length} builder(s)?`, false);
    if (!proceed) {
      logger.info('Aborted.');
      return;
    }
  }

  let succeeded = 0;
  let failed = 0;
  for (const row of eligible) {
    logger.blank();
    logger.info(`Respawning ${row.builderInfo.builderId} (issue ${row.builderInfo.issueArg}, ${row.builderInfo.cliProtocol})...`);
    try {
      await respawnBuilder(row.builderInfo);
      succeeded++;
    } catch (err) {
      failed++;
      logger.error(`Failed to respawn ${row.builderInfo.builderId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  logger.blank();
  logger.kv('Respawned', String(succeeded));
  if (failed > 0) {
    logger.kv('Failed', String(failed));
    process.exit(1);
  }
}
