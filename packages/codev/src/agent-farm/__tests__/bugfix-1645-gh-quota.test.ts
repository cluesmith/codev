/**
 * Issue #1645 regression harness — the real OverviewCache, the real forge
 * layer and the shipped github concept scripts, against a fake `gh` on PATH
 * that is permanently rate-limited. Before the fix every poll re-spawned the
 * four list commands (≈200 spawns for 40 polls); after it: one batch of four,
 * then zero until the suspension lifts.
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
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/bin/sh',
    `echo "$*" >> "${callLog}"`,
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

describe('Tower gh spawns under a rate-limited gh (#1645)', () => {
  it('40 dashboard polls at 2.5 s spawn one batch, then nothing until the suspension lifts', async () => {
    const workspace = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspace);
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
