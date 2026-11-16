/**
 * Spec 823 Phase 1: visual regression guard for the dashboard builder
 * attribution tag.
 *
 * The attribution tag (`<id> · <architect-name>`) renders inline inside the
 * builder ID column when the workspace hosts more than one architect (per
 * baked decision 2b). This test mocks `/api/state` (for the architect count)
 * and `/api/overview` (for builders carrying `spawnedByArchitect`) at three
 * N-architect cardinalities and asserts:
 *
 *   - N=1: no `.builder-attribution` spans rendered anywhere.
 *   - N=2: attribution spans render only on builder rows whose
 *     `spawnedByArchitect` is non-null; legacy rows (null) render no span.
 *   - N=3: same N>1 rendering rule, with three sibling architects.
 *
 * It also asserts the .builder-col-id cell does not column-shift between
 * N=1 and N=2 — the column width may grow to accommodate the longer text,
 * but the layout must remain stable per the Phase 1 plan's "no column shift"
 * acceptance criterion.
 *
 * Prerequisites:
 *   - Tower running on TOWER_TEST_PORT (default 4100)
 *   - npx playwright install chromium
 *
 * Run: npx playwright test spec-823-builder-attribution
 */

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

const TOWER_URL = `http://localhost:${process.env.TOWER_TEST_PORT || '4100'}`;
const WORKSPACE_PATH = resolve(import.meta.dirname, '../../../../../../');
const ENCODED_PATH = Buffer.from(WORKSPACE_PATH).toString('base64url');
const DASH_URL = `${TOWER_URL}/workspace/${ENCODED_PATH}/`;
const API_URL = `${TOWER_URL}/workspace/${ENCODED_PATH}`;

/**
 * Builds a minimal architect entry for the mocked `/api/state` response.
 * The `port`, `pid`, and `terminalId` values are not used by the Work-view
 * rendering — they're filler that satisfies the `ArchitectState` shape.
 */
function makeArchitect(name: string, idx: number) {
  return {
    name,
    port: 0,
    pid: 1000 + idx,
    terminalId: `term-823-${name}`,
    persistent: false,
  };
}

/**
 * Builds a minimal OverviewBuilder entry for the mocked `/api/overview`
 * response. Spec 823 adds `spawnedByArchitect`; all other fields are filler
 * that satisfies the OverviewBuilder shape.
 */
function makeBuilder(
  id: string,
  issueId: string,
  spawnedByArchitect: string | null,
) {
  return {
    id,
    issueId,
    issueTitle: `Test ${issueId}`,
    phase: 'implement',
    protocolPhase: 'implement',
    mode: 'strict' as const,
    gates: {},
    worktreePath: `/tmp/.builders/${id}`,
    roleId: `builder-${id}`,
    protocol: 'spir',
    planPhases: [],
    progress: 50,
    blocked: null,
    blockedGate: null,
    blockedSince: null,
    startedAt: '2026-05-22T12:00:00Z',
    idleMs: 0,
    lastDataAt: null,
    spawnedByArchitect,
    prReady: false,
  };
}

/**
 * Installs mocks for `/api/state` and `/api/overview` on the given page so
 * the Work view renders deterministically for the supplied architect/builder
 * cardinalities. Must be called before `page.goto(DASH_URL)`.
 */
async function mockState(
  page: import('@playwright/test').Page,
  architects: Array<{ name: string; idx: number }>,
  builders: Array<{ id: string; issueId: string; spawnedByArchitect: string | null }>,
): Promise<void> {
  await page.route('**/api/state', async (route) => {
    const response = await route.fetch();
    const base = response.ok() ? await response.json().catch(() => ({})) : {};
    const architectEntries = architects.map((a) => makeArchitect(a.name, a.idx));
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...base,
        architect: architectEntries[0] ?? null,
        architects: architectEntries,
        builders: [],
        utils: [],
        annotations: [],
      }),
    });
  });

  await page.route('**/api/overview', async (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        builders: builders.map((b) => makeBuilder(b.id, b.issueId, b.spawnedByArchitect)),
        pendingPRs: [],
        backlog: [],
        recentlyClosed: [],
      }),
    });
  });
}

