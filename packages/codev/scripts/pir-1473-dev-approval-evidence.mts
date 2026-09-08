/**
 * PIR #1473 — dev-approval evidence against real, ISOLATED Towers.
 *
 * The plan's Manual section is the bar for this gate. Its steps assume a live Tower, but
 * `afx dev` from this worktree would bind the live Tower's port (4100 is shared by design) and
 * restarting the live Tower kills every builder session — so this follows the precedent set by
 * `spec-1365-e2e-evidence.mts` and `pir-1475-dev-approval-evidence.mts`: spawn THIS worktree's
 * built Tower on a private port with its own test DB, register REAL PTY sessions, and drive the
 * REAL HTTP and WebSocket endpoints. Nothing on the path under test is stubbed —
 * client → WebSocket → PtySession.write → stripTerminalReplies → inputSeq/lastInputAt →
 * ringToken/inputSettled → the paced write → the PTY is the full wire path.
 *
 * A SECOND Tower is started from the MAIN checkout's build, so every latency claim here is a
 * measured delta against the code this branch changes rather than an absolute number with
 * nothing to compare it to. If main's dist is missing the comparison SKIPS loudly rather than
 * quietly reporting one-sided numbers.
 *
 * ## What is measured, and what each fixture can and cannot tell you
 *
 *   - **The repaint shims** (`claude`, `codex`): a small Node program in raw mode that redraws
 *     the whole composer on every keystroke — the shape of a real TUI's keystroke→repaint
 *     cycle, at a real process boundary, over a real PTY. It is a PROXY. A real harness adds
 *     its own event loop and render on top, so every number in STEP 2 is a LOWER BOUND on what
 *     claude or codex would show. That matters for the rollback criterion, and the script says
 *     so where it evaluates it rather than burying the caveat here.
 *
 *   - **The echo shim** (`cat` under `stty raw -echo`): echoes every byte written to the PTY
 *     back into the output ring, so the terminal transcript is a faithful record of what
 *     actually reached the terminal, and the screen only ever shows what this script painted.
 *     That is what makes the gate's classification deterministic in the delivery steps. Raw
 *     mode means a `^C` arrives as a byte rather than a signal, so sessions survive scenarios.
 *
 * ## What this script deliberately does NOT claim
 *
 * Manual steps 1, 3 and 4 need a human and are NOT simulated here — the script prints them as
 * outstanding rather than inferring them from unit tests. Step 1 in particular CANNOT be run
 * against `afx attach` (it bypasses PtySession entirely, so it would show zero chunks and read
 * as a false pass), and it needs a real browser and a real VS Code integrated terminal, which
 * is exactly what a script cannot supply.
 *
 * Usage: pnpm build && node --experimental-strip-types \
 *          scripts/pir-1473-dev-approval-evidence.mts
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import net from 'node:net';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
import { ensureLocalKey } from '@cluesmith/codev-core/auth';
import { TOWER_KEY_HEADER, terminalWsProtocols } from '@cluesmith/codev-types';

/**
 * Tower enforces request authentication, so every call here carries the shared local key
 * exactly as `afx` does. Using the real auth path rather than disabling it keeps the evidence
 * honest: these are the same requests an operator's CLI makes.
 */
const KEY = ensureLocalKey();
const AUTH: Record<string, string> = { [TOWER_KEY_HEADER]: KEY };
const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json', ...AUTH };

// Private to this script. 14500, 14600, 14650, 14700, 14782 and 14783 are taken by the other
// evidence scripts and e2e suites — and `startTower` REFUSES a port it did not itself bind,
// because an earlier revision of the #1475 script silently drove someone else's Tower and
// reported its results as its own.
const PORT = 14790;        // this branch's build
const MAIN_PORT = 14791;   // the MAIN checkout's build, for the deltas
const LIVE_TOWER_PORT = 4100; // must be untouched; asserted at start and end

const DIST = resolve(import.meta.dirname, '../dist');
const TOWER = join(DIST, 'agent-farm/servers/tower-server.js');

/**
 * The BASELINE Tower the deltas are measured against — a build of this branch's merge-base.
 *
 * Deliberately NOT the shared main checkout's `dist`: that tree belongs to the live workspace
 * and to every other builder in it, its dist can be months stale (it was, when this script was
 * written — stale enough that it no longer started), and rebuilding it to suit one evidence run
 * is not this script's call to make. A detached worktree at the merge-base is the honest
 * comparison anyway: it is exactly the code this branch changed, with nothing else moving.
 *
 * Produce one with:
 *   git worktree add --detach /path/to/baseline "$(git merge-base main HEAD)"
 *   cd /path/to/baseline && pnpm install --frozen-lockfile \
 *     && pnpm --filter @cluesmith/codev-artifact-canvas build \
 *     && pnpm --filter @cluesmith/codev build
 *
 * then point PIR1473_BASELINE_DIST at its `packages/codev/dist`. Unset → every delta SKIPs
 * loudly rather than reporting one-sided numbers as if they meant something.
 */
const BASELINE_DIST = process.env.PIR1473_BASELINE_DIST ?? '';
const BASELINE_TOWER = BASELINE_DIST ? join(BASELINE_DIST, 'agent-farm/servers/tower-server.js') : '';

const ESC = '\x1b';
const COMPOSER_RULE = '─'.repeat(22);
const CLEAR = `${ESC}[2J${ESC}[H`;
/** A CLEAN claude composer: marker + dim placeholder only → the render gate delivers. */
const CLEAN_COMPOSER = `${CLEAR}❯ ${ESC}[2mTry "fix the flaky test"${ESC}[0m\r\n${COMPOSER_RULE}\r\n`;

