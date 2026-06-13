/**
 * Issue #1012 — cold-tier governance files (arch.md, lessons-learned.md) materialized
 * into projects on init/adopt/update with minimal placeholder content. Companion to the
 * Spec 987 hot-tier materialization; mirrors its test shape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createColdTierDefaults, COLD_TIER_STARTERS } from '../lib/scaffold.js';
import { isUserDataPath } from '../lib/templates.js';

const COLD_TIER_FILES = Object.keys(COLD_TIER_STARTERS);

describe('issue #1012 — createColdTierDefaults', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-mat-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('creates both cold files into codev/resources/, creating the dir', () => {
    const target = path.join(tmp, 'proj');
    const result = createColdTierDefaults(target);
    expect(result.created.sort()).toEqual([...COLD_TIER_FILES].sort());
    for (const f of COLD_TIER_FILES) {
      expect(fs.existsSync(path.join(target, 'codev', 'resources', f))).toBe(true);
    }
  });

  it('writes the placeholder marker so the file is clearly a stub to replace', () => {
    const target = path.join(tmp, 'proj');
    createColdTierDefaults(target);
    const res = path.join(target, 'codev', 'resources');
    expect(fs.readFileSync(path.join(res, 'arch.md'), 'utf-8')).toContain('_No architecture documented yet._');
    expect(fs.readFileSync(path.join(res, 'lessons-learned.md'), 'utf-8')).toContain('_No lessons captured yet._');
  });

  it('skip-existing preserves a curated copy', () => {
    const target = path.join(tmp, 'proj');
    const res = path.join(target, 'codev', 'resources');
    fs.mkdirSync(res, { recursive: true });
    fs.writeFileSync(path.join(res, 'arch.md'), 'MY CURATED CONTENT');

    const result = createColdTierDefaults(target, { skipExisting: true });
    expect(result.skipped).toContain('arch.md');
    expect(result.created).toContain('lessons-learned.md');
    // Curated content untouched.
    expect(fs.readFileSync(path.join(res, 'arch.md'), 'utf-8')).toBe('MY CURATED CONTENT');
  });
});

describe('issue #1012 — cold files are protected user data', () => {
  it('treats the cold files as user data (never overwritten by update)', () => {
    expect(isUserDataPath('resources/arch.md')).toBe(true);
    expect(isUserDataPath('resources/lessons-learned.md')).toBe(true);
  });
});

// Integration: `codev update` on a project lacking the cold files must backfill them,
// while never clobbering a customized one. Mirrors the hot-tier update integration test.
describe('issue #1012 — codev update backfills cold files', () => {
  let originalCwd: string;
  let projectDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-update-'));
    fs.mkdirSync(path.join(projectDir, 'codev'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Codev\n\nKEEP_USER_CONTENT');
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# Codev\n\nKEEP_USER_CONTENT');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('creates missing cold files and reports them in newFiles', async () => {
    process.chdir(projectDir);
    const { update } = await import('../commands/update.js');
    const result = await update();

    for (const f of COLD_TIER_FILES) {
      expect(fs.existsSync(path.join(projectDir, 'codev', 'resources', f)), `${f} created`).toBe(true);
      expect(result.newFiles).toContain(`codev/resources/${f}`);
    }
  });

  it('leaves a customized cold file byte-identical while backfilling the missing sibling', async () => {
    const res = path.join(projectDir, 'codev', 'resources');
    fs.mkdirSync(res, { recursive: true });
    fs.writeFileSync(path.join(res, 'arch.md'), 'MY CURATED ARCH');

    process.chdir(projectDir);
    const { update } = await import('../commands/update.js');
    const result = await update();

    expect(fs.readFileSync(path.join(res, 'arch.md'), 'utf-8')).toBe('MY CURATED ARCH');
    expect(result.newFiles).not.toContain('codev/resources/arch.md');
    expect(fs.existsSync(path.join(res, 'lessons-learned.md'))).toBe(true);
    expect(result.newFiles).toContain('codev/resources/lessons-learned.md');
  });

  it('--dry-run writes nothing', async () => {
    process.chdir(projectDir);
    const { update } = await import('../commands/update.js');
    await update({ dryRun: true });

    for (const f of COLD_TIER_FILES) {
      expect(fs.existsSync(path.join(projectDir, 'codev', 'resources', f)), `${f} not created in dry-run`).toBe(false);
    }
  });
});
