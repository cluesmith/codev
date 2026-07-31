/**
 * Spike 1265 — round 15 follow-up: i14a/b FAILED their restore assertions
 * (the post-submit ^S restored nothing) while i14c (no submit in between)
 * restored fine. This run pins the slot lifecycle and re-scopes ^S from
 * "stash SANDWICH" to "stash as CLEAR primitive".
 *
 *   g1  ASSERTED  control under a dim-aware extractor: draft → ^S → pause →
 *       ^S restores (re-verifies i14c; also proves the extractor fix — i14's
 *       composerText returned prompt-suggestion GHOST text because it did not
 *       filter dim cells, the same dim-placeholder family as g2).
 *   g2  ASSERTED  the diagnosis: draft → ^S → gated delivery submits → ^S →
 *       composer stays EMPTY (submit cleared the stash slot). The pre-restore
 *       screen is snapshotted so the state is on record.
 *   g3  MEASURED  what else clears the slot: draft → ^S → type other text →
 *       ^C (clears input, no submit) → ^S — does the original draft return?
 *   g4  ASSERTED  ^S as CLEAR at scale: a 40-line draft (the i7 shape, where
 *       bulk clear stalls beyond ~13 lines and the paced form needs 150 ms ×
 *       lines ≈ 6 s) → ONE ^S → rendered-empty, elapsed measured.
 *
 * Dead ANTHROPIC_BASE_URL throughout (zero API calls).
 *
 * Usage: node exp-i14g-stash-followup.cjs
 */
'use strict';
const { TuiDriver, sleep, Terminal } = require('./harness.cjs');

const DEAD = 'http://127.0.0.1:9';
const CTRL_S = '\x13';
const CTRL_C = '\x03';

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

/**
 * Dim-aware composer extraction: rebuild each composer-region row from cells,
 * skipping DIM cells (placeholder/suggestion ghosts) — the i14 extractor's
 * gap. Marker glyph stripped via the col-0 skip on the marker row.
 */
function composerTextND(term, cols, rows) {
  const buf = term.buffer.active;
  const lines = screenOfTerm(term, rows);
  let markerRow = -1;
  for (let i = 0; i < lines.length; i++) if (/^[❯›]/.test(lines[i])) markerRow = i;
  if (markerRow === -1) return null;
  let endRow = lines.length;
  for (let i = markerRow + 1; i < lines.length; i++) {
    if (/^[─━╌┄]{5,}/.test(lines[i]) || /^\s{2,}(gpt|high:|~\/)/.test(lines[i])) { endRow = i; break; }
  }
  const top = buf.viewportY;
  const cell = buf.getNullCell();
  const out = [];
  for (let row = markerRow; row < endRow; row++) {
    const line = buf.getLine(top + row);
    if (!line) { out.push(''); continue; }
    let text = '';
    for (let col = 0; col < cols; col++) {
      line.getCell(col, cell);
      const ch = cell.getChars();
      if (row === markerRow && col === 0) continue; // marker glyph
      if (cell.isDim()) continue;                    // ghost/placeholder cells
      text += ch || ' ';
    }
    out.push(text.replace(/^\s?/, '').trimEnd());   // marker's following space
  }
  return out.join('\n').trim();
}

