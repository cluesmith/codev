/**
 * Spike 1265 — round 12, architect findings 1+2: the text→Enter gap is an
 * attach-reachable CORRUPTION window past a passing gate, and the round-11
 * differential verify is (a) suffix-blind, (b) structurally unable to match
 * production-formatted (multiline, wrapped) messages, (c) never asserted on
 * codex.
 *
 * Finding-1 mechanics: every submitting delivery is write(text) then
 * write('\r') 50 ms later (80 ms paced) — message-write.ts:72-80. Attach
 * (direct-socket) input is non-divertable and Tower-invisible (i11: attach
 * DATA executes on the PTY with zero tower frames — the byte stream shellper
 * writes to the PTY is IDENTICAL to any other writer's, so a plain PTY write
 * in the gap reproduces the attach case exactly; only the provenance
 * differs). A byte in the gap fuses into the submit: "messageX".
 *
 *   i12a mid-write fusion, single line — gate PASSES (empty composer), text
 *        written, 'X' lands at +25 ms, \r at +50 ms ⇒ transcript entry is
 *        "messageX". The round-11 differentialVerify (copied VERBATIM from
 *        exp-i10, the artifact under audit) checks only the PREFIX before the
 *        token (exp-i10:139) ⇒ returns delivered-verified: believed-sent
 *        corruption, the exact property violation. The corrected
 *        canonical-stream oracle (boundary-clean on BOTH sides) flags it.
 *   i12b production-formatted multiline — formatArchitectMessage shape
 *        (### header / body / ### footer, message-format.ts:23), one body
 *        line wider than the terminal, delivered production-paced
 *        (message-write.ts multi-line: line+\n at 10 ms gaps, \r at +80 ms).
 *        The round-11 oracle searches single buffer rows for the FULL
 *        message ⇒ can never match a multiline or renderer-wrapped message ⇒
 *        a genuinely delivered production message is permanently unverified.
 *        The canonical-stream oracle verifies it.
 *   i12c pre-Enter composer-equality check (the PREVENTION remedy): after
 *        the text write, poll the ring recon until the composer equals the
 *        message, and only then release Enter. Fused case: composer renders
 *        "messageX" ≠ message ⇒ Enter withheld ⇒ NOTHING submitted, fused
 *        draft stranded VISIBLE in the composer (fail-safe: occupancy holds
 *        followers; human resolves). Clean case: equality reached ⇒ Enter ⇒
 *        delivered. Converts the finding-1 race from detected-after to
 *        prevented-before for everything slower than the sample→Enter gap.
 *   i12d codex differential — dead-API submit rig (scratch CODEX_HOME,
 *        model_provider base_url → 127.0.0.1:9, fake API key; zero real
 *        traffic): if a submitted message renders a transcript entry, assert
 *        the canonical-stream positive branch AND the fused negative branch
 *        on codex. If the rig can't reach a submitted-entry state, record
 *        MEASURED and exit with the rig status — the doc then keeps codex
 *        differential validation as an open item.
 *
 * Canonical-stream oracle: transcript region only (composer excluded),
 * scrollback-inclusive, joined and WHITESPACE-STRIPPED — insensitive to the
 * renderer's own wrapping/indent/line-join decisions (claude re-wraps content
 * at its layout width WITHOUT terminal auto-wrap, so xterm isWrapped joining
 * is not sufficient). Verdict currency: boundary-clean occurrences of the
 * whitespace-stripped full message (no letter/digit adjacent on EITHER side —
 * the suffix side is the round-11 gap). delivered-verified ⇔ exactly one NEW
 * boundary-clean occurrence between gate render and verify render. Residual,
 * stated honestly: whitespace-only interleave canonicalizes away (content
 * preserved modulo spacing); cross-entry straddle matches are theoretical.
 *
 * Claude cases run against a dead ANTHROPIC_BASE_URL (submit mechanics real,
 * zero API calls). Codex runs against the dead scratch-home provider only.
 *
 * Self-asserting: exit 1 on any assertion failure. MEASURED lines are
 * exploratory-tier observations.
 *
 * Usage: node exp-i12-midwrite-fusion.cjs claude
 *        node exp-i12-midwrite-fusion.cjs codex
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TuiDriver, sleep, show, Terminal } = require('./harness.cjs');

const which = process.argv[2] || 'claude';
const DEAD = 'http://127.0.0.1:9';

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

// ---- Round-11 differential oracle, copied VERBATIM from exp-i10 (under audit) ----
const NO_USER_TEXT = /^[^\p{L}\p{N}]*$/u;

function entryLines(term, rows, token) {
  const buf = term.buffer.active;
  const top = buf.viewportY;
  const viewport = screenOfTerm(term, rows);
  let markerRow = -1;
  for (let i = 0; i < viewport.length; i++) if (/^[❯›]/.test(viewport[i])) markerRow = i;
  const composerStartAbs = markerRow >= 0 ? top + markerRow : Infinity;
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    if (i >= composerStartAbs) continue; // composer region is not transcript
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true).trimEnd();
    const idx = text.indexOf(token);
    if (idx === -1) continue;
    out.push({ text, exact: NO_USER_TEXT.test(text.slice(0, idx)) });
  }
  return { count: out.length, exactCount: out.filter((l) => l.exact).length, lines: out, markerPresent: markerRow >= 0 };
}

function differentialVerify(preTerm, postTerm, rows, token) {
  const pre = entryLines(preTerm, rows, token);
  const post = entryLines(postTerm, rows, token);
  const anywherePost = post.count > 0;
  let verdict;
  if (post.exactCount === pre.exactCount + 1) verdict = 'delivered-verified';
  else if (!anywherePost && !post.markerPresent) verdict = 'lost';
  else if (post.count > pre.count && post.exactCount === pre.exactCount) verdict = 'fused-suspect';
  else verdict = 'unverified';
  return { verdict, pre, post };
}

// ---- Round-12 corrected oracle: canonical-stream differential ---------------
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

function differentialVerifyCanon(preTerm, postTerm, rows, message) {
  const pre = canonState(preTerm, rows, message);
  const post = canonState(postTerm, rows, message);
  let verdict;
  if (post.exact === pre.exact + 1) verdict = 'delivered-verified';
  else if (post.raw === 0 && !post.markerPresent) verdict = 'lost'; // the i8c conjunction, unchanged
  else if (post.raw > pre.raw && post.exact === pre.exact) verdict = 'fused-suspect';
  else verdict = 'unverified';
  return { verdict, pre, post };
}

// ---- Pre-Enter composer-equality check (the prevention remedy, i12c) --------
function composerText(term, rows) {
  const lines = screenOfTerm(term, rows);
  let markerRow = -1;
  for (let i = 0; i < lines.length; i++) if (/^[❯›]/.test(lines[i])) markerRow = i;
  if (markerRow === -1) return null; // no composer ⇒ abort direction
  let endRow = lines.length;
  for (let i = markerRow + 1; i < lines.length; i++) {
    if (/^[─━╌┄]{5,}/.test(lines[i]) || /^\s{2,}(gpt|high:|~\/)/.test(lines[i])) { endRow = i; break; }
  }
  return lines.slice(markerRow, endRow)
    .map((l) => l.replace(/^[❯›]\s?/, ''))
    .join('\n')
    .trim();
}

async function reconFromRaw(rawChunks, cols, rows) {
  const t = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
  await new Promise((r) => t.write(rawChunks.join(''), r));
  return t;
}

/**
 * Production shape of the check: after the text write, poll the ring recon
 * every sampleMs; the FIRST sample whose composer equals the message releases
 * Enter (equality is the evidence — no second sample needed); persistent
 * inequality times out to abort-held. Returns {ok, ms, composer}.
 */
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

