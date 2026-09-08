/**
 * Issue #1567 — head-loss repro harness against a REAL `claude` TUI.
 *
 * Drives a real Claude Code TUI under node-pty (no Tower, no shellper, nothing touches
 * `~/.agent-farm`) and pushes long bodies through the PRODUCTION write edge — the same
 * `submitMessagePaced` + `formatArchitectToBuilderMessage` a mailbox delivery uses — timed
 * to land just after a turn ends, which is the window every field specimen correlated with.
 * The production render gate (`classifyBuffer` + `CLAUDE_PROFILE`) and the production
 * settle-before-write interval decide WHEN the write goes out, so the harness cannot write
 * into a state Tower itself would have held on.
 *
 * Each trial's body starts with a unique HEAD token and ends with a unique TAIL token, and
 * asks claude to answer with the first token it received. Three independent oracles then
 * judge the trial from the raw PTY byte log: did the HEAD token ever render (composer echo
 * or transcript), did the TAIL token, and what did claude say the first token was. A trial
 * whose TAIL rendered but whose HEAD did not is the head-loss the issue describes.
 *
 * The reply to each trial's message ends a turn, and that turn-end is the trigger for the
 * next trial — one API call per trial.
 *
 * Usage (from packages/codev, after `pnpm build`):
 *   node --experimental-strip-types scripts/bugfix-1567-head-loss-harness.mts \
 *     [--trials 20] [--body-bytes 1000] [--lines 1] [--delay-ms 300] [--label current] \
 *     [--out ../../codev/evidence/1567-head-loss]
 *
 * Output: `<out>/<label>-<timestamp>/{summary.md,results.json,pty.raw}`.
 */

import { spawn as spawnPty, type IPty } from 'node-pty';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { submitMessagePaced } from '../dist/agent-farm/servers/message-write.js';
import { formatArchitectToBuilderMessage } from '../dist/agent-farm/utils/message-format.js';
import { SessionScreen } from '../dist/terminal/session-screen.js';
import { classifyBuffer, bufferLines } from '../dist/agent-farm/servers/render-gate.js';
import { CLAUDE_PROFILE, CODEX_PROFILE } from '../dist/agent-farm/servers/gate-profiles.js';
import { SETTLE_BEFORE_WRITE_MS } from '../dist/agent-farm/servers/mailbox-delivery.js';

// ---------------------------------------------------------------- args

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const TRIALS = Number(arg('trials', '20'));
const BODY_BYTES = Number(arg('body-bytes', '1000'));
const LINES = Number(arg('lines', '1'));
const DELAY_MS = Number(arg('delay-ms', '300'));
const LABEL = arg('label', 'current');
const OUT_ROOT = resolve(arg('out', '../../codev/evidence/1567-head-loss'));
const COLS = Number(arg('cols', '120'));
const ROWS = Number(arg('rows', '40'));
/** Which TUI to drive: `claude` (default) or `codex`. Picks the gate profile and the chrome regexes. */
const HARNESS = arg('harness', 'claude');
const CMD = arg('cmd', HARNESS);
const DEFAULT_ARGS: Record<string, string> = {
  claude: '--dangerously-skip-permissions --model haiku',
  codex: '--dangerously-bypass-approvals-and-sandbox',
};
const CLAUDE_ARGS = arg('args', arg('claude-args', DEFAULT_ARGS[HARNESS] ?? '')).split(/\s+/).filter(Boolean);
/** How newlines travel INSIDE a bracketed paste: `lf` (as-is) or `cr` (what xterm.js emits on paste). */
const PASTE_NEWLINE = arg('paste-newline', 'lf');
const TURN_TIMEOUT_MS = 120_000;
/**
 * Which write strategy each trial uses:
 *   production        — the production edge (`submitMessagePaced`), whatever it does today.
 *   chunked           — plain text in ≤CHUNK_BYTES writes CHUNK_GAP_MS apart, then Enter.
 *   bracketed         — ONE write: ESC[200~ + frame + ESC[201~, settle, then Enter.
 *   bracketed-chunked — bracketed, with the bracketed payload chunked as above.
 * The non-production strategies are written in the harness so a candidate fix can be measured
 * against the real TUI BEFORE the write edge changes.
 */