/**
 * The constants under test, restated here rather than imported: this script is evidence ABOUT
 * the build in `dist`, so it must not silently track a source edit made after that build.
 */
const INPUT_SETTLE_MS = 300;
const OUTPUT_SETTLE_MS = 250;
const BACKSTOP_INTERVAL_MS = 1500;
/** `QUIESCENCE_DEBOUNCE_MS` — the OTHER fast trigger, and the one a weak assertion mistakes for the re-drain. */
const QUIESCENCE_DEBOUNCE_MS = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const AGENT_FARM_DIR = resolve(homedir(), '.agent-farm');

let failures = 0;
let checks = 0;
const skips: string[] = [];

function check(ok: boolean, label: string, detail = ''): void {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}
function note(msg: string): void { console.log(`  note  ${msg}`); }
function skip(label: string, why: string): void {
  skips.push(label);
  console.log(`  SKIP  ${label}\n        ${why}`);
}
function section(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

// ---------------------------------------------------------------- statistics

interface Stats { n: number; min: number; p50: number; p95: number; p99: number; max: number; mean: number }

/** Nearest-rank percentiles — no interpolation, so every reported value is a real sample. */
function stats(samples: number[]): Stats {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p: number): number => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
  return {
    n: s.length,
    min: s[0],
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: s[s.length - 1],
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
}
const ms = (v: number): string => `${v.toFixed(1)}ms`;
function printStats(label: string, st: Stats): void {
  console.log(
    `  ${label.padEnd(34)} n=${String(st.n).padStart(3)}  ` +
    `min=${ms(st.min).padStart(8)}  p50=${ms(st.p50).padStart(8)}  ` +
    `p95=${ms(st.p95).padStart(8)}  p99=${ms(st.p99).padStart(8)}  max=${ms(st.max).padStart(8)}`,
  );
}

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

interface Tower {
  proc: ChildProcess;
  log: string[];
  port: number;
  base: string;
  dbName: string;
  which: 'branch' | 'main';
}

async function startTower(opts: {
  port: number; tower: string; dbName: string; socketDir: string; which: 'branch' | 'main';
}): Promise<Tower> {
  // Fail loudly rather than adopt a stranger's Tower: a listening port here means some other
  // process owns it, and every measurement after this point would be timing that process.
  if (await portListening(opts.port)) {
    throw new Error(
      `port ${opts.port} is already listening — refusing to run against a Tower this script did not start.`,
    );
  }
  const log: string[] = [];
  const proc = spawn('node', [opts.tower, String(opts.port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test', AF_TEST_DB: opts.dbName, SHELLPER_SOCKET_DIR: opts.socketDir },
  });
  const collect = (d: Buffer): void => {
    for (const line of d.toString().split('\n')) if (line.trim()) log.push(line);
  };
  proc.stdout?.on('data', collect);
  proc.stderr?.on('data', collect);
  for (let i = 0; i < 75; i++) {
    if (await portListening(opts.port)) {
      return { proc, log, port: opts.port, base: `http://localhost:${opts.port}`, dbName: opts.dbName, which: opts.which };
    }
    await sleep(200);
  }
  proc.kill('SIGKILL');
  throw new Error(`Tower did not start on ${opts.port}. log:\n${log.slice(-25).join('\n')}`);
}

async function stopTower(t: Tower): Promise<void> {
  t.proc.kill('SIGTERM');
  for (let i = 0; i < 40; i++) {
    if (!(await portListening(t.port))) return;
    await sleep(250);
  }
  t.proc.kill('SIGKILL');
  await sleep(500);
}

// ---------------------------------------------------------------- fixtures

/**
 * An executable that echoes its PTY input — the deterministic-screen oracle, so the delivery
 * steps classify exactly what this script painted and nothing else.
 */
function makeEchoShim(root: string, name: string): string {
  const bin = join(root, `bin-echo-${name}`);
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, name);
  writeFileSync(shim, `#!/bin/sh\nstty raw -echo 2>/dev/null\nexec cat\n`, { mode: 0o755 });
  return shim;
}

/**
 * An executable that behaves like a TUI: raw mode, and a FULL composer repaint on every
 * keystroke. This is the calibration fixture, and its realism is the whole point — the number
 * that matters for the settle constant is "how long until a keystroke is visible in the
 * terminal's output", and that includes an app waking up, processing the byte and painting.
 *
 * It is still a PROXY, and a generous one: a real harness runs a far heavier render than this.
 * Every figure it produces is therefore a LOWER BOUND, which is the honest direction to be
 * wrong in when the measurement is being used to defend a timeout — an underestimate makes the
 * criterion HARDER to satisfy, not easier.
 */
function makeRepaintShim(root: string, name: string): string {
  const bin = join(root, `bin-repaint-${name}`);
  mkdirSync(bin, { recursive: true });
  const js = join(bin, `${name}-repaint.cjs`);
  writeFileSync(js, [
    "'use strict';",
    "let buf = '';",
    "process.stdin.setRawMode && process.stdin.setRawMode(true);",
    "process.stdin.resume();",
    "process.stdin.on('data', (b) => {",
    "  buf = (buf + b.toString('utf8')).slice(-40);",
    // A full-screen composer redraw, exactly as a TUI repaints its input region.
    "  process.stdout.write('\\x1b[2J\\x1b[H\\u276f ' + buf + '\\r\\n' + '\\u2500'.repeat(22) + '\\r\\n');",
    "});",
  ].join('\n'));
  const shim = join(bin, name);
  writeFileSync(shim, `#!/bin/sh\nexec ${process.execPath} ${js}\n`, { mode: 0o755 });
  return shim;
}

function makeWorkspace(root: string): string {
  const ws = mkdtempSync(join(root, 'ws-'));
  for (const d of ['codev', '.agent-farm', '.codev']) mkdirSync(join(ws, d), { recursive: true });
  writeFileSync(join(ws, '.codev', 'config.json'), JSON.stringify({ shell: { builder: 'bash', shell: 'bash' } }));
  return ws;
}

// ---------------------------------------------------------------- Tower API

async function activate(t: Tower, ws: string): Promise<void> {
  const encoded = Buffer.from(ws).toString('base64url');
  for (let i = 0; i < 30; i++) {
    const res = await fetch(`${t.base}/api/workspaces/${encoded}/activate`, { method: 'POST', headers: AUTH });
    if (res.ok) break;
    await sleep(500);
  }
  for (let i = 0; i < 60; i++) {
    const list = await (await fetch(`${t.base}/api/workspaces`, { headers: AUTH })).json();
    if (list.workspaces.some((w: { path: string }) => w.path === ws)) return;
    await sleep(500);
  }
  throw new Error('workspace never activated');
}

async function registerTerminal(
  t: Tower, ws: string, roleId: string, command: string, persistent: boolean,
): Promise<string> {
  const res = await fetch(`${t.base}/api/terminals`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      command, args: [], cwd: ws, cols: 110, rows: 32,
      workspacePath: ws, type: 'builder', roleId, persistent,
    }),
  });
  if (res.status !== 201) {
    // Dump the Tower's own tail: a registration failure is almost always something the Tower
    // logged in detail and the HTTP body summarised in five words.
    throw new Error(
      `terminal register failed: ${res.status} ${await res.text()}\n  tower tail:\n` +
      t.log.slice(-15).map((l) => `    ${l}`).join('\n'),
    );
  }
  return (await res.json()).id;
}

