/**
 * Spike 1265 — Options B/C/I evidence: kill/yank restore, race window, atomic write.
 *
 *  b1. Separate-writes kill/yank (today-style pacing): Ctrl+E, Ctrl+U, msg,
 *      \r@50ms, Ctrl+Y@+60ms — single-line draft restored?
 *  b2. Race: user keystrokes injected 20ms after the Ctrl+U — corruption?
 *  b3. Atomic (Option I): entire sequence as ONE write — does \r submit
 *      mid-write and Ctrl+Y restore? User byte 5ms later — lands cleanly after?
 *  b4. Multi-line draft + single Ctrl+U — only current line killed (B's limit)?
 *
 * Usage: node exp-bi-killyank.cjs claude|codex
 * (codex: injected message is /status — local, no model call, YOLO-safe)
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

async function snap(d, label, settleMs = 700) {
  await d.settle(settleMs, 12000);
  const text = composer(d);
  d.snapshot(label);
  console.log(`RESULT ${label}: composer=${JSON.stringify(text.slice(0, 110))}`);
  return text;
}

async function clearComposer(d) {
  if (which === 'claude') { d.send(KEYS.ESC); await sleep(150); d.send(KEYS.ESC); await sleep(250); }
  for (let i = 0; i < 4; i++) { d.send(KEYS.CTRL_E); await sleep(40); d.send(KEYS.CTRL_U); await sleep(40); d.send(KEYS.BACKSPACE); await sleep(40); }
  await sleep(200);
}

(async () => {
  const env = which === 'claude' ? { ANTHROPIC_BASE_URL: DEAD } : {};
  const MSG = which === 'claude' ? '[architect] injected-while-busy' : '/status';
  const d = new TuiDriver(which, [], { label: `expBI-${which}`, env });
  await d.settle(2000, 40000);
  await sleep(1200);
  if (which === 'codex' && d.screenText().includes('Press enter to continue')) {
    d.send('3'); await sleep(300); d.send('\r');
    await d.settle(2000, 40000); await sleep(800);
  }

  // ---- b1: separate-writes kill/yank
  await d.type('precious draft text');
  await snap(d, 'b1-draft');
  d.send(KEYS.CTRL_E); await sleep(30);
  d.send(KEYS.CTRL_U); await sleep(30);
  d.send(MSG);
  await sleep(50);
  d.send('\r');
  await sleep(60);
  d.send(KEYS.CTRL_Y);
  const b1 = await snap(d, 'b1-after-killyank', 1000);
  console.log(`VERDICT b1-draft-restored=${b1.includes('precious draft text')}`);
  await clearComposer(d);

  // ---- b2: race — user types "ZZ" 20ms after the kill
  await d.type('racy draft');
  d.send(KEYS.CTRL_E); await sleep(30);
  d.send(KEYS.CTRL_U);
  setTimeout(() => d.send('Z'), 20);
  setTimeout(() => d.send('Z'), 40);
  d.send(MSG);
  await sleep(50);
  d.send('\r');
  await sleep(60);
  d.send(KEYS.CTRL_Y);
  const b2 = await snap(d, 'b2-after-race', 1000);
  console.log(`VERDICT b2-clean=${b2 === 'racy draft'} (composer=${JSON.stringify(b2.slice(0, 60))})`);
  await clearComposer(d);

  // ---- b3: atomic single write (Option I)
  await d.type('atomic draft');
  const atomic = KEYS.CTRL_E + KEYS.CTRL_U + MSG + '\r' + KEYS.CTRL_Y;
  d.send(atomic);
  setTimeout(() => d.send('Q'), 5); // user byte right after — must not interleave
  const b3 = await snap(d, 'b3-after-atomic', 1200);
  console.log(`VERDICT b3-restored=${b3.includes('atomic draft')} b3-userbyte-appended=${b3.includes('Q')} composer=${JSON.stringify(b3.slice(0, 80))}`);
  show(d.snapshot('b3-screen').slice(-14), 'b3 screen tail');
  await clearComposer(d);

  // ---- b4: multi-line draft, single Ctrl+U
  await d.type('top line');
  d.send('\x1b\r'); await sleep(60);
  await d.type('bottom line');
  await snap(d, 'b4-multiline-draft');
  d.send(KEYS.CTRL_U);
  const b4 = await snap(d, 'b4-after-single-ctrl-u');
  console.log(`VERDICT b4-only-current-line-killed=${b4.includes('top line') && !b4.includes('bottom line')}`);

  d.kill();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
