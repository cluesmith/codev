/**
 * Regression tests for the agy auth-state pre-flight cache (Issue #1077).
 *
 * The bug: an unauthenticated `agy` opens an OAuth browser tab *before* printing
 * the OAuth URL that the gemini lane detects, so post-spawn detection cannot stop
 * the tab. A CMAP burst is N separate consult processes, so N tabs landed
 * (12-15 observed in the wild).
 *
 * The lane's guarantee, pinned below: across a burst against an unauthenticated
 * agy, **agy is spawned at most once per TTL window**. Every other call decides
 * from the shared filesystem cache and never spawns.
 *
 * These tests use a fake `agy` (via `CODEV_AGY_BIN`) that records every
 * invocation to a log file — so "did we spawn?" is asserted against observed
 * process starts, not mocks. Because the cache and lock live entirely on disk,
 * concurrent in-process calls exercise exactly the same coordination path that
 * separate `consult` processes do.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  checkCachedAgyAuth,
  recordAgyAuthState,
  clearAgyAuthCache,
  preflightAgyAuth,
  waitForAgyAuthState,
  agyAuthCacheDir,
} from '../agy-auth-cache.js';
import { _runAgyConsultation } from '../index.js';

/** Env keys this suite manipulates; restored wholesale after each test. */
const ENV_KEYS = [
  'CODEV_AGY_BIN',
  'CODEV_AGY_AUTH_CACHE_DIR',
  'CODEV_AGY_AUTH_CACHE_DISABLE',
  'CODEV_AGY_AUTH_CACHE_TTL_UNAUTH_MS',
  'CODEV_AGY_AUTH_CACHE_TTL_AUTH_MS',
  'CODEV_AGY_AUTH_CACHE_WAIT_MS',
  'FAKE_AGY_LOG',
  'FAKE_AGY_MODE',
] as const;

let dir: string;
let savedEnv: Record<string, string | undefined>;

/** Absolute path of the fake agy binary for the current test. */
let fakeAgy: string;
/** File the fake agy appends to on every invocation. */
let spawnLog: string;

/**
 * A stand-in for the `agy` CLI. `FAKE_AGY_MODE=unauth` reproduces the upstream
 * behaviour this issue is about: print the OAuth banner, then sit there waiting
 * for an interactive login that can never complete headlessly.
 */
