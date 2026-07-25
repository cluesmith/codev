/**
 * Tests for the migration-backup audit (#1239).
 *
 * Verifies that both leftover families are found (whole-directory home copies
 * and `*.pre-merge-*` renames), that age drives the stale flag, and that
 * unrelated entries are left alone.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  findMigrationBackups,
  formatMigrationBackup,
  formatBytes,
  totalBytes,
  STALE_BACKUP_AGE_DAYS,
} from '../lib/migration-backup-audit.js';

const NOW = new Date('2026-07-25T12:00:00Z');

/** Create a directory with one file in it, aged to `daysOld`. */
function makeAgedDir(parent: string, name: string, daysOld: number): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'global.db'), 'x'.repeat(4096));
  const mtime = new Date(NOW.getTime() - daysOld * 86_400_000);
  fs.utimesSync(dir, mtime, mtime);
  return dir;
}

/** Create a file aged to `daysOld`. */
function makeAgedFile(parent: string, name: string, daysOld: number): string {
  fs.mkdirSync(parent, { recursive: true });
  const file = path.join(parent, name);
  fs.writeFileSync(file, 'x'.repeat(1024));
  const mtime = new Date(NOW.getTime() - daysOld * 86_400_000);
  fs.utimesSync(file, mtime, mtime);
  return file;
}

describe('migration-backup-audit', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(tmpdir(), 'migration-backup-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('finds nothing in a clean home', () => {
    fs.mkdirSync(path.join(home, '.agent-farm'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agent-farm', 'global.db'), 'x');
    expect(findMigrationBackups({ home, now: NOW })).toEqual([]);
  });

  it('finds a dotted whole-directory home copy', () => {
    const dir = makeAgedDir(home, '.agent-farm.bak-20260702-113930', 23);
    const found = findMigrationBackups({ home, now: NOW });
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe(dir);
    expect(found[0].kind).toBe('home-copy');
    expect(found[0].ageDays).toBe(23);
    expect(found[0].stale).toBe(true);
  });

  it('finds undotted home copies from the #1118 consolidation', () => {
    makeAgedDir(home, 'agent-farm-db-backup-20260702-113930', 23);
    makeAgedDir(home, 'agent-farm-db-backup-premulti-20260702-115840', 23);
    const found = findMigrationBackups({ home, now: NOW });
    expect(found.map(b => path.basename(b.path)).sort()).toEqual([
      'agent-farm-db-backup-20260702-113930',
      'agent-farm-db-backup-premulti-20260702-115840',
    ]);
  });

  it('ignores the live agent-farm dir and unrelated entries', () => {
    fs.mkdirSync(path.join(home, '.agent-farm'), { recursive: true });
    makeAgedDir(home, 'Documents', 100);
    makeAgedDir(home, 'my-backups', 100);
    makeAgedDir(home, 'agent-farm-notes', 100);
    expect(findMigrationBackups({ home, now: NOW })).toEqual([]);
  });

  it('requires the agent-farm prefix, not just a backup marker', () => {
    // `my-backups/` in a real home must never be reported, let alone recommended
    // for `rm -rf`.
    makeAgedDir(home, 'my-backups', 100);
    makeAgedDir(home, 'Backup', 100);
    expect(findMigrationBackups({ home, now: NOW })).toEqual([]);
  });

  it('finds *.pre-merge-* renames inside the agent-farm home', () => {
    makeAgedFile(path.join(home, '.agent-farm'), 'state.db.pre-merge-20260702-113930', 23);
    const found = findMigrationBackups({ home, now: NOW });
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('pre-merge');
  });

  it('finds *.pre-merge-* renames inside the workspace .agent-farm', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(tmpdir(), 'migration-backup-ws-'));
    try {
      makeAgedFile(path.join(workspaceRoot, '.agent-farm'), 'state.db.pre-merge-20260702-113930', 30);
      makeAgedFile(path.join(workspaceRoot, '.agent-farm'), 'state.db.pre-merge-20260702-113930-wal', 30);
      const found = findMigrationBackups({ home, workspaceRoot, now: NOW });
      expect(found).toHaveLength(2);
      expect(found.every(b => b.kind === 'pre-merge')).toBe(true);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('does not scan a workspace when none is given', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(tmpdir(), 'migration-backup-ws-'));
    try {
      makeAgedFile(path.join(workspaceRoot, '.agent-farm'), 'state.db.pre-merge-1', 30);
      expect(findMigrationBackups({ home, workspaceRoot: null, now: NOW })).toEqual([]);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('marks backups stale only at or beyond the verification window', () => {
    makeAgedDir(home, '.agent-farm.bak-fresh', STALE_BACKUP_AGE_DAYS - 1);
    makeAgedDir(home, '.agent-farm.bak-due', STALE_BACKUP_AGE_DAYS);
    const found = findMigrationBackups({ home, now: NOW });
    const byName = Object.fromEntries(found.map(b => [path.basename(b.path), b]));
    expect(byName['.agent-farm.bak-fresh'].stale).toBe(false);
    expect(byName['.agent-farm.bak-due'].stale).toBe(true);
  });

  it('sorts newest first', () => {
    makeAgedDir(home, '.agent-farm.bak-old', 90);
    makeAgedDir(home, '.agent-farm.bak-new', 2);
    const found = findMigrationBackups({ home, now: NOW });
    expect(found.map(b => path.basename(b.path))).toEqual([
      '.agent-farm.bak-new',
      '.agent-farm.bak-old',
    ]);
  });

  it('measures size on disk', () => {
    makeAgedDir(home, '.agent-farm.bak-sized', 10);
    const found = findMigrationBackups({ home, now: NOW });
    expect(found[0].sizeBytes).toBeGreaterThan(0);
    expect(totalBytes(found)).toBe(found[0].sizeBytes);
  });

  it('treats unmeasurable backups as zero in the total', () => {
    expect(totalBytes([
      { path: '/a', kind: 'home-copy', ageDays: 9, sizeBytes: null, stale: true },
      { path: '/b', kind: 'home-copy', ageDays: 9, sizeBytes: 2048, stale: true },
    ])).toBe(2048);
  });

  it('formats bytes at human scale', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(18 * 1024 ** 3)).toBe('18.0 GB');
  });

  it('renders age and size, and says so when size is unknown', () => {
    expect(formatMigrationBackup({
      path: '/home/u/.agent-farm.bak-20260702-113930',
      kind: 'home-copy',
      ageDays: 23,
      sizeBytes: 18 * 1024 ** 3,
      stale: true,
    })).toBe('/home/u/.agent-farm.bak-20260702-113930 — 23 days old, 18.0 GB');

    expect(formatMigrationBackup({
      path: '/home/u/.agent-farm.bak-x',
      kind: 'home-copy',
      ageDays: 1,
      sizeBytes: null,
      stale: false,
    })).toBe('/home/u/.agent-farm.bak-x — 1 day old, size unknown');
  });
});