interface SendResult { status: number; body: Record<string, unknown> }

async function send(
  t: Tower, ws: string, to: string, message: string, options: Record<string, unknown> = {},
): Promise<SendResult> {
  const res = await fetch(`${t.base}/api/send`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ to, workspace: ws, from: 'architect', message, options }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// ---------------------------------------------------------------- terminal WebSocket

/**
 * A live terminal client — the SAME wire path a browser uses, which is what makes the
 * keystroke timings here measurements of the real thing rather than of an HTTP helper.
 *
 * Input goes out as a data frame (`session.handleUserInput`), and every byte the PTY produces
 * arrives back on this socket. Both directions are timestamped on arrival, so a round trip is
 * measured with one clock and no polling interval to round to.
 */
interface TermClient {
  ws: WebSocket;
  /** Wall-clock ms (performance.now basis) at which each output chunk arrived. */
  chunks: Array<{ at: number; text: string }>;
  send(data: string): number;
  waitFor(predicate: (textSince: string) => boolean, sinceIdx: number, timeoutMs?: number): Promise<number | null>;
  textSince(idx: number): string;
  close(): void;
}

async function openTerminal(t: Tower, terminalId: string): Promise<TermClient> {
  const ws = new WebSocket(`ws://localhost:${t.port}/ws/terminal/${terminalId}`, terminalWsProtocols(KEY));
  const chunks: Array<{ at: number; text: string }> = [];
  ws.on('message', (raw: Buffer) => {
    const buf = Buffer.from(raw);
    if (buf.length === 0) return;
    // 0x01 = data frame; 0x00 = control (replay/seq bookkeeping) which is not terminal output.
    if (buf[0] !== 0x01) return;
    chunks.push({ at: performance.now(), text: buf.subarray(1).toString('utf8') });
  });
  await new Promise<void>((res, rej) => {
    const timer = setTimeout(() => rej(new Error('terminal WS open timeout')), 10_000);
    ws.on('open', () => { clearTimeout(timer); res(); });
    ws.on('error', (e) => { clearTimeout(timer); rej(e); });
  });
  // Let the replay burst land so it cannot be mistaken for an echo of our own input.
  await sleep(600);

  const client: TermClient = {
    ws,
    chunks,
    send(data: string): number {
      const frame = Buffer.allocUnsafe(1 + Buffer.byteLength(data));
      frame[0] = 0x01;
      Buffer.from(data, 'utf8').copy(frame, 1);
      const at = performance.now();
      ws.send(frame);
      return at;
    },
    textSince(idx: number): string {
      return chunks.slice(idx).map((c) => c.text).join('');
    },
    async waitFor(predicate, sinceIdx, timeoutMs = 8000): Promise<number | null> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        // Scan forward for the FIRST chunk index at which the predicate becomes true, and
        // report that chunk's arrival time — not the time we noticed, which would fold this
        // poll loop's own interval into every measurement.
        for (let i = sinceIdx; i < chunks.length; i++) {
          if (predicate(chunks.slice(sinceIdx, i + 1).map((c) => c.text).join(''))) return chunks[i].at;
        }
        if (Date.now() > deadline) return null;
        await sleep(2);
      }
    },
    close(): void { try { ws.close(); } catch { /* already gone */ } },
  };
  return client;
}

/**
 * Paint a screen through the raw write route and let the mirror catch up.
 *
 * `settleMs` defaults to comfortably past BOTH settle windows, because most callers want a
 * quiet, idle prompt as their starting condition. A caller that is deliberately measuring the
 * un-settled case passes a shorter one — and must, since the paint is itself an external write
 * and therefore counts as terminal input.
 */
