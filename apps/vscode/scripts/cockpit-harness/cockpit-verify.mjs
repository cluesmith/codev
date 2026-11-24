#!/usr/bin/env node
// Scripted rendered verification of the Codev Cockpit (Spec 1963) against the harness's isolated
// VS Code and Tower. Run through `harness.mjs verify <script>`, never directly: the harness passes
// the workbench URL template, the fixture, log and screenshot paths, and re-checks the tripwire
// around the run. Uses the Chromium already in the Playwright cache (never `playwright install`).
//
// Scripts:
//   explore    open the Cockpit on alpha, expand everything, dump the rows (selector discovery)
//   render     button under Codev, hierarchy N=0/1/>1 across workspaces, Dormant group, themes
//   actions    every builder context action, Approve Gate inline, every workspace-row action,
//              Remove Architect, another workspace's rows, Tower Open / Deactivate
//   reveal     active-file reveal with the workspace and architect rows collapsed
//   windows    builder-worktree window, no-workspace window, Cockpit-only freshness
//   reconnect  Not connected (isolated Tower stopped by PID) → reconnect (started again)
//   requests   request count: Cockpit alone vs Workspace + Agents + Tower alone (scenario 21)
//
// Every result is recorded in --out as { script, results: [{ name, ok, detail, shots }] }. Any
// browser request to the owner's port fails the run.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  for (const k of ['url-template', 'fixtures', 'profile', 'shots', 'out', 'owner-port', 'stub-log', 'request-log', 'tower-port']) {
    if (!opts[k]) throw new Error(`--${k} is required`);
  }
  return opts;
}

// ---------------------------------------------------------------------------------------------
// Run context
// ---------------------------------------------------------------------------------------------

class Run {
  constructor(script, opts) {
    this.script = script;
    this.opts = opts;
    this.results = [];
    this.ownerPortRequests = [];
    this.popups = [];
    this.shotIndex = 0;
  }

  url(query) {
    return this.opts['url-template'].replace('__QUERY__', query);
  }

  folderUrl(...segments) {
    return this.url(`folder=${encodeURIComponent(path.join(this.opts.fixtures, ...segments))}`);
  }

  async shot(page, name) {
    const file = path.join(this.opts.shots, `${this.script}-${String(++this.shotIndex).padStart(2, '0')}-${name}.png`);
    await page.screenshot({ path: file });
    return file;
  }

  /** Record one check. `fn` returns a detail string (or { detail, shots }) or throws. */
  async check(name, fn) {
    const started = Date.now();
    try {
      const out = await fn();
      const detail = typeof out === 'string' ? out : out?.detail ?? '';
      this.results.push({ name, ok: true, detail, shots: out?.shots ?? [], ms: Date.now() - started });
      console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
    } catch (err) {
      const shots = [];
      if (this.page) {
        shots.push(await this.shot(this.page, 'failure').catch(() => null));
        // Close a menu, quick input or dialog the failure left open, so it does not block the next check.
        for (let i = 0; i < 3; i++) await this.page.keyboard.press('Escape').catch(() => {});
      }
      this.results.push({ name, ok: false, detail: String(err.message ?? err), shots: shots.filter(Boolean), ms: Date.now() - started });
      console.log(`FAIL  ${name} — ${err.message ?? err}${shots[0] ? ` (screenshot ${shots[0]})` : ''}`);
    }
  }

  write() {
    fs.writeFileSync(this.opts.out, `${JSON.stringify({
      script: this.script, at: new Date().toISOString(), ownerPortRequests: this.ownerPortRequests,
      popups: this.popups, results: this.results,
    }, null, 2)}\n`);
  }

