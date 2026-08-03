/**
 * Integration test for Issue #1338, phase_2: a builder spawn whose workspace
 * selects the retired gemini harness must fail closed at the spawn() dispatcher
 * BEFORE any worktree / porch / db state is created — leaving nothing behind.
 *
 * This drives the REAL spawn() entry point against a REAL temp workspace and the
 * REAL config loader (no harness/config mocks), so it protects the actual
 * invariant: the preflight runs above every state-creating handler. `createWorktree`
 * itself resolves the builder harness, so a guard placed below dispatch would
 * orphan a half-built worktree — this test would catch that regression.
 *
 * Tower/GitHub are never reached: the retirement throws before the dispatcher
 * hands off to a handler, so no server mocks are needed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { spawn } from '../commands/spawn.js';

describe('spawn retirement preflight (#1338)', () => {
  let ws: string;
  let originalCwd: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalHome = process.env.HOME;
    ws = mkdtempSync(join(tmpdir(), 'spawn-retire-'));
    const git = (c: string) => execSync(c, { cwd: ws, stdio: 'pipe' });
    git('git init -q');
    git('git config user.email test@test.local');
    git('git config user.name Test');
    git('git config commit.gpgsign false');
    mkdirSync(join(ws, 'codev'), { recursive: true });
    writeFileSync(join(ws, 'codev', '.keep'), '');
    git('git add codev/.keep');
    git('git commit -q -m init');
    // Isolate HOME so a developer's global ~/.codev/config.json cannot mask the
    // workspace's gemini builder config through the shared config loader.
    process.env.HOME = ws;
    // spawn() resolves the workspace from process.cwd().
    process.chdir(ws);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(ws, { recursive: true, force: true });
  });

  function writeBuilderHarness(harness: string): void {
    mkdirSync(join(ws, '.codev'), { recursive: true });
    writeFileSync(join(ws, '.codev', 'config.json'), JSON.stringify({ shell: { builderHarness: harness } }));
  }

  it('rejects a gemini builder spawn with the retirement and creates NO state', async () => {
    writeBuilderHarness('gemini');

    await expect(spawn({ protocol: 'maintain', force: true })).rejects.toThrow(/retired/i);

    // The preflight aborts above ensureDirectories / createWorktree / initPorch:
    // no worktree and no porch project may exist afterward.
    const builders = existsSync(join(ws, '.builders')) ? readdirSync(join(ws, '.builders')) : [];
    const porch = existsSync(join(ws, 'codev', 'projects')) ? readdirSync(join(ws, 'codev', 'projects')) : [];
    expect(builders).toEqual([]);
    expect(porch).toEqual([]);
  });
});
