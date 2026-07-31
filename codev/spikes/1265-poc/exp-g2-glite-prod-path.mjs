/**
 * Spike 1265 — review round 8, concerns 3/4/5: G-lite on the PRODUCTION data
 * path, with no user keystroke involved.
 *
 * Earlier rounds demonstrated composer extraction against the harness's own
 * @xterm/headless screen — but production Tower stores raw ANSI in a
 * line-split RingBuffer (packages/codev/src/terminal/ring-buffer.ts) and
 * ships no renderer. This experiment drives the REAL RingBuffer class
 * (imported via --experimental-strip-types, like exp-w1 did message-write.ts)
 * and reconstructs the screen exactly the way a reconnecting production
 * client does: `ring.getAll().join('\n')` written into a fresh terminal
 * (tower-websocket.ts:66-67). The classifier then answers "is the composer
 * provably empty?" from that reconstruction alone — the output-side
 * convergence signal that requires no human typist (round-8 concern 4:
 * builder terminals have none).
 *
 * Classifier shape (fail-toward-dirty): CLEAN requires (a) a recognized
 * composer marker on the reconstructed screen, and (b) zero non-dim,
 * non-marker cells in the composer region — the placeholder-vs-user-text
 * distinction is an SGR attribute (measured here: both TUIs render rotating
 * placeholder text DIM; typed text is normal-intensity), so no placeholder
 * allowlist is needed (round-4's placeholder-rotation flake does not apply).
 * Anything unrecognized → NOT clean → stay dirty → K. Never inject.
 *
 * Cases (fresh TUI session per case; claude on a dead ANTHROPIC_BASE_URL):
 *   g2a claude: idle-empty  → recon composer == live composer; classifier CLEAN
 *                             (asserts the placeholder-dim hypothesis)
 *   g2b claude: 2-line draft → recon shows draft; classifier NOT-clean
 *   g2c claude: slash-menu   → classifier NOT-clean ('/mod' is user text)
 *   g2d claude: stream-shape + truncation — MEASURED: claude emits no '\n'
 *               at all (ring lines=0; everything accumulates in the unbounded
 *               `partial`, the #1047 full-screen basin), so line-capacity
 *               wrap cannot occur; the production truncation mechanism is
 *               capRingSeed's arbitrary BYTE cut (tower-terminals.ts:40-44),
 *               exercised here at a mid-sequence offset → still classifies
 *               correctly (churned-empty, draft, and byte-cut variants)
 *   g2e claude: resize-nudge variant — reconstruct from ONLY the bytes
 *               emitted after a cols-1/cols+0 resize jiggle (the production
 *               post-connect repaint nudge, shellper-client.ts:178): correct
 *               with zero history; and the nudge is occupancy-neutral
 *               (live composer identical before/after)
 *   g2f codex: idle-empty  → CLEAN (recon == live)
 *   g2g codex: draft       → NOT-clean
 *   g2h codex: ESC on empty composer — measures whether the round-1 tip's
 *               "edit last message" arming renders a visible signature on a
 *               fresh session (recon fidelity asserted; the mode-visibility
 *               outcome is MEASURED and reported, feeding the round-8
 *               convergence-safety analysis)
 *
 * Self-asserting: exit 1 on any assertion failure.
 *
 * Usage: XTERM_DIR=... node --experimental-transform-types exp-g2-glite-prod-path.mjs claude|codex
 * (transform-types, not strip-types: ring-buffer.ts uses a constructor
 *  parameter property, which strip-only mode rejects)
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { TuiDriver, KEYS, sleep } = require('./harness.cjs');

// Real production RingBuffer (zero-import TS, loaded like exp-w1 loaded
// message-write.ts — but via transform-types; see usage note).
const { RingBuffer } = await import(
  path.join(here, '..', '..', '..', 'packages', 'codev', 'src', 'terminal', 'ring-buffer.ts')
);

// Headless terminal for the reconstruction side (same resolution as harness).
function resolveXterm() {
  const dirs = [];
  if (process.env.XTERM_DIR) dirs.push(path.join(process.env.XTERM_DIR, 'node_modules'));
  dirs.push(path.join(here, '..', '..', '..', 'packages', 'codev', 'node_modules'));
  for (const dir of dirs) {
    try { return createRequire(path.join(dir, 'noop.js'))('@xterm/headless'); } catch { /* next */ }
  }
  return require('@xterm/headless');
}
const { Terminal } = resolveXterm();