  // Stub log: the afx / porch / codev calls the extension made, as recorded by the stubs.
  stubCalls() {
    const f = this.opts['stub-log'];
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean).map(JSON.parse);
  }

  // Tower request log (request-log.cjs preloaded into the isolated Tower).
  towerRequests() {
    const f = this.opts['request-log'];
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean).map(JSON.parse);
  }

  async tower(method, route, body) {
    const res = await fetch(`http://127.0.0.1:${this.opts['tower-port']}${route}`, {
      method,
      headers: { 'codev-tower-key': process.env.COCKPIT_TOWER_KEY, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${route} answered ${res.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  }

  overview(ws) {
    return this.tower('GET', `/api/overview?workspace=${encodeURIComponent(path.join(this.opts.fixtures, ws))}`);
  }

  /** Call back into harness.mjs (tower-down / tower-up). */
  harness(cmd) {
    const r = spawnSync(process.execPath, [path.join(HERE, 'harness.mjs'), cmd], {
      env: { ...process.env }, encoding: 'utf-8', timeout: 120_000,
    });
    if (r.status !== 0) throw new Error(`harness ${cmd} failed: ${r.stderr || r.stdout}`);
    return r.stdout.trim();
  }
}

// ---------------------------------------------------------------------------------------------
// Workbench helpers
// ---------------------------------------------------------------------------------------------

const TRUST_BUTTON = /Yes, I trust the authors|Trust Folder & Continue|Trust Folder/i;

async function newContext(R) {
  const chromium = await loadChromium();
  const context = await chromium.launchPersistentContext(R.opts.profile, {
    headless: true,
    viewport: { width: 1600, height: 1000 },
  });
  context.on('request', (r) => {
    if (URL.canParse(r.url()) && new URL(r.url()).port === R.opts['owner-port']) R.ownerPortRequests.push(r.url());
    // Main-frame navigations, kept because a popup's URL that nothing serves ends as
    // chrome-error://. A popup's first navigation is issued before its frame exists, and
    // request.frame() throws for it: that one is recorded with no page.
    if (r.isNavigationRequest()) {
      let frame = null;
      try { frame = r.frame(); } catch { /* a popup's first navigation */ }
      if (!frame || frame === frame.page().mainFrame()) navigations.push({ at: Date.now(), page: frame ? frame.page() : null, url: r.url() });
    }
  });
  return context;
}

/** Load a workbench URL into `page`, accept folder trust, and wait for the Codev extension. */
async function loadWorkbench(page, url, { needCodev = true } = {}) {
  await page.goto(url, { timeout: 240_000, waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.monaco-workbench', { timeout: 240_000 });
  const cockpit = activityItem(page, 'Codev Cockpit');
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const trust = page.getByRole('button', { name: TRUST_BUTTON });
    if (await trust.count()) await trust.first().click();
    if (await cockpit.count()) break;
    await page.waitForTimeout(500);
  }
  if (!(await cockpit.count())) throw new Error('the Codev Cockpit activity-bar item never appeared');
  if (needCodev) {
    await page.locator('[id="cluesmith.codev-vscode"]').waitFor({ timeout: 120_000 });
    await page.waitForTimeout(1500);
    await ensureTrusted(page);
  }
  await closeNotifications(page);
}

async function ensureTrusted(page) {
  const trustItem = page.locator('[id="status.workspaceTrust"]');
  if (!(await trustItem.count())) return;
  await trustItem.first().click();
  await page.getByRole('button', { name: /^Trust$/ }).first().click({ timeout: 30_000 });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && (await trustItem.count())) {
    const confirm = page.getByRole('button', { name: TRUST_BUTTON });
    if (await confirm.count()) await confirm.first().click();
    await page.waitForTimeout(500);
  }
  for (let i = 0; i < 10 && (await page.locator('.monaco-modal-editor-block').count()); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }
}

/**
 * An activity-bar item by its container title. Its anchor's label carries the keybinding and the
 * badge ("Codev (⌥⌘C) - 1 blocked"), and the badge overlays the anchor, so this returns the
 * action item that holds both.
 */
function activityItem(page, label) {
  const anchor = [`a[aria-label="${label}"]`, `a[aria-label^="${label} ("]`, `a[aria-label^="${label} -"]`].join(', ');
  return page.locator('.activitybar .action-item').filter({ has: page.locator(anchor) }).first();
}

/** Open a view container from the activity bar (clicking an already-open one would close it). */
async function openContainer(page, label, containerId) {
  const sidebar = page.locator(`[id="workbench.view.extension.${containerId}"]`);
  if (await sidebar.isVisible().catch(() => false)) return sidebar;
  await activityItem(page, label).click();
  await sidebar.waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(1000);
  return sidebar;
}

const openCockpit = (page) => openContainer(page, 'Codev Cockpit', 'codev-cockpit');
const openCodev = (page) => openContainer(page, 'Codev', 'codev');

/**
 * Every rendered row of the tree in `scope`, in tree order (by `data-index`: the list is virtualized
 * and its DOM order is not its visual order).
 */
async function rows(scope) {
  const all = await scope.locator('.monaco-list-row').evaluateAll((els) => els.map((el) => ({
    index: Number(el.getAttribute('data-index')),
    label: el.getAttribute('aria-label'),
    text: el.querySelector('.label-name')?.textContent ?? '',
    description: el.querySelector('.label-description')?.textContent ?? '',
    level: Number(el.getAttribute('aria-level')),
    expanded: el.getAttribute('aria-expanded'),
    selected: el.classList.contains('selected'),
    focused: el.classList.contains('focused'),
  })));
  return all.sort((a, b) => a.index - b.index);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const toRe = (x) => (x instanceof RegExp ? x : new RegExp(`^${escapeRe(x)}$`));

/**
 * The row at `spec`, a path of label matchers from an ancestor down (each a string for an exact
 * label or a RegExp), each step searched only inside the previous step's subtree. Returns the row
 * record plus `loc`, its locator, or null when it is not rendered.
 */
async function findRow(scope, spec) {
  const all = await rows(scope);
  let start = 0;
  let end = all.length;
  let found = null;
  for (const step of spec.map(toRe)) {
    found = null;
    for (let i = start; i < end; i++) {
      if (step.test(all[i].text)) { found = i; break; }
    }
    if (found === null) return null;
    const level = all[found].level;
    start = found + 1;
    end = start;
    while (end < all.length && all[end].level > level) end++;
  }
  const r = all[found];
  return { ...r, loc: scope.locator(`.monaco-list-row[data-index="${r.index}"]`) };
}

/** The row at `spec` and the rows of its subtree (rendered ones), as records. */
async function subtree(scope, spec) {
  const head = await findRow(scope, spec);
  if (!head) return null;
  const all = await rows(scope);
  const i = all.findIndex((r) => r.index === head.index);
  const out = [];
  for (let j = i + 1; j < all.length && all[j].level > head.level; j++) out.push(all[j]);
  return { head, rows: out };
}

async function waitRow(scope, spec, timeout = 30_000) {
  return waitFor(`row ${spec.map(String).join(' › ')}`, () => findRow(scope, spec), timeout);
}

/** Expand (or collapse) the row at `spec`, through its twistie (a row click may run a command). */
async function setExpanded(scope, spec, expanded) {
  const r = await waitRow(scope, spec);
  if (r.expanded === null) throw new Error(`row ${r.text} is not expandable`);
  if ((r.expanded === 'true') !== expanded) {
    await r.loc.locator('.monaco-tl-twistie').click();
    await scope.page().waitForTimeout(900);
  }
  return waitFor(`row ${r.text} ${expanded ? 'expanded' : 'collapsed'}`, async () => {
    const now = await findRow(scope, spec);
    return now && (now.expanded === 'true') === expanded ? now : null;
  }, 10_000);
}

/** Expand every step of `spec` in turn. */
async function expandPath(scope, spec) {
  for (let k = 1; k <= spec.length; k++) await setExpanded(scope, spec.slice(0, k), true);
}

/**
 * Right-click `r` (a locator) and run the context-menu entry titled `title`. VS Code ignores a
 * click on an entry that lands just after the menu opened (measured: at once it is dropped, after
 * 500 ms it runs), so wait first; a menu still open afterwards means the entry did not run.
 */
async function contextAction(r, title) {
  const page = r.page();
  await r.click({ button: 'right' });
  const item = page.locator('.monaco-menu:visible .action-item .action-label', { hasText: new RegExp(`^${escapeRe(title)}$`) });
  await item.first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  await item.first().click();
  await waitFor(`the menu to close after ${title}`, async () => (await page.locator('.monaco-menu:visible').count()) === 0, 3000);
  await page.waitForTimeout(800);
}

/**
 * The Codev entries of the context menu shown for `r` (closes the menu again). VS Code adds its own
 * entries to every tree row (Copy, chat actions); those are not this extension's and are left out.
 */
async function contextTitles(r) {
  const page = r.page();
  await r.click({ button: 'right' });
  const menu = page.locator('.monaco-menu:visible');
  // A row with no entries at all (VS Code adds none of its own to it) opens no menu.
  if (!await menu.first().waitFor({ timeout: 3000 }).then(() => true, () => false)) return [];
  await page.waitForTimeout(300);
  const titles = await menu.locator('.action-item:not(.disabled) .action-label').allTextContents();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  return titles.map((t) => t.trim()).filter((t) => t.startsWith('Codev:'));
}

/** True when right-clicking `r` shows no Codev entry (VS Code may still show its own menu). */
async function hasNoCodevMenu(r) {
  const page = r.page();
  await r.click({ button: 'right' });
  await page.waitForTimeout(1200);
  const titles = await page.locator('.monaco-menu:visible .action-item .action-label').allTextContents();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  return titles.map((t) => t.trim()).filter((t) => t.startsWith('Codev:'));
}

/** A button label without its keybinding suffix: "Codev: Approve Gate (⌘K G)" → "Codev: Approve Gate". */
const withoutKeybinding = (t) => (t ?? '').replace(/ \((?:[⌘⌥⇧⌃]|Ctrl\+|Alt\+|Shift\+|Cmd\+)[^()]*\)$/, '');

/** The inline action buttons on `r` (hover first: they render on hover / selection). */
async function inlineTitles(r) {
  await r.hover();
  await r.page().waitForTimeout(300);
  const labels = await r.locator('.actions .action-label').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? el.getAttribute('title')));
  return labels.map(withoutKeybinding);
}

async function inlineAction(r, title) {
  const titles = await inlineTitles(r);
  const i = titles.indexOf(title);
  if (i < 0) throw new Error(`no inline ${title} on the row (it has ${JSON.stringify(titles)})`);
  await r.locator('.actions .action-label').nth(i).click();
  await r.page().waitForTimeout(800);
}

async function notifications(page) {
  return page.locator('.notifications-toasts .notification-toast .notification-list-item-message').allTextContents();
}

async function closeNotifications(page) {
  for (let i = 0; i < 10; i++) {
    const close = page.locator('.notifications-toasts .codicon-notifications-clear, .notifications-toasts .action-label.codicon-close');
    if (!(await close.count())) return;
    await close.first().click().catch(() => {});
    await page.waitForTimeout(200);
  }
}

async function waitForNotification(page, re, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let seen = [];
  while (Date.now() < deadline) {
    seen = await notifications(page);
    const hit = seen.find((t) => re.test(t));
    if (hit) return hit;
    await page.waitForTimeout(400);
  }
  throw new Error(`no notification matching ${re}; saw ${JSON.stringify(seen)}`);
}

async function dialog(page) {
  const box = page.locator('.monaco-dialog-box');
  await box.waitFor({ timeout: 15_000 });
  return box;
}

async function dialogButton(page, name) {
  const box = await dialog(page);
  // The message: the box's text without its buttons and close action.
  const text = await box.evaluate((el) => {
    const copy = el.cloneNode(true);
    copy.querySelectorAll('.monaco-button, .action-label, .dialog-buttons-row').forEach((n) => n.remove());
    return copy.textContent.replace(/\s+/g, ' ').trim();
  });
  await box.locator('.dialog-buttons .monaco-button', { hasText: new RegExp(`^${escapeRe(name)}$`) }).click();
  await page.waitForTimeout(800);
  return text.trim();
}

async function quickInput(page) {
  const widget = page.locator('.quick-input-widget');
  await widget.waitFor({ state: 'visible', timeout: 15_000 });
  return widget;
}

async function quickType(page, text) {
  const widget = await quickInput(page);
  await widget.locator('input').fill(text);
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
}

async function quickItems(page) {
  const widget = await quickInput(page);
  await page.waitForTimeout(400);
  return widget.locator('.quick-input-list .monaco-list-row .label-name').allTextContents();
}

async function quickPick(page, label) {
  const widget = await quickInput(page);
  await widget.locator('.quick-input-list .monaco-list-row', { hasText: label }).first().click();
  await page.waitForTimeout(600);
}

async function editorTabs(page) {
  return page.locator('.tabs-container .tab').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? el.textContent));
}

async function activeEditorTab(page) {
  return page.locator('.tabs-container .tab.active').first().getAttribute('aria-label');
}

