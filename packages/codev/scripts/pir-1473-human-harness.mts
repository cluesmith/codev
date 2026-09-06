/**
 * PIR #1473 — the human runbook's tooling.
 *
 * Manual steps 1, 3 and 4 need a real harness, a real browser and a real pair of hands. This
 * script supplies everything around them: an isolated Tower running THIS branch's build, a real
 * terminal to type into, and `send`/`inbox` equivalents that talk to that Tower instead of the
 * live one.
 *
 * ## Why `afx` cannot be used for these steps
 *
 * `afx send` and `afx inbox` construct a `TowerClient` with no port argument, so they always
 * talk to the live Tower on 4100 (`commands/send.ts` — `new TowerClient()`). Pointing the
 * runbook at `afx` would therefore drive the LIVE Tower and the real builders on it. The `send`
 * and `inbox` subcommands here are deliberate stand-ins: same endpoints, same shared
 * `formatVerdict` renderer, different port.
 *
 * ## Subcommands
 *
 *   up         start the isolated Tower + a terminal running a real harness, and hold it open
 *   down       tear the whole thing down, including the shellpers Ctrl-C leaves behind
 *   send       send a message to that terminal's agent through the render gate
 *              (`--watch N` polls the row for N seconds and prints a verdict timeline)
 *   inbox      list held rows, rendered exactly as `afx inbox` renders them
 *   calibrate  manual step 2 against the REAL harness: keystroke→echo, percentiles, verdict
 *
 * Usage:
 *   node --experimental-strip-types scripts/pir-1473-human-harness.mts up [--harness claude]
 *   node --experimental-strip-types scripts/pir-1473-human-harness.mts down
 *   node --experimental-strip-types scripts/pir-1473-human-harness.mts send "text" [--delay N] [--watch N]
 *   node --experimental-strip-types scripts/pir-1473-human-harness.mts inbox
 *   node --experimental-strip-types scripts/pir-1473-human-harness.mts calibrate [--harness codex]
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import net from 'node:net';
import readline from 'node:readline';
import WebSocket from 'ws';
import { ensureLocalKey } from '@cluesmith/codev-core/auth';
import { TOWER_KEY_HEADER, terminalWsProtocols } from '@cluesmith/codev-types';
import { formatVerdict } from '@cluesmith/codev-sdk/hold-verdict';

const KEY = ensureLocalKey();
const AUTH: Record<string, string> = { [TOWER_KEY_HEADER]: KEY };
const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json', ...AUTH };

/** Private to the runbook. NOT 4100, and refused if anything else already holds it. */
const PORT = 14793;
const LIVE_TOWER_PORT = 4100;
const DB_NAME = `test-1473-${PORT}.db`;
/**
 * The probe's worktree directory name, and the roleId that name DERIVES.
 *
 * These two are not free choices, and getting them wrong is why the runbook's VS Code step
 * failed the first time. `GET /api/overview` — the ONLY source the VS Code Agents view and its
 * Quick Pick read — left-joins the live terminal registry onto a `readdirSync` of
 * `<workspace>/.builders/` (overview.ts:866-869), and matches by
 * `worktreeNameToRoleId(dirName)` (overview.ts:475-512), which rewrites `pir-1473-probe` to
 * `builder-pir-1473`. A terminal registered under any other roleId, or with no directory on
 * disk, is invisible to VS Code no matter how healthy it is — while remaining perfectly visible
 * in the browser, which renders from the registry directly.
 */
const PROBE_DIR = 'pir-1473-probe';
const AGENT = 'builder-pir-1473';

