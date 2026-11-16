/**
 * Regression test for Bugfix #1519: the schedule-only Playwright dashboard-e2e
 * suite made keyless Tower requests.
 *
 * PR #1421 (advisory GHSA-xvjp-7748-v88v) put every non-public Tower route
 * behind the shared local key (`codev-tower-key` header). Its in-PR fix keyed
 * only the *vitest* harness (`vitest-e2e-setup.ts`); the *Playwright* harness —
 * whose workflow is schedule-only and so never ran on the PR — kept sending
 * keyless requests. `global-setup.ts`'s `POST /api/launch` then 401'd, the
 * workspace never activated, and the suite went red with `element(s) not
 * found` the first time its schedule fired after merge.
 *
 * What this required-CI test pins, and what it deliberately leaves to the
 * Playwright suite itself:
 *   - The `global-setup.ts` HTTP paths (launch POST + state poll) are pinned
 *     end-to-end: each is exercised through a mock `fetch` and asserted to carry
 *     the key. Reverting either regresses this test. These are the paths that
 *     caused the whole-suite cascade, so they are the ones worth gating here.
 *   - The shared tokens (`towerAuthHeaders` / `towerWsProtocols`) are asserted
 *     to carry the local key, keyed to Tower only — never an all-origins header.
 *     This pins token *correctness*, not that the Playwright `request` fixture or
 *     the WebSocket opens actually use them: that wiring lives in Playwright
 *     files vitest doesn't execute, and is proven by the `workflow_dispatch` run
 *     of `dashboard-e2e.yml` cited in the PR.
 *
 * All assertions compare against `ensureLocalKey()`, so they fail against the
 * pre-fix harness and pass with it.
 */

import { describe, it, expect, vi } from 'vitest';
import { ensureLocalKey } from '@cluesmith/codev-core/auth';
import { TOWER_KEY_HEADER, WS_KEY_PROTOCOL_PREFIX } from '@cluesmith/codev-types';
import { towerAuthHeaders, towerWsProtocols } from './e2e/tower-key.js';
import { launchWorkspaceWithRetry, waitForArchitectReady } from './e2e/global-setup.js';

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  return new Headers(init?.headers).get(name) ?? undefined;
}

describe('bugfix #1519: Playwright e2e harness authenticates to Tower', () => {
  it('towerAuthHeaders carries the local key under the tower-key header (token)', () => {
    // Asserted against ensureLocalKey() rather than a hex shape so a
    // CODEV_TOWER_KEY override (which auth.ts supports and does not force to
    // 64 hex) does not false-fail this required-CI check.
    expect(towerAuthHeaders()[TOWER_KEY_HEADER]).toBe(ensureLocalKey());
  });

  it('towerWsProtocols offers the codev-key.<key> subprotocol (token)', () => {
    const protocols = towerWsProtocols();
    expect(protocols).toContain(`${WS_KEY_PROTOCOL_PREFIX}${ensureLocalKey()}`);
  });

  it('global-setup POST /api/launch presents the tower-key header (A)', async () => {
    const seen: Array<RequestInit | undefined> = [];
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(init);
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await launchWorkspaceWithRetry('http://localhost:4100/api/launch', '/tmp/ws', {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(seen).toHaveLength(1);
    expect(headerOf(seen[0], TOWER_KEY_HEADER)).toBe(ensureLocalKey());
    // The pre-existing Content-Type is preserved alongside the injected key.
    expect(headerOf(seen[0], 'Content-Type')).toBe('application/json');
  });

  it('global-setup state poll presents the tower-key header (A)', async () => {
    const seen: Array<RequestInit | undefined> = [];
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(init);
      return new Response(JSON.stringify({ architect: { terminalId: 'term-1' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const ready = await waitForArchitectReady('http://localhost:4100/workspace/x/api/state', {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(ready).toBe(true);
    expect(seen).toHaveLength(1);
    expect(headerOf(seen[0], TOWER_KEY_HEADER)).toBe(ensureLocalKey());
  });
});
