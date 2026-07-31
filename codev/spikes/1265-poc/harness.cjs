/**
 * Spike 1265 POC harness — drive real TUIs (Claude Code, Codex) under a PTY
 * and assert on the *rendered* screen via @xterm/headless.
 *
 * POC quality: no tests, no polish. Evidence generator for the findings doc.
 *
 * Resolution:
 *  - node-pty comes from the repo's installed store (worktree first, then the
 *    main checkout two levels up — worktrees are nested in .builders/).
 *  - @xterm/headless comes from XTERM_DIR env (spike installs it in the
 *    session scratchpad) or plain require as fallback.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');

const WORKTREE_ROOT = path.resolve(__dirname, '..', '..', '..');
const MAIN_ROOT = path.resolve(WORKTREE_ROOT, '..', '..');

function resolveDep(name, extraDirs = []) {
  const candidates = [
    ...extraDirs,
    path.join(WORKTREE_ROOT, 'packages', 'codev', 'node_modules'),
    path.join(MAIN_ROOT, 'packages', 'codev', 'node_modules'),
  ];
  for (const dir of candidates) {
    try {
      const req = createRequire(path.join(dir, 'noop.js'));
      return req(name);
    } catch { /* next */ }
  }
  return require(name); // last resort
}

const pty = resolveDep('node-pty');
const xtermDirs = process.env.XTERM_DIR ? [path.join(process.env.XTERM_DIR, 'node_modules')] : [];
const { Terminal } = resolveDep('@xterm/headless', xtermDirs);

// Round 9: record the emulator version in every run's output — the suite is
// the version-bump smoke test, so its own render substrate must be pinned
// and visible in the evidence (@xterm/headless 6.0.0 is the reference).
try {
  const v = resolveDep('@xterm/headless/package.json', xtermDirs).version;
  console.log(`HARNESS @xterm/headless=${v} node=${process.version}`);
} catch { console.log('HARNESS @xterm/headless=unknown'); }

// ---------------------------------------------------------------------------

const KEYS = {
  ENTER: '\r',
  ESC: '\x1b',
  CTRL_C: '\x03',
  CTRL_E: '\x05',
  CTRL_G: '\x07',
  CTRL_U: '\x15',
  CTRL_Y: '\x19',
  ALT_ENTER: '\x1b\r',
  BACKSPACE: '\x7f',
  TAB: '\t',
  UP: '\x1b[A',
  DOWN: '\x1b[B',
  LEFT: '\x1b[D',
  RIGHT: '\x1b[C',
  PASTE_START: '\x1b[200~',
  PASTE_END: '\x1b[201~',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class TuiDriver {
  /**
   * @param {string} cmd
   * @param {string[]} args
   * @param {{cols?:number, rows?:number, cwd?:string, label?:string, evidenceDir?:string}} opts
   */
  constructor(cmd, args = [], opts = {}) {
    this.cols = opts.cols ?? 110;
    this.rows = opts.rows ?? 32;
    this.label = opts.label ?? cmd;
    this.evidenceDir = opts.evidenceDir ?? process.env.EVIDENCE_DIR ?? path.join(__dirname, 'evidence');
    fs.mkdirSync(this.evidenceDir, { recursive: true });

    // Scrub nested-session env so the child TUI behaves like a fresh top-level run.
    const env = { ...process.env };
    for (const k of Object.keys(env)) {
      if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_EFFORT)/.test(k)) delete env[k];
    }
    env.TERM = 'xterm-256color';
    Object.assign(env, opts.env ?? {});

    this.term = new Terminal({ cols: this.cols, rows: this.rows, allowProposedApi: true, scrollback: 2000 });
    this.lastOutputAt = Date.now();
    this.rawLog = [];

    this.proc = pty.spawn(cmd, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: opts.cwd ?? WORKTREE_ROOT,
      env,
    });
    this.exited = false;
    this.proc.onExit(({ exitCode }) => { this.exited = true; this.exitCode = exitCode; });
    this.proc.onData((data) => {
      this.lastOutputAt = Date.now();
      this.rawLog.push(data);
      this.term.write(data);
    });
  }

  /** Write bytes to the TUI's stdin (what the terminal emulator would send). */
  send(data) {
    this.proc.write(data);
  }

  /** Type text with a small per-chunk delay, like a human (each char its own write). */
  async type(text, perCharMs = 25) {
    for (const ch of text) {
      this.send(ch);
      await sleep(perCharMs);
    }
  }

  /** Wait until no PTY output for quietMs (or timeout). */
  async settle(quietMs = 700, timeoutMs = 15000) {
    const start = Date.now();
    for (;;) {
      await sleep(80);
      if (Date.now() - this.lastOutputAt >= quietMs) return true;
      if (Date.now() - start >= timeoutMs) return false;
    }
  }

  /** Rendered screen lines (viewport only), right-trimmed. */
  screen() {
    const buf = this.term.buffer.active;
    const lines = [];
    const top = buf.viewportY;
    for (let i = 0; i < this.rows; i++) {
      const line = buf.getLine(top + i);
      lines.push(line ? line.translateToString(true).trimEnd() : '');
    }
    return lines;
  }

  /** Non-empty screen lines joined — handy for includes() checks. */
  screenText() {
    return this.screen().filter((l) => l.length > 0).join('\n');
  }

  /** Save a labeled screen snapshot to the evidence dir; returns the lines. */
  snapshot(label) {
    const lines = this.screen();
    const file = path.join(this.evidenceDir, `${this.label}.log`);
    fs.appendFileSync(file, `\n===== ${new Date().toISOString()} ${label} =====\n${lines.join('\n')}\n`);
    return lines;
  }

  /**
   * Extract the composer/input-box content. Both Claude Code and Codex render
   * an input area; strategy: find the LAST box-drawing-bordered region or
   * prompt marker and return its text lines. Falls back to lines between the
   * final horizontal rules.
   */
  inputBox() {
    const lines = this.screen();
    // Claude Code: input line(s) start with '> ' inside a bordered box or bare.
    // Codex: composer delimited by '▌' or box borders. Keep it dumb: return
    // trailing region after the last separator-ish line, minus status lines.
    const isBorder = (l) => /^[\s]*[╭╰│┌└─╌┄╍]|^[\s]*[━─]{3,}/.test(l);
    let lastTop = -1, lastBottom = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^[\s]*[╭┌]/.test(lines[i])) lastTop = i;
      if (/^[\s]*[╰└]/.test(lines[i])) lastBottom = i;
    }
    if (lastTop >= 0 && lastBottom > lastTop) {
      return lines.slice(lastTop + 1, lastBottom).map((l) => l.replace(/^[\s]*│ ?/, '').replace(/ ?│[\s]*$/, '').trimEnd());
    }
    return lines.filter((l) => l.startsWith('> ')).map((l) => l.slice(2));
  }

  kill() {
    try { this.proc.kill(); } catch { /* already dead */ }
  }
}

function logStep(msg) {
  process.stdout.write(`\n--- ${msg}\n`);
}

function show(lines, label = 'screen') {
  process.stdout.write(`\n[${label}]\n${lines.map((l) => `|${l}`).join('\n')}\n`);
}

module.exports = { TuiDriver, KEYS, sleep, logStep, show, WORKTREE_ROOT, MAIN_ROOT, Terminal };