const DIST = resolve(import.meta.dirname, '../dist');
const TOWER = join(DIST, 'agent-farm/servers/tower-server.js');
/** Stable so `send`/`inbox` in a second terminal find the same workspace `up` created. */
const ROOT = resolve(homedir(), '.agent-farm', 'test-workspaces', 'pir1473-human');
const WS_DIR = join(ROOT, 'ws');
/** Written by `up`, read by `calibrate` — see the note at its write site. */
const TERM_ID_FILE = join(ROOT, 'terminal-id');
const BASE = `http://localhost:${PORT}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ms = (v: number): string => `${v.toFixed(1)}ms`;

/** The constant under test, restated (this script is evidence about the BUILD, not the source). */
const INPUT_SETTLE_MS = 300;

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

function encodeWs(p: string): string { return Buffer.from(p).toString('base64url'); }

// ---------------------------------------------------------------- up

async function cmdUp(harness: string): Promise<void> {
  if (!existsSync(TOWER)) {
    console.error(`No build at ${TOWER}. Run:  pnpm --filter @cluesmith/codev build`);
    process.exit(1);
  }
  if (await portListening(PORT)) {
    console.error(`Port ${PORT} is already in use. Something else owns it — refusing to run ` +
      'against a Tower this script did not start. Stop it, or free the port.');
    process.exit(1);
  }
  const liveBefore = await portListening(LIVE_TOWER_PORT);

  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(WS_DIR, '.codev'), { recursive: true });
  mkdirSync(join(WS_DIR, 'codev'), { recursive: true });
  // The half of the VS Code join that lives on disk. See PROBE_DIR.
  mkdirSync(join(WS_DIR, '.builders', PROBE_DIR), { recursive: true });
  mkdirSync(join(ROOT, 'run'), { recursive: true });
  writeFileSync(join(WS_DIR, '.codev', 'config.json'), JSON.stringify({ shell: { builder: 'bash' } }));
  // Fresh DB each run, so held rows from a previous session cannot be mistaken for this one's.
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(resolve(homedir(), '.agent-farm', `${DB_NAME}${suffix}`), { force: true });
  }

  console.log(`Starting an isolated Tower on ${PORT} (branch build).`);
  console.log(`Live Tower on ${LIVE_TOWER_PORT}: ${liveBefore ? 'LISTENING — it will not be touched' : 'not running'}`);
  const proc: ChildProcess = spawn('node', [TOWER, String(PORT)], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      AF_TEST_DB: DB_NAME,
      SHELLPER_SOCKET_DIR: join(ROOT, 'run'),
      // Manual step 1's instrumentation. On by default here because every step in the runbook
      // is either measuring it or harmless alongside it.
      AF_LOG_INPUT_SIGNAL: '1',
    },
  });

  for (let i = 0; i < 100 && !(await portListening(PORT)); i++) await sleep(200);
  if (!(await portListening(PORT))) { console.error('Tower did not start.'); process.exit(1); }

  await fetch(`${BASE}/api/workspaces/${encodeWs(WS_DIR)}/activate`, { method: 'POST', headers: AUTH });
  await sleep(1500);

  const res = await fetch(`${BASE}/api/terminals`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      command: harness, args: [], cwd: WS_DIR, cols: 110, rows: 32,
      workspacePath: WS_DIR, type: 'builder', roleId: AGENT, persistent: true,
    }),
  });
  if (res.status !== 201) {
    console.error(`Could not start a terminal running "${harness}": ${res.status} ${await res.text()}`);
    console.error(`Is "${harness}" on your PATH?`);
    proc.kill('SIGTERM');
    process.exit(1);
  }
  const termId = (await res.json()).id as string;
  // `calibrate` runs in a SECOND terminal and must drive THIS session, not whichever one a
  // list happens to return last — activating the workspace also creates an architect terminal,
  // and calibrating against that would measure the wrong app.
  writeFileSync(TERM_ID_FILE, termId);

  console.log(`\n${'='.repeat(72)}`);
  console.log('READY');
  console.log('='.repeat(72));
  console.log(`\n  Browser:  ${BASE}/workspace/${encodeWs(WS_DIR)}/`);
  console.log(`            Open it and click the "${AGENT}" terminal.`);
  console.log('\n  VS Code:  set BOTH of these in your User settings, then reload the window:');
  console.log(`              "codev.towerPort": ${PORT},`);
  console.log(`              "codev.workspacePath": "${WS_DIR}"`);
  console.log(`            Then open the Agents view and click "${AGENT}".`);
  console.log(`            PUT THEM BACK to 4100 / "" when you are done.`);
  console.log(`\n  Terminal: ${termId}`);
  console.log(`  Harness:  ${harness}`);
  console.log(`  Agent:    ${AGENT}`);
  console.log('\n  Input-signal trace is ON. Lines look like:');
  console.log('    [input-signal abc12345] raw="\\e[?1;2c" stripped="\\e[?1;2c" survived=<NOTHING> inputSeq=0→0');
  console.log('\n  Send / inbox (in ANOTHER terminal, from packages/codev):');
  console.log('    node --experimental-strip-types scripts/pir-1473-human-harness.mts send "hello"');
  console.log('    node --experimental-strip-types scripts/pir-1473-human-harness.mts inbox');
  console.log('\n  Ctrl-C here stops the Tower. Then, in the other terminal, run:');
  console.log('    node --experimental-strip-types scripts/pir-1473-human-harness.mts down');
  console.log('  Ctrl-C alone is NOT enough — shellper sessions are detached and outlive it.\n');

  const shutdown = (): void => {
    console.log('\nShutting down the isolated Tower…');
    proc.kill('SIGTERM');
    setTimeout(() => { proc.kill('SIGKILL'); process.exit(0); }, 3000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => { /* hold open until Ctrl-C */ });
}

// ---------------------------------------------------------------- down

/**
 * Tear down everything `up` created.
 *
 * Shellper sessions are DETACHED on purpose — that is how a builder survives a Tower restart —
 * so Ctrl-C on `up` stops the Tower and leaves the harness processes running. Left behind they
 * are indistinguishable, to a later reader of `ps`, from a real builder.
 *
 * The kill is matched on the isolated run directory in each process's own argv, which no
 * process outside this script can carry. Nothing on the live Tower can match it.
 */
async function cmdDown(): Promise<void> {
  const { execSync } = await import('node:child_process');
  const marker = join(ROOT, 'run');
  let killed = 0;
  const listing = execSync('ps -eo pid=,args=', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  for (const line of listing.split('\n')) {
    // Never match this process, and never match a grep/ps of it.
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (!pid || pid === process.pid) continue;
    if (!line.includes(marker)) continue;
    try { process.kill(pid, 'SIGTERM'); killed++; } catch { /* already gone */ }
  }
  // The Tower itself is matched by its port, not by the run dir.
  const towerLine = listing.split('\n').find((l) => l.includes(`tower-server.js ${PORT}`));
  if (towerLine) {
    const pid = Number(towerLine.trim().split(/\s+/)[0]);
    if (pid && pid !== process.pid) { try { process.kill(pid, 'SIGTERM'); killed++; } catch { /* gone */ } }
  }
  await sleep(1000);
  rmSync(ROOT, { recursive: true, force: true });
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(resolve(homedir(), '.agent-farm', `${DB_NAME}${suffix}`), { force: true });
  }
  console.log(`Stopped ${killed} process(es) and removed the isolated workspace and DB.`);
  console.log(`Port ${PORT}: ${(await portListening(PORT)) ? 'STILL LISTENING — check by hand' : 'free'}`);
  console.log(`Live Tower on ${LIVE_TOWER_PORT}: ${(await portListening(LIVE_TOWER_PORT)) ? 'still listening (untouched)' : 'not running'}`);
}

// ---------------------------------------------------------------- send / inbox

async function requireUp(): Promise<void> {
  if (!(await portListening(PORT))) {
    console.error(`Nothing is listening on ${PORT}. Start it first:\n` +
      '  node --experimental-strip-types scripts/pir-1473-human-harness.mts up');
    process.exit(1);
  }
}

/**
 * `--delay N` matters for manual step 3. A mouse click has to land within the 300 ms settle of
 * the gate's sample, and a human cannot hit that window by racing a command in another
 * terminal. Scheduling the send N seconds out turns an unrepeatable race into an interval the
 * human can simply be clicking through.
 */
async function cmdSend(
  message: string,
  interrupt: boolean,
  delaySeconds: number,
  watchSeconds: number,
): Promise<void> {
  await requireUp();
  const options: Record<string, unknown> = {};
  if (interrupt) options.interrupt = true;
  if (delaySeconds > 0) options.deliverAfter = delaySeconds;
  const res = await fetch(`${BASE}/api/send`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ to: AGENT, workspace: WS_DIR, from: 'architect', message, options }),
  });
  const body = await res.json().catch(() => ({} as Record<string, unknown>));
  if (body.scheduled || (body.notBefore && Number(body.notBefore) > Date.now())) {
    console.log(`scheduled → ${AGENT} in ${delaySeconds}s  (mailbox ${String(body.mailboxId ?? '').slice(0, 8)}…)`);
    if (watchSeconds > 0) await watchRow(String(body.mailboxId), watchSeconds);
    else console.log('Do your keyboard/mouse action across the window, then run:  … inbox');
    return;
  }
  if (body.delivered) {
    console.log(`delivered → ${AGENT}${body.bodyLength ? ` (${body.bodyLength} bytes)` : ''}`);
    if (body.unverifiedCause) console.log(`  UNCONFIRMED: ${String(body.unverifiedCause)}`);
    return;
  }
  if (body.held) {
    // The same renderer `afx inbox` and `afx send` use, so the string in the runbook's
    // pass criterion is the string a real operator would see.
    console.log(`HELD → ${AGENT}  (${formatVerdict(body.reason as string, body.detail as string, 'pending')})` +
      `  mailbox ${String(body.mailboxId ?? '').slice(0, 8)}…`);
    return;
  }
  console.log(`status=${res.status} ${JSON.stringify(body)}`);
}


/**
 * Poll one mailbox row and print every verdict CHANGE, with the time it happened.
 *
 * Exists because of a two-hands problem that makes the manual steps otherwise unrunnable: the
 * hold being measured only lasts while the human is at the keyboard, and asking them to stop
 * and type `inbox` in a second terminal ENDS the very condition under test. A single sample
 * taken after the fact cannot distinguish "never held" from "held and already cleared".
 *
 * A timeline is also better evidence than a point sample: `pending → busy:recent-input →
 * delivered` shows the hold AND its self-clearing recovery, which is the whole claim.
 */
async function watchRow(mailboxId: string, seconds: number): Promise<void> {
  const started = Date.now();
  const at = (): string => `+${((Date.now() - started) / 1000).toFixed(1)}s`;
  let last = '';
  console.log(`\nWatching for ${seconds}s. Do the keyboard/mouse action NOW — keep it up until this stops.\n`);
  while ((Date.now() - started) / 1000 < seconds) {
    const res = await fetch(`${BASE}/api/inbox?workspace=${encodeURIComponent(WS_DIR)}`, { headers: AUTH });
    const rows = (await res.json().catch(() => [])) as Array<Record<string, unknown>>;
    const row = Array.isArray(rows) ? rows.find((r) => r.id === mailboxId) : undefined;
    const verdict = row ? formatVerdict(row.reason as string, row.detail as string, 'pending') : 'DELIVERED';
    if (verdict !== last) { console.log(`  ${at().padStart(7)}  ${verdict}`); last = verdict; }
    if (verdict === 'DELIVERED') break;
    await sleep(250);
  }
  console.log('');
  if (last === 'DELIVERED') console.log('Final: delivered.');
  else console.log(`Final: still held as \`${last}\` when the watch ended.`);
  // The distinct verdicts seen are the evidence; a run that never left `pending` means the
  // send was not due yet and proves nothing either way.
}

