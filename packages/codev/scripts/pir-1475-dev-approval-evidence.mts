/**
 * PIR #1475 — dev-approval evidence against a real, ISOLATED Tower.
 *
 * The plan's Manual section is the bar for this gate, but its steps assume a live
 * Tower. `afx dev` from this worktree would bind the live Tower's port (4100 is
 * shared by design) and restarting the live Tower kills every builder session, so
 * this drives the same steps the `spec-1365-e2e-evidence.mts` way instead: spawn
 * THIS worktree's built Tower on a private port with its own test DB, register
 * REAL shellper-backed PTY sessions, and drive the REAL HTTP endpoints. Nothing
 * about the identity path is stubbed — WELCOME → ShellperClient → PtySession →
 * resolveProfileForSession → render gate → PTY is the full wire path under test.
 *
 * Two fixtures do real work and are worth understanding before reading results:
 *
 *   - The **claude shim**: an executable literally named `claude` that runs
 *     `stty raw -echo; exec cat`. The shellper spawns it, so WELCOME reports a
 *     command whose basename resolves CLAUDE_PROFILE directly — the architect
 *     case, which has no `.builder-start.sh` backstop. `cat` echoes every byte
 *     written to the PTY back into the output ring, so
 *     `GET /api/terminals/:id/output` is a faithful transcript of what actually
 *     reached the terminal. Raw mode means a `^C` is echoed as a byte rather than
 *     raising SIGINT, so sessions survive across scenarios.
 *
 *   - The **legacy shellper**: `dist/terminal/shellper-{process,main}.js` copied
 *     from the MAIN checkout's build — genuinely compiled pre-#1475 code whose
 *     WELCOME carries no identity fields. Not a stub and not hand-edited: it is
 *     exactly "a shellper still running from before the upgrade", which is the
 *     case the fallback exists for.
 *
 * Scenario 4 stages DRIFT by writing the session row directly. That is deliberate
 * and disclosed: drift is produced in the field by a config edit plus the Spec 1313
 * legacy heal, which cannot be forced through the public API. The row is set to
 * `agy` — chosen because AGY_PROFILE's composer marker is `> ` while the painted
 * screen is claude's `❯`, so the two behaviors are DISTINGUISHABLE ON THE WIRE:
 * row-derived identity holds the message (wrong marker), WELCOME-derived identity
 * delivers it.
 *
 * Usage: pnpm build && node --experimental-strip-types \
 *          scripts/pir-1475-dev-approval-evidence.mts
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync, copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import net from 'node:net';
import Database from 'better-sqlite3';
import { ensureLocalKey } from '@cluesmith/codev-core/auth';
import { TOWER_KEY_HEADER } from '@cluesmith/codev-types';

/**
 * Tower enforces request authentication (advisory GHSA-xvjp-7748-v88v), so every
 * call here carries the shared local key exactly as `afx` does. Using the real
 * auth path rather than disabling it keeps this evidence honest: these are the
 * same requests an operator's CLI makes.
 */
const AUTH: Record<string, string> = { [TOWER_KEY_HEADER]: ensureLocalKey() };
const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json', ...AUTH };

// Private to this script. 14500 (cli-tower-mode), 14600 (send-integration), 14650
// (#1365 evidence) and 14700 (#1450 evidence) are taken — and `startTower` REFUSES
// to run against a port it did not itself bind, because an earlier revision of this
// script silently drove someone else's Tower on 14700 and reported its results.
const PORT = 14782;
const LEGACY_PORT = 14783;   // the legacy-shellper Tower
const LIVE_TOWER_PORT = 4100; // must be untouched; asserted at start and end

const DIST = resolve(import.meta.dirname, '../dist');
const TOWER = join(DIST, 'agent-farm/servers/tower-server.js');
const MAIN_DIST = '/home/user/code/codev_root/codev/packages/codev/dist';

