/**
 * Issue #1664 — acceptance harness: does mail reach a recipient that is TALKING?
 *
 * Drives a real Claude Code (or codex) TUI under node-pty and delivers to it through the
 * PRODUCTION delivery path — `deliverAgentMail` itself, over a real sqlite mailbox, with the
 * live gate bindings (`classifyBuffer` + `composerRegionFingerprint` over a `SessionScreen`
 * mirror) and the production write edge (`submitMessagePaced`). Nothing here re-implements a
 * gate: the harness only supplies the terminal and the clock, so what it measures is what
 * Tower would do. No Tower, no shellper, nothing touches `~/.agent-farm`.
 *
 * Three scenarios, one per acceptance criterion:
 *
 *   --scenario streaming  The recipient is mid-turn with an EMPTY composer and a live spinner.
 *                         Expect: every trial DELIVERS while the turn is still running, its
 *                         body lands intact (HEAD and TAIL tokens both render), and the TUI
 *                         submits it as ONE message when the turn ends. Before this fix these
 *                         all waited for the turn to end (field mean 54 s, max 561 s).
 *
 *   --scenario draft      The recipient is mid-turn AND a human has typed a draft on the line.
 *                         Expect: every trial HELD as `busy:user-text` — the one hold the
 *                         owner's ruling keeps. Nothing is ever written onto the draft.
 *
 *   --scenario turn-end   The delivery is attempted continuously across the end of a turn, so
 *                         some attempts land while the composer is being REDRAWN — #1521's
 *                         window, which is why the settle exists. Expect: those attempts are
 *                         held (`busy:composer-redraw`), the message then lands intact, and
 *                         head-loss is 0/N.
 *
 * Usage (from packages/codev, after `pnpm build`):
 *   node --experimental-strip-types scripts/bugfix-1664-streaming-delivery-harness.mts \
 *     [--scenario streaming] [--trials 20] [--body-bytes 1000] [--label current] \
 *     [--out ../../codev/evidence/1664-streaming-delivery]
 *
 * Output: `<out>/<label>-<scenario>-<timestamp>/{summary.md,results.json,pty.raw}`.
 */

import { spawn as spawnPty, type IPty } from 'node-pty';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';

import { submitMessagePaced, writeStrategyForApp } from '../dist/agent-farm/servers/message-write.js';
import { formatArchitectToBuilderMessage } from '../dist/agent-farm/utils/message-format.js';
import { SessionScreen } from '../dist/terminal/session-screen.js';
import { classifyBuffer, composerRegionFingerprint, bufferLines } from '../dist/agent-farm/servers/render-gate.js';
import { CLAUDE_PROFILE, CODEX_PROFILE } from '../dist/agent-farm/servers/gate-profiles.js';
import { deliverAgentMail, SETTLE_BEFORE_WRITE_MS } from '../dist/agent-farm/servers/mailbox-delivery.js';
import { GLOBAL_SCHEMA } from '../dist/agent-farm/db/schema.js';
import { enqueue, getById, dismiss } from '../dist/agent-farm/db/mailbox.js';

// ---------------------------------------------------------------- args

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const SCENARIO = arg('scenario', 'streaming');
const TRIALS = Number(arg('trials', '20'));
const BODY_BYTES = Number(arg('body-bytes', '1000'));
const LABEL = arg('label', 'current');
const OUT_ROOT = resolve(arg('out', '../../codev/evidence/1664-streaming-delivery'));
const COLS = Number(arg('cols', '120'));
const ROWS = Number(arg('rows', '40'));
const HARNESS = arg('harness', 'claude');
const CMD = arg('cmd', HARNESS);
const DEFAULT_ARGS: Record<string, string> = {
  claude: '--dangerously-skip-permissions --model haiku',
  codex: '--dangerously-bypass-approvals-and-sandbox',
};
const TUI_ARGS = arg('args', DEFAULT_ARGS[HARNESS] ?? '').split(/\s+/).filter(Boolean);
const TURN_TIMEOUT_MS = 120_000;
/** How long a delivery may keep being attempted before the trial gives up on it. */
const DELIVER_TIMEOUT_MS = Number(arg('deliver-timeout-ms', '30000'));
/** How often the harness runs a delivery pass — Tower's own backstop cadence. */
const PASS_INTERVAL_MS = Number(arg('pass-interval-ms', '150'));
/**
 * Measure the RETIRED gate instead (`--legacy-gate`), so the same scenario can be run both ways
 * against the same TUI and the improvement is a comparison rather than an assertion.
 *
 * It models the dominant term of the pre-#1664 rule: a pass may only proceed once the WHOLE
 * SCREEN has been free of output for `SETTLE_BEFORE_WRITE_MS`. The rule it omits — the
 * `bytesWritten` half of the change token, which re-held on any repaint between the classify
 * and the write — could only ADD holds, so this model is generous to the old behaviour.
 */