async function paint(t: Tower, terminalId: string, screen: string, settleMs = 400): Promise<void> {
  await fetch(`${t.base}/api/terminals/${terminalId}/write`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ data: screen }),
  });
  await sleep(settleMs);
}

/**
 * A Right-arrow keystroke sent over the terminal's own WebSocket — the REAL human input path
 * (`handleUserInput`), not a route that merely resembles one.
 *
 * Chosen deliberately over a printable character: the echo shim echoes it, the terminal moves
 * its cursor one cell, and the SCREEN CONTENT does not change — so the render gate still
 * classifies a clean composer and the only thing standing between the message and the prompt is
 * the input signal itself. A printable character would leave a draft on screen and the row
 * would hold `user-text`, which is the OLD guard and proves nothing about this issue.
 *
 * It is also the exact case the plan called out as otherwise costing a full backstop period: a
 * navigation key that provokes no visible output of its own.
 */
const ARROW_RIGHT = `${ESC}[C`;

// ---------------------------------------------------------------- DB

function dbFor(dbName: string): Database.Database {
  return new Database(resolve(AGENT_FARM_DIR, dbName));
}

/**
 * Start each run from an empty test DB (only ever the `test-1473-*.db` files this script owns
 * — never `global.db`). Held rows from a previous run would otherwise interleave their
 * starvation notices with this run's log and read as if THIS run had undelivered mail.
 */
function resetTestDb(dbName: string): void {
  if (!/^test-1473-\d+\.db$/.test(dbName)) throw new Error(`refusing to delete non-test DB: ${dbName}`);
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(resolve(AGENT_FARM_DIR, `${dbName}${suffix}`), { force: true });
  }
}

interface RowState { status: string; reason: string | null; detail: string | null }

function rowState(dbName: string, id: string): RowState | null {
  const db = dbFor(dbName);
  try {
    return (db.prepare('SELECT status, reason, detail FROM mailbox WHERE id = ?').get(id) as RowState) ?? null;
  } finally { db.close(); }
}

/**
 * Poll one mailbox row and record every DISTINCT (status, reason, detail) it passes through.
 *
 * This is the transcript that shows the new hold actually happening in a running Tower: a row
 * that goes held/busy/recent-input → delivered is the gate declining to write onto a terminal
 * that had just been typed at, and then delivering once it settled.
 */
async function traceRow(dbName: string, id: string, forMs: number): Promise<Array<RowState & { at: number }>> {
  const seen: Array<RowState & { at: number }> = [];
  const t0 = performance.now();
  const deadline = Date.now() + forMs;
  for (;;) {
    const st = rowState(dbName, id);
    if (st) {
      const last = seen[seen.length - 1];
      if (!last || last.status !== st.status || last.reason !== st.reason || last.detail !== st.detail) {
        seen.push({ ...st, at: performance.now() - t0 });
      }
      if (st.status === 'delivered') return seen;
    }
    if (Date.now() > deadline) return seen;
    await sleep(10);
  }
}

// ================================================================ STEP 2

/**
 * Manual step 2 — the keystroke→echo calibration, and the rollback criterion.
 *
 * This is the one measurement that can invalidate the design rather than merely confirm it, so
 * it runs first and its decision rule is evaluated explicitly in the output.
 */