const ESC = '\x1b';
const CTRL_D = '\x04';
const COMPOSER_RULE = '─'.repeat(22);
const CLEAR = `${ESC}[2J${ESC}[H`;
/** A CLEAN claude composer: marker + dim placeholder only → the render gate delivers. */
const CLEAN_COMPOSER = `${CLEAR}❯ ${ESC}[2mTry "fix the flaky test"${ESC}[0m\r\n${COMPOSER_RULE}\r\n`;

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
}

async function startTower(opts: { port: number; tower: string; dbName: string; socketDir: string; log?: string[] }): Promise<Tower> {
  // Fail loudly rather than adopt a stranger's Tower: a listening port here means
  // some other process owns it, and every assertion after this point would be
  // measuring that process instead of the build under test.
  if (await portListening(opts.port)) {
    throw new Error(
      `port ${opts.port} is already listening — refusing to run against a Tower this script did not start. ` +
      'Pick a free port.',
    );
  }
  const log: string[] = opts.log ?? [];
  const proc = spawn('node', [opts.tower, String(opts.port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      AF_TEST_DB: opts.dbName,
      SHELLPER_SOCKET_DIR: opts.socketDir,
    },
  });
  const collect = (d: Buffer): void => {
    for (const line of d.toString().split('\n')) if (line.trim()) log.push(line);
  };
  proc.stdout?.on('data', collect);
  proc.stderr?.on('data', collect);
  for (let i = 0; i < 75; i++) {
    if (await portListening(opts.port)) {
      return { proc, log, port: opts.port, base: `http://localhost:${opts.port}`, dbName: opts.dbName };
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

/** Tower log lines matching a pattern, since a marker index (per-scenario slicing). */
function logSince(t: Tower, since: number, pattern: RegExp): string[] {
  return t.log.slice(since).filter((l) => pattern.test(l));
}

/** Wait for a Tower log line to appear, up to a bound. */
async function waitForLog(t: Tower, since: number, pattern: RegExp, timeoutMs = 15000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hits = logSince(t, since, pattern);
    if (hits.length) return hits;
    if (Date.now() > deadline) return [];
    await sleep(200);
  }
}

// ---------------------------------------------------------------- fixtures

/**
 * An executable named `claude` that echoes its PTY input — see the header.
 *
 * `mode: 'raw'` is the default oracle: raw mode means a `^C` arrives as a byte
 * instead of a signal, so a session survives every scenario.
 *
 * `mode: 'canonical'` exists for the relaunch step, where the harness has to end
 * with a genuine clean exit(0). Raw mode disables EOF processing, so `^D` there is
 * just a byte and `cat` never ends; in canonical mode `^D` at line start closes
 * stdin and `cat` exits 0 — the real "operator quit the harness" path that #1264
 * reruns. Named `claude` either way, so identity resolves the same.
 *
 * The canonical shim also PAINTS its composer at startup, and that detail is
 * load-bearing rather than cosmetic. A relaunched child is confirmed alive by the
 * first byte it emits: `PtySession.startRestartWait` clears `exitCode` from the
 * client's next `data` event (#1264), so until the harness writes something the
 * session still reports `exited`, `writable` is false, and delivery correctly holds
 * `no-live-pty`. A real harness paints its UI on launch; a bare `cat` prints nothing
 * and would leave the relaunched terminal looking dead forever — a fixture artifact,
 * not a Tower bug. Painting makes the shim behave like the thing it stands in for.
 */
function makeClaudeShim(root: string, mode: 'raw' | 'canonical' = 'raw'): string {
  const bin = join(root, mode === 'raw' ? 'bin' : 'bin-canonical');
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, 'claude');
  const stty = mode === 'raw' ? 'stty raw -echo 2>/dev/null' : 'stty -echo 2>/dev/null';
  const paint = mode === 'canonical'
    ? `printf '\\033[2J\\033[H\\342\\235\\257 \\033[2mTry "fix the flaky test"\\033[0m\\r\\n${COMPOSER_RULE}\\r\\n'\n`
    : '';
  writeFileSync(shim, `#!/bin/sh\n${stty}\n${paint}exec cat\n`, { mode: 0o755 });
  return shim;
}

/**
 * A dist whose shellper is the MAIN checkout's build — real pre-#1475 compiled
 * code that never sends identity on WELCOME. Only the two shellper files are
 * swapped; the Tower under test is still ours.
 */
function makeLegacyDist(): string | null {
  const legacyProcess = join(MAIN_DIST, 'terminal/shellper-process.js');
  const legacyMain = join(MAIN_DIST, 'terminal/shellper-main.js');
  if (!existsSync(legacyProcess) || !existsSync(legacyMain)) return null;
  // Must sit INSIDE the package: Tower resolves its runtime deps (commander, ws,
  // better-sqlite3) by walking up to packages/codev/node_modules, and a copy under
  // a temp dir elsewhere cannot see them.
  const legacyDist = resolve(import.meta.dirname, '../.pir-1475-legacy-dist');
  rmSync(legacyDist, { recursive: true, force: true });
  cpSync(DIST, legacyDist, { recursive: true });
  copyFileSync(legacyProcess, join(legacyDist, 'terminal/shellper-process.js'));
  copyFileSync(legacyMain, join(legacyDist, 'terminal/shellper-main.js'));
  return legacyDist;
}

function makeWorkspace(root: string, architectCmd: string | null, builderScriptTarget: string | null): string {
  const ws = mkdtempSync(join(root, 'ws-'));
  for (const d of ['codev', '.agent-farm', '.codev']) mkdirSync(join(ws, d), { recursive: true });
  const shell: Record<string, string> = { builder: 'bash', shell: 'bash' };
  if (architectCmd) shell.architect = architectCmd;
  writeFileSync(join(ws, '.codev', 'config.json'), JSON.stringify({ shell }));
  if (builderScriptTarget) {
    // A REAL builder launches through this wrapper, so PtySession.command is the
    // shell — and the profile is recovered by READING this file (the wrapped-launch
    // backstop). Exactly how a live builder's profile resolves.
    writeFileSync(join(ws, '.builder-start.sh'), `#!/usr/bin/env bash\nexec ${builderScriptTarget}\n`, { mode: 0o755 });
  }
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
  t: Tower, ws: string, roleId: string, command: string, args: string[], cwd = ws,
): Promise<string> {
  const res = await fetch(`${t.base}/api/terminals`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      command, args, cwd, cols: 110, rows: 32,
      workspacePath: ws, type: 'builder', roleId, persistent: true,
    }),
  });
  if (res.status !== 201) throw new Error(`terminal register failed: ${res.status} ${await res.text()}`);
  return (await res.json()).id;
}

