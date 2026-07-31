/**
 * Spike 1265 — review round 5, concern 2: writer-vs-writer interleaving at the
 * Tower write layer (no TUI needed — this is Tower-side scheduling, not app
 * behavior).
 *
 * Drives the REAL production functions from message-write.ts (loaded via
 * node --experimental-strip-types; the module is pure erasable TS with zero
 * imports) against a mock session that records write order.
 *
 * What it demonstrates:
 *  w1a: two concurrent direct sends (handleSend path, no delayOffset) — the
 *       second message's text lands BEFORE the first message's Enter, so the
 *       receiving line submits "msg1msg2" as one blob.
 *  w1b: two concurrent PACED multi-line sends — their lines interleave.
 *  w1c: writeEscapeToSession vs a concurrent send — the message text lands
 *       between ESC and ESC's trailing Enter.
 *  w1d: control — the delayOffset serialization used by SendBuffer.flush for
 *       its own batch DOES prevent interleaving; the gap is that handleSend's
 *       direct path, cron's deliverMessage, and the escape path never use it
 *       (each starts at offset 0 on the same session).
 *
 * Self-asserting: exit 1 on any assertion failure.
 *
 * Usage: node --experimental-strip-types exp-w1-writer-race.mjs
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(
  path.join(here, '..', '..', '..', 'packages', 'codev', 'src', 'agent-farm', 'servers', 'message-write.ts')
);
const { writeMessageToSession, writeEscapeToSession } = mod;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
function check(label, ok, detail) {
  console.log(`ASSERT ${label}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
  if (!ok) failures.push(label);
}

function recorder() {
  const t0 = Date.now();
  const log = [];
  return {
    session: { write: (data) => log.push({ t: Date.now() - t0, data }) },
    log,
    stream: () => log.map((e) => e.data).join(''),
    dump: (label) => {
      console.log(`[${label}]`);
      for (const e of log) console.log(`  +${String(e.t).padStart(3)}ms ${JSON.stringify(e.data)}`);
    },
  };
}

// --- w1a: two concurrent SHORT direct sends (both offset 0, like handleSend) ---
{
  const r = recorder();
  writeMessageToSession(r.session, '[architect] msg-one', false);
  await sleep(5);
  writeMessageToSession(r.session, '[builder] msg-two', false);
  await sleep(250);
  r.dump('w1a two concurrent short sends, no offset');
  const s = r.stream();
  // msg-two's text is written before msg-one's \r → the line holds both when Enter arrives
  const blob = s.indexOf('[builder] msg-two') < s.indexOf('\r');
  check('w1a-second-text-before-first-enter', blob, `stream=${JSON.stringify(s)}`);
  check('w1a-blob-on-line', s.startsWith('[architect] msg-one[builder] msg-two\r'), 'line content at first Enter = both messages');
}

// --- w1b: two concurrent PACED multi-line sends (both offset 0) ---
{
  const r = recorder();
  const m1 = 'A1\nA2\nA3\nA4\nA5';
  const m2 = 'B1\nB2\nB3\nB4\nB5';
  writeMessageToSession(r.session, m1, false);
  writeMessageToSession(r.session, m2, false);
  await sleep(300);
  r.dump('w1b two concurrent paced sends, no offset');
  const seq = r.log.map((e) => e.data.replace('\n', '')).filter((d) => /^[AB]\d$/.test(d));
  const interleaved = seq.some((d, i) => i > 0 && d[0] !== seq[i - 1][0] && seq.slice(i + 1).some((x) => x[0] === seq[i - 1][0]));
  check('w1b-lines-interleaved', interleaved, `line order=${seq.join(',')}`);
}

// --- w1c: escape (ESC + delayed Enter) vs concurrent send ---
{
  const r = recorder();
  writeEscapeToSession(r.session, false); // ESC now, \r at +50ms
  await sleep(10);
  writeMessageToSession(r.session, '[architect] during-escape', false);
  await sleep(250);
  r.dump('w1c escape vs concurrent send');
  const s = r.stream();
  const msgBetween = s.indexOf('[architect] during-escape') > s.indexOf('\x1b')
    && s.indexOf('[architect] during-escape') < s.indexOf('\r');
  check('w1c-message-lands-inside-escape-sequence', msgBetween, `stream=${JSON.stringify(s)}`);
}

// --- w1d: control — delayOffset chaining (what SendBuffer.flush does) ---
{
  const r = recorder();
  const m1 = 'A1\nA2\nA3\nA4\nA5';
  const m2 = 'B1\nB2\nB3\nB4\nB5';
  const done1 = writeMessageToSession(r.session, m1, false);
  writeMessageToSession(r.session, m2, false, done1 + 10);
  await sleep(400);
  r.dump('w1d same two sends, offset-chained');
  const seq = r.log.map((e) => e.data.replace('\n', '')).filter((d) => /^[AB]\d$/.test(d));
  const clean = seq.join(',') === 'A1,A2,A3,A4,A5,B1,B2,B3,B4,B5';
  check('w1d-offset-chaining-serializes', clean, `line order=${seq.join(',')}`);
}

if (failures.length) {
  console.error(`FAILURES: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('ALL ASSERTIONS PASSED');
process.exit(0);
