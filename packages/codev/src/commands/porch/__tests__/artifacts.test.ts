/**
 * Tests for ArtifactResolver — LocalResolver, CliResolver, getResolver factory.
 * Spec 612 / TICK-001: v3.0.0 config integration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  LocalResolver,
  CliResolver,
  getResolver,
  isPreApprovedContent,
} from '../artifacts.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-test-'));
}

function writeFile(dir: string, relPath: string, content: string): void {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// isPreApprovedContent
// ---------------------------------------------------------------------------

describe('isPreApprovedContent', () => {
  it('returns true for content with approved + validated frontmatter', () => {
    const content = `---
approved: 2026-01-01
validated: [gemini, codex, claude]
---

# Spec`;
    expect(isPreApprovedContent(content)).toBe(true);
  });

  it('returns false when no frontmatter', () => {
    expect(isPreApprovedContent('# Spec\n\nNo frontmatter')).toBe(false);
  });

  it('returns false when missing validated field', () => {
    const content = `---
approved: 2026-01-01
---

# Spec`;
    expect(isPreApprovedContent(content)).toBe(false);
  });

  it('returns false when missing approved field', () => {
    const content = `---
validated: [gemini, codex, claude]
---

# Spec`;
    expect(isPreApprovedContent(content)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LocalResolver
// ---------------------------------------------------------------------------

describe('LocalResolver', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTmp();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('findSpecBaseName: finds spec by numeric ID (leading zeros stripped)', () => {
    writeFile(tmpDir, 'codev/specs/42-my-feature.md', '# Spec');
    const resolver = new LocalResolver(tmpDir);
    expect(resolver.findSpecBaseName('042', 'my-feature')).toBe('42-my-feature');
  });

  it('findSpecBaseName: returns null when no spec matches', () => {
    fs.mkdirSync(path.join(tmpDir, 'codev', 'specs'), { recursive: true });
    const resolver = new LocalResolver(tmpDir);
    expect(resolver.findSpecBaseName('99', '')).toBeNull();
  });

  it('getSpecContent: returns spec file content', () => {
    writeFile(tmpDir, 'codev/specs/1-feature.md', '# Feature Spec');
    const resolver = new LocalResolver(tmpDir);
    expect(resolver.getSpecContent('1', 'feature')).toBe('# Feature Spec');
  });

  it('getSpecContent: returns null when spec missing', () => {
    fs.mkdirSync(path.join(tmpDir, 'codev', 'specs'), { recursive: true });
    const resolver = new LocalResolver(tmpDir);
    expect(resolver.getSpecContent('999', 'missing')).toBeNull();
  });

  it('getPlanContent: reads from legacy codev/plans/', () => {
    writeFile(tmpDir, 'codev/plans/7-my-plan.md', '# Plan');
    const resolver = new LocalResolver(tmpDir);
    expect(resolver.getPlanContent('7', 'my-plan')).toBe('# Plan');
  });

  it('hasPreApproval: returns true for pre-approved spec', () => {
    const content = `---\napproved: 2026-01-01\nvalidated: [gemini, codex, claude]\n---\n\n# Spec`;
    writeFile(tmpDir, 'codev/specs/5-feature.md', content);
    const resolver = new LocalResolver(tmpDir);
    // Use a glob pattern
    expect(resolver.hasPreApproval('codev/specs/5-feature.md')).toBe(true);
  });

  it('hasPreApproval: returns false when spec lacks frontmatter', () => {
    writeFile(tmpDir, 'codev/specs/6-plain.md', '# Plain Spec');
    const resolver = new LocalResolver(tmpDir);
    expect(resolver.hasPreApproval('codev/specs/6-plain.md')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CliResolver
// ---------------------------------------------------------------------------

describe('CliResolver', () => {
  it('hasPreApproval: returns false when glob pattern lacks ID', () => {
    const resolver = new CliResolver('org/project', 'nonexistent-command-xyzzy');
    // Returns false early — no CLI call needed when pattern has no ID
    expect(resolver.hasPreApproval('codev/specs/no-id-here.md')).toBe(false);
  });

  it('hasPreApproval: throws when CLI command is not installed', () => {
    const resolver = new CliResolver('org/project', 'nonexistent-command-xyzzy');
    expect(() => resolver.hasPreApproval('codev/specs/0042-*.md')).toThrow("not found");
  });

  it('findSpecBaseName: throws when CLI command is not installed', () => {
    const resolver = new CliResolver('org/project', 'nonexistent-command-xyzzy');
    expect(() => resolver.findSpecBaseName('42', 'feature')).toThrow("not found");
  });
});

// ---------------------------------------------------------------------------
// getResolver factory
// ---------------------------------------------------------------------------

describe('getResolver', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTmp();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns LocalResolver when no config exists', () => {
    const resolver = getResolver(tmpDir);
    expect(resolver).toBeInstanceOf(LocalResolver);
  });

  it('returns LocalResolver when artifacts.backend is "local"', () => {
    writeFile(tmpDir, '.codev/config.json', JSON.stringify({
      artifacts: { backend: 'local' },
    }));
    const resolver = getResolver(tmpDir);
    expect(resolver).toBeInstanceOf(LocalResolver);
  });

  it('returns CliResolver when artifacts.backend is "cli"', () => {
    writeFile(tmpDir, '.codev/config.json', JSON.stringify({
      artifacts: { backend: 'cli', scope: 'org/project', command: 'my-tool' },
    }));
    const resolver = getResolver(tmpDir);
    expect(resolver).toBeInstanceOf(CliResolver);
  });

  it('returns CliResolver when artifacts.backend is "fava-trails" (alias)', () => {
    writeFile(tmpDir, '.codev/config.json', JSON.stringify({
      artifacts: { backend: 'fava-trails', scope: 'org/project' },
    }));
    const resolver = getResolver(tmpDir);
    expect(resolver).toBeInstanceOf(CliResolver);
  });

  it('throws when cli backend has no scope', () => {
    writeFile(tmpDir, '.codev/config.json', JSON.stringify({
      artifacts: { backend: 'cli' },
    }));
    expect(() => getResolver(tmpDir)).toThrow('.codev/config.json');
    expect(() => getResolver(tmpDir)).toThrow('scope');
  });

  it('throws for unknown backend', () => {
    writeFile(tmpDir, '.codev/config.json', JSON.stringify({
      artifacts: { backend: 'unknown-backend' },
    }));
    expect(() => getResolver(tmpDir)).toThrow('unknown artifacts.backend');
  });

  it('throws when af-config.json is present (v3.0.0 hard error)', () => {
    writeFile(tmpDir, 'af-config.json', JSON.stringify({
      artifacts: { backend: 'cli', scope: 'org/project' },
    }));
    expect(() => getResolver(tmpDir)).toThrow('af-config.json is no longer supported');
  });
});
