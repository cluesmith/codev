/**
 * Regression test for bugfix #1022: VSCode dev config must not walk the
 * builder worktree farm.
 *
 * Two repo-provided pieces collided: `.vscode/extensions.json` recommended
 * ms-vscode.extension-test-runner (whose test discovery runs
 * `rg --no-ignore --follow` over the whole tree), and `.vscode/settings.json`
 * had no watcher/search excludes for `.builders/` or `node_modules`. On a
 * workspace with ~15 builder worktrees this pegged CPU for ~30s at a time.
 *
 * Guards:
 * - extensions.json never re-recommends the test-runner extension
 * - settings.json keeps `.builders` and `node_modules` excluded from both
 *   the file watcher and search
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Resolve repo root (packages/codev -> repo root)
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

function readJson(relPath: string): Record<string, unknown> | null {
  const fullPath = path.join(repoRoot, relPath);
  if (!fs.existsSync(fullPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
}

describe('bugfix-1022: VSCode dev config excludes the builder worktree farm', () => {
  it('.vscode/extensions.json does not recommend ms-vscode.extension-test-runner', () => {
    const extensions = readJson('.vscode/extensions.json');
    expect(extensions, '.vscode/extensions.json must exist').not.toBeNull();

    const recommendations = (extensions!.recommendations ?? []) as string[];
    expect(recommendations).not.toContain('ms-vscode.extension-test-runner');
  });

  it('.vscode/settings.json excludes .builders and node_modules from watch and search', () => {
    const settings = readJson('.vscode/settings.json');
    expect(settings, '.vscode/settings.json must exist').not.toBeNull();

    for (const section of ['files.watcherExclude', 'search.exclude'] as const) {
      const excludes = settings![section] as Record<string, boolean> | undefined;
      expect(excludes, `${section} must be present`).toBeDefined();
      expect(excludes!['**/.builders/**'], `${section} must exclude **/.builders/**`).toBe(true);
      expect(excludes!['**/node_modules/**'], `${section} must exclude **/node_modules/**`).toBe(true);
    }
  });
});
