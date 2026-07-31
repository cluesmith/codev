/**
 * Spike 1265 — review round 4, concern 1: cursor-aware editing semantics.
 * Round 8, concern 8: restructured to a FRESH TUI SESSION PER CASE — the
 * original ran a3a/a3b/a3c in one session with `^E ^U` as the inter-case
 * cleaner, which (a) shared state across independent probes and (b) used
 * a3c's own subject primitive as the cleaner (circular). Each case now
 * spawns its own session; no inter-case cleanup exists to be imperfect.
 *
 * The round-1 classification table said "Ctrl+U kills whole current line" —
 * measured only with the cursor at end-of-line. Reviewer: with the cursor
 * mid-line, readline-style Ctrl+U kills only [start, cursor), so
 * `uvwxyz` + Left×3 + Ctrl+U should leave `xyz` — and a tracker that clears
 * its whole buffer on Ctrl+U would falsely report an EMPTY line (delivery
 * onto occupied line = the original corruption). Backspace similarly edits
 * at the cursor, not the tail. (Draft strings are chosen to never collide
 * with placeholder chrome — 'def' ⊂ "default" was a latent flake.)
 *
 * Asserted probes (exit 1 on any failure), one fresh session each:
 *   a3a  uvwxyz + Left×3 + Ctrl+U   → composer "xyz"? (kill-to-start)
 *   a3b  uvwxyz + Left×2 + BS       → composer "uvwyz"? (delete-at-cursor)
 *   a3c  from mid-line cursor: Ctrl+E then Ctrl+U → fully cleared?
 *        (the per-line clear maneuver's ^E prefix is what makes it safe)
 *
 * Usage: node exp-a3-cursor.cjs claude|codex
 */
'use strict';
const { TuiDriver, KEYS, sleep } = require('./harness.cjs');

const which = process.argv[2] || 'claude';

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

const failures = [];
function assertEq(label, actual, expected) {
  const ok = actual === expected;
  console.log(`ASSERT ${label}: ${ok ? 'PASS' : 'FAIL'} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (!ok) failures.push(label);
}

async function snap(d, label, settleMs = 700) {
  await d.settle(settleMs, 12000);
  const text = composer(d);
  d.snapshot(label);
  return text;
}

/** Fresh session per case (round 8): spawn, settle, handle codex onboarding. */
async function freshSession(label) {
  const d = new TuiDriver(which, [], { label });
  await d.settle(2000, 40000);
  await sleep(1200);
  if (which === 'codex' && d.screenText().includes('Press enter to continue')) {
    d.send('3'); await sleep(300); d.send('\r');
    await d.settle(2000, 40000); await sleep(800);
  }
  return d;
}

(async () => {
  // a3a: mid-line Ctrl+U (fresh session)
  {
    const d = await freshSession(`expA3a-${which}`);
    await d.type('uvwxyz');
    for (let i = 0; i < 3; i++) { d.send(KEYS.LEFT); await sleep(70); }
    d.send(KEYS.CTRL_U);
    assertEq('a3a-midline-ctrl-u', await snap(d, 'a3a'), 'xyz');
    d.kill();
  }

  // a3b: mid-line Backspace (fresh session)
  {
    const d = await freshSession(`expA3b-${which}`);
    await d.type('uvwxyz');
    for (let i = 0; i < 2; i++) { d.send(KEYS.LEFT); await sleep(70); }
    d.send(KEYS.BACKSPACE);
    assertEq('a3b-midline-backspace', await snap(d, 'a3b'), 'uvwyz');
    d.kill();
  }

  // a3c: ^E then ^U from a mid-line cursor fully clears (fresh session)
  {
    const d = await freshSession(`expA3c-${which}`);
    await d.type('uvwxyz');
    for (let i = 0; i < 3; i++) { d.send(KEYS.LEFT); await sleep(70); }
    d.send(KEYS.CTRL_E); await sleep(80);
    d.send(KEYS.CTRL_U);
    const c = await snap(d, 'a3c');
    // Robust empty-check: assert against our known draft content, never against
    // app chrome (codex rotates dim placeholder text on the empty composer).
    const cleared = !c.includes('uvw') && !c.includes('xyz');
    console.log(`ASSERT a3c-ctrlE-ctrlU-clears: ${cleared ? 'PASS' : 'FAIL'} composer=${JSON.stringify(c)}`);
    if (!cleared) failures.push('a3c');
    d.kill();
  }

  if (failures.length) {
    console.error(`FAILURES: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('ALL ASSERTIONS PASSED');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