async function waitFor(what, fn, timeout = 20_000, interval = 500) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Run the palette command whose label is exactly `title`; throws when the palette has none. */
async function runCommand(page, title) {
  await page.keyboard.press('F1');
  const widget = await quickInput(page);
  await widget.locator('input').fill(`>${title}`);
  await page.waitForTimeout(600);
  const items = widget.locator('.quick-input-list .monaco-list-row');
  const labels = await items.evaluateAll((els) => els.map((el) => el.querySelector('.label-name')?.textContent?.trim() ?? ''));
  const i = labels.indexOf(title);
  if (i < 0) {
    await page.keyboard.press('Escape');
    throw new Error(`no palette command "${title}" (the palette offers ${JSON.stringify(labels.slice(0, 8))})`);
  }
  await items.nth(i).click();
  await page.waitForTimeout(800);
}

/**
 * What each workbench part shows: visibility, the active container's title (a tabbed part's
 * checked tab, else the title label), and the side bar's panes with their expansion.
 */
async function partState(page) {
  return page.evaluate(() => {
    const visible = (el) => !!el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== 'hidden';
    const one = (sel) => {
      const part = document.querySelector(sel);
      if (!visible(part)) return { visible: false };
      const tab = part.querySelector('.composite-bar .action-item.checked .action-label');
      const title = (tab?.getAttribute('aria-label') ?? part.querySelector('.composite.title .title-label')?.textContent ?? '').trim();
      const panes = [...part.querySelectorAll('.pane')].filter(visible).map((pane) => {
        const header = pane.querySelector('.pane-header');
        return { title: (header?.querySelector('.title')?.textContent ?? '').trim().replace(/ \(\d+\)$/, ''), expanded: header?.getAttribute('aria-expanded') === 'true' };
      });
      return { visible: true, title, panes };
    };
    return { sidebar: one('.part.sidebar'), auxiliarybar: one('.part.auxiliarybar'), panel: one('.part.panel') };
  });
}

/** Show or hide a workbench part through its toggle command, then confirm the change. */
async function setPart(page, part, visible) {
  const toggle = { panel: 'View: Toggle Panel Visibility', auxiliarybar: 'View: Toggle Secondary Side Bar Visibility' }[part];
  if ((await partState(page))[part].visible !== visible) await runCommand(page, toggle);
  await waitFor(`the ${part} ${visible ? 'shown' : 'hidden'}`, async () => (await partState(page))[part].visible === visible, 5000);
}

async function setTheme(page, theme) {
  await runCommand(page, 'Preferences: Color Theme');
  const widget = await quickInput(page);
  await widget.locator('input').fill(theme);
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
}

/** Wait for a new browser page (window.open from the workbench) and record its URL. */
/** Every main-frame navigation request, by page (the context's request listener fills it). */
const navigations = [];

/**
 * Wait for a new browser page (window.open from the workbench) and return the URL it navigated
 * to: its first main-frame navigation request, so a URL nothing serves (an unserved dev URL)
 * reads as itself rather than the chrome-error:// page it lands on.
 */
async function nextPopup(R, context, action, timeout = 20_000) {
  const t0 = Date.now();
  const [popup] = await Promise.all([context.waitForEvent('page', { timeout }), action()]);
  await popup.waitForLoadState('domcontentloaded').catch(() => {});
  const nav = await waitFor('the popup\'s navigation', async () => navigations
    .find((n) => n.at >= t0 && (n.page === popup || n.page === null) && n.url !== 'about:blank'), 10_000);
  R.popups.push(nav.url);
  await popup.close();
  return nav.url;
}

// ---------------------------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------------------------

const SCRIPTS = {};

// Row paths in the fleet fixture (`fleet` scenario): labels change with state and age, so builder
// rows match on their issue number.
const B = (id) => new RegExp(`#${id}\\b`);
const ALPHA = ['Tower', 'alpha'];
const A_MAIN = [...ALPHA, /^MAIN \(/];
const A_WEB = [...ALPHA, /^WEB \(/];
const BETA = ['Tower', 'beta'];
const GAMMA = ['Tower', 'gamma'];

/** Titles every builder row of this window's workspace offers (the Agents menu, from package.json). */
function expectedBuilderTitles(contextValue, hasDevCommand) {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'apps/vscode/package.json'), 'utf-8'));
  const titles = new Map(pkg.contributes.commands.map((c) => [c.command, c.title]));
  const out = [];
  for (const e of pkg.contributes.menus['view/item/context']) {
    if (!e.when.startsWith('view == codev.agents && ') || e.group.startsWith('inline')) continue;
    const m = e.when.match(/viewItem =~ \/(.+?)\//);
    if (!m || !new RegExp(m[1]).test(contextValue)) continue;
    if (e.when.includes('codev.hasDevCommand') && !hasDevCommand) continue;
    out.push(titles.get(e.command));
  }
  return out;
}

const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** Load alpha with the Cockpit open; returns the Cockpit pane. */
async function alphaCockpit(R, page) {
  await loadWorkbench(page, R.folderUrl('alpha'));
  const cockpit = await openCockpit(page);
  await waitRow(cockpit, A_MAIN, 60_000);
  return cockpit;
}

/** New Tower terminals since `before` (ids). */
async function newTerminals(R, before) {
  const { terminals } = await R.tower('GET', '/api/terminals');
  return (terminals ?? []).filter((t) => !before.has(t.id));
}

async function terminalIds(R) {
  const { terminals } = await R.tower('GET', '/api/terminals');
  return new Set((terminals ?? []).map((t) => t.id));
}

/** Run `action`; report what it produced: popup URL, new editor tabs, notifications, new terminals. */
async function effects(R, context, page, action, { wait = 4000, popup = false } = {}) {
  const tabsBefore = new Set(await editorTabs(page));
  const termsBefore = await terminalIds(R);
  const stubBefore = R.stubCalls().length;
  await closeNotifications(page);
  let popupUrl = null;
  if (popup) {
    popupUrl = await nextPopup(R, context, action);
  } else {
    await action();
  }
  await page.waitForTimeout(wait);
  return {
    popupUrl,
    tabs: (await editorTabs(page)).filter((t) => !tabsBefore.has(t)),
    notes: await notifications(page),
    terminals: (await newTerminals(R, termsBefore)).map((t) => t.label ?? t.name ?? t.id),
    stub: R.stubCalls().slice(stubBefore).filter((c) => c.caller === 'vscode'),
  };
}

const describe = (e) => JSON.stringify(Object.fromEntries(Object.entries(e).filter(([, v]) => v && (!Array.isArray(v) || v.length))));

// ── explore ──────────────────────────────────────────────────────────────────────────────────

SCRIPTS.explore = async (R, context, page) => {
  await R.check('alpha window loads with the Cockpit', async () => {
    const cockpit = await alphaCockpit(R, page);
    await page.waitForTimeout(3000);
    const all = await rows(cockpit);
    fs.writeFileSync(path.join(R.opts.shots, 'explore-rows.json'), `${JSON.stringify(all, null, 2)}\n`);
    return { detail: `${all.length} rows`, shots: [await R.shot(page, 'cockpit')] };
  });
};

// ── render ───────────────────────────────────────────────────────────────────────────────────

