#!/usr/bin/env node
/**
 * PIR #1201 — live demo driver: the Kimi builder launch path end-to-end against a
 * REAL `kimi` (>= 0.33.0, authenticated), using the REAL built modules from
 * packages/codev/dist. No Tower required.
 *
 * Rewritten for the design pivot (PR #1203 re-integration). The retired version
 * drove the seed-session bootstrap (`kimi -p` seed → resume_hint capture → pinned
 * `kimi -S <id>` loop → a sentinel-gated BEGIN written straight to the PTY). The
 * shipped design instead delivers the ROLE via `--agent-file` and the TASK via the
 * Spec 1313 mailbox, and resumes crashes with the documented cwd-scoped `kimi -c`.
 *
 * What it exercises, in order:
 *   1. Role injection — the REAL getWorktreeFiles + buildScriptRoleInjection +
 *      buildBuilderLaunchScript generate the worktree files and .builder-start.sh
 *      exactly as spawn-worktree.ts does. The TUI is asked a role-identifying
 *      question; a correct answer proves --agent-file reached the interactive TUI
 *      (not just `-p`), and that ${base_prompt} did not clobber the role.
 *   2. Render gate — the REAL KIMI_PROFILE + classifyBuffer classify the LIVE
 *      screen. This is the readiness barrier that replaced the PTY sentinel: a
 *      booting/busy kimi classifies not-clean and holds; an idle composer is clean.
 *   3. Paced delivery — the REAL writeMessagePaced with the REAL Kimi pacing
 *      submits a >3-line message (the 80ms default is swallowed by kimi's paste
 *      detection; the pinned ~1s Enter submits).
 *   4. Crash resume — the TUI process is killed; the script's own loop consults its
 *      inlined store probe, takes `kimi -c`, and a follow-up question verifies the
 *      role survived the resume.
 *   5. The fail-closed guard — with an EMPTY store the same probe reports "no
 *      session", so the loop must launch FRESH WITH the role. This is the #929
 *      hazard `kimi -c` opens by silently starting a roleless session when there is
 *      nothing to continue.
 *
 * Run from the repo root of this worktree (after `pnpm build`):
 *   node codev/spikes/pir-1201-kimi-builder-demo.mjs
 *
 * Output: PASS/FAIL per step plus the raw evidence.
 */