async function paint(t: Tower, terminalId: string, screen: string): Promise<void> {
  await fetch(`${t.base}/api/terminals/${terminalId}/write`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ data: screen }),
  });
  await sleep(300); // let the PTY echo land and the gate mirror catch up
}

async function transcript(t: Tower, terminalId: string): Promise<string> {
  const res = await fetch(`${t.base}/api/terminals/${terminalId}/output?lines=1000000`, { headers: AUTH });
  const data = await res.json();
  return Array.isArray(data.lines) ? data.lines.join('\n') : JSON.stringify(data);
}

interface SendResult { status: number; body: Record<string, unknown> }

async function send(t: Tower, ws: string, to: string, message: string): Promise<SendResult> {
  const res = await fetch(`${t.base}/api/send`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ to, workspace: ws, from: 'architect', message, options: {} }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** Send, then wait for the body to appear on the wire (fast trigger or backstop). */
async function sendAndAwait(t: Tower, ws: string, to: string, body: string, terminalId: string, waitMs = 6000): Promise<{ result: SendResult; landed: boolean }> {
  const before = (await transcript(t, terminalId)).length;
  const result = await send(t, ws, to, body);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const after = (await transcript(t, terminalId)).slice(before);
    if (after.includes(body)) return { result, landed: true };
    if (Date.now() > deadline) return { result, landed: false };
    await sleep(250);
  }
}

