/**
 * Issue #1450 — dev-approval evidence for the clickable held-mail counter.
 *
 * This is a DASHBOARD change, so "tests pass" is not evidence: the affordance, the popover,
 * its grouping and its stacking only exist in a browser. This script produces that browser
 * run against a real, ISOLATED Tower and saves screenshots.
 *
 * ## Why a second Tower, and why it is safe
 *
 * `afx dev` deliberately reuses the live Tower's ports, and restarting the live Tower kills
 * every builder session — neither is acceptable from inside a builder worktree. So this
 * follows the pattern `send-integration.e2e.test.ts` and pir-1365's evidence script use:
 * spawn THIS worktree's built `tower-server.js` on a private port with
 * `NODE_ENV=test` + `AF_TEST_DB`, which redirects the mailbox to its own db file inside
 * `~/.agent-farm/` (`db/index.ts` getGlobalDbPath). That isolation is load-bearing, not
 * tidiness: a second Tower reading the real `global.db` would run its own mailbox-delivery
 * loop against the cohort's live held mail. The shared Tower on 4100 is never touched.
 *
 * ## What is real here
 *
 * Nothing about the path under test is stubbed. Real Tower process, real SQLite mailbox,
 * real `POST /api/send` going through the render gate (which HOLDS, because the recipient's
 * composer is painted occupied), real `GET /workspace/<b64>/api/inbox` — the route this
 * issue adds — and the real built SPA driven by a real Chromium.
 *
 * The `GET .../api/inbox` response status is asserted to be 200. That assertion is the point:
 * the route is key-authenticated, and a 401 renders in the popover as a tidy error state that
 * looks like a working UI. "The panel showed something" is not evidence.
 *
 * ## Running it
 *
 *   pnpm build
 *   node --experimental-strip-types packages/codev/scripts/issue-1450-dashboard-evidence.mts
 *
 * Needs a Playwright browser driver. `playwright-core` is not a dependency of this repo (it
 * would be a heavy devDependency for one script), so point PW_CORE at an installed copy and
 * PW_CHROMIUM at a browser binary:
 *
 *   npm install playwright-core --prefix /tmp/pw
 *   PW_CORE=/tmp/pw/node_modules/playwright-core \
 *   PW_CHROMIUM=~/.cache/ms-playwright/chromium-*\/chrome-linux64/chrome \
 *   node --experimental-strip-types packages/codev/scripts/issue-1450-dashboard-evidence.mts
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import net from 'node:net';

const PORT = 14700; // private to this script (14500 / 14600 / 14650 are taken)
const BASE = `http://localhost:${PORT}`;
const TOWER = resolve(import.meta.dirname, '../dist/agent-farm/servers/tower-server.js');
// Defaults outside the repo so a bare run cannot leave untracked PNGs in the working tree.
const SHOTS = process.env.SHOT_DIR || resolve(tmpdir(), 'codev-evidence-1450');

const ESC = '\x1b';
const RULE = '─'.repeat(22);
const CLEAR = `${ESC}[2J${ESC}[H`;
/** An OCCUPIED composer: a draft at normal intensity → the render gate HOLDS the send. */
const DRAFT_COMPOSER = `${CLEAR}❯ ${ESC}[0mdeploy the hotfix to prod\r\n${RULE}\r\n`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let checks = 0;
function check(ok: boolean, label: string, detail = ''): void {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}
function section(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

/** The shared local key Tower expects on API calls (advisory GHSA-xvjp-7748-v88v). */
const KEY = readFileSync(resolve(homedir(), '.agent-farm', 'local-key'), 'utf-8').trim();
const AUTH = { 'codev-tower-key': KEY };

// ---------------------------------------------------------------- Tower lifecycle

async function portListening(port: number): Promise<boolean> {
  return new Promise((r) => {
    const s = new net.Socket();
    s.setTimeout(1000);
    s.on('connect', () => { s.destroy(); r(true); });
    s.on('timeout', () => { s.destroy(); r(false); });
    s.on('error', () => r(false));
    s.connect(port, '127.0.0.1');
  });
}

async function startTower(): Promise<ChildProcess> {
  if (!existsSync(TOWER)) throw new Error(`Tower build missing at ${TOWER} — run \`pnpm build\` first.`);
  const proc = spawn('node', [TOWER, String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // THE isolation seam — see the header. Without AF_TEST_DB this would attach to the
    // cohort's live global.db and start delivering their held mail.
    env: { ...process.env, NODE_ENV: 'test', AF_TEST_DB: `test-1450-${PORT}.db` },
  });
  let stderr = '';
  proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  for (let i = 0; i < 75; i++) {
    if (await portListening(PORT)) return proc;
    await sleep(200);
  }
  proc.kill();
  throw new Error(`Tower did not start on ${PORT}. stderr:\n${stderr}`);
}

async function stopTower(proc: ChildProcess | null): Promise<void> {
  if (!proc) return;
  proc.kill('SIGTERM');
  await new Promise<void>((r) => {
    proc.on('exit', () => r());
    setTimeout(() => { proc.kill('SIGKILL'); r(); }, 3000);
  });
}

// ---------------------------------------------------------------- workspace + terminals

const enc = (p: string) => Buffer.from(p).toString('base64url');

function makeWorkspace(): string {
  const base = resolve(homedir(), '.agent-farm', 'test-workspaces');
  mkdirSync(base, { recursive: true });
  const ws = mkdtempSync(resolve(base, 'issue1450-'));
  for (const d of ['codev', '.agent-farm', '.codev']) mkdirSync(resolve(ws, d), { recursive: true });
  writeFileSync(
    resolve(ws, '.codev', 'config.json'),
    JSON.stringify({ shell: { architect: 'sh -c "sleep 3600"', builder: 'bash', shell: 'bash' } }),
  );
  // Lets `resolveProfileForSession` recover a harness for the wrapped launch, so sends are
  // held for `busy` (an occupied composer) rather than short-circuiting on `no-profile`.
  writeFileSync(resolve(ws, '.builder-start.sh'), '#!/usr/bin/env bash\nexec claude --dangerously-skip-permissions\n');
  return ws;
}

async function activate(ws: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const res = await fetch(`${BASE}/api/workspaces/${enc(ws)}/activate`, { method: 'POST', headers: AUTH });
    if (res.ok) break;
    await sleep(500);
  }
  for (let i = 0; i < 60; i++) {
    const list = await (await fetch(`${BASE}/api/workspaces`, { headers: AUTH })).json();
    if (list.workspaces?.some((w: { path: string }) => w.path === ws)) return;
    await sleep(500);
  }
  throw new Error('workspace never activated');
}

