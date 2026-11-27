/**
 * Spec 1967, plan phase 12: the read-only Peers panel on Tower's home page, in a real browser.
 *
 * Runs only through `playwright.peers.config.ts`, on a fresh throwaway Tower with directories of
 * its own (never port 4100, never reused). The marked states come from route-mocking the panel's
 * one read-only route, `GET /api/peer/panel`, which is deterministic; each mocks a registered
 * Tower or one with the switch on. One case reads the real route unmocked, on the fresh Tower as
 * it starts: the switch off and no cloud registration, so the section is absent (the architect's
 * ruling in phase 13: it appears once the Tower is connected or the switch is on).
 *
 * What is proven, rendered: no section on a Tower never connected with the switch off; the peer
 * list with the online hint and what each Tower may message here; the switch; a peer that is not
 * verifying, one whose clock is out of range and one shown as "cloud error", each on its own row,
 * and this Tower's own clock; with one peer and with several; through Codev Cloud, that turning
 * on and granting are done at the machine, with no control on the panel; why a list is not a
 * fresh one; that names from the route are text, never markup; and a route failure said as one.
 *
 * Run: TOWER_TEST_PORT=14102 npx playwright test --config playwright.peers.config.ts
 */

import { test, expect, type Page } from '@playwright/test';
import type { PeerGrantView, PeerListedTowerView, PeerMarkView, PeerPanelResponse } from '@cluesmith/codev-types';

const TOWER_URL = `http://localhost:${process.env.TOWER_TEST_PORT}`;
const LISTED_AT = Date.UTC(2026, 10, 27, 9, 30, 0);

function grant(recipient: string, mode: PeerGrantView['mode'] = 'deliver'): PeerGrantView {
  return {
    peerTowerId: '01JDEVVM0000000000000000AA',
    peerName: 'devvm',
    scope: 'architect',
    mode,
    workspacePath: '/work/codev',
    workspaceName: 'codev',
    architect: 'local',
    recipient,
    reaches: null,
    matchesNothing: null,
    createdAt: LISTED_AT,
    updatedAt: LISTED_AT,
  };
}

function mark(name: PeerMarkView['mark']): PeerMarkView {
  return { mark: name, run: name === 'clock-out-of-range' ? 1 : 5, since: LISTED_AT - 600_000, lastAt: LISTED_AT - 60_000 };
}

function tower(name: string, over: Partial<PeerListedTowerView> = {}): PeerListedTowerView {
  return {
    towerId: `01J${name.toUpperCase().padEnd(23, '0')}`,
    name,
    online: true,
    protocols: [1],
    remoteMessaging: 'on',
    mayMessage: [],
    marks: [],
    ...over,
  };
}

function panel(over: Partial<PeerPanelResponse> = {}): PeerPanelResponse {
  return {
    remoteMessaging: 'on',
    towerName: 'ana-s-mbp',
    tunnel: 'up',
    relay: { state: 'available', why: null },
    listing: { fresh: true, refreshedAt: LISTED_AT, problem: null, retryAfterSec: null },
    towers: [],
    clockSkewSince: null,
    viaTunnel: false,
    ...over,
  };
}

async function showPanel(page: Page, body?: PeerPanelResponse | { status: number }): Promise<void> {
  if (body !== undefined) {
    await page.route('**/api/peer/panel', (route) =>
      'status' in body && !('towers' in body)
        ? route.fulfill({ status: body.status, contentType: 'application/json', body: '{"error":"INTERNAL_ERROR"}' })
        : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }),
    );
  }
  await page.goto(`${TOWER_URL}/`);
  await expect(page.getByTestId('peers-panel')).toBeVisible({ timeout: 15_000 });
}