SCRIPTS.render = async (R, context, page) => {
  let cockpit;
  await R.check('scenario 11: the Cockpit button sits directly below Codev', async () => {
    await loadWorkbench(page, R.folderUrl('alpha'));
    const labels = await page.locator('.activitybar .action-item a').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
    const codev = labels.findIndex((l) => /^Codev( \(|$| -)/.test(l));
    const cockpitAt = labels.findIndex((l) => /^Codev Cockpit( \(|$| -)/.test(l));
    if (codev < 0 || cockpitAt !== codev + 1) throw new Error(`activity bar order: ${JSON.stringify(labels)}`);
    const shot = path.join(R.opts.shots, `render-${String(++R.shotIndex).padStart(2, '0')}-activity-bar.png`);
    await page.locator('.part.activitybar').screenshot({ path: shot });
    return { detail: `items ${codev}: "${labels[codev]}", ${cockpitAt}: "${labels[cockpitAt]}"`, shots: [shot] };
  });

  await R.check('scenario 11: the existing Codev container is unchanged', async () => {
    // Its contribution is byte-identical to origin/main's, and it renders those views in that
    // order (Team only under codev.teamEnabled, which the fixture does not set).
    const branch = JSON.parse(fs.readFileSync(path.join(REPO, 'apps/vscode/package.json'), 'utf-8')).contributes.views.codev;
    const main = JSON.parse(spawnSync('git', ['show', 'origin/main:apps/vscode/package.json'], { cwd: REPO, encoding: 'utf-8' }).stdout).contributes.views.codev;
    if (JSON.stringify(branch) !== JSON.stringify(main)) throw new Error('the codev container\'s views differ from origin/main');
    const codev = await openCodev(page);
    const headers = (await codev.locator('.pane-header .title').allTextContents()).map((t) => t.trim().replace(/ \(\d+\)$/, ''));
    const want = branch.filter((v) => v.id !== 'codev.team').map((v) => v.name);
    if (JSON.stringify(headers) !== JSON.stringify(want)) throw new Error(`rendered ${JSON.stringify(headers)}, want ${JSON.stringify(want)}`);
    return { detail: `contribution identical to origin/main; renders ${headers.join(', ')}`, shots: [await R.shot(page, 'codev-container')] };
  });

  await R.check('scenario 12: hierarchy with N>1, N=1 and N=0 builders across workspaces', async () => {
    cockpit = await openCockpit(page);
    await waitRow(cockpit, A_MAIN, 60_000);
    for (const spec of [ALPHA, A_MAIN, A_WEB, BETA, [...BETA, /^MAIN \(/], GAMMA]) await setExpanded(cockpit, spec, true);
    const got = {};
    for (const [name, spec] of [['alpha', ALPHA], ['beta', BETA], ['gamma', GAMMA]]) {
      const t = await subtree(cockpit, spec);
      got[name] = t.rows.map((r) => `${'  '.repeat(r.level - 3)}${r.text}`);
    }
    const builders = (name) => got[name].filter((l) => /#\d+/.test(l)).length;
    const problems = [];
    if (builders('alpha') !== 3) problems.push(`alpha has ${builders('alpha')} builders`);
    if (builders('beta') !== 1) problems.push(`beta has ${builders('beta')} builders`);
    if (builders('gamma') !== 0) problems.push(`gamma has ${builders('gamma')} builders`);
    for (const [spec, ids] of [[A_MAIN, [101, 102]], [A_WEB, [103]], [[...BETA, /^MAIN \(/], [201]]]) {
      const t = await subtree(cockpit, spec);
      const under = t.rows.filter((r) => r.level === t.head.level + 1).map((r) => r.text);
      for (const id of ids) if (!under.some((x) => B(id).test(x))) problems.push(`#${id} not under ${t.head.text}`);
    }
    const ws = await findRow(cockpit, ALPHA);
    if (!/current/.test(ws.description)) problems.push(`alpha row lacks the current marker: "${ws.description}"`);
    if (problems.length) throw new Error(`${problems.join('; ')} — ${JSON.stringify(got)}`);
    return { detail: JSON.stringify(got), shots: [await R.shot(page, 'hierarchy-light')] };
  });

  await R.check('the Dormant group', async () => {
    await setExpanded(cockpit, ['Tower', /^Dormant \(1\)$/], true);
    const t = await subtree(cockpit, ['Tower', /^Dormant \(1\)$/]);
    const names = t.rows.map((r) => r.text);
    if (!names.includes('delta')) throw new Error(`Dormant holds ${JSON.stringify(names)}`);
    const delta = t.rows.find((r) => r.text === 'delta');
    if (delta.expanded !== null) throw new Error('a dormant workspace row is expandable');
    return { detail: `Dormant (1): ${names.join(', ')}`, shots: [await R.shot(page, 'dormant')] };
  });

  await R.check('scenario 18 (hierarchy part): dark theme, then a live switch back to light', async () => {
    await setTheme(page, 'Dark Modern');
    const dark = await page.locator('.monaco-workbench').evaluate((el) => el.classList.contains('vs-dark'));
    const darkShot = await R.shot(page, 'hierarchy-dark');
    await setTheme(page, 'Light Modern');
    const light = await page.locator('.monaco-workbench').evaluate((el) => el.classList.contains('vs'));
    const still = await findRow(cockpit, A_MAIN);
    if (!dark || !light || !still) throw new Error(`dark=${dark} light=${light} rows kept=${Boolean(still)}`);
    return { detail: 'vs-dark then vs; rows kept across the switch', shots: [darkShot, await R.shot(page, 'hierarchy-light-again')] };
  });
};

// ── actions ──────────────────────────────────────────────────────────────────────────────────

SCRIPTS.actions = async (R, context, page) => {
  // The fleet scenario's own state: only #101 blocked. Earlier scripts (windows, requests) leave
  // #102's and #103's gates requested.
  for (const id of [102, 103]) if (gateRequested(R, 'alpha', id)) requestGate(R, 'alpha', id, { request: false });
  if (!gateRequested(R, 'alpha', 101)) throw new Error('#101\'s gate is not requested: reseed the fleet scenario');
  const cockpit = await alphaCockpit(R, page);
  for (const spec of [ALPHA, A_MAIN, A_WEB]) await setExpanded(cockpit, spec, true);
  const b101 = [...A_MAIN, B(101)];
  const b102 = [...A_MAIN, B(102)];
  const row = async (spec) => (await waitRow(cockpit, spec)).loc;

  await R.check('scenario 12: a builder row\'s menu shows the Agents entries (blocked and waiting rows)', async () => {
    const out = [];
    for (const [spec, ctx] of [[b101, 'blocked-builder-spir'], [b102, 'awaiting-builder-spir']]) {
      const got = await contextTitles(await row(spec));
      const want = expectedBuilderTitles(ctx, true);
      if (!sameSet(got, want)) throw new Error(`${spec.at(-1)}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      out.push(`${ctx}: ${got.length} entries`);
    }
    return out.join('; ');
  });

  await R.check('the same builder\'s menu in the Agents view matches the Cockpit\'s', async () => {
    const cockpitTitles = await contextTitles(await row(b101));
    try {
      const codev = await openCodev(page);
      // Titles carry counts ("Agents (3)").
      const agents = codev.locator('.pane').filter({ has: page.locator('.pane-header .title', { hasText: /^Agents( \(\d+\))?$/i }) });
      const agentRow = await waitFor('#101 in Agents', async () => {
        const hit = await findRow(agents, [B(101)]);
        if (hit) return hit;
        // Builders sit under collapsed group rows (stage axis by default): open the first one.
        const closed = (await rows(agents)).find((r) => r.expanded === 'false' && r.level === 1);
        if (closed) await agents.locator(`.monaco-list-row[data-index="${closed.index}"] .monaco-tl-twistie`).click();
        return null;
      }, 30_000);
      const agentTitles = await contextTitles(agentRow.loc);
      if (!sameSet(agentTitles, cockpitTitles)) throw new Error(`Agents ${JSON.stringify(agentTitles)} vs Cockpit ${JSON.stringify(cockpitTitles)}`);
      return `${agentTitles.length} identical entries`;
    } finally {
      await openCockpit(page);
    }
  });

  await R.check('Approve Gate is inline on the blocked row only', async () => {
    const blocked = await inlineTitles(await row(b101));
    const waiting = await inlineTitles(await row(b102));
    if (!blocked.includes('Codev: Approve Gate') || waiting.includes('Codev: Approve Gate')) {
      throw new Error(`#101 ${JSON.stringify(blocked)}, #102 ${JSON.stringify(waiting)}`);
    }
    return `#101 inline ${JSON.stringify(blocked)}`;
  });

  const builderAction = (title, spec, check, opts = {}) => R.check(`builder menu › ${title}`, async () => {
    const e = await effects(R, context, page, async () => contextAction(await row(spec), title), opts);
    const verdict = check(e);
    if (verdict !== true) throw new Error(`${verdict}: ${describe(e)}`);
    const shots = opts.shot ? [await R.shot(page, opts.shot)] : [];
    return { detail: describe(e), shots };
  });

  await builderAction('Codev: Open Builder Terminal', b102, (e) => e.tabs.some((t) => /102|second-main/.test(t)) || 'no builder terminal tab', { shot: 'open-builder-terminal' });
  await builderAction('Codev: View Spec File', b101, (e) => e.tabs.some((t) => /gated-spec|101/.test(t)) || 'no spec tab', { shot: 'view-spec' });
  await builderAction('Codev: View Plan File', b101, (e) => (e.tabs.length || e.notes.length) ? true : 'no visible outcome');
  await builderAction('Codev: View Review File', b101, (e) => (e.tabs.length || e.notes.length) ? true : 'no visible outcome');
  await builderAction('Codev: View Diff', b101, (e) => e.tabs.length ? true : 'no diff tab', { shot: 'view-diff' });
  await builderAction('Codev: Open Worktree in New Window', b101, (e) => (e.popupUrl && decodeURIComponent(e.popupUrl).includes('/.builders/')) || 'no worktree window', { popup: true });
  await builderAction('Codev: Open Worktree Folder', b101, () => true);
  // Setup runs `afx setup <id>` in a VS Code terminal in the workspace root: the stub records it.
  await builderAction('Codev: Run Worktree Setup', b101, (e) => e.stub.some((c) => c.tool === 'afx' && c.argv.join(' ') === 'setup 101' && c.cwd.endsWith('/alpha')) || 'no `afx setup 101` in alpha');

  await R.check('builder menu › Codev: Run Dev, then the workspace row offers Stop Dev; then Codev: Stop Dev', async () => {
    const started = await effects(R, context, page, async () => contextAction(await row(b101), 'Codev: Run Dev'), { wait: 5000 });
    if (!started.terminals.length) throw new Error(`no dev terminal: ${describe(started)}`);
    const wsTitles = await waitFor('workspace row offering Stop Dev', async () => {
      const t = await contextTitles(await row(ALPHA));
      return t.includes('Codev: Stop Dev') ? t : null;
    }, 15_000);
    const shot = await R.shot(page, 'worktree-dev-running');
    const before = await terminalIds(R);
    await contextAction(await row(b101), 'Codev: Stop Dev');
    const gone = await waitFor('dev terminal gone', async () => {
      const now = await terminalIds(R);
      return started.terminals.length && now.size < before.size ? now : null;
    }, 15_000).catch(() => null);
    const after = await contextTitles(await row(ALPHA));
    if (!gone || !after.includes('Codev: Start Dev (this workspace)')) throw new Error(`after stop: terminals gone=${Boolean(gone)}, row ${JSON.stringify(after)}`);
    return { detail: `started ${started.terminals.join(', ')}; row then offered ${JSON.stringify(wsTitles.filter((t) => /Dev/.test(t)))}; stopped`, shots: [shot] };
  });

  // Approve Gate relays the decision to the builder's spawning architect through Tower (#1494):
  // #101 was spawned by main, which is live, so the extension POSTs /api/send to architect:main
  // and never runs porch itself (its direct `porch approve` is only the no-live-architect branch).
  await R.check('Approve Gate (inline) on #101 relays to its architect', async () => {
    const t0 = Date.now();
    const e = await effects(R, context, page, async () => {
      await inlineAction(await row(b101), 'Codev: Approve Gate');
      R.lastDialog = await dialogButton(page, 'Approve');
    }, { wait: 4000 });
    const sends = R.towerRequests().filter((r) => r.at >= t0 && r.method === 'POST' && r.url.startsWith('/api/send'));
    const porch = e.stub.filter((c) => c.tool === 'porch');
    const note = e.notes.find((n) => /^Codev: sent (the .* approval )?to main/.test(n));
    if (sends.length !== 1 || porch.length || !note) throw new Error(`sends ${sends.length}, porch calls ${porch.length}: ${describe(e)}`);
    return `dialog "${R.lastDialog}"; POST /api/send ×1; no porch call; "${note}"`;
  });

  // Workspace row.
  await R.check('workspace row: inline and context entries', async () => {
    const inline = await inlineTitles(await row(ALPHA));
    const menu = await contextTitles(await row(ALPHA));
    const wantInline = ['Codev: Spawn Builder', 'Codev: New Shell', 'Codev: Add Architect'];
    const wantMenu = [...wantInline, 'Codev: Open Web Interface', 'Codev: Start Dev (this workspace)', 'Codev: Open Dev URL'];
    if (!sameSet(inline, wantInline) || !sameSet(menu, wantMenu)) throw new Error(`inline ${JSON.stringify(inline)}, menu ${JSON.stringify(menu)}`);
    return { detail: `inline ${JSON.stringify(inline)}; menu ${JSON.stringify(menu)}`, shots: [await R.shot(page, 'workspace-row')] };
  });

  await R.check('workspace row › Spawn Builder (inline) runs `afx spawn` through the stub', async () => {
    const e = await effects(R, context, page, async () => {
      await inlineAction(await row(ALPHA), 'Codev: Spawn Builder');
      await quickType(page, '4242');
      await quickPick(page, 'spir');
      await quickType(page, '');
    }, { wait: 2500 });
    const call = e.stub.find((c) => c.tool === 'afx');
    if (!call || call.argv.join(' ') !== 'spawn 4242 --protocol spir') throw new Error(`stub calls ${JSON.stringify(e.stub)}`);
    if (!call.cwd.endsWith('/alpha')) throw new Error(`cwd ${call.cwd}`);
    return `afx ${call.argv.join(' ')} in ${call.cwd}`;
  });

  await R.check('workspace row › New Shell (inline)', async () => {
    const e = await effects(R, context, page, async () => inlineAction(await row(ALPHA), 'Codev: New Shell'), { wait: 4000 });
    if (!e.terminals.length) throw new Error(`no shell terminal: ${describe(e)}`);
    return { detail: describe(e), shots: [await R.shot(page, 'new-shell')] };
  });

  await R.check('workspace row › Add Architect (inline) asks main', async () => {
    const e = await effects(R, context, page, async () => {
      await inlineAction(await row(ALPHA), 'Codev: Add Architect');
      await quickType(page, 'ops');
    }, { wait: 3000 });
    if (!e.notes.some((n) => /Asked main to add a 'ops' architect/.test(n))) throw new Error(describe(e));
    return describe(e);
  });

  await R.check('workspace row › Open Web Interface opens the isolated Tower\'s dashboard', async () => {
    const e = await effects(R, context, page, async () => contextAction(await row(ALPHA), 'Codev: Open Web Interface'), { popup: true, wait: 1000 });
    if (!e.popupUrl || new URL(e.popupUrl).port !== R.opts['tower-port']) throw new Error(describe(e));
    return e.popupUrl;
  });

  await R.check('workspace row › Start Dev, then Stop Dev replaces it, then Stop Dev', async () => {
    const started = await effects(R, context, page, async () => contextAction(await row(ALPHA), 'Codev: Start Dev (this workspace)'), { wait: 5000 });
    if (!started.terminals.length) throw new Error(`no dev terminal: ${describe(started)}`);
    const menu = await waitFor('Stop Dev (this workspace) on the row', async () => {
      const t = await contextTitles(await row(ALPHA));
      return t.includes('Codev: Stop Dev (this workspace)') && !t.includes('Codev: Start Dev (this workspace)') ? t : null;
    }, 15_000);
    const shot = await R.shot(page, 'workspace-dev-running');
    await contextAction(await row(ALPHA), 'Codev: Stop Dev (this workspace)');
    const back = await waitFor('Start Dev back on the row', async () => {
      const t = await contextTitles(await row(ALPHA));
      return t.includes('Codev: Start Dev (this workspace)') ? t : null;
    }, 15_000);
    return { detail: `dev ${started.terminals.join(', ')}; menu while running ${JSON.stringify(menu.filter((t) => /Dev/.test(t)))}; after stop ${JSON.stringify(back.filter((t) => /Dev/.test(t)))}`, shots: [shot] };
  });

  await R.check('workspace row › Open Dev URL lists both URLs and opens the picked one', async () => {
    await contextAction(await row(ALPHA), 'Codev: Open Dev URL');
    const items = await quickItems(page);
    if (!items.some((i) => /App/.test(i)) || !items.some((i) => /Admin/.test(i))) throw new Error(`QuickPick items ${JSON.stringify(items)}`);
    const url = await nextPopup(R, context, async () => {
      await quickPick(page, 'Admin');
      const box = page.locator('.monaco-dialog-box');
      if (await box.count()) await box.locator('.dialog-buttons .monaco-button', { hasText: /^Open$/ }).click();
    });
    if (url !== 'http://127.0.0.1:18799/admin') throw new Error(`opened ${url}`);
    return `QuickPick ${JSON.stringify(items)}; opened ${url}`;
  });

  // Architects.
  // Remove Architect. A childless sibling's row goes with it. A sibling that spawned builders keeps
  // its header as their owner's (architectGrouping: "no builder is ever dropped"), as in Agents.
  const removeArchitect = async (spec, name) => {
    await contextAction(await row(spec), 'Codev: Remove Architect');
    const text = await dialogButton(page, 'Remove');
    const ov = await waitFor(`${name} gone from the overview`, async () => {
      const o = await R.overview('alpha');
      return (o.architects ?? []).some((a) => a.name === name) ? null : o;
    }, 20_000);
    return { text, architects: ov.architects.map((a) => a.name) };
  };
  await R.check('Remove Architect is offered on siblings only; a childless sibling\'s row goes with it', async () => {
    const mainTitles = await contextTitles(await row(A_MAIN));
    if (mainTitles.includes('Codev: Remove Architect')) throw new Error(`MAIN offers ${JSON.stringify(mainTitles)}`);
    const enc = Buffer.from(path.join(R.opts.fixtures, 'alpha')).toString('base64url');
    const added = await R.tower('POST', `/api/workspaces/${enc}/architects`, { name: 'qa' });
    if (!added.success) throw new Error(`adding architect qa failed: ${JSON.stringify(added)}`);
    const qa = [...ALPHA, /^QA \(0\)$/];
    await waitRow(cockpit, qa, 20_000);
    const qaTitles = await contextTitles(await row(qa));
    if (!qaTitles.includes('Codev: Remove Architect')) throw new Error(`QA offers ${JSON.stringify(qaTitles)}`);
    const shot = await R.shot(page, 'qa-added');
    const { text, architects } = await removeArchitect(qa, 'qa');
    await waitFor('QA row gone', async () => ((await findRow(cockpit, qa)) ? null : true), 20_000);
    return { detail: `MAIN menu ${JSON.stringify(mainTitles)}; QA menu ${JSON.stringify(qaTitles)}; dialog "${text}"; architects now ${JSON.stringify(architects)}; QA row gone`, shots: [shot, await R.shot(page, 'qa-removed')] };
  });

  await R.check('Remove Architect on a sibling with a builder: the header stays as the builder\'s owner', async () => {
    const webTitles = await contextTitles(await row(A_WEB));
    if (!webTitles.includes('Codev: Remove Architect')) throw new Error(`WEB offers ${JSON.stringify(webTitles)}`);
    const { text, architects } = await removeArchitect(A_WEB, 'web');
    // The overview no longer lists web; the next render still shows WEB (1) holding #103.
    await page.waitForTimeout(3000);
    const held = await waitRow(cockpit, [...A_WEB, B(103)], 10_000);
    return { detail: `dialog "${text}"; architects now ${JSON.stringify(architects)}; WEB still holds "${held.text}"`, shots: [await R.shot(page, 'web-removed')] };
  });

  // Other workspaces.
  for (const spec of [BETA, [...BETA, /^MAIN \(/]]) await setExpanded(cockpit, spec, true);
  const bMain = [...BETA, /^MAIN \(/];
  const b201 = [...bMain, B(201)];
  await R.check('another workspace\'s rows carry no builder or architect actions', async () => {
    const archTitles = await hasNoCodevMenu(await row(bMain));
    const builderTitles = await hasNoCodevMenu(await row(b201));
    if (archTitles.length || builderTitles.length) throw new Error(`beta rows offer ${JSON.stringify({ archTitles, builderTitles })}`);
    return 'no Codev entry on beta\'s MAIN or #201';
  });
  for (const [what, spec] of [['architect', bMain], ['builder', b201]]) {
    await R.check(`scenario 12: another workspace's ${what} row opens that workspace's window`, async () => {
      const url = await nextPopup(R, context, async () => (await row(spec)).click());
      const folder = new URL(url).searchParams.get('folder') ?? '';
      if (!decodeURIComponent(folder).endsWith('/beta')) throw new Error(`opened ${url}`);
      return url;
    });
  }
  await R.check('another workspace row: inline Open opens it, as in the Tower view', async () => {
    const inline = await inlineTitles(await row(BETA));
    if (!sameSet(inline, ['Codev: Open Workspace', 'Codev: Deactivate Workspace'])) throw new Error(`inline ${JSON.stringify(inline)}`);
    const url = await nextPopup(R, context, async () => inlineAction(await row(BETA), 'Codev: Open Workspace'));
    if (!decodeURIComponent(new URL(url).searchParams.get('folder') ?? '').endsWith('/beta')) throw new Error(`opened ${url}`);
    return `inline ${JSON.stringify(inline)}; opened ${url}`;
  });
  await R.check('another workspace row: inline Deactivate moves it to Dormant', async () => {
    await inlineAction(await row(GAMMA), 'Codev: Deactivate Workspace');
    const text = await dialogButton(page, 'Deactivate');
    await waitFor('gamma under Dormant (2)', async () => {
      await setExpanded(cockpit, ['Tower', /^Dormant \(2\)$/], true).catch(() => null);
      return findRow(cockpit, ['Tower', /^Dormant \(2\)$/, 'gamma']);
    }, 30_000);
    return { detail: `dialog "${text}"`, shots: [await R.shot(page, 'gamma-dormant')] };
  });
};

// ── reveal ───────────────────────────────────────────────────────────────────────────────────

SCRIPTS.reveal = async (R, context, page) => {
  const cockpit = await alphaCockpit(R, page);
  const b101 = [...A_MAIN, B(101)];
  await R.check('active-file reveal expands collapsed workspace and architect rows', async () => {
    await expandPath(cockpit, b101);
    const file = await waitFor('alpha.ts under #101', async () => {
      const t = await subtree(cockpit, b101);
      for (const r of t?.rows ?? []) {
        if (r.expanded === 'false') {
          await cockpit.locator(`.monaco-list-row[data-index="${r.index}"] .monaco-tl-twistie`).click();
          await page.waitForTimeout(600);
          return null;
        }
      }
      return findRow(cockpit, [...b101, 'alpha.ts']);
    }, 30_000);
    await file.loc.click();
    await waitFor('the alpha.ts diff tab', async () => ((await activeEditorTab(page)) ?? '').includes('alpha.ts'), 20_000);
    const diffTab = await activeEditorTab(page);
    await setExpanded(cockpit, A_MAIN, false);
    await setExpanded(cockpit, ALPHA, false);
    const collapsedShot = await R.shot(page, 'collapsed');
    // Another editor, then back to the diff: the active-editor change drives the reveal.
    await runCommand(page, 'Go to File...');
    await quickType(page, 'README.md');
    await waitFor('README active', async () => ((await activeEditorTab(page)) ?? '').includes('README'), 15_000);
    await page.locator('.tabs-container .tab', { hasText: 'alpha.ts' }).first().click();
    const revealed = await waitFor('alpha.ts row revealed', async () => {
      const r = await findRow(cockpit, [...b101, 'alpha.ts']);
      return r && (r.selected || r.focused) ? r : null;
    }, 20_000);
    const ancestors = await Promise.all([ALPHA, A_MAIN, b101].map((s) => findRow(cockpit, s)));
    if (!ancestors.every((a) => a?.expanded === 'true')) throw new Error(`ancestors ${JSON.stringify(ancestors.map((a) => a?.expanded))}`);
    return { detail: `diff tab "${diffTab}"; row "${revealed.text}" selected=${revealed.selected} focused=${revealed.focused}`, shots: [collapsedShot, await R.shot(page, 'revealed')] };
  });
};

// ── windows ──────────────────────────────────────────────────────────────────────────────────

SCRIPTS.windows = async (R, context, page) => {
  await R.check('scenario 19: builder-worktree window — the parent row carries worktree-scoped actions only', async () => {
    const wt = fs.readdirSync(path.join(R.opts.fixtures, 'alpha', '.builders')).find((d) => d.includes('101'));
    await loadWorkbench(page, R.folderUrl('alpha', '.builders', wt));
    const cockpit = await openCockpit(page);
    const ws = await waitRow(cockpit, ALPHA, 60_000);
    const inline = await inlineTitles(ws.loc);
    const menu = await contextTitles(ws.loc);
    const forbidden = ['Codev: Spawn Builder', 'Codev: New Shell', 'Codev: Add Architect'];
    if ([...inline, ...menu].some((t) => forbidden.includes(t))) throw new Error(`parent row offers ${JSON.stringify({ inline, menu })}`);
    if (!sameSet(menu, ['Codev: Open Web Interface', 'Codev: Start Dev (this workspace)', 'Codev: Open Dev URL'])) throw new Error(`parent row menu ${JSON.stringify(menu)}`);
    await setExpanded(cockpit, ALPHA, true);
    await setExpanded(cockpit, A_MAIN, true);
    const b = await waitRow(cockpit, [...A_MAIN, B(101)]);
    const builderMenu = await hasNoCodevMenu(b.loc);
    if (builderMenu.length) throw new Error(`a builder row acts in a worktree window: ${JSON.stringify(builderMenu)}`);
    return { detail: `worktree ${wt}; parent row "${ws.description}" inline ${JSON.stringify(inline)} menu ${JSON.stringify(menu)}; builder rows navigate`, shots: [await R.shot(page, 'worktree-window')] };
  });

  await R.check('scenario 19: no-workspace window — the state row explains and offers Open Folder', async () => {
    await loadWorkbench(page, R.url('ew=true'), { needCodev: false });
    const cockpit = await openCockpit(page);
    const r = await waitRow(cockpit, ['Tower', 'Not connected to Tower'], 60_000);
    await r.loc.hover();
    await page.waitForTimeout(1500);
    const hover = (await page.locator('.monaco-hover, .workbench-hover').allTextContents()).join(' ').trim();
    if (!/no Codev workspace/.test(hover) && !/no Codev workspace/.test(r.label ?? '')) throw new Error(`tooltip "${hover}", label "${r.label}"`);
    return { detail: `row "${r.text}"; tooltip "${hover || r.label}"`, shots: [await R.shot(page, 'no-workspace-window')] };
  });

  await R.check('scenario 19: Codev container hidden, Cockpit visible — a builder change appears within one refresh interval', async () => {
    const cockpit = await alphaCockpit(R, page);
    await setPart(page, 'auxiliarybar', false);
    await setPart(page, 'panel', false);
    const parts = await partState(page);
    if (!/^codev cockpit$/i.test(parts.sidebar.title)) throw new Error(`the side bar shows "${parts.sidebar.title}", not the Cockpit`);
    await setExpanded(cockpit, A_MAIN, true);
    const before = await waitRow(cockpit, [...A_MAIN, B(102)]);
    // Toggle #102's gate (a rerun finds it already requested): either way one builder state change.
    const request = !/blocked/.test(before.text);
    const changedAt = requestGate(R, 'alpha', 102, { request });
    const after = await waitFor(`#102 shown ${request ? 'blocked' : 'no longer blocked'}`, async () => {
      const r = await findRow(cockpit, [...A_MAIN, B(102)]);
      return r && /blocked/.test(r.text) === request ? r : null;
    }, 75_000, 1000);
    const secs = ((Date.now() - changedAt) / 1000).toFixed(1);
    return { detail: `"${before.text}" → "${after.text}" after ${secs}s (codev.overviewRefreshSeconds default 60)`, shots: [await R.shot(page, 'cockpit-only-fresh')] };
  });
};

/**
 * Toggle builder `id` of `ws`'s spec-approval gate between requested (porch's `status: pending` +
 * `requested_at`, as when the gate is reached) and not requested: either way one builder state
 * change. Returns when it was written.
 */
const GATE_REQUESTED = /(\n  spec-approval:\n    status: pending\n)    requested_at: [^\n]*\n/;
const GATE_PENDING = /(\n  spec-approval:\n    status: pending\n)/;

/** Builder `id` of `ws`'s porch status file. */
function statusFile(R, ws, id) {
  const builders = path.join(R.opts.fixtures, ws, '.builders');
  const wt = fs.readdirSync(builders).find((d) => d.includes(String(id)));
  const projects = path.join(builders, wt, 'codev', 'projects');
  const dir = fs.readdirSync(projects).find((d) => d.startsWith(`${id}-`));
  return path.join(projects, dir, 'status.yaml');
}

/** Whether builder `id` of `ws` has its spec-approval gate requested. */
function gateRequested(R, ws, id) {
  return GATE_REQUESTED.test(fs.readFileSync(statusFile(R, ws, id), 'utf-8'));
}

function requestGate(R, ws, id, { request = true } = {}) {
  const file = statusFile(R, ws, id);
  const text = fs.readFileSync(file, 'utf-8');
  const requested = GATE_REQUESTED;
  const pending = GATE_PENDING;
  let next;
  if (request) {
    if (requested.test(text) || !pending.test(text)) throw new Error(`#${id}'s spec-approval is not pending and unrequested in ${file}`);
    next = text.replace(pending, `$1    requested_at: '${new Date().toISOString()}'\n`);
  } else {
    if (!requested.test(text)) throw new Error(`#${id}'s spec-approval is not requested in ${file}`);
    next = text.replace(requested, '$1');
  }
  fs.writeFileSync(file, next);
  return Date.now();
}

// ── reconnect ────────────────────────────────────────────────────────────────────────────────

SCRIPTS.reconnect = async (R, context, page) => {
  let cockpit;
  await R.check('a loaded Cockpit keeps its content while the isolated Tower is down', async () => {
    cockpit = await alphaCockpit(R, page);
    const up = await R.shot(page, 'connected');
    R.harness('tower-down');
    await page.waitForTimeout(10_000);
    const kept = await findRow(cockpit, A_MAIN);
    if (!kept) throw new Error('the hierarchy was cleared');
    return { detail: `kept "${kept.text}"`, shots: [up, await R.shot(page, 'tower-down-loaded')] };
  });
  await R.check('a window loaded while Tower is down shows Not connected to Tower', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await loadWorkbench(page, R.folderUrl('alpha'));
    cockpit = await openCockpit(page);
    const r = await waitRow(cockpit, ['Tower', 'Not connected to Tower'], 90_000);
    return { detail: `row "${r.text}"`, shots: [await R.shot(page, 'not-connected')] };
  });
  await R.check('Tower back + the row\'s Reconnect → the hierarchy returns', async () => {
    R.harness('tower-up');
    const r = await findRow(cockpit, ['Tower', 'Not connected to Tower']);
    if (r) await r.loc.click();
    const back = await waitRow(cockpit, A_MAIN, 90_000);
    return { detail: `${r ? 'clicked Reconnect; ' : 'already reconnected; '}"${back.text}"`, shots: [await R.shot(page, 'reconnected')] };
  });
};

// ── requests ─────────────────────────────────────────────────────────────────────────────────

const IDLE_MS = 60_000;
const BURST_WAIT_MS = 15_000;
const SETTLE_MS = 25_000;
/** The fleet cache's fallback poll (`POLL_INTERVAL_MS`, views/tower-cache.ts). */
const FLEET_POLL_MS = 20_000;

/** Count the Tower requests in [from, to), grouped by method and route (workspace paths by name). */
function countRequests(R, from, to) {
  const counts = {};
  for (const r of R.towerRequests()) {
    if (r.at < from || r.at >= to) continue;
    const u = new URL(r.url, 'http://x');
    let route = u.pathname.replace(/\/api\/workspaces\/[^/]+/, '/api/workspaces/:ws');
    const ws = u.searchParams.get('workspace');
    if (ws) route += `?workspace=${path.basename(ws)}`;
    const key = `${r.kind === 'upgrade' ? 'WS' : r.method} ${route}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Touch alpha's config so Tower's watcher broadcasts `codev-config-updated`. */
function touchConfig(R) {
  const file = path.join(R.opts.fixtures, 'alpha', '.codev', 'config.json');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf-8'));
}

/**
 * One layout's counts, in a freshly restarted VS Code server, so no other window's extension host
 * (kept alive for VS Code's reconnection grace period) is polling the Tower.
 *
 * Idle: 60 s, three fleet-poll periods. Burst: it starts 2 s after a fleet poll tick and lasts
 * 15 s, so no poll tick lands inside it in either layout and its counts are only what the two
 * changes cause (the fleet cache also refetches on every SSE event, so a window holding a poll tick
 * would count one fan-out more or less depending on the poll's phase).
 */
async function measure(R, page, label, layout, builderId, request) {
  await page.goto('about:blank');
  R.harness('vscode-restart');
  const tLoad = Date.now();
  await loadWorkbench(page, R.folderUrl('alpha'));
  const parts = await layout();
  await page.waitForTimeout(SETTLE_MS);
  const t0 = Date.now();
  await page.waitForTimeout(IDLE_MS);
  const tIdleEnd = Date.now();
  const tick = await waitFor('a fleet poll tick', () => R.towerRequests()
    .find((r) => r.at >= tIdleEnd && r.url === '/api/workspaces'), FLEET_POLL_MS + 5000, 200);
  await page.waitForTimeout(Math.max(0, tick.at + 2000 - Date.now()));
  const tb = Date.now();
  requestGate(R, 'alpha', builderId, { request });
  touchConfig(R);
  await page.waitForTimeout(BURST_WAIT_MS);
  const t1 = Date.now();
  if (t1 >= tick.at + FLEET_POLL_MS) throw new Error('the burst window reached the next poll tick');
  const events = R.towerRequests().filter((r) => r.at >= tLoad && r.at < t1 && r.method === 'GET' && r.url.startsWith('/api/events')).length;
  return {
    label, parts, events, window: { tLoad, t0, tIdleEnd, tick: tick.at, tb, t1 },
    idle: countRequests(R, t0, tIdleEnd), burst: countRequests(R, tb, t1), shot: await R.shot(page, label),
  };
}

/** Expand exactly the Codev container's `keep` panes (a collapsed view is not visible). */
async function codevPanes(page, keep) {
  const codev = await openCodev(page);
  const headers = codev.locator('.pane-header');
  for (let i = 0; i < await headers.count(); i++) {
    const header = headers.nth(i);
    // Titles carry counts ("Agents (3)"); Team renders only under codev.teamEnabled.
    const title = ((await header.locator('.title').textContent()) ?? '').trim().replace(/ \(\d+\)$/, '');
    if ((await header.getAttribute('aria-expanded') === 'true') !== keep.includes(title)) await header.click();
  }
}

/** Show the Codev Tower view in the secondary side bar. */
async function showTowerView(page) {
  await setPart(page, 'auxiliarybar', true);
  await runCommand(page, 'Codev Tower: Focus on Codev Tower View');
}

/**
 * The three request-count layouts (spec scenario 21). Each states what must be on screen; the
 * measurement refuses to run on any other screen.
 */
const REQUEST_LAYOUTS = [
  {
    label: 'cockpit-alone',
    async apply(page) {
      await openCockpit(page);
      await setPart(page, 'auxiliarybar', false);
      await setPart(page, 'panel', false);
    },
    want: { sidebar: /^codev cockpit$/i, auxiliarybar: null, panel: null },
  },
  {
    label: 'source-views-alone',
    async apply(page) {
      await codevPanes(page, ['Workspace', 'Agents']);
      await showTowerView(page);
      await setPart(page, 'panel', false);
    },
    want: { sidebar: /^codev$/i, panes: ['Workspace', 'Agents'], auxiliarybar: /^codev tower\b/i, panel: null },
  },
  {
    // The Cockpit moves to the panel so both sets show at once; Reset View Locations undoes it.
    label: 'both',
    async apply(page) {
      await runCommand(page, 'View: Move View');
      await quickType(page, 'Codev Cockpit'); // the view to move
      await quickPick(page, 'New Panel Entry'); // where to
      await codevPanes(page, ['Workspace', 'Agents']);
      await showTowerView(page);
      await setPart(page, 'panel', true);
    },
    want: { sidebar: /^codev$/i, panes: ['Workspace', 'Agents'], auxiliarybar: /^codev tower\b/i, panel: /^codev cockpit\b/i },
    async undo(page) {
      await runCommand(page, 'View: Reset View Locations');
      await waitFor('the Cockpit back in the activity bar', async () => activityItem(page, 'Codev Cockpit').isVisible(), 10_000);
    },
  },
];

/** Where `parts` differs from a layout's `want`, as messages (empty when it matches). */
function layoutProblems(parts, want) {
  const out = [];
  for (const part of ['sidebar', 'auxiliarybar', 'panel']) {
    const st = parts[part];
    if (want[part] === null) {
      if (st.visible) out.push(`${part} shows "${st.title}"`);
    } else if (!st.visible || !want[part].test(st.title)) {
      out.push(`${part} shows ${st.visible ? `"${st.title}"` : 'nothing'}, want ${want[part]}`);
    }
  }
  if (want.panes) {
    const open = parts.sidebar.panes?.filter((p) => p.expanded).map((p) => p.title) ?? [];
    if (!sameSet(open, want.panes)) out.push(`expanded panes ${JSON.stringify(open)}, want ${JSON.stringify(want.panes)}`);
  }
  return out;
}

const isConfigRoute = (route) => route.startsWith('GET /api/worktree-config');

SCRIPTS.requests = async (R, context, page) => {
  const results = {};
  // #103's gate alternates, so each burst is one builder state change.
  let request = true;
  for (const layout of REQUEST_LAYOUTS) {
    await R.check(`scenario 21: ${layout.label}`, async () => {
      try {
        const m = await measure(R, page, layout.label, async () => {
          await layout.apply(page);
          const parts = await partState(page);
          const problems = layoutProblems(parts, layout.want);
          if (problems.length) throw new Error(`layout ${layout.label} not on screen: ${problems.join('; ')}`);
          return parts;
        }, 103, request);
        request = !request;
        results[layout.label] = m;
        return { detail: JSON.stringify({ parts: m.parts, idle: m.idle, burst: m.burst, events: m.events }), shots: [m.shot] };
      } finally {
        if (layout.undo) await layout.undo(page);
      }
    });
  }
  await R.check('scenario 21: the request counts match', async () => {
    const a = results['cockpit-alone'];
    const b = results['source-views-alone'];
    const c = results.both;
    if (!a || !b || !c) throw new Error('a layout was not measured');
    const keys = [...new Set([a, b, c].flatMap((m) => [...Object.keys(m.idle), ...Object.keys(m.burst)]))].sort();
    const n = (m, w, k) => m[w][k] ?? 0;
    const table = keys.map((k) => ({
      route: k,
      cockpitIdle: n(a, 'idle', k), sourceIdle: n(b, 'idle', k), bothIdle: n(c, 'idle', k),
      cockpitBurst: n(a, 'burst', k), sourceBurst: n(b, 'burst', k), bothBurst: n(c, 'burst', k),
    }));
    fs.writeFileSync(path.join(R.opts.shots, 'requests-table.json'), `${JSON.stringify({
      idleMs: IDLE_MS, burstWaitMs: BURST_WAIT_MS,
      layouts: [a, b, c].map((m) => ({ label: m.label, parts: m.parts, events: m.events, ...m.window })),
      table,
    }, null, 2)}\n`);
    const problems = [];
    // The Cockpit alone makes nothing the source views do not.
    for (const r of table) {
      if (r.cockpitIdle > r.sourceIdle || r.cockpitBurst > r.sourceBurst) problems.push(`Cockpit alone makes more ${r.route}`);
    }
    // The fleet and the overviews are shared: identical counts in all three layouts.
    for (const r of table.filter((x) => x.route === 'GET /api/workspaces' || x.route.startsWith('GET /api/overview'))) {
      if (new Set([r.cockpitIdle, r.sourceIdle, r.bothIdle]).size > 1 || new Set([r.cockpitBurst, r.sourceBurst, r.bothBurst]).size > 1) problems.push(`${r.route} differs across layouts`);
    }
    // getWorktreeConfig never on a fleet tick: none while idle, in any layout.
    for (const r of table.filter((x) => isConfigRoute(x.route))) {
      if (r.cockpitIdle || r.sourceIdle || r.bothIdle) problems.push(`${r.route} while idle`);
    }
    // Both at once: beyond the source views alone, only getWorktreeConfig.
    for (const r of table) {
      if ((r.bothIdle > r.sourceIdle || r.bothBurst > r.sourceBurst) && !isConfigRoute(r.route)) problems.push(`both at once adds ${r.route}`);
    }
    // No stream added: one event stream per window in every layout.
    for (const m of [a, b, c]) if (m.events !== 1) problems.push(`${m.label}: ${m.events} event streams`);
    if (problems.length) throw new Error(`${problems.join('; ')}: ${JSON.stringify(table)}`);
    return JSON.stringify(table);
  });
};

async function main() {
  const [script, ...rest] = process.argv.slice(2);
  if (!SCRIPTS[script]) {
    console.error(`usage: cockpit-verify.mjs <${Object.keys(SCRIPTS).join('|')}> --url-template … (run via harness.mjs verify)`);
    process.exit(64);
  }
  const opts = parseArgs(rest);
  fs.mkdirSync(opts.shots, { recursive: true });
  const R = new Run(script, opts);
  const context = await newContext(R);
  try {
    const page = context.pages()[0] ?? await context.newPage();
    R.page = page;
    await SCRIPTS[script](R, context, page);
  } catch (err) {
    R.results.push({ name: 'script error', ok: false, detail: String(err.stack ?? err) });
    console.log(`FAIL  script error — ${err.message ?? err}`);
  } finally {
    await context.close().catch(() => {});
    if (R.ownerPortRequests.length) {
      R.results.push({ name: 'no browser request to the owner port', ok: false, detail: R.ownerPortRequests.join(', ') });
    }
    R.write();
  }
  const failed = R.results.filter((r) => !r.ok).length;
  console.log(failed ? `${script}: ${failed} of ${R.results.length} FAILED` : `${script}: all ${R.results.length} passed`);
  process.exit(failed ? 1 : 0);
}

export {
  Run, loadWorkbench, openCockpit, openCodev, rows, findRow, subtree, waitRow, setExpanded, expandPath, contextAction, contextTitles, requestGate,
  inlineTitles, inlineAction, notifications, closeNotifications, waitForNotification, dialogButton, quickType,
  quickItems, quickPick, editorTabs, activeEditorTab, waitFor, runCommand, setTheme, nextPopup,
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
