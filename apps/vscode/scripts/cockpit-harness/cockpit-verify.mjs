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
//   dashboard  the browser dashboard's Work and Decisions tabs render, act and rule as before
//              (scenario 20); with --baseline, styles and DOM identical to a run on main's build
//   decisions  the VS Code Decisions panel (Phase 7): the hierarchy's entries, images, full size,
//              a link, a ruling and its notice, a stale refusal, hidden-panel polling, themes,
//              reload restore, the unavailable windows, empty state → init, network audit
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

// ---------------------------------------------------------------------------------------------
// Dashboard regression (Phase 6, spec scenario 20): the browser dashboard's Work and Decisions
// tabs, served by the isolated Tower, render and rule as before. Each run writes a snapshot of
// every element's computed colours, type and box under the two views; with --baseline (a
// snapshot from a run on main's build) the run fails on any difference.
// ---------------------------------------------------------------------------------------------

/** Style properties the snapshot records: colour, type and box model, never content-driven sizes. */
const SNAPSHOT_PROPS = [
  'color', 'background-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-radius',
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-transform',
  'text-decoration-line', 'white-space', 'padding', 'margin', 'display', 'gap', 'flex-direction', 'align-items',
  'justify-content', 'position', 'overflow-y', 'opacity', 'cursor', 'box-shadow', 'outline-color',
];

/** Every element under `root`, in document order: its path, tag, classes, own text (ages masked) and styles. */
async function styleSnapshot(page, root) {
  await page.mouse.move(0, 0);
  return page.evaluate(({ root, props }) => {
    const top = document.querySelector(root);
    if (!top) throw new Error(`${root} is not rendered`);
    const out = [];
    const walk = (el, at) => {
      const cs = getComputedStyle(el);
      const style = {};
      for (const p of props) style[p] = cs.getPropertyValue(p);
      const text = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('')
        .trim().replace(/\d+[dhm]?(\s+\d+[dhm])?/g, 'N');
      out.push({ at, tag: el.tagName.toLowerCase(), cls: el.getAttribute('class') ?? '', text, style });
      [...el.children].forEach((child, i) => walk(child, `${at}>${i}`));
    };
    walk(top, root);
    return out;
  }, { root, props: SNAPSHOT_PROPS });
}

/** Differences between two snapshots of one view, as readable lines. */
function snapshotDiff(name, before, after) {
  const lines = [];
  if (before.length !== after.length) lines.push(`${name}: ${before.length} elements before, ${after.length} after`);
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    const [b, a] = [before[i], after[i]];
    for (const k of ['at', 'tag', 'cls', 'text']) if (b[k] !== a[k]) lines.push(`${name} ${b.at} ${k}: ${JSON.stringify(b[k])} → ${JSON.stringify(a[k])}`);
    for (const p of SNAPSHOT_PROPS) if (b.style[p] !== a.style[p]) lines.push(`${name} ${b.at} <${b.tag} class="${b.cls}"> ${p}: ${b.style[p]} → ${a.style[p]}`);
  }
  return lines;
}

/** The isolated Tower's dashboard for a fixture workspace. */
function dashboardUrl(R, ws) {
  return `http://127.0.0.1:${R.opts['tower-port']}/workspace/${Buffer.from(path.join(R.opts.fixtures, ws)).toString('base64url')}/`;
}

/** The dashboard's content tab bar (Work, Decisions, builders, files); the architect strip has its own. */
const CONTENT_TABS = '.tab-bar[aria-label="Content tabs"]';

async function dashboardTab(page, label) {
  await page.locator(`${CONTENT_TABS} [role="tab"]`, { hasText: label }).first().click();
}

async function activeDashboardTab(page) {
  return (await page.locator(`${CONTENT_TABS} .tab-active .tab-label`).textContent())?.trim() ?? '';
}

async function contentTabLabels(page) {
  return (await page.locator(`${CONTENT_TABS} .tab-label`).allTextContents()).map((t) => t.trim());
}

/** Run `action`, wait for the browser tab it opens, and return the URL that tab loaded. */
async function popupUrl(context, action, timeout = 20_000) {
  const [popup] = await Promise.all([context.waitForEvent('page', { timeout }), action()]);
  const url = await waitFor('the new tab to navigate', async () => (popup.url() !== 'about:blank' ? popup.url() : null), 10_000);
  await popup.close();
  return url;
}

