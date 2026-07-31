/**
 * Spike 1265 — review round 9, concern 4: the H divert window is unbounded as
 * documented.
 *
 * i5 validated the maneuver with char-paced replay (14 ms/chunk) and 50 ms
 * steps inside the per-line clear — fine for a 3-line draft (~2 s), but linear
 * in draft size: ~14 s at 1 KB, ~2 min at the 8 KB capture cap. The doc's
 * "few hundred ms" (delivery matrix) and "~2 s" (constraint 8) were both
 * unscaled snapshots of the small-draft case, and a fail-open gate timeout
 * cannot be specified against an unbounded window.
 *
 * This experiment measures whether the maneuver's writes can be BULKED:
 *   clear:  all (^E ^U BS)×N rounds in ONE write (vs 50 ms per step)
 *   replay: the entire captured byte stream in ONE write (vs 14 ms per chunk)
 *
 * Cases per TUI (fresh session each):
 *   i7a  3-line draft incl. a backspace edit (i5's shape):
 *        bulk clear + inject + BULK replay → composer must equal the pre-
 *        maneuver snapshot exactly. ASSERTED.
 *   i7b  12-line / ~0.55 KB draft: same flow. The interesting failure mode is
 *        paste-collapse (claude folds large single-write pastes into a
 *        "[Pasted text]" attachment token — that would preserve content but
 *        not the rendered composer). If bulk replay diverges, a fresh session
 *        retries with LINE-CHUNKED replay (one write per captured line
 *        segment, 40 ms apart) — still O(lines), not O(chars). ASSERTED as:
 *        at least one bounded-replay form reconstructs byte-identically;
 *        which form(s) is MEASURED output for the findings doc.
 *   i7c  40-line / ~1.8 KB draft: same bulk-then-line-chunked structure —
 *        probes paste-collapse at size and bounds how far the single-write
 *        form is validated.
 *
 * Measured en route (i7b, claude): tall drafts SCROLL the composer — the
 * rendered composer is a window (zq01 scrolled out at 12 lines) — so ref
 * snapshots, G-lite verdicts, and post-replay equality all operate on the
 * window, which is exactly what a screen-level check can and should promise.
 *
 * Timings are printed for the doc's divert-window bound (settle waits are
 * included and noted — treat as upper bounds).
 *
 * Usage: node exp-i7-bulk-replay.cjs claude|codex
 * (claude on a dead ANTHROPIC_BASE_URL; codex injects local /status only)
 */
'use strict';
const { TuiDriver, KEYS, sleep } = require('./harness.cjs');

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
  await d.settle(settleMs, 15000);
  const text = composer(d);
  d.snapshot(label);
  return text;
}

