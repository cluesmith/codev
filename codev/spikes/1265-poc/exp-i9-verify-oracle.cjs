/**
 * Spike 1265 — review round 10, concern 2: H's replay verification oracle is
 * window-bounded, and the 8 KB replay claims were extrapolated from 1.84 KB.
 *
 * i7 verified post-replay reconstruction as `composer(window) === ref(window)`.
 * Tall drafts SCROLL the composer (measured in i7: claude windows at ~11
 * composer lines, codex at ~28 on a 32-row terminal), so for any draft taller
 * than the window that equality attests only the TAIL: a replay that silently
 * dropped PREFIX lines renders an identical window (both windows show the last
 * N lines) and would pass verification — in production H that pass would
 * delete the journal, converting partial loss into SILENT partial loss.
 *
 * This experiment (a) builds a FULL-CONTENT oracle for the lab: Ctrl+G opens
 * `$EDITOR` with the draft on both TUIs (measured round 1); pointing EDITOR at
 * a capture script copies the draft file byte-for-byte out of the TUI — the
 * whole draft, not the window. (b) Uses it to prove the blindness is real
 * loss, and (c) probes replay at ~8 KB so the doc's size claims are measured.
 *
 * NOTE: Ctrl+G is a POC ORACLE ONLY. Production can never use it (it launches
 * the user's real editor — modal, visible, flow-destroying; the classification
 * table lists Ctrl+G as a dirty-marking modal key). Production H verification
 * remains window-bounded — which is exactly why the findings doc now bounds
 * H's addressable drafts to fit the rendered window.
 *
 * Cases per TUI (fresh session each):
 *   i9a  8-line draft (fits both windows) — ASSERTED:
 *        - ref window shows the WHOLE draft (zq01 and zq08 both visible);
 *        - editor-oracle capture #1 === the typed draft (validates the oracle
 *          mechanism against known content — anchors every later capture:
 *          a broken oracle cannot produce a vacuous pass in i9b);
 *        - the Ctrl+G roundtrip with an instant no-op editor leaves the
 *          rendered composer unchanged (usable mid-flow as an oracle);
 *        - full maneuver (clear → inject → FAITHFUL bulk replay): window
 *          oracle passes AND editor capture #2 === the full draft — for
 *          fits-window drafts the window verify is COMPLETE, which is the
 *          soundness condition for deleting H's journal on verify-pass.
 *   i9b  40-line draft, TRUNCATED replay (first line dropped) — ASSERTED:
 *        - pre-maneuver editor capture CONTAINS zq01 (in-session anchor);
 *        - window oracle PASSES on the truncated replay (the blindness,
 *          asserted as fact: got === ref while zq01 is gone);
 *        - post-replay editor capture contains zq02 and zq40 (tail intact)
 *          but NOT zq01 (the loss the window could not see).
 *        Replay uses each app's validated at-size form (claude: bulk —
 *        1.8 KB validated in i7c; codex: line-chunked — its 1.8 KB bulk
 *        paste-collapses, i7c).
 *   i9c  ~8.3 KB draft (41 × 199-char lines) — MEASURED (exploratory tier):
 *        per-app validated-form replay at the capture cap; window match,
 *        paste-collapse, timings, and editor-verified FULL fidelity recorded
 *        whichever way they land. Also measures the rendered window (visible
 *        zq tokens) when long lines wrap. One assert: the oracle mechanism
 *        produced a capture (else the fidelity notes would be meaningless).
 *
 * Usage: node exp-i9-verify-oracle.cjs claude|codex
 * (claude on a dead ANTHROPIC_BASE_URL; codex injects local /status only —
 *  drafts are never submitted)
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TuiDriver, KEYS, sleep, show } = require('./harness.cjs');

const which = process.argv[2] || 'claude';
const DEAD = 'http://127.0.0.1:9';

const failures = [];
function check(label, ok, detail) {
  console.log(`ASSERT ${label}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
  if (!ok) failures.push(label);
}
function note(label, detail) {
  console.log(`MEASURED ${label}: ${detail}`);
}

// Same window extraction as i7 — the oracle under scrutiny.
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

async function waitForCond(cond, timeoutMs, pollMs = 100) {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return Date.now() - t0;
    if (Date.now() - t0 >= timeoutMs) return -1;
    await sleep(pollMs);
  }
}

/**
 * Condition-based REF capture: poll until the composer window contains the
 * expected token AND renders identically on two samples 400 ms apart. The
 * first codex run showed why quiet-period settling is not enough for refs
 * either (round 9e's lesson, now applied to captures): the ref snapshot
 * caught a mid-paint frame with one character missing from a scrolled line
 * (`…rdg` vs `…rdgn`), failing an equality the stable screens satisfy.
 */