const LEGACY_GATE = process.argv.includes('--legacy-gate');

const WS = '/harness/1664';
const AGENT = 'builder-harness-1664';

const CWD = resolve(arg('cwd', resolve(tmpdir(), `bugfix-1664-harness-${process.pid}`)));
mkdirSync(CWD, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = resolve(OUT_ROOT, `${LABEL}-${SCENARIO}${process.argv.includes('--legacy-gate') ? '-legacy' : ''}-${stamp}`);
mkdirSync(OUT, { recursive: true });
const RAW = resolve(OUT, 'pty.raw');
writeFileSync(RAW, '');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
const skeleton = (s: string) => s.replace(/[^A-Za-z0-9]/g, '');

// ---------------------------------------------------------------- the terminal

let tuiVersion = 'unknown';
try { tuiVersion = execSync(`${CMD} --version`, { encoding: 'utf8' }).trim(); } catch { /* recorded as unknown */ }

// A nested claude must not inherit the outer session's identity — scrub every CLAUDE* var.
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined && !k.startsWith('CLAUDE')) env[k] = v;
}
env.TERM = 'xterm-256color';

const PROFILE = HARNESS === 'codex' ? CODEX_PROFILE : CLAUDE_PROFILE;
/**
 * "The recipient is producing output, so the RETIRED whole-screen settle would refuse to write
 * right now" — the condition the owner's ruling is phrased in, defined to be exactly the
 * negation of the gate this issue removed. A trial that delivers while this holds is, by
 * construction, a trial the old gate could not have delivered.
 */
const wouldLegacyGateHold = () => Date.now() - lastDataAt < SETTLE_BEFORE_WRITE_MS;

/**
 * "A turn is running", read off the rendered screen: claude's live working line carries a
 * PARENTHESISED elapsed counter (`✽ Bunning… (17m 7s · ↓ 70.5k tokens · thinking some more)`),
 * and its finished counterpart does not (`✻ Sautéed for 15s · done 8:52 AM`).
 *
 * NOT the `esc to interrupt` hint the #1567 harness matches: claude 2.1.266 (measured here)
 * does not render it at all, so that detector reports a working agent as idle — which makes a
 * harness race ahead and stack every prompt in the TUI's queue without a single turn running.
 */
const WORKING_RE = /\((?:\d+m\s+)?\d+s\s+·/;
/** Claude's composer hint while messages are waiting for the current turn to finish. */
const QUEUED_RE = /Press up to edit queued messages/;

const pty: IPty = spawnPty(CMD, TUI_ARGS, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: CWD, env });
const screen = new SessionScreen(COLS, ROWS);

let log = '';
let bytesWritten = 0;
let lastDataAt = Date.now();
/** Repaint accounting, so the summary can state how quiet the screen actually was. */
let outputChunks = 0;
pty.onData((d: string) => {
  log += d;
  bytesWritten += Buffer.byteLength(d, 'utf8');
  lastDataAt = Date.now();
  outputChunks++;
  screen.feed(d);
  appendFileSync(RAW, d);
});
let exited = false;
pty.onExit(() => { exited = true; });

/**
 * The session the production delivery path sees. Structurally a `PtySession`; `inputSeq` /
 * `lastInputAt` move only for HUMAN input, exactly as `PtySession.write()`'s `'external'`
 * origin does — a delivery's own bytes must never trip the gate's input signal.
 */
let inputSeq = 0;
let lastInputAt = 0;
const session = {
  id: `harness-1664-${process.pid}`,
  get bytesWritten() { return bytesWritten; },
  get lastDataAt() { return lastDataAt; },
  get inputSeq() { return inputSeq; },
  get lastInputAt() { return lastInputAt; },
  info: { cols: COLS, rows: ROWS },
  command: CMD,
  launchArgs: TUI_ARGS,
  cwd: CWD,
  writable: true,
  write: (d: string) => { pty.write(d); return true; },
};