const failures = [];
function check(label, ok, detail) {
  console.log(`ASSERT ${label}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
  if (!ok) failures.push(label);
}
function note(label, detail) {
  console.log(`MEASURED ${label}: ${detail}`);
}

async function freshSession(label) {
  const env = which === 'claude' ? { ANTHROPIC_BASE_URL: DEAD } : {};
  const d = new TuiDriver(which, [], { label, env });
  await d.settle(2000, 40000);
  await sleep(1200);
  if (which === 'codex' && d.screenText().includes('Press enter to continue')) {
    d.send('3'); await sleep(300); d.send('\r');
    await d.settle(2000, 40000); await sleep(800);
  }
  return d;
}

// Collision-proof line content (no real-word substrings; unique per line).
function makeLines(n) {
  const fill = 'kwvx mtrp jhgd nsbc lfyo wezu qapi rdgn';
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push(`zq${String(i).padStart(2, '0')} ${fill}`);
  return lines;
}

/** Type the draft like a human, capturing the byte stream (incl. an edit). */
async function buildDraft(d, lines, perCharMs) {
  const captured = [];
  const emit = async (b) => { d.send(b); captured.push(b); await sleep(perCharMs); };
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await emit('\x1b\r');
    for (const ch of lines[i]) await emit(ch);
    if (i === lines.length - 1) { await emit('X'); await emit(KEYS.BACKSPACE); } // edit on the last line
  }
  return captured;
}

function injectForm() {
  return which === 'claude'
    ? KEYS.CTRL_E + KEYS.CTRL_U + '[architect] bulk maneuver inject' + '\r'
    : KEYS.CTRL_E + KEYS.CTRL_U + KEYS.PASTE_START + '/status' + KEYS.PASTE_END + '\r';
}

/** Split a captured stream into line segments at the Alt+Enter boundaries. */
function lineSegments(captured) {
  const segs = [[]];
  for (const b of captured) {
    if (b === '\x1b\r') { segs.push([b]); segs.push([]); continue; }
    segs[segs.length - 1].push(b);
  }
  return segs.filter((s) => s.length).map((s) => s.join(''));
}

/** Poll until cond() is true (returns ms taken) or timeout (returns -1).
 * Condition-based waiting replaced quiet-period settling for the maneuver
 * steps: settle() measures "no output for N ms" against a timestamp that is
 * already stale after a quiet snapshot, so it can return BEFORE the TUI has
 * painted the effect of a just-sent bulk write (round-9 false FAIL on the
 * 40-line clear). Polling for the expected screen state has no such race and
 * yields honest step timings as a bonus. */
async function waitForCond(cond, timeoutMs, pollMs = 100) {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return Date.now() - t0;
    if (Date.now() - t0 >= timeoutMs) return -1;
    await sleep(pollMs);
  }
}

/**
 * Run the full maneuver on a fresh session.
 * replayMode: 'bulk' (one write) | 'lines' (one write per line segment, 40 ms)
 * Clear is attempted bulk-first with a paced (i5-style 50 ms/step) fallback;
 * which mode succeeded is recorded.
 * Returns { ok, ref, got, clearMode, tClearMs, tReplayMs, bytes }.
 */
async function runCase(label, lineCount, perCharMs, replayMode) {
  const d = await freshSession(`expI7-${label}-${which}`);
  const lines = makeLines(lineCount);
  const captured = await buildDraft(d, lines, perCharMs);
  const ref = await snap(d, `${label}-ref`);
  // Anchor on the LAST line + any zq line: tall drafts scroll the composer —
  // the render is a WINDOW onto the draft (measured here on claude at 12
  // lines: zq01 scrolls out while zq02… remain), so the head being off-screen
  // is correct behavior, not an extraction failure. The window is also what
  // makes the post-replay exact-equality meaningful: same content, same
  // scroll position.
  const anchored = ref.includes(`zq${String(lineCount).padStart(2, '0')}`) && /zq\d\d/.test(ref);
  check(`i7${label}-anchor-draft-visible`, anchored, `ref=${JSON.stringify(ref.slice(0, 60))}…`);

  // Per-line clear: BULK first (every round in one write, +1 slack round —
  // extra BS on an empty composer is a no-op, i5), paced fallback if the
  // rendered composer hasn't emptied in time.
  const tokenFree = () => !/zq\d\d/.test(composer(d));
  let clearMode = 'bulk';
  const clearBytes = (KEYS.CTRL_E + KEYS.CTRL_U + KEYS.BACKSPACE).repeat(lineCount + 1);
  d.send(clearBytes);
  let tClearMs = await waitForCond(tokenFree, 4000);
  if (tClearMs < 0) {
    note(`i7${label}-bulk-clear`, `did not empty within 4 s (composer=${JSON.stringify(composer(d).slice(0, 50))}) — falling back to paced per-line clear`);
    clearMode = 'paced';
    for (let i = 0; i < lineCount + 2; i++) {
      d.send(KEYS.CTRL_E); await sleep(50);
      d.send(KEYS.CTRL_U); await sleep(50);
      d.send(KEYS.BACKSPACE); await sleep(50);
    }
    tClearMs = await waitForCond(tokenFree, 8000);
  }
  d.snapshot(`${label}-cleared`);
  check(`i7${label}-clear-empties`, tClearMs >= 0, `mode=${clearMode} tClearMs=${tClearMs} composer=${JSON.stringify(composer(d).slice(0, 50))}`);
  if (tClearMs < 0) { d.kill(); return { ok: false, ref, got: composer(d), clearMode, tClearMs, tReplayMs: -1, bytes: 0 }; }

  // Inject + submit (per-app atomic form, NO trailing ^Y — p4/p5).
  d.send(injectForm());
  await sleep(900);
  await snap(d, `${label}-after-inject`);

  // Replay, then poll for the reconstructed ref (bounded; a divergence like
  // codex's paste-collapse simply never matches and times out).
  const allBytes = captured.join('');
  const t1 = Date.now();
  if (replayMode === 'bulk') {
    d.send(allBytes);
  } else {
    for (const seg of lineSegments(captured)) { d.send(seg); await sleep(40); }
  }
  let matchedMs = await waitForCond(() => composer(d) === ref, 6000);
  if (matchedMs < 0) {
    // Distinguish "slow straggler render" from permanent divergence: keep
    // polling; a late match is a timing note, not a failure.
    const lateMs = await waitForCond(() => composer(d) === ref, 10000);
    if (lateMs >= 0) { matchedMs = 6000 + lateMs; note(`i7${label}-${replayMode}-late-match`, `matched after ~${matchedMs} ms (past the 6 s first window)`); }
  }
  const tReplayMs = Date.now() - t1;
  const got = composer(d);
  d.snapshot(`${label}-after-replay-${replayMode}`);
  const ok = matchedMs >= 0 && got === ref;
  note(`i7${label}-${replayMode}`, `bytes=${allBytes.length} clearMode=${clearMode} tClearMs=${tClearMs} tReplayMs=${ok ? tReplayMs : -1} charPacedEstimateMs=${allBytes.length * 14} match=${ok}`);
  if (!ok) {
    const di = [...got].findIndex((ch, i) => ch !== ref[i]);
    note(`i7${label}-${replayMode}-divergence`, `firstDiffAt=${di} refLen=${ref.length} gotLen=${got.length} refCtx=${JSON.stringify(ref.slice(Math.max(0, di - 20), di + 40))} gotCtx=${JSON.stringify(got.slice(Math.max(0, di - 20), di + 40))}`);
  }
  d.kill();
  return { ok, ref, got, clearMode, tClearMs, tReplayMs, bytes: allBytes.length };
}

(async () => {
  // ---- i7a: small draft, bulk everything — must reconstruct exactly ------
  const a = await runCase('a', 3, 25, 'bulk');
  check('i7a-bulk-replay-byte-identical', a.ok, `got=${JSON.stringify((a.got ?? '').slice(0, 60))}`);

  // ---- i7b: ~0.55 KB draft — bulk first, line-chunked fallback -----------
  const b1 = await runCase('b', 12, 8, 'bulk');
  let b2 = null;
  if (!b1.ok) {
    note('i7b', 'bulk replay diverged — retrying with line-chunked replay on a fresh session');
    b2 = await runCase('b2', 12, 8, 'lines');
  }
  check('i7b-bounded-replay-reconstructs', b1.ok || (b2 && b2.ok), `bulk=${b1.ok}${b2 ? ` lines=${b2.ok}` : ''}`);

  // ---- i7c: ~1.8 KB / 40-line draft — paste-collapse probe at size -------
  // (the capture cap is a design parameter; this bounds how far the bulk
  // single-write form is validated, with line-chunked as the O(lines)
  // fallback beyond it)
  const c1 = await runCase('c', 40, 8, 'bulk');
  let c2 = null;
  if (!c1.ok) {
    note('i7c', 'bulk replay diverged at ~1.8 KB — retrying with line-chunked replay on a fresh session');
    c2 = await runCase('c2', 40, 8, 'lines');
  }
  check('i7c-bounded-replay-reconstructs', c1.ok || (c2 && c2.ok), `bulk=${c1.ok}${c2 ? ` lines=${c2.ok}` : ''}`);

  if (failures.length) {
    console.error(`FAILURES: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('ALL ASSERTIONS PASSED');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
