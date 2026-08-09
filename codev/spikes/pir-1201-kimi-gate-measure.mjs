/**
 * Kimi render-gate measurement (PIR #1201, re-integration against Spec 1313).
 *
 * Spec 1313's render gate delivers a message only onto a composer it can prove
 * empty, and it does that per-app via a `GateProfile` (marker pattern, region-end
 * patterns, optional placeholder color). An app with no profile holds every
 * message with `no-profile` — so a measured Kimi profile is a functional
 * prerequisite for `afx send` to a Kimi builder, not polish.
 *
 * This is the Kimi analogue of the agy Phase-3 measurement: drive a real `kimi`
 * TUI under a PTY, capture the raw byte stream for each screen state, render it
 * through the SAME data path the live gate uses (RingBuffer → @xterm/headless),
 * and dump per-cell attributes so the profile is derived from observation rather
 * than assumption.
 *
 * States captured:
 *   idle   — settled composer, nothing typed  (must classify CLEAN)
 *   draft  — a few characters typed, no Enter (must classify BUSY)
 *   seed   — `kimi -p … --output-format stream-json` running (must classify BUSY:
 *            this is the seed window, where a written byte has no consumer)
 *
 * Usage:  node codev/spikes/pir-1201-kimi-gate-measure.mjs [outDir]
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

const COLS = 110;
const ROWS = 32;
const outDir = process.argv[2] || join(repoRoot, 'codev/spikes/kimi-gate-capture');
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Render a raw PTY stream and dump the viewport + per-cell attributes. */
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
  return { term, buf, top, lines };
}

/** Per-cell attribute dump for one viewport row — the evidence the profile rests on. */
function dumpRow(buf, top, row) {
  const line = buf.getLine(top + row);
  if (!line) return '  (no line)';
  const cell = buf.getNullCell();
  const parts = [];
  for (let col = 0; col < COLS; col++) {
    line.getCell(col, cell);
    const ch = cell.getChars();
    if (!ch || ch === ' ') continue;
    const attrs = [];
    if (cell.isDim()) attrs.push('dim');
    if (cell.isInverse()) attrs.push('inv');
    if (cell.isBold()) attrs.push('bold');
    if (cell.isFgPalette()) attrs.push(`fgPal=${cell.getFgColor()}`);
    else if (cell.isFgRGB()) attrs.push(`fgRGB=${cell.getFgColor().toString(16)}`);
    else attrs.push('fgDefault');
    parts.push(`${col}:${JSON.stringify(ch)}[${attrs.join(',')}]`);
  }
  return '  ' + (parts.join(' ') || '(empty)');
}

async function report(name, raw) {
  writeFileSync(join(outDir, `${name}.raw.txt`), raw);
  const { term, buf, top, lines } = await render(raw);
  console.log(`\n${'='.repeat(78)}\n== ${name}  (${raw.length} bytes)\n${'='.repeat(78)}`);
  console.log(`cursor: row=${buf.cursorY} col=${buf.cursorX}`);
  console.log('--- viewport (row: text) ---');
  lines.forEach((l, i) => {
    if (l) console.log(`${String(i).padStart(2)}: ${JSON.stringify(l)}`);
  });
  // Dump attributes for every non-empty row in the bottom third — the composer lives there.
  console.log('--- per-cell attributes (non-empty rows, bottom half) ---');
  for (let i = Math.floor(ROWS / 2); i < ROWS; i++) {
    if (!lines[i]) continue;
    console.log(`row ${i}: ${JSON.stringify(lines[i])}`);
    console.log(dumpRow(buf, top, i));
  }
  term.dispose();
}

/**
 * Pre-write kimi's workspace-trust record for `root` (0.33.0+).
 *
 * UNDOCUMENTED SURFACE, derived by observation on 0.34.0: trust lives at
 * `~/.kimi-code/workspace-trust/wd_<basename-lowercased>_<sha256(root)[:12]>`
 * holding `{root, trustedAt}`. Without it the pinned `-S` TUI opens on an
 * interactive "Trust this folder?" dialog instead of a composer, and the
 * dialog's only non-trusting option EXITS — so an unattended builder can never
 * reach its prompt. (Trust gates project-level MCP servers only.)
 */
function preTrust(root) {
  const dir = join(process.env.HOME, '.kimi-code', 'workspace-trust');
  mkdirSync(dir, { recursive: true });
  const slug = root.split('/').filter(Boolean).pop().toLowerCase();
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 12);
  writeFileSync(join(dir, `wd_${slug}_${hash}`), JSON.stringify({ root, trustedAt: Date.now() }));
}