const MODE = arg('mode', 'production');
const CHUNK_BYTES = Number(arg('chunk-bytes', '512'));
const CHUNK_GAP_MS = Number(arg('chunk-gap-ms', '5'));
const ENTER_DELAY_MS = Number(arg('enter-delay-ms', '80'));
/** Where the nested claude runs. Default: an EMPTY scratch dir, so no CLAUDE.md is loaded. */
const CWD = resolve(arg('cwd', resolve(tmpdir(), `bugfix-1567-harness-${process.pid}`)));
mkdirSync(CWD, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = resolve(OUT_ROOT, `${LABEL}-${HARNESS}-${MODE}-${stamp}`);
mkdirSync(OUT, { recursive: true });
const RAW = resolve(OUT, 'pty.raw');
writeFileSync(RAW, '');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
const skeleton = (s: string) => s.replace(/[^A-Za-z0-9]/g, '');

// ---------------------------------------------------------------- the terminal

let claudeVersion = 'unknown';
try { claudeVersion = execSync(`${CMD} --version`, { encoding: 'utf8' }).trim(); } catch { /* recorded as unknown */ }

// A nested claude must not inherit the outer session's identity — scrub every CLAUDE* var.
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined && !k.startsWith('CLAUDE')) env[k] = v;
}
env.TERM = 'xterm-256color';

const PROFILE = HARNESS === 'codex' ? CODEX_PROFILE : CLAUDE_PROFILE;
/** The TUI's "a turn is running" chrome. Measured: claude `esc to interrupt`, codex `Esc to interrupt`. */
const WORKING_RE = /esc to interrupt/i;

const pty: IPty = spawnPty(CMD, CLAUDE_ARGS, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: CWD, env });
const screen = new SessionScreen(COLS, ROWS);

/** Every byte the TUI emitted, in order — the same log a Tower PTY session keeps. */
let log = '';
let lastDataAt = Date.now();
pty.onData((d: string) => {
  log += d;
  lastDataAt = Date.now();
  screen.feed(d);
  appendFileSync(RAW, d);
});
let exited = false;
pty.onExit(() => { exited = true; });

async function screenText(): Promise<string> {
  const { term } = await screen.read();
  return bufferLines(term).join('\n');
}

/** The VISIBLE rows only — the working indicator is judged here, not in scrollback. */
async function viewportText(): Promise<string> {
  const { term, rows } = await screen.read();
  return bufferLines(term).slice(-rows).join('\n');
}

async function gateClean(): Promise<boolean> {
  const { term, cols, rows } = await screen.read();
  return classifyBuffer(term, cols, rows, PROFILE).clean;
}

/** Accept the one-time dialogs a fresh claude may raise (folder trust, bypass warning). */
async function acceptDialogs(): Promise<void> {
  // Only act on a dialog that has finished painting: claude remounts its first-run dialogs
  // during startup, and a keystroke sent into that window is applied to the OLD mount while
  // the new one comes back with the default (negative) option selected.
  if (Date.now() - lastDataAt < 1000) return;
  const text = await viewportText();
  // codex's update nag preselects "Update now" (a global npm install) — pick "Skip" instead.
  if (/Update now/i.test(text) && /Skip/i.test(text) && /Press enter to continue/i.test(text)) {
    console.log('  [dialog] codex update prompt: choosing Skip');
    pty.write('2');
    await sleep(300);
    pty.write('\r');
    await sleep(1500);
    return;
  }
  // codex's directory-trust prompt preselects the affirmative option.
  if (/trust/i.test(text) && /Press enter to continue/i.test(text)) {
    console.log('  [dialog] codex trust prompt: Enter');
    pty.write('\r');
    await sleep(1500);
    return;
  }
  if (/Enter to confirm/i.test(text) && /(trust|accept|proceed)/i.test(text)) {
    // The selected option carries the ❯ glyph. Both first-run dialogs default to the
    // negative option ("No, exit"), so move down to the affirmative one before confirming.
    const selectedNo = /❯\s*No\b/i.test(text);
    console.log(`  [dialog] accepting (${selectedNo ? 'down + ' : ''}Enter)`);
    if (selectedNo) { pty.write('\x1b[B'); await sleep(200); }
    pty.write('\r');
    await sleep(1500);
  }
}

