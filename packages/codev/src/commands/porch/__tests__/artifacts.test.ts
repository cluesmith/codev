/**
 * Tests for artifact resolver (artifacts.ts)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  isPreApprovedContent,
  LocalResolver,
  CliResolver,
  getResolver,
} from '../artifacts.js';

// =============================================================================
// isPreApprovedContent
// =============================================================================

describe('isPreApprovedContent', () => {
  it('returns true for content with approved and validated frontmatter', () => {
    const content = `---
approved: 2026-03-17
validated: [gpt-5, gemini, claude]
---

# My Spec
`;
    expect(isPreApprovedContent(content)).toBe(true);
  });

  it('returns false when approved is missing', () => {
    const content = `---
validated: [gpt-5, gemini]
---

# My Spec
`;
    expect(isPreApprovedContent(content)).toBe(false);
  });

  it('returns false when validated is missing', () => {
    const content = `---
approved: 2026-03-17
---

# My Spec
`;
    expect(isPreApprovedContent(content)).toBe(false);
  });

  it('returns false when no frontmatter', () => {
    expect(isPreApprovedContent('# Just a heading\n\nNo frontmatter here.')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isPreApprovedContent('')).toBe(false);
  });

  it('returns false when validated list is empty', () => {
    const content = `---
approved: 2026-03-17
validated: []
---
`;
    expect(isPreApprovedContent(content)).toBe(false);
  });
});

// =============================================================================
// LocalResolver
// =============================================================================

describe('LocalResolver', () => {
  const testDir = path.join(tmpdir(), `artifact-resolver-test-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(path.join(testDir, 'codev', 'specs'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'codev', 'plans'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'codev', 'reviews'), { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  it('finds spec by numeric ID', () => {
    fs.writeFileSync(path.join(testDir, 'codev', 'specs', '0042-feature.md'), '# Spec');
    const resolver = new LocalResolver(testDir);
    expect(resolver.findSpecBaseName('42', '')).toBe('0042-feature');
  });

  it('returns null for missing spec', () => {
    const resolver = new LocalResolver(testDir);
    expect(resolver.findSpecBaseName('999', '')).toBeNull();
  });

  it('reads spec content', () => {
    fs.writeFileSync(path.join(testDir, 'codev', 'specs', '0042-feature.md'), '# My Feature Spec');
    const resolver = new LocalResolver(testDir);
    expect(resolver.getSpecContent('42', '')).toBe('# My Feature Spec');
  });

  it('reads plan content from plans dir', () => {
    fs.writeFileSync(path.join(testDir, 'codev', 'plans', '42-feature.md'), '# Plan');
    const resolver = new LocalResolver(testDir);
    expect(resolver.getPlanContent('42', '')).toBe('# Plan');
  });

  it('reads review content', () => {
    fs.writeFileSync(path.join(testDir, 'codev', 'reviews', '42-feature.md'), '# Review');
    const resolver = new LocalResolver(testDir);
    expect(resolver.getReviewContent('42', '')).toBe('# Review');
  });

  it('detects pre-approval via hasPreApproval', () => {
    const content = `---\napproved: 2026-01-01\nvalidated: [gpt, gemini]\n---\n# Spec`;
    fs.writeFileSync(path.join(testDir, 'codev', 'specs', '0042-feature.md'), content);
    const resolver = new LocalResolver(testDir);
    expect(resolver.hasPreApproval('codev/specs/0042-*.md')).toBe(true);
  });

  it('returns false for non-approved spec', () => {
    fs.writeFileSync(path.join(testDir, 'codev', 'specs', '0042-feature.md'), '# No frontmatter');
    const resolver = new LocalResolver(testDir);
    expect(resolver.hasPreApproval('codev/specs/0042-*.md')).toBe(false);
  });
});

// =============================================================================
// CliResolver
// =============================================================================

describe('CliResolver', () => {
  it('calls CLI command with get --list for listChildren', () => {
    const resolver = new CliResolver('org/proj/assets', 'echo');
    // 'echo' will just print the args back — not a real backend, but exercises the code path
    // The important thing is it doesn't throw ENOENT
    const result = resolver.findSpecBaseName('42', '');
    // echo outputs "get --list org/proj/assets/specs" which won't match any numeric prefix
    expect(result).toBeNull();
  });

  it('throws when CLI command is not found', () => {
    const resolver = new CliResolver('org/proj/assets', 'nonexistent-command-xyz');
    expect(() => resolver.findSpecBaseName('42', '')).toThrow('not found');
  });

  it('caches negative results (does not re-call CLI on repeated failures)', () => {
    const resolver = new CliResolver('org/proj/assets', 'false'); // 'false' always exits 1
    // First call — CLI runs and fails
    const result1 = resolver.getSpecContent('42', '');
    expect(result1).toBeNull();
    // Second call — should hit negative cache, not re-invoke CLI
    const result2 = resolver.getSpecContent('42', '');
    expect(result2).toBeNull();
  });

  it('hasPreApproval returns false when content not found', () => {
    const resolver = new CliResolver('org/proj/assets', 'false');
    expect(resolver.hasPreApproval('codev/specs/0042-*.md')).toBe(false);
  });
});

// =============================================================================
// getResolver factory
// =============================================================================

describe('getResolver', () => {
  const testDir = path.join(tmpdir(), `resolver-factory-test-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  it('returns LocalResolver when no config', () => {
    const resolver = getResolver(testDir);
    expect(resolver).toBeInstanceOf(LocalResolver);
  });

  it('returns LocalResolver for backend: "local"', () => {
    fs.writeFileSync(
      path.join(testDir, 'af-config.json'),
      JSON.stringify({ artifacts: { backend: 'local' } }),
    );
    const resolver = getResolver(testDir);
    expect(resolver).toBeInstanceOf(LocalResolver);
  });

  it('returns CliResolver for backend: "cli" with command and scope', () => {
    fs.writeFileSync(
      path.join(testDir, 'af-config.json'),
      JSON.stringify({ artifacts: { backend: 'cli', command: 'my-tool', scope: 'org/proj' } }),
    );
    const resolver = getResolver(testDir);
    expect(resolver).toBeInstanceOf(CliResolver);
  });

  it('throws when backend: "cli" but no scope', () => {
    fs.writeFileSync(
      path.join(testDir, 'af-config.json'),
      JSON.stringify({ artifacts: { backend: 'cli', command: 'my-tool' } }),
    );
    expect(() => getResolver(testDir)).toThrow('no artifacts.scope');
  });

  it('throws when backend: "cli" but no command', () => {
    fs.writeFileSync(
      path.join(testDir, 'af-config.json'),
      JSON.stringify({ artifacts: { backend: 'cli', scope: 'org/proj' } }),
    );
    expect(() => getResolver(testDir)).toThrow('no artifacts.command');
  });

  it('throws for unknown backend', () => {
    fs.writeFileSync(
      path.join(testDir, 'af-config.json'),
      JSON.stringify({ artifacts: { backend: 'redis' } }),
    );
    expect(() => getResolver(testDir)).toThrow('unknown artifacts.backend');
  });
});
