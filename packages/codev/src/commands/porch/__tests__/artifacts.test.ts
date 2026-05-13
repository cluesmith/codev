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
  matchesProjectId,
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

  it('returns true for YAML block list format (validated with dashes)', () => {
    const content = `---
approved: 2026-01-01
validated:
  - gemini
  - codex
  - claude
---

# Spec`;
    expect(isPreApprovedContent(content)).toBe(true);
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

  it('throws when cli backend has no command', () => {
    writeFile(tmpDir, '.codev/config.json', JSON.stringify({
      artifacts: { backend: 'cli', scope: 'org/project' },
    }));
    expect(() => getResolver(tmpDir)).toThrow('no artifacts.command');
  });

  it('throws when cli backend has no scope', () => {
    writeFile(tmpDir, '.codev/config.json', JSON.stringify({
      artifacts: { backend: 'cli', command: 'my-tool' },
    }));
    expect(() => getResolver(tmpDir)).toThrow('no artifacts.scope');
  });

  it('rejects fava-trails as unknown backend', () => {
    writeFile(tmpDir, '.codev/config.json', JSON.stringify({
      artifacts: { backend: 'fava-trails', scope: 'org/project' },
    }));
    expect(() => getResolver(tmpDir)).toThrow('unknown artifacts.backend');
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

// ---------------------------------------------------------------------------
// matchesProjectId (Issue 691 — fix prefix-N project ID resolution)
// ---------------------------------------------------------------------------

describe('matchesProjectId', () => {
  describe('numeric project IDs (SPIR / ASPIR / AIR)', () => {
    it('matches a file whose leading digits equal the (zero-stripped) ID', () => {
      expect(matchesProjectId('0073-feature-name.md', '0073')).toBe(true);
      expect(matchesProjectId('0073-feature-name.md', '73')).toBe(true);
      expect(matchesProjectId('73-feature-name.md', '0073')).toBe(true);
    });

    it('matches a directory name (no .md suffix)', () => {
      expect(matchesProjectId('0073-feature-name', '0073')).toBe(true);
    });

    it('rejects a different numeric ID', () => {
      expect(matchesProjectId('0073-feature-name.md', '0074')).toBe(false);
    });

    it('rejects a filename without leading digits', () => {
      expect(matchesProjectId('feature-name.md', '0073')).toBe(false);
    });
  });

  describe('prefix-N project IDs (BUGFIX / PIR / future issue-driven)', () => {
    it('matches a file whose name starts with <prefix>-<N>-', () => {
      expect(matchesProjectId('pir-1099-fix-avatar.md', 'pir-1099')).toBe(true);
      expect(matchesProjectId('bugfix-237-stale-cache.md', 'bugfix-237')).toBe(true);
    });

    it('matches a directory name (no .md suffix)', () => {
      expect(matchesProjectId('pir-1099-fix-avatar', 'pir-1099')).toBe(true);
    });

    it('matches when filename equals the project ID exactly (no slug)', () => {
      expect(matchesProjectId('pir-1099.md', 'pir-1099')).toBe(true);
      expect(matchesProjectId('pir-1099', 'pir-1099')).toBe(true);
    });

    it('rejects a different prefix', () => {
      expect(matchesProjectId('bugfix-1099-foo.md', 'pir-1099')).toBe(false);
    });

    it('rejects a different number', () => {
      expect(matchesProjectId('pir-1099-foo.md', 'pir-1100')).toBe(false);
    });

    it('rejects a filename where the ID is a prefix but not delimited by -', () => {
      // "pir-1099foo.md" should NOT match "pir-1099" — the next char must be "-" or end.
      expect(matchesProjectId('pir-1099foo.md', 'pir-1099')).toBe(false);
    });

    it('does not confuse numeric and prefixed matching', () => {
      // A numeric ID should not match a prefix-N filename.
      expect(matchesProjectId('pir-1099-foo.md', '1099')).toBe(false);
      expect(matchesProjectId('pir-1099-foo.md', '0073')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// LocalResolver — prefix-N project ID support (Issue 691)
// ---------------------------------------------------------------------------

describe('LocalResolver — prefix-N project IDs (bugfix)', () => {
  // PIR was historically in this group but aligned with SPIR's numeric
  // convention in commit dc177c83. These tests exercise the prefix-N path
  // that is still load-bearing for BUGFIX (and any future issue-driven
  // protocol that opts for a prefix-N ID).
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTmp();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getPlanContent finds a prefix-N plan file (bugfix-style)', () => {
    writeFile(
      tmpDir,
      'codev/plans/bugfix-237-stale-cache.md',
      '# Plan: stale cache\n',
    );

    const resolver = new LocalResolver(tmpDir);
    const content = resolver.getPlanContent('bugfix-237', 'stale-cache');
    expect(content).toContain('# Plan: stale cache');
  });

  it('getReviewContent finds a prefix-N review file (bugfix-style)', () => {
    writeFile(
      tmpDir,
      'codev/reviews/bugfix-237-stale-cache.md',
      '# Review: stale cache\n',
    );

    const resolver = new LocalResolver(tmpDir);
    const content = resolver.getReviewContent('bugfix-237', 'stale-cache');
    expect(content).toContain('# Review: stale cache');
  });

  it('returns null for a missing prefix-N plan', () => {
    fs.mkdirSync(path.join(tmpDir, 'codev', 'plans'), { recursive: true });

    const resolver = new LocalResolver(tmpDir);
    expect(resolver.getPlanContent('bugfix-9999', 'nothing-here')).toBeNull();
  });

  it('does not match a prefix-N plan when looking up a numeric ID with the same digits', () => {
    // Regression guard: "bugfix-237-foo.md" must NOT be returned for projectId="237".
    writeFile(
      tmpDir,
      'codev/plans/bugfix-237-stale.md',
      '# Plan: bugfix stale cache\n',
    );

    const resolver = new LocalResolver(tmpDir);
    expect(resolver.getPlanContent('237', '')).toBeNull();
  });

  it('still works for numeric project IDs (SPIR / ASPIR / AIR / PIR)', () => {
    writeFile(
      tmpDir,
      'codev/plans/0073-user-auth.md',
      '# Plan: user auth\n',
    );

    const resolver = new LocalResolver(tmpDir);
    expect(resolver.getPlanContent('0073', 'user-auth')).toContain('# Plan: user auth');
    expect(resolver.getPlanContent('73', 'user-auth')).toContain('# Plan: user auth');
  });

  it('finds a PIR plan file by bare numeric ID (post-dc177c83 convention)', () => {
    writeFile(
      tmpDir,
      'codev/plans/1298-fix-native-social-login.md',
      '# Plan: fix social login\n',
    );

    const resolver = new LocalResolver(tmpDir);
    const content = resolver.getPlanContent('1298', 'fix-native-social-login');
    expect(content).toContain('# Plan: fix social login');
  });

  it('finds a PIR review file by bare numeric ID (post-dc177c83 convention)', () => {
    writeFile(
      tmpDir,
      'codev/reviews/1298-fix-native-social-login.md',
      '# Review: fix social login\n',
    );

    const resolver = new LocalResolver(tmpDir);
    const content = resolver.getReviewContent('1298', 'fix-native-social-login');
    expect(content).toContain('# Review: fix social login');
  });
});
