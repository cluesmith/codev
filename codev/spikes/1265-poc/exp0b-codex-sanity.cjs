/** Spike 1265 — exp0b: codex TUI layout discovery. */
'use strict';
const { TuiDriver, KEYS, sleep, logStep, show } = require('./harness.cjs');

(async () => {
  const d = new TuiDriver('codex', [], { label: 'exp0b-codex' });
  await d.settle(2000, 40000);
  await sleep(1500);
  if (d.screenText().includes('Update available')) {
    d.send('3'); await sleep(300); d.send('\r');
    await d.settle(2000, 40000);
    await sleep(1000);
  }
  show(d.snapshot('startup'), 'codex startup');

  await d.type('hello codex draft');
  await d.settle(800, 8000);
  show(d.snapshot('typed'), 'codex typed');

  d.send(KEYS.ESC);
  await d.settle(800, 8000);
  show(d.snapshot('after-esc'), 'codex after one esc');

  d.kill();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