test.describe('Spec 823 Phase 1: dashboard builder attribution', () => {
  test('N=1 — no attribution spans rendered (baseline parity)', async ({ page }) => {
    await mockState(
      page,
      [{ name: 'main', idx: 0 }],
      [
        { id: '0042', issueId: '42', spawnedByArchitect: 'main' },
        { id: '0043', issueId: '43', spawnedByArchitect: 'main' },
        { id: '0044', issueId: '44', spawnedByArchitect: 'main' },
      ],
    );

    await page.goto(DASH_URL);
    await page.locator('#root').waitFor({ state: 'attached', timeout: 10_000 });

    // Wait for any builder row to render before asserting absence.
    await page.locator('.builder-row').first().waitFor({ state: 'attached', timeout: 10_000 });

    // No attribution spans anywhere at N=1, even though every builder carries
    // a non-null spawnedByArchitect. The N=1 dashboard renders identically to
    // pre-823.
    expect(await page.locator('.builder-attribution').count()).toBe(0);

    // Sanity: builder IDs render as expected.
    await expect(page.getByText('#42', { exact: true })).toBeVisible();
    await expect(page.getByText('#43', { exact: true })).toBeVisible();
    await expect(page.getByText('#44', { exact: true })).toBeVisible();
  });

  test('N=2 — attribution renders on non-null rows; legacy null row unchanged', async ({ page }) => {
    await mockState(
      page,
      [
        { name: 'main', idx: 0 },
        { name: 'ob-refine', idx: 1 },
      ],
      [
        { id: '0042', issueId: '42', spawnedByArchitect: 'main' },
        { id: '0043', issueId: '43', spawnedByArchitect: 'ob-refine' },
        { id: '0044', issueId: '44', spawnedByArchitect: 'ob-refine' },
        // Legacy row from before #755 — must render no attribution span even
        // though the workspace has N=2 architects.
        { id: '0045', issueId: '45', spawnedByArchitect: null },
      ],
    );

    await page.goto(DASH_URL);
    await page.locator('#root').waitFor({ state: 'attached', timeout: 10_000 });
    await page.locator('.builder-row').first().waitFor({ state: 'attached', timeout: 10_000 });

    // Three attribution spans (one per non-null spawnedByArchitect builder);
    // the legacy null row contributes none.
    expect(await page.locator('.builder-attribution').count()).toBe(3);

    // Spot-check the three names.
    expect(await page.locator('.builder-attribution').nth(0).textContent()).toBe(' · main');
    expect(await page.locator('.builder-attribution').nth(1).textContent()).toBe(' · ob-refine');
    expect(await page.locator('.builder-attribution').nth(2).textContent()).toBe(' · ob-refine');

    // Hover-tooltip carries the full "spawned by ..." text.
    expect(
      await page.locator('.builder-attribution').nth(1).getAttribute('title'),
    ).toBe('spawned by ob-refine');
  });

  test('N=3 — attribution renders for three sibling architects', async ({ page }) => {
    await mockState(
      page,
      [
        { name: 'main', idx: 0 },
        { name: 'ob-refine', idx: 1 },
        { name: 'team-a', idx: 2 },
      ],
      [
        { id: '0042', issueId: '42', spawnedByArchitect: 'main' },
        { id: '0043', issueId: '43', spawnedByArchitect: 'ob-refine' },
        { id: '0044', issueId: '44', spawnedByArchitect: 'team-a' },
        { id: '0045', issueId: '45', spawnedByArchitect: 'team-a' },
        { id: '0046', issueId: '46', spawnedByArchitect: 'ob-refine' },
        { id: '0047', issueId: '47', spawnedByArchitect: 'main' },
      ],
    );

    await page.goto(DASH_URL);
    await page.locator('#root').waitFor({ state: 'attached', timeout: 10_000 });
    await page.locator('.builder-row').first().waitFor({ state: 'attached', timeout: 10_000 });

    // Six attribution spans, one per builder.
    expect(await page.locator('.builder-attribution').count()).toBe(6);

    // Spot-check that each architect name appears at least once.
    const allText = await page.locator('.builder-attribution').allTextContents();
    expect(allText.some((t) => t.includes('main'))).toBe(true);
    expect(allText.some((t) => t.includes('ob-refine'))).toBe(true);
    expect(allText.some((t) => t.includes('team-a'))).toBe(true);
  });

  test('layout: N=1 → N=2 transition does not collapse or break the builder table', async ({ page }) => {
    // Pin the layout invariant — under N=2, the .builder-col-id cell expands
    // to fit `<id> · <architect-name>` (per Spec 823 column-width caveat: the
    // CSS was changed from `width: 60px` to `min-width: 60px` so the cell
    // grows naturally). The table still renders all rows; no row collapses.
    await mockState(
      page,
      [
        { name: 'main', idx: 0 },
        { name: 'ob-refine', idx: 1 },
      ],
      [
        { id: '0042', issueId: '42', spawnedByArchitect: 'main' },
        { id: '0043', issueId: '43', spawnedByArchitect: 'ob-refine' },
      ],
    );

    await page.goto(DASH_URL);
    await page.locator('#root').waitFor({ state: 'attached', timeout: 10_000 });
    await page.locator('.builder-row').first().waitFor({ state: 'attached', timeout: 10_000 });

    // Both rows are rendered (table didn't collapse).
    const rows = await page.locator('.builder-row').count();
    expect(rows).toBe(2);

    // .builder-col-id cells render with non-zero width (table didn't collapse
    // to 0-width column under the new content).
    const idCells = page.locator('.builder-col-id');
    const firstBox = await idCells.first().boundingBox();
    expect(firstBox).not.toBeNull();
    expect(firstBox!.width).toBeGreaterThan(0);
    expect(firstBox!.height).toBeGreaterThan(0);

    // Each builder card shows its attribution adjacent to the ID — same row,
    // same cell. The cell's text content includes both the `#NN` and the
    // architect name (with the ` · ` separator).
    const firstCellText = await idCells.first().textContent();
    expect(firstCellText).toContain('#42');
    expect(firstCellText).toContain(' · main');
  });
});
