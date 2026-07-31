/**
 * Spike 1265 — review round 3 demos, reworked in round 4 to be self-asserting
 * and session-isolated, and again in round 5 after a reviewer reproduced
 * failures on fresh reruns of the claude suite.
 *
 * Round-5 changes (reviewer: "retry state contaminates the right-order
 * scenario; the Up-recall assertion is brittle"):
 *  - i6b's wrong-order and right-order cases now run in SEPARATE fresh
 *    sessions. The old shape shared one session: the wrong-order case left the
 *    dead-API session retrying, and the ESC ESC "cleanup" between cases is
 *    exactly the gesture that interrupts the in-flight retry and restores
 *    queued/interrupted content into the composer (integration-constraint 4c)
 *    — so the right-order case started from an unknowable composer.
 *  - The Up-recall assertion is gone. Up reads per-project history (shared
 *    with any OTHER claude session running in this repo — e.g. the reviewer's
 *    own) and behaves differently while messages are queued ("press up to
 *    edit queued messages"). Both cases now assert on the TRANSCRIPT: a
 *    submitted message renders as its own conversation entry, so the blob
 *    check is "the concatenated string appears on screen" and the clean check
 *    is "the draft appears on screen, the concatenation does not" — same
 *    pattern i6c already used for the /afx selection.
 *  - Draft strings are collision-proof tokens (no 'def' ⊂ "default"-style
 *    substring collisions with TUI chrome).
 *
 * Demos:
 *  i6b-wrong (own session): message written BEFORE the user's \r reaches the
 *      PTY → transcript shows ONE blob entry "draft+message".
 *  i6b-right (own session): user's \r written FIRST, then the message →
 *      transcript shows the draft alone; no concatenated entry; composer
 *      clean afterwards.
 *  i6a (own session): ungated keystroke between inject and replay is applied
 *      twice (live + replay-append); gated divert-then-append is
 *      byte-identical to draft+key.
 *  i6c (own session, both TUIs): "/" menu open — bare \r is consumed by the
 *      menu (claude submits the SELECTION /afx; codex opens the model
 *      picker), never a plain composer submit.
 *
 * Usage: node exp-i6-gating.cjs claude|codex   (codex runs i6c only)
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

const failures = [];
function check(label, ok, detail) {
  console.log(`ASSERT ${label}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
  if (!ok) failures.push(label);
}

async function snap(d, label, settleMs = 800) {
  await d.settle(settleMs, 12000);
  const text = composer(d);
  d.snapshot(label);
  console.log(`RESULT ${label}: composer=${JSON.stringify(text)}`);
  return text;
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

async function buildDraft(d, cap) {
  const typeBytes = async (chunks) => { for (const c of chunks) { d.send(c); cap.push(c); await sleep(28); } };
  await typeBytes([...'first line']);
  await typeBytes(['\x1b\r']);
  await typeBytes([...'second line']);
}

async function perLineClear(d, rounds) {
  for (let i = 0; i < rounds; i++) {
    d.send(KEYS.CTRL_E); await sleep(50);
    d.send(KEYS.CTRL_U); await sleep(50);
    d.send(KEYS.BACKSPACE); await sleep(50);
  }
}

(async () => {
  if (which === 'claude') {
    // ---------- i6b wrong-order: flush before user's \r (OWN session) ----------
    {
      const d = await freshSession('expI6bWrong-claude');
      await d.type('wrduvq');
      d.send('[architect] wrongorder'); // flush fired before user's \r written
      await sleep(50);
      d.send('\r');
      await sleep(80);
      d.send('\r');                     // user's Enter arrives after — line already empty
      await sleep(1200);
      const comp = await snap(d, 'i6b-wrong-order-composer');
      const txt = d.screenText();
      // The submitted blob renders as ONE transcript entry (no Up-recall — see header).
      check('i6b-blob-submitted', txt.includes('wrduvq[architect] wrongorder'),
        `transcript-has-blob=${txt.includes('wrduvq[architect] wrongorder')}`);
      check('i6b-wrong-composer-empty', !comp.includes('wrduvq'), `composer=${JSON.stringify(comp.slice(0, 60))}`);
      d.kill();
    }

    // ---------- i6b right-order: user's \r first, then message (OWN session) ----------
    {
      const d = await freshSession('expI6bRight-claude');
      await d.type('rtdkzp');
      d.send('\r');                     // user's Enter written FIRST
      d.send('[architect] rightorder');
      await sleep(50);
      d.send('\r');
      await sleep(1200);
      const right = await snap(d, 'i6b-right-order-composer');
      const txt = d.screenText();
      check('i6b-right-no-blob', !txt.includes('rtdkzp[architect]'),
        `concatenated-entry-present=${txt.includes('rtdkzp[architect]')}`);
      check('i6b-right-draft-own-entry', txt.includes('rtdkzp'), 'draft submitted as its own entry');
      check('i6b-right-order-clean', !right.includes('rtdkzp'), `composer=${JSON.stringify(right.slice(0, 60))}`);
      d.kill();
    }

    // ---------- i6a: input gating (own session — no queued-msg contamination) ----------
    {
      const d = await freshSession('expI6a-claude');
      // ungated variant: its own draft + baseline
      const cap = [];
      await buildDraft(d, cap);
      const ref1 = await snap(d, 'i6a-ungated-draft');
      check('i6a-ungated-draft-clean', ref1 === 'first line\n  second line', `draft=${JSON.stringify(ref1)}`);
      await perLineClear(d, 2);
      d.send(KEYS.CTRL_E + KEYS.CTRL_U + '[architect] gateless inject' + '\r');
      await sleep(120);
      d.send('Z');                      // ungated user keystroke
      await sleep(120);
      for (const c of [...cap, 'Z']) { d.send(c); await sleep(14); } // naive append policy
      const ungated = await snap(d, 'i6a-ungated-result');
      const zCount = (ungated.match(/Z/g) || []).length;
      check('i6a-ungated-double-apply', zCount === 2 && ungated !== ref1 + 'Z', `zCount=${zCount} result=${JSON.stringify(ungated)}`);
      await perLineClear(d, 6);

      // gated variant: fresh draft + its own baseline
      const cap2 = [];
      await buildDraft(d, cap2);
      const ref2 = await snap(d, 'i6a-gated-draft');
      check('i6a-gated-draft-clean', ref2 === 'first line\n  second line', `draft=${JSON.stringify(ref2)}`);
      await perLineClear(d, 2);
      d.send(KEYS.CTRL_E + KEYS.CTRL_U + '[architect] gated inject' + '\r');
      await sleep(240);                 // the Z "arrives" here but the gate holds it
      for (const c of cap2) { d.send(c); await sleep(14); }
      d.send('Z');                      // gate releases after replay
      const gated = await snap(d, 'i6a-gated-result');
      check('i6a-gated-clean', gated === ref2 + 'Z', `result=${JSON.stringify(gated)}`);
      d.kill();
    }
  }

  // ---------- i6c: "/" menu Enter-ambiguity (own session, both TUIs) ----------
  {
    const d = await freshSession(`expI6c-${which}`);
    d.send('/');
    await sleep(700);
    show(d.snapshot('i6c-menu-open').slice(-14), `${which} slash menu`);
    const menuVisible = which === 'claude'
      ? d.screenText().includes('/afx')
      : d.screenText().includes('/model');
    check('i6c-menu-open', menuVisible, 'slash menu rendered');
    d.send('\r');
    await sleep(1000);
    await snap(d, 'i6c-after-enter');
    show(d.snapshot('i6c-screen').slice(-14), `${which} after enter on menu`);
    if (which === 'claude') {
      // Enter submitted the SELECTION (/afx), not the composer content "/"
      check('i6c-enter-consumed-by-menu', d.screenText().includes('❯ /afx'), 'selection /afx submitted');
    } else {
      // Enter opened the model-picker modal
      check('i6c-enter-opened-modal', d.screenText().includes('Select Model'), 'model picker modal open');
    }
    d.kill();
  }

  if (failures.length) {
    console.error(`FAILURES: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('ALL ASSERTIONS PASSED');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
