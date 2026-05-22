/**
 * Regression test for Bugfix #773: Flaky Dashboard E2E global-setup.
 *
 * Tower returns HTTP 400 with `error: "Tower is still starting up. Try again
 * shortly."` while its async `_deps` initialization is in flight. The previous
 * `global-setup.ts` issued POST /api/launch exactly once and treated any
 * non-OK response as a benign "workspace may already be active" — so a cold
 * Tower start raced the test harness, the workspace was never activated, and
 * every terminal-dependent test timed out 30s later.
 *
 * The fix retries POST /api/launch while the response body contains the
 * "Tower is still starting up" marker, with a bounded total budget. Other
 * non-OK responses are still tolerated (no retry, no throw) so the existing
 * "already active" pass-through is preserved.
 */

import { describe, it, expect, vi } from 'vitest';
import { launchWorkspaceWithRetry } from './e2e/global-setup.js';

const URL = 'http://localhost:4100/api/launch';
const WORKSPACE = '/tmp/workspace';

const transientResponse = () =>
  new Response(
    JSON.stringify({ success: false, error: 'Tower is still starting up. Try again shortly.' }),
    { status: 400, headers: { 'Content-Type': 'application/json' } },
  );

const successResponse = () =>
  new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const terminalFailureResponse = () =>
  new Response(
    JSON.stringify({ success: false, error: 'Path does not exist: /missing' }),
    { status: 400, headers: { 'Content-Type': 'application/json' } },
  );

describe('bugfix #773: launchWorkspaceWithRetry', () => {
  it('returns ok on the first successful response without retrying', async () => {
    const fetchFn = vi.fn(async () => successResponse());

    const result = await launchWorkspaceWithRetry(URL, WORKSPACE, { fetchFn });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.attempts).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('retries while Tower reports "still starting up", then resolves on success', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(transientResponse())
      .mockResolvedValueOnce(transientResponse())
      .mockResolvedValueOnce(successResponse());

    const result = await launchWorkspaceWithRetry(URL, WORKSPACE, {
      fetchFn,
      interval: 1,
      timeout: 1_000,
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a non-transient 4xx — terminal failures fail fast', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(terminalFailureResponse());

    const result = await launchWorkspaceWithRetry(URL, WORKSPACE, {
      fetchFn,
      interval: 1,
      timeout: 1_000,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.body).toContain('Path does not exist');
    expect(result.attempts).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the timeout if Tower never finishes starting', async () => {
    // Each call returns a fresh Response — bodies are single-use streams.
    const fetchFn = vi.fn(async () => transientResponse());

    const result = await launchWorkspaceWithRetry(URL, WORKSPACE, {
      fetchFn,
      interval: 10,
      timeout: 50,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.body).toContain('Tower is still starting up');
    expect(result.attempts).toBeGreaterThanOrEqual(2);
    // Sanity: bounded by the budget, not unbounded retries
    expect(result.attempts).toBeLessThan(50);
  });

  it('sends POST /api/launch with the workspacePath in the JSON body', async () => {
    const fetchFn = vi.fn(async () => successResponse());

    await launchWorkspaceWithRetry(URL, WORKSPACE, { fetchFn });

    expect(fetchFn).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ workspacePath: WORKSPACE }),
      }),
    );
  });
});