async function step2(branch: Tower, ws: string, root: string): Promise<void> {
  section('STEP 2 — keystroke→echo calibration, and the rollback criterion');

  note('measured on the REAL client path: terminal WebSocket → PtySession.handleUserInput →');
  note('write() → PTY → app repaint → ring → WebSocket. One clock, no polling interval.');
  note(`the constant under test is INPUT_SETTLE_BEFORE_WRITE_MS = ${INPUT_SETTLE_MS}ms`);

  const SAMPLES = 40;
  const combos: Array<{ label: string; harness: 'claude' | 'codex'; persistent: boolean }> = [
    { label: 'claude, shellper-backed', harness: 'claude', persistent: true },
    { label: 'claude, local pty', harness: 'claude', persistent: false },
    { label: 'codex,  shellper-backed', harness: 'codex', persistent: true },
    { label: 'codex,  local pty', harness: 'codex', persistent: false },
  ];

  const all: number[] = [];
  const perCombo: Array<{ label: string; st: Stats }> = [];

  for (const combo of combos) {
    const shim = makeRepaintShim(root, combo.harness);
    const agent = `cal-${combo.harness}-${combo.persistent ? 'shellper' : 'local'}`;
    let termId: string;
    try {
      termId = await registerTerminal(branch, ws, agent, shim, combo.persistent);
    } catch (err) {
      // A terminal that will not register is not a measurement, and inventing one would be
      // worse than having none. The non-persistent path in particular fails INSIDE the Tower
      // process with `nodePty.spawn is not a function` — reproduced identically against a build
      // of this branch's merge-base, so it is pre-existing and outside this issue. Recorded as
      // a skip with its reason rather than fixed here (an unrelated red is not this branch's to
      // turn green) or quietly dropped.
      skip(`calibration: ${combo.label}`, String(err).split('\n')[0]);
      continue;
    }
    const term = await openTerminal(branch, termId);
    const samples: number[] = [];
    try {
      for (let i = 0; i < SAMPLES; i++) {
        // A distinct printable character per sample, so an echo can only be matched to the
        // keystroke that produced it — never to a repaint left over from the previous one.
        const ch = String.fromCharCode(0x41 + (i % 26));
        const sinceIdx = term.chunks.length;
        const sentAt = term.send(ch);
        const echoAt = await term.waitFor((text) => text.includes(ch), sinceIdx, 5000);
        if (echoAt !== null) samples.push(echoAt - sentAt);
        await sleep(25); // let the repaint drain so samples do not queue behind each other
      }
    } finally {
      term.close();
    }
    if (samples.length === 0) {
      skip(`calibration: ${combo.label}`, 'no echo ever returned — the shim did not come up');
      continue;
    }
    const st = stats(samples);
    perCombo.push({ label: combo.label, st });
    all.push(...samples);
    printStats(combo.label, st);
    check(samples.length >= SAMPLES * 0.9, `${combo.label}: collected a full sample set`,
      `${samples.length}/${SAMPLES}`);
  }

  if (all.length === 0) {
    skip('STEP 2 rollback criterion', 'no samples collected at all');
    return;
  }

  const overall = stats(all);
  console.log('');
  printStats('ALL COMBOS POOLED', overall);

  // ---- the decision rule, evaluated in the open
  console.log('');
  console.log('  ROLLBACK CRITERION (from the plan\'s Test Plan, step 2):');
  console.log(`    p99 <= ${INPUT_SETTLE_MS}ms                → keep the constant`);
  console.log(`    p99 >  ${INPUT_SETTLE_MS}ms                → raise it to p99 + margin`);
  console.log('    ...and if that would exceed ~500ms → adopt the bounded `lastInputAt > lastDataAt`');
  console.log('       refinement instead of a larger constant, and RE-OPEN the plan.');
  const worstP99 = Math.max(...perCombo.map((c) => c.st.p99));
  console.log(`\n    worst per-combo p99 = ${ms(worstP99)}  (pooled p99 = ${ms(overall.p99)})`);
  if (worstP99 > INPUT_SETTLE_MS) {
    console.log(`    → CRITERION FIRED at the proxy floor. The constant is too small even here.`);
  } else if (worstP99 > INPUT_SETTLE_MS * 0.5) {
    console.log(`    → criterion not fired, but the MARGIN IS THIN (>50% of the budget at a`);
    console.log(`      lower bound). A real harness could cross it; see the caveat below.`);
  } else {
    console.log(`    → criterion NOT fired: the whole distribution sits far inside the budget.`);
  }
  check(worstP99 <= INPUT_SETTLE_MS,
    `every combo's p99 keystroke→echo gap is within the ${INPUT_SETTLE_MS}ms settle`,
    `worst p99 ${ms(worstP99)}`);

  console.log('');
  note('CAVEAT, stated because it bounds what this number proves: the fixture is a repaint');
  note('shim, not claude or codex. It pays a real process boundary, a real PTY and a real');
  note('full-composer redraw, but a real harness runs a heavier render on top — so these are a');
  note('LOWER BOUND. The criterion is evaluated at the floor above; confirming it against the');
  note('actual harnesses is listed under WHAT STILL NEEDS A HUMAN.');
}

// ================================================================ STEP 5 + 6

interface LatencyRun { sendToWire: number; response: SendResult; trace: Array<RowState & { at: number }> }

/**
 * Send and measure the gap from the request leaving this process to the body appearing on the
 * terminal's own WebSocket — the operator-visible latency, end to end.
 */
async function measureDelivery(
  t: Tower, ws: string, agent: string, term: TermClient, body: string, traceMs = 6000,
): Promise<LatencyRun> {
  const sinceIdx = term.chunks.length;
  const t0 = performance.now();
  const response = await send(t, ws, agent, body);
  const rowId = String(response.body.mailboxId ?? '');
  const [arrivedAt, trace] = await Promise.all([
    term.waitFor((text) => text.includes(body), sinceIdx, traceMs),
    rowId ? traceRow(t.dbName, rowId, traceMs) : Promise.resolve([]),
  ]);
  return { sendToWire: arrivedAt === null ? Number.NaN : arrivedAt - t0, response, trace };
}

function printTrace(trace: Array<RowState & { at: number }>): void {
  for (const s of trace) {
    console.log(`      +${s.at.toFixed(0).padStart(5)}ms  status=${s.status.padEnd(9)} ` +
      `reason=${String(s.reason).padEnd(11)} detail=${String(s.detail)}`);
  }
}