async function stableComposer(d, mustInclude, timeoutMs = 8000) {
  let prev = null;
  const t0 = Date.now();
  for (;;) {
    const cur = composer(d);
    if (cur !== '<NO-MARKER>' && (!mustInclude || cur.includes(mustInclude)) && cur === prev) return cur;
    prev = cur;
    if (Date.now() - t0 >= timeoutMs) return cur;
    await sleep(400);
  }
}

// ---- Editor-capture oracle -------------------------------------------------
// A per-case shell script appends the draft file the TUI hands $EDITOR to a
// capture file, marks the block end, sleeps briefly, and exits 0 — the TUI
// reloads the (unchanged) file into the composer. Block markers let one case
// capture more than once.
const scratch = fs.mkdtempSync(path.join(process.env.I9_SCRATCH || os.tmpdir(), 'i9-'));
const END_MARK = '@@I9-CAPTURE-END@@';

function makeOracle(caseLabel) {
  const outFile = path.join(scratch, `${caseLabel}-capture.txt`);
  const script = path.join(scratch, `${caseLabel}-editor.sh`);
  fs.writeFileSync(script, `#!/bin/sh\ncat "$1" >> "${outFile}"\nprintf '\\n${END_MARK}\\n' >> "${outFile}"\nsleep 0.3\nexit 0\n`, { mode: 0o755 });
  const blocks = () => {
    if (!fs.existsSync(outFile)) return [];
    return fs.readFileSync(outFile, 'utf8').split(`\n${END_MARK}\n`).filter((b) => b.trim().length > 0);
  };
  return { script, outFile, blocks };
}

/** Trigger Ctrl+G, wait for the Nth capture block, return normalized content (or null). */
async function editorCapture(d, oracle, expectedBlocks) {
  d.send(KEYS.CTRL_G);
  const got = await waitForCond(() => oracle.blocks().length >= expectedBlocks, 10000, 150);
  // Let the TUI finish restoring its screen after the editor exits.
  await d.settle(700, 12000);
  await sleep(400);
  if (got < 0) return null;
  const all = oracle.blocks();
  return all[all.length - 1].replace(/\r\n/g, '\n').trimEnd();
}

async function freshSession(label, extraEnv = {}) {
  const env = which === 'claude' ? { ANTHROPIC_BASE_URL: DEAD, ...extraEnv } : { ...extraEnv };
  const d = new TuiDriver(which, [], { label, env });
  await d.settle(2000, 40000);
  await sleep(1200);
  if (which === 'codex' && d.screenText().includes('Press enter to continue')) {
    d.send('3'); await sleep(300); d.send('\r');
    await d.settle(2000, 40000); await sleep(800);
  }
  return d;
}

function makeLines(n, width = 0) {
  const fill = 'kwvx mtrp jhgd nsbc lfyo wezu qapi rdgn';
  const lines = [];
  for (let i = 1; i <= n; i++) {
    let l = `zq${String(i).padStart(2, '0')} ${fill}`;
    while (width && l.length < width) l += ` ${fill}`;
    lines.push(width ? l.slice(0, width) : l);
  }
  return lines;
}

/** Type per-char (human shape), capturing the byte stream (incl. one edit). */
async function buildDraft(d, lines, perCharMs) {
  const captured = [];
  const emit = async (b) => { d.send(b); captured.push(b); await sleep(perCharMs); };
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await emit('\x1b\r');
    for (const ch of lines[i]) await emit(ch);
    if (i === lines.length - 1) { await emit('X'); await emit(KEYS.BACKSPACE); }
  }
  return captured;
}

/** Build per-line (fast, for the 8 KB probe): one write per line segment.
 * The capture/replay byte stream is identical to what a per-char build would
 * produce; only the BUILD pacing differs (the build is not under test). */
