/**
 * Kimi composer box-growth measurement (PIR #1201, architect review finding 1).
 *
 * QUESTION THIS ANSWERS: does kimi's composer box ever grow past ONE interior row
 * for a reason other than a multi-line draft?
 *
 * Why it matters. `classifyBuffer` counts *cells* inside the composer region and
 * calls a zero-cell region CLEAN. Kimi's per-row marker exemption makes that
 * unsound for one draft shape: enter Shift+Enter then `>` and the screen is
 *
 *     │ >              <- row 1: empty
 *     │   >            <- row 2: matches KIMI_MARKER, so its `>` is span-exempted
 *
 * Every cell is either whitespace or exempt chrome → userCells 0 → CLEAN → held
 * mail is typed on top of unsent user input, the exact merge Spec 1313 exists to
 * prevent.
 *
 * The proposed fix reads GEOMETRY rather than cells: for a profile that declares
 * `regionStartPatterns` (kimi alone), a region spanning more than one interior row
 * is a multi-line draft by construction → busy regardless of what the cells say.
 * That is only sound if box growth is *exclusive* to multi-line drafts — a
 * non-draft state that grows the box would hold delivery forever (a liveness bug,
 * not a fail-safe one). Hence: measure before implementing.
 *
 * Geometry reported per state matches the classifier's own bounds exactly:
 *   startRow = (last box-top row) + 1     ... findRegionStart
 *   endRow   = first box-bottom row after the LAST marker row  ... findRegionEnd
 *   interior = endRow - startRow          ... the rows classifyBuffer scans
 *
 * States captured (the architect's required list, plus the two that decide liveness):
 *   idle             settled composer, nothing typed          expect interior 1
 *   draft            short single-line draft                  expect interior 1
 *   wrap             one long line, no spaces, soft-wrapped   informational: if this
 *                    grows the box it carries text and is busy either way
 *   menu             the "/" command list                     expect interior 1
 *   picker           the "@" file picker                      expect interior 1
 *   newline-bare     Shift+Enter then ">"  (THE false-CLEAN)  expect interior 2
 *   newline-only     Shift+Enter, nothing else                expect interior 2
 *   after-response   idle again after a real reply            expect interior 1 — this
 *                    is the builder's steady state; growth here would hold forever
 *
 * Usage:  node codev/spikes/pir-1201-kimi-box-growth.mjs [outDir]
 */

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pty = require(join(repoRoot, 'packages/codev/node_modules/node-pty'));
const xterm = require(join(repoRoot, 'packages/codev/node_modules/@xterm/headless'));
const { Terminal } = xterm;

// The same 110x32 the suite classifies at, so geometry here IS geometry there.
const COLS = 110;
const ROWS = 32;
const outDir = process.argv[2] || join(repoRoot, 'codev/spikes/kimi-gate-capture');
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mirrors of the production profile's patterns (gate-profiles.ts). Kept literal
// rather than imported so this spike stays a standalone observation of kimi, not
// a test of our own code.
const MARKER = /^\s*│\s*>/;
const BOX_TOP = /^\s*╭[─━╌┄]{3,}/;
const BOX_BOTTOM = /^\s*╰[─━╌┄]{3,}/;

async function render(raw) {
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 2000 });
  await new Promise((resolve) => term.write(raw, resolve));
  const buf = term.buffer.active;
  const top = buf.viewportY;
  const lines = [];
  for (let i = 0; i < ROWS; i++) {
    const line = buf.getLine(top + i);
    lines.push(line ? line.translateToString(true).trimEnd() : '');
  }
  return { term, lines };
}

/** Reproduce the classifier's region bounds and report the interior row count. */
function geometry(lines) {
  let markerRow = -1;
  for (let i = 0; i < lines.length; i++) if (MARKER.test(lines[i])) markerRow = i; // LAST match
  if (markerRow === -1) return { markerRow, verdict: 'no-composer-marker' };

  let endRow = -1;
  for (let i = markerRow + 1; i < lines.length; i++) {
    if (BOX_BOTTOM.test(lines[i])) { endRow = i; break; }
  }
  if (endRow === -1) return { markerRow, verdict: 'no-region-end' };

  let startRow = -1;
  for (let i = markerRow - 1; i >= 0; i--) {
    if (BOX_TOP.test(lines[i])) { startRow = i + 1; break; }
  }
  if (startRow === -1) return { markerRow, endRow, verdict: 'no-region-start' };

  return { markerRow, startRow, endRow, interior: endRow - startRow, verdict: 'scanned' };
}

const results = [];

async function report(name, raw, expectation) {
  writeFileSync(join(outDir, `growth-${name}.raw.txt`), raw);
  const { term, lines } = await render(raw);
  const g = geometry(lines);
  results.push({ name, ...g, expectation });
  console.log(`\n${'='.repeat(78)}\n== ${name}  (${raw.length} bytes)  — expected: ${expectation}\n${'='.repeat(78)}`);
  console.log(`geometry: ${JSON.stringify(g)}`);
  console.log('--- composer rows (the region and its bounds) ---');
  const from = g.startRow !== undefined ? g.startRow - 1 : Math.floor(ROWS / 2);
  const to = g.endRow !== undefined ? g.endRow + 1 : ROWS - 1;
  for (let i = Math.max(0, from); i <= Math.min(ROWS - 1, to); i++) {
    const tag = g.startRow !== undefined && i >= g.startRow && i < g.endRow ? ' <== SCANNED' : '';
    console.log(`${String(i).padStart(2)}: ${JSON.stringify(lines[i])}${tag}`);
  }
  term.dispose();
}

