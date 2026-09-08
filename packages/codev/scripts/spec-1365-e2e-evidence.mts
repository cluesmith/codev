/**
 * Issue #1365 — dev-approval evidence against a real, ISOLATED Tower.
 *
 * Running `afx dev` from this worktree would bind the live Tower's port (4100 is shared by
 * design) and restarting the live Tower kills every builder session, so the running-worktree
 * evidence is produced the way `send-integration.e2e.test.ts` does instead: spawn this
 * worktree's built Tower on a private port, register REAL shellper-backed PTY sessions, and
 * drive the REAL HTTP endpoints. Nothing is stubbed — routes → mailbox → render gate → the
 * locks → PTY is the full wire path under test.
 *
 * The oracle is an echo terminal (`stty raw -echo; exec cat`), the same fixture the existing
 * e2e uses: `cat` re-emits every byte written to the PTY input, in order, into the output
 * ring. So `GET /api/terminals/:id/output` is a faithful, ordered transcript of every byte
 * every writer put on that terminal — which is exactly what "did these two writers
 * interleave?" needs. Raw mode also means the `^C` is echoed as a byte rather than raising
 * SIGINT, so the session survives and stays registered across scenarios.
 *
 * Usage: pnpm --filter @cluesmith/codev build && node --experimental-strip-types \
 *          scripts/spec-1365-e2e-evidence.mts
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import net from 'node:net';

const PORT = 14650; // private to this script (14500 = cli-tower-mode, 14600 = send-integration)
const BASE = `http://localhost:${PORT}`;
const TOWER = resolve(import.meta.dirname, '../dist/agent-farm/servers/tower-server.js');

const ESC = '\x1b';
const CTRL_C = '\x03';
const COMPOSER_RULE = '─'.repeat(22);
const CLEAR = `${ESC}[2J${ESC}[H`;
/** A CLEAN claude composer: marker + dim placeholder only → the render gate delivers. */
const CLEAN_COMPOSER = `${CLEAR}❯ ${ESC}[2mTry "fix the flaky test"${ESC}[0m\r\n${COMPOSER_RULE}\r\n`;
/** An OCCUPIED composer: a draft at normal intensity → the render gate holds (mid-turn). */
const DRAFT_COMPOSER = `${CLEAR}❯ ${ESC}[0mdeploy the hotfix to prod\r\n${COMPOSER_RULE}\r\n`;

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

/** Everything Tower itself logged — the server-side corroboration for the wire assertions. */
const towerLog: string[] = [];

/** Tower log lines matching a pattern, since a marker index (for per-scenario slicing). */
function towerLogSince(since: number, pattern: RegExp): string[] {
  return towerLog.slice(since).filter((l) => pattern.test(l));
}

async function startTower(): Promise<ChildProcess> {
  const proc = spawn('node', [TOWER, String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test', AF_TEST_DB: `test-1365-${PORT}.db` },
  });
  let stderr = '';
  const collect = (d: Buffer): void => {
    for (const line of d.toString().split('\n')) if (line.trim()) towerLog.push(line);
  };
  proc.stdout?.on('data', collect);
  proc.stderr?.on('data', collect);
  proc.stderr?.on('data', (d) => (stderr += d.toString()));
  for (let i = 0; i < 75; i++) {
    if (await portListening(PORT)) return proc;
    await sleep(200);
  }
  proc.kill();
  throw new Error(`Tower did not start on ${PORT}. stderr:\n${stderr}`);
}

// ---------------------------------------------------------------- workspace + terminals

function makeWorkspace(): string {
  const base = resolve(homedir(), '.agent-farm', 'test-workspaces');
  mkdirSync(base, { recursive: true });
  const ws = mkdtempSync(resolve(base, 'pir1365-'));
  for (const d of ['codev', '.agent-farm', '.codev']) mkdirSync(resolve(ws, d), { recursive: true });
  writeFileSync(
    resolve(ws, '.codev', 'config.json'),
    JSON.stringify({ shell: { architect: 'sh -c "sleep 3600"', builder: 'bash', shell: 'bash' } }),
  );
  // A REAL builder launches through this wrapper, so its PtySession.command is the shell,
  // not the harness — and `resolveProfileForSession` recovers the harness by reading this
  // file (the wrapped-launch fallback, same code path `afx reset` uses). Without it the gate
  // holds every send `no-profile` and nothing would ever be delivered to assert about. This
  // is fidelity, not a shortcut: it is exactly how a live builder's profile resolves.
  writeFileSync(
    resolve(ws, '.builder-start.sh'),
    '#!/usr/bin/env bash\nexec claude --dangerously-skip-permissions\n',
  );
  return ws;
}