/** Type as a HUMAN would: the bytes reach the PTY and they move the input signals. */
function typeAsHuman(d: string): void {
  inputSeq++;
  lastInputAt = Date.now();
  pty.write(d);
}

async function viewportText(): Promise<string> {
  const { term, rows } = await screen.read();
  return bufferLines(term).slice(-rows).join('\n');
}

// ---------------------------------------------------------------- the production ports

const db = new Database(':memory:');
db.exec(GLOBAL_SCHEMA);

/** Held verdicts observed during a trial, in order — what `afx inbox` would have shown. */
let verdicts: string[] = [];

const ports = {
  getSessionForAgent: () => session,
  resolveProfile: () => PROFILE,
  // The live gate binding: classify the mirror's viewport.
  classify: async () => {
    const { term, cols, rows } = await screen.read();
    return classifyBuffer(term, cols, rows, PROFILE);
  },
  // The live stability binding: fingerprint the composer region, synchronously (Issue #1664).
  composerFingerprint: () => composerRegionFingerprint(screen.peek().term, COLS, ROWS, PROFILE),
  writeMessage: (s: typeof session, msg: string, noEnter: boolean, precheck: () => unknown) =>
    submitMessagePaced(s, msg, noEnter, precheck, undefined, writeStrategyForApp(PROFILE.app)),
  // The harness judges landing from the raw PTY log (head/tail oracles), which is stronger
  // evidence than the header echo, so this watch simply never blocks the commit.
  watchEcho: () => Promise.resolve({ verify: () => Promise.resolve(true) }),
  broadcast: () => {},
  onHeldStateChange: () => {},
  onEscalation: () => {},
  onLiveness: () => {},
  log: () => {},
  now: () => Date.now(),
};

// ---------------------------------------------------------------- the body

const FILLER = [
  'Rulings on your three items follow, and each one is load-bearing for the next step.',
  'Do not merge until the regression test is green on main and the review doc is updated.',
  'Scope the storage key by user id, keep the widening minimal, and note the adjacent idiom.',
  'Switch the PR body to Refs and leave the issue open for the deferred gap you listed.',
  'The coalescing behavior itself is correct and stays; only the re-pin backstop changes.',
];

interface Trial { n: number; head: string; tail: string; frame: string }

function makeTrial(n: number): Trial {
  const rand = randomBytes(3).toString('hex');
  const head = `H1664-${n}-${rand}`;
  const tail = `T1664-${n}-${rand}`;
  const ask = `This is an automated delivery test. No action is needed and no reply is wanted; please just continue with what you were doing. ${tail}`;
  let filler = '';
  let i = 0;
  while (Buffer.byteLength(`${head} ${filler} ${ask}`) < BODY_BYTES) {
    filler += (filler ? ' ' : '') + FILLER[i++ % FILLER.length];
  }
  const body = `${head} ${filler} ${ask}`;
  return { n, head, tail, frame: formatArchitectToBuilderMessage(AGENT, body, undefined, false, 'architect:main') };
}

/** Enough of a turn for the `draft` scenario, without filling the TUI's context. */
const SHORT_PROMPT = 'Without using any tools, count from 1 to 40, one number per line.';

/** A prompt that keeps the TUI talking (and repainting) for a good while. */
const LONG_PROMPT =
  'Without using any tools, write a slow, careful, numbered explanation of what a terminal ' +
  'emulator does with an escape sequence — at least 60 numbered points, one short line each. ' +
  'Take your time and be thorough; there is no need to stop early.';

// ---------------------------------------------------------------- trial plumbing

async function waitIdle(quietMs: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exited) throw new Error(`${CMD} exited`);
    await acceptDialogs();
    const { term, cols, rows } = await screen.read();
    const text = bufferLines(term).slice(-rows).join('\n');
    // Idle means: no turn running, nothing queued behind one, the screen quiet, and the gate
    // clean. Dropping any of the four lets the harness stack prompts into the TUI's queue and
    // measure deliveries against an agent that never actually ran a turn.
    const busy = WORKING_RE.test(text) || QUEUED_RE.test(text);
    const quiet = Date.now() - lastDataAt >= quietMs;
    if (!busy && quiet && classifyBuffer(term, cols, rows, PROFILE).clean) return;
    if (Date.now() > deadline) throw new Error('timeout waiting for idle');
    await sleep(25);
  }
}