async function cmdInbox(): Promise<void> {
  await requireUp();
  const res = await fetch(`${BASE}/api/inbox?workspace=${encodeURIComponent(WS_DIR)}`, { headers: AUTH });
  // GET /api/inbox answers with a bare array of HeldMessage — the same projection `afx inbox`
  // renders. (It is NOT wrapped in an envelope; assuming one prints "no held messages" over a
  // full mailbox, which in this runbook would read as a step-4 FAIL.)
  const rows = (await res.json().catch(() => [])) as Array<Record<string, unknown>>;
  if (!Array.isArray(rows) || rows.length === 0) { console.log('(no held messages)'); return; }
  for (const r of rows) {
    const age = `${Math.round((Date.now() - Number(r.createdAt)) / 1000)}s ago`;
    console.log(`${String(r.id).slice(0, 8)}…  → ${String(r.toAgent)}  from ${String(r.fromAgent)}  ` +
      `${formatVerdict(r.reason as string, r.detail as string, 'pending')}` +
      `${r.escalated ? '!' : ''}  ${age}`);
  }
}

// ---------------------------------------------------------------- calibrate (manual step 2)

/** Nearest-rank percentiles — every reported value is a real sample, not an interpolation. */
function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

function ask(question: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, () => { rl.close(); res(); }));
}

