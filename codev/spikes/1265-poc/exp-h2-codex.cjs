/**
 * Spike 1265 — Option H against codex, corrected:
 *  - composer = LAST `›` region (codex echoes submitted msgs with `›` too)
 *  - injected message = /status (recognized, local-only, clears composer)
 *  - newline gestures: Alt+Enter and Ctrl+J only (backslash+Enter SUBMITS in codex)
 */
'use strict';
const { TuiDriver, KEYS, sleep } = require('./harness.cjs');

function composer(d) {
  const lines = d.screen();
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (/^›/.test(lines[i])) start = i;
  if (start === -1) return '<NO-MARKER>';
  const out = [];
  for (let i = start; i < lines.length; i++) {
    if (/^\s{2,}gpt/.test(lines[i])) break;
    out.push(lines[i].replace(/^›\s?/, ''));
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

(async () => {
  const d = new TuiDriver('codex', [], { label: 'expH2-codex' });
  await d.settle(2000, 40000);
  await sleep(1200);
  if (d.screenText().includes('Press enter to continue')) {
    d.send('3'); await sleep(300); d.send('\r');
    await d.settle(2000, 40000); await sleep(800);
  }

  // Build 3-line draft with Alt+Enter + Ctrl+J, include a backspace edit
  const captured = [];
  const typeBytes = async (chunks) => {
    for (const c of chunks) { d.send(c); captured.push(c); await sleep(30); }
  };
  await typeBytes([...'first line']);
  await typeBytes(['\x1b\r']);
  await typeBytes([...'secondX']);
  await typeBytes([KEYS.BACKSPACE]);
  await typeBytes([...' line']);
  await typeBytes(['\n']);
  await typeBytes([...'third']);
  const before = await snap(d, 'c1-draft-3line');

  // Clear: per-line Ctrl+E Ctrl+U Backspace ×3
  for (let i = 0; i < 3; i++) {
    d.send(KEYS.CTRL_E); await sleep(60);
    d.send(KEYS.CTRL_U); await sleep(60);
    d.send(KEYS.BACKSPACE); await sleep(60);
  }
  const cleared = await snap(d, 'c2-after-clear');

  // Inject /status + Enter (local command, composer should clear)
  d.send('/status'); await sleep(150); d.send('\r');
  await snap(d, 'c3-after-inject');

  // Replay captured bytes verbatim
  for (const c of captured) { d.send(c); await sleep(15); }
  const after = await snap(d, 'c4-after-replay');

  console.log(`VERDICT codex-clear-worked=${!cleared.includes('first line')}`);
  console.log(`VERDICT codex-replay-reconstructed=${after === before} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);

  d.kill();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