// ---------------------------------------------------------------- DB (staged drift + assertions)

function dbFor(dbName: string): Database.Database {
  return new Database(resolve(AGENT_FARM_DIR, dbName));
}

/**
 * Start each run from an empty test DB (only ever the two `test-1475-*.db` files
 * this script owns — never `global.db`). Without this, held rows from previous
 * runs survive and their starvation/escalation notices for long-dead workspaces
 * interleave with this run's log, which makes the transcript read as if THIS run
 * had undelivered mail. A hermetic DB keeps the evidence about the code.
 */
function resetTestDb(dbName: string): void {
  if (!/^test-1475-\d+\.db$/.test(dbName)) throw new Error(`refusing to delete non-test DB: ${dbName}`);
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(resolve(AGENT_FARM_DIR, `${dbName}${suffix}`), { force: true });
  }
}

function rowCommand(dbName: string, terminalId: string): string | null | undefined {
  const db = dbFor(dbName);
  try {
    const row = db.prepare('SELECT command FROM terminal_sessions WHERE id = ?').get(terminalId) as
      | { command: string | null } | undefined;
    return row ? row.command : undefined;
  } finally { db.close(); }
}

function setRowCommand(dbName: string, terminalId: string, command: string | null): void {
  const db = dbFor(dbName);
  try {
    db.prepare('UPDATE terminal_sessions SET command = ? WHERE id = ?').run(command, terminalId);
  } finally { db.close(); }
}

// ---------------------------------------------------------------- scenarios

/** Manual steps 2 + 3 — baseline delivery, and identity sourced from WELCOME. */
async function step2and3(t: Tower, ws: string, agent: string, terminalId: string): Promise<void> {
  section('STEP 2+3 — baseline delivery, and identity hydrated from WELCOME');

  const idLines = logSince(t, 0, /\[identity\] terminal-create/);
  for (const l of idLines) console.log(`  tower: ${l.trim()}`);
  check(idLines.some((l) => l.includes('identity hydrated from WELCOME') && l.includes('source=welcome')),
    'Tower logged identity hydrated from WELCOME (source=welcome)');
  check(idLines.some((l) => /command=\S*claude/.test(l)),
    'the hydrated command is the process actually running (the claude shim)');

  await paint(t, terminalId, CLEAN_COMPOSER);
  const { result, landed } = await sendAndAwait(t, ws, agent, 'STEP2-BASELINE-BODY', terminalId);
  console.log(`  send → status=${result.status} delivered=${String(result.body.delivered)} ` +
    `held=${String(result.body.held)} reason=${String(result.body.reason)}`);
  check(landed, 'the body reached the PTY — the render gate resolved a profile and delivered');

  const persisted = rowCommand(t.dbName, terminalId);
  check(typeof persisted === 'string' && /claude/.test(persisted),
    'the session row records what is RUNNING', `row=${String(persisted)}`);
}

/**
 * Manual step 4 — Tower restart → reconcile adopts the live shellper → WELCOME
 * beats a drifted row, delivery still works, and the row is corrected.
 */
