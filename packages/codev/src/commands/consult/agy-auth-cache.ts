/**
 * Cross-process auth-state cache for the Antigravity CLI (`agy`) — Issue #1077.
 *
 * ## Why this exists
 *
 * An unauthenticated `agy --print` opens an OAuth browser tab *before* it prints
 * the OAuth URL that `AGY_OAUTH_MARKERS` detection keys off. So by the time the
 * gemini consult lane recognises "not signed in" and kills the child, the tab is
 * already on screen. A CMAP burst runs N consults as N separate OS processes, so
 * N tabs land — 12-15 stranded tabs were observed in the wild.
 *
 * A module-level memo cannot help: each `consult` invocation is its own process.
 * The state has to be shared through the filesystem.
 *
 * ## The protocol
 *
 * 1. Read `~/.cache/codev/agy-auth.json`. A *fresh* entry decides immediately:
 *    `unauth` → skip without spawning; `auth` → spawn as usual.
 * 2. Cold or expired cache → race for an exclusive lock. Exactly one process
 *    wins and becomes the **prober**: it spawns agy for real and publishes the
 *    verdict the moment it is knowable (see `runAgyConsultation`).
 * 3. Losers do **not** block on the lock — the prober may hold it for minutes on
 *    a real review. They poll the cache for a few seconds and act on the verdict
 *    as soon as it appears.
 *
 * ## Fail-open bias
 *
 * Only positive OAuth-marker evidence records `unauth`. A waiter that never sees
 * a verdict proceeds with its spawn. Both choices push failures toward "one
 * unnecessary browser tab" (the status quo) and away from "silently skipped a
 * working reviewer", which would corrupt a CMAP round.
 */

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

export type AgyAuthState = 'auth' | 'unauth';

/** Cache entry persisted to `agy-auth.json`. */
interface AgyAuthCacheEntry {
  state: AgyAuthState;
  /** epoch ms of the probe that produced `state`. */
  checkedAt: number;
  /** Binary the verdict applies to — a different binary invalidates it. */
  agyBinPath: string;
  /** Newest mtime across agy's candidate credential files, or null if none found. */
  agyAuthMtime: number | null;
}

/**
 * `unauth` expires fast: a user who signs in elsewhere should get the lane back
 * without clearing anything by hand. `auth` lasts longer because re-probing a
 * working agy is pure overhead.
 */
const DEFAULT_TTL_UNAUTH_MS = 5 * 60 * 1000;
const DEFAULT_TTL_AUTH_MS = 30 * 60 * 1000;

/** How long a waiter polls for the prober's verdict before failing open. */
const DEFAULT_WAIT_MS = 6000;
const WAIT_POLL_INTERVAL_MS = 100;

/**
 * A lock older than this is treated as abandoned (prober crashed / was killed
 * mid-run) and reclaimed. Generous enough to cover a prober that is still
 * deciding, short enough that a crash does not wedge the lane for a whole TTL.
 */
const LOCK_STALE_MS = 60 * 1000;

/**
 * Files agy plausibly writes when an OAuth login completes. Purely a *hint*: a
 * changed mtime invalidates the cache early, so a sign-in is picked up before
 * the TTL lapses. agy's credential location is not documented and has moved
 * between releases, so this list is best-effort by design and every entry is
 * optional — when none exist, `agyAuthMtime` is null and the TTL is the only
 * recovery window (which is sufficient on its own).
 *
 * Deliberately excludes general settings/state files: those churn for unrelated
 * reasons, and a spurious invalidation costs a browser tab.
 */
const AGY_CREDENTIAL_CANDIDATES = [
  ['.antigravity', 'credentials.json'],
  ['Library', 'Application Support', 'Antigravity', 'credentials.json'],
  ['.gemini', 'antigravity-cli', 'credentials.json'],
  ['.gemini', 'antigravity-cli', 'oauth_creds.json'],
  ['.gemini', 'oauth_creds.json'],
  ['.gemini', 'google_accounts.json'],
];

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function ttlFor(state: AgyAuthState): number {
  return state === 'unauth'
    ? envInt('CODEV_AGY_AUTH_CACHE_TTL_UNAUTH_MS', DEFAULT_TTL_UNAUTH_MS)
    : envInt('CODEV_AGY_AUTH_CACHE_TTL_AUTH_MS', DEFAULT_TTL_AUTH_MS);
}

