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
 * These assertions pin the shared auth tokens (`tower-key.ts`) that the harness
 * now presents on every Tower-bound path: HTTP setup calls (A), the direct-API
 * request fixture / `page.request` calls (B), and raw WebSocket opens (C). They
 * fail against the pre-fix harness and pass with it. The tokens are keyed to
 * Tower only — never installed as an all-origins header — so the key is never
 * disclosed to a cross-origin request.
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
  it('towerAuthHeaders carries the local key under the tower-key header (B)', () => {
    // Asserted against ensureLocalKey() rather than a hex shape so a
    // CODEV_TOWER_KEY override (which auth.ts supports and does not force to
    // 64 hex) does not false-fail this required-CI check.
    expect(towerAuthHeaders()[TOWER_KEY_HEADER]).toBe(ensureLocalKey());
  });

  it('towerWsProtocols offers the codev-key.<key> subprotocol (C)', () => {
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
