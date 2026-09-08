/**
 * Issue #1645 — forge rate-limit awareness.
 *
 * Pins the three pieces that stop Tower from burning the account's whole
 * GitHub GraphQL budget: recognising the error, suspending on it with a
 * doubling backoff, and getting the error's detail out of `executeForgeCommand`
 * (which otherwise collapses every failure to `null`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeForgeCommand, onForgeFailure, type ForgeFailure } from '../lib/forge.js';
import {
  isRateLimitError,
  noteRateLimited,
  noteForgeSuccess,
  clearForgeSuspension,
  DEFAULT_PROVIDER,
  resetForgeRateLimit,
  isForgeSuspended,
  getForgeRateLimit,
  parseBudget,
  installForgeRateLimitWatch,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  SUSPEND_CAP_MS,
} from '../lib/forge-rate-limit.js';

describe('forge rate-limit awareness (#1645)', () => {
  beforeEach(() => {
    resetForgeRateLimit();
  });

  describe('isRateLimitError', () => {
    it('recognises the exact message gh prints on an exhausted GraphQL budget', () => {
      // Captured verbatim from `gh issue list` on a real exhausted account.
      expect(isRateLimitError('GraphQL: API rate limit already exceeded for user ID 2716496.')).toBe(true);
    });

    it('recognises the REST wording and the GraphQL error type', () => {
      expect(isRateLimitError('API rate limit exceeded for user ID 1.')).toBe(true);
      expect(isRateLimitError('{"type":"RATE_LIMITED","message":"..."}')).toBe(true);
      expect(isRateLimitError('You have exceeded a secondary rate limit')).toBe(true);
    });

    it('does not fire on unrelated failures', () => {
      expect(isRateLimitError('gh: command not found')).toBe(false);
      expect(isRateLimitError('gh auth login required')).toBe(false);
      expect(isRateLimitError('')).toBe(false);
    });
  });

  describe('suspension', () => {
    it('is not suspended by default', () => {
      expect(isForgeSuspended(DEFAULT_PROVIDER)).toBe(false);
      expect(getForgeRateLimit(DEFAULT_PROVIDER)).toEqual({ limited: false, resetAt: null });
    });

    it('suspends only the provider that was refused', () => {
      // A GitHub limit says nothing about a GitLab workspace's forge, and
      // blanking its Work view for the backoff window would be a regression
      // for a workspace that is not even involved.
      const now = 1_000_000;
      noteRateLimited('github', null, now);

      expect(isForgeSuspended('github', now)).toBe(true);
      expect(isForgeSuspended('gitlab', now)).toBe(false);
      expect(isForgeSuspended('linear', now)).toBe(false);
      expect(getForgeRateLimit('gitlab', now)).toEqual({ limited: false, resetAt: null });
    });

    it('backs each provider off independently', () => {
      const now = 1_000_000;
      noteRateLimited('github', null, now);
      noteRateLimited('gitlab', null, now);
      noteForgeSuccess('github', now + 1);

      expect(isForgeSuspended('github', now)).toBe(false);
      expect(isForgeSuspended('gitlab', now)).toBe(true);
    });

    it('suspends until a reported reset instant', () => {
      const now = Date.now();
      const reset = now + 5 * 60_000;
      noteRateLimited(DEFAULT_PROVIDER, reset, now);

      expect(isForgeSuspended(DEFAULT_PROVIDER, now)).toBe(true);
      expect(getForgeRateLimit(DEFAULT_PROVIDER, now).resetAt).toBe(new Date(reset).toISOString());
      expect(isForgeSuspended(DEFAULT_PROVIDER, reset + 1)).toBe(false);
    });

    it('falls back to a doubling backoff when the reset instant is unknown', () => {
      const now = 1_000_000;
      noteRateLimited(DEFAULT_PROVIDER, null, now);
      expect(getForgeRateLimit(DEFAULT_PROVIDER, now).resetAt).toBe(new Date(now + BACKOFF_BASE_MS).toISOString());

      // Second hit lands past the first window, so the backoff doubles.
      const later = now + BACKOFF_BASE_MS + 1;
      noteRateLimited(DEFAULT_PROVIDER, null, later);
      expect(getForgeRateLimit(DEFAULT_PROVIDER, later).resetAt).toBe(new Date(later + BACKOFF_BASE_MS * 2).toISOString());
    });

    it('caps the backoff at 15 minutes', () => {
      let t = 1_000_000;
      for (let i = 0; i < 12; i++) {
        noteRateLimited(DEFAULT_PROVIDER, null, t);
        t += BACKOFF_MAX_MS + 1;
      }
      noteRateLimited(DEFAULT_PROVIDER, null, t);
      expect(getForgeRateLimit(DEFAULT_PROVIDER, t).resetAt).toBe(new Date(t + BACKOFF_MAX_MS).toISOString());
    });

    it('refuses to trust a reset instant more than an hour out', () => {
      const now = 1_000_000;
      noteRateLimited(DEFAULT_PROVIDER, now + 5 * SUSPEND_CAP_MS, now);
      expect(getForgeRateLimit(DEFAULT_PROVIDER, now).resetAt).toBe(new Date(now + SUSPEND_CAP_MS).toISOString());
    });

    it('never shortens a suspension already in force', () => {
      const now = 1_000_000;
      noteRateLimited(DEFAULT_PROVIDER, now + 10 * 60_000, now);
      noteRateLimited(DEFAULT_PROVIDER, now + 60_000, now);
      expect(getForgeRateLimit(DEFAULT_PROVIDER, now).resetAt).toBe(new Date(now + 10 * 60_000).toISOString());
    });

    it('escalates once per window, not once per failed command', () => {
      // An overview refresh fires four forge commands in parallel and all four
      // fail together. Counting each would jump from 60s straight to 8 minutes
      // on the very first refresh.
      const now = 1_000_000;
      noteRateLimited(DEFAULT_PROVIDER, null, now);
      noteRateLimited(DEFAULT_PROVIDER, null, now);
      noteRateLimited(DEFAULT_PROVIDER, null, now);
      noteRateLimited(DEFAULT_PROVIDER, null, now);
      expect(getForgeRateLimit(DEFAULT_PROVIDER, now).resetAt).toBe(new Date(now + BACKOFF_BASE_MS).toISOString());
    });

    it('clears on a forge command dispatched after the suspension began', () => {
      const now = 1_000_000;
      noteRateLimited(DEFAULT_PROVIDER, null, now);
      expect(isForgeSuspended(DEFAULT_PROVIDER, now)).toBe(true);
      noteForgeSuccess(DEFAULT_PROVIDER, now + 1);
      expect(isForgeSuspended(DEFAULT_PROVIDER, now)).toBe(false);
    });

    it('ignores a success from a command dispatched BEFORE the suspension', () => {
      // The REST `user-identity` call runs in the same batch as the GraphQL
      // ones and is charged to a different budget, so it succeeds while they
      // are refused. It must not wipe the suspension they just set.
      const dispatchedAt = 1_000_000;
      noteRateLimited(DEFAULT_PROVIDER, null, dispatchedAt + 10);
      noteForgeSuccess(DEFAULT_PROVIDER, dispatchedAt);
      expect(isForgeSuspended(DEFAULT_PROVIDER, dispatchedAt + 20)).toBe(true);
    });

    it('clears outright on an explicit refresh', () => {
      noteRateLimited(DEFAULT_PROVIDER, Date.now() + 60_000);
      expect(isForgeSuspended(DEFAULT_PROVIDER)).toBe(true);
      clearForgeSuspension();
      expect(isForgeSuspended(DEFAULT_PROVIDER)).toBe(false);
    });
  });

  describe('parseBudget', () => {
    it('parses the rate-limit concept output', () => {
      expect(parseBudget({ limit: 5000, remaining: 0, used: 5000, reset: 1788847344 }))
        .toEqual({ limit: 5000, remaining: 0, used: 5000, reset: 1788847344 });
    });

    it('rejects anything else', () => {
      expect(parseBudget(null)).toBeNull();
      expect(parseBudget('nope')).toBeNull();
      expect(parseBudget({ limit: 5000 })).toBeNull();
      expect(parseBudget({ limit: '5000', remaining: 0, used: 0, reset: 0 })).toBeNull();
    });
  });
});

describe('forge failure detail reaches its observers (#1645)', () => {
  let dir: string;
  let unsubscribe: () => void;

  beforeEach(() => {
    resetForgeRateLimit();
    dir = mkdtempSync(join(tmpdir(), 'forge-fail-'));
  });

  afterEach(() => {
    unsubscribe?.();
    rmSync(dir, { recursive: true, force: true });
  });

  function script(body: string): string {
    const p = join(dir, 'concept.sh');
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  }

  it('publishes stderr and exit code that executeForgeCommand would have discarded', async () => {
    const command = script('echo "GraphQL: API rate limit already exceeded for user ID 1." >&2; exit 1');
    const failures: ForgeFailure[] = [];
    unsubscribe = onForgeFailure(f => failures.push(f));

    const result = await executeForgeCommand('issue-list', {}, { forgeConfig: { 'issue-list': command } });

    expect(result).toBeNull(); // unchanged contract for existing callers
    expect(failures).toHaveLength(1);
    expect(failures[0].concept).toBe('issue-list');
    expect(failures[0].exitCode).toBe(1);
    expect(failures[0].message).toContain('rate limit already exceeded');
  });

  it('suspends the forge when the watch sees a rate-limit failure', async () => {
    installForgeRateLimitWatch();
    const command = script('echo "GraphQL: API rate limit already exceeded for user ID 1." >&2; exit 1');

    expect(isForgeSuspended(DEFAULT_PROVIDER)).toBe(false);
    await executeForgeCommand('issue-list', {}, { forgeConfig: { 'issue-list': command } });

    expect(isForgeSuspended(DEFAULT_PROVIDER)).toBe(true);
  });

  it('leaves the forge alone for a non-rate-limit failure', async () => {
    installForgeRateLimitWatch();
    const command = script('echo "gh: not authenticated" >&2; exit 1');

    await executeForgeCommand('issue-list', {}, { forgeConfig: { 'issue-list': command } });

    expect(isForgeSuspended(DEFAULT_PROVIDER)).toBe(false);
  });

  it('does not fire for a command that succeeds', async () => {
    const command = script('echo "[]"');
    const failures: ForgeFailure[] = [];
    unsubscribe = onForgeFailure(f => failures.push(f));

    await executeForgeCommand('issue-list', {}, { forgeConfig: { 'issue-list': command } });

    expect(failures).toHaveLength(0);
  });
});
