/**
 * Spike 1265 — follow-up: reviewer-flagged kill-ring interaction in the H+I
 * max-age sequence.
 *
 * As documented, the max-age multi-line path chains:
 *   per-line clear (^E ^U BS)×N  →  atomic inject (both app forms END in ^Y)
 *   →  byte-replay of the captured draft.
 * Concern: the per-line clear's ^U primes the kill-ring, so the inject's
 * trailing ^Y yanks a killed draft line onto the fresh prompt BEFORE the
 * replay re-adds the whole draft → duplicated content.
 *
 * Phases (per TUI):
 *   p1  build 3-line draft, snapshot
 *   p2  per-line clear ×3, snapshot empty
 *   p3  RING PROBE: bare ^Y on the cleared composer — what does the ring hold?
 *   p4  BUGGY variant: rebuild draft → per-line clear → atomic inject WITH
 *       trailing ^Y → byte-replay → snapshot; compare against p1
 *   p5  FIXED variant: rebuild draft → per-line clear → same inject WITHOUT
 *       the trailing ^Y → byte-replay → snapshot; must equal p1 exactly
 *
 * Usage: node exp-i5-maxage-fullseq.cjs claude|codex
 * (claude runs on a dead ANTHROPIC_BASE_URL; codex injects /status only)
 */
'use strict';
const { TuiDriver, KEYS, sleep, show } = require('./harness.cjs');

const which = process.argv[2] || 'claude';
const DEAD = 'http://127.0.0.1:9';

function composer(d) {
  const lines = d.screen();
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

async function snap(d, label, settleMs = 800) {
  await d.settle(settleMs, 12000);
  const text = composer(d);
  d.snapshot(label);
  console.log(`RESULT ${label}: composer=${JSON.stringify(text)}`);
  return text;
}

/** Build the reference 3-line draft, returning the captured byte list. */
async function buildDraft(d) {
  const captured = [];
  const typeBytes = async (chunks) => {
    for (const c of chunks) { d.send(c); captured.push(c); await sleep(28); }
  };
  await typeBytes([...'first line']);
  await typeBytes(['\x1b\r']);
  await typeBytes([...'second line']);
  await typeBytes(['\x1b\r']);
  await typeBytes([...'third']);
  return captured;
}

async function perLineClear(d, rounds) {
  for (let i = 0; i < rounds; i++) {
    d.send(KEYS.CTRL_E); await sleep(50);
    d.send(KEYS.CTRL_U); await sleep(50);
    d.send(KEYS.BACKSPACE); await sleep(50);
  }
}

async function replay(d, captured) {
  for (const c of captured) { d.send(c); await sleep(14); }
}

function injectAtomic(d, withYank) {
  const MSG = which === 'claude'
    ? KEYS.CTRL_E + KEYS.CTRL_U + '[architect] maxage inject' + '\r'
    : KEYS.CTRL_E + KEYS.CTRL_U + KEYS.PASTE_START + '/status' + KEYS.PASTE_END + '\r';
  d.send(withYank ? MSG + KEYS.CTRL_Y : MSG);
}

(async () => {
  const env = which === 'claude' ? { ANTHROPIC_BASE_URL: DEAD } : {};
  const d = new TuiDriver(which, [], { label: `expI5-${which}`, env });
  await d.settle(2000, 40000);
  await sleep(1200);
  if (which === 'codex' && d.screenText().includes('Press enter to continue')) {
    d.send('3'); await sleep(300); d.send('\r');
    await d.settle(2000, 40000); await sleep(800);
  }

  // ---- p1: reference draft
  await buildDraft(d);
  const ref = await snap(d, 'p1-draft');

  // ---- p2: per-line clear
  await perLineClear(d, 3);
  const cleared = await snap(d, 'p2-after-perline-clear');
  console.log(`VERDICT p2-cleared=${!cleared.includes('first line')}`);

  // ---- p3: ring probe — bare ^Y on the cleared composer
  d.send(KEYS.CTRL_Y);
  const ring = await snap(d, 'p3-ring-probe');
  console.log(`VERDICT p3-ring-holds=${JSON.stringify(ring)}`);
  await perLineClear(d, 5); // remove whatever the probe yanked
  await snap(d, 'p3-cleaned');

  // ---- p4: BUGGY as-documented sequence
  const cap4 = await buildDraft(d);
  await snap(d, 'p4-draft-rebuilt');
  await perLineClear(d, 3);
  injectAtomic(d, /* withYank */ true);
  await sleep(900);
  await snap(d, 'p4-after-inject-with-yank');
  await replay(d, cap4);
  const buggy = await snap(d, 'p4-after-replay');
  console.log(`VERDICT p4-buggy-matches-ref=${buggy === ref}`);
  console.log(`VERDICT p4-duplication=${buggy !== ref} buggy=${JSON.stringify(buggy)}`);
  await perLineClear(d, 8);
  await snap(d, 'p4-cleaned');

  // ---- p5: FIXED — no trailing ^Y on the byte-replay path
  const cap5 = await buildDraft(d);
  await snap(d, 'p5-draft-rebuilt');
  await perLineClear(d, 3);
  injectAtomic(d, /* withYank */ false);
  await sleep(900);
  await snap(d, 'p5-after-inject-no-yank');
  await replay(d, cap5);
  const fixed = await snap(d, 'p5-after-replay');
  console.log(`VERDICT p5-fixed-byte-identical=${fixed === ref} fixed=${JSON.stringify(fixed)}`);

  d.kill();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
