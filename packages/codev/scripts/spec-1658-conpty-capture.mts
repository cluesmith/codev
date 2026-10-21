/**
 * Spec 1658, Phase 8: record a real agent TUI under ConPTY for the render-gate replay suite.
 *
 * Run on a Windows machine with the agent installed and AUTHENTICATED (CI has neither). Each
 * state starts a fresh agent session in a fresh scratch directory, drives it like a human would,
 * and writes one capture: every output chunk, keystroke and resize, stamped in milliseconds, plus
 * the probe points where the replay asks the production delivery path for a verdict. The format
 * and the replay live in `src/agent-farm/__tests__/helpers/conpty-replay.ts`.
 *
 * Usage (from packages/codev, after `pnpm build`):
 *   node --experimental-strip-types scripts/spec-1658-conpty-capture.mts --app claude [--state all]
 *     [--out conpty-captures] [--redact you@example.com] [-- <extra agent args>]
 *
 * States: idle (delivered) · draft (held: a human typed text) · midturn (delivered: a turn is
 * streaming and the composer is empty, #1664) · resize (delivered after the repaint) · all.
 *
 * Output: `<out>/conpty-<app>-<state>.capture.jsonl.gz`. Every chunk is scrubbed of the user
 * name, home directory, scratch directory, host name and each `--redact` value with SAME-LENGTH
 * placeholders, so the rendered screen keeps its geometry. If any of them still appears in the
 * rendered text (a value split across chunks, say), the capture is refused and nothing is
 * written.
 */

import { spawn as spawnPty, type IPty } from 'node-pty';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { hostname, homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

import { ptyCommand } from '../dist/lib/pty-command.js';
import { sanitizeAgentEnv } from '../dist/lib/agent-env.js';
import { SessionScreen } from '../dist/terminal/session-screen.js';
import { bufferLines, classifyBuffer } from '../dist/agent-farm/servers/render-gate.js';
import { resolveProfile } from '../dist/agent-farm/servers/gate-profiles.js';

// ---------------------------------------------------------------- args

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  return fallback;
}

function allArgs(name: string): string[] {
  const values: string[] = [];
  process.argv.forEach((value, i) => {
    if (value === `--${name}` && process.argv[i + 1] !== undefined) values.push(process.argv[i + 1]);
  });
  return values;
}

const APP = arg('app', '');
const STATE = arg('state', 'all');
const OUT = resolve(arg('out', 'conpty-captures'));
const COLS = Number(arg('cols', '120'));
const ROWS = Number(arg('rows', '40'));
const separator = process.argv.indexOf('--');
let AGENT_ARGS: string[] = [];
if (separator !== -1) AGENT_ARGS = process.argv.slice(separator + 1);

const STATES = ['idle', 'draft', 'midturn', 'resize'];
const EXPECT: Record<string, 'delivered' | 'held'> = {
  idle: 'delivered',
  draft: 'held',
  midturn: 'delivered',
  resize: 'delivered',
};

const profile = resolveProfile({ command: APP });
if (!profile) {
  console.error(`--app must name an agent with a gate profile (claude, codex, agy); got "${APP}"`);
  process.exit(2);
}
let states = [STATE];
if (STATE === 'all') states = STATES;
for (const state of states) {
  if (!STATES.includes(state)) {
    console.error(`unknown --state ${state}; expected one of ${STATES.join(', ')}, all`);
    process.exit(2);
  }
}

