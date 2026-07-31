/**
 * Spike 1265 — round 14 (architect request): enumerate each TUI's OWN view of
 * its keyboard bindings via the built-in introspection commands, and ground
 * the keybinding-customization constraint (findings constraint 17e).
 *
 *   claude  /keybindings
 *   codex   /keymap
 *   agy     /keybindings
 *
 * EXPLORATORY TIER (exp0-style: observation prints, minimal asserts — the
 * panels' CONTENT is the evidence, captured into the .out). Context: the
 * spike's delivery forms and the DraftTracker classification table assume
 * each app's DEFAULT binding semantics. Claude bindings are user-customizable
 * via ~/.claude/keybindings.json — the live file on THIS box (the box every
 * claude measurement ran on) is a schema'd per-context table that includes
 * `enter: chat:submit` and `ctrl+j: chat:newline` as BINDABLE actions, and
 * diverges from the published reference at ctrl+l (chat:clearInput here vs
 * "redraw screen" in the docs) — per-install divergence is live, not
 * hypothetical. This probe records what each app reports about its own
 * bindings so the findings can cite measured panels, and demonstrates the
 * introspection commands are composer-consuming UI commands (usable in a lab;
 * NEVER injectable in production).
 *
 * Zero API traffic: claude runs against a dead ANTHROPIC_BASE_URL; codex runs
 * in the i12d scratch-home dead-provider rig; agy only opens a local panel
 * (nothing is ever submitted to a model; the #1077 unauthenticated-agy guard
 * from exp0c is replicated).
 *
 * Usage: node exp-i13-keybindings.cjs claude
 *        node exp-i13-keybindings.cjs codex
 *        node exp-i13-keybindings.cjs agy
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TuiDriver, sleep, show, logStep } = require('./harness.cjs');

const which = process.argv[2] || 'claude';
const DEAD = 'http://127.0.0.1:9';
const ROWS = 45; // taller than the default 32 — capture more of the panel

function dumpScreen(d, label) {
  const lines = d.screen().map((l, i) => ({ l, i })).filter(({ l }) => l.trim().length > 0);
  console.log(`\n----- ${label} (${lines.length} non-empty rows of ${ROWS}) -----`);
  for (const { l, i } of lines) console.log(`${String(i).padStart(2)}| ${l}`);
  console.log(`----- end ${label} -----\n`);
  d.snapshot(label);
}

async function typeSlashCommand(d, cmd) {
  logStep(`typing ${cmd}`);
  await d.type(cmd); // '/' opens the app's slash menu; the rest filters it
  await d.settle(900, 15000);
  dumpScreen(d, `${which}-menu-filtered`);
  d.send('\r'); // menu Enter executes the highlighted command (i6c semantics)
  await d.settle(1500, 25000);
  await sleep(600);
}

(async () => {
  if (which === 'claude') {
    // Live customization-surface evidence, recorded alongside the panel.
    const kbPath = path.join(os.homedir(), '.claude', 'keybindings.json');
    if (fs.existsSync(kbPath)) {
      try {
        const kb = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
        const chat = (kb.bindings || []).find((b) => b.context === 'Chat');
        const keys = chat ? Object.keys(chat.bindings || {}) : [];
        logStep(`~/.claude/keybindings.json EXISTS on this box; Chat-context bindable keys: ${keys.join(', ')}`);
        logStep(`Chat submit binding: ${chat ? JSON.stringify({ enter: chat.bindings.enter, 'ctrl+j': chat.bindings['ctrl+j'], 'ctrl+l': chat.bindings['ctrl+l'] }) : 'n/a'}`);
        const editKeys = ['ctrl+a', 'ctrl+e', 'ctrl+u', 'ctrl+k', 'ctrl+w', 'ctrl+y', 'backspace'];
        const enumerated = editKeys.filter((k) => keys.includes(k));
        logStep(`low-level edit keys (maneuver bytes) enumerated in Chat bindings: ${enumerated.length ? enumerated.join(', ') : 'NONE (not bindable via this file, per the live table)'}`);
      } catch (e) { logStep(`keybindings.json unreadable: ${e.message}`); }
    } else {
      logStep('~/.claude/keybindings.json absent on this box');
    }

    const d = new TuiDriver('claude', [], { label: 'expI13claude', rows: ROWS, env: { ANTHROPIC_BASE_URL: DEAD } });
    await d.settle(2000, 40000);
    await sleep(1200);
    await typeSlashCommand(d, '/keybindings');
    dumpScreen(d, 'claude-keybindings-panel');
    const t = d.screenText();
    logStep(`panel mentions: keybind=${/keybind/i.test(t)} shortcut=${/shortcut/i.test(t)} customiz=${/customiz/i.test(t)} json=${/keybindings\.json/i.test(t)}`);
    d.kill();
  }

  if (which === 'codex') {
    // i12d dead-provider scratch home — pristine DEFAULT bindings, zero traffic.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'i13-codex-home-'));
    fs.writeFileSync(path.join(home, 'config.toml'), [
      'model = "gpt-5"',
      'model_provider = "dead"',
      '[model_providers.dead]',
      'name = "dead"',
      `base_url = "${DEAD}/v1"`,
      'wire_api = "responses"',
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-dead-i13' }) + '\n');
    logStep(`scratch CODEX_HOME=${home} (pristine defaults — no user keymap config)`);

    const d = new TuiDriver('codex', [], { label: 'expI13codex', rows: ROWS, env: { CODEX_HOME: home } });
    await d.settle(2000, 40000);
    await sleep(1200);
    for (let round = 0; round < 5; round++) {
      const text = d.screenText();
      if (/Press enter to continue/i.test(text)) { d.send('\r'); }
      else if (/allow codex|trust this (folder|directory)|do you trust/i.test(text)) { d.send('\r'); }
      else break;
      await d.settle(1500, 20000); await sleep(600);
    }
    await typeSlashCommand(d, '/keymap');
    dumpScreen(d, 'codex-keymap-panel');
    const t = d.screenText();
    logStep(`panel mentions: keymap=${/keymap/i.test(t)} shortcut=${/shortcut/i.test(t)} customiz=${/customiz/i.test(t)}`);
    d.kill();
  }

  if (which === 'agy') {
    // #1077 guard from exp0c: never spawn an unauthenticated agy (OAuth tab).
    try {
      const cache = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.cache', 'codev', 'agy-auth.json'), 'utf8'));
      if (cache.state !== 'auth') {
        console.log(`SKIP: agy auth cache state=${cache.state} — not spawning (would open OAuth tab, #1077)`);
        process.exit(0);
      }
      logStep(`agy auth cache: state=${cache.state}`);
    } catch {
      console.log('SKIP: no agy auth cache — not spawning (would open OAuth tab, #1077)');
      process.exit(0);
    }

    const d = new TuiDriver('agy', [], { label: 'expI13agy', rows: ROWS });
    await d.settle(2500, 40000);
    await sleep(1200);
    dumpScreen(d, 'agy-boot');
    if (/trust/i.test(d.screenText())) {
      logStep('trust dialog present — accepting for this (our own) worktree');
      d.send('\r');
      await d.settle(2000, 25000); await sleep(800);
    }
    await typeSlashCommand(d, '/keybindings');
    dumpScreen(d, 'agy-keybindings-panel');
    const t = d.screenText();
    logStep(`panel mentions: keybind=${/keybind/i.test(t)} shortcut=${/shortcut/i.test(t)} customiz=${/customiz/i.test(t)}`);
    d.kill();
  }

  console.log('\nEXPLORATORY RUN COMPLETE');
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
