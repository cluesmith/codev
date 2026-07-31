/**
 * Spike 1265 — Option J evidence: bracketed-paste framing vs #584 pacing.
 *
 *  j1. #584 repro: multi-line message as ONE plain write + delayed \r —
 *      is the Enter swallowed (message left in composer, unsubmitted)?
 *  j2. J: same message in ONE write wrapped in ESC[200~…ESC[201~ + delayed \r —
 *      does it submit cleanly (no line pacing needed)?
 *  j3. Control chars inside the brackets (\x03, \x1b) — neutralized to content,
 *      or interpreted as keystrokes?
 *
 * TUIs run with an unroutable API base URL: submissions fail fast with a
 * connection error — full submission mechanics, zero model calls.
 *
 * Usage: node exp-j-paste.cjs claude|codex
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

async function snap(d, label) {
  await d.settle(700, 10000);
  const text = composer(d);
  d.snapshot(label);
  console.log(`RESULT ${label}: composer=${JSON.stringify(text.slice(0, 120))}`);
  return text;
}

(async () => {
  const env = which === 'claude'
    ? { ANTHROPIC_BASE_URL: DEAD }
    : { OPENAI_BASE_URL: DEAD, CODEX_BASE_URL: DEAD };
  const d = new TuiDriver(which, [], { label: `expJ-${which}`, env });
  await d.settle(2000, 40000);
  await sleep(1200);
  if (which === 'codex' && d.screenText().includes('Press enter to continue')) {
    d.send('3'); await sleep(300); d.send('\r');
    await d.settle(2000, 40000); await sleep(800);
  }
  d.snapshot('startup');

  const MSG = '[architect] spike J message line-1\nline-2 of the message\nline-3 of the message\nline-4 of the message\nline-5 tail';

  // ---- j1: #584 repro — one plain write, then \r after 50ms
  d.send(MSG);
  await sleep(50);
  d.send('\r');
  const j1 = await snap(d, 'j1-plain-single-write');
  const j1Swallowed = j1.includes('line-5 tail') || j1.includes('line-2');
  console.log(`VERDICT j1-enter-swallowed(message-stuck-in-composer)=${j1Swallowed}`);

  // clean up composer whatever happened
  if (which === 'claude') { d.send(KEYS.ESC); await sleep(150); d.send(KEYS.ESC); }
  for (let i = 0; i < 6; i++) { d.send(KEYS.CTRL_E); await sleep(40); d.send(KEYS.CTRL_U); await sleep(40); d.send(KEYS.BACKSPACE); await sleep(40); }
  await snap(d, 'j1-cleaned');

  // ---- j2: bracketed-paste framing, one write, then \r after 50ms
  d.send(KEYS.PASTE_START + MSG + KEYS.PASTE_END);
  await sleep(50);
  d.send('\r');
  const j2 = await snap(d, 'j2-bracketed-single-write');
  const j2Submitted = !j2.includes('line-5 tail') && !j2.includes('[Pasted text');
  console.log(`VERDICT j2-bracketed-submitted=${j2Submitted}`);
  show(d.snapshot('j2-screen').slice(-14), 'post-j2 screen tail');

  // clean up
  if (which === 'claude') { d.send(KEYS.ESC); await sleep(150); d.send(KEYS.ESC); }
  for (let i = 0; i < 6; i++) { d.send(KEYS.CTRL_E); await sleep(40); d.send(KEYS.CTRL_U); await sleep(40); d.send(KEYS.BACKSPACE); await sleep(40); }

  // ---- j3: control chars inside brackets (Ctrl+C, ESC) — neutralized?
  d.send(KEYS.PASTE_START + 'ctrl-c here:\x03 esc here:\x1b end' + KEYS.PASTE_END);
  const j3 = await snap(d, 'j3-ctrlchars-in-brackets');
  console.log(`VERDICT j3-tui-survived=${!d.exited} composer-nonempty=${j3.length > 0}`);
  show(d.snapshot('j3-screen').slice(-10), 'post-j3 screen tail');

  d.kill();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
