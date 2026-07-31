/**
 * Spike 1265 — review round 9, concern 7: the builder launch-loop wrapper is a
 * silent-loss path that input-side tracking cannot see.
 *
 * Every builder terminal runs `.builder-start.sh`: `while true; do <agent>;
 * LAUNCH_LOOP_TAIL; done` (spawn-worktree.ts — 5 generation sites, all
 * sharing LAUNCH_LOOP_TAIL). Two wrapper states can own the PTY's stdin while
 * no agent exists:
 *
 *   (A) deliberate exit (status 0): bash `read -r` waits on "Press Enter to
 *       relaunch". A delivered message (text + \r) is consumed by `read` —
 *       the text lands in $REPLY and is discarded, the \r terminates the read,
 *       and the loop RELAUNCHES the agent. The sender was told "delivered".
 *       No input-side model can distinguish this from an empty composer: the
 *       message bytes themselves are the only input frames.
 *
 *   (B) crash restart (status != 0): bash sleeps 2 s, then relaunches. Bytes
 *       arriving during the sleep sit in the TTY input buffer and are drained
 *       by WHATEVER the next process is — where they land is app init
 *       behavior, measured here against real claude.
 *
 * The wrapper tail is EXTRACTED FROM THE PRODUCTION SOURCE at runtime
 * (spawn-worktree.ts LAUNCH_LOOP_TAIL) so this stays truthful to what ships;
 * the experiment fails loudly if the extraction ever stops matching.
 *
 * Tiers: case A is ASSERTED (deterministic bash semantics, fake agent).
 * Case B is MEASURED (exploratory — real claude on a dead ANTHROPIC_BASE_URL;
 * outcome recorded whichever way it lands).
 *
 * Usage: node exp-i8-wrapper-loss.cjs
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TuiDriver, sleep, show, WORKTREE_ROOT } = require('./harness.cjs');

const failures = [];
function check(label, ok, detail) {
  console.log(`ASSERT ${label}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
  if (!ok) failures.push(label);
}
function note(label, detail) {
  console.log(`MEASURED ${label}: ${detail}`);
}

// ---- Extract the production launch-loop tail ------------------------------
const SPAWN_SRC = path.join(WORKTREE_ROOT, 'packages', 'codev', 'src', 'agent-farm', 'commands', 'spawn-worktree.ts');
const src = fs.readFileSync(SPAWN_SRC, 'utf8');
const m = src.match(/const LAUNCH_LOOP_TAIL = `([\s\S]*?)`;/);
if (!m) {
  console.error('FATAL: LAUNCH_LOOP_TAIL not found in spawn-worktree.ts — production shape changed; update this experiment.');
  process.exit(1);
}
const TAIL = m[1];
check('i8-tail-extracted', TAIL.includes('Press Enter to relaunch') && TAIL.includes('read -r || exit 0'), 'production tail has the read-gated relaunch');

const scratch = fs.mkdtempSync(path.join(process.env.I8_SCRATCH || os.tmpdir(), 'i8-'));

function writeWrapper(name, agentCmd, cwd) {
  // Same shape startBuilderSession generates: cd, while-true, agent, TAIL.
  const wrapperPath = path.join(scratch, name);
  fs.writeFileSync(wrapperPath, `#!/bin/bash\ncd "${cwd}"\nwhile true; do\n  ${agentCmd}\n${TAIL}\ndone\n`, { mode: 0o755 });
  return wrapperPath;
}

(async () => {
  // ======================= Case A: exit-0 prompt ===========================
  {
    const bootLog = path.join(scratch, 'boots.log');
    const seenLog = path.join(scratch, 'seen.log');
    const fakeAgent = path.join(scratch, 'fake-agent.sh');
    // The fake agent DRAIN-PROBES its stdin at boot: if the delivered bytes
    // had survived for the relaunched agent to read, they would land in
    // seen.log. They don't — bash's `read` already consumed them into $REPLY.
    fs.writeFileSync(fakeAgent, `#!/bin/bash\necho "FAKE-AGENT-BOOT-$(wc -l < "${bootLog}" 2>/dev/null || echo 0)"\necho boot >> "${bootLog}"\nwhile IFS= read -t 0.3 -r pending; do echo "AGENT-SAW:$pending" >> "${seenLog}"; done\nexit 0\n`, { mode: 0o755 });
    const wrapper = writeWrapper('wrapper-a.sh', `"${fakeAgent}"`, scratch);

    const d = new TuiDriver('bash', [wrapper], { label: 'expI8a' });
    await d.settle(900, 15000);
    await sleep(400);
    show(d.screen().filter((l) => l), 'wrapper prompt after deliberate exit');
    d.snapshot('i8a-prompt');
    const boots0 = fs.readFileSync(bootLog, 'utf8').trim().split('\n').length;
    check('i8a-prompt-shown', d.screenText().includes('Press Enter to relaunch'), 'wrapper prompt rendered');
    check('i8a-one-boot', boots0 === 1, `boots=${boots0}`);

    // Deliver a message exactly like Tower's non-paced path: text, then \r
    // 50 ms later (message-write.ts single-line shape).
    const TOKEN = '[architect] i8qvzkx relaunch probe';
    d.send(TOKEN);
    await sleep(50);
    d.send('\r');
    await d.settle(900, 15000);
    await sleep(500);
    show(d.screen().filter((l) => l), 'after message delivery onto the prompt');
    d.snapshot('i8a-after-send');
    const boots1 = fs.readFileSync(bootLog, 'utf8').trim().split('\n').length;
    // The message's \r is the ONLY Enter this session ever received — the
    // relaunch it triggered proves `read` consumed the delivery.
    check('i8a-message-triggered-relaunch', boots1 === 2, `boots=${boots1}`);
    check('i8a-message-text-vanished', !d.screenText().includes('i8qvzkx'), 'token nowhere on screen — discarded into $REPLY');
    check('i8a-successor-agent-never-saw-it', !fs.existsSync(seenLog), `relaunched agent's stdin drain-probe found nothing${fs.existsSync(seenLog) ? `: ${fs.readFileSync(seenLog, 'utf8')}` : ''}`);
    check('i8a-back-at-prompt', d.screenText().includes('Press Enter to relaunch'), 'fake agent exited again; prompt is back');
    d.kill();
  }

  // ================= Case B: crash-restart window (claude) =================
  {
    const flag = path.join(scratch, 'crashed-once');
    try { fs.unlinkSync(flag); } catch { /* fresh */ }
    const agent = path.join(scratch, 'crashy-agent.sh');
    // First run: simulated crash (exit 7 → wrapper's auto-restart path).
    // Second run: real claude (dead API — no calls can succeed).
    fs.writeFileSync(agent, `#!/bin/bash\nif [ ! -f "${flag}" ]; then\n  touch "${flag}"\n  echo SIM-CRASH\n  sleep 0.5\n  exit 7\nfi\nexec claude\n`, { mode: 0o755 });
    // cwd = the worktree (production shape: builders relaunch in their
    // worktree, a directory claude already knows — no first-run dialogs).
    const wrapper = writeWrapper('wrapper-b.sh', `"${agent}"`, WORKTREE_ROOT);

    const d = new TuiDriver('bash', [wrapper], { label: 'expI8b', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } });
    // Wait for the restart countdown to appear, then send INTO the 2 s window.
    const deadline = Date.now() + 8000;
    let sawCountdown = false;
    while (Date.now() < deadline) {
      if (d.screenText().includes('Restarting in 2 seconds')) { sawCountdown = true; break; }
      await sleep(60);
    }
    check('i8b-countdown-seen', sawCountdown, 'wrapper auto-restart path reached');
    const TOKEN = '[architect] i8crash window probe';
    d.send(TOKEN);
    await sleep(50);
    d.send('\r');
    note('i8b-sent', 'message written during the sleep-2 restart window');
    // Let claude boot and settle fully.
    await d.settle(2500, 45000);
    await sleep(1500);
    show(d.screen().filter((l) => l), 'claude after crash-window delivery');
    d.snapshot('i8b-after-boot');
    const text = d.screenText();
    const inComposer = /[❯›].*i8crash/.test(d.screen().join('\n'));
    const anywhere = text.includes('i8crash');
    note('i8b-outcome', `tokenAnywhere=${anywhere} tokenInComposerLine=${inComposer} — where crash-window bytes land is claude init behavior; see snapshot`);
    d.kill();
  }

  if (failures.length) {
    console.error(`FAILURES: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('ALL ASSERTIONS PASSED (case B is measured, not asserted)');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
