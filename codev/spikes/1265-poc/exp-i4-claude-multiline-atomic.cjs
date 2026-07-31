/** Spike 1265 — claude: atomic UNBRACKETED kill/yank with a MULTI-LINE message. */
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

(async () => {
  const d = new TuiDriver('claude', [], { label: 'expI4-claude', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } });
  await d.settle(2000, 40000);
  await sleep(1200);

  await d.type('ml draft');
  const MSG = '[architect] multi msg L1\nmsg L2\nmsg L3';
  d.send(KEYS.CTRL_E + KEYS.CTRL_U + MSG + '\r' + KEYS.CTRL_Y);
  await d.settle(1000, 12000);
  const text = composer(d);
  d.snapshot('i4-after');
  console.log(`RESULT i4: composer=${JSON.stringify(text)}`);
  console.log(`VERDICT i4-draft-restored-clean=${text === 'ml draft'}`);
  d.kill();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