async function acceptDialogs(): Promise<void> {
  if (Date.now() - lastDataAt < 1000) return;
  const text = await viewportText();
  if (/Enter to confirm/i.test(text) && /(trust|accept|proceed)/i.test(text)) {
    if (/❯\s*No\b/i.test(text)) { pty.write('\x1b[B'); await sleep(200); }
    pty.write('\r');
    await sleep(1500);
  }
}

/** Wait until a turn is visibly running. */
async function waitStreaming(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (WORKING_RE.test(await viewportText())) return true;
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
}

interface Result {
  n: number;
  scenario: string;
  /** ms from enqueue to the delivery pass that wrote it; null when never delivered. */
  deliveredAfterMs: number | null;
  /**
   * Was the retired whole-screen settle UNSATISFIED at the delivering pass — i.e. would the old
   * gate have refused this exact write? This is the acceptance claim, not a description.
   */
  deliveredWhileWorking: boolean;
  /** The longest gap between output bytes while the row waited (the old gate needed 250 ms). */
  longestQuietMs: number;
  /** Every distinct held verdict seen while waiting — the `afx inbox` view of the wait. */
  verdicts: string[];
  /** Output chunks the TUI emitted during the wait — evidence it was never quiet. */
  outputChunksDuringWait: number;
  headRendered: boolean;
  tailRendered: boolean;
  /** Was the composer a verified-empty prompt again once the trial settled (i.e. we submitted)? */
  composerClearedAfter: boolean;
  /** Was a turn actually running while the row waited? */
  turnRunning: boolean;
  verdict: 'delivered-intact' | 'delivered-head-lost' | 'held' | 'delivered-not-rendered' | 'harness-error';
}

const results: Result[] = [];