/** Manual step 5 — delivery lands on the ~300ms re-drain, not the 1.5s backstop. */
async function step5(t: Tower, ws: string, agent: string, termId: string, term: TermClient): Promise<void> {
  section('STEP 5 — after input stops, delivery lands on the re-drain, not the backstop');

  note('the keystroke below goes over the terminal\'s own WebSocket — the real human input');
  note('path. It is a Right-arrow on purpose: it counts as input, but it changes only the');
  note('cursor, so the composer stays CLEAN and the input signal is the ONLY thing holding the');
  note('row. A printable character would leave a draft and hold `user-text`, which is the OLD');
  note('guard and would prove nothing about this issue.');

  // ---- (a) the isolated re-drain: output already settled, input deliberately not.
  //
  // The two settles run concurrently from the same keystroke (its echo is output), and the
  // input one is the longer. Waiting just past the OUTPUT window and no further is what leaves
  // the input settle as the sole remaining gate — so the hold this observes can only be the new
  // one, and the recovery can only be the re-drain.
  await paint(t, termId, CLEAN_COMPOSER);
  console.log('\n  (a) send arriving while ONLY the input settle is outstanding');
  term.send(ARROW_RIGHT);
  await sleep(OUTPUT_SETTLE_MS + 15);
  const isolated = await measureDelivery(t, ws, agent, term, 'STEP5-REDRAIN-BODY');

  console.log(`      send response: held=${String(isolated.response.body.held)} ` +
    `reason=${String(isolated.response.body.reason)} detail=${String(isolated.response.body.detail)}`);
  console.log('      row state transitions:');
  printTrace(isolated.trace);
  console.log(`      send → body on the wire: ${ms(isolated.sendToWire)}`);

  const sawInputHold = isolated.response.body.detail === 'recent-input'
    || isolated.trace.some((st) => st.detail === 'recent-input');
  check(sawInputHold, 'the row was observably held on `recent-input` — the new gate fired');
  check(Number.isFinite(isolated.sendToWire), 'the body reached the terminal');
  // Assert against the QUIESCENCE debounce, not merely the backstop. "Faster than 1.5s" would
  // pass even if the quiescence trigger were doing all the work — which is exactly what an
  // earlier run of this script showed, and it is how the request path's missing re-drain was
  // found. The remaining input settle here is ~35ms, so a re-drain recovery lands an order of
  // magnitude inside the ~235ms the quiescence path would have taken.
  const quiescenceWouldBe = QUIESCENCE_DEBOUNCE_MS - (OUTPUT_SETTLE_MS + 15);
  console.log(`      what the quiescence trigger alone would have cost: ~${ms(quiescenceWouldBe)}`);
  check(isolated.sendToWire < quiescenceWouldBe,
    'it was recovered by the RE-DRAIN specifically — faster than quiescence could have been',
    `${ms(isolated.sendToWire)} < ~${ms(quiescenceWouldBe)}`);
  check(isolated.sendToWire < BACKSTOP_INTERVAL_MS,
    'and far inside the backstop interval it replaces',
    `${ms(isolated.sendToWire)} < ${BACKSTOP_INTERVAL_MS}ms`);

  // ---- (b) the whole user-visible story: a keystroke, then a send, with no pause at all.
  console.log('\n  (b) send arriving IMMEDIATELY after the keystroke (both settles outstanding)');
  await paint(t, termId, CLEAN_COMPOSER);
  term.send(ARROW_RIGHT);
  const immediate = await measureDelivery(t, ws, agent, term, 'STEP5-IMMEDIATE-BODY');
  console.log('      row state transitions:');
  printTrace(immediate.trace);
  console.log(`      send → body on the wire: ${ms(immediate.sendToWire)}`);
  console.log(`      the backstop interval it must beat: ${BACKSTOP_INTERVAL_MS}ms`);
  check(Number.isFinite(immediate.sendToWire), 'the body reached the terminal');
  check(immediate.sendToWire < BACKSTOP_INTERVAL_MS,
    'a keystroke immediately followed by a send still delivers inside one backstop period',
    ms(immediate.sendToWire));
}

/**
 * Manual step 6 — an idle terminal still delivers promptly, measured as a DELTA against main.
 *
 * Two sub-measurements, because they answer different questions and only one of them is the
 * "no regression on the common path" claim:
 *
 *   (a) IDLE — the terminal has been quiet past both settles before the send. This is the
 *       common path, and the delta against main is the regression test.
 *   (b) FRESHLY PAINTED — a send that arrives while the screen is still warm. This is where
 *       the branch pays for the new guard, and it is reported rather than hidden.
 */
async function step6(
  branch: { t: Tower; ws: string; agent: string; termId: string; term: TermClient },
  main: { t: Tower; ws: string; agent: string; termId: string; term: TermClient } | null,
): Promise<void> {
  section('STEP 6 — the common path, as a delta against the merge-base');

  const idle = async (side: { t: Tower; ws: string; agent: string; termId: string; term: TermClient }, tag: string) => {
    await paint(side.t, side.termId, CLEAN_COMPOSER);
    // Quiet past BOTH settles, so this is genuinely the idle-prompt case.
    await sleep(INPUT_SETTLE_MS + OUTPUT_SETTLE_MS + 200);
    return measureDelivery(side.t, side.ws, side.agent, side.term, `STEP6-IDLE-${tag}`);
  };
  const warm = async (side: { t: Tower; ws: string; agent: string; termId: string; term: TermClient }, tag: string) => {
    // Genuinely fresh: a short mirror-catch-up pause and nothing more, so the send arrives
    // while the terminal is still inside both settle windows. (The default `paint` wait is
    // longer than either, which would quietly turn this into a second copy of the idle case.)
    await paint(side.t, side.termId, CLEAN_COMPOSER, 60);
    return measureDelivery(side.t, side.ws, side.agent, side.term, `STEP6-WARM-${tag}`);
  };

  console.log('\n  (a) IDLE terminal — the common path');
  const branchIdle = await idle(branch, 'B');
  console.log(`      branch: ${ms(branchIdle.sendToWire)}  ` +
    `(response delivered=${String(branchIdle.response.body.delivered)})`);
  check(Number.isFinite(branchIdle.sendToWire), 'branch: an idle terminal still receives the body');

  if (main) {
    const mainIdle = await idle(main, 'M');
    console.log(`      main:   ${ms(mainIdle.sendToWire)}  ` +
      `(response delivered=${String(mainIdle.response.body.delivered)})`);
    const delta = branchIdle.sendToWire - mainIdle.sendToWire;
    console.log(`      delta:  ${delta >= 0 ? '+' : ''}${ms(delta)}`);
    check(delta < INPUT_SETTLE_MS,
      'branch adds less than one settle to the idle common path — no regression there',
      `${delta >= 0 ? '+' : ''}${ms(delta)}`);
  } else {
    skip('STEP 6 idle delta vs baseline', 'no baseline build — set PIR1473_BASELINE_DIST');
  }

  console.log('\n  (b) FRESHLY-PAINTED terminal — where the branch pays for the guard');
  const branchWarm = await warm(branch, 'B');
  console.log(`      branch: ${ms(branchWarm.sendToWire)}  ` +
    `held-first=${String(branchWarm.response.body.held)} detail=${String(branchWarm.response.body.detail)}`);
  if (main) {
    const mainWarm = await warm(main, 'M');
    console.log(`      main:   ${ms(mainWarm.sendToWire)}  held-first=${String(mainWarm.response.body.held)}`);
    const delta = branchWarm.sendToWire - mainWarm.sendToWire;
    console.log(`      delta:  ${delta >= 0 ? '+' : ''}${ms(delta)}`);
    note('this is the disclosed cost of the change, not a defect: a send arriving within one');
    note('settle of terminal input now waits for that input to settle before it writes.');
  }
  check(Number.isFinite(branchWarm.sendToWire), 'branch: a freshly-painted terminal still receives the body');
}

