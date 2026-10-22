/**
 * Spec 1595 Phase 7: the dashboard renders each served agent state distinctly.
 *
 * Mocks `/api/overview` with builders at needs-input (a permission prompt whose summary
 * carries Markdown and HTML), idle, dead, working and blocked, plus an architect at a
 * prompt, and asserts in a real browser:
 *
 *   - each builder card shows its own state text ("Needs input: …", "Idle", "Agent exited",
 *     the phase, "Blocked: …"), with dead carrying its own row and text treatment (SC7);
 *   - the needs-input summary renders literally as text, never as markup (SC19);
 *   - the Needs Attention list gains rows for the needs-input and dead builders and for the
 *     architect at a prompt, but not for the idle or working builders (SC13).
 *
 * Prerequisites:
 *   - Tower running on TOWER_TEST_PORT (default 4100)
 *   - npx playwright install chromium
 *
 * Run: npx playwright test spec-1595-agent-state
 */

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

const TOWER_URL = `http://localhost:${process.env.TOWER_TEST_PORT || '4100'}`;
const WORKSPACE_PATH = resolve(import.meta.dirname, '../../../../../../');
const ENCODED_PATH = Buffer.from(WORKSPACE_PATH).toString('base64url');
const DASH_URL = `${TOWER_URL}/workspace/${ENCODED_PATH}/`;

/** A summary carrying Markdown, a command link and HTML: it must render as these exact characters. */
const HOSTILE_SUMMARY = '<img src=x onerror=alert(1)> [run](command:x) **b**';

const SINCE = new Date(Date.now() - 3 * 60_000).toISOString();
const FRESH = new Date().toISOString();

function servedState(state: string, needsInput?: unknown) {
  return {
    state,
    since: SINCE,
    source: 'harness',
    alive: state !== 'dead',
    activity: null,
    activityAt: SINCE,
    backgroundWork: false,
    ...(needsInput ? { needsInput } : {}),
  };
}

function makeBuilder(issueId: string, overrides: Record<string, unknown>) {
  return {
    id: `spir-${issueId}`,
    issueId,
    issueTitle: `Test ${issueId}`,
    phase: 'implement',
    protocolPhase: 'implement',
    mode: 'strict' as const,
    gates: {},
    worktreePath: `/tmp/.builders/spir-${issueId}`,
    roleId: `builder-spir-${issueId}`,
    protocol: 'spir',
    planPhases: [],
    progress: 50,
    blocked: null,
    blockedGate: null,
    blockedSince: null,
    startedAt: '2026-05-22T12:00:00Z',
    idleMs: 0,
    lastDataAt: FRESH,
    spawnedByArchitect: null,
    prReady: false,
    ...overrides,
  };
}

const BUILDERS = [
  makeBuilder('11', { agentState: servedState('needs-input', { kind: 'permission', tool: 'Bash', summary: HOSTILE_SUMMARY }) }),
  makeBuilder('12', { agentState: servedState('idle') }),
  makeBuilder('13', { agentState: servedState('dead') }),
  makeBuilder('14', { agentState: servedState('working') }),
  makeBuilder('15', {
    blocked: 'plan review',
    blockedGate: 'plan-approval',
    blockedSince: SINCE,
    agentState: servedState('blocked'),
  }),
];

const ARCHITECTS = [
  { name: 'main', port: 0, pid: 0, terminalId: 'term-1595-main', persistent: false, lastDataAt: FRESH, agentState: servedState('needs-input', { kind: 'question' }) },
];

test.describe('Spec 1595: dashboard agent states', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/overview', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        builders: BUILDERS,
        architects: ARCHITECTS,
        pendingPRs: [],
        backlog: [],
        recentlyClosed: [],
        heldCount: 0,
        mailboxEscalated: false,
        queuedFeedback: {},
        feedbackMode: 'forward',
      }),
    }));
    await page.goto(DASH_URL);
    await page.locator('#root').waitFor({ state: 'attached', timeout: 10_000 });
    await page.locator('.builder-row').first().waitFor({ state: 'attached', timeout: 10_000 });
  });

  test('each builder card shows its state distinctly', async ({ page }) => {
    const stateOf = (issue: string) =>
      page.locator('.builder-row', { hasText: `#${issue}` }).locator('.builder-col-state span');

    await expect(stateOf('11')).toHaveText(`Needs input: at a permission prompt: Bash ${HOSTILE_SUMMARY}`);
    await expect(stateOf('12')).toHaveText('Idle');
    await expect(stateOf('13')).toHaveText('Agent exited');
    await expect(stateOf('14')).toHaveText('implement');
    await expect(stateOf('15')).toHaveText('Blocked: plan review');

    // Dead has its own treatment, distinct from the waits (SC7).
    await expect(stateOf('13')).toHaveClass('builder-state-dead');
    await expect(page.locator('.builder-row--dead')).toHaveCount(1);
    await expect(page.locator('.builder-row--waiting')).toHaveCount(2);
    const deadColor = await stateOf('13').evaluate((el) => getComputedStyle(el).color);
    const idleColor = await stateOf('12').evaluate((el) => getComputedStyle(el).color);
    expect(deadColor).not.toBe(idleColor);
  });

  test('a needs-input summary renders literally, never as markup (SC19)', async ({ page }) => {
    const cell = page.locator('.builder-row', { hasText: '#11' }).locator('.builder-col-state');
    await expect(cell.locator('img')).toHaveCount(0);
    await expect(cell.locator('a')).toHaveCount(0);
    await expect(cell.locator('span')).toHaveAttribute('title', `Needs input: at a permission prompt: Bash ${HOSTILE_SUMMARY}`);
  });

  test('Needs Attention lists needs-input and dead agents, builders and architects (SC13)', async ({ page }) => {
    const rows = page.locator('.attention-row');
    await expect(rows.filter({ hasText: '#11' })).toContainText('Needs input');
    await expect(rows.filter({ hasText: '#13' })).toContainText('Agent exited');
    await expect(rows.filter({ hasText: 'architect' })).toContainText('main');
    await expect(rows.filter({ hasText: 'architect' })).toContainText('Needs input');
    // The gate row covers the blocked builder; idle and working builders are not asks.
    await expect(rows.filter({ hasText: '#15' })).toContainText('plan review');
    await expect(rows.filter({ hasText: '#12' })).toHaveCount(0);
    await expect(rows.filter({ hasText: '#14' })).toHaveCount(0);
    await page.screenshot({ path: process.env.SPEC_1595_SCREENSHOT || '/tmp/spec-1595-dashboard.png', fullPage: true });
  });
});