async function buildDraftBulkLines(d, lines) {
  const captured = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) { d.send('\x1b\r'); captured.push('\x1b\r'); await sleep(40); }
    d.send(lines[i]); captured.push(lines[i]);
    await sleep(40);
  }
  return captured;
}

function injectForm() {
  return which === 'claude'
    ? KEYS.CTRL_E + KEYS.CTRL_U + '[architect] i9 verify-oracle inject' + '\r'
    : KEYS.CTRL_E + KEYS.CTRL_U + KEYS.PASTE_START + '/status' + KEYS.PASTE_END + '\r';
}

function lineSegments(captured) {
  const segs = [[]];
  for (const b of captured) {
    if (b === '\x1b\r') { segs.push([b]); segs.push([]); continue; }
    segs[segs.length - 1].push(b);
  }
  return segs.filter((s) => s.length).map((s) => s.join(''));
}

/** Clear the composer: bulk first, paced fallback (i7's validated shapes). */
async function clearComposer(d, lineCount) {
  const tokenFree = () => !/zq\d\d/.test(composer(d));
  d.send((KEYS.CTRL_E + KEYS.CTRL_U + KEYS.BACKSPACE).repeat(lineCount + 1));
  let t = await waitForCond(tokenFree, 4000);
  let mode = 'bulk';
  if (t < 0) {
    mode = 'paced';
    for (let i = 0; i < lineCount + 2; i++) {
      d.send(KEYS.CTRL_E); await sleep(50);
      d.send(KEYS.CTRL_U); await sleep(50);
      d.send(KEYS.BACKSPACE); await sleep(50);
    }
    t = await waitForCond(tokenFree, 8000);
  }
  return { emptied: t >= 0, mode };
}

/**
 * Build the draft and VERIFY it landed byte-exactly (editor capture as the
 * build oracle), retrying once at slower pacing. Fast injected typing can
 * outrun the TUI's input handling: codex dropped one typed char in ~2.8 K at
 * 8 ms/char (once across runs) — the byte went into `captured`, the TUI's
 * buffer lost it, and every downstream equality inherits the skew. That skew
 * class is exactly what production's maneuver-entry capture-consistency check
 * exists to catch; in the POC the build is scaffolding, so it verifies and
 * retries instead. Returns { captured, ref, cap, attempt } (cap === expected
 * guaranteed on success; caller asserts).
 */