// ================================================================ STEP 7

/**
 * Manual step 7 — the operator bypasses still behave, and the delayed `^C` now counts as input.
 *
 * The second half is a PREDICTION the plan made and this is where it is checked: the delayed
 * interrupt fires UNATTENDED, writes `^C` through the external path, and therefore now moves
 * the input signal — so the drain nudge that follows it holds `recent-input`, and the re-drain
 * is what recovers the body. If that were wrong, the body would sit until the backstop.
 */
async function step7(t: Tower, ws: string, agent: string, termId: string, term: TermClient): Promise<void> {
  section('STEP 7 — operator bypasses, and the delayed ^C as an input source');

  // ---- immediate --interrupt still writes through
  await paint(t, termId, CLEAN_COMPOSER);
  await sleep(INPUT_SETTLE_MS + 200);
  let sinceIdx = term.chunks.length;
  const interrupt = await send(t, ws, agent, 'STEP7-INTERRUPT-BODY', { interrupt: true });
  const interruptLanded = await term.waitFor((x) => x.includes('STEP7-INTERRUPT-BODY'), sinceIdx, 8000);
  console.log(`  --interrupt → status=${interrupt.status} delivered=${String(interrupt.body.delivered)} ` +
    `degraded=${String(interrupt.body.degraded ?? false)}`);
  check(interruptLanded !== null, '--interrupt still writes its body through (the explicit bypass)');
  check(term.textSince(sinceIdx).includes('\x03'), 'and the ^C reached the terminal ahead of it');

  // ---- --escape still writes through
  await paint(t, termId, CLEAN_COMPOSER);
  await sleep(INPUT_SETTLE_MS + 200);
  sinceIdx = term.chunks.length;
  const escape = await send(t, ws, agent, 'STEP7-ESCAPE-BODY', { escape: true });
  // `--escape` writes a bare ESC (plus its trailing Enter) and returns — it never writes the
  // message body at all, and its response carries no `delivered` field. So the assertion is
  // that the ESC reached the terminal, not that a body did. (An earlier revision of this script
  // asserted the body and "failed"; the script was wrong, not the code.)
  const escLanded = await term.waitFor((x) => x.includes(ESC), sinceIdx, 8000);
  console.log(`  --escape    → status=${escape.status} (bare ESC + Enter; no body, by design)`);
  check(escape.status === 200, '--escape still returns 200');
  check(escLanded !== null, 'and its ESC keystroke reached the terminal');

  // ---- the delayed ^C: fires unattended, counts as input, re-drain recovers the body
  await paint(t, termId, CLEAN_COMPOSER);
  await sleep(INPUT_SETTLE_MS + 200);
  sinceIdx = term.chunks.length;
  const t0 = performance.now();
  const delayed = await send(t, ws, agent, 'STEP7-DELAYED-BODY', { interrupt: true, deliverAfter: 1 });
  const rowId = String(delayed.body.mailboxId ?? '');
  console.log(`  --interrupt --delay 1 → scheduled=${String(delayed.body.scheduled)} row=${rowId.slice(0, 8)}…`);

  const [landedAt, trace] = await Promise.all([
    term.waitFor((x) => x.includes('STEP7-DELAYED-BODY'), sinceIdx, 12_000),
    rowId ? traceRow(t.dbName, rowId, 12_000) : Promise.resolve([]),
  ]);
  console.log('  row state transitions:');
  printTrace(trace);
  check(landedAt !== null, 'the delayed body eventually reached the terminal');
  if (landedAt !== null) {
    console.log(`  send → body on the wire: ${ms(landedAt - t0)} (of which ~1000ms is the requested delay)`);
  }
  const sawInputHold = trace.some((s) => s.detail === 'recent-input');
  check(sawInputHold,
    'the unattended ^C was OBSERVED as input — the drain nudge right after it held `recent-input`');
  check(trace.some((s) => s.status === 'delivered'),
    'and the body still delivered, so the hold was recovered rather than sticking');
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  console.log('PIR #1473 — dev-approval evidence (render gate: the gate→write input race)');
  console.log(`isolated Towers on ports ${PORT} (branch) / ${MAIN_PORT} (baseline) — NOT ${LIVE_TOWER_PORT}`);
  console.log(`branch build: ${TOWER}`);
  console.log(`baseline build: ${BASELINE_TOWER || '(none — set PIR1473_BASELINE_DIST; deltas will SKIP)'}`);
  console.log(`started: ${new Date().toISOString()}`);

  const liveBefore = await portListening(LIVE_TOWER_PORT);
  console.log(`live Tower on ${LIVE_TOWER_PORT} before: ${liveBefore ? 'LISTENING' : 'not running'}`);

  const haveMain = BASELINE_TOWER !== '' && existsSync(BASELINE_TOWER);
  if (!haveMain) {
    console.log('\nWARNING: no baseline build available, so every delta will SKIP.');
    console.log('         Set PIR1473_BASELINE_DIST — see BASELINE_DIST for how to make one.');
  }

  const root = mkdtempSync(resolve(AGENT_FARM_DIR, 'test-workspaces', 'pir1473-'));
  const socketDir = join(root, 'run');
  mkdirSync(socketDir, { recursive: true });

  let branch: Tower | null = null;
  let mainTower: Tower | null = null;
  const clients: TermClient[] = [];

  try {
    resetTestDb(`test-1473-${PORT}.db`);
    branch = await startTower({ port: PORT, tower: TOWER, dbName: `test-1473-${PORT}.db`, socketDir, which: 'branch' });
    const ws = makeWorkspace(root);
    await activate(branch, ws);
    console.log(`\nworkspace: ${ws}`);

    const only = process.env.PIR1473_ONLY ? new Set(process.env.PIR1473_ONLY.split(',')) : null;
    const wanted = (n: string): boolean => !only || only.has(n);
    if (only) console.log(`\n(PIR1473_ONLY=${process.env.PIR1473_ONLY} — PARTIAL RUN, not evidence)`);

    if (wanted('2')) await step2(branch, ws, root);

    // The delivery steps use the echo shim, so the classified screen is exactly what we paint.
    const echoShim = makeEchoShim(root, 'claude');
    const agent = 'pir-1473-probe';
    const termId = await registerTerminal(branch, ws, agent, echoShim, true);
    const term = await openTerminal(branch, termId);
    clients.push(term);
    console.log(`\ndelivery terminal: ${termId} (real shellper-backed PTY running the echo shim)`);

    let mainSide: { t: Tower; ws: string; agent: string; termId: string; term: TermClient } | null = null;
    if (haveMain && (wanted('6'))) {
      resetTestDb(`test-1473-${MAIN_PORT}.db`);
      mainTower = await startTower({
        port: MAIN_PORT, tower: BASELINE_TOWER, dbName: `test-1473-${MAIN_PORT}.db`,
        socketDir: join(root, 'run-main'), which: 'main',
      });
      mkdirSync(join(root, 'run-main'), { recursive: true });
      const mws = makeWorkspace(root);
      await activate(mainTower, mws);
      const mTermId = await registerTerminal(mainTower, mws, agent, echoShim, true);
      const mTerm = await openTerminal(mainTower, mTermId);
      clients.push(mTerm);
      mainSide = { t: mainTower, ws: mws, agent, termId: mTermId, term: mTerm };
      console.log(`main-build terminal: ${mTermId}`);
    }

    if (wanted('5')) await step5(branch, ws, agent, termId, term);
    if (wanted('6')) await step6({ t: branch, ws, agent, termId, term }, mainSide);
    if (wanted('7')) await step7(branch, ws, agent, termId, term);

    section('WHAT STILL NEEDS A HUMAN (not simulated, not inferred, NOT marked done)');
    console.log(`
  STEP 1 — reply-traffic measurement, 60s, hands OFF the keyboard, agent running.
           Log every handleUserInput chunk plus what the filter strips vs keeps.
           Expected: zero surviving residue. If replies still get through, nothing
           downstream of it is trustworthy.
           Run it in a BROWSER and again in the VS CODE INTEGRATED TERMINAL (a different
           xterm build, and the one surface whose reply set may differ).
           NOT against 'afx attach': it talks to the shellper socket directly and never
           touches PtySession, so it would log zero chunks and read as a FALSE PASS.

  STEP 2 (confirmation half) — re-run the keystroke→echo measurement against REAL claude
           and codex. The scripted figures above are a lower bound from a repaint proxy;
           the rollback criterion's decisive evaluation needs the real harnesses.

  STEP 3 — mouse: click into a builder's composer mid-'afx send' → the message must hold.
           This is the assertion that would have FAILED under plan revision 2, which
           stripped mouse reports out of the input signal.

  STEP 4 — 'afx send' while typing into the target's composer → holds, the draft is
           untouched, and 'afx inbox' shows busy:recent-input. ~10x at different points
           in the keystroke stream.
`);

    section('LIVE TOWER UNTOUCHED');
    const liveAfter = await portListening(LIVE_TOWER_PORT);
    console.log(`  live Tower on ${LIVE_TOWER_PORT} after: ${liveAfter ? 'LISTENING' : 'not running'}`);
    check(liveAfter === liveBefore, `the live Tower on ${LIVE_TOWER_PORT} is exactly as it was`);

    section('RESULT');
    console.log(`  ${checks - failures}/${checks} checks passed`);
    if (skips.length) console.log(`  ${skips.length} skipped: ${skips.join('; ')}`);
    console.log(failures === 0 ? '  ALL EXECUTED CHECKS PASSED' : `  ${failures} FAILED`);
    console.log('\n  NOTE: this covers the SCRIPTABLE half of the gate. The four human steps');
    console.log('        above are outstanding and are not claimed by this run.');
  } finally {
    for (const c of clients) c.close();
    if (branch) await stopTower(branch);
    if (mainTower) await stopTower(mainTower);
    rmSync(root, { recursive: true, force: true });
  }
  process.exit(failures === 0 ? 0 : 1);
}

void main();
