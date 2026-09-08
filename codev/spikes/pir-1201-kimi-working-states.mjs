/**
 * Kimi composer geometry while the agent is WORKING (PIR #1201, CMAP 2026-08-09).
 *
 * The box-growth measurement (`pir-1201-kimi-box-growth.mjs`) covered idle, drafts,
 * menus, pickers and the post-reply steady state, and the multi-row-draft rule rests
 * on it. The 3-way review flagged one class it did not enumerate: the composer WHILE
 * the agent is generating (spinner / "esc to interrupt" / queued-message indicator),
 * and the mode chrome (shift+tab mode cycle, `!` bash mode).
 *
 * If any of those grow the box past one interior row while carrying no countable
 * cells, mail to a WORKING kimi builder would be held until it goes idle — bounded and
 * self-healing, but a behavior change nothing documents. This probe answers it with
 * bytes instead of reasoning.
 *
 * Usage:  node codev/spikes/pir-1201-kimi-working-states.mjs
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
const { Terminal } = require(join(repoRoot, 'packages/codev/node_modules/@xterm/headless'));

const COLS = 110, ROWS = 32;
const outDir = join(repoRoot, 'codev/spikes/kimi-gate-capture');
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MARKER = /^\s*│\s*>/;
const BOX_TOP = /^\s*╭[─━╌┄]{3,}/;
const BOX_BOTTOM = /^\s*╰[─━╌┄]{3,}/;

async function geometry(raw) {
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 2000 });
  await new Promise((r) => term.write(raw, r));
  const buf = term.buffer.active;
  const top = buf.viewportY;
  const lines = [];
  for (let i = 0; i < ROWS; i++) {
    const l = buf.getLine(top + i);
    lines.push(l ? l.translateToString(true).trimEnd() : '');
  }
  let markerRow = -1;
  for (let i = 0; i < ROWS; i++) if (MARKER.test(lines[i])) markerRow = i;
  if (markerRow === -1) { term.dispose(); return { verdict: 'no-composer-marker', lines }; }
  let endRow = -1;
  for (let i = markerRow + 1; i < ROWS; i++) if (BOX_BOTTOM.test(lines[i])) { endRow = i; break; }
  if (endRow === -1) { term.dispose(); return { verdict: 'no-region-end', lines }; }
  let startRow = -1;
  for (let i = markerRow - 1; i >= 0; i--) if (BOX_TOP.test(lines[i])) { startRow = i + 1; break; }
  term.dispose();
  if (startRow === -1) return { verdict: 'no-region-start', lines };
  return { verdict: 'scanned', interior: endRow - startRow, startRow, endRow, lines };
}

function preTrust(root) {
  const dir = join(process.env.HOME, '.kimi-code', 'workspace-trust');
  mkdirSync(dir, { recursive: true });
  const slug = root.split('/').filter(Boolean).pop().toLowerCase();
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 12);
  writeFileSync(join(dir, `wd_${slug}_${hash}`), JSON.stringify({ root, trustedAt: Date.now() }));
}

const results = [];
async function record(name, raw, note) {
  writeFileSync(join(outDir, `working-${name}.raw.txt`), raw);
  const g = await geometry(raw);
  results.push({ name, ...g, note });
  console.log(`\n${'='.repeat(74)}\n== ${name} — ${note}\n${'='.repeat(74)}`);
  console.log(`verdict=${g.verdict} interior=${g.interior ?? '-'}`);
  const from = g.startRow !== undefined ? g.startRow - 1 : ROWS - 8;
  const to = g.endRow !== undefined ? g.endRow + 1 : ROWS - 1;
  for (let i = Math.max(0, from); i <= Math.min(ROWS - 1, to); i++) {
    if (g.lines[i]) console.log(`${String(i).padStart(2)}: ${JSON.stringify(g.lines[i])}`);
  }
}

const cwd = mkdtempSync(join(tmpdir(), 'kimi-working-'));
preTrust(cwd);
const term = pty.spawn('kimi', ['--yolo'], {
  name: 'xterm-256color', cols: COLS, rows: ROWS, cwd,
  env: { ...process.env, TERM: 'xterm-256color' },
});
let raw = '';
term.onData((d) => { raw += d; });

console.error('[working] settling (20s)…');
await sleep(20000);

// Mode chrome first, while nothing is running.
console.error('[working] shift+tab mode cycle…');
term.write('\x1b[Z');
await sleep(3500);
await record('mode-cycle', raw, 'after shift+tab (mode chrome)');

console.error('[working] "!" bash mode…');
term.write('!');
await sleep(3500);
await record('bash-mode', raw, 'after "!" (bash mode)');
term.write('\x7f'.repeat(5));
await sleep(2500);

// A prompt long enough to observe MID-generation rather than only the settled end.
console.error('[working] submitting a long-running prompt…');
term.write('Count from 1 to 40, one number per line, each with a brief comment.');
await sleep(1200);
term.write('\r');

await sleep(5000);
await record('generating-early', raw, 'MID-generation, ~5s after submit');
await sleep(8000);
await record('generating-mid', raw, 'MID-generation, ~13s after submit');

// A message typed WHILE the agent works — kimi queues it; does the box grow?
console.error('[working] typing while the agent is still working…');
term.write('queued while working');
await sleep(4000);
await record('queued-while-working', raw, 'draft typed during generation');

term.kill();

console.log(`\n${'='.repeat(74)}\n== VERDICT TABLE\n${'='.repeat(74)}`);
for (const r of results) {
  console.log(`${r.name.padEnd(24)} verdict=${String(r.verdict).padEnd(18)} interior=${r.interior ?? '-'}   (${r.note})`);
}
// A grown box with no countable cells is the only shape that would newly hold mail.
const risky = results.filter((r) => r.verdict === 'scanned' && r.interior > 1 && r.name !== 'queued-while-working');
console.log(
  risky.length === 0
    ? '\nNO NEW HOLD: no working/mode state grew the box. The rule changes nothing for a working builder.'
    : `\nBEHAVIOR CHANGE: ${risky.map((r) => r.name).join(', ')} grow the box — mail to a working builder would be held until idle.`
);
process.exit(0);