// message-write.ts single-line shape: text, \r at 50 ms.
async function towerDeliver(d, msg) {
  d.send(msg);
  await sleep(50);
  d.send('\r');
}

// message-write.ts multi-line paced shape: line+\n at 10 ms gaps, \r at +80 ms.
async function towerDeliverPaced(d, lines) {
  for (let i = 0; i < lines.length; i++) {
    d.send(i < lines.length - 1 ? lines[i] + '\n' : lines[i]);
    await sleep(10);
  }
  await sleep(70); // last-line write already slept 10 ⇒ Enter at +80 ms
  d.send('\r');
}

// Production-formatted message (formatArchitectMessage shape, message-format.ts:23).
// One body line wider than the 110-col terminal to force renderer wrapping.
const LONG_BODY = 'Line two carries a deliberately long tail to exceed the terminal width: ' + 'wrap'.repeat(22) + ' end.';
const PROD_LINES = [
  '### [ARCHITECT INSTRUCTION | 2026-07-31T12:00:00.000Z] ###',
  'Review the i12b delivery evidence run for spike 1265.',
  LONG_BODY,
  '###############################',
];
const PROD_MSG = PROD_LINES.join('\n');

(async () => {
  if (which === 'claude') {
    // ============ i12a: mid-write fusion past a PASSING gate =================
    {
      const d = await freshClaude('expI12a');
      const MSG = '[architect] i12afuse probe';
      const kPre = d.rawLog.length;
      const preRecon = await reconFromRaw(d.rawLog.slice(0, kPre), d.cols, d.rows);
      check('i12a-gate-clean', classifyTerm(preRecon, d.cols, d.rows).clean === true,
        'empty composer at gate time — the fusion below happens AFTER a passing gate (unlike i10b)');

      // The delivery under test, with an attach-shaped byte in the 50 ms gap.
      d.send(MSG);
      await sleep(25);
      d.send('X'); // i11 provenance: attach DATA is a plain PTY write Tower never sees
      await sleep(25);
      d.send('\r');
      await d.settle(1500, 20000); await sleep(800);
      d.snapshot('i12a-after-fused-submit');
      check('i12a-fused-submitted', d.screenText().includes(MSG + 'X'),
        'transcript entry is "messageX" — the gap byte was submitted WITH the message');

      const postRecon = await reconFromRaw(d.rawLog, d.cols, d.rows);
      const r11 = differentialVerify(preRecon, postRecon, d.rows, MSG);
      check('i12a-r11-oracle-suffix-blind', r11.verdict === 'delivered-verified',
        `round-11 differential=${r11.verdict} — prefix-only exactness blesses the fused submit: believed-sent corruption AS FACT`);
      const r12 = differentialVerifyCanon(preRecon, postRecon, d.rows, MSG);
      check('i12a-canon-oracle-flags', r12.verdict !== 'delivered-verified',
        `canonical-stream=${r12.verdict} (raw=${r12.post.raw}, exact=${r12.post.exact}) — boundary-clean on BOTH sides refuses the fusion`);
      d.kill();
    }

    // ============ i12b: production-formatted multiline delivery ==============
    {
      const d = await freshClaude('expI12b');
      const kPre = d.rawLog.length;
      const preRecon = await reconFromRaw(d.rawLog.slice(0, kPre), d.cols, d.rows);
      check('i12b-gate-clean', classifyTerm(preRecon, d.cols, d.rows).clean === true, 'empty composer at gate time');

      await towerDeliverPaced(d, PROD_LINES); // 4 lines ⇒ the paced production path
      await d.settle(1500, 25000); await sleep(800);
      d.snapshot('i12b-after-prod-delivery');
      check('i12b-delivered-for-real', d.screenText().includes('i12b delivery evidence'),
        'the production-formatted message rendered as a transcript entry');

      const postRecon = await reconFromRaw(d.rawLog, d.cols, d.rows);
      // Renderer wrapping evidence: no single buffer row carries the long body line.
      const buf = postRecon.buffer.active;
      let anyRowHasLongLine = false;
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line && line.translateToString(true).includes(LONG_BODY)) { anyRowHasLongLine = true; break; }
      }
      check('i12b-long-line-wrapped', anyRowHasLongLine === false,
        'the >110-col body line appears on NO single buffer row — renderer wrapping split it (per-row search cannot see it)');

      const r11 = differentialVerify(preRecon, postRecon, d.rows, PROD_MSG);
      check('i12b-r11-oracle-structurally-blind', r11.verdict !== 'delivered-verified',
        `round-11 differential=${r11.verdict} (post count=${r11.post.count}) — a genuinely delivered production message is permanently unverifiable by single-row full-message search`);
      const r12 = differentialVerifyCanon(preRecon, postRecon, d.rows, PROD_MSG);
      check('i12b-canon-oracle-verifies', r12.verdict === 'delivered-verified',
        `canonical-stream=${r12.verdict} (pre exact=${r12.pre.exact}, post exact=${r12.post.exact}) — whitespace-stripped block matched across header/body/footer AND the wrapped line`);
      d.kill();
    }

    // ============ i12c: pre-Enter equality — prevention, fused case ==========
    {
      const d = await freshClaude('expI12c1');
      const MSG = '[architect] i12cfuse probe';
      const kPre = d.rawLog.length;
      const preRecon = await reconFromRaw(d.rawLog.slice(0, kPre), d.cols, d.rows);
      check('i12c1-gate-clean', classifyTerm(preRecon, d.cols, d.rows).clean === true, 'empty composer at gate time');

      d.send(MSG);
      await sleep(25);
      d.send('X'); // the same attach-shaped gap byte
      const gate = await preEnterGate(d, MSG);
      check('i12c1-preenter-refuses', gate.ok === false,
        `pre-Enter equality FAILED in ${gate.ms} ms (composer=${JSON.stringify(gate.composer)}) — Enter withheld`);
      // No \r is ever sent. Assert nothing was submitted and the fused draft is visible.
      await d.settle(1500, 20000); await sleep(500);
      d.snapshot('i12c1-after-abort');
      const postRecon = await reconFromRaw(d.rawLog, d.cols, d.rows);
      const cState = canonState(postRecon, d.rows, MSG);
      check('i12c1-nothing-submitted', cState.raw === 0,
        `transcript region carries zero occurrences (raw=${cState.raw}) — the fused blob was NOT submitted`);
      const cls = classifyTerm(postRecon, d.cols, d.rows);
      check('i12c1-stranded-visible', cls.clean === false && cls.reason === 'user-text',
        `composer=${cls.reason} — the fused draft is stranded VISIBLE; occupancy holds followers; fail-safe direction`);
      d.kill();
    }

    // ============ i12c: pre-Enter equality — clean case delivers =============
    {
      const d = await freshClaude('expI12c2');
      const MSG = '[architect] i12cclean probe';
      const kPre = d.rawLog.length;
      const preRecon = await reconFromRaw(d.rawLog.slice(0, kPre), d.cols, d.rows);
      check('i12c2-gate-clean', classifyTerm(preRecon, d.cols, d.rows).clean === true, 'empty composer at gate time');

      d.send(MSG);
      const gate = await preEnterGate(d, MSG);
      check('i12c2-preenter-passes', gate.ok === true,
        `pre-Enter equality reached in ${gate.ms} ms — echo latency vs the fixed 50 ms budget, measured`);
      note('i12c2-echo-latency', `${gate.ms} ms from text write to composer==message (fixed production delay is 50 ms)`);
      d.send('\r');
      await d.settle(1500, 20000); await sleep(800);
      d.snapshot('i12c2-after-clean-delivery');
      const postRecon = await reconFromRaw(d.rawLog, d.cols, d.rows);
      const r12 = differentialVerifyCanon(preRecon, postRecon, d.rows, MSG);
      check('i12c2-delivered-verified', r12.verdict === 'delivered-verified',
        `canonical-stream=${r12.verdict} — the gated Enter delivers and verifies clean`);
      d.kill();
    }
  }

  if (which === 'codex') {
    // ============ i12d: codex differential via dead-API submit rig ===========
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'i12-codex-home-'));
    fs.writeFileSync(path.join(home, 'config.toml'), [
      'model = "gpt-5"',
      'model_provider = "dead"',
      '[model_providers.dead]',
      'name = "dead"',
      `base_url = "${DEAD}/v1"`,
      'wire_api = "responses"', // codex 0.146 rejects "chat" (config error at boot)
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-dead-i12' }) + '\n');
    note('i12d-rig', `scratch CODEX_HOME=${home} provider=dead base_url=${DEAD}/v1 (zero real traffic)`);

    async function deadCodexSession(label) {
      const d = new TuiDriver('codex', [], { label, env: { CODEX_HOME: home } });
      await d.settle(2000, 40000);
      await sleep(1200);
      // Fresh-home onboarding screens: press through generically, bounded rounds.
      for (let round = 0; round < 5; round++) {
        const text = d.screenText();
        if (/Press enter to continue/i.test(text)) { d.send('\r'); }
        else if (/allow codex|trust this (folder|directory)|do you trust/i.test(text)) { d.send('\r'); }
        else break;
        await d.settle(1500, 20000); await sleep(600);
      }
      return d;
    }

    // Rig probe: does a submitted message render a transcript entry at all?
    const probe = await deadCodexSession('expI12dProbe');
    probe.snapshot('i12d-probe-boot');
    const bootCls = classifyTerm(probe.term, probe.cols, probe.rows);
    if (!bootCls.clean) {
      show(probe.screen().filter((l) => l), 'i12d probe boot screen (composer not clean)');
      note('i12d-rig-status', `SKIPPED — scratch-home codex did not reach a clean composer (${bootCls.reason}); codex differential stays an open item`);
      probe.kill();
    } else {
      const PMSG = '[architect] i12d codex probe';
      await towerDeliver(probe, PMSG);
      await probe.settle(2500, 30000); await sleep(800);
      probe.snapshot('i12d-probe-after-submit');
      const entryRendered = canonState(probe.term, probe.rows, PMSG).raw > 0;
      probe.kill();
      if (!entryRendered) {
        note('i12d-rig-status', 'SKIPPED — submitted message rendered no transcript entry under the dead provider; codex differential stays an open item');
      } else {
        note('i12d-rig-status', 'LIVE — dead-provider codex renders submitted entries; asserting both branches');

        // Positive branch: production-formatted multiline delivery verifies.
        {
          const d = await deadCodexSession('expI12dPos');
          const kPre = d.rawLog.length;
          const preRecon = await reconFromRaw(d.rawLog.slice(0, kPre), d.cols, d.rows);
          check('i12d-pos-gate-clean', classifyTerm(preRecon, d.cols, d.rows).clean === true, 'empty composer at gate time');
          await towerDeliverPaced(d, PROD_LINES);
          await d.settle(2500, 30000); await sleep(800);
          d.snapshot('i12d-pos-after-prod-delivery');
          const postRecon = await reconFromRaw(d.rawLog, d.cols, d.rows);
          const r12 = differentialVerifyCanon(preRecon, postRecon, d.rows, PROD_MSG);
          check('i12d-pos-canon-verifies', r12.verdict === 'delivered-verified',
            `canonical-stream=${r12.verdict} (post exact=${r12.post.exact}) — codex positive differential on a production-formatted multiline message`);
          const r11 = differentialVerify(preRecon, postRecon, d.rows, PROD_MSG);
          note('i12d-pos-r11-verdict', `round-11 oracle says ${r11.verdict} on the same delivery (structural multiline blindness, codex arm)`);
          d.kill();
        }

        // Negative branch: mid-write fusion flagged, r11 suffix blindness on codex.
        {
          const d = await deadCodexSession('expI12dNeg');
          const MSG = '[architect] i12dfuse probe';
          const kPre = d.rawLog.length;
          const preRecon = await reconFromRaw(d.rawLog.slice(0, kPre), d.cols, d.rows);
          check('i12d-neg-gate-clean', classifyTerm(preRecon, d.cols, d.rows).clean === true, 'empty composer at gate time');
          d.send(MSG);
          await sleep(25);
          d.send('X');
          await sleep(25);
          d.send('\r');
          await d.settle(2500, 30000); await sleep(800);
          d.snapshot('i12d-neg-after-fused-submit');
          check('i12d-neg-fused-submitted', d.screenText().includes(MSG + 'X') || canonState(d.term, d.rows, MSG + 'X').raw > 0,
            'the gap byte fused into the codex submit');
          const postRecon = await reconFromRaw(d.rawLog, d.cols, d.rows);
          const r11 = differentialVerify(preRecon, postRecon, d.rows, MSG);
          note('i12d-neg-r11-verdict', `round-11 oracle on the fused codex submit: ${r11.verdict} (prefix-only exactness)`);
          const r12 = differentialVerifyCanon(preRecon, postRecon, d.rows, MSG);
          check('i12d-neg-canon-flags', r12.verdict !== 'delivered-verified',
            `canonical-stream=${r12.verdict} (raw=${r12.post.raw}, exact=${r12.post.exact}) — fusion refused on codex too`);
          d.kill();
        }
      }
    }
  }

  if (failures.length) {
    console.error(`FAILURES: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nALL ASSERTIONS PASSED');
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