import { mkdtempSync, writeFileSync, chmodSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const dist = (p) => join(repoRoot, 'packages', 'codev', 'dist', p);

const { KIMI_HARNESS, KIMI_AGENT_FILE } = await import(dist('agent-farm/utils/harness.js'));
const { writeMessagePaced } = await import(dist('agent-farm/servers/message-write.js'));
const { classifyBuffer } = await import(dist('agent-farm/servers/render-gate.js'));
const { KIMI_PROFILE } = await import(dist('agent-farm/servers/gate-profiles.js'));
const { ensureKimiWorkspaceTrust } = await import(dist('agent-farm/utils/kimi-session-discovery.js'));

const require = createRequire(join(repoRoot, 'packages', 'codev', 'package.json'));
const pty = require('node-pty');
const xterm = require('@xterm/headless');

const COLS = 110;
const ROWS = 32;
const worktree = mkdtempSync(join(tmpdir(), 'kimi-demo-wt-'));
console.log(`demo worktree: ${worktree}`);

const results = [];
const record = (step, ok, evidence) => {
  results.push({ step, ok, evidence });
  console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${step}\n  ${evidence}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Generate the launch artifacts exactly as spawn-worktree.ts does --------
/**
 * The role carries a CODEWORD, and the steps that check "did the role reach the
 * model?" ask for it back.
 *
 * An earlier version instead told the model to prefix every reply with a token,
 * and asserted on the prefix. That conflated two different claims: whether the
 * role was injected (what this demo exists to prove) and whether K3 honors a
 * persistent output-format constraint (which it does not do reliably — measured:
 * it answered the task correctly while dropping the prefix, and when asked about
 * its prefix it discussed the idea rather than emitting the token). A recall
 * question isolates the claim under test, and it is the same oracle
 * `pir-1201-kimi-agentfile-probe.mjs` uses to measure `--agent-file` directly.
 */
const CODEWORD = 'DEMO-ROLE-OK-4417';
const ROLE = 'You are a demo builder agent. Your codeword is ' + CODEWORD + '. '
  + 'If you are asked for your codeword, reply with exactly that token and nothing else.';
const ASK_CODEWORD = 'What is your codeword? Reply with only the codeword.';
const TASK = ASK_CODEWORD;

const roleFile = join(worktree, '.builder-role.md');
writeFileSync(roleFile, ROLE);
const promptFile = join(worktree, '.builder-prompt.txt');
writeFileSync(promptFile, TASK);

// getWorktreeFiles writes the --agent-file definition (role wrapped around
// ${base_prompt}); buildScriptRoleInjection produces the flag that points at it.
for (const f of KIMI_HARNESS.getWorktreeFiles(ROLE)) {
  writeFileSync(join(worktree, f.relativePath), f.content);
}
const { fragment: roleFragment } = KIMI_HARNESS.buildScriptRoleInjection(ROLE, roleFile);

// The spawn path pre-records folder trust so an unattended builder is not
// stranded on kimi 0.33.0+'s "Trust this folder?" dialog.
KIMI_HARNESS.prepareWorkspace?.(worktree);

const scriptPath = join(worktree, '.builder-start.sh');
writeFileSync(scriptPath, KIMI_HARNESS.buildBuilderLaunchScript({
  worktreePath: worktree, baseCmd: 'kimi', roleFragment,
  // The demo delivers the task itself (step 3) rather than shelling out to `afx
  // send`, which would need a running Tower. The queue call is still generated
  // and printed below, so what is skipped is visible rather than hidden.
  taskFile: promptFile, builderId: 'kimi-demo',
}));
chmodSync(scriptPath, 0o755);
console.log('--- generated .builder-role-agent.md ---');
console.log(readFileSync(join(worktree, KIMI_AGENT_FILE), 'utf-8'));
console.log('--- generated .builder-start.sh ---');
console.log(readFileSync(scriptPath, 'utf-8'));

// --- Host the script in a PTY, mirroring it into a headless terminal --------
// The mirror is what production classifies (SessionScreen); feeding it the same
// bytes lets the REAL classifier run against the REAL live screen.
const term = pty.spawn('/bin/bash', [scriptPath], {
  name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: worktree,
  env: { ...process.env },
});

const mirror = new xterm.Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 2000 });
let transcript = '';
term.onData((d) => { transcript += d; mirror.write(d); });

const session = { write: (d) => { term.write(d); return true; } };

/** Classify the live screen with the production classifier. */
function gate() {
  return classifyBuffer(mirror, COLS, ROWS, KIMI_PROFILE);
}

/** Wait until the gate says the composer is clean (or time out). */
async function waitForCleanComposer(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = gate();
    if (last.clean) return last;
    await sleep(500);
  }
  return last;
}

/** Deliver a message the way the mailbox does: gate first, then paced write. */
async function deliver(message) {
  const verdict = await waitForCleanComposer();
  if (!verdict?.clean) return { delivered: false, verdict };
  const ok = await writeMessagePaced(session, message, false, KIMI_HARNESS.messagePacing);
  return { delivered: ok, verdict };
}

const seen = (re, from = 0) => re.test(transcript.slice(from));

/**
 * Wait for `re` to appear in the transcript after `from`. Generous by default:
 * kimi K3 at "thinking: high" can take well over a minute on a cold first turn,
 * and a too-short window makes a working feature look broken.
 */
async function waitFor(re, from, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (seen(re, from)) return true;
    await sleep(1000);
  }
  return seen(re, from);
}

/**
 * Kill the kimi TUI (not the script) so the launch loop takes its crash path.
 *
 * Deliberately walks the process tree from the script's own bash instead of
 * pattern-matching a command line: kimi ships as a COMPILED binary whose argv
 * varies with how it was installed and invoked, and a pkill pattern that quietly
 * matches nothing turns this step into a false PASS — the original session simply
 * keeps running and answers the follow-up question.
 */
function killTui(bashPid) {
  const out = spawnSync('pgrep', ['-P', String(bashPid)], { encoding: 'utf-8' });
  const pids = (out.stdout || '').trim().split('\n').filter(Boolean);
  for (const p of pids) {
    try { process.kill(Number(p), 'SIGKILL'); } catch { /* already gone */ }
  }
  return pids;
}

