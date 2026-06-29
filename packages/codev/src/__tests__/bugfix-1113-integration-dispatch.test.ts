/**
 * Wiring test for #1113: drives the real `consult --type integration` dispatch
 * (resolveArchitectQuery → resolveIntegrationBase → computeLocalPRDiff →
 * buildPRQuery) with a base override set, and asserts the query consumed the
 * locally-computed three-dot diff rather than `gh pr diff` (the PR's host base).
 *
 * The helper-level tests (bugfix-1113-integration-base.test.ts) prove the diff
 * math in isolation; this proves the command path is actually wired to it.
 *
 * The forge layer (PR metadata / `gh pr diff`) is stubbed so PR info, comments,
 * and the host-base diff are deterministic. `computeLocalPRDiff` uses real git
 * (node:child_process, NOT forge), so the three-dot diff is computed for real
 * against the fixture's ci-ahead-of-main topology.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Sentinel that only appears in the stubbed `gh pr diff` output — if it shows up
// in the diff file the model reads, the dispatch wrongly used the host base.
const GH_PR_DIFF_SENTINEL = 'GH_PR_DIFF_SENTINEL_must_not_be_used';

vi.mock('../lib/forge.js', () => ({
  executeForgeCommandSync: vi.fn((concept: string, env: Record<string, string>) => {
    if (concept === 'pr-search') {
      // findPRForIssue → PR #42, head `feature`, base `main` (the host base).
      return [{ number: 42, headRefName: 'feature', baseRefName: 'main' }];
    }
    if (concept === 'pr-view') {
      if (env?.CODEV_INCLUDE_COMMENTS) return '(No comments)';
      return JSON.stringify({ title: 'Test PR', state: 'OPEN' });
    }
    if (concept === 'pr-diff') {
      // Name-only: the ballooned host-base file set (includes ci-over-main files).
      if (env?.CODEV_DIFF_NAME_ONLY) return ['ci-big.txt', 'feature.txt', 'shared.txt'].join('\n');
      // Full `gh pr diff`: the host-base diff the fix must NOT use when --base is set.
      return `diff --git a/ci-big.txt b/ci-big.txt\n+${GH_PR_DIFF_SENTINEL}\n`;
    }
    return '';
  }),
}));

import { _resolveArchitectQuery as resolveArchitectQuery } from '../commands/consult/index.js';

function shell(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: 'pipe' });
}

describe('#1113 integration dispatch consumes the local three-dot diff (not gh pr diff)', () => {
  let workDir: string;
  let originDir: string;

  beforeEach(() => {
    originDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1113-disp-origin-'));
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1113-disp-work-'));

    execSync(`git init --bare -b main "${originDir}"`, { stdio: 'pipe' });
    execSync(`git clone "${originDir}" "${workDir}"`, { stdio: 'pipe' });
    shell('git config user.email "test@test.com"', workDir);
    shell('git config user.name "Test"', workDir);

    // main: baseline.
    fs.writeFileSync(path.join(workDir, 'shared.txt'), 'shared baseline\n');
    shell('git add shared.txt', workDir);
    shell('git commit -m "initial on main"', workDir);
    shell('git push origin main', workDir);

    // ci: integration branch, well ahead of main.
    shell('git checkout -b ci', workDir);
    fs.writeFileSync(
      path.join(workDir, 'ci-big.txt'),
      Array.from({ length: 500 }, (_, i) => `ci line ${i}`).join('\n') + '\n',
    );
    shell('git add ci-big.txt', workDir);
    shell('git commit -m "advance ci far ahead of main"', workDir);
    shell('git push origin ci', workDir);

    // feature: off ci, the actual PR change. PR #42 targets main on the host.
    shell('git checkout -b feature', workDir);
    fs.writeFileSync(path.join(workDir, 'feature.txt'), 'the actual PR change\n');
    shell('git add feature.txt', workDir);
    shell('git commit -m "feature work"', workDir);
    shell('git push origin feature', workDir);
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(originDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('--base ci anchors the diff on the integration branch end-to-end', () => {
    const query = resolveArchitectQuery(workDir, 'integration', {
      model: 'codex',
      type: 'integration',
      issue: '42',
      base: 'ci',
    });

    // Changed-files list is the local three-dot set (feature.txt only), NOT the
    // ballooned host-base name-only list (which also had ci-big.txt + shared.txt).
    expect(query).toContain('## Changed Files (1)');
    expect(query).toContain('- feature.txt');
    expect(query).not.toContain('- ci-big.txt');
    expect(query).not.toContain('- shared.txt');

    // The diff written to disk (what the reviewer reads) is the real local
    // three-dot diff, NOT the stubbed `gh pr diff` host-base output.
    const m = query.match(/\*\*Diff file\*\*: `([^`]+)`/);
    expect(m).toBeTruthy();
    const diffOnDisk = fs.readFileSync(m![1], 'utf-8');
    expect(diffOnDisk).toContain('the actual PR change');
    expect(diffOnDisk).not.toContain(GH_PR_DIFF_SENTINEL);
    expect(diffOnDisk).not.toContain('ci line 0'); // ci-over-main delta excluded
  });
});
