/**
 * Spec 987 — Phase 4: hot-tier files materialized into projects via an explicit
 * wired-in step (init/adopt/update), NOT the dead copyResourceTemplates.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { copyHotTierDefaults, HOT_TIER_FILES } from '../lib/scaffold.js';
import { isUserDataPath } from '../lib/templates.js';
import { HOT_BLOCK_BEGIN } from '../lib/managed-block.js';

describe('Spec 987 — copyHotTierDefaults', () => {
  let tmp: string;
  let skeleton: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-mat-'));
    skeleton = path.join(tmp, 'skeleton');
    fs.mkdirSync(path.join(skeleton, 'templates'), { recursive: true });
    for (const f of HOT_TIER_FILES) {
      fs.writeFileSync(path.join(skeleton, 'templates', f), `# ${f}\n\nSTARTER ${f}\n`);
    }
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('copies both hot files into codev/resources/, creating the dir', () => {
    const target = path.join(tmp, 'proj');
    const result = copyHotTierDefaults(target, skeleton);
    expect(result.copied.sort()).toEqual([...HOT_TIER_FILES].sort());
    for (const f of HOT_TIER_FILES) {
      expect(fs.existsSync(path.join(target, 'codev', 'resources', f))).toBe(true);
    }
  });

  it('skip-existing preserves a curated copy', () => {
    const target = path.join(tmp, 'proj');
    const res = path.join(target, 'codev', 'resources');
    fs.mkdirSync(res, { recursive: true });
    fs.writeFileSync(path.join(res, 'arch-critical.md'), 'MY CURATED CONTENT');

    const result = copyHotTierDefaults(target, skeleton, { skipExisting: true });
    expect(result.skipped).toContain('arch-critical.md');
    expect(result.copied).toContain('lessons-critical.md');
    // Curated content untouched.
    expect(fs.readFileSync(path.join(res, 'arch-critical.md'), 'utf-8')).toBe('MY CURATED CONTENT');
  });
});

describe('Spec 987 — hot files are protected user data', () => {
  it('treats the hot files as user data (never overwritten by update)', () => {
    expect(isUserDataPath('resources/arch-critical.md')).toBe(true);
    expect(isUserDataPath('resources/lessons-critical.md')).toBe(true);
  });
});

// Combined integration: `codev update` on a project lacking BOTH the hot files and
// the managed-block markers must create both (the dead-code trap the plan-iter1 CMAP
// surfaced). Uses the real package skeleton (built) as the template source.
describe('Spec 987 — codev update materializes hot files + injects the block', () => {
  let originalCwd: string;
  let projectDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-update-'));
    fs.mkdirSync(path.join(projectDir, 'codev'), { recursive: true });
    // Root docs exist but have NEITHER hot files NOR markers — the existing-adopter case.
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

  it('creates the hot files and inserts the block, preserving user content', async () => {
    process.chdir(projectDir);
    const { update } = await import('../commands/update.js');
    const result = await update();

    // Hot files created locally.
    for (const f of HOT_TIER_FILES) {
      expect(fs.existsSync(path.join(projectDir, 'codev', 'resources', f)), `${f} created`).toBe(true);
      expect(result.newFiles).toContain(`codev/resources/${f}`);
    }

    // Block injected into both root docs; user content preserved; docs identical.
    const claude = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    const agents = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf-8');
    expect(claude).toContain(HOT_BLOCK_BEGIN);
    expect(claude).toContain('KEEP_USER_CONTENT');
    expect(claude).toBe(agents);

    // #1119: the block carries @import lines, not a verbatim copy of the hot files.
    expect(claude).toContain('@codev/resources/arch-critical.md');
    expect(claude).toContain('@codev/resources/lessons-critical.md');
    // The hot files' own structural marker would only appear if content were inlined.
    expect(claude).not.toContain('<!-- HOT tier:');
  });
});