function classifyTerm(term, cols, rows) {
  const buf = term.buffer.active;
  const lines = screenOfTerm(term, rows);
  let markerRow = -1;
  for (let i = 0; i < lines.length; i++) if (/^[❯›]/.test(lines[i])) markerRow = i;
  if (markerRow === -1) return { clean: false, reason: 'no-composer-marker' };
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

async function reconFromRaw(rawChunks, cols, rows) {
  const t = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
  await new Promise((r) => t.write(rawChunks.join(''), r));
  return t;
}

async function preEnterGate(d, message, { sampleMs = 40, timeoutMs = 2500 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(sampleMs);
    const recon = await reconFromRaw(d.rawLog, d.cols, d.rows);
    const last = composerTextND(recon, d.cols, d.rows);
    recon.dispose?.();
    if (last !== null && last === message.trim()) return { ok: true, ms: Date.now() - t0 };
  }
  return { ok: false, ms: Date.now() - t0 };
}

async function freshClaude(label) {
  const d = new TuiDriver('claude', [], { label, env: { ANTHROPIC_BASE_URL: DEAD } });
  await d.settle(2000, 40000);
  await sleep(1200);
  return d;
}

(async () => {
  // ================= g1: control — stash/restore, no submit =================
  {
    const d = await freshClaude('expI14g1');
    const DRAFT = 'g1 control draft';
    await d.type(DRAFT);
    await sleep(600);
    d.send(CTRL_S);
    await d.settle(800, 15000); await sleep(2000); // parked
    check('g1-stash-clears', classifyTerm(d.term, d.cols, d.rows).clean === true, 'rendered-empty while parked');
    d.send(CTRL_S);
    await d.settle(800, 15000); await sleep(500);
    const restored = composerTextND(d.term, d.cols, d.rows);
    check('g1-restore-works-no-submit', restored === DRAFT,
      `restored=${JSON.stringify(restored)} — slot survives idle parking (and the dim-aware extractor reads it clean)`);
    d.kill();
  }

  // ================= g2: the diagnosis — submit clears the slot =============
  {
    const d = await freshClaude('expI14g2');
    const DRAFT = 'g2 victim draft text';
    const MSG = '[architect] g2 probe message';
    await d.type(DRAFT);
    await sleep(600);
    d.send(CTRL_S);
    await d.settle(800, 15000); await sleep(400);
    check('g2-stash-clears', classifyTerm(d.term, d.cols, d.rows).clean === true, 'rendered-empty post-stash');
    d.send(MSG);
    const gate = await preEnterGate(d, MSG);
    check('g2-preenter-passes', gate.ok === true, `equality in ${gate.ms} ms`);
    d.send('\r');
    await d.settle(1500, 20000); await sleep(800);
    d.snapshot('g2-pre-restore');       // the state ^S is pressed into
    d.send(CTRL_S);
    await d.settle(1000, 15000); await sleep(500);
    d.snapshot('g2-post-restore');
    const after = composerTextND(d.term, d.cols, d.rows);
    check('g2-submit-cleared-slot', after === '' || after === null,
      `post-submit restore yields ${JSON.stringify(after)} — the SUBMIT cleared the stash slot: ^S is not a cross-submit restore primitive (i14a/b root cause, now isolated)`);
    d.kill();
  }

  // ================= g3: does non-submit activity clear it? (MEASURED) ======
  {
    const d = await freshClaude('expI14g3');
    const DRAFT = 'g3 parked draft';
    await d.type(DRAFT);
    await sleep(600);
    d.send(CTRL_S);
    await d.settle(800, 15000); await sleep(300);
    await d.type('interim text never submitted');
    await sleep(600);
    d.send(CTRL_C); // clears the input, no submit
    await d.settle(800, 15000); await sleep(400);
    const cleared = classifyTerm(d.term, d.cols, d.rows).clean;
    d.send(CTRL_S);
    await d.settle(800, 15000); await sleep(500);
    const after = composerTextND(d.term, d.cols, d.rows);
    note('g3-slot-after-type-and-ctrl-c-clear', `input-cleared=${cleared}; restore yields ${JSON.stringify(after)} — ${after === DRAFT ? 'slot SURVIVES non-submit composer activity (typing + ^C clear)' : 'slot cleared by non-submit activity too'}`);
    d.kill();
  }

  // ================= g4: ^S as CLEAR at scale (the i7 shape) ================
  {
    const d = await freshClaude('expI14g4');
    const LINES = 40;
    for (let i = 0; i < LINES; i++) {
      d.send(`line ${String(i).padStart(2, '0')} qfiller-xyz`);
      await sleep(30);
      if (i < LINES - 1) { d.send('\n'); await sleep(30); }
    }
    await d.settle(1200, 20000); await sleep(600);
    const cls0 = classifyTerm(d.term, d.cols, d.rows);
    check('g4-tall-draft-built', cls0.clean === false && cls0.reason === 'user-text',
      `composer=${cls0.reason} (${cls0.userCells} cells rendered) — a ${LINES}-line draft, past the ~13-line bulk-clear stall threshold`);
    const t0 = Date.now();
    d.send(CTRL_S);
    let cleared = false, elapsed = 0;
    while (Date.now() - t0 < 5000) {
      await sleep(100);
      if (classifyTerm(d.term, d.cols, d.rows).clean === true) { cleared = true; elapsed = Date.now() - t0; break; }
    }
    check('g4-one-byte-clear-at-scale', cleared === true,
      `rendered-empty ${elapsed} ms after ONE ^S on a ${LINES}-line draft — vs the paced per-line clear's ~${LINES * 150} ms and the >13-line bulk-clear stall (i7/i9c)`);
    d.snapshot('g4-after-clear');
    d.kill();
  }

  if (failures.length) {
    console.error(`FAILURES: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nALL ASSERTIONS PASSED');
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
