/**
 * Spike 1265 — review round 3: integration-semantics demos.
 *
 *  i6b (concern 3 — flush ordering): if the E-flush writes the message BEFORE
 *      the user's Enter byte reaches the PTY, the message lands on the still-
 *      occupied line and the user's Enter submits the blob. Then the correct
 *      ordering (message written strictly AFTER the user's \r) for contrast.
 *  i6a (concern 2 — input gating): an ungated user keystroke arriving between
 *      H's inject and replay corrupts the reconstruction — and if Tower ALSO
 *      appends it to the replay (the doc's old claim), it appears TWICE.
 *      Gated variant (hold the byte, apply after replay) is clean.
 *  i6c (concern 4 — Enter ≠ submit): with the "/" command menu open, a bare
 *      \r is consumed by the menu, not the composer — a tracker counting it
 *      as "submitted → composer empty" diverges. Run on BOTH TUIs.
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

async function snap(d, label, settleMs = 800) {
  await d.settle(settleMs, 12000);
  const text = composer(d);
  d.snapshot(label);
  console.log(`RESULT ${label}: composer=${JSON.stringify(text)}`);
  return text;
}

async function perLineClear(d, rounds) {
  for (let i = 0; i < rounds; i++) {
    d.send(KEYS.CTRL_E); await sleep(50);
    d.send(KEYS.CTRL_U); await sleep(50);
    d.send(KEYS.BACKSPACE); await sleep(50);
  }
}

(async () => {
  const env = which === 'claude' ? { ANTHROPIC_BASE_URL: DEAD } : {};
  const d = new TuiDriver(which, [], { label: `expI6-${which}`, env });
  await d.settle(2000, 40000);
  await sleep(1200);
  if (which === 'codex' && d.screenText().includes('Press enter to continue')) {
    d.send('3'); await sleep(300); d.send('\r');
    await d.settle(2000, 40000); await sleep(800);
  }

  if (which === 'claude') {
    // ---- i6b: flush ordering — WRONG order first
    await d.type('abc');
    d.send('[architect] wrongorder'); // flush fired before user's \r was written
    await sleep(50);
    d.send('\r');            // flush's Enter
    await sleep(80);
    d.send('\r');            // the user's Enter finally arrives
    await sleep(1000);
    await snap(d, 'i6b-wrong-order-composer');
    d.send(KEYS.UP);         // recall last submission to prove the blob
    const blob = await snap(d, 'i6b-wrong-order-recall');
    console.log(`VERDICT i6b-blob-submitted=${blob.includes('abc[architect] wrongorder')}`);
    d.send(KEYS.ESC); await sleep(200); d.send(KEYS.ESC); await sleep(300);

    // Correct order for contrast (same shape as e1): user \r written first
    await d.type('def');
    d.send('\r');            // user's Enter reaches the PTY first
    d.send('[architect] rightorder');
    await sleep(50);
    d.send('\r');
    await sleep(1000);
    const right = await snap(d, 'i6b-right-order-composer');
    console.log(`VERDICT i6b-right-order-clean=${!right.includes('def')}`);
    d.send(KEYS.ESC); await sleep(200); d.send(KEYS.ESC); await sleep(300);

    // ---- i6a: ungated interleave during H maneuver
    const cap = [];
    const typeBytes = async (chunks) => { for (const c of chunks) { d.send(c); cap.push(c); await sleep(28); } };
    await typeBytes([...'first line']);
    await typeBytes(['\x1b\r']);
    await typeBytes([...'second line']);
    const ref = await snap(d, 'i6a-draft');

    await perLineClear(d, 2);
    d.send(KEYS.CTRL_E + KEYS.CTRL_U + '[architect] gateless inject' + '\r'); // inject, no ^Y
    await sleep(120);
    d.send('Z');             // ungated user keystroke lands between inject and replay
    await sleep(120);
    for (const c of [...cap, 'Z']) { d.send(c); await sleep(14); } // old doc: "append late arrivals to replay"
    const ungated = await snap(d, 'i6a-ungated-result');
    console.log(`VERDICT i6a-ungated-corrupt=${ungated !== ref + 'Z'} zCount=${(ungated.match(/Z/g) || []).length} result=${JSON.stringify(ungated)}`);
    await perLineClear(d, 6);

    // Gated variant: the Z is diverted during the maneuver, applied after replay
    const cap2 = [];
    const typeBytes2 = async (chunks) => { for (const c of chunks) { d.send(c); cap2.push(c); await sleep(28); } };
    await typeBytes2([...'first line']);
    await typeBytes2(['\x1b\r']);
    await typeBytes2([...'second line']);
    await snap(d, 'i6a-draft2');
    await perLineClear(d, 2);
    d.send(KEYS.CTRL_E + KEYS.CTRL_U + '[architect] gated inject' + '\r');
    await sleep(240);        // Z arrives here but the gate HOLDS it
    for (const c of cap2) { d.send(c); await sleep(14); }
    d.send('Z');             // gate releases the held byte after replay
    const gated = await snap(d, 'i6a-gated-result');
    console.log(`VERDICT i6a-gated-clean=${gated === ref + 'Z'} result=${JSON.stringify(gated)}`);
    await perLineClear(d, 6);
  }

  // ---- i6c: "/" menu open — is a bare \r consumed by the menu? (both TUIs)
  d.send('/');
  await sleep(600);
  show(d.snapshot('i6c-menu-open').slice(-16), `${which} slash menu`);
  d.send('\r');
  await sleep(900);
  const after = await snap(d, 'i6c-after-enter');
  show(d.snapshot('i6c-screen').slice(-16), `${which} after enter on menu`);
  console.log(`VERDICT i6c-see-snapshots (composer=${JSON.stringify(after.slice(0, 60))})`);

  d.kill();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