/** Wait until the TUI is idle at a clean composer, quiet for at least `quietMs`. */
async function waitIdle(quietMs: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exited) throw new Error('claude exited');
    await acceptDialogs();
    const text = await viewportText();
    const working = WORKING_RE.test(text);
    const quiet = Date.now() - lastDataAt >= quietMs;
    if (!working && quiet && (await gateClean())) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for idle; screen tail:\n${text.slice(-1500)}`);
    await sleep(25);
  }
}

/** Wait for a turn to START (the working indicator appears) after an injection. */
async function waitWorking(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (WORKING_RE.test(await viewportText())) return true;
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
}

// ---------------------------------------------------------------- the body

const FILLER = [
  'Rulings on your three items follow, and each one is load-bearing for the next step.',
  'Do not merge until the regression test is green on main and the review doc is updated.',
  'Scope the storage key by user id, keep the widening minimal, and note the adjacent idiom.',
  'Switch the PR body to Refs and leave the issue open for the deferred gap you listed.',
  'The coalescing behavior itself is correct and stays; only the re-pin backstop changes.',
];

interface Trial {
  n: number;
  head: string;
  tail: string;
  body: string;
  frame: string;
}

function makeTrial(n: number): Trial {
  const rand = randomBytes(3).toString('hex');
  const head = `H1567-${n}-${rand}`;
  const tail = `T1567-${n}-${rand}`;
  const ask = `This is an automated delivery test, no action needed. Reply with exactly ZZ followed by the first token of this message. ${tail}`;
  let filler = '';
  let i = 0;
  while (Buffer.byteLength(`${head} ${filler} ${ask}`) < BODY_BYTES) {
    filler += (filler ? ' ' : '') + FILLER[i++ % FILLER.length];
  }
  let body = `${head} ${filler} ${ask}`;
  if (LINES > 1) {
    // Split the filler into LINES lines so the frame crosses the per-line pacing threshold.
    const words = body.split(' ');
    const per = Math.ceil(words.length / LINES);
    const lines: string[] = [];
    for (let w = 0; w < words.length; w += per) lines.push(words.slice(w, w + per).join(' '));
    body = lines.join('\n');
  }
  const frame = formatArchitectToBuilderMessage('builder-harness-1567', body, undefined, false, 'architect:main');
  return { n, head, tail, body, frame };
}

// ---------------------------------------------------------------- write strategies

const PASTE_BEGIN = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const pasteBody = (frame: string) => (PASTE_NEWLINE === 'cr' ? frame.replace(/\r?\n/g, '\r') : frame);

function chunks(text: string): string[] {
  const out: string[] = [];
  const buf = Buffer.from(text, 'utf8');
  for (let at = 0; at < buf.length; ) {
    let end = Math.min(buf.length, at + CHUNK_BYTES);
    // Never split a UTF-8 sequence: back off to a leading byte.
    while (end < buf.length && (buf[end] & 0xc0) === 0x80) end--;
    out.push(buf.subarray(at, end).toString('utf8'));
    at = end;
  }
  return out;
}

async function writeByMode(session: { id: string; write(d: string): boolean }, frame: string): Promise<{ status: string }> {
  switch (MODE) {
    case 'production':
      return submitMessagePaced(session, frame, false, () => null);
    case 'chunked': {
      for (const c of chunks(frame)) { session.write(c); await sleep(CHUNK_GAP_MS); }
      await sleep(ENTER_DELAY_MS);
      session.write('\r');
      return { status: 'written' };
    }
    case 'bracketed': {
      session.write(PASTE_BEGIN + pasteBody(frame) + PASTE_END);
      await sleep(ENTER_DELAY_MS);
      session.write('\r');
      return { status: 'written' };
    }
    case 'bracketed-chunked': {
      for (const c of chunks(PASTE_BEGIN + pasteBody(frame) + PASTE_END)) { session.write(c); await sleep(CHUNK_GAP_MS); }
      await sleep(ENTER_DELAY_MS);
      session.write('\r');
      return { status: 'written' };
    }
    default:
      throw new Error(`unknown --mode ${MODE}`);
  }
}

// ---------------------------------------------------------------- one trial

interface Result {
  n: number;
  bodyBytes: number;
  frameBytes: number;
  frameLines: number;
  writeStatus: string;
  msSinceTurnEnd: number;
  headRendered: boolean;
  tailRendered: boolean;
  placard: boolean;
  replyToken: string | null;
  verdict: 'intact' | 'head-lost' | 'nothing-rendered' | 'unknown';
  excerpt: string;
}

const results: Result[] = [];

async function runTrial(t: Trial): Promise<Result> {
  // The production settle: at least SETTLE_BEFORE_WRITE_MS of output silence, then our
  // configured post-turn-end delay (DELAY_MS) — whichever is longer.
  await waitIdle(Math.max(SETTLE_BEFORE_WRITE_MS, DELAY_MS), TURN_TIMEOUT_MS);
  const msSinceTurnEnd = Date.now() - lastDataAt;
  const start = log.length;

  const session = { id: `harness-1567-${process.pid}`, write: (d: string) => { pty.write(d); return true; } };
  const result = await writeByMode(session, t.frame);

  // Let the turn run: the message asks for a reply, so wait for working → idle.
  const started = await waitWorking(15_000);
  if (started) {
    try { await waitIdle(SETTLE_BEFORE_WRITE_MS, TURN_TIMEOUT_MS); } catch (e) { console.log(`  [warn] ${String(e).split('\n')[0]}`); }
  } else {
    // No turn began — the Enter may have been swallowed; give the screen a moment, then judge.
    await sleep(3000);
  }

  const slice = log.slice(start);
  const plain = stripAnsi(slice);
  const flat = skeleton(plain);
  const headRendered = flat.includes(skeleton(t.head));
  const tailRendered = flat.includes(skeleton(t.tail));
  const placard = /Pasted\s*(text\s*#\d+|Content\s*\d+\s*chars)/i.test(plain);
  const m = plain.replace(/\s+/g, ' ').match(/ZZ[\s.:-]*([A-Za-z0-9][A-Za-z0-9-]*)/g);
  // The body's own echo contains "prefixed by ZZ. T1567…"; the reply is whatever ZZ-prefixed
  // token is NOT the tail token and is not part of the body text.
  let replyToken: string | null = null;
  for (const hit of m ?? []) {
    const tok = hit.replace(/^ZZ[\s.:-]*/, '');
    // Skip the body's own "ZZ followed by…" phrase and the tail token; what remains is the reply.
    if (tok !== t.tail && !tok.startsWith('T1567') && !tok.toLowerCase().startsWith('followed')) { replyToken = tok; break; }
  }
  let verdict: Result['verdict'] = 'unknown';
  if (headRendered && tailRendered) verdict = 'intact';
  else if (!headRendered && tailRendered) verdict = 'head-lost';
  else if (!headRendered && !tailRendered) verdict = 'nothing-rendered';

  const lines = t.frame.split('\n').length;
  const excerptSrc = plain.replace(/\r/g, '').split('\n').map((l) => l.trimEnd()).filter(Boolean).join('\n');
  return {
    n: t.n,
    bodyBytes: Buffer.byteLength(t.body),
    frameBytes: Buffer.byteLength(t.frame),
    frameLines: lines,
    writeStatus: result.status,
    msSinceTurnEnd,
    headRendered,
    tailRendered,
    placard,
    replyToken,
    verdict,
    excerpt: excerptSrc.slice(0, 3000),
  };
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  console.log(`claude: ${claudeVersion}  args: ${CLAUDE_ARGS.join(' ')}  ${COLS}x${ROWS}`);
  console.log(`harness=${HARNESS} pasteNewline=${PASTE_NEWLINE} mode=${MODE} trials=${TRIALS} bodyBytes≈${BODY_BYTES} lines=${LINES} delayMs=${DELAY_MS} label=${LABEL} cwd=${CWD}`);
  console.log(`out: ${OUT}`);

  // Boot: wait for the first clean composer, then warm up with one plain short turn so the
  // first real trial lands on a just-ended turn like all the others.
  await waitIdle(1000, 90_000);
  console.log('booted; warming up');
  pty.write('Respond with only the word READY.');
  await sleep(100);
  pty.write('\r');
  await waitWorking(15_000);

  for (let n = 1; n <= TRIALS; n++) {
    const t = makeTrial(n);
    const r = await runTrial(t);
    results.push(r);
    console.log(
      `trial ${String(n).padStart(2)}: ${r.verdict.padEnd(16)} head=${r.headRendered ? 'Y' : 'n'} tail=${r.tailRendered ? 'Y' : 'n'} ` +
        `placard=${r.placard ? 'Y' : 'n'} reply=${r.replyToken ?? '-'} write=${r.writeStatus} ` +
        `frame=${r.frameBytes}B/${r.frameLines}L +${r.msSinceTurnEnd}ms`,
    );
    writeFileSync(resolve(OUT, 'results.json'), JSON.stringify({ harness: HARNESS, cmd: CMD, pasteNewline: PASTE_NEWLINE, claudeVersion, CLAUDE_ARGS, COLS, ROWS, MODE, CHUNK_BYTES, CHUNK_GAP_MS, ENTER_DELAY_MS, TRIALS, BODY_BYTES, LINES, DELAY_MS, LABEL, results }, null, 2));
  }

  const lost = results.filter((r) => r.verdict === 'head-lost').length;
  const intact = results.filter((r) => r.verdict === 'intact').length;
  const none = results.filter((r) => r.verdict === 'nothing-rendered').length;
  const summary = [
    `# Issue #1567 head-loss harness — ${LABEL} / ${MODE}`,
    '',
    `- run: ${new Date().toISOString()}`,
    `- tui: ${claudeVersion} (\`${CMD} ${CLAUDE_ARGS.join(' ')}\`, ${COLS}x${ROWS}, real TUI under node-pty, no Tower); paste newline=${PASTE_NEWLINE}`,
    `- mode: **${MODE}**${MODE === 'production' ? ' (production `submitMessagePaced` from dist)' : ` (harness strategy; chunk=${CHUNK_BYTES}B gap=${CHUNK_GAP_MS}ms enter=+${ENTER_DELAY_MS}ms)`}; frame from production \`formatArchitectToBuilderMessage\``,
    `- gate: production \`classifyBuffer(CLAUDE_PROFILE)\` clean + \`SETTLE_BEFORE_WRITE_MS\`=${SETTLE_BEFORE_WRITE_MS} ms quiet, then ≥${DELAY_MS} ms after the last output byte of the previous turn`,
    `- body ≈ ${BODY_BYTES} bytes, ${LINES} line(s); frame ${results[0]?.frameBytes ?? '?'} bytes / ${results[0]?.frameLines ?? '?'} lines`,
    '',
    `## Result: ${lost}/${results.length} head-lost, ${intact}/${results.length} intact, ${none}/${results.length} nothing rendered`,
    '',
    '| trial | verdict | head | tail | placard | claude says first token | write | frame | ms after turn end |',
    '|---|---|---|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.n} | ${r.verdict} | ${r.headRendered ? 'Y' : 'n'} | ${r.tailRendered ? 'Y' : 'n'} | ${r.placard ? 'Y' : 'n'} | ${r.replyToken ?? '-'} | ${r.writeStatus} | ${r.frameBytes}B/${r.frameLines}L | ${r.msSinceTurnEnd} |`),
    '',
    '## Per-trial screen excerpts (ANSI stripped, from the injection onward)',
    '',
    ...results.flatMap((r) => [`### trial ${r.n} — ${r.verdict}`, '```', r.excerpt, '```', '']),
  ].join('\n');
  writeFileSync(resolve(OUT, 'summary.md'), summary);
  console.log(`\n${lost}/${results.length} head-lost, ${intact}/${results.length} intact, ${none}/${results.length} nothing rendered`);
  console.log(`summary: ${resolve(OUT, 'summary.md')}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => {
    try { pty.write('/exit\r'); } catch { /* exiting anyway */ }
    setTimeout(() => { try { pty.kill(); } catch { /* already gone */ } process.exit(); }, 1500);
  });