/**
 * Manual step 2 against a REAL harness. Types single characters into the live composer over the
 * terminal's own WebSocket — the same path a browser uses — and times each one to its echo.
 *
 * Never sends Enter, and backspaces each character afterwards, so nothing is ever submitted to
 * the agent.
 */
async function cmdCalibrate(harness: string, samples: number): Promise<void> {
  await requireUp();
  if (!existsSync(TERM_ID_FILE)) {
    console.error(`No probe terminal recorded at ${TERM_ID_FILE}. Is \`up\` running?`);
    process.exit(1);
  }
  const termId = readFileSync(TERM_ID_FILE, 'utf8').trim();
  const info = await fetch(`${BASE}/api/terminals/${termId}`, { headers: AUTH });
  if (!info.ok) {
    console.error(`Terminal ${termId} is gone. Restart \`up\`.`);
    process.exit(1);
  }

  console.log(`Calibrating against the REAL "${harness}" on terminal ${termId.slice(0, 8)}…`);
  console.log('This types single characters into its composer and backspaces them. It never');
  console.log('presses Enter, so nothing is submitted.\n');
  await ask('Make sure the harness has finished booting and is showing an EMPTY composer, then press Enter… ');

  const ws = new WebSocket(`ws://localhost:${PORT}/ws/terminal/${termId}`, terminalWsProtocols(KEY));
  const chunks: Array<{ at: number; text: string }> = [];
  ws.on('message', (raw: Buffer) => {
    const buf = Buffer.from(raw);
    if (buf.length > 0 && buf[0] === 0x01) chunks.push({ at: performance.now(), text: buf.subarray(1).toString('utf8') });
  });
  await new Promise<void>((res, rej) => {
    const timer = setTimeout(() => rej(new Error('WS open timeout')), 10_000);
    ws.on('open', () => { clearTimeout(timer); res(); });
    ws.on('error', (e) => { clearTimeout(timer); rej(e); });
  });
  await sleep(800); // let the replay burst land

  const sendKey = (data: string): number => {
    const frame = Buffer.allocUnsafe(1 + Buffer.byteLength(data));
    frame[0] = 0x01;
    Buffer.from(data, 'utf8').copy(frame, 1);
    const at = performance.now();
    ws.send(frame);
    return at;
  };
  /** Wait until the harness stops painting, so the next chunk we see is OUR echo. */
  const quiesce = async (idleMs = 200, capMs = 4000): Promise<void> => {
    const deadline = Date.now() + capMs;
    for (;;) {
      const last = chunks.length ? chunks[chunks.length - 1].at : -Infinity;
      if (performance.now() - last >= idleMs) return;
      if (Date.now() > deadline) return;
      await sleep(25);
    }
  };

  const gaps: number[] = [];
  let missed = 0;
  for (let i = 0; i < samples; i++) {
    await quiesce();
    const ch = String.fromCharCode(0x41 + (i % 26));
    const since = chunks.length;
    const sentAt = sendKey(ch);
    let echoAt: number | null = null;
    const deadline = Date.now() + 4000;
    while (echoAt === null && Date.now() < deadline) {
      for (let j = since; j < chunks.length; j++) {
        if (chunks.slice(since, j + 1).map((c) => c.text).join('').includes(ch)) { echoAt = chunks[j].at; break; }
      }
      if (echoAt === null) await sleep(2);
    }
    if (echoAt === null) missed++; else gaps.push(echoAt - sentAt);
    await quiesce(150, 2000);
    sendKey('\x7f'); // backspace it away — never leave a draft behind
    process.stdout.write(`\r  sampled ${i + 1}/${samples}`);
  }
  process.stdout.write('\n');
  ws.close();

  if (gaps.length === 0) {
    console.error('\nNo echo was ever observed. Is the composer focused and empty?');
    process.exit(1);
  }

  const sorted = [...gaps].sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  const p99 = percentile(sorted, 0.99);
  console.log(`\n${'='.repeat(72)}`);
  console.log(`MANUAL STEP 2 — keystroke→echo against REAL ${harness}`);
  console.log('='.repeat(72));
  console.log(`  samples: ${gaps.length}${missed ? ` (${missed} with no echo, excluded)` : ''}`);
  console.log(`  min=${ms(sorted[0])}  p50=${ms(p50)}  p95=${ms(p95)}  p99=${ms(p99)}  max=${ms(sorted[sorted.length - 1])}`);
  console.log(`  budget:  INPUT_SETTLE_BEFORE_WRITE_MS = ${INPUT_SETTLE_MS}ms`);
  console.log('');
  // The verdict is printed, not left to the reader — this is the measurement that can
  // invalidate the design, and "here are some numbers" is not a decision.
  if (p99 <= INPUT_SETTLE_MS) {
    console.log(`  VERDICT: ROLLBACK CRITERION DID NOT FIRE.`);
    console.log(`           p99 ${ms(p99)} <= ${INPUT_SETTLE_MS}ms. Keep the constant as it is.`);
  } else if (p99 + 100 <= 500) {
    console.log(`  VERDICT: ROLLBACK CRITERION FIRED.`);
    console.log(`           p99 ${ms(p99)} > ${INPUT_SETTLE_MS}ms. Raise INPUT_SETTLE_BEFORE_WRITE_MS`);
    console.log(`           to about ${Math.ceil((p99 + 100) / 50) * 50}ms (p99 + margin) and re-run this.`);
  } else {
    console.log(`  VERDICT: ROLLBACK CRITERION FIRED, AND A BIGGER CONSTANT IS THE WRONG FIX.`);
    console.log(`           p99 ${ms(p99)} would need a settle above ~500ms. Do NOT just raise it:`);
    console.log(`           adopt the bounded \`lastInputAt > lastDataAt\` refinement instead, and`);
    console.log(`           RE-OPEN the plan. Report this number to the architect.`);
  }
  console.log('');
}