test.describe('Spec 1967: the Peers panel on Tower home', () => {
  test('a fresh Tower, unmocked: no cloud registration and the switch off, so the section is absent', async ({ page }, testInfo) => {
    const panelAnswered = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/peer/panel');
    await page.goto(`${TOWER_URL}/`);
    await panelAnswered;

    // The route itself, read by the page with the key the Tower injects same-origin.
    const answer = await page.evaluate(async () => {
      const key = (window as unknown as { __CODEV_TOWER_KEY__?: string }).__CODEV_TOWER_KEY__ ?? '';
      const response = await fetch('./api/peer/panel', { headers: { 'codev-tower-key': key } });
      return { status: response.status, body: (await response.json()) as PeerPanelResponse };
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      remoteMessaging: 'off',
      towerName: null,
      tunnel: 'down',
      relay: { state: 'unknown' },
      listing: { fresh: false, refreshedAt: null, problem: 'not-connected' },
      towers: [],
      clockSkewSince: null,
      viaTunnel: false,
    });

    // The page rendered that answer: the home page is up, and the Peers section is not on it.
    await expect(page.locator('#peers-container')).toBeAttached();
    await expect(page.locator('#peers-container')).toBeEmpty();
    await expect(page.getByTestId('peers-panel')).toHaveCount(0);
    await expect(page.getByText('Remote messaging:')).toHaveCount(0);

    await page.screenshot({ path: testInfo.outputPath('peers-hidden-unregistered.png'), fullPage: true });
  });

  test('one peer: its name, the online hint, its own switch and what it may message here', async ({ page }) => {
    await showPanel(page, panel({
      towers: [tower('devvm', { mayMessage: [grant('codev:architect:local'), grant('codev:architect:main', 'hold')] })],
    }));

    await expect(page.getByTestId('peers-switch')).toHaveAttribute('data-state', 'on');
    await expect(page.getByTestId('peers-switch')).not.toContainText('afx peer on');
    const row = page.getByTestId('peer-row');
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('data-peer', 'devvm');
    await expect(row.getByTestId('peer-online')).toHaveText('online');
    await expect(row).toContainText('remote messaging on');
    await expect(row.getByTestId('peer-may')).toHaveText(
      'May message this Tower: codev:architect:local (deliver), codev:architect:main (hold for release)',
    );
    await expect(row.getByTestId('peer-mark')).toHaveCount(0);
    // Read-only here too, not only through the cloud: no control of any kind.
    await expect(page.getByTestId('peers-panel').locator('button, input, select, textarea, a[href]')).toHaveCount(0);
  });

  test('several peers: each mark on its own peer, and this Tower\'s own clock', async ({ page }, testInfo) => {
    await showPanel(page, panel({
      towers: [
        tower('devvm', { marks: [mark('not-verifying')], mayMessage: [grant('codev:architect:local')] }),
        tower('lab', { online: false, remoteMessaging: 'off', marks: [mark('clock-out-of-range')] }),
        tower('mini', { marks: [mark('cloud-error')] }),
        tower('studio', { remoteMessaging: 'unknown' }),
      ],
      clockSkewSince: LISTED_AT - 120_000,
    }));

    const rows = page.getByTestId('peer-row');
    await expect(rows).toHaveCount(4);
    const marksOf = async (peer: string) =>
      page.locator(`[data-testid="peer-row"][data-peer="${peer}"] [data-testid="peer-mark"]`).evaluateAll((els) => els.map((el) => el.getAttribute('data-mark')));
    expect(await marksOf('devvm')).toEqual(['not-verifying']);
    expect(await marksOf('lab')).toEqual(['clock-out-of-range']);
    expect(await marksOf('mini')).toEqual(['cloud-error']);
    expect(await marksOf('studio')).toEqual([]);

    const devvm = page.locator('[data-testid="peer-row"][data-peer="devvm"]');
    await expect(devvm.getByTestId('peer-mark')).toContainText('Not verifying: its last 5 messages from here were not verified there');
    const lab = page.locator('[data-testid="peer-row"][data-peer="lab"]');
    await expect(lab.getByTestId('peer-online')).toHaveText('offline');
    await expect(lab).toContainText('remote messaging off');
    await expect(lab.getByTestId('peer-mark')).toContainText('Clock out of range: it refused a message from here as clock-skew');
    await expect(page.locator('[data-testid="peer-row"][data-peer="mini"] [data-testid="peer-mark"]')).toContainText(
      'Cloud error: Codev Cloud failed the last 5 messages to it',
    );
    await expect(page.locator('[data-testid="peer-row"][data-peer="studio"]')).toContainText('remote messaging unknown');
    await expect(page.getByTestId('peers-clock')).toContainText("This Tower's clock may be out of range");

    await page.getByTestId('peers-panel').screenshot({ path: testInfo.outputPath('peers-panel-several.png') });
  });

  test('through Codev Cloud: turning on and granting are done at the machine, and the panel has no control', async ({ page }, testInfo) => {
    await showPanel(page, panel({ remoteMessaging: 'off', viaTunnel: true, towers: [tower('devvm')] }));

    const note = page.getByTestId('peers-via-cloud');
    await expect(note).toContainText('Turning remote messaging on and granting a peer are not available through Codev Cloud');
    await expect(note).toContainText("at this Tower's own machine");
    // Through the cloud the switch line offers no command it would refuse; the note says where.
    await expect(page.getByTestId('peers-switch')).toHaveText('Remote messaging: off');
    const panelEl = page.getByTestId('peers-panel');
    await expect(panelEl.locator('button, input, select, textarea, a[href]')).toHaveCount(0);

    await panelEl.screenshot({ path: testInfo.outputPath('peers-panel-via-cloud.png') });
  });

  test('why the list is not a fresh one, a cloud with no relay, and this Tower\'s own tunnel down', async ({ page }) => {
    await showPanel(page, panel({
      tunnel: 'down',
      relay: { state: 'none', why: 'stated-none' },
      listing: { fresh: false, refreshedAt: LISTED_AT, problem: 'cloud-unreachable', retryAfterSec: null },
      towers: [tower('devvm')],
    }));

    const notes = page.getByTestId('peers-note');
    await expect(notes.filter({ hasText: 'Codev Cloud is unreachable; this is the list from' })).toHaveCount(1);
    await expect(notes.filter({ hasText: 'This Codev Cloud has no relay: remote messaging is unavailable.' })).toHaveCount(1);
    await expect(notes.filter({ hasText: "This Tower's own tunnel is down: it can send, but cannot receive" })).toHaveCount(1);
  });

  test('an account with no other Towers says so', async ({ page }) => {
    await showPanel(page, panel());
    await expect(page.getByTestId('peers-empty')).toHaveText('No other Towers are on your Codev Cloud account.');
  });

  test('names, recipients and an unknown mode from the route are text, never markup', async ({ page }) => {
    const hostile = '<img src=x onerror="window.__peersXss=1">';
    const unknownMode = '<b>later</b>' as unknown as PeerGrantView['mode'];
    await showPanel(page, panel({ towers: [tower(hostile, { mayMessage: [grant(hostile), grant('codev:architect:x', unknownMode)] })] }));

    await expect(page.getByTestId('peer-row')).toHaveCount(1);
    await expect(page.getByTestId('peers-panel').locator('img, b')).toHaveCount(0);
    await expect(page.getByTestId('peer-row').locator('.peer-name')).toHaveText(hostile);
    // A mode the page does not know is shown as it is, not relabelled as deliver.
    await expect(page.getByTestId('peer-may')).toContainText('codev:architect:x (<b>later</b>)');
    expect(await page.evaluate(() => (window as unknown as { __peersXss?: number }).__peersXss)).toBeUndefined();
  });

  test('an answer slower than the next request never replaces the newer list', async ({ page }) => {
    let calls = 0;
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    let slowAnswered: () => void = () => {};
    const slowFulfilled = new Promise<void>((resolve) => { slowAnswered = resolve; });
    await page.route('**/api/peer/panel', async (route) => {
      calls += 1;
      const call = calls;
      if (call === 2) await released;
      const name = call === 1 ? 'first' : call === 2 ? 'stale' : 'fresh';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(panel({ towers: [tower(name)] })) });
      if (call === 2) slowAnswered();
    });
    await showPanel(page);
    await expect(page.getByTestId('peer-row')).toHaveAttribute('data-peer', 'first');

    // Two refreshes: the first answered only after the second.
    await page.evaluate(() => {
      const w = window as unknown as { refreshPeers: () => Promise<void> };
      void w.refreshPeers();
      return w.refreshPeers();
    });
    await expect(page.getByTestId('peer-row')).toHaveAttribute('data-peer', 'fresh');
    release();
    await slowFulfilled;
    await page.waitForTimeout(300);
    await expect(page.getByTestId('peer-row')).toHaveAttribute('data-peer', 'fresh');
  });

  test('a route failure is said as one, not shown as an empty list', async ({ page }) => {
    await showPanel(page, { status: 500 });
    await expect(page.getByTestId('peers-error')).toContainText('The peer list could not be loaded: Tower answered 500');
    await expect(page.getByTestId('peer-row')).toHaveCount(0);
  });
});
