/**
 * Spec 1313 Phase 8: browser-level guard for the dashboard held-count indicator.
 *
 * The header badge (`HeldCountBadge`, `data-testid="held-badge"`) renders the
 * count of currently-held mailbox rows from `OverviewData.heldCount`, entering a
 * distinct attention state (a pulsing amber dot, `held-badge--attention` /
 * `held-dot--attention`) when `OverviewData.mailboxEscalated` is true. It is
 * count-only and read-only (spec Decision 8).
 *
 * This test mocks `/api/state` (to keep the desktop layout deterministic) and
 * `/api/overview` (the badge's data source) and asserts, in a real browser
 * against the built dashboard bundle:
 *
 *   - heldCount 0 → the badge is not rendered (stays out of the way).
 *   - heldCount 3, not escalated → "3 held", no attention class/dot.
 *   - heldCount 1, escalated → "1 held", attention class + pulsing dot.
 *   - live update → mutating the overview stub from 2/not-escalated to
 *     4/escalated flips the badge WITHOUT a reload (via the `useOverview` poll /
 *     SSE refetch), proving the count updates live and escalation moves it into
 *     the attention state.
 *
 * Spec 1967 (plan phase 12) extends it in place for the three counts: mail held
 * for release and mail waiting for a peer are shown apart from held mail, held
 * for release puts the badge in its attention state and waiting for a peer
 * never does, and the popover lists each kind in its own group, each group as
 * long as its count (asserted on the grouping, not only the counts: `GET
 * /api/inbox` lists held-for-release rows, which `heldCount` excludes).
 *
 * Runs only through `playwright.peers.config.ts`, on a fresh throwaway Tower
 * (never port 4100, never reused), against a throwaway workspace directory:
 * every route it asserts is mocked, but the page comes from the Tower.
 *
 * Run: TOWER_TEST_PORT=14102 npx playwright test --config playwright.peers.config.ts
 */

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOWER_URL = `http://localhost:${process.env.TOWER_TEST_PORT}`;
let workspacePath = '';

test.beforeAll(() => {
  workspacePath = mkdtempSync(join(realpathSync(tmpdir()), 'codev-held-count-'));
});

test.afterAll(() => {
  if (workspacePath) rmSync(workspacePath, { recursive: true, force: true });
});

function dashUrl(): string {
  return `${TOWER_URL}/workspace/${Buffer.from(workspacePath).toString('base64url')}/`;
}

/**
 * A minimal OverviewData payload carrying the held fields. Every other
 * list is empty — the header badge reads only the counts and `mailboxEscalated`,
 * and empty builders/PRs/backlog keep the Work view inert for the assertion.
 */
function overviewBody(heldCount: number, mailboxEscalated: boolean, peer: { heldForReleaseCount?: number; waitingForPeerCount?: number } = {}): string {
  return JSON.stringify({
    builders: [],
    pendingPRs: [],
    backlog: [],
    recentlyClosed: [],
    architects: [],
    heldCount,
    mailboxEscalated,
    heldForReleaseCount: peer.heldForReleaseCount ?? 0,
    waitingForPeerCount: peer.waitingForPeerCount ?? 0,
  });
}

/**
 * A static, minimal DashboardState so the desktop layout mounts deterministically
 * (empty terminals → no architect/builder tabs; the header renders regardless).
 * Static (not a `route.fetch` passthrough) so no route callback is left in flight
 * when the page closes between assertions.
 */
const STATE_BODY = JSON.stringify({
  architect: null,
  architects: [],
  builders: [],
  utils: [],
  annotations: [],
  version: '0.0.0-e2e',
  hostname: 'e2e',
  workspaceName: 'spir-1313',
});

/**
 * Installs the `/api/state` + `/api/overview` mocks. `getOverview` is read on
 * every `/api/overview` request, so a test can mutate it mid-run to simulate a
 * held-state-change broadcast and prove the badge updates live. `/api/state` is
 * a fixed minimal payload — the header badge reads only the overview, so the
 * state just needs to let the desktop layout mount.
 */
