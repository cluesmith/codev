/**
 * Spike 1265 — Option H evidence: tower-side draft byte capture + verbatim replay.
 *
 * Scenario: user has a MULTI-LINE draft in the composer. Tower must deliver a
 * message. H says: clear the line, inject message+Enter, replay the captured
 * user bytes verbatim to reconstruct the draft.
 *
 * Empirical questions:
 *  h1. What newline gestures build a multi-line draft? (backslash+Enter,
 *      Alt+Enter=\x1b\r, Ctrl+J=\x0a)
 *  h2. What reliably CLEARS a multi-line draft? (ESC ESC on claude;
 *      per-line Ctrl+U(+Backspace) on both?)
 *  h3. Does verbatim byte replay (incl. editing keys like backspace/arrows)
 *      reconstruct the draft exactly?
 *
 * Usage: node exp-h-replay.cjs claude|codex
 */
'use strict';
const { TuiDriver, KEYS, sleep, show } = require('./harness.cjs');

const which = process.argv[2] || 'claude';

function composer(d) {
  const lines = d.screen();
  const start = lines.findIndex((l) => /^[❯›]/.test(l));
  if (start === -1) return '<NO-MARKER>';
  const out = [];
  for (let i = start; i < lines.length; i++) {
    if (/^[─━╌┄]{5,}/.test(lines[i]) || /^\s*[╰└]/.test(lines[i]) || /^\s{2,}(gpt|high:|~\/)/.test(lines[i])) break;
    out.push(lines[i].replace(/^[❯›]\s?/, ''));
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n').trimEnd();
}

async function snap(d, label) {
  await d.settle(600, 8000);
  const text = composer(d);
  d.snapshot(label);
  console.log(`RESULT ${label}: composer=${JSON.stringify(text)}`);
  return text;
}

/** Send a byte string through a per-keystroke writer with human-ish pacing —
 *  this doubles as the "captured stream" we replay verbatim. */
async function typeBytes(d, chunks, capture) {
  for (const c of chunks) {
    d.send(c);
    if (capture) capture.push(c);
    await sleep(30);
  }
}

(async () => {
  const d = new TuiDriver(which, [], { label: `expH-${which}` });
  await d.settle(2000, 40000);
  await sleep(1200);
  if (which === 'codex' && d.screenText().includes('Press enter to continue')) {
    d.send('3'); await sleep(300); d.send('\r');
    await d.settle(2000, 40000); await sleep(800);
  }

  // ---- h1: which newline gestures work?
  await typeBytes(d, [...'aaa']);
  await typeBytes(d, ['\x1b\r']); // Alt+Enter
  await typeBytes(d, [...'bbb']);
  await snap(d, 'h1a-alt-enter-2line');
  // clear whatever we got (per-app best known clear)
  if (which === 'claude') { d.send(KEYS.ESC); await sleep(150); d.send(KEYS.ESC); }
  else { d.send(KEYS.CTRL_U); await sleep(120); d.send(KEYS.BACKSPACE); await sleep(120); d.send(KEYS.CTRL_U); }
  await snap(d, 'h1a-cleared');

  await typeBytes(d, [...'ccc', '\\', '\r', ...'ddd']); // backslash+Enter
  await snap(d, 'h1b-backslash-enter-2line');
  if (which === 'claude') { d.send(KEYS.ESC); await sleep(150); d.send(KEYS.ESC); }
  else { d.send(KEYS.CTRL_U); await sleep(120); d.send(KEYS.BACKSPACE); await sleep(120); d.send(KEYS.CTRL_U); }
  await snap(d, 'h1b-cleared');

  await typeBytes(d, [...'eee', '\n', ...'fff']); // Ctrl+J / raw LF
  await snap(d, 'h1c-ctrl-j-2line');
  if (which === 'claude') { d.send(KEYS.ESC); await sleep(150); d.send(KEYS.ESC); }
  else { d.send(KEYS.CTRL_U); await sleep(120); d.send(KEYS.BACKSPACE); await sleep(120); d.send(KEYS.CTRL_U); }
  await snap(d, 'h1c-cleared');

  // ---- h2 + h3: full H maneuver on a 3-line draft with editing keys in it
  const captured = [];
  // "first line" / "secondX<bs> line" / "third"
  await typeBytes(d, [...'first line'], captured);
  await typeBytes(d, ['\x1b\r'], captured);
  await typeBytes(d, [...'secondX'], captured);
  await typeBytes(d, [KEYS.BACKSPACE], captured);
  await typeBytes(d, [...' line'], captured);
  await typeBytes(d, ['\x1b\r'], captured);
  await typeBytes(d, [...'third'], captured);
  const draftBefore = await snap(d, 'h2-draft-3line');

  // Clear step — count lines from captured stream like Tower would.
  // Strategy CLR-A (claude): ESC ESC.  Strategy CLR-B (codex): per line, Ctrl+E Ctrl+U Backspace.
  if (which === 'claude') {
    d.send(KEYS.ESC); await sleep(200); d.send(KEYS.ESC); await sleep(200);
  } else {
    for (let i = 0; i < 3; i++) {
      d.send(KEYS.CTRL_E); await sleep(60);
      d.send(KEYS.CTRL_U); await sleep(60);
      d.send(KEYS.BACKSPACE); await sleep(60);
    }
  }
  const afterClear = await snap(d, 'h2-after-clear');

  // Inject message (slash command → no model call) + Enter
  d.send('/spike-1265-injected-message');
  await sleep(120);
  d.send('\r');
  await snap(d, 'h2-after-inject');

  // Replay captured bytes verbatim with light pacing
  for (const c of captured) { d.send(c); await sleep(15); }
  const draftAfter = await snap(d, 'h3-after-replay');

  console.log(`VERDICT clear-worked=${afterClear === '' || !afterClear.includes('first line')}`);
  console.log(`VERDICT replay-reconstructed=${draftAfter === draftBefore} before=${JSON.stringify(draftBefore)} after=${JSON.stringify(draftAfter)}`);

  d.kill();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