/** How long each state keeps recording past its last probe: the replay retries for up to 2 s. */
const TAIL_MS = 2500;
/** A turn is running: codex's `esc to interrupt`, claude's parenthesised elapsed counter (#1664 harness). */
const WORKING_RE = /esc to interrupt|\((?:\d+m\s+)?\d+s\s+[·•]/i;
/** The folder-trust dialog every agent shows in a fresh directory: the only dialog the recorder accepts. */
const TRUST_DIALOG_RE = /trust/i;
/** An update offer (codex: `Update available`, whose first option runs an installer): dismissed, never accepted. */
const UPDATE_PROMPT_RE = /update available[\s\S]*esc skip/i;
/** The option the recorder may confirm in a trust dialog. */
const ACCEPT_OPTION_RE = /\b(yes|trust)\b/i;
/** Options that run or change software: never confirmed, whatever else the line says. */
const NEVER_CONFIRM_RE = /update|install|curl|\bsh\b/i;
/** The highlighted row of a first-run dialog's option list. */
const SELECTED_OPTION_RE = /^\s*[❯›>]\s/;
const MIDTURN_PROMPT = 'Without using any tools, write a 700-word essay on the history of the electric telegraph.';
const DRAFT_TEXT = 'review the mailbox change';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let appVersion = 'unknown';
try {
  appVersion = execSync(`${APP} --version`, { encoding: 'utf8' }).trim();
} catch {
  // recorded as unknown
}

// ---------------------------------------------------------------- one session

type CaptureEvent =
  | { t: number; o: string }
  | { t: number; i: string }
  | { t: number; r: [number, number] }
  | { t: number; probe: string };

class Recording {
  readonly events: CaptureEvent[] = [];
  readonly screen: SessionScreen;
  readonly cwd: string;
  private readonly pty: IPty;
  private readonly start = Date.now();
  private lastOutputAt = Date.now();
  private cols = COLS;
  private rows = ROWS;

  constructor() {
    this.cwd = mkdtempSync(join(tmpdir(), 'codev-conpty-'));
    // The environment an agent session gets in production: Tower's own env through
    // sanitizeAgentEnv (Claude session markers and the worktree variable removed), not the
    // dashboard-shell whitelist. Run the recorder from the kind of console Tower is started from,
    // since colour variables there (COLORTERM, WT_SESSION) reach the agent the same way.
    const env = sanitizeAgentEnv(process.env);
    env.TERM = 'xterm-256color';
    this.screen = new SessionScreen(COLS, ROWS);
    const launch = ptyCommand(APP, AGENT_ARGS, env);
    this.pty = spawnPty(launch.file, launch.args, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: this.cwd, env });
    this.pty.onData((data: string) => {
      this.events.push({ t: this.now(), o: data });
      this.lastOutputAt = Date.now();
      this.screen.feed(data);
    });
  }

  now(): number {
    return Date.now() - this.start;
  }

  async type(text: string): Promise<void> {
    for (const ch of text) {
      this.events.push({ t: this.now(), i: ch });
      this.pty.write(ch);
      await sleep(60);
    }
  }

  /** One key that is a multi-byte sequence (an arrow), written whole so a lone ESC is never seen. */
  key(sequence: string): void {
    this.events.push({ t: this.now(), i: sequence });
    this.pty.write(sequence);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.events.push({ t: this.now(), r: [cols, rows] });
    this.pty.resize(cols, rows);
    this.screen.resize(cols, rows);
  }

  probe(name: string): void {
    this.events.push({ t: this.now(), probe: name });
  }

  async text(): Promise<string> {
    const { term } = await this.screen.read();
    return bufferLines(term).slice(-this.rows).join('\n');
  }

  async clean(): Promise<boolean> {
    const { term } = await this.screen.read();
    return classifyBuffer(term, this.cols, this.rows, profile!).clean;
  }

  /** Wait for an empty composer that has been quiet for 1.5 s, accepting first-run dialogs. */
  async composerReady(timeoutMs = 90_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let dialogSince = 0;
    let dialogKeys = 0;
    while (Date.now() < deadline) {
      await sleep(250);
      if (await this.clean()) {
        dialogSince = 0;
        if (Date.now() - this.lastOutputAt >= 1500) return;
        continue;
      }
      const text = await this.text();
      if (dialogKeys >= 8) continue;
      if (UPDATE_PROMPT_RE.test(text)) {
        this.key('\x1b'); // the prompt's own "esc skip"
        dialogKeys++;
        await sleep(1000);
        continue;
      }
      if (!TRUST_DIALOG_RE.test(text)) {
        dialogSince = 0;
        continue;
      }
      if (dialogSince === 0) dialogSince = Date.now();
      if (Date.now() - dialogSince < 2000) continue;
      // Move the selection onto the accepting option (claude defaults to "No, exit"), then confirm.
      const selected = text.split('\n').find((line) => SELECTED_OPTION_RE.test(line)) ?? '';
      if (ACCEPT_OPTION_RE.test(selected) && !NEVER_CONFIRM_RE.test(selected)) {
        await this.type('\r');
      } else {
        this.key('\x1b[B');
      }
      dialogKeys++;
      dialogSince = Date.now();
    }
    const { term } = await this.screen.read();
    const verdict = classifyBuffer(term, this.cols, this.rows, profile!);
    throw new Error(`no empty composer within ${timeoutMs} ms (gate: ${verdict.detail}); screen:\n${await this.text()}`);
  }

  async working(): Promise<boolean> {
    return WORKING_RE.test(await this.text());
  }

  kill(): void {
    try {
      this.pty.kill();
    } catch {
      // already exited
    }
  }
}

