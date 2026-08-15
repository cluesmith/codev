import { describe, it, expect, vi } from 'vitest';
// @ts-expect-error — plain ESM build script, no type declarations.
import {
  runWithBackoff,
  isTransientError,
  TRANSIENT_SIGNATURES,
} from '../../scripts/validate.mjs';

/**
 * #1436: `streamdeck validate`'s `manifestUrlsExist` rule does a live HEAD request to the
 * manifest's `URL`. Anything other than ENOTFOUND (UND_ERR_SOCKET, "fetch failed", …) is rethrown
 * and crashes the whole validate run, flaking unrelated PRs' CI. The fix wraps the invocation in a
 * bounded loop that runs again ONLY on transient network failures. These tests pin that contract:
 * they fail against a single-shot implementation and pass with the backoff loop.
 */

const ok = { code: 0, output: 'Validation successful.' };
const socketFail = { code: 1, output: 'validate failed\nTypeError: fetch failed\n  UND_ERR_SOCKET' };
const realFail = {
  code: 1,
  output: 'manifest.json\n  error: Actions must not be empty\n1 error',
};

// No real waiting under test.
const noSleep = () => Promise.resolve();

describe('isTransientError', () => {
  it('matches the observed socket errors', () => {
    expect(isTransientError('TypeError: fetch failed\n  UND_ERR_SOCKET')).toBe(true);
    expect(isTransientError('read ECONNRESET')).toBe(true);
    expect(isTransientError('connect ETIMEDOUT')).toBe(true);
  });

  it('does not match a real validation failure or ENOTFOUND', () => {
    expect(isTransientError('error: Actions must not be empty')).toBe(false);
    // ENOTFOUND is reported by the CLI as a normal "must be resolvable" error, not a crash.
    expect(isTransientError('URL must be resolvable (ENOTFOUND)')).toBe(false);
  });

  it('is case-insensitive across every declared signature', () => {
    for (const sig of TRANSIENT_SIGNATURES) {
      expect(isTransientError(`prefix ${sig.toUpperCase()} suffix`)).toBe(true);
      expect(isTransientError(`prefix ${sig.toLowerCase()} suffix`)).toBe(true);
    }
  });
});

describe('runWithBackoff', () => {
  it('recovers from a transient failure then a success (fails with a single attempt)', async () => {
    const run = vi.fn().mockResolvedValueOnce(socketFail).mockResolvedValueOnce(ok);
    const result = await runWithBackoff({ run, sleep: noSleep });
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.code).toBe(0);
    expect(result.attempts).toBe(2);
  });

  it('runs up to the attempt cap on repeated transient failures, then surfaces the failure', async () => {
    const run = vi.fn().mockResolvedValue(socketFail);
    const result = await runWithBackoff({ run, attempts: 3, sleep: noSleep });
    expect(run).toHaveBeenCalledTimes(3);
    expect(result.code).toBe(1);
    expect(result.attempts).toBe(3);
  });

  it('fails fast on a real validation error without a second attempt', async () => {
    const run = vi.fn().mockResolvedValue(realFail);
    const result = await runWithBackoff({ run, attempts: 3, sleep: noSleep });
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.code).toBe(1);
  });

  it('applies exponential backoff between transient attempts', async () => {
    const run = vi.fn().mockResolvedValue(socketFail);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await runWithBackoff({ run, attempts: 3, baseBackoffMs: 1000, sleep });
    // Two waits between three attempts: 1000ms then 2000ms.
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
  });

  it('returns immediately on first-attempt success', async () => {
    const run = vi.fn().mockResolvedValue(ok);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await runWithBackoff({ run, sleep });
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(result.code).toBe(0);
  });
});
