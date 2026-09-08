/**
 * Validate the PIR #1201 design pivot against real kimi 0.34.0.
 *
 * The pivot replaces the 0.27.0-era seed bootstrap (a `kimi -p` one-shot
 * carrying role + task under an ack-and-wait discipline, a captured session id,
 * and a store-verified BEGIN kick) with two sanctioned mechanisms:
 *   role → `--agent-file <role.md>` at launch, composed with `${base_prompt}`
 *          so it EXTENDS kimi's system prompt instead of replacing it;
 *   task → an ordinary Spec 1313 mailbox message delivered onto a
 *          render-gate-verified empty composer.
 *
 * Before building on that, four claims must hold on a real install. This probe
 * checks each and prints PASS/FAIL:
 *
 *   1. --agent-file injects the role in NON-interactive (-p) mode.
 *   2. --agent-file injects the role in the INTERACTIVE TUI (the half the
 *      pivot actually depends on, and the half that was never measured).
 *   3. The TUI mints its session on the FIRST MESSAGE, not at startup
 *      (0.33.0 changed this) — so a crash-resume has something to resume only
 *      after the task message lands.
 *   4. `kimi -c` (documented, cwd-scoped) resumes that session AND the role
 *      binding survives — which is what lets the crash path drop both
 *      --agent-file (illegal with -c) and the undocumented store lookup.
 *
 * Usage: node codev/spikes/pir-1201-kimi-agentfile-probe.mjs
 */

import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pty = require(join(repoRoot, 'packages/codev/node_modules/node-pty'));

const TOKEN = 'CODEV-ROLE-OK-7731';
const ASK = 'What is the codeword? Reply with only the codeword.';
const ENTER_DELAY_MS = Number(process.env.PROBE_ENTER_DELAY_MS || 1000);
const KIMI_HOME = process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Pre-write kimi's workspace-trust record (0.33.0+); see kimi-session-discovery.ts. */
function preTrust(root) {
  const dir = join(KIMI_HOME, 'workspace-trust');
  mkdirSync(dir, { recursive: true });
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 12);
  writeFileSync(join(dir, `wd_${basename(root).toLowerCase()}_${hash}`),
    JSON.stringify({ root, trustedAt: Date.now() }));
}

/** Count sessions the store holds for `cwd` (v2 `cwd`, v1 `workDir`). */
function sessionsFor(cwd) {
  const root = join(KIMI_HOME, 'sessions');
  const found = [];
  if (!existsSync(root)) return found;
  for (const wd of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    for (const s of readdirSync(join(root, wd.name), { withFileTypes: true }).filter((e) => e.isDirectory())) {
      try {
        const st = JSON.parse(readFileSync(join(root, wd.name, s.name, 'state.json'), 'utf-8'));
        if ((st.cwd ?? st.workDir) === cwd) found.push(s.name);
      } catch { /* unreadable → not a session we can use */ }
    }
  }
  return found;
}

function agentFile(dir) {
  const p = join(dir, 'role-agent.md');
  writeFileSync(p, `---
name: codev-builder
description: Codev builder role (probe)
---
\${base_prompt}

# Codev Builder Role (probe)

If the user asks for the codeword, reply with exactly ${TOKEN} and nothing else.
`);
  return p;
}

/** Run kimi non-interactively and return stdout. */
function runP(args, cwd) {
  return new Promise((resolve) => {
    const term = pty.spawn('kimi', args, {
      name: 'xterm-256color', cols: 110, rows: 32, cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    let out = '';
    term.onData((d) => { out += d; });
    term.onExit(() => resolve(out));
  });
}

/**
 * Drive the interactive TUI: type `message`, pause ENTER_DELAY_MS (kimi's paste
 * window swallows an Enter that arrives too soon), submit, then wait.
 */
async function runTui(args, cwd, message, waitMs) {
  const term = pty.spawn('kimi', args, {
    name: 'xterm-256color', cols: 110, rows: 32, cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  let out = '';
  term.onData((d) => { out += d; });
  await sleep(12000);                       // let the TUI paint its composer
  const beforeSend = out.length;
  term.write(message);
  await sleep(ENTER_DELAY_MS);
  term.write('\r');
  await sleep(waitMs);
  try { term.kill(); } catch { /* already gone */ }
  await sleep(500);
  return { out, afterSend: out.slice(beforeSend) };
}

const dir = mkdtempSync(join(tmpdir(), 'kimi-pivot-'));
preTrust(dir);
const role = agentFile(dir);
console.log(`[probe] worktree: ${dir}\n[probe] enter delay: ${ENTER_DELAY_MS}ms\n`);

// 1. Non-interactive role injection.
const pOut = await runP(['--agent-file', role, '-p', ASK], dir);
record('1. --agent-file injects the role in -p mode', pOut.includes(TOKEN),
  pOut.includes(TOKEN) ? '' : `stdout: ${JSON.stringify(pOut.slice(-200))}`);

// 2 + 3. Interactive TUI: role injection, and session-mint timing.
const dir2 = mkdtempSync(join(tmpdir(), 'kimi-pivot-tui-'));
preTrust(dir2);
const role2 = agentFile(dir2);
const beforeAny = sessionsFor(dir2);
record('3a. TUI start mints NO session (checked before launch)', beforeAny.length === 0,
  `${beforeAny.length} session(s) pre-existing`);

const tui = await runTui(['--agent-file', role2, '--yolo'], dir2, ASK, 45000);
record('2. --agent-file injects the role in the interactive TUI', tui.afterSend.includes(TOKEN),
  tui.afterSend.includes(TOKEN) ? '' : `tail: ${JSON.stringify(tui.out.slice(-400))}`);

const afterMsg = sessionsFor(dir2);
record('3b. the first message mints exactly one session', afterMsg.length === 1,
  `sessions now: ${JSON.stringify(afterMsg)}`);

// 4. `-c` resumes that session and the role binding survives (no --agent-file).
const cont = await runTui(['-c', '--yolo'], dir2, ASK, 45000);
record('4a. kimi -c resumes without --agent-file', !cont.out.includes('No session yet'),
  cont.out.includes('No session yet') ? 'TUI reported no session to continue' : '');
record('4b. the role binding survives the resume', cont.afterSend.includes(TOKEN),
  cont.afterSend.includes(TOKEN) ? '' : `tail: ${JSON.stringify(cont.out.slice(-400))}`);
const afterCont = sessionsFor(dir2);
record('4c. -c reused the session (no second one minted)', afterCont.length === 1,
  `sessions now: ${JSON.stringify(afterCont)}`);

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
