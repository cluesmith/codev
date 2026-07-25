/**
 * Migration-backup audit for `codev doctor` (issue #1239).
 *
 * State migrations leave copies of the pre-migration state behind and nothing
 * ever removes them. A disk audit on 2026-07-25 found an 18 GB
 * `~/.agent-farm.bak-*` directory still on disk three weeks after the migration
 * that created it — a full copy of the agent-farm dir, dominated by the logs it
 * duplicated.
 *
 * Two leftover families exist:
 *
 *  1. `~/{.,}agent-farm*bak*` — whole-directory copies of the agent-farm home,
 *     taken by hand during the #1118 state consolidation. These are the big
 *     ones (they include `logs/`).
 *  2. `*.pre-merge-<timestamp>` — the source `state.db` (plus `-wal`/`-shm`
 *     sidecars) that `db/consolidate.ts` renames rather than deletes after
 *     merging it into `global.db`. Small, but equally unreaped.
 *
 * This module reports; it never deletes. These are multi-gigabyte copies of the
 * user's own state, and the decision to remove them is the human's. Doctor
 * prints age + size + the exact `rm -rf` command so that decision is one
 * paste away.
 */

import { readdirSync, lstatSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * A leftover is only worth nagging about once the migration that produced it
 * has demonstrably held up. Below this age it is reported informationally;
 * at or above it, doctor counts it as a warning.
 */
export const STALE_BACKUP_AGE_DAYS = 7;

export type MigrationBackupKind = 'home-copy' | 'pre-merge';

export interface MigrationBackup {
  /** Absolute path to the leftover file or directory. */
  path: string;
  kind: MigrationBackupKind;
  /** Whole days since last modification. */
  ageDays: number;
  /** Size on disk in bytes, or null when it could not be measured. */
  sizeBytes: number | null;
  /** True once `ageDays >= STALE_BACKUP_AGE_DAYS`. */
  stale: boolean;
}

/**
 * Matches a hand-taken whole-directory copy of the agent-farm home.
 *
 * Requires BOTH an `agent-farm` prefix (so an unrelated `my-backups/` is never
 * touched) and a backup marker. The marker spelling has varied across the
 * migrations that produced these — `.agent-farm.bak-<ts>` and
 * `agent-farm-db-backup-<ts>` are both real — so match `bak` and `back` alike.
 * The live `.agent-farm` itself has no separator after the prefix and is never
 * matched.
 */
function isHomeCopy(name: string): boolean {
  return /^\.?agent-farm[.-]/i.test(name) && /bac?k/i.test(name);
}

/** Matches the `*.pre-merge-<timestamp>` renames left by db/consolidate.ts. */
function isPreMerge(name: string): boolean {
  return name.includes('.pre-merge-');
}

/**
 * Measure a path's size on disk with `du -sk`.
 *
 * A recursive Node walk would stat tens of thousands of log files on exactly
 * the multi-GB directories this audit exists to find, so shell out instead.
 * Returns null (reported as "size unknown") when `du` is unavailable or times
 * out — never a guessed number.
 */
function measureBytes(path: string): number | null {
  const result = spawnSync('du', ['-sk', path], { encoding: 'utf-8', timeout: 20000 });
  if (result.status !== 0 || !result.stdout) return null;
  const kb = parseInt(result.stdout.trim().split(/\s+/)[0], 10);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

/** Human-readable byte size, e.g. `18.0 GB`. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

function inspect(
  path: string,
  kind: MigrationBackupKind,
  now: number
): MigrationBackup | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    // Vanished between readdir and lstat — nothing to report.
    return null;
  }
  const ageDays = Math.floor((now - stat.mtimeMs) / 86_400_000);
  return {
    path,
    kind,
    ageDays,
    sizeBytes: measureBytes(path),
    stale: ageDays >= STALE_BACKUP_AGE_DAYS,
  };
}

function scanDir(
  dir: string,
  match: (name: string) => boolean,
  kind: MigrationBackupKind,
  now: number
): MigrationBackup[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // Unreadable directory (permissions) — not something doctor should fail on.
    return [];
  }
  const found: MigrationBackup[] = [];
  for (const name of names) {
    if (!match(name)) continue;
    const entry = inspect(join(dir, name), kind, now);
    if (entry) found.push(entry);
  }
  return found;
}

export interface FindMigrationBackupsOptions {
  /** Home directory to scan. Defaults to the real home; overridable for tests. */
  home?: string;
  /** Workspace root whose `.agent-farm/` is scanned for `*.pre-merge-*`. */
  workspaceRoot?: string | null;
  /** Reference time for age computation. Defaults to now. */
  now?: Date;
}

/**
 * Find every migration leftover on disk, newest first.
 *
 * Scans the home directory for whole-directory copies, and both the agent-farm
 * home (`~/.agent-farm/`) and the workspace's `.agent-farm/` for `*.pre-merge-*`
 * renames. Read-only; safe to call unconditionally.
 */
export function findMigrationBackups(
  options: FindMigrationBackupsOptions = {}
): MigrationBackup[] {
  const home = options.home ?? homedir();
  const now = (options.now ?? new Date()).getTime();

  const backups = [
    ...scanDir(home, isHomeCopy, 'home-copy', now),
    ...scanDir(join(home, '.agent-farm'), isPreMerge, 'pre-merge', now),
  ];

  if (options.workspaceRoot) {
    backups.push(
      ...scanDir(join(options.workspaceRoot, '.agent-farm'), isPreMerge, 'pre-merge', now)
    );
  }

  return backups.sort((a, b) => a.ageDays - b.ageDays);
}

/** One-line doctor rendering: path, age, size. */
export function formatMigrationBackup(backup: MigrationBackup): string {
  const age = backup.ageDays === 1 ? '1 day old' : `${backup.ageDays} days old`;
  const size = backup.sizeBytes === null ? 'size unknown' : formatBytes(backup.sizeBytes);
  return `${backup.path} — ${age}, ${size}`;
}

/** Total measured bytes across a set of leftovers (unmeasurable ones count 0). */
export function totalBytes(backups: MigrationBackup[]): number {
  return backups.reduce((sum, b) => sum + (b.sizeBytes ?? 0), 0);
}
