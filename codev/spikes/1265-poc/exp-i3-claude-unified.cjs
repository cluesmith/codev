/** Spike 1265 — unified atomic delivery string on claude:
 *  Ctrl+E Ctrl+U ESC[200~ msg ESC[201~ \r Ctrl+Y — one write. */
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
  const d = new TuiDriver('claude', [], { label: 'expI3-claude', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } });
  await d.settle(2000, 40000);
  await sleep(1200);

  await d.type('unified draft');
  d.send(KEYS.CTRL_E + KEYS.CTRL_U + KEYS.PASTE_START + '[architect] unified atomic msg' + KEYS.PASTE_END + '\r' + KEYS.CTRL_Y);
  await d.settle(1000, 12000);
  const text = composer(d);
  d.snapshot('i3-after-unified-atomic');
  console.log(`RESULT i3: composer=${JSON.stringify(text)}`);
  const screen = d.screenText();
  console.log(`VERDICT i3-msg-submitted=${screen.includes('unified atomic msg') && !text.includes('unified atomic msg')}`);
  console.log(`VERDICT i3-draft-restored=${text === 'unified draft'}`);
  d.kill();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