async function buildVerified(d, lines, perCharMs, oracle, counter) {
  const expected = lines.join('\n');
  const lastToken = `zq${String(lines.length).padStart(2, '0')}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const captured = await buildDraft(d, lines, attempt === 1 ? perCharMs : 25);
    await d.settle(700, 10000);
    const ref = await stableComposer(d, lastToken);
    counter.n += 1;
    const cap = await editorCapture(d, oracle, counter.n);
    if (cap === expected) return { captured, ref, cap, attempt };
    note('build-infidelity', `attempt ${attempt}: editor capture ${cap === null ? 'MISSING' : `${cap.length} chars`} vs expected ${expected.length} — ${attempt === 1 ? 'clearing and rebuilding at 25 ms/char' : 'giving up; downstream asserts will fail loudly'}`);
    if (attempt === 1) await clearComposer(d, lines.length);
    else return { captured, ref, cap, attempt };
  }
}

(async () => {
  // ======================= i9a: oracle validation ==========================
  {
    const oracle = makeOracle(`i9a-${which}`);
    const d = await freshSession(`expI9a-${which}`, { EDITOR: oracle.script, VISUAL: oracle.script });
    const lines = makeLines(8);
    const expected = lines.join('\n');
    const counter = { n: 0 };
    const built = await buildVerified(d, lines, 8, oracle, counter);
    const { captured, ref } = built;
    d.snapshot('i9a-ref');
    check('i9a-fits-window', ref.includes('zq01') && ref.includes('zq08'), `whole draft visible: ${JSON.stringify(ref.slice(0, 40))}…`);
    check('i9a-oracle-mechanism', built.cap !== null, built.cap === null ? 'Ctrl+G produced no capture — oracle unusable on this TUI' : `captured ${built.cap.length} chars (build attempt ${built.attempt})`);
    check('i9a-oracle-full-content', built.cap === expected, `capture === typed draft (${built.cap === null ? 'n/a' : `${built.cap.length} vs ${expected.length} chars`})`);
    const afterRoundtrip = await stableComposer(d, 'zq08');
    check('i9a-roundtrip-preserves-composer', afterRoundtrip === ref, `window after Ctrl+G roundtrip unchanged (${JSON.stringify(afterRoundtrip.slice(0, 30))})`);

    // Full maneuver with FAITHFUL bulk replay (both apps validated at this size, i7b).
    const cleared = await clearComposer(d, lines.length);
    check('i9a-clear-empties', cleared.emptied, `mode=${cleared.mode}`);
    d.send(injectForm());
    await sleep(900);
    d.send(captured.join(''));
    const matched = await waitForCond(() => composer(d) === ref, 8000);
    d.snapshot('i9a-after-replay');
    check('i9a-window-oracle-passes', matched >= 0, `faithful replay: window == ref in ${matched} ms`);
    counter.n += 1;
    const cap2 = await editorCapture(d, oracle, counter.n);
    check('i9a-full-verify-complete', cap2 !== null && cap2 === expected, `post-replay capture === full draft — fits-window verify is COMPLETE (${cap2 === null ? 'n/a' : `${cap2.length} chars`})`);
    d.kill();
  }

  // ================= i9b: window-oracle blindness (ASSERTED) ===============
  {
    const oracle = makeOracle(`i9b-${which}`);
    const d = await freshSession(`expI9b-${which}`, { EDITOR: oracle.script, VISUAL: oracle.script });
    const lines = makeLines(40);
    const counter = { n: 0 };
    const built = await buildVerified(d, lines, 8, oracle, counter);
    const { captured, ref } = built;
    const cap1 = built.cap;
    d.snapshot('i9b-ref');
    const firstVisible = (ref.match(/zq\d\d/) || ['<none>'])[0];
    note('i9b-window', `first visible token=${firstVisible} of zq01..zq40 — the composer is a window (build attempt ${built.attempt})`);
    check('i9b-anchor-tail-visible', ref.includes('zq40') && /zq\d\d/.test(ref), `tail rendered: ${JSON.stringify(ref.slice(0, 40))}…`);
    // In-session anchor: the oracle SEES zq01 before the maneuver (and the
    // build gate guarantees the full 40-line draft is byte-exact in the TUI).
    check('i9b-anchor-oracle-sees-full-draft', cap1 !== null && cap1.includes('zq01') && cap1.includes('zq40'), `pre-maneuver capture has zq01 and zq40 (${cap1 === null ? 'n/a' : `${cap1.length} chars`})`);

    const cleared = await clearComposer(d, lines.length);
    check('i9b-clear-empties', cleared.emptied, `mode=${cleared.mode}`);
    d.send(injectForm());
    await sleep(900);

    // TRUNCATED replay: drop the first line and its Alt+Enter separator.
    const segs = lineSegments(captured);
    const truncated = segs.slice(2); // segs[0]=line1 chars, segs[1]='\x1b\r'
    if (which === 'claude') {
      d.send(truncated.join(''));
    } else {
      for (const seg of truncated) { d.send(seg); await sleep(40); }
    }
    const matched = await waitForCond(() => composer(d) === ref, 10000);
    const got = composer(d);
    d.snapshot('i9b-after-truncated-replay');
    // THE BLINDNESS, asserted as measured fact: the window oracle passes on a
    // replay that lost the first line.
    check('i9b-window-oracle-blind-to-prefix-loss', matched >= 0 && got === ref, `window == ref despite zq01 dropped (matched in ${matched} ms)`);
    counter.n += 1;
    const cap2 = await editorCapture(d, oracle, counter.n);
    check('i9b-fullcontent-oracle-catches-loss', cap2 !== null && cap2.includes('zq02') && cap2.includes('zq40') && !cap2.includes('zq01'), `post-replay capture: zq02 ✓ zq40 ✓ zq01 ABSENT (${cap2 === null ? 'n/a' : `${cap2.length} chars`})`);
    d.kill();
  }

  // ================= i9c: ~8 KB probe (MEASURED) ===========================
  {
    const oracle = makeOracle(`i9c-${which}`);
    let d = await freshSession(`expI9c-${which}`, { EDITOR: oracle.script, VISUAL: oracle.script });
    const lines = makeLines(41, 199);
    const expected = lines.join('\n');
    let captured = await buildDraftBulkLines(d, lines);
    const totalBytes = captured.join('').length;
    await d.settle(900, 15000);
    let ref = await stableComposer(d, 'zq41');
    d.snapshot('i9c-ref');
    const visibleTokens = (ref.match(/zq\d\d/g) || []).length;
    note('i9c-shape', `draft=${totalBytes} bytes over ${lines.length} lines × 199 chars; rendered window shows ${visibleTokens} of 41 line tokens (long lines wrap)`);

    const cleared = await clearComposer(d, lines.length);
    note('i9c-clear', `emptied=${cleared.emptied} mode=${cleared.mode}`);
    if (cleared.emptied) {
      d.send(injectForm());
      await sleep(900);

      let form, tReplay, windowMatch, pasted;
      if (which === 'claude') {
        // The 8 KB single-write probe — is bulk replay still faithful at cap size?
        const t0 = Date.now();
        d.send(captured.join(''));
        const m = await waitForCond(() => composer(d) === ref, 12000);
        tReplay = Date.now() - t0;
        windowMatch = m >= 0;
        pasted = /\[Pasted/i.test(d.screenText());
        form = 'bulk';
        if (!windowMatch) {
          note('i9c-bulk-outcome', `bulk 8 KB single write did NOT reconstruct (pasted-attachment=${pasted}, composer=${JSON.stringify(composer(d).slice(0, 60))}) — retrying line-chunked on a fresh session`);
          d.snapshot('i9c-bulk-diverged');
          d.kill();
          d = await freshSession(`expI9c2-${which}`, { EDITOR: oracle.script, VISUAL: oracle.script });
          captured = await buildDraftBulkLines(d, lines);
          await d.settle(900, 15000);
          ref = await stableComposer(d, 'zq41');
          const c2 = await clearComposer(d, lines.length);
          note('i9c-clear2', `emptied=${c2.emptied} mode=${c2.mode}`);
          d.send(injectForm());
          await sleep(900);
          const t1 = Date.now();
          for (const seg of lineSegments(captured)) { d.send(seg); await sleep(40); }
          const m2 = await waitForCond(() => composer(d) === ref, 15000);
          tReplay = Date.now() - t1;
          windowMatch = m2 >= 0;
          pasted = /\[Pasted/i.test(d.screenText());
          form = 'line-chunked';
        }
      } else {
        // codex: bulk paste-collapses at 1.8 KB already (i7c) — line-chunked is
        // its validated at-size form.
        const t0 = Date.now();
        for (const seg of lineSegments(captured)) { d.send(seg); await sleep(40); }
        const m = await waitForCond(() => composer(d) === ref, 15000);
        tReplay = Date.now() - t0;
        windowMatch = m >= 0;
        pasted = /\[Pasted/i.test(d.screenText());
        form = 'line-chunked';
      }
      d.snapshot(`i9c-after-replay-${form}`);
      note('i9c-replay', `form=${form} bytes=${totalBytes} tReplayMs=${tReplay} windowMatch=${windowMatch} pastedAttachment=${pasted}`);

      const cap = await editorCapture(d, oracle, oracle.blocks().length + 1);
      check('i9c-oracle-ran', cap !== null, `capture ${cap === null ? 'MISSING' : `${cap.length} chars`}`);
      if (cap !== null) {
        const full = cap === expected;
        let firstDiff = -1;
        if (!full) for (let i = 0; i < Math.max(cap.length, expected.length); i++) { if (cap[i] !== expected[i]) { firstDiff = i; break; } }
        note('i9c-full-fidelity', `editorVerified=${full} capLen=${cap.length} expectedLen=${expected.length}${full ? '' : ` firstDiffAt=${firstDiff} capCtx=${JSON.stringify(cap.slice(Math.max(0, firstDiff - 20), firstDiff + 30))} expCtx=${JSON.stringify(expected.slice(Math.max(0, firstDiff - 20), firstDiff + 30))}`}`);
      }
    } else {
      d.snapshot('i9c-clear-failed');
      show(d.screen().filter((l) => l), 'i9c composer did not empty');
      note('i9c-abandoned', 'clear did not empty at 41×199 — measured as a size bound on the clear step itself');
    }
    d.kill();
  }

  if (failures.length) {
    console.error(`FAILURES: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('ALL ASSERTIONS PASSED (i9c outcomes are measured, not asserted)');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