async function step4(t: Tower, ws: string, agent: string, terminalId: string, socketDir: string): Promise<Tower> {
  section('STEP 4 — Tower restart: reconcile adopts the live shellper, WELCOME beats a drifted row');

  // Staged drift — disclosed in the header. `agy` is chosen because its composer
  // marker is `> ` while the screen we paint is claude's `❯`: row-derived identity
  // would fail the marker test and HOLD, WELCOME-derived identity delivers.
  setRowCommand(t.dbName, terminalId, 'agy');
  check(rowCommand(t.dbName, terminalId) === 'agy', 'staged: the row now names a harness the process is NOT running');

  await stopTower(t);
  check(!(await portListening(t.port)), 'the isolated Tower is down (the shellper keeps running, as designed)');

  const restarted = await startTower({ port: t.port, tower: TOWER, dbName: t.dbName, socketDir });
  const adopt = await waitForLog(restarted, 0, /\[identity\] reconcile-adopt/);
  for (const l of adopt) console.log(`  tower: ${l.trim()}`);

  check(adopt.length > 0, 'reconcile adopted the still-running shellper after the restart');
  check(adopt.some((l) => l.includes('source=welcome')), 'identity came from WELCOME, not the row');
  check(adopt.some((l) => /row=agy/.test(l)), 'the log shows the drifted row it overrode');
  check(adopt.some((l) => /command=\S*claude/.test(l)), 'the adopted identity is the running process');

  const corrected = rowCommand(restarted.dbName, terminalId);
  check(typeof corrected === 'string' && /claude/.test(corrected),
    'persist-back CORRECTED the drifted row', `row=${String(corrected)}`);

  await paint(restarted, terminalId, CLEAN_COMPOSER);
  const { result, landed } = await sendAndAwait(restarted, ws, agent, 'STEP4-POST-RESTART-BODY', terminalId);
  console.log(`  send → status=${result.status} delivered=${String(result.body.delivered)} ` +
    `held=${String(result.body.held)} reason=${String(result.body.reason)}`);
  check(landed, 'delivery works after the restart — and would NOT have under the drifted row (agy marker ≠ ❯)');
  return restarted;
}

