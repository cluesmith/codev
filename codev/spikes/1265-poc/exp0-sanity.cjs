/** Spike 1265 — exp0: harness sanity vs real `claude` TUI. */
'use strict';
const { TuiDriver, KEYS, sleep, logStep, show } = require('./harness.cjs');

(async () => {
  logStep('spawn claude');
  const d = new TuiDriver('claude', [], { label: 'exp0-claude' });
  await d.settle(1200, 25000);
  show(d.snapshot('startup'), 'startup');

  logStep('type draft');
  await d.type('hello draft one');
  await d.settle(500, 5000);
  show(d.snapshot('typed'), 'typed');

  logStep('press ESC');
  d.send(KEYS.ESC);
  await d.settle(500, 5000);
  show(d.snapshot('after-esc'), 'after-esc');

  d.kill();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
