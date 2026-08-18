/**
 * Playwright fixtures that authenticate the dashboard-e2e suite to Tower the
 * way a real client does — same-origin only (advisory GHSA-xvjp-7748-v88v;
 * issue #1519).
 *
 * The `request` fixture is replaced with a Tower-scoped, keyed
 * `APIRequestContext`: direct-API tests present the `codev-tower-key` header on
 * their calls, which only ever target Tower, so the key is never attached to a
 * page navigation or a cross-origin subresource load. Browser page fetches use
 * the key Tower injects into the shell same-origin, exactly as the shipped
 * dashboard does; raw WebSocket and `page.request` calls carry the key
 * explicitly via `tower-key.ts`.
 */

import { test as base, expect } from '@playwright/test';
import { towerAuthHeaders } from './tower-key.js';

export const test = base.extend({
  request: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({
      extraHTTPHeaders: towerAuthHeaders(),
    });
    await use(context);
    await context.dispose();
  },
});

export { expect };