/** A real shellper-backed PTY that echoes its input, so a composer can be painted onto it. */
async function registerEchoTerminal(ws: string, roleId: string): Promise<string> {
  const res = await fetch(`${BASE}/api/terminals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...AUTH },
    body: JSON.stringify({
      command: 'sh',
      args: ['-c', 'stty raw -echo 2>/dev/null; exec cat'],
      cwd: ws, cols: 110, rows: 32,
      workspacePath: ws, type: 'builder', roleId, persistent: true,
    }),
  });
  if (res.status !== 201) throw new Error(`terminal register failed for ${roleId}: ${res.status}`);
  return (await res.json()).id;
}

async function paint(terminalId: string, screen: string): Promise<void> {
  await fetch(`${BASE}/api/terminals/${terminalId}/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...AUTH },
    body: JSON.stringify({ data: screen }),
  });
  await sleep(250);
}

async function send(ws: string, to: string, message: string, options: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...AUTH },
    body: JSON.stringify({ to, workspace: ws, from: 'architect', message, options }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });

  // playwright-core is CJS: an ESM `import()` of it puts the exports on `.default`, and a
  // bare directory path needs its entry file spelled out. Accept either shape so PW_CORE can
  // be a package name, a directory, or a file.
  const pwCore = process.env.PW_CORE || 'playwright-core';
  const candidates = pwCore.endsWith('.js') || !pwCore.startsWith('/')
    ? [pwCore]
    : [`${pwCore}/index.js`, pwCore];
  let chromium: any;
  for (const candidate of candidates) {
    try {
      const mod: any = await import(candidate);
      chromium = mod.chromium ?? mod.default?.chromium;
      if (chromium) break;
    } catch { /* try the next shape */ }
  }
  if (!chromium) {
    console.error(
      `\nCould not load playwright-core from "${pwCore}".\n` +
      `Install it out-of-tree and set PW_CORE / PW_CHROMIUM — see this file's header.\n`,
    );
    process.exit(2);
  }

  let tower: ChildProcess | null = null;
  try {
    section('SETUP — isolated Tower, workspace, held mail');
    tower = await startTower();
    check(true, `Tower up on ${PORT} with AF_TEST_DB=test-1450-${PORT}.db (live global.db untouched)`);

    const ws = makeWorkspace();
    await activate(ws);
    check(true, `workspace activated`, ws);

    // Two recipients with OCCUPIED composers → the gate holds every send.
    const cost = await registerEchoTerminal(ws, 'cost');
    const docs = await registerEchoTerminal(ws, 'docs');
    await paint(cost, DRAFT_COMPOSER);
    await paint(docs, DRAFT_COMPOSER);

    const r1 = await send(ws, 'cost', 'the cost report needs a second look');
    const r2 = await send(ws, 'docs', 'please refresh the install docs');
    // A pre-due --delay row: scheduled, NOT counted by heldCount. This is the row that makes
    // the badge count and the list length disagree, which the popover has to group.
    const r3 = await send(ws, 'cost', 'nightly summary', { deliverAfter: 3600 });

    check(r1.body.held === true, 'send → cost was HELD (occupied composer)', String(r1.body.reason ?? ''));
    check(r2.body.held === true, 'send → docs was HELD', String(r2.body.reason ?? ''));
    check(r3.status === 200, 'delayed send accepted', `status ${r3.status}`);

    const inbox = await (await fetch(`${BASE}/api/inbox?workspace=${encodeURIComponent(ws)}`, { headers: AUTH })).json();
    console.log(`  inbox rows: ${JSON.stringify(inbox.map((r: any) => `${r.fromAgent}→${r.toAgent}${r.notBefore ? ' (scheduled)' : ''}`))}`);
    check(inbox.length >= 2, 'held rows are in the mailbox', `${inbox.length} rows`);

    section('BROWSER — the real built SPA in Chromium');
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    // Capture the status of the route this issue adds. A 401 renders as a benign-looking
    // error state, so the status is the assertion that matters.
    const inboxStatuses: number[] = [];
    page.on('response', (res) => {
      if (new URL(res.url()).pathname.endsWith('/api/inbox')) inboxStatuses.push(res.status());
    });
    const consoleErrors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    // NOT `networkidle`: the dashboard holds an SSE stream (/api/events) open for its
    // lifetime, so the network never goes idle and the wait would always time out.
    await page.goto(`${BASE}/workspace/${enc(ws)}/`, { waitUntil: 'domcontentloaded' });

    // 1 — the counter, closed. The affordance must be visible without interacting.
    const badge = page.getByTestId('held-badge');
    await badge.waitFor({ state: 'visible', timeout: 20_000 });
    check(true, 'held badge is rendered', await badge.textContent() ?? '');
    const decoration = await badge.evaluate((el) => getComputedStyle(el).textDecorationLine);
    check(decoration.includes('underline'), 'counter is underlined (reads as clickable)', decoration);
    check(await badge.evaluate((el) => el.tagName) === 'BUTTON', 'counter is a real <button>');
    check(await badge.getAttribute('aria-expanded') === 'false', 'starts collapsed (aria-expanded=false)');
    await page.screenshot({ path: `${SHOTS}/1-counter-closed.png` });

    // 2 — click it open.
    await badge.click();
    const popover = page.getByTestId('held-popover');
    await popover.waitFor({ state: 'visible', timeout: 10_000 });
    check(await badge.getAttribute('aria-expanded') === 'true', 'aria-expanded flips to true on open');

    // The fetch is lazy, so the panel renders "Loading…" before the rows. Wait for the
    // loaded content, or the text assertions below race the request and read the spinner.
    await page.getByTestId('held-group-held').waitFor({ state: 'visible', timeout: 15_000 });
    const panelText = (await popover.textContent()) ?? '';
    check(panelText.includes('architect → cost'), 'panel lists architect → cost');
    check(panelText.includes('architect → docs'), 'panel lists architect → docs');
    check(panelText.includes('Held ('), 'panel has a Held group');
    check(panelText.includes('Scheduled ('), 'panel has a Scheduled group for the pre-due row');
    await page.screenshot({ path: `${SHOTS}/2-popover-open.png` });

    // THE network assertion.
    check(inboxStatuses.length > 0, 'GET .../api/inbox was actually requested', JSON.stringify(inboxStatuses));
    check(inboxStatuses.every((s) => s === 200), 'GET .../api/inbox returned 200 (not a 401 masquerading as empty)', JSON.stringify(inboxStatuses));

    // The Held group must equal the badge count — the plan's blocking-finding invariant.
    const badgeCount = parseInt((await badge.textContent())?.trim() ?? '0', 10);
    const heldRows = await page.getByTestId('held-group-held').locator('li').count();
    check(heldRows === badgeCount, 'Held group length === badge count', `held=${heldRows} badge=${badgeCount}`);
    const schedRows = await page.getByTestId('held-group-scheduled').locator('li').count();
    check(schedRows >= 1, 'scheduled row is listed separately, not counted', `scheduled=${schedRows}`);

    // 3 — stacking against a REAL terminal. The hazard this guards is xterm's WebGL/canvas
    // renderer painting over an unlayered panel, so the check is only meaningful with a
    // terminal actually mounted underneath the popover — not the Work view. Open a builder
    // terminal tab in the right pane first, then reopen the popover on top of it.
    await page.keyboard.press('Escape');
    await popover.waitFor({ state: 'detached', timeout: 5000 });

    await page.getByRole('tab', { name: /cost/ }).first().click();
    await page.locator('.xterm-screen, .xterm canvas').first().waitFor({ state: 'visible', timeout: 20_000 });
    await sleep(600); // let the renderer paint before we measure what is on top

    await badge.click();
    await popover.waitFor({ state: 'visible', timeout: 10_000 });

    const stacking = await popover.evaluate((el) => {
      const r = el.getBoundingClientRect();
      // Sample several points across the panel, not just the centre: a canvas can win at
      // one coordinate and lose at another.
      const points: Array<[number, number]> = [
        [r.left + r.width / 2, r.top + 10],
        [r.left + r.width / 2, r.top + r.height / 2],
        [r.left + r.width / 2, r.bottom - 10],
        [r.left + 10, r.top + r.height / 2],
        [r.right - 10, r.top + r.height / 2],
      ];
      const covered = points.filter(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return hit ? el.contains(hit) : false;
      }).length;
      // Is there genuinely a terminal painted behind it? Check EVERY mounted .xterm, not
      // just the first — the left pane holds an architect terminal that never overlaps the
      // top-right popover, and querying only that one would silently under-report.
      const overlapsTerminal = Array.from(document.querySelectorAll('.xterm')).some((term) => {
        const b = term.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) return false; // hidden/kept-alive tab
        return b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top;
      });
      return { covered, total: points.length, overlapsTerminal };
    });
    check(stacking.overlapsTerminal, 'a terminal is mounted behind the popover (the check is real)');
    check(
      stacking.covered === stacking.total,
      'popover paints over the terminal at every sampled point (z-index tier holds)',
      `${stacking.covered}/${stacking.total}`,
    );
    await page.screenshot({ path: `${SHOTS}/3-popover-over-terminal.png`, fullPage: false });

    // 4 — keyboard: Escape closes and focus returns to the button.
    await page.keyboard.press('Escape');
    await popover.waitFor({ state: 'detached', timeout: 5000 });
    const focusIsBadge = await page.evaluate(() =>
      document.activeElement?.getAttribute('data-testid') === 'held-badge');
    check(focusIsBadge, 'Escape closes and returns focus to the counter');

    check(consoleErrors.length === 0, 'browser console clean', consoleErrors.slice(0, 3).join(' | '));

    await browser.close();

    section(`RESULT — ${checks - failures}/${checks} checks passed; screenshots in ${SHOTS}`);
  } finally {
    await stopTower(tower);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