async function runTrial(t: Trial): Promise<Result> {
  await waitIdle(SETTLE_BEFORE_WRITE_MS, TURN_TIMEOUT_MS);

  // Put the recipient to work: from here it is streaming and repainting continuously.
  let turnRunning = false;
  if (SCENARIO !== 'turn-end') {
    // The `draft` scenario only needs SOME turn running, and its 20 trials otherwise fill the
    // TUI's context with twenty long answers — measured, that is what starts making turns fail
    // to begin at all. Give it a small one.
    typeAsHuman(SCENARIO === 'draft' ? SHORT_PROMPT : LONG_PROMPT);
    await sleep(200);
    typeAsHuman('\r');
    // NOT fatal if no turn starts: the thing under measurement is the gate's verdict, and for
    // the `draft` scenario a draft on the line must hold the message whether or not a turn is
    // running. Record it and let the trial speak for itself.
    turnRunning = await waitStreaming(20_000);
    if (turnRunning) await sleep(1200); // let the turn get properly under way
    else if (SCENARIO !== 'draft') throw new Error('the TUI never started a turn');
  } else {
    // #1521's window: start a SHORT turn and attempt delivery straight across its end.
    typeAsHuman('Reply with the single word: ok');
    await sleep(200);
    typeAsHuman('\r');
    turnRunning = await waitStreaming(20_000);
  }

  if (SCENARIO === 'draft') {
    // A human is at the line, mid-turn. This is the hold the owner's ruling preserves.
    typeAsHuman('a draft I am still writing');
    await sleep(400);
  }

  verdicts = [];
  const chunksBefore = outputChunks;
  const start = log.length;
  const enqueuedAt = Date.now();
  const row = enqueue(db, {
    workspacePath: WS,
    toAgent: AGENT,
    body: t.frame,
    formattedMessage: t.frame,
    now: enqueuedAt,
  });

  // Drive the PRODUCTION delivery loop at Tower's cadence until it delivers or we give up.
  let deliveredAfterMs: number | null = null;
  let deliveredWhileWorking = false;
  let longestQuietMs = 0;
  let lastSeenDataAt = lastDataAt;
  while (Date.now() - enqueuedAt < DELIVER_TIMEOUT_MS) {
    const streamingNow = wouldLegacyGateHold();
    // Track the longest gap between output bytes: the old gate needed one of at least
    // SETTLE_BEFORE_WRITE_MS to deliver at all, so this is the measurement that says whether it
    // could ever have done so.
    if (lastDataAt !== lastSeenDataAt) {
      longestQuietMs = Math.max(longestQuietMs, lastDataAt - lastSeenDataAt);
      lastSeenDataAt = lastDataAt;
    }
    if (LEGACY_GATE && Date.now() - lastDataAt < SETTLE_BEFORE_WRITE_MS) {
      if (verdicts[verdicts.length - 1] !== 'busy (legacy whole-screen settle)') {
        verdicts.push('busy (legacy whole-screen settle)');
      }
      await sleep(PASS_INTERVAL_MS);
      continue;
    }
    const out = await deliverAgentMail(ports as never, db, WS, AGENT);
    if (out.delivered.length > 0) {
      deliveredAfterMs = Date.now() - enqueuedAt;
      deliveredWhileWorking = streamingNow;
      break;
    }
    const v = out.reason ? `${out.reason}${out.detail ? `:${out.detail}` : ''}` : 'none';
    if (verdicts[verdicts.length - 1] !== v) verdicts.push(v);
    await sleep(PASS_INTERVAL_MS);
  }
  const outputChunksDuringWait = outputChunks - chunksBefore;

  if (SCENARIO === 'draft') {
    // Clear the human's draft so the next trial starts from a clean line, and let the turn end.
    typeAsHuman('\x15'); // ^U
    await sleep(300);
  }

  // Let the turn finish. A message delivered mid-turn is QUEUED by the TUI and submitted when
  // that turn ends — which starts a turn of its own. Observing that second turn is the oracle
  // for "it was submitted as one message", and it is the reliable one: counting copies of the
  // body on screen does not work (a composer repaints its own contents every frame, and those
  // intermediate states scroll into history), and asking the model to echo a token back does
  // not either — measured, claude correctly DECLINES instructions embedded in a delivered
  // message while acknowledging it received it.
  try { await waitIdle(SETTLE_BEFORE_WRITE_MS, TURN_TIMEOUT_MS); } catch { /* recorded below */ }
  if (deliveredAfterMs !== null && (await waitStreaming(8_000))) {
    try { await waitIdle(SETTLE_BEFORE_WRITE_MS, TURN_TIMEOUT_MS); } catch { /* recorded below */ }
  }
  // Submitted, not left sitting on the line: the body rendered in the transcript AND the
  // composer is a verified-empty prompt again. (Measured: at this point the TUI has moved the
  // whole message into its transcript as one user turn.)
  const after = await screen.read();
  const composerClearedAfter = classifyBuffer(after.term, after.cols, after.rows, PROFILE).clean;

  // A trial that never delivered leaves its row HELD, and the delivery path always picks the
  // OLDEST held row — so without this the next trial would be measuring this trial's message.
  // (The `draft` scenario holds by design, so every one of its trials lands here.)
  if (deliveredAfterMs === null) dismiss(db, row.id);

  const plain = stripAnsi(log.slice(start));
  const flat = skeleton(plain);
  const headRendered = flat.includes(skeleton(t.head));
  const tailRendered = flat.includes(skeleton(t.tail));

  const stored = getById(db, row.id);
  let verdict: Result['verdict'];
  if (stored?.status !== 'delivered') verdict = 'held';
  else if (headRendered && tailRendered) verdict = 'delivered-intact';
  else if (!headRendered && tailRendered) verdict = 'delivered-head-lost';
  else verdict = 'delivered-not-rendered';

  return {
    n: t.n,
    scenario: SCENARIO,
    deliveredAfterMs,
    deliveredWhileWorking,
    longestQuietMs,
    verdicts: [...verdicts],
    outputChunksDuringWait,
    headRendered,
    tailRendered,
    composerClearedAfter,
    turnRunning,
    verdict,
  };
}

// ---------------------------------------------------------------- run

console.log(`[1664] ${CMD} ${tuiVersion} — scenario=${SCENARIO} trials=${TRIALS} cols=${COLS} rows=${ROWS}`);
console.log(`[1664] output → ${OUT}`);

