#!/usr/bin/env node
// Headless driver for the harness's isolated VS Code (serve-web). It uses the Chromium already in
// the Playwright cache through the workspace's own playwright install: never `playwright install`.
// The browser profile is persistent (under the harness root), so the folder-trust decision made
// on the first load holds for every later scenario.
//
//   node workbench.mjs check --url <workbench url> --profile <dir> --shot <png> --out <json>
//                            --owner-port <n>
//
// `check` loads the workbench, accepts the Restricted Mode trust prompt if it appears, and waits
// for the Codev activity-bar container (the extension under test has activated). Any browser
// request to the owner's port fails the check.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');

async function loadChromium() {
  const require = createRequire(path.join(REPO, 'packages/codev/package.json'));
  const mod = await import(pathToFileURL(require.resolve('playwright')).href);
  return mod.chromium ?? mod.default.chromium;
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    opts[flag.replace(/^--/, '')] = value;
  }
  for (const k of ['url', 'profile', 'shot', 'out', 'owner-port']) {
    if (!opts[k]) throw new Error(`--${k} is required`);
  }
  return opts;
}

const TRUST_BUTTON = /Yes, I trust the authors|Trust Folder & Continue|Trust Folder/i;

/**
 * Trust the opened folder when the window is in Restricted Mode, through the Workspace Trust
 * editor the status-bar item opens; otherwise terminal creation later stalls behind a modal.
 * The decision persists in the harness's browser profile and server user dir.
 */
async function ensureTrusted(page, result) {
  // The status bar fills in after the activity bar; the Codev status item is the cue that the
  // trust item, if any, has rendered too.
  await page.locator('[id="cluesmith.codev-vscode"]').waitFor({ timeout: 120_000 });
  await page.waitForTimeout(2000);
  const trustItem = page.locator('[id="status.workspaceTrust"]');
  const banner = page.locator('.part.banner', { hasText: 'Restricted Mode' });
  const isRestricted = async () => (await trustItem.count()) > 0 || (await banner.count()) > 0;
  if (!(await isRestricted())) return true;
  await trustItem.first().click();
  await page.getByRole('button', { name: /^Trust$/ }).first().click({ timeout: 30_000 });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const confirm = page.getByRole('button', { name: TRUST_BUTTON });
    if (await confirm.count()) await confirm.first().click();
    if (!(await isRestricted())) {
      result.trustAccepted = true;
      // The Workspace Trust editor opens as a modal editor; it blocks the workbench until closed.
      const modal = page.locator('.monaco-modal-editor-block');
      for (let i = 0; i < 10 && (await modal.count()); i++) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
      }
      if (await modal.count()) throw new Error('the Workspace Trust modal editor did not close');
      return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function check(opts) {
  const chromium = await loadChromium();
  const result = { ok: false, trustAccepted: false, ownerPortRequests: [], consoleErrors: [], error: null };
  const context = await chromium.launchPersistentContext(opts.profile, {
    headless: true,
    viewport: { width: 1600, height: 1000 },
  });
  try {
    context.on('request', (r) => {
      if (URL.canParse(r.url()) && new URL(r.url()).port === opts['owner-port']) result.ownerPortRequests.push(r.url());
    });
    const page = context.pages()[0] ?? await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error') result.consoleErrors.push(m.text()); });
    await page.goto(opts.url, { timeout: 240_000, waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.monaco-workbench', { timeout: 240_000 });

    // The Codev item's label carries its keybinding and badge ("Codev (⌥⌘C) - 1 blocked"); the
    // badge overlays the anchor, so the click goes to the action item that holds both.
    const codevItem = page.locator('.activitybar .action-item').filter({
      has: page.locator('a[aria-label="Codev"], a[aria-label^="Codev ("], a[aria-label^="Codev -"]'),
    }).first();
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const trust = page.getByRole('button', { name: TRUST_BUTTON });
      if (await trust.count()) {
        await trust.first().click();
        result.trustAccepted = true;
      }
      if (await codevItem.count()) break;
      await page.waitForTimeout(500);
    }
    if (!(await codevItem.count())) throw new Error('the Codev activity-bar container never appeared');
    result.trusted = await ensureTrusted(page, result);
    if (!result.trusted) throw new Error('the fixture folder is still in Restricted Mode');
    await codevItem.click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: opts.shot });
    if (result.ownerPortRequests.length) throw new Error(`the browser requested the owner's port: ${result.ownerPortRequests.join(', ')}`);
    result.ok = true;
  } catch (err) {
    result.error = String(err.message ?? err);
  } finally {
    await context.close();
    fs.writeFileSync(opts.out, `${JSON.stringify(result, null, 2)}\n`);
  }
  return result.ok;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== 'check') {
    console.error('usage: workbench.mjs check --url <u> --profile <dir> --shot <png> --out <json> --owner-port <n>');
    process.exit(64);
  }
  check(parseArgs(rest))
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((err) => {
      console.error(`workbench error: ${err.stack ?? err}`);
      process.exit(1);
    });
}