const which = process.argv[2] || 'claude';
const DEAD = 'http://127.0.0.1:9';
const COLS = 110, ROWS = 32;

const failures = [];
function check(label, ok, detail) {
  console.log(`ASSERT ${label}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
  if (!ok) failures.push(label);
}
function note(label, detail) {
  console.log(`MEASURED ${label}: ${detail}`);
}

// --------------------------------------------------------------------------
// Reconstruction: raw chunks → REAL RingBuffer (per-chunk pushData, as
// pty-session.ts:360 does) → getAll().join('\n') (tower-websocket.ts:67)
// → fresh headless terminal.
// --------------------------------------------------------------------------
async function reconstruct(chunks, capacity = 1000) {
  const ring = new RingBuffer(capacity);
  for (const c of chunks) ring.pushData(c);
  const replay = ring.getAll().join('\n');
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 2000 });
  await new Promise((r) => term.write(replay, r));
  return { term, ring, replayBytes: replay.length };
}

function screenOf(term) {
  const buf = term.buffer.active;
  const lines = [];
  const top = buf.viewportY;
  for (let i = 0; i < ROWS; i++) {
    const line = buf.getLine(top + i);
    lines.push(line ? line.translateToString(true).trimEnd() : '');
  }
  return lines;
}

// Same composer extraction the asserted experiments use.
function composerText(lines) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (/^[❯›]/.test(lines[i])) start = i;
  if (start === -1) return '<NO-MARKER>';
  const out = [];
  for (let i = start; i < lines.length; i++) {
    if (/^[─━╌┄]{5,}/.test(lines[i]) || /^\s{2,}(gpt|high:|~\/)/.test(lines[i])) break;
    out.push(lines[i].replace(/^[❯›]\s?/, ''));
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n').trimEnd();
}

// --------------------------------------------------------------------------
// Classifier: CLEAN ⇔ composer marker found AND zero non-dim user-text cells
// in the composer region. Fail-toward-dirty: no marker, unparseable region,
// or any normal-intensity text → NOT clean.
// --------------------------------------------------------------------------
const IGNORE_CHARS = new Set(['❯', '›', '│', '▌', '─', '━', '╌', '┄', '╭', '╰', '┌', '└', '']);

function classify(term) {
  const buf = term.buffer.active;
  const lines = screenOf(term);
  let markerRow = -1;
  for (let i = 0; i < lines.length; i++) if (/^[❯›]/.test(lines[i])) markerRow = i;
  if (markerRow === -1) return { clean: false, reason: 'no-composer-marker', userCells: -1 };

  // Region rows: marker row through the next rule/status line (same bounds as
  // composerText), scanned at the CELL level for attributes.
  let endRow = lines.length;
  for (let i = markerRow + 1; i < lines.length; i++) {
    if (/^[─━╌┄]{5,}/.test(lines[i]) || /^\s{2,}(gpt|high:|~\/)/.test(lines[i])) { endRow = i; break; }
  }
  const top = buf.viewportY;
  let userCells = 0;
  const samples = [];
  const cell = buf.getNullCell();
  for (let row = markerRow; row < endRow; row++) {
    const line = buf.getLine(top + row);
    if (!line) continue;
    for (let col = 0; col < COLS; col++) {
      line.getCell(col, cell);
      const ch = cell.getChars();
      if (!ch || /^\s+$/u.test(ch) || IGNORE_CHARS.has(ch)) continue; // all whitespace incl. NBSP
      if (row === markerRow && col === 0) continue; // the marker glyph itself
      if (cell.isDim()) continue; // placeholder / hint chrome renders dim
      userCells++;
      if (samples.length < 12) samples.push(ch);
    }
  }
  return { clean: userCells === 0, reason: userCells === 0 ? 'empty' : 'user-text', userCells, samples: samples.join('') };
}

// Attribute report for the composer region (placeholder-dim measurement).
function attributeReport(term) {
  const buf = term.buffer.active;
  const lines = screenOf(term);
  let markerRow = -1;
  for (let i = 0; i < lines.length; i++) if (/^[❯›]/.test(lines[i])) markerRow = i;
  if (markerRow === -1) return 'no-marker';
  const top = buf.viewportY;
  const line = buf.getLine(top + markerRow);
  const cell = buf.getNullCell();
  const runs = [];
  let cur = null;
  for (let col = 0; col < COLS; col++) {
    line.getCell(col, cell);
    const ch = cell.getChars();
    if (!ch || ch === ' ') continue;
    const key = `dim=${cell.isDim() ? 1 : 0} bold=${cell.isBold() ? 1 : 0} fgMode=${cell.getFgColorMode()} fg=${cell.getFgColor()}`;
    if (cur && cur.key === key) { cur.text += ch; } else { cur = { key, text: ch }; runs.push(cur); }
  }
  return runs.map((r) => `[${JSON.stringify(r.text.slice(0, 24))} ${r.key}]`).join(' ');
}

// --------------------------------------------------------------------------
// Session helpers
// --------------------------------------------------------------------------
async function freshSession(label, opts = {}) {
  const env = which === 'claude' ? { ANTHROPIC_BASE_URL: DEAD, ...(opts.env ?? {}) } : { ...(opts.env ?? {}) };
  const d = new TuiDriver(which, [], { label, env, cols: COLS, rows: ROWS });
  await d.settle(2000, 40000);
  await sleep(1200);
  if (which === 'codex' && d.screenText().includes('Press enter to continue')) {
    d.send('3'); await sleep(300); d.send('\r');
    await d.settle(2000, 40000); await sleep(800);
  }
  return d;
}

async function settled(d, quiet = 900) {
  await d.settle(quiet, 15000);
  return composerText(d.screen());
}

// --------------------------------------------------------------------------
(async () => {
  // ---- g2a / g2f: idle-empty --------------------------------------------
  {
    const d = await freshSession(`expG2a-${which}`);
    const live = await settled(d);
    const { term, ring, replayBytes } = await reconstruct(d.rawLog);
    const recon = composerText(screenOf(term));
    const verdict = classify(term);
    note(`${which}-idle-attrs`, attributeReport(term));
    note(`${which}-idle-ring`, `lines=${ring.size} partialBytes=${ring.partialBytes} replayBytes=${replayBytes}`);
    check(`g2-${which}-idle-recon-matches-live`, recon === live, `recon=${JSON.stringify(recon.slice(0, 60))} live=${JSON.stringify(live.slice(0, 60))}`);
    check(`g2-${which}-idle-clean`, verdict.clean === true, `verdict=${JSON.stringify(verdict)}`);
    d.snapshot('g2-idle');
    d.kill();
  }

  // ---- g2b / g2g: multi-line draft --------------------------------------
  {
    const d = await freshSession(`expG2b-${which}`);
    await settled(d);
    await d.type('kqzvbn wmxdrf');
    d.send(KEYS.ALT_ENTER); await sleep(120);
    await d.type('ptljh gsvycq');
    const live = await settled(d);
    const { term } = await reconstruct(d.rawLog);
    const recon = composerText(screenOf(term));
    const verdict = classify(term);
    note(`${which}-draft-attrs`, attributeReport(term));
    check(`g2-${which}-draft-recon-matches-live`, recon === live, `recon=${JSON.stringify(recon)} live=${JSON.stringify(live)}`);
    check(`g2-${which}-draft-recon-shows-draft`, recon.includes('kqzvbn') && recon.includes('ptljh'), `recon=${JSON.stringify(recon)}`);
    check(`g2-${which}-draft-not-clean`, verdict.clean === false && verdict.userCells > 0, `verdict=${JSON.stringify(verdict)}`);
    d.snapshot('g2-draft');
    d.kill();
  }

  // Claude-only structural cases (wrap/truncation/nudge/menu); codex gets the
  // ESC-on-empty measurement instead.
  if (which === 'claude') {
    // ---- g2c: slash-menu open -------------------------------------------
    {
      const d = await freshSession('expG2c-claude');
      await settled(d);
      await d.type('/mod');
      await settled(d);
      const { term } = await reconstruct(d.rawLog);
      const verdict = classify(term);
      const reconScreen = screenOf(term).join('\n');
      check('g2-claude-menu-not-clean', verdict.clean === false, `verdict=${JSON.stringify(verdict)}`);
      check('g2-claude-menu-visible-in-recon', reconScreen.includes('/mod'), 'menu filter text present in reconstruction');
      d.snapshot('g2-menu');
      d.kill();
    }

    // ---- g2d: the newline-free stream + arbitrary byte truncation -------
    // First run MEASURED that claude's TUI emits no '\n' at all: the ring
    // holds zero complete lines and the whole session accumulates in the
    // unbounded `partial` (exactly the #1047 full-screen-TUI basin the
    // RingBuffer comments describe). So line-capacity wrap CANNOT truncate a
    // claude stream — the production truncation mechanism for such sessions
    // is capRingSeed's byte cut (tower-terminals.ts:40-44), which this case
    // exercises at an arbitrary (likely mid-escape-sequence) offset.
    {
      const d = await freshSession('expG2d-claude');
      await settled(d);
      // Churn activity so the accumulated stream is substantial.
      for (let round = 0; round < 6; round++) {
        await d.type(`churn${round} aaaa bbbb cccc dddd`, 8);
        d.send(KEYS.ALT_ENTER); await sleep(60);
        await d.type('second line of churn', 8);
        for (let i = 0; i < 3; i++) {
          d.send(KEYS.CTRL_E); await sleep(35);
          d.send(KEYS.CTRL_U); await sleep(35);
          d.send(KEYS.BACKSPACE); await sleep(35);
        }
        await sleep(120);
      }
      const liveEmpty = await settled(d);
      const { term: t1, ring: r1 } = await reconstruct(d.rawLog, 60);
      note('claude-stream-shape', `ringLines=${r1.size} seq=${r1.currentSeq} partialBytes=${r1.partialBytes}`);
      check('g2-claude-stream-newline-free', r1.size === 0 && r1.partialBytes > 8000, `lines=${r1.size} partialBytes=${r1.partialBytes} — claude output accumulates in the unbounded partial (#1047 basin); line-capacity wrap cannot occur`);
      const recon1 = composerText(screenOf(t1));
      const v1 = classify(t1);
      check('g2-claude-churned-empty-recon-matches-live', recon1 === liveEmpty, `recon=${JSON.stringify(recon1.slice(0, 60))} live=${JSON.stringify(liveEmpty.slice(0, 60))}`);
      check('g2-claude-churned-empty-clean', v1.clean === true, `verdict=${JSON.stringify(v1)}`);

      // Draft on top of the churned stream.
      await d.type('zvqnrw draft after churn');
      const liveDraft = await settled(d);
      const { term: t2 } = await reconstruct(d.rawLog, 60);
      const v2 = classify(t2);
      check('g2-claude-churned-draft-recon-matches-live', composerText(screenOf(t2)) === liveDraft, '');
      check('g2-claude-churned-draft-not-clean', v2.clean === false, `verdict=${JSON.stringify(v2)}`);

      // Arbitrary BYTE truncation (capRingSeed cuts mid-anything, then the
      // stream is pushData'd — tower-terminals.ts:40-44 + pty-session.ts:188).
      const all = d.rawLog.join('');
      const cut = all.slice(Math.max(0, all.length - 40000) + 137); // odd offset, likely mid-sequence
      const { term: t3 } = await reconstruct([cut], 1000);
      const v3 = classify(t3);
      check('g2-claude-bytecut-draft-recon-matches-live', composerText(screenOf(t3)) === liveDraft, `recon=${JSON.stringify(composerText(screenOf(t3)).slice(0, 60))}`);
      check('g2-claude-bytecut-not-clean', v3.clean === false, `verdict=${JSON.stringify(v3)}`);
      d.snapshot('g2-churn');
      d.kill();
    }

    // ---- g2e: resize-nudge — fresh frame with ZERO history --------------
    {
      const d = await freshSession('expG2e-claude');
      await settled(d);
      await d.type('mfhkzt nudge draft');
      const liveBefore = await settled(d);
      const markStart = d.rawLog.length;
      d.proc.resize(COLS - 1, ROWS); await d.settle(700, 10000);
      d.proc.resize(COLS, ROWS); await d.settle(900, 12000);
      const liveAfter = composerText(d.screen());
      const postNudge = d.rawLog.slice(markStart);
      // Keep only the bytes emitted at the FINAL size (after the back-resize):
      // a client reconstructs at one size; find the tail after the second
      // resize by locating the last chunk boundary before quiescence — the
      // whole post-nudge slice includes the cols-1 frame, so reconstruct from
      // the final repaint alone: drop chunks until the terminal is back at
      // COLS. Simplest faithful cut: feed everything post-nudge; the final
      // full repaint at COLS wins the screen.
      const { term } = await reconstruct(postNudge);
      const recon = composerText(screenOf(term));
      const verdict = classify(term);
      note('claude-nudge-bytes', `postNudgeChunks=${postNudge.length}`);
      check('g2-claude-nudge-occupancy-neutral', liveAfter === liveBefore, `before=${JSON.stringify(liveBefore)} after=${JSON.stringify(liveAfter)}`);
      check('g2-claude-nudge-recon-matches-live', recon === liveAfter, `recon=${JSON.stringify(recon)}`);
      check('g2-claude-nudge-not-clean', verdict.clean === false, `verdict=${JSON.stringify(verdict)}`);
      d.snapshot('g2-nudge');
      d.kill();
    }
  }

  if (which === 'codex') {
    // ---- g2h: ESC on an empty composer (fresh session, no history) ------
    {
      const d = await freshSession('expG2h-codex');
      await settled(d);
      const idleScreen = d.screen().join('\n');
      const idleComposer = composerText(d.screen());
      d.send(KEYS.ESC);
      await d.settle(900, 10000);
      const postScreen = d.screen().join('\n');
      const { term } = await reconstruct(d.rawLog);
      const recon = composerText(screenOf(term));
      const verdict = classify(term);
      const changed = postScreen !== idleScreen;
      note('codex-esc-on-empty', `screenChanged=${changed} idleComposer=${JSON.stringify(idleComposer.slice(0, 40))} verdict=${JSON.stringify(verdict)}`);
      if (changed) {
        // Show what changed (first differing lines) for the findings doc.
        const a = idleScreen.split('\n'), b = postScreen.split('\n');
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          if ((a[i] ?? '') !== (b[i] ?? '')) note('codex-esc-diff', `row${i}: ${JSON.stringify(a[i] ?? '')} -> ${JSON.stringify(b[i] ?? '')}`);
        }
      }
      check('g2-codex-esc-recon-matches-live', recon === composerText(d.screen()), `recon=${JSON.stringify(recon)}`);
      // Consistency: if the armed mode renders a signature, the classifier
      // must NOT report clean on it unless the signature is dim chrome only.
      // Either measured branch is a finding; assert internal consistency.
      check('g2-codex-esc-consistency', changed ? true : verdict.clean === true, `changed=${changed} verdict=${JSON.stringify(verdict)}`);
      d.snapshot('g2-esc');
      d.kill();
    }
  }

  if (failures.length) {
    console.error(`FAILURES: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('ALL ASSERTIONS PASSED');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