/**
 * Pre-write kimi's workspace-trust record (0.33.0+) so the TUI opens on a composer
 * rather than the interactive trust dialog. Undocumented surface, derived by
 * observation on 0.34.0 — see the harness spike for the full note.
 */
function preTrust(root) {
  const dir = join(process.env.HOME, '.kimi-code', 'workspace-trust');
  mkdirSync(dir, { recursive: true });
  const slug = root.split('/').filter(Boolean).pop().toLowerCase();
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 12);
  writeFileSync(join(dir, `wd_${slug}_${hash}`), JSON.stringify({ root, trustedAt: Date.now() }));
}

/** Backspace the composer clean so the next capture starts from a settled idle screen. */
async function clear(term, n) {
  term.write('\x7f'.repeat(n));
  await sleep(2500);
}

async function capture() {
  const cwd = mkdtempSync(join(tmpdir(), 'kimi-growth-'));
  preTrust(cwd);
  const term = pty.spawn('kimi', ['--yolo'], {
    name: 'xterm-256color', cols: COLS, rows: ROWS, cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  let raw = '';
  term.onData((d) => { raw += d; });

  console.error('[growth] waiting 20s for the kimi TUI to settle…');
  await sleep(20000);
  const idle = raw;

  console.error('[growth] short single-line draft…');
  term.write('draft text');
  await sleep(4000);
  const draft = raw;
  await clear(term, 40);

  // No spaces: forces a hard soft-wrap rather than a word-boundary break, which is
  // the shape most likely to add an interior row without a newline in the draft.
  console.error('[growth] long single line (soft wrap)…');
  term.write('x'.repeat(180));
  await sleep(4000);
  const wrap = raw;
  await clear(term, 260);

  console.error('[growth] "/" command menu…');
  term.write('/');
  await sleep(4000);
  const menu = raw;
  await clear(term, 10);

  console.error('[growth] "@" file picker…');
  term.write('@');
  await sleep(4000);
  const picker = raw;
  await clear(term, 10);

  // THE false-CLEAN shape: newline first (so row 1 is empty), then a bare ">" on
  // row 2 — which matches the marker pattern and so is span-exempted as chrome.
  console.error('[growth] newline then bare ">" (the false-CLEAN shape)…');
  term.write('\n>');
  await sleep(4000);
  const newlineBare = raw;
  await clear(term, 20);

  console.error('[growth] newline only…');
  term.write('\n');
  await sleep(4000);
  const newlineOnly = raw;
  await clear(term, 20);

  // The builder's STEADY state: a composer that has already carried a turn. If the
  // box stays grown here, the geometry rule would hold every later message forever.
  console.error('[growth] submitting a real prompt, then measuring idle-after-response (45s)…');
  term.write('Reply with exactly OK and nothing else.');
  await sleep(1200);
  term.write('\r');
  await sleep(45000);
  const afterResponse = raw;

  term.kill();
  return { idle, draft, wrap, menu, picker, newlineBare, newlineOnly, afterResponse };
}

const s = await capture();
await report('idle', s.idle, 'interior 1');
await report('draft', s.draft, 'interior 1');
await report('wrap', s.wrap, 'informational (text-bearing either way)');
await report('menu', s.menu, 'interior 1');
await report('picker', s.picker, 'interior 1');
await report('newline-bare', s.newlineBare, 'interior 2 (the false-CLEAN shape)');
await report('newline-only', s.newlineOnly, 'interior 2');
await report('after-response', s.afterResponse, 'interior 1 (steady state — growth here = permanent hold)');

console.log(`\n${'='.repeat(78)}\n== VERDICT TABLE\n${'='.repeat(78)}`);
for (const r of results) {
  console.log(
    `${r.name.padEnd(16)} interior=${String(r.interior ?? '-').padEnd(3)} ` +
    `verdict=${(r.verdict ?? '-').padEnd(18)} expected: ${r.expectation}`
  );
}
const drafts = new Set(['newline-bare', 'newline-only']);
const grewWithoutDraft = results.filter(
  (r) => r.interior !== undefined && r.interior > 1 && !drafts.has(r.name) && r.name !== 'wrap'
);
console.log(
  grewWithoutDraft.length === 0
    ? '\nPREMISE HOLDS: only multi-line drafts grew the box. The geometry rule is safe.'
    : `\nPREMISE CONTRADICTED by: ${grewWithoutDraft.map((r) => r.name).join(', ')} — do NOT implement; document the residual.`
);
console.error(`\n[growth] raw captures written to ${outDir}`);
process.exit(0);
