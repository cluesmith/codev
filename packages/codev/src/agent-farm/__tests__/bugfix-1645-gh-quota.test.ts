/**
 * Issue #1645 regression harness — the real OverviewCache, the real forge
 * layer and the shipped github concept scripts, against a fake `gh` on PATH
 * that is permanently rate-limited. Before the fix every poll re-spawned the
 * four list commands (≈200 spawns for 40 polls); after it: one batch, then zero
 * until the suspension lifts.
 *
 * Spec 1647: the default GitHub workspace fetches through one `overview-bundle`
 * call, so its batch is one `gh api graphql` plus the REST identity call. The
 * four-call twin (`overview-bundle: null`) keeps #1645's original batch of five.
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

let tmpDir: string;
let callLog: string;
const originalPath = process.env.PATH;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bugfix-1645-'));
  dbState.globalDbPath = path.join(tmpDir, 'global.db');
  callLog = path.join(tmpDir, 'gh-calls.log');
  const bin = path.join(tmpDir, 'bin');
  fs.mkdirSync(bin);
  // `gh api user` (REST) succeeds; every GraphQL-backed command is rate-limited.
  // Only the subcommand is logged: the bundle's query text spans many lines.
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/bin/sh',
    `echo "$1 $2" >> "${callLog}"`,
    'if [ "$1 $2" = "api user" ]; then echo octocat; exit 0; fi',
    'echo "gh: API rate limit already exceeded for user ID 12345" >&2',
    'exit 1',
  ].join('\n'));
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
});

afterAll(() => {
  process.env.PATH = originalPath;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const spawns = () => (fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf-8').trim().split('\n').filter(Boolean) : []);

/** A fresh workspace (and a fresh spawn log), optionally with a forge section. */
function workspace(name: string, forge?: Record<string, string | null>): string {
  fs.rmSync(callLog, { force: true });
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(path.join(dir, '.codev'), { recursive: true });
  if (forge) fs.writeFileSync(path.join(dir, '.codev', 'config.json'), JSON.stringify({ forge }));
  return dir;
}

describe('Tower gh spawns under a rate-limited gh (#1645)', () => {
  it('40 dashboard polls at 2.5 s spawn one bundle and one identity call, then nothing until the suspension lifts', async () => {
    const ws = workspace('bundled');
    let clock = Date.now();
    const cache = new OverviewCache({ now: () => clock });

    let data = await cache.getOverview(ws);
    for (let i = 1; i < 40; i++) {
      clock += 2_500;
      data = await cache.getOverview(ws);
    }
    // The bundle's first request fails, so its invocation is one gh process.
    expect(spawns()).toEqual(expect.arrayContaining(['api graphql', 'api user']));
    expect(spawns()).toHaveLength(2);
    expect(data.forgeStatus).toBe('rate-limited');
    expect(data.forgeResetAt).toBeDefined();
    expect(data.pendingPRs).toEqual([]);
    expect(data.errors?.prs).toMatch(/^gh rate limited until/);
    expect(data.errors?.issues).toMatch(/^gh rate limited until/);

    // Suspension over (no probe here → 15 min fallback): exactly one more bundle.
    clock += 15 * 60_000 + 1_000;
    await cache.getOverview(ws);
    expect(spawns()).toHaveLength(3);
    expect(spawns()[2]).toBe('api graphql');
  });

  it('four-call twin (overview-bundle: null): one batch of five, then nothing until the suspension lifts', async () => {
    const ws = workspace('four-call', { 'overview-bundle': null });
    let clock = Date.now();
    const cache = new OverviewCache({ now: () => clock });

    let data = await cache.getOverview(ws);
    for (let i = 1; i < 40; i++) {
      clock += 2_500;
      data = await cache.getOverview(ws);
    }
    const batch = spawns();
    expect(batch).toHaveLength(5);
    expect(batch.filter(l => l.startsWith('api user'))).toHaveLength(1);
    expect(data.forgeStatus).toBe('rate-limited');
    expect(data.forgeResetAt).toBeDefined();
    expect(data.pendingPRs).toEqual([]);
    expect(data.errors?.prs).toMatch(/^gh rate limited until/);

    clock += 15 * 60_000 + 1_000;
    await cache.getOverview(ws);
    expect(spawns()).toHaveLength(9);
  });

  it("github/pr-list propagates gh's exit status instead of jq's (POSIX sh has no pipefail)", async () => {
    const result = await executeForgeCommandDetailed('pr-list', {}, { cwd: tmpDir, forgeConfig: null });
    expect(result.data).toBeNull();
    expect(result.error?.exitCode).toBe(1);
    expect(result.error?.stderr).toContain('rate limit already exceeded');
  });
});
