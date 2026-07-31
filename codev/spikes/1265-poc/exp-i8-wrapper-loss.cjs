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
 * Round 10 additions (i8c/i8d): both loss states are MACHINE-DETECTABLE.
 * A post-delivery verify — the same G-lite render pass, run ~settle after the
 * delivery, asking "does the delivery LOOK delivered?" — classifies case A as
 * `lost` (token nowhere on the rendered screen, no composer marker) and case B
 * as `stranded` (token rendered as composer text, classifier not-clean).
 * Neither state can masquerade as a successful delivery, which is what lets
 * the check→write process-exit race and the wrapper states degrade to
 * DETECTED loss (row re-held / escalated) instead of silent loss. Verdicts
 * are asserted on BOTH the live emulator and a raw-stream reconstruction
 * (the ring-replay shape production would use — recon==live equivalence for
 * these screens).
 *
 * Usage: node exp-i8-wrapper-loss.cjs
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TuiDriver, sleep, show, WORKTREE_ROOT, Terminal } = require('./harness.cjs');

// ---- G-lite classifier + post-delivery verify (g2's semantics, .cjs copy) --
const IGNORE_CHARS = new Set(['❯', '›', '│', '▌', '─', '━', '╌', '┄', '╭', '╰', '┌', '└', '']);

function screenOfTerm(term, rows) {
  const buf = term.buffer.active;
  const top = buf.viewportY;
  const lines = [];
  for (let i = 0; i < rows; i++) {
    const line = buf.getLine(top + i);
    lines.push(line ? line.translateToString(true).trimEnd() : '');
  }
  return lines;
}

function classifyTerm(term, cols, rows) {
  const buf = term.buffer.active;
  const lines = screenOfTerm(term, rows);
  let markerRow = -1;
  for (let i = 0; i < lines.length; i++) if (/^[❯›]/.test(lines[i])) markerRow = i;
  if (markerRow === -1) return { clean: false, reason: 'no-composer-marker', userCells: -1 };
  let endRow = lines.length;
  for (let i = markerRow + 1; i < lines.length; i++) {
    if (/^[─━╌┄]{5,}/.test(lines[i]) || /^\s{2,}(gpt|high:|~\/)/.test(lines[i])) { endRow = i; break; }
  }
  const top = buf.viewportY;
  let userCells = 0;
  const cell = buf.getNullCell();
  for (let row = markerRow; row < endRow; row++) {
    const line = buf.getLine(top + row);
    if (!line) continue;
    for (let col = 0; col < cols; col++) {
      line.getCell(col, cell);
      const ch = cell.getChars();
      if (!ch || /^\s+$/u.test(ch) || IGNORE_CHARS.has(ch)) continue;
      if (row === markerRow && col === 0) continue;
      if (cell.isDim()) continue;
      userCells++;
    }
  }
  return { clean: userCells === 0, reason: userCells === 0 ? 'empty' : 'user-text', userCells };
}

/** Reconstruct a screen from the raw output stream (the ring-replay shape). */
async function reconFromRaw(rawChunks, cols, rows) {
  const t = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
  await new Promise((r) => t.write(rawChunks.join(''), r));
  return t;
}

/**
 * The post-delivery verify decision procedure: does this delivery LOOK
 * delivered on the rendered screen?
 *   lost      — token nowhere on screen (case A: eaten by the wrapper's read)
 *   stranded  — token rendered inside the composer region (case B: landed as
 *               unsubmitted draft text; classifier not-clean via user-text)
 *   delivered-visible — token rendered outside the composer (transcript entry;
 *               the positive branch, validated separately by i6's transcript
 *               assertions)
 * Production maps these to mailbox-row outcomes: verified / re-held /
 * escalated — never "assume success".
 */
function postVerify(term, cols, rows, token) {
  const cls = classifyTerm(term, cols, rows);
  const lines = screenOfTerm(term, rows);
  if (!lines.join('\n').includes(token)) return { verdict: 'lost', cls };
  let markerRow = -1;
  for (let i = 0; i < lines.length; i++) if (/^[❯›]/.test(lines[i])) markerRow = i;
  const inComposer = markerRow >= 0 && lines.slice(markerRow).join('\n').includes(token);
  if (inComposer) return { verdict: 'stranded', cls };
  return { verdict: 'delivered-visible', cls };
}

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

    // ---- i8c (round 10): the loss is DETECTABLE — post-delivery verify ----
    // Pre-gate view: the wrapper screen has no composer marker → not-clean →
    // a NEXT delivery is held. Post-verify view: this delivery's token is
    // nowhere on the rendered screen → verdict `lost` → the row is re-held
    // instead of being believed delivered. Assert on the live emulator AND on
    // a raw-stream reconstruction (the ring-replay shape production uses).
    const clsLive = classifyTerm(d.term, d.cols, d.rows);
    const pvLive = postVerify(d.term, d.cols, d.rows, 'i8qvzkx');
    const recon = await reconFromRaw(d.rawLog, d.cols, d.rows);
    const clsRecon = classifyTerm(recon, d.cols, d.rows);
    const pvRecon = postVerify(recon, d.cols, d.rows, 'i8qvzkx');
    check('i8c-wrapper-screen-classifies-held', clsLive.clean === false && clsLive.reason === 'no-composer-marker' && clsRecon.clean === false && clsRecon.reason === 'no-composer-marker', `live=${clsLive.reason} recon=${clsRecon.reason} — pre-gate holds the next delivery`);
    check('i8c-postverify-detects-loss', pvLive.verdict === 'lost' && pvRecon.verdict === 'lost', `live=${pvLive.verdict} recon=${pvRecon.verdict} — the eaten delivery never looks delivered`);
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

    // ---- i8d (round 10): whatever the landing, it never LOOKS delivered ---
    // The landing spot stays measured (claude init behavior), but the safety
    // property is asserted: the post-delivery verify must not return
    // `delivered-visible` — the round-9 landing (token stranded as composer
    // text) yields `stranded` (classifier not-clean via user-text); a vanished
    // token would yield `lost`. Either way the delivery is DETECTED as
    // not-delivered, on the live emulator and on the ring-replay recon.
    const pvBLive = postVerify(d.term, d.cols, d.rows, 'i8crash');
    const reconB = await reconFromRaw(d.rawLog, d.cols, d.rows);
    const pvBRecon = postVerify(reconB, d.cols, d.rows, 'i8crash');
    note('i8d-verdicts', `live=${pvBLive.verdict}(${pvBLive.cls.reason}) recon=${pvBRecon.verdict}(${pvBRecon.cls.reason})`);
    check('i8d-never-looks-delivered', pvBLive.verdict !== 'delivered-visible' && pvBRecon.verdict !== 'delivered-visible', `live=${pvBLive.verdict} recon=${pvBRecon.verdict}`);
    d.kill();
  }

  if (failures.length) {
    console.error(`FAILURES: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('ALL ASSERTIONS PASSED (case B landing spot measured; its never-looks-delivered property asserted)');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
