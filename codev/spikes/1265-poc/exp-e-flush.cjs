/**
 * Spike 1265 — Option E evidence: flush-on-submit timing (claude, dead API URL).
 *
 *  e0. Baseline corruption repro: half-typed draft + 3.5s pause ("thinking"),
 *      then today's delivery (write + \r@50ms) → blob submitted as one. (The
 *      exact #1265 failure.)
 *  e1. E: deliver immediately AFTER user submits — message lands on empty
 *      composer, cleanly, as its own submission.
 *  e2. UP-arrow with history present: does the line become occupied? (claude
 *      half of the arrows-occupancy question; codex half already proven.)
 */
'use strict';
const { TuiDriver, KEYS, sleep, show } = require('./harness.cjs');

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
  console.log(`RESULT ${label}: composer=${JSON.stringify(text.slice(0, 100))}`);
  return text;
}

(async () => {
  const d = new TuiDriver('claude', [], { label: 'expE-claude', env: { ANTHROPIC_BASE_URL: DEAD } });
  await d.settle(2000, 40000);
  await sleep(1200);

  // ---- e0: baseline corruption (idle-timer path, today's behavior)
  await d.type('deploy the hotfix to prod once');
  await sleep(3500); // user pauses to think — isUserIdle(3000) becomes true
  d.send('[builder spir-999] tests green, ready to merge'); // tower delivers
  await sleep(50);
  d.send('\r');
  await sleep(1500);
  const e0 = await snap(d, 'e0-corruption-blob');
  show(d.snapshot('e0-screen').slice(-16), 'e0 screen tail');

  // ---- e1: flush-on-submit — user submits, deliver instantly
  d.send(KEYS.ESC); await sleep(150); d.send(KEYS.ESC); await sleep(300); // clean composer
  await d.type('first user message');
  d.send('\r');                     // user submits
  d.send('[architect] follow-up instruction'); // tower flushes at t≈0 after Enter
  await sleep(50);
  d.send('\r');
  await sleep(1200);
  const e1 = await snap(d, 'e1-after-flush-on-submit');
  show(d.snapshot('e1-screen').slice(-20), 'e1 screen tail');

  // ---- e2: UP with history
  d.send(KEYS.ESC); await sleep(150); d.send(KEYS.ESC); await sleep(300);
  d.send(KEYS.UP);
  const e2 = await snap(d, 'e2-up-with-history');
  console.log(`VERDICT e2-up-occupies-line=${e2.length > 0 && !/^Try "/.test(e2)}`);

  d.kill();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