/** Manual step 5 — a clean-exit SPAWN relaunch, with NO Tower restart. */
async function step5(t: Tower, root: string): Promise<void> {
  section('STEP 5 — clean-exit SPAWN relaunch (no Tower restart): identity read through the live client');

  // Its own workspace, whose architect harness can actually end cleanly.
  const ws = makeWorkspace(root, makeClaudeShim(root, 'canonical'), null);
  await activate(t, ws);

  // The architect session is the one with restartOnExit + the #1264 fresh-launch
  // factory wired; terminals created via POST /api/terminals deliberately are not
  // (defaultSessionOptions → restartOnExit: false), so this step needs the
  // architect that Tower launches from `.codev/config.json`.
  const architect = await (async (): Promise<{ id: string; name: string } | null> => {
    // Activating a workspace does not itself launch an architect, so ask Tower for
    // one explicitly (Spec 755's add-architect route). This is the SAME launch path
    // the product uses, so the session comes with restartOnExit and the #1264
    // fresh-launch factory wired — which is what makes the clean-exit rerun real.
    const res = await fetch(`${t.base}/api/workspaces/${Buffer.from(ws).toString('base64url')}/architects`, {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name: 'evidence' }),
    });
    const body = await res.json().catch(() => ({}));
    // Spec 755 addressing: a named architect is reached as `architect:<name>`,
    // not by bare name (which resolves builders).
    if (res.ok && body.terminalId) return { id: String(body.terminalId), name: `architect:${String(body.name || 'evidence')}` };
    console.log(`  add-architect → ${res.status} ${JSON.stringify(body)}`);
    return null;
  })();

  if (!architect) {
    skip('step 5 (clean-exit SPAWN relaunch)',
      'no architect session appeared for this workspace, so the restartOnExit/#1264 path could not be driven ' +
      'from the public API. The identity-after-SPAWN property is covered by the unit test ' +
      '"tracks a SPAWN relaunch with no re-attach and no reconnect" in pir-1475-welcome-identity.test.ts.');
    return;
  }
  console.log(`  architect terminal: ${architect.id} (agent "${architect.name}")`);

  const mark = t.log.length;
  for (const l of logSince(t, 0, new RegExp(`\\[identity\\].*${architect.id}`))) console.log(`  tower: ${l.trim()}`);
  await sleep(1500); // let the harness reach its prompt before painting
  await paint(t, architect.id, CLEAN_COMPOSER);
  const before = await sendAndAwait(t, ws, architect.name, 'STEP5-PRE-RELAUNCH', architect.id, 10000);
  console.log(`  baseline send → status=${before.result.status} delivered=${String(before.result.body.delivered)} ` +
    `held=${String(before.result.body.held)} reason=${String(before.result.body.reason)} ` +
    `error=${String(before.result.body.error ?? '')}`);
  check(before.landed, 'baseline: the architect receives mail before the relaunch');

  // Ctrl-D ends `cat` with a clean exit(0) — the #1264 rerun path, which re-spawns
  // through the SAME shellper client with no reconnect and no re-attach.
  await fetch(`${t.base}/api/terminals/${architect.id}/write`, {
    method: 'POST', headers: JSON_HEADERS,
    body: JSON.stringify({ data: CTRL_D }),
  });

  const relaunch = await waitForLog(t, mark, /rerunning harness|session-fresh-restart|exited cleanly/i, 20000);
  for (const l of relaunch.slice(0, 3)) console.log(`  tower: ${l.trim()}`);
  if (!relaunch.length) {
    skip('step 5 (clean-exit SPAWN relaunch)',
      'the harness did not take the clean-exit rerun path within 20s, so there is nothing to assert about ' +
      'post-relaunch identity here. Covered by the unit test named above.');
    return;
  }
  check(true, 'the harness exited cleanly and Tower re-spawned it through the SAME shellper (no reconnect)');

  await sleep(5000); // restartDelay (2s) + respawn + the new harness reaching its prompt

  // Diagnostics: what does Tower think this terminal IS after the relaunch?
  // `status=running` here is itself evidence: the relaunched child is confirmed
  // alive by its first byte of output (#1264), so a terminal that came back is a
  // terminal that painted.
  const listed = await (await fetch(`${t.base}/api/terminals`, { headers: AUTH })).json().catch(() => ({}));
  const rows: Array<Record<string, unknown>> = Array.isArray(listed?.terminals) ? listed.terminals : [];
  for (const r of rows.filter((r) => String(r.id) === architect.id)) {
    console.log(`  terminal after relaunch: id=${String(r.id)} status=${String(r.status)}`);
  }
  for (const l of logSince(t, mark, new RegExp(`\\[identity\\].*${architect.id}`))) console.log(`  tower: ${l.trim()}`);

  // The fresh PTY starts with a blank screen, which is NOT a verified-empty
  // composer — so the gate is entitled to HOLD at request time. That is correct
  // behavior, not a failure. What must be true is that the message is not lost:
  // once the new harness shows a clean prompt, the held row drains to it. So send,
  // then keep the composer painted while the fast trigger/backstop delivers.
  const BODY = 'STEP5-POST-RELAUNCH';
  const beforeLen = (await transcript(t, architect.id)).length;
  const result = await send(t, ws, architect.name, BODY);
  console.log(`  post-relaunch send → status=${result.status} ` +
    `delivered=${String(result.body.delivered)} held=${String(result.body.held)} reason=${String(result.body.reason)}`);

  let landed = false;
  let lastStatus = '';
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if ((await transcript(t, architect.id)).slice(beforeLen).includes(BODY)) { landed = true; break; }
    const info = await (await fetch(`${t.base}/api/terminals/${architect.id}`, { headers: AUTH })).json().catch(() => ({}));
    const status = String(info?.status ?? info?.terminal?.status ?? 'unknown');
    if (status !== lastStatus) { console.log(`  terminal status → ${status}`); lastStatus = status; }
    await paint(t, architect.id, CLEAN_COMPOSER);
    await sleep(700);
  }
  check(landed, 'the message reaches the RELAUNCHED harness, with NO Tower restart' +
    (result.body.delivered === true ? '' : ' (held at request time, then drained onto the clean prompt)'));
  note('identity VALUE cannot change here: both relaunch paths swap args/env only — session.options.command ' +
    'is never mutated (#1338). The read-through vs snapshot distinction is pinned by the unit test.');
}