async function record(state: string): Promise<Recording> {
  const rec = new Recording();
  try {
    await rec.composerReady();
    if (state === 'idle') {
      await sleep(1000);
      rec.probe('idle-early');
      await sleep(1500);
      rec.probe('idle-late');
    } else if (state === 'draft') {
      await rec.type(DRAFT_TEXT);
      rec.probe('typed');
      await sleep(1500);
      rec.probe('paused');
    } else if (state === 'midturn') {
      await rec.type(MIDTURN_PROMPT);
      await sleep(500);
      await rec.type('\r');
      const startDeadline = Date.now() + 30_000;
      while (!(await rec.working())) {
        if (Date.now() > startDeadline) throw new Error(`the turn never started; screen:\n${await rec.text()}`);
        await sleep(200);
      }
      let probes = 0;
      for (let n = 1; n <= 4; n++) {
        await sleep(2000);
        if (!(await rec.working())) break;
        rec.probe(`midturn-${n}`);
        probes++;
      }
      if (probes < 2) {
        throw new Error(`the turn ended after ${probes} probe(s); pass a slower model or a longer prompt`);
      }
    } else if (state === 'resize') {
      await sleep(1000);
      rec.resize(100, 30);
      await sleep(1500);
      rec.resize(140, 45);
      await sleep(2500);
      rec.probe('after-resize');
    }
    await sleep(TAIL_MS);
    return rec;
  } finally {
    rec.kill();
  }
}

// ---------------------------------------------------------------- scrub and write

function scrubValues(cwd: string): string[] {
  const values = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value || value.length < 3) return;
    values.add(value);
    values.add(value.replace(/\\/g, '/'));
  };
  add(cwd);
  add(homedir());
  add(userInfo().username);
  add(hostname());
  for (const value of allArgs('redact')) add(value);
  return [...values].sort((a, b) => b.length - a.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scrub(text: string, values: string[]): string {
  let out = text;
  for (const value of values) {
    out = out.replace(new RegExp(escapeRegExp(value), 'gi'), 'X'.repeat(value.length));
  }
  return out;
}

async function write(state: string, rec: Recording): Promise<string> {
  const values = scrubValues(rec.cwd);
  const events = rec.events.map((event) => {
    if ('o' in event) return { t: event.t, o: scrub(event.o, values) };
    return event;
  });
  // Leak check on the RENDERED text of the scrubbed stream: catches a value the per-chunk scrub
  // missed because a chunk boundary split it.
  const check = new SessionScreen(COLS, ROWS);
  for (const event of events) {
    if ('o' in event) check.feed(event.o);
    if ('r' in event) check.resize(event.r[0], event.r[1]);
  }
  const { term } = await check.read();
  const rendered = bufferLines(term).join('\n');
  let joined = '';
  for (const event of events) {
    if ('o' in event) joined += event.o;
  }
  const leaks = values.filter((value) => {
    const pattern = new RegExp(escapeRegExp(value), 'i');
    return pattern.test(rendered) || pattern.test(joined);
  });
  check.dispose();
  if (leaks.length > 0) {
    throw new Error(`refusing to write ${state}: ${leaks.length} private value(s) survived the scrub`);
  }
  const header = {
    format: 'codev-terminal-capture',
    version: 1,
    app: APP,
    appVersion: scrub(appVersion, values),
    state,
    platform: process.platform,
    cols: COLS,
    rows: ROWS,
    expect: EXPECT[state],
  };
  const body = [header, ...events].map((entry) => JSON.stringify(entry)).join('\n') + '\n';
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `conpty-${APP}-${state}.capture.jsonl.gz`);
  writeFileSync(file, gzipSync(body));
  return file;
}

console.log(`[1658] ${APP} ${appVersion} on ${process.platform}, ${COLS}x${ROWS}; states: ${states.join(', ')}`);
if (process.platform !== 'win32') {
  console.log('[1658] not Windows: this records the host PTY, not ConPTY; the replay suite rejects it');
}
let failed = 0;
for (const state of states) {
  try {
    const rec = await record(state);
    const file = await write(state, rec);
    const probes = rec.events.filter((event) => 'probe' in event).length;
    console.log(`[1658] ${state}: ${rec.events.length} events, ${probes} probe(s) -> ${file}`);
  } catch (error) {
    failed++;
    console.error(`[1658] ${state}: FAILED: ${(error as Error).message}`);
  }
}
process.exit(failed);