try {
  // --- Step 1+2: gate recognizes the live composer; role reached the TUI -----
  const boot = gate();
  const ready = await waitForCleanComposer();
  record(
    '1. render gate classifies the LIVE kimi composer (the readiness barrier)',
    ready?.clean === true,
    `at boot: ${JSON.stringify(boot)} → when idle: ${JSON.stringify(ready)}`,
  );

  const mark1 = transcript.length;
  await deliver(TASK);
  // The task IS the codeword question, so one delivery proves two things at once:
  // the mailbox → render-gate → composer path carried it, and --agent-file injected
  // the role in the INTERACTIVE TUI without ${base_prompt} displacing it.
  const roleHonored = await waitFor(new RegExp(CODEWORD), mark1);
  record(
    '2. role injected via --agent-file and honored in the interactive TUI',
    roleHonored,
    roleHonored ? `assistant recalled the role codeword ${CODEWORD}` : 'the role codeword never came back',
  );

  // --- Step 3: paced multi-line delivery ------------------------------------
  const mark2 = transcript.length;
  const multiline = [
    'Answer with exactly one word, no punctuation:',
    'line two is filler',
    'line three is filler',
    'line four: what is the capital of France?',
  ].join('\n');
  const { delivered } = await deliver(multiline);
  const answered = await waitFor(/Paris/i, mark2);
  record(
    `3. multi-line delivery submits with the pinned ${KIMI_HARNESS.messagePacing.enterDelayMs}ms Enter`,
    delivered && answered,
    delivered ? 'paced write reported all bytes on the wire; model answered' : 'paced write reported a dropped write',
  );

  // --- Step 4: crash resume via the script's own probe + `kimi -c` -----------
  const mark3 = transcript.length;
  const killed = killTui(term.pid);
  // The loop prints its decision before relaunching; a resumed conversation is
  // the one the store probe authorized.
  await waitFor(/Resuming the conversation|Relaunching fresh/, mark3, 60000);
  const choseResume = seen(/Resuming the conversation/, mark3);
  record(
    '4a. crash restart consults the store probe and chooses resume',
    killed.length > 0 && choseResume,
    killed.length === 0
      ? 'NO child process was killed — the crash path was never exercised (harness fault, not a product result)'
      : choseResume
        ? `killed pid(s) ${killed.join(',')}; loop announced "Resuming the conversation"`
        : `killed pid(s) ${killed.join(',')}; loop did NOT choose resume (see transcript)`,
  );

  const mark4 = transcript.length;
  await deliver(ASK_CODEWORD);
  const survived = await waitFor(new RegExp(CODEWORD), mark4);
  record(
    '4b. role survives the `kimi -c` resume',
    survived && choseResume,
    survived
      ? (choseResume ? 'post-resume reply still recalls the role codeword' : 'codeword present, but no resume happened — not evidence')
      : 'the role codeword was gone after resume',
  );

  // --- Step 5: the fail-closed guard ---------------------------------------
  // `kimi -c` with nothing to continue does NOT fail — it starts a fresh session
  // that never saw --agent-file, i.e. a ROLELESS builder. Run the script's own
  // inlined probe against an EMPTY store: it must report "no session" so the loop
  // takes the fresh, role-carrying path instead.
  const probe = /node -e '([^']*)'/.exec(readFileSync(scriptPath, 'utf-8'))?.[1];
  const emptyHome = mkdtempSync(join(tmpdir(), 'kimi-demo-emptyhome-'));
  mkdirSync(join(emptyHome, '.kimi-code'), { recursive: true });
  const emptyProbe = spawnSync(process.execPath, ['-e', probe, worktree], {
    env: { ...process.env, KIMI_CODE_HOME: join(emptyHome, '.kimi-code') },
  });
  const liveProbe = spawnSync(process.execPath, ['-e', probe, worktree], { env: { ...process.env } });
  rmSync(emptyHome, { recursive: true, force: true });
  record(
    '5. store probe fails CLOSED on an empty store (no roleless -c fallback)',
    emptyProbe.status !== 0 && liveProbe.status === 0,
    `empty store → exit ${emptyProbe.status} (want non-zero); real store → exit ${liveProbe.status} (want 0)`,
  );

  // Trust pre-record is idempotent: the second call must be a no-op.
  record(
    '6. workspace-trust pre-record is idempotent',
    ensureKimiWorkspaceTrust(worktree) === false,
    'second ensureKimiWorkspaceTrust() returned false (existing record left alone)',
  );
} finally {
  try { term.kill(); } catch { /* already dead */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
if (failed.length) {
  console.log('failed steps:', failed.map((f) => f.step).join('; '));
  console.log('\n--- raw transcript tail ---\n' + transcript.slice(-4000));
}
process.exit(failed.length ? 1 : 0);