SCRIPTS.dashboard = async (R, context, page) => {
  // Item links point at example.com: answer them here, so no request leaves the machine.
  await context.route(/^https?:\/\/example\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>fixture link</p>' }));
  const snapshot = {};
  const card = (id) => page.locator('.decisions-card', { has: page.locator('.decisions-item-id', { hasText: id }) });

  await R.check('scenario 20: the dashboard Work tab renders', async () => {
    // The overview Tower computed when VS Code first opened alpha (before the seed wrote its forge
    // config) is cached with the forge concepts failed: drop it, and wait for one with every list.
    const ws = Buffer.from(path.join(R.opts.fixtures, 'alpha')).toString('base64url');
    await R.tower('POST', `/workspace/${ws}/api/overview/refresh`);
    await waitFor('alpha\'s overview with its forge lists', async () => {
      const o = await R.overview('alpha');
      return !o.errors && o.pendingPRs?.length && o.backlog?.length && o.recentlyClosed?.length;
    }, 60_000);
    await page.goto(dashboardUrl(R, 'alpha'));
    await waitFor('three builder rows', async () => (await page.locator('.work-view .builder-table tbody tr').count()) === 3, 60_000);
    const problems = [];
    const ids = await page.locator('.builder-table .builder-col-id').allTextContents();
    for (const id of ['#101', '#102', '#103']) if (!ids.some((t) => t.startsWith(id))) problems.push(`no builder row ${id}`);
    if (await page.locator('.builder-table .builder-row-open').count() !== 3) problems.push('not three Open buttons');
    for (const label of ['+ Shell', 'Refresh']) if (!await page.locator('.work-actions .work-btn', { hasText: label }).count()) problems.push(`no ${label} button`);
    if (!await page.locator('.work-file-panel .work-file-panel-search').count()) problems.push('no collapsed Files panel with its search box');
    if (!await page.locator('.work-view .tip-banner').count()) problems.push('no tip banner');
    const attention = (await page.locator('.attention-rows .attention-row').allTextContents()).join(' | ');
    if (!/#101.*spec review/.test(attention)) problems.push(`Needs Attention lacks #101's spec review: "${attention}"`);
    const prRow = page.locator('a.attention-row', { hasText: '#301' });
    if (await prRow.getAttribute('href').catch(() => null) !== 'https://example.com/fixture/pull/301') problems.push('Needs Attention lacks PR #301 as a link');
    const backlog = (await page.locator('.backlog-rows .backlog-row').allTextContents()).join(' | ');
    if (!/#401/.test(backlog) || !/#402/.test(backlog) || /#10[123]/.test(backlog)) problems.push(`Backlog is "${backlog}"`);
    const b401 = page.locator('.backlog-row', { hasText: '#401' });
    const artifacts = (await b401.locator('.backlog-artifact-link').allTextContents()).map((t) => t.trim());
    if (JSON.stringify(artifacts) !== JSON.stringify(['spec', 'plan'])) problems.push(`#401 offers ${JSON.stringify(artifacts)}`);
    const closed = page.locator('.recently-closed-row', { hasText: '#399' });
    const closedLinks = (await closed.locator('.backlog-artifact-link').allTextContents()).map((t) => t.trim());
    if (JSON.stringify(closedLinks) !== JSON.stringify(['review', 'PR'])) problems.push(`#399 offers ${JSON.stringify(closedLinks)}`);
    if (problems.length) throw new Error(problems.join('; '));
    snapshot.work = await styleSnapshot(page, '.work-view');
    return { detail: `builders ${ids.join(', ')}; ${snapshot.work.length} elements`, shots: [await R.shot(page, 'work')] };
  });

  await R.check('scenario 20: the dashboard Decisions tab renders', async () => {
    await dashboardTab(page, 'Decisions');
    await waitFor('two decision cards', async () => (await page.locator('.decisions-card').count()) === 2, 30_000);
    const image = card('main-1').locator('img[alt="Compact board"]');
    await waitFor('the workspace image to load as an object URL', async () => (await image.getAttribute('src'))?.startsWith('blob:'), 20_000);
    const problems = [];
    const words = await card('main-1').locator('input[type="radio"]').evaluateAll((els) => els.map((e) => e.value));
    if (JSON.stringify(words) !== JSON.stringify(['compact', 'stacked', 'hold'])) problems.push(`main-1 offers ${JSON.stringify(words)}`);
    if (!/Written under this item/.test(await card('web-1').textContent())) problems.push('web-1 does not show its written ruling');
    if (!/2 open/.test(await page.locator('.decisions-count').textContent())) problems.push('the count is not "2 open"');
    const link = card('main-1').locator('a', { hasText: 'https://example.com/fixture/main-1' });
    if (await link.getAttribute('target') !== '_blank') problems.push('the http(s) link does not open in a new tab');
    if (problems.length) throw new Error(problems.join('; '));
    snapshot.decisions = await styleSnapshot(page, '.decisions-view');
    return { detail: `main-1 offers ${words.join(' / ')}; image loaded; ${snapshot.decisions.length} elements`, shots: [await R.shot(page, 'decisions')] };
  });

  await R.check('scenario 20: a Decisions link and image open in a new tab', async () => {
    const linkUrl = await popupUrl(context, () => card('main-1').locator('a', { hasText: 'https://example.com/fixture/main-1' }).click());
    if (linkUrl !== 'https://example.com/fixture/main-1') throw new Error(`the link opened ${linkUrl}`);
    const imageUrl = await popupUrl(context, () => card('main-1').locator('img[alt="Compact board"]').click());
    if (!imageUrl.startsWith('blob:')) throw new Error(`the image opened ${imageUrl}`);
    return `link → ${linkUrl}; image → a ${imageUrl.slice(0, 5)} page`;
  });

  await R.check('scenario 20: a ruling round-trips', async () => {
    const main1 = card('main-1');
    await main1.locator('input[type="radio"][value="stacked"]').check();
    await main1.locator('textarea.decisions-comment').fill('Fixture comment from the dashboard.');
    const formShot = await R.shot(page, 'decisions-draft');
    await main1.locator('button.decisions-submit-btn').click();
    await waitFor('main-1 to show the written ruling', async () => /Written under this item/.test(await main1.textContent()), 20_000);
    const shown = (await main1.locator('.decisions-ruling-text').textContent()) ?? '';
    const want = 'stacked\n\nFixture comment from the dashboard.';
    if (shown !== want) throw new Error(`the card shows ${JSON.stringify(shown)}`);
    const file = fs.readFileSync(path.join(R.opts.fixtures, 'alpha', 'codev/state/pending-decisions.md'), 'utf-8');
    if (!file.includes(`**Your word:** \`compact\` / \`stacked\` / \`hold\`\n${want}\n`)) throw new Error('the file does not hold the ruling under main-1');
    return { detail: 'Submit → Tower wrote the file → the card shows the written ruling', shots: [formShot, await R.shot(page, 'decisions-ruled')] };
  });

  await R.check('scenario 20: Work actions (Open, + Shell, Refresh, spec link, issue link)', async () => {
    await dashboardTab(page, 'Work');
    const problems = [];
    await page.locator('.builder-row', { hasText: '#102' }).locator('.builder-row-open').click();
    await page.waitForTimeout(1000);
    const opened = await activeDashboardTab(page);
    if (opened !== 'builder-spir-102') problems.push(`Open on #102 selected "${opened}"`);

    await dashboardTab(page, 'Work');
    const before = await contentTabLabels(page);
    await page.locator('.work-actions .work-btn', { hasText: '+ Shell' }).click();
    const shellTab = await waitFor('a new shell tab', async () => {
      const added = (await contentTabLabels(page)).filter((t) => !before.includes(t));
      return added.length === 1 ? added[0] : null;
    }, 20_000).catch(() => { problems.push('+ Shell added no tab'); return null; });

    await dashboardTab(page, 'Work');
    const beforeSpec = await contentTabLabels(page);
    await page.locator('.backlog-row', { hasText: '#401' }).locator('.backlog-artifact-link', { hasText: 'spec' }).click();
    const specTab = await waitFor('a file tab for the spec', async () => {
      const added = (await contentTabLabels(page)).filter((t) => !beforeSpec.includes(t));
      return added.length === 1 ? added[0] : null;
    }, 20_000).catch(() => { problems.push('the #401 spec link added no tab'); return null; });
    if (specTab && !/401-fixture-backlog/.test(specTab)) problems.push(`the spec link opened "${specTab}"`);

    await dashboardTab(page, 'Work');
    const issueUrl = await popupUrl(context, () => page.locator('.backlog-row', { hasText: '#402' }).locator('a.backlog-row-main').click());
    if (issueUrl !== 'https://example.com/fixture/issues/402') problems.push(`the #402 row opened ${issueUrl}`);

    const from = R.towerRequests().length;
    await page.locator('.work-actions .work-btn', { hasText: 'Refresh' }).click();
    await page.waitForTimeout(1500);
    if (!R.towerRequests().slice(from).some((r) => r.method === 'POST' && /\/api\/overview\/refresh$/.test((r.url ?? '').split('?')[0]))) problems.push('Refresh sent no POST …/api/overview/refresh');
    if (problems.length) throw new Error(problems.join('; '));
    return `Open → "${opened}"; + Shell → "${shellTab}"; spec → "${specTab}"; #402 → ${issueUrl}; Refresh → POST …/api/overview/refresh`;
  });

  fs.writeFileSync(path.join(R.opts.shots, 'dashboard-snapshot.json'), `${JSON.stringify(snapshot, null, 1)}\n`);
  if (R.opts.baseline) {
    await R.check('scenario 20: computed styles and DOM unchanged from the baseline', async () => {
      const base = JSON.parse(fs.readFileSync(R.opts.baseline, 'utf-8'));
      const diff = [...snapshotDiff('work', base.work ?? [], snapshot.work ?? []), ...snapshotDiff('decisions', base.decisions ?? [], snapshot.decisions ?? [])];
      if (diff.length) throw new Error(`${diff.length} difference(s): ${diff.slice(0, 25).join(' | ')}`);
      return `work ${snapshot.work.length} and decisions ${snapshot.decisions.length} elements identical to ${path.basename(R.opts.baseline)}`;
    });
  }
};

// ── decisions (Phase 7) ──────────────────────────────────────────────────────────────────────

const DECISIONS_PATH = 'codev/state/pending-decisions.md';
const REMOTE_IMAGE = 'https://example.com/fixture/remote-board.svg';
/** A remote image the browser fails to load: the route answers 404. */
const REMOTE_GONE = 'https://example.com/fixture/gone-board.svg';
const REMOTE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80" viewBox="0 0 200 80"><rect width="200" height="80" fill="#38a169"/><rect x="16" y="32" width="168" height="16" fill="#f0fff4"/></svg>';
const OUTSIDE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#e53e3e"/></svg>';

/**
 * `main-2`, added to alpha's file by this script: an https image, which the webview loads itself;
 * an https image the browser fails to load (404); and an image outside the workspace, which Tower
 * refuses. It is also the item the stale-fingerprint check edits under the panel.
 */
const MAIN_2 = `### main-2 · 2026-11-21 10:00 UTC · Which board image should the fixture keep?

- **Context:** an image from the web, and one from outside the workspace.

![Remote board](${REMOTE_IMAGE})

![Gone board](${REMOTE_GONE})

![Outside image](../../../outside.svg)

**Your word:** \`remote\` / \`local\`

`;

/** An item for gamma's new file, added the way the hub adds one. */
const GAMMA_1 = `### main-1 · 2026-11-24 12:00 UTC · Adopt the Decisions panel in gamma?

- **Context:** added by the hub after \`afx decisions init\`.

**Your word:** \`adopt\` / \`wait\`

`;

/** Add `item` at the top of a decisions file's Open section, and set its status line. */
function addOpenItem(file, item, status) {
  const text = fs.readFileSync(file, 'utf-8');
  if (!text.includes('## Open\n\n')) throw new Error(`${file} has no "## Open" section`);
  fs.writeFileSync(file, text.replace('## Open\n\n', `## Open\n\n${item}`).replace(/^_Status: .*_$/m, `_Status: ${status}_`));
}

/** The Decisions panel's document: VS Code nests a webview's page two iframes down. */
async function decisionsFrame(page, timeout = 60_000) {
  return waitFor('the Decisions webview', async () => {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      if (await frame.locator('.decisions-view').count().catch(() => 0)) return frame;
    }
    return null;
  }, timeout);
}

const decisionCard = (frame, id) => frame.locator('.decisions-card', { has: frame.locator('.decisions-item-id', { hasText: new RegExp(`^${escapeRe(id)}$`) }) });

/** GETs of a decisions document the Tower received after request-log line `from`. */
const decisionsReads = (R, from) => R.towerRequests().slice(from)
  .filter((r) => r.method === 'GET' && (r.url ?? '').split('?')[0].endsWith('/api/decisions'));

/** The isolated Tower's notices to a hub architect, from its log. */
function rulingNotices(R) {
  const log = path.join(path.dirname(R.opts['request-log']), 'tower.log');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf-8').split('\n').filter((l) => /Decisions notice .* → main @ /.test(l));
}

const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  const n = (i) => parseInt(h.slice(i, i + 2), 16);
  return h.length >= 6 ? `rgb(${n(0)}, ${n(2)}, ${n(4)})` : hex;
};

SCRIPTS.decisions = async (R, context, page) => {
  const alphaFile = path.join(R.opts.fixtures, 'alpha', DECISIONS_PATH);
  addOpenItem(alphaFile, MAIN_2, '3 open — main-2, main-1, web-1.');
  fs.writeFileSync(path.join(R.opts.fixtures, 'outside.svg'), OUTSIDE_SVG);
  // Item links and the remote image point at example.com: answer them here, so nothing leaves the machine.
  await context.route(/^https?:\/\/example\.com\//, (route) => (route.request().url() === REMOTE_IMAGE
    ? route.fulfill({ status: 200, contentType: 'image/svg+xml', body: REMOTE_SVG })
    : route.request().url() === REMOTE_GONE
      ? route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' })
      : route.fulfill({ status: 200, contentType: 'text/html', body: '<p>fixture link</p>' })));

  // Every request the browser makes, with the frame that made it, for scenario 22.
  const requests = [];
  context.on('request', (r) => {
    let frame = 'other';
    try {
      const f = r.frame();
      frame = f === f.page().mainFrame() ? 'main' : f.url();
    } catch { /* a service worker's request, or a popup's first navigation */ }
    requests.push({ url: r.url(), frame, key: Object.keys(r.headers()).some((h) => h.toLowerCase() === 'codev-tower-key') });
  });

  let cockpit;
  let frame;
  const DRAFT = 'Draft that must survive a refusal.';

  await R.check('scenario 12: a Decisions entry under every active workspace, none under the dormant one', async () => {
    await loadWorkbench(page, R.folderUrl('alpha'));
    cockpit = await openCockpit(page);
    await waitRow(cockpit, A_MAIN, 60_000);
    const got = {};
    for (const [name, spec] of [['alpha', ALPHA], ['beta', BETA], ['gamma', GAMMA]]) {
      await setExpanded(cockpit, spec, true);
      const t = await subtree(cockpit, spec);
      got[name] = t.rows.filter((r) => r.level === t.head.level + 1).map((r) => r.text);
    }
    await setExpanded(cockpit, ['Tower', /^Dormant \(1\)$/], true);
    const dormant = await subtree(cockpit, ['Tower', /^Dormant \(1\)$/]);
    const problems = [];
    for (const [name, children] of Object.entries(got)) {
      if (children.at(-1) !== 'Decisions') problems.push(`${name}'s last child is "${children.at(-1)}"`);
      if (children.filter((c) => c === 'Decisions').length !== 1) problems.push(`${name} has ${children.filter((c) => c === 'Decisions').length} Decisions entries`);
    }
    const delta = dormant.rows.find((r) => r.text === 'delta');
    if (!delta || delta.expanded !== null) problems.push('the dormant delta row is missing or expandable');
    if (problems.length) throw new Error(`${problems.join('; ')} — ${JSON.stringify(got)}`);
    return { detail: `${JSON.stringify(got)}; Dormant: delta, a leaf (beta and gamma have no decisions file)`, shots: [await R.shot(page, 'entries')] };
  });

  await R.check("scenario 12: another workspace's Decisions entry opens that workspace's window", async () => {
    const entry = await waitRow(cockpit, [...BETA, 'Decisions']);
    const url = await nextPopup(R, context, () => entry.loc.click());
    if (!decodeURIComponent(new URL(url).searchParams.get('folder') ?? '').endsWith('/beta')) throw new Error(`opened ${url}`);
    return `beta's entry → ${url}`;
  });

  await R.check("scenario 12: this workspace's Decisions entry opens the panel, which renders the items", async () => {
    const entry = await waitRow(cockpit, [...ALPHA, 'Decisions']);
    await entry.loc.click();
    await waitFor('the Decisions editor tab', async () => /^Decisions/.test(await activeEditorTab(page) ?? ''), 20_000);
    frame = await decisionsFrame(page);
    await waitFor('three decision cards', async () => (await frame.locator('.decisions-card').count()) === 3, 30_000);
    const problems = [];
    const count = (await frame.locator('.decisions-count').textContent())?.trim();
    if (count !== '3 open') problems.push(`the count reads "${count}"`);
    const words = await decisionCard(frame, 'main-1').locator('input[type="radio"]').evaluateAll((els) => els.map((e) => e.value));
    if (JSON.stringify(words) !== JSON.stringify(['compact', 'stacked', 'hold'])) problems.push(`main-1 offers ${JSON.stringify(words)}`);
    if (!/Written under this item/.test(await decisionCard(frame, 'web-1').textContent())) problems.push('web-1 does not show its written ruling');
    // Clicking the entry again reveals the same panel: still one Decisions tab.
    await entry.loc.click();
    await page.waitForTimeout(1000);
    const tabs = (await editorTabs(page)).filter((t) => /^Decisions/.test(t ?? ''));
    if (tabs.length !== 1) problems.push(`${tabs.length} Decisions tabs after a second click`);
    if (problems.length) throw new Error(problems.join('; '));
    return { detail: `tab "${await activeEditorTab(page)}"; ${count}; main-1 offers ${words.join(' / ')}; one tab after a second click`, shots: [await R.shot(page, 'panel')] };
  });

  await R.check('scenario 15: a workspace image (bytes through the host), an https image, and two not loaded (the browser\'s 404, Tower\'s refusal)', async () => {
    const local = decisionCard(frame, 'main-1').locator('img[alt="Compact board"]');
    const remote = decisionCard(frame, 'main-2').locator('img[alt="Remote board"]');
    const loaded = (img) => img.evaluate((el) => el.complete && el.naturalWidth > 0).catch(() => false);
    await waitFor('the workspace image to render from an object URL', async () => (await local.getAttribute('src'))?.startsWith('blob:') && loaded(local), 20_000);
    await waitFor('the https image to render', async () => (await remote.getAttribute('src')) === REMOTE_IMAGE && loaded(remote), 20_000);
    const missing = decisionCard(frame, 'main-2').locator('.decisions-image-missing');
    await waitFor('two not-loaded notes', async () => (await missing.count()) === 2, 20_000);
    const notes = await missing.evaluateAll((els) => els.map((el) => ({ text: el.textContent.replace(/\s+/g, ' ').trim(), reason: el.title })));
    const gone = notes.find((n) => n.text.includes(REMOTE_GONE));
    const outside = notes.find((n) => /outside\.svg/.test(n.text));
    if (!gone || !/^Image not loaded Gone board/.test(gone.text)) throw new Error(`no note for the 404 image: ${JSON.stringify(notes)}`);
    if (!outside || !/^Image not loaded/.test(outside.text) || !/outside/i.test(outside.reason)) throw new Error(`no note for the refused image: ${JSON.stringify(notes)}`);
    if (await decisionCard(frame, 'main-2').locator('img[alt="Gone board"]').count()) throw new Error('the 404 image is still a (broken) img');
    const size = await local.evaluate((el) => `${el.naturalWidth}×${el.naturalHeight}`);
    return { detail: `workspace SVG ${size} from blob:; https image loaded; 404: "${gone.text}" (${gone.reason}); refused: "${outside.text}" (${outside.reason})`, shots: [await R.shot(page, 'images')] };
  });

  await R.check('scenario 15: the full-size view opens over the panel; Escape and Close each close it', async () => {
    const local = decisionCard(frame, 'main-1').locator('img[alt="Compact board"]');
    const overlay = frame.locator('.wv-fullsize[role="dialog"]');
    await local.click();
    await overlay.waitFor({ timeout: 10_000 });
    const src = await overlay.locator('img').getAttribute('src');
    if (src !== await local.getAttribute('src')) throw new Error(`the full-size image is ${src}`);
    const shot = await R.shot(page, 'full-size');
    await page.keyboard.press('Escape');
    await waitFor('Escape to close the full-size view', async () => (await overlay.count()) === 0, 5000);
    await local.click();
    await overlay.waitFor({ timeout: 10_000 });
    await overlay.locator('button', { hasText: 'Close' }).click();
    await waitFor('Close to close the full-size view', async () => (await overlay.count()) === 0, 5000);
    return { detail: `opened on ${src.slice(0, 5)}…; Escape closed it; Close closed it`, shots: [shot] };
  });

  await R.check('scenario 15: an http(s) link opens in the browser, through the extension host', async () => {
    const link = decisionCard(frame, 'main-1').locator('a', { hasText: 'https://example.com/fixture/main-1' });
    let asked = null;
    const url = await nextPopup(R, context, async () => {
      await link.click();
      // VS Code asks before opening a domain it does not trust yet.
      if (await page.locator('.monaco-dialog-box').waitFor({ timeout: 5000 }).then(() => true, () => false)) asked = await dialogButton(page, 'Open');
    });
    if (url !== 'https://example.com/fixture/main-1') throw new Error(`opened ${url}`);
    return `→ ${url}${asked ? ` (after VS Code's prompt: "${asked.slice(0, 80)}")` : ''}`;
  });

  await R.check('scenario 15: rule an item — the file is updated, the card shows the ruling, the architect is notified', async () => {
    const main1 = decisionCard(frame, 'main-1');
    const noticesBefore = rulingNotices(R).length;
    await main1.locator('input[type="radio"][value="stacked"]').check();
    await main1.locator('textarea.decisions-comment').fill('Fixture comment from the VS Code panel.');
    const formShot = await R.shot(page, 'draft');
    await main1.locator('button.decisions-submit-btn').click();
    await waitFor('main-1 to show the written ruling', async () => /Written under this item/.test(await main1.textContent()), 20_000);
    const shown = (await main1.locator('.decisions-ruling-text').textContent()) ?? '';
    const want = 'stacked\n\nFixture comment from the VS Code panel.';
    if (shown !== want) throw new Error(`the card shows ${JSON.stringify(shown)}`);
    const file = fs.readFileSync(alphaFile, 'utf-8');
    if (!file.includes(`**Your word:** \`compact\` / \`stacked\` / \`hold\`\n${want}\n`)) throw new Error('the file does not hold the ruling under main-1');
    const notice = await waitFor('Tower\'s notice to main', async () => rulingNotices(R).slice(noticesBefore)[0] ?? null, 20_000);
    return { detail: `file updated; card shows it; Tower: ${notice.replace(/^\[[^\]]*\] \[INFO\] /, '')}`, shots: [formShot, await R.shot(page, 'ruled')] };
  });

  await R.check('scenario 15: a stale fingerprint is refused, and the draft is kept', async () => {
    const main2 = decisionCard(frame, 'main-2');
    await main2.locator('input[type="radio"][value="local"]').check();
    await main2.locator('textarea.decisions-comment').fill(DRAFT);
    const submit = main2.locator('button.decisions-submit-btn');
    await submit.hover();
    // Edit main-2 just after a poll, so Submit lands before the next one can read the edit.
    const from = R.towerRequests().length;
    await waitFor('a Decisions poll', async () => decisionsReads(R, from).length > 0, 10_000, 50);
    fs.writeFileSync(alphaFile, fs.readFileSync(alphaFile, 'utf-8').replace('one from outside the workspace.', 'one from outside the workspace (edited under the panel).'));
    await submit.click();
    const alert = main2.locator('[role="alert"]');
    await waitFor('the refusal on main-2', async () => (await alert.count()) === 1, 10_000);
    const message = (await alert.textContent()).trim();
    const draft = await main2.locator('textarea.decisions-comment').inputValue();
    const word = await main2.locator('input[type="radio"]:checked').getAttribute('value');
    const problems = [];
    if (!/changed/i.test(message)) problems.push(`the refusal reads "${message}"`);
    if (draft !== DRAFT) problems.push(`the comment box holds ${JSON.stringify(draft)}`);
    if (word !== 'local') problems.push(`the chosen word is ${word}`);
    const section = fs.readFileSync(alphaFile, 'utf-8').split('### main-2')[1]?.split('### main-1')[0] ?? '';
    if (!section.endsWith('**Your word:** `remote` / `local`\n\n')) problems.push(`main-2's section now ends ${JSON.stringify(section.slice(-60))}`);
    if (problems.length) throw new Error(problems.join('; '));
    return { detail: `"${message}"; draft and word kept`, shots: [await R.shot(page, 'stale-refused')] };
  });

  await R.check('scenario 21: the Decisions poll stops while its panel is hidden, and resumes when shown', async () => {
    const t0 = R.towerRequests().length;
    await page.waitForTimeout(6000);
    const shown = decisionsReads(R, t0).length;
    await runCommand(page, 'File: New Untitled Text File');
    await waitFor('the untitled editor in front', async () => /^Untitled/.test(await activeEditorTab(page) ?? ''), 10_000);
    await page.waitForTimeout(1000);
    const t1 = R.towerRequests().length;
    await page.waitForTimeout(8000);
    const hidden = decisionsReads(R, t1).length;
    await runCommand(page, 'View: Close Editor');
    await waitFor('the Decisions editor in front again', async () => /^Decisions/.test(await activeEditorTab(page) ?? ''), 10_000);
    const t2 = R.towerRequests().length;
    await waitFor('a read once shown again', async () => decisionsReads(R, t2).length > 0, 6000);
    if (shown < 2 || hidden !== 0) throw new Error(`reads: ${shown} in 6 s shown, ${hidden} in 8 s hidden`);
    const kept = await decisionCard(frame, 'main-2').locator('textarea.decisions-comment').inputValue();
    if (kept !== DRAFT) throw new Error(`the draft did not survive hiding: ${JSON.stringify(kept)}`);
    return `${shown} reads in 6 s shown; ${hidden} in 8 s hidden; reading again once shown; draft kept (retained context)`;
  });

  await R.check('scenario 18: light, dark and high-contrast themes, switched live with the panel open', async () => {
    await frame.evaluate(() => { window.__codevMarker = 'kept'; });
    const shots = [];
    const seen = {};
    const themes = [['Dark Modern', 'vs-dark'], ['Dark High Contrast', 'hc-black'], ['Light High Contrast', 'hc-light'], ['Light Modern', 'vs']];
    for (const [theme, cls] of themes) {
      await setTheme(page, theme);
      const applied = await page.locator('.monaco-workbench').evaluate((el, c) => el.classList.contains(c), cls);
      if (!applied) throw new Error(`the workbench is not ${cls} after choosing ${theme}`);
      await page.waitForTimeout(800);
      seen[theme] = await frame.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const card = document.querySelector('.decisions-card');
        // WCAG contrast of computed colours: rgb()/rgba(), or color(srgb …) from a color-mix().
        const parse = (c) => {
          const n = (c.match(/-?[\d.]+(?:e-?\d+)?/g) ?? []).map(Number);
          const k = c.startsWith('color(') ? 255 : 1;
          return c === 'transparent' ? { r: 0, g: 0, b: 0, a: 0 } : { r: n[0] * k, g: n[1] * k, b: n[2] * k, a: n.length > 3 ? n[3] : 1 };
        };
        const over = (top, under) => ({ r: top.a * top.r + (1 - top.a) * under.r, g: top.a * top.g + (1 - top.a) * under.g, b: top.a * top.b + (1 - top.a) * under.b, a: 1 });
        // What an element's text is drawn on: its own and its ancestors' backgrounds, composited.
        const backdrop = (el) => {
          const layers = [];
          for (let e = el; e; e = e.parentElement) {
            const bg = parse(getComputedStyle(e).backgroundColor);
            if (bg.a > 0) layers.push(bg);
            if (bg.a >= 1) break;
          }
          let base = layers.at(-1)?.a >= 1 ? layers.pop() : { r: 255, g: 255, b: 255, a: 1 };
          for (const layer of layers.reverse()) base = over(layer, base);
          return base;
        };
        const lum = ({ r, g, b }) => {
          const [R, G, B] = [r, g, b].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
          return 0.2126 * R + 0.7152 * G + 0.0722 * B;
        };
        const ratio = (fg, bg) => { const [x, y] = [lum(fg), lum(bg)].sort((m, n) => n - m); return Math.round(((x + 0.05) / (y + 0.05)) * 10) / 10; };
        const textContrast = (el) => { const bg = backdrop(el); return ratio(over(parse(getComputedStyle(el).color), bg), bg); };
        const contrast = (a, b) => ratio(parse(a), parse(b));
        const page = getComputedStyle(document.body).backgroundColor;
        const id = document.querySelector('.decisions-item-id');
        const submit = [...document.querySelectorAll('.decisions-submit-btn')].find((b) => !b.disabled);
        const word = document.querySelector('.decisions-option-word');
        const badge = document.querySelector('.decisions-badge');
        // Every rendered element in the panel with text of its own, on what it is drawn on.
        const texts = [...document.querySelectorAll('.decisions-view *')]
          .filter((el) => el.getClientRects().length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
          .map((el) => {
            const kind = `${el.tagName.toLowerCase()}${[...el.classList].map((c) => `.${c}`).join('')}`;
            return { kind, what: `${kind} "${el.textContent.trim().slice(0, 24)}"`, contrast: textContrast(el) };
          })
          .sort((a, b) => a.contrast - b.contrast);
        return {
          marker: window.__codevMarker ?? null,
          body: page,
          text: getComputedStyle(document.body).color,
          editorBg: root.getPropertyValue('--vscode-editor-background').trim(),
          card: card ? getComputedStyle(card).borderTopColor : null,
          accent: root.getPropertyValue('--codev-wv-accent').trim(),
          // Text drawn in the accent on the page, and on an accent-filled button.
          idContrast: id ? contrast(getComputedStyle(id).color, page) : null,
          submitContrast: submit ? contrast(getComputedStyle(submit).color, getComputedStyle(submit).backgroundColor) : null,
          wordContrast: word ? textContrast(word) : null,
          badgeContrast: badge ? textContrast(badge) : null,
          scanned: texts.length,
          lowest: texts.slice(0, 3).map(({ what, contrast: c }) => ({ what, contrast: c })),
          // Every kind of text under 4.5:1, at its lowest: shown in the evidence, not only failed on.
          under45: [...new Map(texts.filter((t) => t.contrast < 4.5).reverse().map((t) => [t.kind, t.contrast])).entries()].map(([k, c]) => `${c} ${k}`),
        };
      });
      shots.push(await R.shot(page, `theme-${cls}`));
    }
    const problems = [];
    for (const [theme, s] of Object.entries(seen)) {
      if (s.marker !== 'kept') problems.push(`${theme}: the webview reloaded`);
      if (s.body !== hexToRgb(s.editorBg)) problems.push(`${theme}: body ${s.body} is not the editor background ${s.editorBg}`);
      if (!s.accent) problems.push(`${theme}: --codev-wv-accent resolves to nothing`);
      if (!(s.idContrast >= 4.5)) problems.push(`${theme}: an item id's contrast is ${s.idContrast}`);
      if (!(s.submitContrast >= 4.5)) problems.push(`${theme}: Submit's text contrast is ${s.submitContrast}`);
      if (!(s.wordContrast >= 4.5)) problems.push(`${theme}: an option word's contrast is ${s.wordContrast}`);
      if (!(s.badgeContrast >= 3)) problems.push(`${theme}: the Recommended badge's contrast is ${s.badgeContrast}`);
      // No text in the panel below 3:1, the floor for anything a reader is meant to see.
      const faint = s.lowest.filter((t) => !(t.contrast >= 3));
      if (faint.length) problems.push(`${theme}: faint text ${JSON.stringify(faint)}`);
    }
    const tuples = new Set(Object.values(seen).map((s) => `${s.body}|${s.text}|${s.card}`));
    if (tuples.size !== themes.length) problems.push(`only ${tuples.size} distinct looks across ${themes.length} themes`);
    const draft = await decisionCard(frame, 'main-2').locator('textarea.decisions-comment').inputValue();
    if (draft !== DRAFT) problems.push('the draft did not survive the switches');
    if (problems.length) throw new Error(`${problems.join('; ')} — ${JSON.stringify(seen)}`);
    return { detail: Object.entries(seen).map(([t, s]) => `${t}: body ${s.body}, text ${s.text}, card border ${s.card}, contrast id ${s.idContrast} / Submit ${s.submitContrast} / option word ${s.wordContrast} / badge ${s.badgeContrast}; lowest of ${s.scanned} texts ${s.lowest.map((x) => `${x.contrast} ${x.what}`).join(', ')}; under 4.5: ${s.under45.join(', ') || 'none'}`).join('; '), shots };
  });

  await R.check('the panel is restored after a window reload', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.monaco-workbench', { timeout: 240_000 });
    frame = await decisionsFrame(page, 120_000);
    await waitFor('the restored panel\'s cards', async () => (await frame.locator('.decisions-card').count()) === 3, 60_000);
    const tabs = (await editorTabs(page)).filter((t) => /^Decisions/.test(t ?? ''));
    if (tabs.length !== 1) throw new Error(`${tabs.length} Decisions tabs after the reload`);
    return { detail: 'one Decisions tab, its cards rendered', shots: [await R.shot(page, 'restored')] };
  });

  await R.check('scenario 19: in a builder-worktree window, Open Decisions explains, and the entry navigates to the parent', async () => {
    const wt = fs.readdirSync(path.join(R.opts.fixtures, 'alpha', '.builders')).find((d) => d.includes('101'));
    await loadWorkbench(page, R.folderUrl('alpha', '.builders', wt));
    await runCommand(page, 'Codev: Open Decisions');
    const note = await waitForNotification(page, /not offered in a builder-worktree window/);
    const shot = await R.shot(page, 'worktree-explains');
    const wtCockpit = await openCockpit(page);
    await setExpanded(wtCockpit, ALPHA, true);
    const entry = await waitRow(wtCockpit, [...ALPHA, 'Decisions']);
    const url = await nextPopup(R, context, () => entry.loc.click());
    if (!decodeURIComponent(new URL(url).searchParams.get('folder') ?? '').endsWith('/alpha')) throw new Error(`the entry opened ${url}`);
    if ((await editorTabs(page)).some((t) => /^Decisions/.test(t ?? ''))) throw new Error('a Decisions panel opened in the worktree window');
    return { detail: `"${note}"; entry → ${url}`, shots: [shot] };
  });

  await R.check('scenario 19: in a no-workspace window, Open Decisions explains', async () => {
    await loadWorkbench(page, R.url('ew=true'), { needCodev: false });
    await page.waitForTimeout(3000);
    await runCommand(page, 'Codev: Open Decisions');
    const note = await waitForNotification(page, /needs a Codev workspace/);
    return { detail: `"${note}"`, shots: [await R.shot(page, 'no-workspace-explains')] };
  });

  await R.check('scenario 16: no decisions file shows the empty state; afx decisions init, then an item, and it appears', async () => {
    await loadWorkbench(page, R.folderUrl('gamma'));
    const gammaCockpit = await openCockpit(page);
    await waitRow(gammaCockpit, GAMMA, 60_000);
    await setExpanded(gammaCockpit, GAMMA, true);
    await (await waitRow(gammaCockpit, [...GAMMA, 'Decisions'])).loc.click();
    frame = await decisionsFrame(page);
    const status = frame.locator('.decisions-notice[role="status"]');
    await waitFor('the empty state', async () => (await status.count()) === 1, 20_000);
    const empty = (await status.textContent()).trim();
    if (!/^There is no decisions file/.test(empty) || !/afx decisions init/.test(empty)) throw new Error(`the empty state reads "${empty}"`);
    const emptyShot = await R.shot(page, 'empty-state');

    // The real CLI, run in the fixture: `decisions init` only writes the template (no Tower call).
    const gamma = path.join(R.opts.fixtures, 'gamma');
    const init = spawnSync(process.execPath, [path.join(REPO, 'packages/codev/bin/afx.js'), 'decisions', 'init'], { cwd: gamma, env: process.env, encoding: 'utf-8', timeout: 60_000 });
    if (init.status !== 0) throw new Error(`afx decisions init exited ${init.status}: ${init.stderr || init.stdout}`);
    await waitFor('the new file in place of the empty state', async () => (await status.count()) === 0 && /0 open/.test(await frame.locator('.decisions-count').textContent().catch(() => '')), 15_000);
    const initShot = await R.shot(page, 'initialized');
    addOpenItem(path.join(gamma, DECISIONS_PATH), GAMMA_1, '1 open — main-1.');
    await waitFor('gamma\'s first item', async () => (await decisionCard(frame, 'main-1').count()) === 1, 15_000);
    const words = await decisionCard(frame, 'main-1').locator('input[type="radio"]').evaluateAll((els) => els.map((e) => e.value));
    return {
      detail: `"${empty}" → afx decisions init: "${init.stdout.split('\n').find((l) => /Created/.test(l))?.trim()}" → 0 open → main-1 appears (${words.join(' / ')})`,
      shots: [emptyShot, initShot, await R.shot(page, 'item-appears')],
    };
  });

  await R.check('scenario 22: the webview never contacts Tower; the key is in no request; remote item images are its only network loads', async () => {
    const towerPort = R.opts['tower-port'];
    const problems = [];
    const toTower = requests.filter((r) => URL.canParse(r.url) && new URL(r.url).port === towerPort);
    if (toTower.length) problems.push(`${toTower.length} browser request(s) to the Tower port: ${toTower.slice(0, 3).map((r) => r.url).join(', ')}`);
    const keyed = requests.filter((r) => r.key);
    if (keyed.length) problems.push(`${keyed.length} request(s) carry the key header`);
    const webview = requests.filter((r) => /\/webview\/browser\/pre\//.test(r.frame));
    const kinds = {};
    for (const r of webview) {
      const origin = URL.canParse(r.frame) ? new URL(r.frame).origin : '';
      const kind = r.url === REMOTE_IMAGE || r.url === REMOTE_GONE ? 'remote item image'
        : /^(blob|data):/.test(r.url) ? 'blob/data'
          : URL.canParse(r.url) && /\.vscode-resource\./.test(new URL(r.url).hostname) ? 'extension resource'
            : URL.canParse(r.url) && new URL(r.url).origin === origin ? "VS Code's webview host page"
              : null;
      if (!kind) problems.push(`unexpected webview request ${r.url}`);
      else kinds[kind] = (kinds[kind] ?? 0) + 1;
    }
    if (!kinds['remote item image']) problems.push('the audit saw no webview request at all for the remote image (is it attributing frames?)');
    const html = await frame.content();
    if (html.includes(process.env.COCKPIT_TOWER_KEY) || html.includes(`:${towerPort}`)) problems.push('the webview document holds the key or the Tower port');
    if (problems.length) throw new Error(problems.slice(0, 8).join('; '));
    return `${requests.length} browser requests, none to :${towerPort}, none keyed; webview frames: ${JSON.stringify(kinds)}`;
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