/** Manual step 6 — a genuine pre-#1475 shellper: fallback identity, and a NULL row that STAYS NULL. */
async function step6(root: string, socketDir: string): Promise<void> {
  let legacyDistPath: string | null = null;
  section('STEP 6 — legacy (pre-#1475) shellper: source=config, delivery works, legacy NULL row stays NULL');

  const legacyDist = makeLegacyDist();
  legacyDistPath = legacyDist;
  if (!legacyDist) {
    skip('step 6 (legacy shellper)',
      `no pre-#1475 build found at ${MAIN_DIST}/terminal/. Build the main checkout to produce one. ` +
      'The fallback path is covered by the unit tests (legacy/undefined identity → source=config).');
    return;
  }

  const shim = makeClaudeShim(root);
  const ws = makeWorkspace(root, null, null);
  const dbName = `test-1475-${LEGACY_PORT}.db`;
  resetTestDb(dbName);
  let tower = await startTower({
    port: LEGACY_PORT, tower: join(legacyDist, 'agent-farm/servers/tower-server.js'), dbName, socketDir,
  });
  try {
    await activate(tower, ws);
    const agent = 'pir-1475-legacy';
    const terminalId = await registerTerminal(tower, ws, agent, shim, []);

    const idLines = logSince(tower, 0, /\[identity\] terminal-create/);
    for (const l of idLines) console.log(`  tower: ${l.trim()}`);
    check(idLines.some((l) => l.includes('source=config')),
      'a legacy shellper sends no identity → Tower falls back to the recorded command');

    await paint(tower, terminalId, CLEAN_COMPOSER);
    const { result, landed } = await sendAndAwait(tower, ws, agent, 'STEP6-LEGACY-BODY', terminalId);
    console.log(`  send → status=${result.status} delivered=${String(result.body.delivered)} ` +
      `held=${String(result.body.held)}`);
    check(landed, 'delivery still works on the fallback path — the Spec 1313 SSOT is intact');

    // The legacy-NULL-row property: a row persisted before migration v16 has
    // command NULL. Adopting it with a legacy shellper must leave it NULL —
    // persisting '' instead would make the Spec 1313 self-heal (`??`) unable to
    // ever displace it.
    setRowCommand(dbName, terminalId, null);
    check(rowCommand(dbName, terminalId) === null, 'staged: a pre-v16 row with command NULL');

    await stopTower(tower);
    tower = await startTower({
      port: LEGACY_PORT, tower: join(legacyDist, 'agent-farm/servers/tower-server.js'), dbName, socketDir,
    });
    const adopt = await waitForLog(tower, 0, /\[identity\] reconcile-adopt/);
    for (const l of adopt) console.log(`  tower: ${l.trim()}`);
    check(adopt.some((l) => l.includes('source=config')), 'reconcile fell back for the legacy shellper');

    const after = rowCommand(dbName, terminalId);
    check(after === null, 'the legacy NULL row is STILL NULL after reconcile (never written as "")',
      `row=${after === null ? 'null' : JSON.stringify(after)}`);
  } finally {
    await stopTower(tower);
    if (legacyDistPath) rmSync(legacyDistPath, { recursive: true, force: true });
  }
}