// ---------------------------------------------------------------- main

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const cmd = process.argv[2] ?? 'up';
switch (cmd) {
  case 'up':
    await cmdUp(flag('harness', 'claude'));
    break;
  case 'send': {
    const interrupt = process.argv.includes('--interrupt');
    const delaySeconds = Number(flag('delay', '0'));
    // Drop the flag VALUE as well as the flag, or `--delay 8` puts "8" in the message body.
    const rest = process.argv.slice(3);
    // Drop each flag together with its value, or `--delay 8 --watch 20` lands in the body.
    for (const f of ['--delay', '--watch']) {
      const i = rest.indexOf(f);
      if (i !== -1) rest.splice(i, 2);
    }
    const text = rest.filter((a) => !a.startsWith('--')).join(' ');
    if (!text) { console.error('usage: … send "message text" [--interrupt] [--delay N] [--watch N]'); process.exit(1); }
    await cmdSend(text, interrupt, delaySeconds, Number(flag('watch', '0')));
    break;
  }
  case 'inbox':
    await cmdInbox();
    break;
  case 'down':
    await cmdDown();
    break;
  case 'calibrate':
    await cmdCalibrate(flag('harness', 'claude'), Number(flag('samples', '40')));
    break;
  default:
    console.error(`unknown command "${cmd}" — expected up | down | send | inbox | calibrate`);
    process.exit(1);
}