const FAKE_AGY_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_AGY_LOG, process.pid + '\\n');
if (process.argv[2] === '--version') { console.log('1.0.10-fake'); process.exit(0); }
if (process.env.FAKE_AGY_MODE === 'unauth') {
  process.stderr.write('Please visit https://accounts.google.com/o/oauth2/auth?client_id=fake\\n');
  setTimeout(() => process.exit(1), 30000);   // hang like real agy; the lane kills us
} else {
  process.stdout.write('---\\nVERDICT: APPROVE\\nSUMMARY: ok\\nCONFIDENCE: HIGH\\n---\\n');
  process.exit(0);
}
`;

/** Invocations of the fake agy so far — i.e. how many browser tabs would exist. */
function spawnCount(): number {
  if (!fs.existsSync(spawnLog)) return 0;
  return fs.readFileSync(spawnLog, 'utf-8').split('\n').filter(Boolean).length;
}

function setMode(mode: 'auth' | 'unauth'): void {
  process.env.FAKE_AGY_MODE = mode;
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-auth-cache-test-'));
  fakeAgy = path.join(dir, 'agy');
  fs.writeFileSync(fakeAgy, FAKE_AGY_SOURCE, { mode: 0o755 });
  spawnLog = path.join(dir, 'spawns.log');
  fs.writeFileSync(spawnLog, '');

  process.env.CODEV_AGY_BIN = fakeAgy;
  process.env.CODEV_AGY_AUTH_CACHE_DIR = path.join(dir, 'cache');
  process.env.FAKE_AGY_LOG = spawnLog;
  delete process.env.CODEV_AGY_AUTH_CACHE_DISABLE;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('agy auth-state cache', () => {
  it('reports nothing on a cold cache', () => {
    expect(checkCachedAgyAuth(fakeAgy)).toBeNull();
  });

  it('round-trips both states', () => {
    recordAgyAuthState('unauth', fakeAgy);
    expect(checkCachedAgyAuth(fakeAgy)).toBe('unauth');
    recordAgyAuthState('auth', fakeAgy);
    expect(checkCachedAgyAuth(fakeAgy)).toBe('auth');
  });

  it('writes the cache file 0600 in a 0700 directory', () => {
    recordAgyAuthState('unauth', fakeAgy);
    const cacheFile = path.join(agyAuthCacheDir(), 'agy-auth.json');
    expect(fs.statSync(cacheFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(agyAuthCacheDir()).mode & 0o777).toBe(0o700);
  });

  it('expires an unauth verdict once its TTL lapses', async () => {
    process.env.CODEV_AGY_AUTH_CACHE_TTL_UNAUTH_MS = '20';
    recordAgyAuthState('unauth', fakeAgy);
    expect(checkCachedAgyAuth(fakeAgy)).toBe('unauth');
    await new Promise((r) => setTimeout(r, 40));
    expect(checkCachedAgyAuth(fakeAgy)).toBeNull();
  });

  it('applies the auth and unauth TTLs independently', async () => {
    process.env.CODEV_AGY_AUTH_CACHE_TTL_UNAUTH_MS = '20';
    process.env.CODEV_AGY_AUTH_CACHE_TTL_AUTH_MS = '60000';
    recordAgyAuthState('auth', fakeAgy);
    await new Promise((r) => setTimeout(r, 40));
    // Past the *unauth* TTL but well inside the auth one.
    expect(checkCachedAgyAuth(fakeAgy)).toBe('auth');
  });

  it('ignores a verdict recorded for a different agy binary', () => {
    recordAgyAuthState('unauth', '/some/other/agy');
    expect(checkCachedAgyAuth(fakeAgy)).toBeNull();
  });

  it('ignores a verdict whose credential-mtime hint no longer matches', () => {
    // Simulates the user completing OAuth: agy rewrites its credentials, so the
    // recorded hint goes stale and the verdict must not be trusted.
    fs.mkdirSync(agyAuthCacheDir(), { recursive: true });
    fs.writeFileSync(
      path.join(agyAuthCacheDir(), 'agy-auth.json'),
      JSON.stringify({ state: 'unauth', checkedAt: Date.now(), agyBinPath: fakeAgy, agyAuthMtime: 12345 }),
    );
    expect(checkCachedAgyAuth(fakeAgy)).toBeNull();
  });

  it('treats a corrupt cache file as cold rather than throwing', () => {
    fs.mkdirSync(agyAuthCacheDir(), { recursive: true });
    fs.writeFileSync(path.join(agyAuthCacheDir(), 'agy-auth.json'), '{not json');
    expect(checkCachedAgyAuth(fakeAgy)).toBeNull();
  });

  it('rejects an entry with an unrecognised state', () => {
    fs.mkdirSync(agyAuthCacheDir(), { recursive: true });
    fs.writeFileSync(
      path.join(agyAuthCacheDir(), 'agy-auth.json'),
      JSON.stringify({ state: 'maybe', checkedAt: Date.now(), agyBinPath: fakeAgy, agyAuthMtime: null }),
    );
    expect(checkCachedAgyAuth(fakeAgy)).toBeNull();
  });

  it('goes inert when disabled, neither reading nor writing', () => {
    recordAgyAuthState('unauth', fakeAgy);
    process.env.CODEV_AGY_AUTH_CACHE_DISABLE = '1';
    expect(checkCachedAgyAuth(fakeAgy)).toBeNull();
    recordAgyAuthState('auth', fakeAgy);      // must not overwrite
    delete process.env.CODEV_AGY_AUTH_CACHE_DISABLE;
    expect(checkCachedAgyAuth(fakeAgy)).toBe('unauth');
  });

  it('clears the cache on request', () => {
    recordAgyAuthState('unauth', fakeAgy);
    clearAgyAuthCache();
    expect(checkCachedAgyAuth(fakeAgy)).toBeNull();
  });

  it('stops waiting and returns null when no verdict arrives', async () => {
    const started = Date.now();
    expect(await waitForAgyAuthState(fakeAgy, 150)).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it('returns the verdict as soon as another process publishes it', async () => {
    setTimeout(() => recordAgyAuthState('unauth', fakeAgy), 50);
    expect(await waitForAgyAuthState(fakeAgy, 3000)).toBe('unauth');
  });
});

describe('agy auth pre-flight', () => {
  it('elects exactly one prober among concurrent callers', async () => {
    // Nothing publishes a verdict here, so the losers ride out the fail-open
    // wait — shorten it so the test does not sit through the real one.
    process.env.CODEV_AGY_AUTH_CACHE_WAIT_MS = '150';
    const results = await Promise.all([
      preflightAgyAuth(fakeAgy),
      preflightAgyAuth(fakeAgy),
      preflightAgyAuth(fakeAgy),
    ]);
    // Losers fall through to the (short) wait, then fail open — so they all say
    // "proceed", but only one of them is on the hook to publish a verdict.
    expect(results.filter((r) => r.isProber)).toHaveLength(1);
    results.forEach((r) => r.release());
  });

  it('skips without probing when a fresh unauth verdict exists', async () => {
    recordAgyAuthState('unauth', fakeAgy);
    const pre = await preflightAgyAuth(fakeAgy);
    expect(pre.action).toBe('skip');
    expect(pre.reason).toMatch(/cached/);
    expect(pre.isProber).toBe(false);
  });

  it('proceeds without probing when a fresh auth verdict exists', async () => {
    recordAgyAuthState('auth', fakeAgy);
    const pre = await preflightAgyAuth(fakeAgy);
    expect(pre.action).toBe('proceed');
    expect(pre.isProber).toBe(false);
  });

  it('releases the lock so the next caller can probe', async () => {
    const first = await preflightAgyAuth(fakeAgy);
    expect(first.isProber).toBe(true);
    first.release();
    const second = await preflightAgyAuth(fakeAgy);
    expect(second.isProber).toBe(true);
    second.release();
  });

  it('reclaims a lock abandoned by a crashed prober', async () => {
    const lock = path.join(agyAuthCacheDir(), 'agy-auth.lock');
    fs.mkdirSync(agyAuthCacheDir(), { recursive: true });
    fs.writeFileSync(lock, '99999 0\n');
    // Backdate past the staleness threshold (60s).
    const old = new Date(Date.now() - 5 * 60 * 1000);
    fs.utimesSync(lock, old, old);

    const pre = await preflightAgyAuth(fakeAgy);
    expect(pre.isProber).toBe(true);
    pre.release();
  });

  it('is inert when the cache is disabled', async () => {
    process.env.CODEV_AGY_AUTH_CACHE_DISABLE = '1';
    recordAgyAuthState('unauth', fakeAgy);   // no-op while disabled
    const pre = await preflightAgyAuth(fakeAgy);
    expect(pre.action).toBe('proceed');
    expect(pre.isProber).toBe(false);
  });
});

describe('gemini lane burst behaviour (#1077 regression)', () => {
  /** Silence the lane's review/skip output so test logs stay readable. */
  function muteStdout() {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  }

  async function runLane(n: number): Promise<void> {
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        _runAgyConsultation('review this', 'be terse', dir, path.join(dir, `review-${i}.txt`)),
      ),
    );
  }

  it('spawns agy at most once across a 5-wide burst when unauthenticated', async () => {
    setMode('unauth');
    muteStdout();

    await runLane(5);

    // The heart of #1077: one spawn means one browser tab, not five.
    expect(spawnCount()).toBe(1);
    expect(checkCachedAgyAuth(fakeAgy)).toBe('unauth');
  }, 30_000);

  it('still emits a non-blocking COMMENT skip for every call it short-circuits', async () => {
    setMode('unauth');
    muteStdout();

    await runLane(5);

    // A skipped lane must never silently produce nothing — porch aggregates these.
    for (let i = 0; i < 5; i++) {
      const review = fs.readFileSync(path.join(dir, `review-${i}.txt`), 'utf-8');
      expect(review).toContain('VERDICT: COMMENT');
      expect(review).toMatch(/Gemini lane skipped/);
    }
  }, 30_000);

  it('does not spawn at all once the unauth verdict is cached', async () => {
    setMode('unauth');
    muteStdout();
    recordAgyAuthState('unauth', fakeAgy);

    await runLane(3);

    expect(spawnCount()).toBe(0);
  }, 30_000);

  it('re-probes after the unauth TTL lapses, recovering once the user signs in', async () => {
    process.env.CODEV_AGY_AUTH_CACHE_TTL_UNAUTH_MS = '50';
    setMode('unauth');
    muteStdout();

    await runLane(1);
    expect(checkCachedAgyAuth(fakeAgy)).toBe('unauth');

    // User completes OAuth in another window; the stale verdict times out.
    setMode('auth');
    await new Promise((r) => setTimeout(r, 80));

    await runLane(1);
    expect(checkCachedAgyAuth(fakeAgy)).toBe('auth');
    const review = fs.readFileSync(path.join(dir, 'review-0.txt'), 'utf-8');
    expect(review).toContain('VERDICT: APPROVE');
  }, 30_000);

  it('runs every lane in a burst when authenticated (no reviewer dropped)', async () => {
    setMode('auth');
    muteStdout();

    await runLane(5);

    // Each call is real work and must reach agy; the cache must not suppress any.
    expect(spawnCount()).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(fs.readFileSync(path.join(dir, `review-${i}.txt`), 'utf-8')).toContain('VERDICT: APPROVE');
    }
  }, 30_000);

  it('keeps spawning per call when the cache is disabled (pre-#1077 behaviour)', async () => {
    process.env.CODEV_AGY_AUTH_CACHE_DISABLE = '1';
    setMode('unauth');
    muteStdout();

    await runLane(3);

    // The escape hatch genuinely restores the old always-spawn path — this is
    // also the assertion that proves the burst test above measures the cache.
    expect(spawnCount()).toBe(3);
  }, 30_000);
});
