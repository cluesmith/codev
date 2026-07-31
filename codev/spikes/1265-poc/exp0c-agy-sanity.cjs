/**
 * Spike 1265 — review round 8, concern 1: agy (Antigravity CLI, the Gemini
 * CLI's replacement) as an afx-send target.
 *
 * Tower's config accepts ARBITRARY architect/builder commands and its harness
 * auto-detect explicitly contemplates gemini-family agents (config.ts:256-278,
 * #929) — so an agy terminal is a configurable send target TODAY, and the
 * findings' per-app delivery matrix (verified: claude, codex) must say what
 * happens for it.
 *
 * EXPLORATORY TIER (observation prints, no assertions): spawn the real `agy`
 * binary under the harness, observe whether it renders a composer, whether
 * typed text appears (occupancy is observable), and whether ^E ^U clears the
 * line (the app-agnostic clear primitive). NOTHING IS EVER SUBMITTED — the
 * session is authenticated (auth cache verified before running) and no prompt
 * is sent to the model; typed probe text is cleared, then the TUI is killed.
 *
 * Usage: node exp0c-agy-sanity.cjs   (requires `agy` on PATH, authenticated —
 *        an unauthenticated agy opens an OAuth browser tab, #1077)
 */
'use strict';
const { TuiDriver, KEYS, sleep, show, logStep } = require('./harness.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Round 9 (trust dialog since cleared by the architect): report SGR attribute
 * runs for rows matching a predicate — feeds the G-lite question "does agy
 * render a recognizable composer marker, and is its placeholder dim like
 * claude/codex's?" without asserting anything (exploratory tier).
 */
function attrRuns(d, predicate, label) {
  const buf = d.term.buffer.active;
  const top = buf.viewportY;
  const lines = d.screen();
  const cell = buf.getNullCell();
  for (let i = 0; i < lines.length; i++) {
    if (!predicate(lines[i], i)) continue;
    const line = buf.getLine(top + i);
    if (!line) continue;
    const runs = [];
    let cur = null;
    for (let col = 0; col < d.cols; col++) {
      line.getCell(col, cell);
      const ch = cell.getChars();
      if (!ch || ch === ' ') continue;
      const key = `dim=${cell.isDim() ? 1 : 0} bold=${cell.isBold() ? 1 : 0}`;
      if (cur && cur.key === key) { cur.text += ch; } else { cur = { key, text: ch }; runs.push(cur); }
    }
    logStep(`${label} row${i}: ${runs.map((r) => `[${JSON.stringify(r.text.slice(0, 30))} ${r.key}]`).join(' ')}`);
  }
}

(async () => {
  // #1077 guard: refuse to spawn an unauthenticated agy (OAuth browser tab).
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.cache', 'codev', 'agy-auth.json'), 'utf8'));
    if (cache.state !== 'auth') {
      console.log(`SKIP: agy auth cache state=${cache.state} — not spawning (would open OAuth tab, #1077)`);
      process.exit(0);
    }
    logStep(`agy auth cache: state=${cache.state} checkedAt=${new Date(cache.checkedAt).toISOString()}`);
  } catch {
    console.log('SKIP: no agy auth cache — not spawning (would open OAuth tab, #1077)');
    process.exit(0);
  }

  const d = new TuiDriver('agy', [], { label: 'exp0c-agy' });
  await d.settle(2500, 45000);
  await sleep(2000);
  show(d.screen(), 'agy initial screen');
  d.snapshot('agy-initial');

  const idle = d.screenText();
  logStep(`composer-marker candidates: ${d.screen().filter((l) => /^[❯›>▌]/.test(l)).map((l) => JSON.stringify(l.slice(0, 40))).join(' | ') || '(none)'}`);

  // Round 9: G-lite relevance — does any row match the marker regex the
  // classifier keys on for claude/codex? (If not, agy stays fail-toward-dirty
  // by construction: no marker → never clean → defer-only + K.)
  const gliteMarkerRows = d.screen().filter((l) => /^[❯›]/.test(l));
  logStep(`G-lite marker regex ^[❯›] matches: ${gliteMarkerRows.length ? gliteMarkerRows.map((l) => JSON.stringify(l.slice(0, 40))).join(' | ') : '(none)'}`);
  // (agy anchors its UI at the TOP of the screen, unlike claude/codex — dump
  // every non-empty row's attributes; there are only ~9.)
  attrRuns(d, (l) => l.trim().length > 0, 'idle-attrs');

  logStep('typing probe token (never submitted)');
  await d.type('qwvzkx probe');
  await d.settle(800, 10000);
  show(d.screen(), 'agy after typing');
  d.snapshot('agy-typed');
  const typedVisible = d.screenText().includes('qwvzkx');
  logStep(`typed text visible on screen: ${typedVisible}`);
  attrRuns(d, (l) => l.includes('qwvzkx'), 'probe-attrs');

  logStep('clearing with ^E ^U (app-agnostic clear primitive)');
  d.send(KEYS.CTRL_E); await sleep(120);
  d.send(KEYS.CTRL_U); await sleep(400);
  await d.settle(800, 10000);
  show(d.screen(), 'agy after ^E ^U');
  d.snapshot('agy-cleared');
  const clearedVisible = d.screenText().includes('qwvzkx');
  logStep(`probe text still visible after ^E ^U: ${clearedVisible}`);

  logStep(`OBSERVATIONS: composer-renders=${typedVisible} ctrlE-ctrlU-clears=${!clearedVisible} (idle screen ${idle.length} chars)`);
  d.kill();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