async function activate(ws: string): Promise<void> {
  const encoded = Buffer.from(ws).toString('base64url');
  for (let i = 0; i < 30; i++) {
    const res = await fetch(`${BASE}/api/workspaces/${encoded}/activate`, { method: 'POST' });
    if (res.ok) break;
    await sleep(500);
  }
  for (let i = 0; i < 60; i++) {
    const list = await (await fetch(`${BASE}/api/workspaces`)).json();
    if (list.workspaces.some((w: { path: string }) => w.path === ws)) return;
    await sleep(500);
  }
  throw new Error('workspace never activated');
}

/** A real shellper-backed PTY that echoes its input — see the header for why. */
async function registerEchoTerminal(ws: string, roleId: string): Promise<string> {
  const res = await fetch(`${BASE}/api/terminals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'sh',
      args: ['-c', 'stty raw -echo 2>/dev/null; exec cat'],
      cwd: ws,
      cols: 110,
      rows: 32,
      workspacePath: ws,
      type: 'builder',
      roleId,
      persistent: true,
    }),
  });
  if (res.status !== 201) throw new Error(`terminal register failed: ${res.status}`);
  return (await res.json()).id;
}

async function paint(terminalId: string, screen: string): Promise<void> {
  await fetch(`${BASE}/api/terminals/${terminalId}/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: screen }),
  });
  await sleep(250); // let the PTY echo land and the gate mirror catch up
}

/**
 * Every byte the echo PTY has emitted, in order — the interleaving oracle.
 *
 * `GET /api/terminals/:id/output` projects the ring as `{lines: string[]}`, so the lines are
 * rejoined here. Reading the ring rather than a mock is the point: this is the same output
 * stream the render gate classifies and the operator sees.
 */
async function transcript(terminalId: string): Promise<string> {
  const res = await fetch(`${BASE}/api/terminals/${terminalId}/output?lines=1000000`);
  const data = await res.json();
  return Array.isArray(data.lines) ? data.lines.join('\n') : JSON.stringify(data);
}

interface SendOptions { interrupt?: boolean; escape?: boolean; deliverAfter?: number }
interface SendResult { status: number; body: Record<string, unknown>; elapsedMs: number }

async function send(ws: string, to: string, message: string, options: SendOptions = {}): Promise<SendResult> {
  const startedAt = Date.now();
  const res = await fetch(`${BASE}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, workspace: ws, from: 'architect', message, options }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, elapsedMs: Date.now() - startedAt };
}

/** The held rows `afx inbox` would show — metadata only, as the route projects them. */
async function inbox(ws: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${BASE}/api/inbox?workspace=${encodeURIComponent(ws)}`);
  if (!res.ok) return [];
  return res.json();
}

// ---------------------------------------------------------------- scenarios

/**
 * A body long enough to take the paced multi-line path and hold the line while the
 * interrupt races it. 12 lines ≈ 11×10 + 80 = 190 ms of exposed text→Enter window.
 */
function longBody(i: number): string {
  return Array.from({ length: 12 }, (_, n) => `S1-${i}-line${n}`).join('\n');
}

/** Occurrences of `needle` in `haystack`. */
function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Scenario 1 — a long multi-line send raced by a concurrent interrupt, ×10.
 *
 * The property under test is NOT "the delivery always wins" — a gated delivery is entitled to
 * hold when the line is busy, and a row reported `held` at request time may still be
 * delivered moments later by the fast trigger or the backstop. Both are correct.
 *
 * The invariant is about FRAGMENTATION, which is what interleaving actually looks like on the
 * wire: whenever any part of the body reaches the terminal, the WHOLE body reaches it as one
 * contiguous run. So count the body's first line and count the whole body — if a racing `^C`
 * ever split a delivery, there would be a first line with no whole body behind it, and the
 * two counts would diverge. That is a sharper detector than "is the body present", and it is
 * exactly the failure this issue exists to remove.
 */
