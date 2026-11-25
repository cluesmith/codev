/**
 * Issue #1901 — every CLI command's Tower gate goes through `checkTower`.
 *
 * Under heavy load a live Tower accepts the connection at once but its starved event loop misses
 * the request timeout. The old gate (`isRunning()`, a bare boolean) reported that as "Tower is not
 * running. Start it with: afx tower start". These tests drive the real CLI client with an
 * injected fetch, the way Node's fetch fails, and pin the three outcomes the issue asks for.
 */

import { describe, it, expect, vi } from 'vitest';
import { TowerClient } from '../lib/tower-client.js';
import { checkTower } from '../lib/tower-check.js';

const errno = (code: string) => Object.assign(new Error(`connect ${code}`), { code });
/** Node's fetch over `localhost`: one attempt per address, wrapped as the cause. */
const refused = () =>
  Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new AggregateError([errno('ECONNREFUSED'), errno('ECONNREFUSED')], ''), { code: 'ECONNREFUSED' }),
  });
const reset = () => Object.assign(new TypeError('fetch failed'), { cause: errno('ECONNRESET') });
const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
const healthy = () =>
  ({ ok: true, status: 200, json: async () => ({ status: 'healthy' }), text: async () => '' }) as Response;

/** A fetch that plays `steps` in order: an Error is thrown, anything else is returned. */
function scriptedFetch(...steps: Array<() => Error | Response>) {
  const queue = [...steps];
  return vi.fn(async () => {
    const step = queue.shift();
    if (!step) throw new Error('scriptedFetch: called more times than scripted');
    const outcome = step();
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const clientWith = (fetchFn: typeof fetch) => new TowerClient({ port: 4199, getAuthKey: () => null, fetchFn });

describe('checkTower (#1901)', () => {
  it('says "not running" and suggests starting Tower only when the connection is refused', async () => {
    const fetchFn = scriptedFetch(refused);
    const check = await checkTower(clientWith(fetchFn), { retryDelayMs: 0 });
    expect(check).toEqual({ state: 'not-running', message: 'Tower is not running. Start it with: afx tower start' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('passes silently when a reset is followed by a healthy answer', async () => {
    const fetchFn = scriptedFetch(reset, healthy);
    expect(await checkTower(clientWith(fetchFn), { retryDelayMs: 0 })).toEqual({ state: 'running' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('passes silently when a timeout is followed by a healthy answer', async () => {
    const fetchFn = scriptedFetch(timeout, healthy);
    expect(await checkTower(clientWith(fetchFn), { retryDelayMs: 0 })).toEqual({ state: 'running' });
  });

  it('after two failures reports the underlying error and never suggests starting Tower', async () => {
    const fetchFn = scriptedFetch(timeout, reset);
    const check = await checkTower(clientWith(fetchFn), { retryDelayMs: 0 });
    expect(check.state).toBe('unresponsive');
    if (check.state !== 'unresponsive') return;
    expect(check.message).toMatch(/^Tower did not answer \/health \(fetch failed: ECONNRESET\) after \d+ ms; it appears to be up, retry$/);
    expect(check.message).not.toContain('not running');
    expect(check.message).not.toContain('afx tower start');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('names the caller\'s own start command in the "not running" message', async () => {
    const check = await checkTower(clientWith(scriptedFetch(refused)), { startCommand: 'afx workspace start' });
    expect(check).toMatchObject({ message: 'Tower is not running. Start it with: afx workspace start' });
  });
});