async function captureTrustDialog() {
  const cwd = mkdtempSync(join(tmpdir(), 'kimi-untrusted-'));
  const term = pty.spawn('kimi', ['--yolo'], {
    name: 'xterm-256color', cols: COLS, rows: ROWS, cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  let raw = '';
  term.onData((d) => { raw += d; });
  console.error('[measure] capturing the untrusted-folder dialog (18s)…');
  await sleep(18000);
  try { term.kill(); } catch { /* already gone */ }
  return { trust: raw };
}

async function captureTui() {
  const cwd = mkdtempSync(join(tmpdir(), 'kimi-gate-'));
  preTrust(cwd);
  const term = pty.spawn('kimi', ['--yolo'], {
    name: 'xterm-256color', cols: COLS, rows: ROWS, cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  let raw = '';
  term.onData((d) => { raw += d; });

  console.error('[measure] waiting 20s for the kimi TUI to settle…');
  await sleep(20000);
  const idle = raw;

  console.error('[measure] typing a draft (no Enter)…');
  term.write('draft text');
  await sleep(4000);
  const draft = raw;
  await clear(term, 40);

  // The screens the 3-way review (2026-08-09) said a happy-path run never
  // produces, and which are exactly where a LAST-match marker search can pick
  // the wrong row. Each is captured raw so the profile is derived from what kimi
  // actually renders rather than from a constructed screen.
  //
  // multiline: a two-line draft whose SECOND line begins with ">" — a pasted
  // quote or a markdown blockquote, and the shape that could make a
  // continuation row look like the composer marker while the real draft text
  // sits ABOVE it, outside the scanned region.
  console.error('[measure] typing a multi-line draft whose 2nd line starts with ">"…');
  let multiline = null;
  term.write('implement the whole feature\n> quoted second line');
  await sleep(4000);
  multiline = raw;
  await clear(term, 80);

  // The false-CLEAN shape itself: same two-line draft, but the last line is a
  // BARE ">". Every cell the classifier would count then lives ABOVE the row it
  // picks as the marker, so the composer reads empty while holding real text.
  // Captured rather than constructed so the regression test rests on bytes kimi
  // actually emitted.
  console.error('[measure] typing a multi-line draft whose 2nd line is a bare ">"…');
  term.write('implement the whole feature\n>');
  await sleep(4000);
  const multilineBare = raw;
  await clear(term, 80);

  // menu: the "/" command list. picker: the "@" file list. Both render EXTRA
  // rows around the composer, which is what makes them the interesting case.
  console.error('[measure] opening the "/" command menu…');
  term.write('/');
  await sleep(4000);
  const menu = raw;
  await clear(term, 10);

  console.error('[measure] opening the "@" file picker…');
  term.write('@');
  await sleep(4000);
  const picker = raw;
  await clear(term, 10);

  term.kill();
  return { idle, draft, multiline, multilineBare, menu, picker };
}

/** Backspace the composer clean so the next capture starts from a settled idle screen. */
async function clear(term, n) {
  term.write('\x7f'.repeat(n));
  await sleep(2000);
}

async function captureSeed() {
  const cwd = mkdtempSync(join(tmpdir(), 'kimi-seed-'));
  const term = pty.spawn('kimi', ['-p', 'Reply with exactly SEED-OK and nothing else.',
    '--output-format', 'stream-json'], {
    name: 'xterm-256color', cols: COLS, rows: ROWS, cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  let raw = '';
  term.onData((d) => { raw += d; });
  console.error('[measure] running the seed (non-interactive) for 12s…');
  await sleep(12000);
  const seed = raw;
  try { term.kill(); } catch { /* already gone */ }
  return { seed };
}

const { idle, draft, multiline, multilineBare, menu, picker } = await captureTui();
await report('kimi-idle', idle);
await report('kimi-draft', draft);
await report('kimi-multiline', multiline);
await report('kimi-multiline-bare', multilineBare);
await report('kimi-menu', menu);
await report('kimi-picker', picker);
const { trust } = await captureTrustDialog();
await report('kimi-trust', trust);
const { seed } = await captureSeed();
await report('kimi-seed', seed);
console.error(`\n[measure] raw captures written to ${outDir}`);
process.exit(0);
