/**
 * Spike 1265 — Option A evidence: keystroke → line-occupancy classification
 * against the real TUIs (expectation-based: a step is "cleared" iff the known
 * draft text is no longer present in the input area).
 *
 * Usage: node exp-a-keys.cjs claude|codex
 */
'use strict';
const { TuiDriver, KEYS, sleep, show } = require('./harness.cjs');

const which = process.argv[2] || 'claude';

function inputArea(d) {
  const lines = d.screen();
  const start = lines.findIndex((l) => /^[❯›]/.test(l));
  if (start === -1) return '';
  const out = [];
  for (let i = start; i < lines.length; i++) {
    if (/^[─━╌┄]{5,}/.test(lines[i]) || /^\s*[╰└]/.test(lines[i]) || /^\s{2,}(gpt|high:|~\/)/.test(lines[i])) break;
    out.push(lines[i].replace(/^[❯›]\s?/, ''));
  }
  return out.join('\n').trimEnd();
}

async function check(d, label, expected) {
  await d.settle(500, 6000);
  const text = inputArea(d);
  d.snapshot(label);
  const present = expected ? text.includes(expected) : null;
  console.log(`RESULT ${label}: expected=${JSON.stringify(expected)} present=${present} line=${JSON.stringify(text.slice(0, 60))}`);
  return present;
}

async function start(which) {
  const d = new TuiDriver(which, [], { label: `expA-${which}` });
  await d.settle(2000, 40000);
  await sleep(1200);
  if (which === 'codex' && d.screenText().includes('Press enter to continue')) {
    d.send('3'); await sleep(300); d.send('\r');
    await d.settle(2000, 40000); await sleep(800);
  }
  return d;
}

(async () => {
  const d = await start(which);
  d.snapshot('startup');

  await d.type('draft alpha');
  await check(d, '01-typed', 'draft alpha');

  d.send(KEYS.ESC);
  await check(d, '02-one-esc', 'draft alpha');

  d.send(KEYS.ESC);
  await check(d, '03-two-esc', 'draft alpha');

  await d.type('draft bravo');
  await check(d, '04-retyped', 'draft bravo');
  d.send(KEYS.CTRL_U);
  await check(d, '05-ctrl-u', 'draft bravo');

  await d.type('draft charlie');
  await check(d, '06-typed3', 'draft charlie');
  d.send(KEYS.CTRL_C);
  await check(d, '07-ctrl-c', 'draft charlie');

  await d.type('draft delta');
  d.send(KEYS.CTRL_G);
  await check(d, '08-ctrl-g', 'draft delta');
  // clean up whatever ctrl-g left
  d.send(KEYS.CTRL_U); await sleep(200);

  // arrows/Tab from empty line — the #492 stuck-true keys; do they occupy the line?
  d.send(KEYS.UP);
  await check(d, '09-up-arrow', null);
  d.send(KEYS.DOWN);
  await check(d, '10-down-arrow', null);
  d.send(KEYS.TAB);
  await check(d, '11-tab', null);
  show(d.snapshot('post-tab'), 'post-tab screen');
  d.send(KEYS.CTRL_U); await sleep(200);

  // backspace-to-empty: line empty but naive composing stays true
  await d.type('ab');
  d.send(KEYS.BACKSPACE); await sleep(120); d.send(KEYS.BACKSPACE);
  await check(d, '12-backspaced', 'ab');

  d.kill();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
