/**
 * Issue #1645 regression harness — the real OverviewCache, the real forge
 * layer and the shipped github concept scripts, against a fake `gh` on PATH
 * that is permanently rate-limited. Before the fix every poll re-spawned the
 * four list commands (≈200 spawns for 40 polls); after it: one batch of four,
 * then zero until the suspension lifts.
 *
 * Spec 1995: a default GitHub workspace takes the bundle path, where a batch is
 * one `gh api graphql`. The four-call batch is kept on a fallback workspace.
 * Both read their path from config on disk, so each asserts it first.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { dbState } = vi.hoisted(() => ({ dbState: { globalDbPath: '' } }));
vi.mock('../db/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/index.js')>();
  return { ...actual, getGlobalDbPath: () => dbState.globalDbPath };
});

import { OverviewCache } from '../servers/overview.js';
import { executeForgeCommandDetailed } from '../../lib/forge.js';
import { overviewPath } from '../../lib/github.js';

let tmpDir: string;
let callLog: string;
const originalPath = process.env.PATH;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bugfix-1645-'));
  dbState.globalDbPath = path.join(tmpDir, 'global.db');
  callLog = path.join(tmpDir, 'gh-calls.log');
  const bin = path.join(tmpDir, 'bin');
  fs.mkdirSync(bin);
  // `gh api user` (REST) succeeds; every GraphQL-backed command is rate-limited.
  // Only the subcommand is logged: a graphql query spans many lines.
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/bin/sh',
    `echo "$1 $2" >> "${callLog}"`,
    'if [ "$1 $2" = "api user" ]; then echo octocat; exit 0; fi',
    'echo "gh: API rate limit already exceeded for user ID 12345" >&2',
    'exit 1',
  ].join('\n'));
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
  // Each workspace's overview path comes from config on disk, and loadConfig
  // layers ~/.codev/config.json under the project. An empty fake home keeps a
  // developer's global forge section from choosing the path. os.homedir()
  // reads HOME on POSIX and USERPROFILE on Windows.
  const home = path.join(tmpDir, 'home');
  fs.mkdirSync(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterAll(() => {
  process.env.PATH = originalPath;
  restoreEnv('HOME', originalHome);
  restoreEnv('USERPROFILE', originalUserProfile);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const spawns = () => (fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf-8').trim().split('\n').filter(Boolean) : []);

/** A fresh workspace dir; `forge` is written as its `.codev/config.json` forge section. */
function makeWorkspace(name: string, forge?: Record<string, unknown>): string {
  const workspace = path.join(tmpDir, name);
  fs.mkdirSync(path.join(workspace, '.codev'), { recursive: true });
  if (forge) fs.writeFileSync(path.join(workspace, '.codev', 'config.json'), JSON.stringify({ forge }));
  fs.rmSync(callLog, { force: true });
  return workspace;
}

describe('Tower gh spawns under a rate-limited gh (#1645)', () => {
  it('bundle path: 40 dashboard polls spawn one graphql call and the identity call, then nothing until the suspension lifts (Spec 1995)', async () => {
    const workspace = makeWorkspace('bundle');
    expect(overviewPath(workspace)).toEqual({ kind: 'bundle' });
    let clock = Date.now();
    const cache = new OverviewCache({ now: () => clock });

    let data = await cache.getOverview(workspace);
    for (let i = 1; i < 40; i++) {
      clock += 2_500;
      data = await cache.getOverview(workspace);
    }
    expect(spawns().sort()).toEqual(['api graphql', 'api user']);
    expect(data.forgeStatus).toBe('rate-limited');
    expect(data.forgeResetAt).toBeDefined();
    expect(data.pendingPRs).toEqual([]);
    expect(data.errors?.prs).toMatch(/^gh rate limited until/);

    // Suspension over (no probe here → 15 min fallback): exactly one more bundle.
    clock += 15 * 60_000 + 1_000;
    await cache.getOverview(workspace);
    expect(spawns().sort()).toEqual(['api graphql', 'api graphql', 'api user']);
  });

  it('fallback workspace: 40 dashboard polls spawn one batch, then nothing until the suspension lifts', async () => {
    const workspace = makeWorkspace('fallback', { 'overview-bundle': null });
    expect(overviewPath(workspace)).toEqual({ kind: 'four-call', reason: 'forge config disables overview-bundle' });
    let clock = Date.now();
    const cache = new OverviewCache({ now: () => clock });

    let data = await cache.getOverview(workspace);
    for (let i = 1; i < 40; i++) {
      clock += 2_500;
      data = await cache.getOverview(workspace);
    }
    const batch = spawns();
    expect(batch).toHaveLength(5);
    expect(batch.filter(l => l.startsWith('api user'))).toHaveLength(1);
    expect(data.forgeStatus).toBe('rate-limited');
    expect(data.forgeResetAt).toBeDefined();
    expect(data.pendingPRs).toEqual([]);
    expect(data.errors?.prs).toMatch(/^gh rate limited until/);

    // Suspension over (no probe here → 15 min fallback): exactly one more batch.
    clock += 15 * 60_000 + 1_000;
    await cache.getOverview(workspace);
    expect(spawns()).toHaveLength(9);
  });

  it("github/pr-list propagates gh's exit status instead of jq's (POSIX sh has no pipefail)", async () => {
    const result = await executeForgeCommandDetailed('pr-list', {}, { cwd: tmpDir, forgeConfig: null });
    expect(result.data).toBeNull();
    expect(result.error?.exitCode).toBe(1);
    expect(result.error?.stderr).toContain('rate limit already exceeded');
  });
});
