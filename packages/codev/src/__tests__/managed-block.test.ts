/**
 * Spec 987 — Phase 3: interactive hot-tier managed block in CLAUDE.md / AGENTS.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  HOT_BLOCK_BEGIN,
  HOT_BLOCK_END,
  renderHotContextBlock,
  upsertHotContextBlock,
  syncHotContextBlock,
} from '../lib/managed-block.js';

function seedHotFiles(root: string, archBody = 'ARCH_HOT_MARKER', lessonsBody = 'LESSONS_HOT_MARKER'): void {
  const dir = path.join(root, 'codev', 'resources');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'arch-critical.md'), `# arch\n\n${archBody}\n`);
  fs.writeFileSync(path.join(dir, 'lessons-critical.md'), `# lessons\n\n${lessonsBody}\n`);
}

describe('Spec 987 — managed block (pure upsert logic)', () => {
  const BLOCK = `${HOT_BLOCK_BEGIN}\nfresh content\n${HOT_BLOCK_END}`;

  it('inserts after the first H1 when no markers exist, preserving user content', () => {
    const doc = '# Title\n\nUser intro.\n\n## Section\nbody';
    const out = upsertHotContextBlock(doc, BLOCK);
    expect(out).toContain(HOT_BLOCK_BEGIN);
    expect(out).toContain('User intro.');
    expect(out).toContain('## Section');
    // Block sits between the H1 and the user intro.
    expect(out.indexOf('# Title')).toBeLessThan(out.indexOf(HOT_BLOCK_BEGIN));
    expect(out.indexOf(HOT_BLOCK_BEGIN)).toBeLessThan(out.indexOf('User intro.'));
  });

  it('replaces an existing block in place, preserving content before and after', () => {
    const doc = `# Title\n\n${HOT_BLOCK_BEGIN}\nOLD\n${HOT_BLOCK_END}\n\nAfter text.`;
    const out = upsertHotContextBlock(doc, BLOCK);
    expect(out).toContain('fresh content');
    expect(out).not.toContain('OLD');
    expect(out).toContain('# Title');
    expect(out).toContain('After text.');
    // Exactly one block (no duplication).
    expect(out.split(HOT_BLOCK_BEGIN).length - 1).toBe(1);
  });

  it('is idempotent — upserting twice equals upserting once', () => {
    const doc = '# Title\n\nbody';
    const once = upsertHotContextBlock(doc, BLOCK);
    const twice = upsertHotContextBlock(once, BLOCK);
    expect(twice).toBe(once);
  });

  it('prepends at the top when the doc has no H1', () => {
    const doc = 'no heading here';
    const out = upsertHotContextBlock(doc, BLOCK);
    expect(out.startsWith(HOT_BLOCK_BEGIN)).toBe(true);
    expect(out).toContain('no heading here');
  });

  it('leaves the doc untouched when there is no block to inject', () => {
    const doc = '# Title\n\nbody';
    expect(upsertHotContextBlock(doc, '')).toBe(doc);
  });
});

describe('Spec 987 — managed block (render + sync into root docs)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-block-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('renders a marker-delimited block carrying both hot files', () => {
    seedHotFiles(tmp);
    const block = renderHotContextBlock(tmp);
    expect(block.startsWith(HOT_BLOCK_BEGIN)).toBe(true);
    expect(block.trimEnd().endsWith(HOT_BLOCK_END)).toBe(true);
    expect(block).toContain('ARCH_HOT_MARKER');
    expect(block).toContain('LESSONS_HOT_MARKER');
  });

  it('injects an identical block into both CLAUDE.md and AGENTS.md; skips missing docs', () => {
    seedHotFiles(tmp);
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# Codev\n\nproject instructions');
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), '# Codev\n\nproject instructions');

    const changed = syncHotContextBlock(tmp);
    expect(changed.sort()).toEqual(['AGENTS.md', 'CLAUDE.md']);

    const claude = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf-8');
    const agents = fs.readFileSync(path.join(tmp, 'AGENTS.md'), 'utf-8');
    // Both carry the block and remain byte-identical (the CLAUDE.md ≡ AGENTS.md invariant).
    expect(claude).toContain('ARCH_HOT_MARKER');
    expect(claude).toContain('project instructions');
    expect(claude).toBe(agents);

    // A workspace without AGENTS.md only updates CLAUDE.md.
    fs.rmSync(path.join(tmp, 'AGENTS.md'));
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# Codev\n\nfresh');
    expect(syncHotContextBlock(tmp)).toEqual(['CLAUDE.md']);
  });

  it('refreshes the block when a hot file changes, preserving user edits outside it', () => {
    seedHotFiles(tmp, 'ARCH_V1');
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# Codev\n\nKEEP_ME_ABOVE\n\n## More\nKEEP_ME_BELOW');
    syncHotContextBlock(tmp);

    // Edit the hot file and re-sync.
    fs.writeFileSync(path.join(tmp, 'codev', 'resources', 'arch-critical.md'), '# arch\n\nARCH_V2\n');
    const changed = syncHotContextBlock(tmp);
    expect(changed).toEqual(['CLAUDE.md']);

    const claude = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf-8');
    expect(claude).toContain('ARCH_V2');
    expect(claude).not.toContain('ARCH_V1');
    expect(claude).toContain('KEEP_ME_ABOVE');
    expect(claude).toContain('KEEP_ME_BELOW');
    // Still exactly one block.
    expect(claude.split(HOT_BLOCK_BEGIN).length - 1).toBe(1);
  });
});