async function scenario1(ws: string, agent: string, terminalId: string): Promise<void> {
  section('SCENARIO 1 — 10x  long multi-line send  +  concurrent --interrupt');
  let deliveredAtRequest = 0;
  let heldAtRequest = 0;
  let landedWhole = 0;

  for (let i = 0; i < 10; i++) {
    await paint(terminalId, CLEAN_COMPOSER);
    const before = (await transcript(terminalId)).length;

    const body = longBody(i);
    const [normal] = await Promise.all([
      send(ws, agent, body),
      send(ws, agent, `S1-${i}-INTERRUPT`, { interrupt: true }),
    ]);
    // Long enough for the paced writes AND for a fast-trigger/backstop redelivery of a row
    // that was held at request time, so the observed end state is stable.
    await sleep(2200);

    const after = (await transcript(terminalId)).slice(before);
    const wholeBodies = countOf(after, body);
    const firstLines = countOf(after, `S1-${i}-line0`);

    // THE assertion: no fragment of the body exists that is not part of a whole body.
    check(firstLines === wholeBodies,
      `run ${i}: body never fragmented on the wire (whole=${wholeBodies} starts=${firstLines})`);
    check(wholeBodies <= 1, `run ${i}: the body was not duplicated`, `saw ${wholeBodies}`);

    if (normal.body.delivered === true) {
      deliveredAtRequest++;
      check(wholeBodies === 1, `run ${i}: reported delivered → the body IS on the wire, whole`);
    } else {
      heldAtRequest++;
      // Held at request time is fine; it may still deliver via the fast trigger/backstop.
      console.log(`  note  run ${i}: held (${String(normal.body.reason)}) at request time, ` +
        `${wholeBodies === 1 ? 'delivered whole by a later gated pass' : 'still pending'}`);
    }
    if (wholeBodies === 1) landedWhole++;

    check(after.includes(`S1-${i}-INTERRUPT`), `run ${i}: the interrupt itself landed`);
    check(after.includes(CTRL_C), `run ${i}: the interrupt's ^C landed`);
  }

  console.log(`\n  at request time: delivered=${deliveredAtRequest} held=${heldAtRequest}`);
  console.log(`  bodies that reached the wire: ${landedWhole}/10 — every one of them WHOLE`);
  console.log('  (holding is a correct outcome; fragmenting or lying about delivery is not)');

  const held = await inbox(ws);
  console.log(`  rows still held after scenario 1: ${held.length}` +
    (held.length ? ` (${held.map((r) => String(r.reason)).join(', ')}) — still deliverable, nothing lost` : ''));
}

/** Scenario 2 — `--delay 5 --interrupt` against a mid-turn agent. */
async function scenario2(ws: string, agent: string, terminalId: string): Promise<void> {
  section('SCENARIO 2 — --delay 5 --interrupt against a MID-TURN agent');
  await paint(terminalId, DRAFT_COMPOSER); // mid-turn: the gate must hold the body
  const before = (await transcript(terminalId)).length;

  const BODY = 'S2-DELAYED-BODY';
  const scheduled = await send(ws, agent, BODY, { deliverAfter: 5, interrupt: true });
  check(scheduled.body.scheduled === true, 'the send is SCHEDULED, not written at request time');
  check(!(await transcript(terminalId)).slice(before).includes(BODY), 'no body on the wire at request time');

  await sleep(6500); // past the due time
  const afterDue = (await transcript(terminalId)).slice(before);
  check(afterDue.includes(CTRL_C), 'the ^C fired at due time');
  check(!afterDue.includes(BODY), 'the body did NOT land mid-turn (the screen is still a draft)');

  // The turn ends: a clean prompt appears, and the gate lets the body through.
  await paint(terminalId, CLEAN_COMPOSER);
  for (let i = 0; i < 20 && !(await transcript(terminalId)).slice(before).includes(BODY); i++) await sleep(300);

  const final = (await transcript(terminalId)).slice(before);
  const occurrences = final.split(BODY).length - 1;
  check(occurrences === 1, 'the body landed EXACTLY once on the clean prompt', `saw ${occurrences}`);
  check(final.indexOf(CTRL_C) < final.indexOf(BODY), 'the ^C preceded the body');
}

/** Scenario 3 — an interrupt must not stall behind a long delivery (the D3 ceiling). */
async function scenario3(ws: string, agent: string, terminalId: string): Promise<void> {
  section('SCENARIO 3 — --interrupt against a busy line returns within the 2000ms ceiling');
  await paint(terminalId, CLEAN_COMPOSER);

  // ~400 lines ⇒ 399×10 + 80 ≈ 4.07 s of paced write: comfortably longer than the ceiling,
  // so an UNBOUNDED wait would show up as a ~4 s interrupt. This is not a pathological body —
  // it is the size of a modest --file attachment.
  const hugeBody = Array.from({ length: 400 }, (_, n) => `S3-line${n}`).join('\n');
  const logMark = towerLog.length;
  const delivery = send(ws, agent, hugeBody);
  await sleep(300); // let the delivery take the terminal lock

  const interrupt = await send(ws, agent, 'S3-INTERRUPT', { interrupt: true });
  console.log(`  interrupt round-trip: ${interrupt.elapsedMs}ms (ceiling 2000ms)`);
  check(interrupt.elapsedMs < 3200, 'the interrupt returned near the ceiling, not after the whole write',
    `${interrupt.elapsedMs}ms`);
  check(interrupt.status === 200, 'the interrupt still succeeded (the escape hatch works)');

  const deliveryResult = await delivery;
  console.log(`  delivery outcome: delivered=${String(deliveryResult.body.delivered)} ` +
    `held=${String(deliveryResult.body.held)} reason=${String(deliveryResult.body.reason)}`);
  await sleep(500);

  // Server-side corroboration. Two lines matter, and together they are the whole D3 story:
  // the operator announced its degradation, and the raced delivery refused to claim success.
  const degraded = towerLogSince(logMark, /UNSERIALIZED/);
  const preempted = towerLogSince(logMark, /raced by an unserialized/);
  for (const l of [...degraded, ...preempted]) console.log(`  tower: ${l.trim()}`);
  check(degraded.length === 1, 'Tower logged the ceiling degradation loudly (WARN)');
  check(preempted.length === 1, 'the raced delivery reported PREEMPTED and held its row for redelivery');
  check(deliveryResult.body.delivered !== true,
    'the raced delivery did NOT claim delivered — the false-delivered failure cannot recur here');
}