/**
 * Opt-out escape hatch: restores the pre-#1077 always-spawn behaviour.
 *
 * Also inert under a test runner unless the suite names a cache directory. This
 * cache is a *user-global* side effect: without the guard, any test that reaches
 * `doctor()` or the gemini lane would record a verdict into the developer's real
 * `~/.cache/codev` and, worse, later tests would silently take the cached branch
 * and stop spawning what they assert on. Suites that mean to exercise the cache
 * set `CODEV_AGY_AUTH_CACHE_DIR` and get the full behaviour.
 */
export function agyAuthCacheDisabled(): boolean {
  const raw = process.env.CODEV_AGY_AUTH_CACHE_DISABLE;
  if (raw === '1' || raw === 'true') return true;
  return Boolean(process.env.VITEST) && !process.env.CODEV_AGY_AUTH_CACHE_DIR;
}

/**
 * Cache directory. `CODEV_AGY_AUTH_CACHE_DIR` keeps tests off the real user
 * cache; otherwise XDG_CACHE_HOME, else `~/.cache`.
 */
export function agyAuthCacheDir(): string {
  const override = process.env.CODEV_AGY_AUTH_CACHE_DIR;
  if (override) return override;
  const xdg = process.env.XDG_CACHE_HOME;
  return path.join(xdg && xdg.startsWith('/') ? xdg : path.join(homedir(), '.cache'), 'codev');
}

function cacheFilePath(): string {
  return path.join(agyAuthCacheDir(), 'agy-auth.json');
}

function lockFilePath(): string {
  return path.join(agyAuthCacheDir(), 'agy-auth.lock');
}

/** Newest mtime across the candidate credential files; null when none exist. */
function currentAgyAuthMtime(): number | null {
  let newest: number | null = null;
  for (const parts of AGY_CREDENTIAL_CANDIDATES) {
    try {
      const stat = fs.statSync(path.join(homedir(), ...parts));
      const mtime = stat.mtimeMs;
      if (newest === null || mtime > newest) newest = mtime;
    } catch {
      // Absent or unreadable — this list is a hint, not a requirement.
    }
  }
  return newest;
}

function readEntry(): AgyAuthCacheEntry | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFilePath(), 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const e = parsed as Partial<AgyAuthCacheEntry>;
    if (e.state !== 'auth' && e.state !== 'unauth') return null;
    if (typeof e.checkedAt !== 'number' || !Number.isFinite(e.checkedAt)) return null;
    if (typeof e.agyBinPath !== 'string') return null;
    return {
      state: e.state,
      checkedAt: e.checkedAt,
      agyBinPath: e.agyBinPath,
      agyAuthMtime: typeof e.agyAuthMtime === 'number' ? e.agyAuthMtime : null,
    };
  } catch {
    // Missing, truncated, or concurrently-rewritten file — treat as cold.
    return null;
  }
}

/**
 * The cached auth state for `agyBinPath`, or null when there is nothing
 * trustworthy to act on (cold, expired, different binary, or a credential file
 * changed since the probe).
 */
export function checkCachedAgyAuth(agyBinPath: string): AgyAuthState | null {
  if (agyAuthCacheDisabled()) return null;
  const entry = readEntry();
  if (!entry) return null;
  // A reinstall or a CODEV_AGY_BIN change means the verdict describes a
  // different binary than the one we are about to run.
  if (entry.agyBinPath !== agyBinPath) return null;
  if (Date.now() - entry.checkedAt >= ttlFor(entry.state)) return null;
  // Credentials moved under us → someone signed in (or out); re-probe.
  if (entry.agyAuthMtime !== currentAgyAuthMtime()) return null;
  return entry.state;
}

/**
 * Persist a verdict. Written via a temp file + rename so a concurrent reader
 * never observes a half-written JSON document.
 */
