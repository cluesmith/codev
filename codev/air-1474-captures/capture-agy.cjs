#!/usr/bin/env node
/**
 * Capture real agy (Antigravity CLI) PTY screens for the render-gate fixture suite (#1474).
 *
 * Usage:
 *   node capture-agy.cjs <state> <outfile> <cwd>
 *   states: idle | baremarker | draft | menu | trust | quoted
 *
 * `cwd` should be a FRESH directory: agy asks for per-folder trust on first run, which is
 * both the `trust` fixture and the thing every other state has to click through first. For
 * every state except `trust` the dialog is confirmed and the buffer reset afterwards, so the
 * capture is the composer screen rather than the boot sequence.
 *
 * Output is the RAW pty byte stream. Run it through `sanitize.py` before committing — agy's
 * banner embeds the authenticated account email and the session cwd.
 *
 * Requires: `agy` on PATH and authenticated (`agy --print "say OK"` should succeed), and
 * node-pty resolvable (run with NODE_PATH=<repo>/packages/codev/node_modules).
 */
const pty = require('node-pty');
const fs = require('node:fs');

const state = process.argv[2];
const outfile = process.argv[3];
const cwd = process.argv[4] || process.cwd();

// 110x32 matches the geometry the committed fixtures were captured at; the classifier is
// given the same cols/rows when it replays them, so changing this invalidates the fixtures.
const COLS = 110;
const ROWS = 32;

const term = pty.spawn('agy', [], {
  name: 'xterm-256color',
  cols: COLS,
  rows: ROWS,
  cwd,
  env: { ...process.env, TERM: 'xterm-256color' },
});

let buf = '';
term.onData((d) => { buf += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await sleep(12000); // boot, sign-in, first paint (the trust dialog in a fresh dir)

  if (state !== 'trust') {
    term.write('\r'); // confirm "Yes, I trust this folder"
    await sleep(8000);
    buf = ''; // drop the trust dialog + boot; keep the composer screen only
    term.write('\x0c'); // ctrl-L: force a full repaint so the capture is a coherent frame
    await sleep(3000);
  }

  if (state === 'baremarker') {
    // shift+tab cycles the agent mode. Two cycles from accept-edits reaches the mode with no
    // hint text, where the empty composer renders as a BARE `>`.
    term.write('\x1b[Z');
    await sleep(2500);
    term.write('\x1b[Z');
    await sleep(2500);
  } else if (state === 'menu') {
    term.write('/'); // the slash-command menu, whose selection cursor is ALSO `> ` in palette-12
    await sleep(3000);
  } else if (state === 'draft') {
    term.write('review the mailbox change'); // typed, not submitted
    await sleep(3000);
  } else if (state === 'quoted') {
    // Submit a turn, so the transcript carries agy's `> <message>` echo above the composer.
    term.write('Reply with ONLY these four markdown blockquote lines and nothing else: "> alpha" "> beta" "> gamma" "> delta"');
    await sleep(1500);
    term.write('\r');
    await sleep(35000); // let the answer stream and settle
  }

  fs.writeFileSync(outfile, buf);
  process.stdout.write(`captured ${buf.length} bytes -> ${outfile}\n`);
  term.kill();
  process.exit(0);
}

main();
