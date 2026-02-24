/**
 * Tests for cleanup command — status.yaml preservation (Bugfix #532)
 *
 * cleanupPorchState should preserve status.yaml in project directories
 * so project history (protocol, timing, gates) survives cleanup for analytics.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';

/**
 * Re-implement cleanupPorchState logic for testing.
 * Mirrors the updated cleanup.ts without requiring git or shell side effects.
 */
async function cleanupPorchState(
  projectId: string,
  codevDir: string,
): Promise<void> {
  const projectsDir = path.join(codevDir, 'projects');

  if (!fs.existsSync(projectsDir)) {
    return;
  }

  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(`${projectId}-`)) {
      const projectDir = path.join(projectsDir, entry.name);
      const children = fs.readdirSync(projectDir);

      // Delete review artifacts but preserve status.yaml
      for (const child of children) {
        if (child === 'status.yaml') continue;
        await rm(path.join(projectDir, child), { recursive: true, force: true });
      }

      // If no status.yaml, remove the empty directory
      const hasStatus = children.includes('status.yaml');
      if (!hasStatus) {
        await rm(projectDir, { recursive: true, force: true });
      }
    }
  }
}

function createTestDir(): string {
  const dir = path.join(
    tmpdir(),
    `cleanup-status-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('Cleanup — status.yaml preservation (Bugfix #532)', () => {
  let testDir: string;
  let codevDir: string;

  beforeEach(() => {
    testDir = createTestDir();
    codevDir = path.join(testDir, 'codev');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('preserves status.yaml while deleting review artifacts', async () => {
    const projectDir = path.join(codevDir, 'projects', 'bugfix-42-login-spaces');
    fs.mkdirSync(projectDir, { recursive: true });

    // Create status.yaml and review artifacts
    fs.writeFileSync(path.join(projectDir, 'status.yaml'), 'id: bugfix-42\nphase: complete\n');
    fs.writeFileSync(path.join(projectDir, 'bugfix-42-fix-iter1-gemini.txt'), 'VERDICT: APPROVE');
    fs.writeFileSync(path.join(projectDir, 'bugfix-42-fix-iter1-codex.txt'), 'VERDICT: APPROVE');
    fs.writeFileSync(path.join(projectDir, 'bugfix-42-fix-iter1-context.md'), 'context');

    await cleanupPorchState('bugfix-42', codevDir);

    // status.yaml must survive
    expect(fs.existsSync(path.join(projectDir, 'status.yaml'))).toBe(true);
    // Review artifacts must be deleted
    expect(fs.existsSync(path.join(projectDir, 'bugfix-42-fix-iter1-gemini.txt'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'bugfix-42-fix-iter1-codex.txt'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'bugfix-42-fix-iter1-context.md'))).toBe(false);
    // Directory must still exist
    expect(fs.existsSync(projectDir)).toBe(true);
  });

  it('removes directory entirely when no status.yaml exists', async () => {
    const projectDir = path.join(codevDir, 'projects', 'bugfix-99-no-status');
    fs.mkdirSync(projectDir, { recursive: true });

    // Only review artifacts, no status.yaml
    fs.writeFileSync(path.join(projectDir, 'bugfix-99-fix-iter1-gemini.txt'), 'VERDICT: APPROVE');

    await cleanupPorchState('bugfix-99', codevDir);

    // Entire directory should be removed
    expect(fs.existsSync(projectDir)).toBe(false);
  });

  it('handles project directory with only status.yaml', async () => {
    const projectDir = path.join(codevDir, 'projects', '0073-feature-auth');
    fs.mkdirSync(projectDir, { recursive: true });

    fs.writeFileSync(path.join(projectDir, 'status.yaml'), 'id: "0073"\nphase: complete\n');

    await cleanupPorchState('0073', codevDir);

    // status.yaml and directory must survive
    expect(fs.existsSync(path.join(projectDir, 'status.yaml'))).toBe(true);
    expect(fs.existsSync(projectDir)).toBe(true);
  });

  it('does not affect other project directories', async () => {
    const target = path.join(codevDir, 'projects', 'bugfix-42-login');
    const other = path.join(codevDir, 'projects', 'bugfix-99-other');
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(other, { recursive: true });

    fs.writeFileSync(path.join(target, 'status.yaml'), 'id: bugfix-42');
    fs.writeFileSync(path.join(target, 'review.txt'), 'artifact');
    fs.writeFileSync(path.join(other, 'status.yaml'), 'id: bugfix-99');
    fs.writeFileSync(path.join(other, 'review.txt'), 'artifact');

    await cleanupPorchState('bugfix-42', codevDir);

    // Target: status.yaml preserved, review deleted
    expect(fs.existsSync(path.join(target, 'status.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'review.txt'))).toBe(false);
    // Other: completely untouched
    expect(fs.existsSync(path.join(other, 'status.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(other, 'review.txt'))).toBe(true);
  });

  it('handles non-existent projects directory gracefully', async () => {
    // No projects dir created — should not throw
    await expect(cleanupPorchState('bugfix-42', codevDir)).resolves.toBeUndefined();
  });

  it('preserves status.yaml with nested subdirectories', async () => {
    const projectDir = path.join(codevDir, 'projects', '0104-custom-session');
    const subDir = path.join(projectDir, 'nested-artifacts');
    fs.mkdirSync(subDir, { recursive: true });

    fs.writeFileSync(path.join(projectDir, 'status.yaml'), 'id: "0104"\nphase: complete\n');
    fs.writeFileSync(path.join(subDir, 'deep-review.txt'), 'content');

    await cleanupPorchState('0104', codevDir);

    expect(fs.existsSync(path.join(projectDir, 'status.yaml'))).toBe(true);
    expect(fs.existsSync(subDir)).toBe(false);
  });
});
