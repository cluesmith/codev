/**
 * Tower authentication tokens for the Playwright dashboard-e2e harness.
 *
 * Tower requires the shared local key on every non-public route (advisory
 * GHSA-xvjp-7748-v88v; issue #1519). A real client only ever presents the key
 * to Tower itself: the browser shell receives it injected same-origin
 * (`window.__CODEV_TOWER_KEY__`) and never forwards it to another origin. The
 * harness mirrors that — it keys ONLY Tower-bound requests and never installs
 * an all-origins header that could disclose the key cross-origin.
 *
 * This module is deliberately free of any `@playwright/test` import so it can be
 * shared by `global-setup.ts` (node-`fetch` calls) and the vitest regression
 * test without pulling the Playwright runtime into either. The Playwright
 * `request`-fixture wiring lives in `tower-auth.ts`.
 */

import { ensureLocalKey } from '@cluesmith/codev-core/auth';
import { TOWER_KEY_HEADER, terminalWsProtocols } from '@cluesmith/codev-types';

/** The `codev-tower-key` header for a single Tower HTTP request. */
export function towerAuthHeaders(): Record<string, string> {
  return { [TOWER_KEY_HEADER]: ensureLocalKey() };
}

/**
 * The `Sec-WebSocket-Protocol` offer carrying the key for a raw browser
 * WebSocket against Tower (browsers can't set headers on a WebSocket, so the
 * key travels as the `codev-key.<key>` subprotocol).
 */
export function towerWsProtocols(): string[] | undefined {
  return terminalWsProtocols(ensureLocalKey());
}