export function recordAgyAuthState(state: AgyAuthState, agyBinPath: string): void {
  if (agyAuthCacheDisabled()) return;
  const entry: AgyAuthCacheEntry = {
    state,
    checkedAt: Date.now(),
    agyBinPath,
    agyAuthMtime: currentAgyAuthMtime(),
  };
  try {
    const dir = agyAuthCacheDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `agy-auth.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
    fs.renameSync(tmp, cacheFilePath());
  } catch {
    // A cache we cannot write is a missed optimisation, never a failed consult.
  }
}

/** Test/diagnostic helper: drop the cache file and any lock. */
export function clearAgyAuthCache(): void {
  for (const p of [cacheFilePath(), lockFilePath()]) {
    try { fs.unlinkSync(p); } catch { /* already gone */ }
  }
}

/**
 * Try to become the prober. Returns a release function on success, null when
 * another process holds the lock. An abandoned lock (older than LOCK_STALE_MS)
 * is reclaimed once.
 */
function acquireProbeLock(): (() => void) | null {
  const lockPath = lockFilePath();
  const attempt = (): boolean => {
    try {
      fs.mkdirSync(agyAuthCacheDir(), { recursive: true, mode: 0o700 });
      // 'wx' fails when the file exists — the atomic test-and-set we need.
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(fd, `${process.pid} ${Date.now()}\n`);
      fs.closeSync(fd);
      return true;
    } catch {
      return false;
    }
  };

  if (attempt()) return () => { try { fs.unlinkSync(lockPath); } catch { /* already gone */ } };

  try {
    if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
      fs.unlinkSync(lockPath);
      if (attempt()) return () => { try { fs.unlinkSync(lockPath); } catch { /* already gone */ } };
    }
  } catch {
    // Lock vanished mid-inspection (holder finished) — fall through to waiting.
  }
  return null;
}

/**
 * Poll for the prober's verdict. Resolves with the state as soon as one lands,
 * or null if the wait elapses first.
 *
 * Polls the *cache* rather than waiting on the lock: the prober holds the lock
 * for its entire agy run, which can be minutes, but publishes its verdict within
 * seconds.
 */
export async function waitForAgyAuthState(
  agyBinPath: string,
  timeoutMs = envInt('CODEV_AGY_AUTH_CACHE_WAIT_MS', DEFAULT_WAIT_MS),
): Promise<AgyAuthState | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = checkCachedAgyAuth(agyBinPath);
    if (state) return state;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, WAIT_POLL_INTERVAL_MS));
  }
}

export interface AgyAuthPreflight {
  /** `skip` → do not spawn agy at all; `proceed` → spawn. */
  action: 'skip' | 'proceed';
  /** Skip reason, suitable for a user-facing message. Set iff action is `skip`. */
  reason?: string;
  /**
   * True when this process won the probe lock. Such a process MUST report what
   * it learns via `publish` — every other process is waiting on it.
   */
  isProber: boolean;
  /**
   * Record a verdict and release the lock. Idempotent, and a no-op for
   * non-probers, so callers can invoke it from every exit path unconditionally.
   */
  publish: (state: AgyAuthState) => void;
  /** Release the lock without recording anything (abnormal exits). Idempotent. */
  release: () => void;
}

const SKIP_REASON_CACHED_UNAUTH =
  'agy unauthenticated (cached); run `agy` once to sign in';

/**
 * Decide whether to spawn agy, before spawning it.
 *
 * Callers that receive `proceed` with `isProber: true` are on the hook to
 * `publish` what the spawn reveals; see the module header for the full protocol.
 */
export async function preflightAgyAuth(agyBinPath: string): Promise<AgyAuthPreflight> {
  const inert: AgyAuthPreflight = {
    action: 'proceed',
    isProber: false,
    publish: () => {},
    release: () => {},
  };
  if (agyAuthCacheDisabled()) return inert;

  const cached = checkCachedAgyAuth(agyBinPath);
  if (cached === 'unauth') {
    return { ...inert, action: 'skip', reason: SKIP_REASON_CACHED_UNAUTH };
  }
  if (cached === 'auth') return inert;

  const release = acquireProbeLock();
  if (release) {
    let done = false;
    const finish = (state?: AgyAuthState) => {
      if (done) return;
      done = true;
      if (state) recordAgyAuthState(state, agyBinPath);
      release();
    };
    return {
      action: 'proceed',
      isProber: true,
      publish: (state) => finish(state),
      release: () => finish(),
    };
  }

  // Another process is probing. Wait briefly for its verdict rather than adding
  // a spawn (and a browser tab) of our own.
  const observed = await waitForAgyAuthState(agyBinPath);
  if (observed === 'unauth') {
    return { ...inert, action: 'skip', reason: SKIP_REASON_CACHED_UNAUTH };
  }
  // `auth`, or no verdict in time: proceed. Failing open keeps a slow or crashed
  // prober from silently dropping a reviewer that would have worked.
  return inert;
}
