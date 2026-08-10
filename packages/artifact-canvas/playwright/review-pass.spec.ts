import { test, expect } from '@playwright/test';

/**
 * The complete review pass in horizontal mode (spec 1380 success criterion / phase 6):
 * read → comment → submit → see card → edit → delete, mouse-driven, in the browser host.
 * Every write round-trips through the stub text store (the same #1055 verified-write
 * contract the VS Code host uses), so each step really is a content reload.
 */

test('full review pass: add → edit → delete, in horizontal mode', async ({ page }) => {
  await page.goto('/?fixture=columns&mode=horizontal');
  const body = page.locator('.codev-artifact-canvas-body');
  await expect(body.locator('h1')).toHaveText('Columns fixture');
  await expect(body.locator('.codev-canvas-marker-card')).toHaveCount(6);

  // ADD: hover a block, open the composer, submit.
  const target = body.locator('p', { hasText: 'Between blocks.' });
  await target.hover();
  await page.locator('.codev-canvas-add-comment').click();
  await page.locator('.codev-canvas-comment-composer-input').fill('review-pass comment');
  await page.locator('.codev-canvas-comment-composer-submit').click();
  const card = body.locator('.codev-canvas-marker-card', { hasText: 'review-pass comment' });
  await expect(card).toBeVisible();
  await expect(body.locator('.codev-canvas-marker-card')).toHaveCount(7);

  // EDIT: the card's action buttons render because the host wired the intents and the stub
  // markers carry `markerLine`. Rewrite the body and confirm the round-trip.
  await card.hover();
  await card.locator('.codev-canvas-marker-card-edit').click();
  const editor = page.locator('.codev-canvas-comment-composer-input');
  await expect(editor).toHaveValue('review-pass comment');
  await editor.fill('review-pass comment, edited');
  await page.locator('.codev-canvas-comment-composer-submit').click();
  const edited = body.locator('.codev-canvas-marker-card', { hasText: 'review-pass comment, edited' });
  await expect(edited).toBeVisible();

  // DELETE: remove it and confirm the stack returns to the fixture's six cards.
  await edited.hover();
  await edited.locator('.codev-canvas-marker-card-delete').click();
  await expect(
    body.locator('.codev-canvas-marker-card', { hasText: 'review-pass' }),
  ).toHaveCount(0);
  await expect(body.locator('.codev-canvas-marker-card')).toHaveCount(6);

  // The whole pass happened without leaving horizontal mode.
  await expect(page.locator('.codev-artifact-canvas')).toHaveClass(/codev-canvas-mode-horizontal/);
});
