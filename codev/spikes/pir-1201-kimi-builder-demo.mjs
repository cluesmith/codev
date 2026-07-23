#!/usr/bin/env node
/**
 * PIR #1201 — live demo driver: Kimi builder launch path end-to-end against a
 * REAL `kimi` (>= 0.27.0, authenticated), using the REAL built modules from
 * packages/codev/dist — no Tower required.
 *
 * What it exercises, in order (the dev-approval demo checklist):
 *   1. Seed-session bootstrap — KIMI_HARNESS.buildBuilderLaunchScript +
 *      seedDelivery.buildSeedPrompt generate .builder-start.sh/.builder-seed.txt
 *      exactly as spawn-worktree.ts does; the script runs `kimi -p` and captures
 *      the session id from the (undocumented) session.resume_hint meta line.
 *   2. Sentinel-gated, store-verified BEGIN — the REAL armSeedKick watches the
 *      PTY for __CODEV_KIMI_SEED_DONE__, waits the grace, writes BEGIN with the
 *      Kimi Enter delay, and confirms against state.json.lastPrompt.
 *   3. Multiline delivery — the REAL writeMessageToSession (paced lines +
 *      pinned Enter delay) submits a >3-line message to the running TUI.
 *   4. Inner-restart retention — the TUI process is killed; the script's
 *      while-true loop re-enters `kimi -S <id>`; a follow-up question verifies
 *      role/task context survived. buildResume() is then shown returning the
 *      same pinned id (afx spawn --resume path).
 *
 * Run from the repo root of this worktree (after `pnpm build`):
 *   node codev/spikes/pir-1201-kimi-builder-demo.mjs
 *
 * Output: PASS/FAIL per step, plus the raw evidence (lastPrompt values,
 * assistant text extracted from the session wire log).
 */

import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const dist = (p) => join(repoRoot, 'packages', 'codev', 'dist', p);

const { KIMI_HARNESS } = await import(dist('agent-farm/utils/harness.js'));
const { armSeedKick } = await import(dist('agent-farm/servers/seed-kick.js'));
const { writeMessageToSession } = await import(dist('agent-farm/servers/message-write.js'));
const { readKimiSessionState } = await import(dist('agent-farm/utils/kimi-session-discovery.js'));

const require = createRequire(join(repoRoot, 'packages', 'codev', 'package.json'));
const pty = require('node-pty');

const worktree = mkdtempSync(join(tmpdir(), 'kimi-demo-wt-'));
console.log(`demo worktree: ${worktree}`);