try {
  await waitIdle(1000, 90_000);
  for (let n = 1; n <= TRIALS; n++) {
    const t = makeTrial(n);
    let r: Result;
    try {
      r = await runTrial(t);
    } catch (err) {
      // One flaky trial must not discard the other nineteen: record it, put the TUI back on a
      // clean line if it will come back, and carry on. A run whose report is never written is a
      // run that measured nothing.
      console.log(`  #${String(n).padStart(2)} harness-error          ${String(err).split('\n')[0]}`);
      results.push({
        n, scenario: SCENARIO, deliveredAfterMs: null, deliveredWhileWorking: false,
        longestQuietMs: 0, verdicts: [], outputChunksDuringWait: 0,
        headRendered: false, tailRendered: false, composerClearedAfter: false, verdict: 'harness-error',
      });
      if (exited) break;
      try { await waitIdle(SETTLE_BEFORE_WRITE_MS, TURN_TIMEOUT_MS); } catch { break; }
      continue;
    }
    results.push(r);
    console.log(
      `  #${String(n).padStart(2)} ${r.verdict.padEnd(22)} ` +
        `after=${r.deliveredAfterMs === null ? 'never' : `${r.deliveredAfterMs}ms`} ` +
        `whileStreaming=${r.deliveredWhileWorking} repaints=${r.outputChunksDuringWait} ` +
        `maxQuiet=${r.longestQuietMs}ms ` +
        `verdicts=[${r.verdicts.join(', ')}]`,
    );
  }
} finally {
  pty.kill();
  db.close();
}

// ---------------------------------------------------------------- report

const delivered = results.filter((r) => r.deliveredAfterMs !== null);
const waits = delivered.map((r) => r.deliveredAfterMs as number).sort((a, b) => a - b);
const mean = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : 0;
const counts = results.reduce<Record<string, number>>((acc, r) => {
  acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
  return acc;
}, {});

const summary = [
  `# Issue #1664 — ${SCENARIO} delivery acceptance (${LABEL})`,
  '',
  `- harness: \`${CMD}\` ${tuiVersion}, ${COLS}x${ROWS}, ${TRIALS} trials`,
  `- gate: ${LEGACY_GATE ? 'the RETIRED whole-screen output settle (--legacy-gate)' : 'the CURRENT composer-region stability gate'}`,
  `- delivery: the PRODUCTION \`deliverAgentMail\` over a real sqlite mailbox, live gate bindings`,
  `  (\`classifyBuffer\` + \`composerRegionFingerprint\`) and the production write edge`,
  `  (\`submitMessagePaced\`), driven every ${PASS_INTERVAL_MS} ms`,
  `- settle: \`SETTLE_BEFORE_WRITE_MS\`=${SETTLE_BEFORE_WRITE_MS} ms`,
  '',
  '## Outcomes',
  '',
  ...Object.entries(counts).map(([k, v]) => `- **${k}**: ${v}/${TRIALS}`),
  '',
  `- delivered at a moment the RETIRED whole-screen settle would have refused: ${delivered.filter((r) => r.deliveredWhileWorking).length}/${TRIALS}`,
  `- longest output gap seen while a row waited: ${Math.max(0, ...results.map((r) => r.longestQuietMs))} ms ` +
    `(the retired whole-screen settle needed ${SETTLE_BEFORE_WRITE_MS} ms to deliver at all)`,
  `- wait to delivery: mean ${mean} ms, median ${waits.length ? waits[Math.floor(waits.length / 2)] : 0} ms, max ${waits.length ? waits[waits.length - 1] : 0} ms`,
  `- head-loss (tail rendered, head did not): ${results.filter((r) => r.verdict === 'delivered-head-lost').length}/${TRIALS}`,
  `- body left the composer for the transcript (submitted, not stranded on the line): ${results.filter((r) => r.composerClearedAfter).length}/${TRIALS}`,
  `- a turn was running while the row waited: ${results.filter((r) => r.turnRunning).length}/${TRIALS}`,
  `- repaints the recipient emitted while the row waited: median ${
    [...results.map((r) => r.outputChunksDuringWait)].sort((a, b) => a - b)[Math.floor(results.length / 2)] ?? 0
  }`,
  '',
  '## Hold verdicts observed',
  '',
  ...[...new Set(results.flatMap((r) => r.verdicts))].map((v) => `- \`${v}\``),
  '',
].join('\n');

writeFileSync(resolve(OUT, 'summary.md'), summary);
writeFileSync(resolve(OUT, 'results.json'), JSON.stringify({ scenario: SCENARIO, tuiVersion, results }, null, 2));
console.log(`\n${summary}`);
