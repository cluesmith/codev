/**
 * Spike 1265 — follow-ups:
 *  i2a (codex): atomic write WITH bracketed-paste framing — does the trailing
 *      same-write \r submit, or is a delayed Enter unavoidable on codex?
 *  i2b (codex): semi-atomic — everything except Enter in one write, \r after 60ms.
 *  i2c (claude): app-agnostic per-line clear (Ctrl+E Ctrl+U Backspace ×N) on a
 *      3-line draft, no ESC involved — does it fully clear?
 */
'use strict';
const { TuiDriver, KEYS, sleep } = require('./harness.cjs');

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
  console.log(`RESULT ${label}: composer=${JSON.stringify(text.slice(0, 110))}`);
  return text;
}

(async () => {
  // ---------- codex variants ----------
  const c = new TuiDriver('codex', [], { label: 'expI2-codex' });
  await c.settle(2000, 40000);
  await sleep(1200);
  if (c.screenText().includes('Press enter to continue')) {
    c.send('3'); await sleep(300); c.send('\r');
    await c.settle(2000, 40000); await sleep(800);
  }

  // i2a: fully atomic with brackets
  await c.type('codex draft one');
  c.send(KEYS.CTRL_E + KEYS.CTRL_U + KEYS.PASTE_START + '/status' + KEYS.PASTE_END + '\r' + KEYS.CTRL_Y);
  const i2a = await snap(c, 'i2a-atomic-bracketed', 1200);
  console.log(`VERDICT i2a-submitted-and-restored=${i2a === 'codex draft one'}`);
  for (let i = 0; i < 4; i++) { c.send(KEYS.CTRL_E); await sleep(40); c.send(KEYS.CTRL_U); await sleep(40); c.send(KEYS.BACKSPACE); await sleep(40); }

  // i2b: semi-atomic (kill+msg+yank-pending), Enter delayed 60ms
  await c.type('codex draft two');
  c.send(KEYS.CTRL_E + KEYS.CTRL_U + KEYS.PASTE_START + '/status' + KEYS.PASTE_END);
  await sleep(60);
  c.send('\r');
  await sleep(60);
  c.send(KEYS.CTRL_Y);
  const i2b = await snap(c, 'i2b-semiatomic', 1200);
  console.log(`VERDICT i2b-submitted-and-restored=${i2b === 'codex draft two'}`);
  c.kill();

  // ---------- claude generic clear ----------
  const d = new TuiDriver('claude', [], { label: 'expI2-claude' });
  await d.settle(2000, 40000);
  await sleep(1200);
  await d.type('l-one');
  d.send('\x1b\r'); await sleep(60);
  await d.type('l-two');
  d.send('\x1b\r'); await sleep(60);
  await d.type('l-three');
  await snap(d, 'i2c-3line-draft');
  for (let i = 0; i < 3; i++) {
    d.send(KEYS.CTRL_E); await sleep(50);
    d.send(KEYS.CTRL_U); await sleep(50);
    d.send(KEYS.BACKSPACE); await sleep(50);
  }
  const i2c = await snap(d, 'i2c-after-perline-clear');
  console.log(`VERDICT i2c-generic-clear-worked=${!i2c.includes('l-one') && !i2c.includes('l-three')}`);
  d.kill();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