const results = [];
const record = (step, ok, evidence) => {
  results.push({ step, ok, evidence });
  console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${step}\n  ${evidence}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Generate the launch artifacts exactly as spawn-worktree.ts does --------
const ROLE = 'You are a demo builder agent. Begin every reply with the exact token DEMO-OK followed by a space.';
const TASK = 'Your task: when told to begin, reply (per your role) with a one-line haiku about git worktrees. Do not use tools.';

const seedFile = join(worktree, '.builder-seed.txt');
writeFileSync(seedFile, KIMI_HARNESS.seedDelivery.buildSeedPrompt(ROLE, TASK));

const scriptPath = join(worktree, '.builder-start.sh');
writeFileSync(scriptPath, KIMI_HARNESS.buildBuilderLaunchScript({
  worktreePath: worktree, baseCmd: 'kimi', seedFile,
}));
chmodSync(scriptPath, 0o755);
console.log('--- generated .builder-start.sh ---');
console.log(readFileSync(scriptPath, 'utf-8'));

// --- Host the script in a PTY, shimming the PtySession surface --------------
const term = pty.spawn('/bin/bash', [scriptPath], {
  name: 'xterm-256color', cols: 120, rows: 40, cwd: worktree,
  env: { ...process.env },
});

const dataListeners = new Set();
let transcript = '';
term.onData((d) => {
  transcript += d;
  for (const l of dataListeners) l(d);
});
const session = {
  write: (d) => term.write(d),
  on: (ev, l) => { if (ev === 'data') dataListeners.add(l); },
  off: (ev, l) => { if (ev === 'data') dataListeners.delete(l); },
};

const logs = [];
const log = (level, message) => {
  logs.push(`${level}: ${message}`);
  console.log(`  [seed-kick ${level}] ${message}`);
};

// Arm the REAL readiness-gated kick (what handleTerminalCreate does).
armSeedKick(session, {
  sentinel: KIMI_HARNESS.seedDelivery.sentinelPrefix,
  message: KIMI_HARNESS.seedDelivery.kickMessage,
  graceMs: KIMI_HARNESS.seedDelivery.graceMs,
  enterDelayMs: KIMI_HARNESS.messagePacing.enterDelayMs,
  verify: { kind: 'kimi-session-store', worktreePath: worktree },
}, log);

// --- Step 1+2: wait for seed, sentinel, verified BEGIN ----------------------
const deadline = Date.now() + 150_000;
let sid = null;
while (Date.now() < deadline) {
  const m = /__CODEV_KIMI_SEED_DONE__[ \t]+(\S+)/.exec(transcript);
  if (m) { sid = m[1]; break; }
  await sleep(500);
}
record('1. seed-session bootstrap (sentinel printed, id captured)', !!sid, `sid=${sid}`);
if (!sid) { term.kill(); process.exit(1); }

let beginConfirmed = false;
const beginDeadline = Date.now() + 45_000;
while (Date.now() < beginDeadline) {
  if (logs.some((l) => l.includes('confirmed submitted'))) { beginConfirmed = true; break; }
  await sleep(500);
}
const st1 = readKimiSessionState(sid);
record('2. sentinel-gated BEGIN, store-verified', beginConfirmed,
  `lastPrompt=${JSON.stringify(st1?.lastPrompt)}`);

// Give the model time to answer BEGIN (the haiku per the task briefing).
await sleep(25_000);

// --- Step 3: multiline delivery with the pinned Enter delay -----------------
const multiline = ['This is a multiline delivery check.', 'Line two.', 'Line three.',
  'Reply per your role with the single token MULTI-OK and nothing else.'].join('\n');
writeMessageToSession(session, multiline, false, 0,
  { enterDelayMs: KIMI_HARNESS.messagePacing.enterDelayMs });

let multiOk = false;
const multiDeadline = Date.now() + 40_000;
while (Date.now() < multiDeadline) {
  const st = readKimiSessionState(sid);
  if (st?.lastPrompt?.includes('MULTI-OK')) { multiOk = true; break; }
  await sleep(1000);
}
record('3. multiline afx-send-shaped delivery submits (pinned Enter delay)', multiOk,
  `lastPrompt=${JSON.stringify(readKimiSessionState(sid)?.lastPrompt?.slice(0, 80))}`);
await sleep(20_000); // let the model reply before the restart

// --- Step 4: inner-restart retention ---------------------------------------
// Kill the kimi TUI (not the script): the while-true loop restarts `-S $SID`.
const { execSync } = await import('node:child_process');
try {
  execSync(`pkill -f -- "-S ${sid}"`, { stdio: 'ignore' });
} catch { /* pkill exits 1 if pattern raced; the transcript shows the restart */ }
await sleep(10_000); // restart notice (2s) + TUI warm-up

writeMessageToSession(session, 'After this restart: what one-line task were you originally given? Reply per your role.',
  false, 0, { enterDelayMs: KIMI_HARNESS.messagePacing.enterDelayMs });
await sleep(30_000);

// Evidence: assistant turns from the session wire log mention the task/role.
let retention = false;
let lastTurns = '';
try {
  const sessionsRoot = join(homedir(), '.kimi-code', 'sessions');
  const { readdirSync } = await import('node:fs');
  outer:
  for (const wd of readdirSync(sessionsRoot)) {
    const wire = join(sessionsRoot, wd, sid, 'agents', 'main', 'wire.jsonl');
    if (existsSync(wire)) {
      const texts = [...readFileSync(wire, 'utf-8').matchAll(/"part":\{"type":"text","text":"((?:[^"\\]|\\.)*)"/g)]
        .map((m) => m[1]);
      lastTurns = texts.slice(-3).join(' | ').slice(0, 400);
      retention = texts.slice(-2).some((t) => t.includes('DEMO-OK') && /haiku|worktree/i.test(t));
      break outer;
    }
  }
} catch (err) {
  lastTurns = `wire log read failed: ${err.message}`;
}
record('4. inner-restart retention (role token + task recalled via kimi -S)', retention,
  `last turns: ${lastTurns}`);

// buildResume returns the same pinned id (afx spawn --resume path).
const resume = KIMI_HARNESS.buildResume(worktree);
record('4b. buildResume returns the pinned session (-S form)',
  resume?.sessionId === sid && resume?.args?.[0] === '-S',
  JSON.stringify(resume));

// --- Teardown ---------------------------------------------------------------
term.write('\x03'); await sleep(500); term.write('\x03'); await sleep(1000);
term.kill();

console.log('\n=== DEMO SUMMARY ===');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.step}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