async function installRoutes(page: Page, getOverview: () => string, lists: { inbox?: unknown[]; outbox?: unknown } = {}): Promise<void> {
  await page.route('**/api/state', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: STATE_BODY }),
  );

  await page.route('**/api/overview', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: getOverview() }),
  );

  // The popover's two lists, read when it opens.
  await page.route('**/api/inbox', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(lists.inbox ?? []) }),
  );
  await page.route('**/api/peer/outbox', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(lists.outbox ?? { paused: null, messages: [] }) }),
  );
}

async function gotoDashboard(page: Page): Promise<void> {
  await page.goto(dashUrl());
  await page.locator('#root').waitFor({ state: 'attached', timeout: 15_000 });
  // The header controls always render in the desktop layout; anchor on them so
  // an absent badge (count 0) is a real absence, not an un-mounted page.
  await page.locator('.header-controls').waitFor({ state: 'attached', timeout: 15_000 });
}

test.describe('Spec 1313 Phase 8: dashboard held-count indicator', () => {
  test('renders no badge when nothing is held', async ({ page }) => {
    await installRoutes(page, () => overviewBody(0, false));
    await gotoDashboard(page);
    await expect(page.getByTestId('held-badge')).toHaveCount(0);
  });

  test('shows the held count without the attention state when not escalated', async ({ page }) => {
    await installRoutes(page, () => overviewBody(3, false));
    await gotoDashboard(page);

    const badge = page.getByTestId('held-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('3 held');
    await expect(badge).not.toHaveClass(/held-badge--attention/);
    await expect(page.locator('.held-dot--attention')).toHaveCount(0);
  });

  test('enters the attention state (pulsing dot) when escalated', async ({ page }) => {
    await installRoutes(page, () => overviewBody(1, true));
    await gotoDashboard(page);

    const badge = page.getByTestId('held-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('1 held');
    await expect(badge).toHaveClass(/held-badge--attention/);
    await expect(badge.locator('.held-dot--attention')).toHaveCount(1);
  });

  test('updates the count and attention state live, without a reload', async ({ page }) => {
    // A mutable holder the /api/overview mock reads each request — flipping it
    // mid-test simulates a held-state-change broadcast + an age crossing.
    const holder = { body: overviewBody(2, false) };
    await installRoutes(page, () => holder.body);
    await gotoDashboard(page);

    const badge = page.getByTestId('held-badge');
    await expect(badge).toContainText('2 held');
    await expect(badge).not.toHaveClass(/held-badge--attention/);

    // Two more rows are held and one escalates. `useOverview` refetches on its
    // poll / SSE tick, so the badge converges without a page reload.
    holder.body = overviewBody(4, true);
    await expect(badge).toContainText('4 held', { timeout: 8_000 });
    await expect(badge).toHaveClass(/held-badge--attention/);
    await expect(badge.locator('.held-dot--attention')).toHaveCount(1);
  });

  // ------------------------------------------------------------------ Spec 1967: three counts

  test('shows the three counts apart, and enters the attention state for mail held for release', async ({ page }) => {
    await installRoutes(page, () => overviewBody(2, false, { heldForReleaseCount: 1, waitingForPeerCount: 3 }));
    await gotoDashboard(page);

    const badge = page.getByTestId('held-badge');
    await expect(badge.getByTestId('held-count-held')).toHaveText('2 held');
    await expect(badge.getByTestId('held-count-release')).toContainText('1 for release');
    await expect(badge.getByTestId('held-count-peer')).toContainText('3 for a peer');
    await expect(badge).toHaveClass(/held-badge--attention/);
    await expect(badge.locator('.held-dot--attention')).toHaveCount(1);
  });

  test('mail held for release alone: its count, and the attention state with nothing escalated', async ({ page }) => {
    await installRoutes(page, () => overviewBody(0, false, { heldForReleaseCount: 1 }));
    await gotoDashboard(page);

    const badge = page.getByTestId('held-badge');
    await expect(badge.getByTestId('held-count-release')).toContainText('1 for release');
    await expect(badge.getByTestId('held-count-held')).toHaveCount(0);
    await expect(badge).toHaveClass(/held-badge--attention/);
  });

  test('mail waiting for a peer alone: its count, never the attention state', async ({ page }) => {
    await installRoutes(page, () => overviewBody(0, false, { waitingForPeerCount: 4 }));
    await gotoDashboard(page);

    const badge = page.getByTestId('held-badge');
    await expect(badge.getByTestId('held-count-peer')).toContainText('4 for a peer');
    await expect(badge.getByTestId('held-count-held')).toHaveCount(0);
    await expect(badge).not.toHaveClass(/held-badge--attention/);
    await expect(page.locator('.held-dot--attention')).toHaveCount(0);
  });

  test('the popover lists each kind in its own group, each as long as its count', async ({ page }, testInfo) => {
    const now = Date.now();
    const local = (id: string, toAgent: string) => ({
      id, workspacePath, toAgent, fromAgent: 'architect', reason: 'busy', detail: 'user-text',
      escalated: false, createdAt: now - 90_000, notBefore: null, remoteSender: null, remoteOwnerEmail: null,
    });
    const released = (id: string, toAgent: string) => ({
      id, workspacePath, toAgent, fromAgent: null, reason: 'held-for-release', detail: null,
      escalated: false, createdAt: now - 300_000, notBefore: null,
      remoteSender: 'afx://devvm/codev:architect:main', remoteOwnerEmail: 'ana@example.com',
    });
    const waiting = (id: string) => ({
      id, to: 'afx://devvm/codev:architect:local', peerTowerId: '01JDEVVM0000000000000000AA', peerName: 'devvm',
      fromAgent: 'architect:main', workspacePath, sentAt: now - 120_000, expiresAt: now + 29 * 86_400_000,
      state: 'held', reason: 'tower-offline', lastOutcome: 'unavailable', attempts: 3, nextAttemptAt: now + 60_000,
      inFlight: false, resolvedAt: null,
    });
    await installRoutes(page, () => overviewBody(1, false, { heldForReleaseCount: 2, waitingForPeerCount: 1 }), {
      inbox: [local('l1', 'spir-1'), released('r1', 'architect:local'), released('r2', 'architect:main')],
      outbox: { paused: null, messages: [waiting('w1')] },
    });
    await gotoDashboard(page);

    await page.getByTestId('held-badge').click();
    const popover = page.getByTestId('held-popover');
    const held = popover.getByTestId('held-group-held');
    const release = popover.getByTestId('held-group-release');
    const peer = popover.getByTestId('held-group-peer');

    // Each group is as long as the count the badge shows for it.
    await expect(held.getByTestId('held-row')).toHaveCount(1);
    await expect(release.getByTestId('held-row')).toHaveCount(2);
    await expect(peer.getByTestId('held-row')).toHaveCount(1);
    await expect(popover).toContainText('Held (1)');
    await expect(popover).toContainText('Held for release (2)');
    await expect(popover).toContainText('Waiting for a peer (1)');

    // Each row is in its own group only.
    await expect(held).toContainText('architect → spir-1');
    await expect(held).not.toContainText('afx://devvm');
    await expect(release).toContainText('afx://devvm/codev:architect:main → architect:local');
    await expect(release).toContainText('afx://devvm/codev:architect:main → architect:main');
    await expect(peer).toContainText('architect:main → afx://devvm/codev:architect:local');
    await expect(peer).toContainText('tower-offline');

    await page.screenshot({ path: testInfo.outputPath('held-count-three-groups.png'), clip: { x: 0, y: 0, width: 1280, height: 520 } });
  });
});