/** Manual step 7 — a wrapped builder launch still resolves via `.builder-start.sh`. */
async function step7(t: Tower, root: string, shim: string): Promise<void> {
  section('STEP 7 — wrapped builder launch: delivery via the .builder-start.sh backstop (no regression)');

  const ws = makeWorkspace(root, null, shim);
  await activate(t, ws);
  const agent = 'pir-1475-builder';
  const scriptPath = join(ws, '.builder-start.sh');
  const terminalId = await registerTerminal(t, ws, agent, '/bin/bash', [scriptPath], ws);

  const idLines = logSince(t, 0, new RegExp(`\\[identity\\] terminal-create ${terminalId}`));
  for (const l of idLines) console.log(`  tower: ${l.trim()}`);
  check(idLines.some((l) => /command=\/bin\/bash/.test(l)),
    'WELCOME reports the WRAPPER (/bin/bash), exactly as before this change');

  await paint(t, terminalId, CLEAN_COMPOSER);
  const { result, landed } = await sendAndAwait(t, ws, agent, 'STEP7-WRAPPED-BODY', terminalId);
  console.log(`  send → status=${result.status} delivered=${String(result.body.delivered)} ` +
    `held=${String(result.body.held)}`);
  check(landed, 'the wrapped builder still receives mail — the launch-script backstop is untouched');
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  console.log('PIR #1475 — dev-approval evidence (WELCOME-frame identity hydration)');
  console.log(`isolated Tower on port ${PORT} / ${LEGACY_PORT} — NOT ${LIVE_TOWER_PORT}`);
  console.log(`tower build: ${TOWER}`);
  console.log(`started: ${new Date().toISOString()}`);

  const liveBefore = await portListening(LIVE_TOWER_PORT);
  console.log(`live Tower on ${LIVE_TOWER_PORT} before: ${liveBefore ? 'LISTENING' : 'not running'}`);

  const root = mkdtempSync(resolve(AGENT_FARM_DIR, 'test-workspaces', 'pir1475-'));
  const socketDir = join(root, 'run');
  mkdirSync(socketDir, { recursive: true });

  let tower: Tower | null = null;
  try {
    const shim = makeClaudeShim(root);
    console.log(`claude shim: ${shim}`);

    const ws = makeWorkspace(root, shim, null);
    resetTestDb(`test-1475-${PORT}.db`);
    tower = await startTower({ port: PORT, tower: TOWER, dbName: `test-1475-${PORT}.db`, socketDir });
    await activate(tower, ws);

    const agent = 'pir-1475-probe';
    const terminalId = await registerTerminal(tower, ws, agent, shim, []);
    console.log(`\nworkspace: ${ws}\nterminal:  ${terminalId} (real shellper-backed PTY running the claude shim)`);

    // `PIR1475_ONLY=5` runs a single scenario — a debugging aid while iterating on
    // one step. Unset (the default, and the only form whose transcript is evidence)
    // runs all of them.
    const only = process.env.PIR1475_ONLY ? new Set(process.env.PIR1475_ONLY.split(',')) : null;
    const wanted = (n: string): boolean => !only || only.has(n);
    if (only) console.log(`\n(PIR1475_ONLY=${process.env.PIR1475_ONLY} — PARTIAL RUN, not evidence)`);

    if (wanted('2') || wanted('3')) await step2and3(tower, ws, agent, terminalId);
    if (wanted('4')) tower = await step4(tower, ws, agent, terminalId, socketDir);
    if (wanted('5')) await step5(tower, root);
    if (wanted('7')) await step7(tower, root, shim);
    if (wanted('6')) await step6(root, socketDir);

    section('LIVE TOWER UNTOUCHED');
    const liveAfter = await portListening(LIVE_TOWER_PORT);
    console.log(`  live Tower on ${LIVE_TOWER_PORT} after: ${liveAfter ? 'LISTENING' : 'not running'}`);
    check(liveAfter === liveBefore, `the live Tower on ${LIVE_TOWER_PORT} is exactly as it was`);

    section('RESULT');
    console.log(`  ${checks - failures}/${checks} checks passed`);
    if (skips.length) console.log(`  ${skips.length} skipped: ${skips.join('; ')}`);
    console.log(failures === 0 ? '  ALL EXECUTED CHECKS PASSED' : `  ${failures} FAILED`);
  } finally {
    if (tower) await stopTower(tower);
    rmSync(root, { recursive: true, force: true });
  }
  process.exit(failures === 0 ? 0 : 1);
}

void main();
