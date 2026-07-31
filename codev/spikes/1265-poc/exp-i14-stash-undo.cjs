/**
 * Spike 1265 — round 15 (architect request): mine the interactive-mode
 * reference for shortcuts the DELIVERY DESIGN should use (not just classify
 * defensively). Two candidates measured here:
 *
 *   ^S (chat:stash) — "with text in the input, stashes it and clears the
 *       prompt; pressed again on an empty prompt, restores the stashed text,
 *       cursor position, and pasted content." If real, the claude busy-line
 *       delivery becomes a STASH SANDWICH — ^S · msg · \r (pre-Enter gated) ·
 *       ^S — replacing H's destructive per-line clear + byte-replay: the
 *       draft is never destroyed (the app holds it), no kill-ring pollution
 *       (no kills at all), and content byte-replay can never reconstruct
 *       (image chips, pasted blobs — constraint 17a's byteless class)
 *       stashes natively. Bound on this box/version (live keybindings.json:
 *       ctrl+s → chat:stash, claude 2.1.212). Absent from agy's captured
 *       table (i13). Codex probed below.
 *   ^_ (chat:undo) — "restores the previous input text and cursor position."
 *       Candidate rollback for the pre-Enter abort path: today a failed
 *       equality gate strands the fused draft visible (i12c1 contract); a
 *       VERIFIED undo could clean that up.
 *
 * Cases:
 *   i14a  ASSERTED  single-line stash sandwich end-to-end: draft → ^S →
 *         rendered-empty (G-lite clean) → pre-Enter-gated delivery →
 *         delivered-verified (canon oracle) → ^S → draft restored exactly.
 *   i14b  ASSERTED  multi-line draft (typed \n newlines + a backspace edit):
 *         same sandwich, render-equality on the restored composer.
 *   i14c  MEASURED  stash-slot semantics: stash A, type B, stash B — is A
 *         overwritten (single slot ⇒ a user's prior stash would be DESTROYED
 *         by our maneuver ⇒ no-prior-^S precondition) or stacked?
 *   i14d  ASSERTED  undo rollback of an injected write: empty → write msg
 *         (no \r) → ^_ → rendered-empty again, nothing submitted.
 *         MEASURED  fused variant: write msg, foreign byte at +25 ms, ^_ —
 *         what state results (informs the abort path; any outcome recorded).
 *   i14e  (implicit) ^S under the real PTY write path — if ^S were eaten by
 *         termios flow control (IXON/XOFF) the session output would freeze
 *         and every settle below would time out loudly. rawLog growth after
 *         each ^S is asserted in i14a.
 *   i14f  MEASURED  codex ^S probe (scratch dead-provider home): does codex
 *         stash, ignore, or do something else? (agy: no stash in its table,
 *         i13 — cited, not re-probed.)
 *
 * Claude runs against a dead ANTHROPIC_BASE_URL (zero API calls); codex runs
 * in the i12d scratch-home dead-provider rig (zero traffic).
 *
 * Usage: node exp-i14-stash-undo.cjs claude
 *        node exp-i14-stash-undo.cjs codex
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TuiDriver, KEYS, sleep, show, Terminal } = require('./harness.cjs');

const which = process.argv[2] || 'claude';
const DEAD = 'http://127.0.0.1:9';
const CTRL_S = '\x13';
const CTRL_UNDERSCORE = '\x1f';

const failures = [];
function check(label, ok, detail) {
  console.log(`ASSERT ${label}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
  if (!ok) failures.push(label);
}
function note(label, detail) { console.log(`MEASURED ${label}: ${detail}`); }

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
  const IGNORE_CHARS = new Set(['❯', '›', '│', '▌', '─', '━', '╌', '┄', '╭', '╰', '┌', '└', '']);
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

function composerText(term, rows) {
  const lines = screenOfTerm(term, rows);
  let markerRow = -1;
  for (let i = 0; i < lines.length; i++) if (/^[❯›]/.test(lines[i])) markerRow = i;
  if (markerRow === -1) return null;
  let endRow = lines.length;
  for (let i = markerRow + 1; i < lines.length; i++) {
    if (/^[─━╌┄]{5,}/.test(lines[i]) || /^\s{2,}(gpt|high:|~\/)/.test(lines[i])) { endRow = i; break; }
  }
  return lines.slice(markerRow, endRow)
    .map((l) => l.replace(/^[❯›]\s?/, ''))
    .join('\n')
    .trim();
}

const ALNUM = /[\p{L}\p{N}]/u;
const canon = (s) => s.replace(/\s+/gu, '');
function canonState(term, rows, message) {
  const buf = term.buffer.active;
  const viewport = screenOfTerm(term, rows);
  let markerRow = -1;
  for (let i = 0; i < viewport.length; i++) if (/^[❯›]/.test(viewport[i])) markerRow = i;
  const top = buf.viewportY;
  const composerStartAbs = markerRow >= 0 ? top + markerRow : Infinity;
  const parts = [];
  for (let i = 0; i < buf.length && i < composerStartAbs; i++) {
    const line = buf.getLine(i);
    if (line) parts.push(line.translateToString(true));
  }
  const hay = canon(parts.join('\n'));
  const needle = canon(message);
  let raw = 0, exact = 0;
  if (needle.length > 0) {
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
      raw++;
      const b = i > 0 ? hay[i - 1] : '';
      const a = i + needle.length < hay.length ? hay[i + needle.length] : '';
      if (!ALNUM.test(b) && !ALNUM.test(a)) exact++;
    }
  }
  return { raw, exact, markerPresent: markerRow >= 0 };
}

async function reconFromRaw(rawChunks, cols, rows) {
  const t = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
  await new Promise((r) => t.write(rawChunks.join(''), r));
  return t;
}

async function preEnterGate(d, message, { sampleMs = 40, timeoutMs = 2500 } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(sampleMs);
    const recon = await reconFromRaw(d.rawLog, d.cols, d.rows);
    last = composerText(recon, d.rows);
    recon.dispose?.();
    if (last !== null && last === message.trim()) return { ok: true, ms: Date.now() - t0, composer: last };
  }
  return { ok: false, ms: Date.now() - t0, composer: last };
}

async function freshClaude(label) {
  const d = new TuiDriver('claude', [], { label, env: { ANTHROPIC_BASE_URL: DEAD } });
  await d.settle(2000, 40000);
  await sleep(1200);
  return d;
}

(async () => {
  if (which === 'claude') {
    // ================= i14a: single-line stash sandwich =====================
    {
      const d = await freshClaude('expI14a');
      const DRAFT = 'i14draft alpha status';
      const MSG = '[architect] i14a stash-sandwich probe';
      await d.type(DRAFT);
      await sleep(600);
      const preStash = composerText(d.term, d.rows);
      check('i14a-draft-on-line', preStash === DRAFT, `composer=${JSON.stringify(preStash)} — the busy-line starting state`);

      const rawBefore = d.rawLog.length;
      d.send(CTRL_S); // stash
      await d.settle(800, 15000); await sleep(400);
      check('i14a-output-alive-after-ctrl-s', d.rawLog.length > rawBefore, `${d.rawLog.length - rawBefore} chunks after ^S — no IXON/XOFF freeze on the PTY path`);
      const stashRecon = await reconFromRaw(d.rawLog, d.cols, d.rows);
      const stashCls = classifyTerm(stashRecon, d.cols, d.rows);
      check('i14a-stash-clears-rendered', stashCls.clean === true, `post-^S G-lite=${stashCls.reason} — the stash empties the rendered composer (the gate would now pass)`);

      const kPre = d.rawLog.length;
      const preRecon = await reconFromRaw(d.rawLog.slice(0, kPre), d.cols, d.rows);
      d.send(MSG);
      const gate = await preEnterGate(d, MSG);
      check('i14a-preenter-passes', gate.ok === true, `equality in ${gate.ms} ms on the stash-emptied composer`);
      d.send('\r');
      await d.settle(1500, 20000); await sleep(800);
      const postRecon = await reconFromRaw(d.rawLog, d.cols, d.rows);
      const cs = canonState(postRecon, d.rows, MSG);
      const csPre = canonState(preRecon, d.rows, MSG);
      check('i14a-delivered-verified', cs.exact === csPre.exact + 1, `canon exact ${csPre.exact}→${cs.exact} — the sandwiched delivery submitted clean`);

      d.send(CTRL_S); // restore
      await d.settle(1000, 15000); await sleep(500);
      d.snapshot('i14a-after-restore');
      const restored = composerText(d.term, d.rows);
      check('i14a-draft-restored-exact', restored === DRAFT, `composer=${JSON.stringify(restored)} — the stashed draft came back byte-identical in the render`);
      const csAfter = canonState(await reconFromRaw(d.rawLog, d.cols, d.rows), d.rows, DRAFT);
      check('i14a-draft-not-submitted', csAfter.raw === 0, `draft occurrences in transcript=${csAfter.raw} — restore did not submit anything`);
      d.kill();
    }

    // ================= i14b: multi-line draft sandwich ======================
    {
      const d = await freshClaude('expI14b');
      const MSG = '[architect] i14b multiline sandwich probe';
      // Draft with a newline structure and a live edit (h3's shape, smaller).
      await d.type('check the tower logs');
      d.send('\n'); await sleep(120);
      await d.type('then restart nothing');
      for (let i = 0; i < 7; i++) { d.send(KEYS.BACKSPACE); await sleep(60); } // "nothing" → ""
      await d.type('yet');
      d.send('\n'); await sleep(120);
      await d.type('ping me after');
      await sleep(700);
      const refDraft = composerText(d.term, d.rows);
      check('i14b-draft-built', refDraft !== null && refDraft.includes('yet') && refDraft.includes('ping me after'), `draft=${JSON.stringify(refDraft)}`);

      d.send(CTRL_S);
      await d.settle(800, 15000); await sleep(400);
      const stashCls = classifyTerm(d.term, d.cols, d.rows);
      check('i14b-stash-clears-rendered', stashCls.clean === true, `post-^S G-lite=${stashCls.reason} — multi-line draft stashed whole`);

      const kPre = d.rawLog.length;
      const preRecon = await reconFromRaw(d.rawLog.slice(0, kPre), d.cols, d.rows);
      d.send(MSG);
      const gate = await preEnterGate(d, MSG);
      check('i14b-preenter-passes', gate.ok === true, `equality in ${gate.ms} ms`);
      d.send('\r');
      await d.settle(1500, 20000); await sleep(800);
      const cs = canonState(await reconFromRaw(d.rawLog, d.cols, d.rows), d.rows, MSG);
      const csPre = canonState(preRecon, d.rows, MSG);
      check('i14b-delivered-verified', cs.exact === csPre.exact + 1, `canon exact ${csPre.exact}→${cs.exact}`);

      d.send(CTRL_S);
      await d.settle(1000, 15000); await sleep(500);
      d.snapshot('i14b-after-restore');
      const restored = composerText(d.term, d.rows);
      check('i14b-draft-restored-exact', restored === refDraft, `restored=${JSON.stringify(restored)} vs ref=${JSON.stringify(refDraft)} — render-equality across the sandwich (edited multi-line draft)`);
      d.kill();
    }

    // ================= i14c: stash-slot semantics (MEASURED) ================
    {
      const d = await freshClaude('expI14c');
      await d.type('slotprobe AAA');
      await sleep(500);
      d.send(CTRL_S); await d.settle(800, 15000); await sleep(300);
      await d.type('slotprobe BBB');
      await sleep(500);
      d.send(CTRL_S); await d.settle(800, 15000); await sleep(300); // stash while slot occupied
      d.send(CTRL_S); await d.settle(800, 15000); await sleep(300); // restore — which one?
      const first = composerText(d.term, d.rows);
      note('i14c-first-restore', `${JSON.stringify(first)}`);
      // Clear what came back (^S again re-stashes it — use double-ESC? no: just stash it away) and probe once more.
      d.send(CTRL_S); await d.settle(800, 15000); await sleep(300); // stash it back
      d.send(CTRL_S); await d.settle(800, 15000); await sleep(300); // restore again
      const second = composerText(d.term, d.rows);
      note('i14c-second-restore', `${JSON.stringify(second)}`);
      const aaaGone = first !== null && !first.includes('AAA') && (second === null || !second.includes('AAA'));
      note('i14c-slot-semantics', aaaGone
        ? 'SINGLE-SLOT OVERWRITE — stashing while the slot is occupied DESTROYS the earlier stash (AAA unrecoverable). S-form precondition: no user ^S tracked this session.'
        : `slot appears to retain AAA somewhere (first=${JSON.stringify(first)}, second=${JSON.stringify(second)}) — semantics richer than single-slot; enumerate before relying on it`);
      d.snapshot('i14c-slot-probe-end');
      d.kill();
    }

    // ================= i14d: undo as abort rollback ========================
    {
      const d = await freshClaude('expI14d');
      const MSG = '[architect] i14d undo-rollback probe';
      const cls0 = classifyTerm(d.term, d.cols, d.rows);
      check('i14d-starts-clean', cls0.clean === true, `boot composer=${cls0.reason}`);

      d.send(MSG); // the injected text write, one write() — no Enter ever sent
      await sleep(700);
      const afterWrite = composerText(d.term, d.rows);
      check('i14d-write-rendered', afterWrite === MSG, `composer=${JSON.stringify(afterWrite)}`);
      d.send(CTRL_UNDERSCORE); // undo the injected edit
      await d.settle(800, 15000); await sleep(400);
      const clsUndo = classifyTerm(d.term, d.cols, d.rows);
      const csUndo = canonState(await reconFromRaw(d.rawLog, d.cols, d.rows), d.rows, MSG);
      check('i14d-undo-rolls-back', clsUndo.clean === true && csUndo.raw === 0,
        `post-^_ composer=${clsUndo.reason}, transcript occurrences=${csUndo.raw} — one undo reverts one injected write, nothing submitted`);

      // Fused variant (MEASURED): write + foreign byte, then undo — what remains?
      d.send(MSG);
      await sleep(25);
      d.send('X');
      await sleep(700);
      const fused = composerText(d.term, d.rows);
      d.send(CTRL_UNDERSCORE);
      await d.settle(800, 15000); await sleep(400);
      const afterUndo = composerText(d.term, d.rows);
      d.send(CTRL_UNDERSCORE);
      await d.settle(800, 15000); await sleep(400);
      const afterUndo2 = composerText(d.term, d.rows);
      note('i14d-fused-undo', `fused=${JSON.stringify(fused)} → ^_ → ${JSON.stringify(afterUndo)} → ^_ → ${JSON.stringify(afterUndo2)} — undo granularity under interleave (abort path must verify the render, never assume)`);
      const csEnd = canonState(await reconFromRaw(d.rawLog, d.cols, d.rows), d.rows, MSG);
      check('i14d-fused-nothing-submitted', csEnd.raw === 0, `transcript occurrences=${csEnd.raw} — no submit happened during the fused-undo probe`);
      d.snapshot('i14d-end');
      d.kill();
    }
  }

  if (which === 'codex') {
    // ================= i14f: codex ^S probe (MEASURED) ======================
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'i14-codex-home-'));
    fs.writeFileSync(path.join(home, 'config.toml'), [
      'model = "gpt-5"',
      'model_provider = "dead"',
      '[model_providers.dead]',
      'name = "dead"',
      `base_url = "${DEAD}/v1"`,
      'wire_api = "responses"',
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-dead-i14' }) + '\n');

    const d = new TuiDriver('codex', [], { label: 'expI14f', env: { CODEX_HOME: home } });
    await d.settle(2000, 40000);
    await sleep(1200);
    for (let round = 0; round < 5; round++) {
      const text = d.screenText();
      if (/Press enter to continue/i.test(text)) { d.send('\r'); }
      else if (/allow codex|trust this (folder|directory)|do you trust/i.test(text)) { d.send('\r'); }
      else break;
      await d.settle(1500, 20000); await sleep(600);
    }
    await d.type('i14f codex stash probe');
    await sleep(600);
    const before = composerText(d.term, d.rows);
    const rawBefore = d.rawLog.length;
    d.send(CTRL_S);
    await d.settle(1000, 15000); await sleep(500);
    const after = composerText(d.term, d.rows);
    note('i14f-codex-ctrl-s', `composer before=${JSON.stringify(before)} after=${JSON.stringify(after)} (${d.rawLog.length - rawBefore} chunks) — ${before === after ? 'NO visible stash action on codex defaults' : 'composer CHANGED — enumerate before use'}`);
    d.send(CTRL_S);
    await d.settle(1000, 15000); await sleep(500);
    note('i14f-codex-ctrl-s-again', `composer=${JSON.stringify(composerText(d.term, d.rows))}`);
    d.snapshot('i14f-end');
    d.kill();
  }

  if (failures.length) {
    console.error(`FAILURES: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nALL ASSERTIONS PASSED');
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
