/** Spike 1265 — Option A part 2: arrows/Tab/backspace, no Ctrl+G (it opens $EDITOR). */
'use strict';
const { TuiDriver, KEYS, sleep, show } = require('./harness.cjs');

const which = process.argv[2] || 'claude';

function inputArea(d) {
  const lines = d.screen();
  const start = lines.findIndex((l) => /^[❯›]/.test(l));
  if (start === -1) return '<NO-MARKER>';
  const out = [];
  for (let i = start; i < lines.length; i++) {
    if (/^[─━╌┄]{5,}/.test(lines[i]) || /^\s*[╰└]/.test(lines[i]) || /^\s{2,}(gpt|high:|~\/)/.test(lines[i])) break;
    out.push(lines[i].replace(/^[❯›]\s?/, ''));
  }
  return out.join('\n').trimEnd();
}

async function check(d, label) {
  await d.settle(500, 6000);
  const text = inputArea(d);
  d.snapshot(label);
  console.log(`RESULT ${label}: line=${JSON.stringify(text.slice(0, 70))}`);
}

(async () => {
  const d = new TuiDriver(which, [], { label: `expA2-${which}` });
  await d.settle(2000, 40000);
  await sleep(1200);
  if (which === 'codex' && d.screenText().includes('Press enter to continue')) {
    d.send('3'); await sleep(300); d.send('\r');
    await d.settle(2000, 40000); await sleep(800);
  }

  d.send(KEYS.UP);
  await check(d, '01-up-on-empty');
  d.send(KEYS.DOWN);
  await check(d, '02-down');
  d.send(KEYS.ESC); await sleep(200);

  d.send(KEYS.TAB);
  await check(d, '03-tab-on-empty');
  show(d.snapshot('03b-tab-screen').slice(-8), 'tab screen tail');
  d.send(KEYS.CTRL_U); await sleep(200);

  await d.type('ab');
  d.send(KEYS.BACKSPACE); await sleep(120); d.send(KEYS.BACKSPACE); await sleep(120);
  await check(d, '04-backspaced-to-empty');

  // left/right arrows mid-draft (cursor moves, content unchanged)
  await d.type('wxyz');
  d.send(KEYS.LEFT); await sleep(80); d.send(KEYS.LEFT); await sleep(80);
  await check(d, '05-left-arrows-mid-draft');
  d.send(KEYS.CTRL_U); await sleep(150);

  d.kill();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