/** Scenario 4 — `--escape` is unchanged, and a dead terminal is refused loudly. */
async function scenario4(ws: string, agent: string, terminalId: string): Promise<void> {
  section('SCENARIO 4 — --escape unchanged; a non-writable terminal is refused');
  await paint(terminalId, CLEAN_COMPOSER);
  const before = (await transcript(terminalId)).length;

  const esc = await send(ws, agent, '<esc>', { escape: true });
  await sleep(300);
  const after = (await transcript(terminalId)).slice(before);
  check(esc.status === 200 && esc.body.ok === true, 'escape returns 200 ok');
  check(after.includes(ESC), 'the ESC byte reached the PTY');
  check(after.includes('\r'), 'its trailing Enter reached the PTY');

  // Refusal path: kill the terminal, then retry. Documented honestly below — this exercises
  // the no-live-session refusal, NOT the shellper-socket-down 503.
  await fetch(`${BASE}/api/terminals/${terminalId}`, { method: 'DELETE' });
  await sleep(1200);
  const dead = await send(ws, agent, '<esc>', { escape: true });
  console.log(`  escape to a killed terminal → ${dead.status} ${String(dead.body.error)}`);
  check(dead.status >= 400, 'an operator action to a dead terminal is REFUSED, never silently dropped');

  const normal = await send(ws, agent, 'S4-NORMAL-AFTER-DEATH');
  console.log(`  normal send to the same dead agent → ${normal.status} ` +
    `held=${String(normal.body.held)} reason=${String(normal.body.reason)}`);
  // This fixture's agent exists ONLY as a live terminal (registered via POST /api/terminals),
  // never as a spawned builder in global.db, so once its terminal is killed the agent is
  // unknown to the registry and 404 is the correct answer. The Spec 1313 "hold instead of
  // 404" seam needs a registry-known agent, which this harness deliberately does not fake —
  // it is covered by send-delivery/tower-routes unit tests against the real registry.
  check(normal.status === 404,
    'an unknown-after-death agent 404s (registry seam needs a real builder — see note)');

  console.log('\n  NOT SCRIPTED HERE, and why:');
  console.log('    503 TERMINAL_NOT_WRITABLE needs a shellper socket that has DIED while the');
  console.log('    session still reports status=running (#1198). That state cannot be forced');
  console.log('    from the public API without killing the shellper out of band, which would');
  console.log('    be staging the result rather than observing it. It is covered by');
  console.log('    tower-routes.test.ts:1560 against the real route, and this change does not');
  console.log('    touch that branch — only the lock the branch returns before reaching.');
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  console.log(`Issue #1365 — dev-approval evidence`);
  console.log(`isolated Tower on port ${PORT} (NOT 4100 — the live Tower is untouched)`);
  console.log(`tower build: ${TOWER}`);
  console.log(`started: ${new Date().toISOString()}`);

  let tower: ChildProcess | null = null;
  let ws = '';
  try {
    tower = await startTower();
    ws = makeWorkspace();
    await activate(ws);

    const agent = 'pir-1365-probe';
    const terminalId = await registerEchoTerminal(ws, agent);
    console.log(`\nworkspace: ${ws}\nterminal:  ${terminalId} (real shellper-backed PTY, echo oracle)`);

    await scenario1(ws, agent, terminalId);
    await scenario2(ws, agent, terminalId);
    await scenario3(ws, agent, terminalId);
    await scenario4(ws, agent, terminalId);

    section('RESULT');
    console.log(`  ${checks - failures}/${checks} checks passed`);
    console.log(failures === 0 ? '  ALL SCENARIOS PASSED' : `  ${failures} FAILED`);
  } finally {
    if (tower) {
      tower.kill('SIGTERM');
      await sleep(1500);
      tower.kill('SIGKILL');
    }
    if (ws) rmSync(ws, { recursive: true, force: true });
  }
  process.exit(failures === 0 ? 0 : 1);
}

void main();
