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
 * These assertions pin the harness to presenting the key the way a real client
 * does. They fail against the pre-fix harness (no key header) and pass with it.
 */

import { describe, it, expect, vi } from 'vitest';
import { TOWER_KEY_HEADER } from '@cluesmith/codev-types';
import { launchWorkspaceWithRetry, towerAuthHeaders } from './e2e/global-setup.js';
import playwrightConfig from '../../../playwright.config.js';

const HEX_64 = /^[0-9a-f]{64}$/;

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  return new Headers(init?.headers).get(name) ?? undefined;
}

describe('bugfix #1519: Playwright e2e harness authenticates to Tower', () => {
  it('towerAuthHeaders carries a well-formed local key under the tower-key header', () => {
    const headers = towerAuthHeaders();
    const key = headers[TOWER_KEY_HEADER];
    expect(key).toMatch(HEX_64);
  });

  it('global-setup POST /api/launch presents the tower-key header', async () => {
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
    expect(headerOf(seen[0], TOWER_KEY_HEADER)).toMatch(HEX_64);
    // The pre-existing Content-Type is preserved alongside the injected key.
    expect(headerOf(seen[0], 'Content-Type')).toBe('application/json');
  });

  it('playwright.config injects the tower-key header into every request context', () => {
    const key = playwrightConfig.use?.extraHTTPHeaders?.[TOWER_KEY_HEADER];
    expect(key).toMatch(HEX_64);
  });
});
