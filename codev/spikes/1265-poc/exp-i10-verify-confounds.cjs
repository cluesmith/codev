/**
 * Spike 1265 — round 11, architect gap 2: the round-10 post-delivery verify
 * (i8's postVerify: viewport token search) cannot support "no undetected
 * loss" as a UNIVERSAL property. This experiment audits the oracle itself.
 *
 * The round-10 decision procedure is copied VERBATIM from exp-i8 (the
 * artifact under audit) as postVerifyNaive. Against it we run a
 * DIFFERENTIAL own-entry oracle shaped like production would be: the gate
 * render (pre-write ring recon) and the verify render (post-settle ring
 * recon) are both available in production — verdicts come from the DELTA,
 * not from post-state token presence.
 *
 *   i10a duplicate content — an identical entry already in the transcript +
 *        a delivery that renders NOTHING new (the i8a-measured wrapper-eaten
 *        outcome: zero new render — asserted there via the successor stdin
 *        drain probe) ⇒ naive says delivered-visible (FALSE SUCCESS);
 *        differential sees count unchanged ⇒ not delivered.
 *   i10b fused input — draft on the line, today-style delivery submits the
 *        blob (e0 baseline) ⇒ naive says delivered-visible (FALSE SUCCESS on
 *        the exact corruption this spike exists to fix); differential sees no
 *        new EXACT entry, flags the fused form.
 *   i10c fast responses / scrolling — a genuinely successful delivery whose
 *        entry scrolls out of the viewport ⇒ a LATE naive verify says `lost`
 *        (FALSE LOSS — the auto-re-hold signature ⇒ duplicate redelivery);
 *        the composer marker is still present, so the sound `lost` rule
 *        (token-absent AND no-composer-marker, the i8c conjunction) refuses
 *        it. Also: the EARLY (at-settle) verify is correct on both oracles —
 *        the verify is a ONE-SHOT at settle, not a re-runnable check.
 *   i10d codex positive branch — a successful local /status delivery on
 *        codex (no API traffic): the same render/classify machinery
 *        produces a usable positive/consumed verdict on the second TUI.
 *
 * Claude cases run against a dead ANTHROPIC_BASE_URL (submit mechanics real,
 * zero API calls). Codex runs the local /status command only.
 *
 * Self-asserting: exit 1 on any assertion failure. MEASURED lines are
 * exploratory-tier observations.
 *
 * Usage: node exp-i10-verify-confounds.cjs claude
 *        node exp-i10-verify-confounds.cjs codex
 */
'use strict';
const { TuiDriver, sleep, show, Terminal } = require('./harness.cjs');

const which = process.argv[2] || 'claude';
const DEAD = 'http://127.0.0.1:9';

const failures = [];
function check(label, ok, detail) {
  console.log(`ASSERT ${label}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
  if (!ok) failures.push(label);
}
function note(label, detail) { console.log(`MEASURED ${label}: ${detail}`); }

// ---- Round-10 decision procedure, copied VERBATIM from exp-i8 (under audit) ----
const IGNORE_CHARS = new Set(['❯', '›', '│', '▌', '─', '━', '╌', '┄', '╭', '╰', '┌', '└', '']);

function screenOfTerm(term, rows) {
  const buf = term.buffer.active;
  const top = buf.viewportY;
  const lines = [];
  for (let i = 0; i < rows; i++) {
    const line = buf.getLine(top + i);
    lines.push(line ? line.translateToString(true).trimEnd() : '');
  }
  return lines;
}

function classifyTerm(term, cols, rows) {
  const buf = term.buffer.active;
  const lines = screenOfTerm(term, rows);
  let markerRow = -1;
  for (let i = 0; i < lines.length; i++) if (/^[❯›]/.test(lines[i])) markerRow = i;
  if (markerRow === -1) return { clean: false, reason: 'no-composer-marker', userCells: -1 };
  let endRow = lines.length;
  for (let i = markerRow + 1; i < lines.length; i++) {
    if (/^[─━╌┄]{5,}/.test(lines[i]) || /^\s{2,}(gpt|high:|~\/)/.test(lines[i])) { endRow = i; break; }
  }
  const top = buf.viewportY;
  let userCells = 0;
  const cell = buf.getNullCell();
  for (let row = markerRow; row < endRow; row++) {
    const line = buf.getLine(top + row);
    if (!line) continue;
    for (let col = 0; col < cols; col++) {
      line.getCell(col, cell);
      const ch = cell.getChars();
      if (!ch || /^\s+$/u.test(ch) || IGNORE_CHARS.has(ch)) continue;
      if (row === markerRow && col === 0) continue;
      if (cell.isDim()) continue;
      userCells++;
    }
  }
  return { clean: userCells === 0, reason: userCells === 0 ? 'empty' : 'user-text', userCells };
}

function postVerifyNaive(term, cols, rows, token) {
  const cls = classifyTerm(term, cols, rows);
  const lines = screenOfTerm(term, rows);
  if (!lines.join('\n').includes(token)) return { verdict: 'lost', cls };
  let markerRow = -1;
  for (let i = 0; i < lines.length; i++) if (/^[❯›]/.test(lines[i])) markerRow = i;
  const inComposer = markerRow >= 0 && lines.slice(markerRow).join('\n').includes(token);
  if (inComposer) return { verdict: 'stranded', cls };
  return { verdict: 'delivered-visible', cls };
}

async function reconFromRaw(rawChunks, cols, rows) {
  const t = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
  await new Promise((r) => t.write(rawChunks.join(''), r));
  return t;
}

// ---- Differential own-entry oracle (the production-shaped alternative) -----
// Scans the WHOLE buffer (scrollback + viewport), excludes the composer
// region, counts lines carrying the FULL delivered message, and checks for an
// EXACT entry: no user text (letters/digits) before the message on its line —
// entry glyphs/spinners are punctuation, a fused draft carries alphanumerics.
// (Attribute-shaped rule, not a glyph allowlist — same design lesson as the
// classifier's dim-placeholder rule. Pathological all-punctuation drafts
// would evade it; the input-side tracker still sees those as occupancy.)
const NO_USER_TEXT = /^[^\p{L}\p{N}]*$/u;

function entryLines(term, rows, token) {
  const buf = term.buffer.active;
  const top = buf.viewportY;
  const viewport = screenOfTerm(term, rows);
  let markerRow = -1;
  for (let i = 0; i < viewport.length; i++) if (/^[❯›]/.test(viewport[i])) markerRow = i;
  const composerStartAbs = markerRow >= 0 ? top + markerRow : Infinity;
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    if (i >= composerStartAbs) continue; // composer region is not transcript
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true).trimEnd();
    const idx = text.indexOf(token);
    if (idx === -1) continue;
    out.push({ text, exact: NO_USER_TEXT.test(text.slice(0, idx)) });
  }
  return { count: out.length, exactCount: out.filter((l) => l.exact).length, lines: out, markerPresent: markerRow >= 0 };
}

function differentialVerify(preTerm, postTerm, rows, token) {
  const pre = entryLines(preTerm, rows, token);
  const post = entryLines(postTerm, rows, token);
  const anywherePost = post.count > 0;
  let verdict;
  if (post.exactCount === pre.exactCount + 1) verdict = 'delivered-verified';
  else if (!anywherePost && !post.markerPresent) verdict = 'lost'; // the sound i8c conjunction
  else if (post.count > pre.count && post.exactCount === pre.exactCount) verdict = 'fused-suspect';
  else verdict = 'unverified';
  return { verdict, pre, post };
}

async function freshSession(label) {
  const env = which === 'claude' ? { ANTHROPIC_BASE_URL: DEAD } : {};
  const d = new TuiDriver(which, [], { label, env });
  await d.settle(2000, 40000);
  await sleep(1200);
  if (which === 'codex' && d.screenText().includes('Press enter to continue')) {
    d.send('3'); await sleep(300); d.send('\r');
    await d.settle(2000, 40000); await sleep(800);
  }
  return d;
}

// Tower's non-paced delivery shape (message-write.ts single-line): text, \r at 50 ms.
async function towerDeliver(d, msg) {
  d.send(msg);
  await sleep(50);
  d.send('\r');
}

(async () => {
  if (which === 'claude') {
    // ================= i10a: duplicate-content false success ================
    {
      const d = await freshSession('expI10a');
      const MSG = '[architect] i10dup probe';
      await towerDeliver(d, MSG);            // the EARLIER, real delivery
      await d.settle(1500, 20000); await sleep(800);
      check('i10a-earlier-entry-rendered', d.screenText().includes('i10dup'), 'identical content already in the transcript');
      d.snapshot('i10a-before');

      // Gate moment for the delivery UNDER TEST.
      const kPre = d.rawLog.length;
      const preRecon = await reconFromRaw(d.rawLog.slice(0, kPre), d.cols, d.rows);

      // The delivery under test is EATEN: zero new render. That outcome class
      // is measured fact (i8a: wrapper `read -r` consumed text+\r; successor
      // stdin drain found nothing; i8c: the eaten case renders no token).
      await sleep(1200); // the settle a production verify would wait

      const postRecon = await reconFromRaw(d.rawLog, d.cols, d.rows);
      const naive = postVerifyNaive(postRecon, d.cols, d.rows, 'i10dup');
      const naiveLive = postVerifyNaive(d.term, d.cols, d.rows, 'i10dup');
      check('i10a-naive-false-success', naive.verdict === 'delivered-visible' && naiveLive.verdict === 'delivered-visible',
        `recon=${naive.verdict} live=${naiveLive.verdict} — token search credits the OLD entry to a delivery that rendered nothing`);
      const diff = differentialVerify(preRecon, postRecon, d.rows, MSG); // FULL message — the exact-entry currency
      check('i10a-differential-not-fooled', diff.verdict !== 'delivered-verified',
        `differential=${diff.verdict} (pre exact=${diff.pre.exactCount}, post exact=${diff.post.exactCount}) — no NEW entry ⇒ not delivered`);
      d.kill();
    }

    // ================= i10b: fused-blob false success ========================
    {
      const d = await freshSession('expI10b');
      await d.type('i10fuse-draft');         // user's half-typed input, no submit
      await sleep(600);
      const kPre = d.rawLog.length;
      const preRecon = await reconFromRaw(d.rawLog.slice(0, kPre), d.cols, d.rows);
      const gate = classifyTerm(preRecon, d.cols, d.rows);
      check('i10b-gate-would-hold', gate.clean === false && gate.reason === 'user-text',
        `pre-write G-lite=${gate.reason} — the fusion below is only reachable when the gate is bypassed/raced (today: always)`);

      const MSG = '[architect] i10fuse msg';
      await towerDeliver(d, MSG);            // today-style delivery onto the draft
      await d.settle(1500, 20000); await sleep(800);
      d.snapshot('i10b-after-blob');
      const blob = d.screenText().includes('i10fuse-draft[architect] i10fuse msg');
      check('i10b-blob-submitted', blob, 'draft+message fused into ONE transcript entry (e0 baseline mechanics)');

      const postRecon = await reconFromRaw(d.rawLog, d.cols, d.rows);
      const naive = postVerifyNaive(postRecon, d.cols, d.rows, 'i10fuse msg');
      check('i10b-naive-false-success', naive.verdict === 'delivered-visible',
        `naive=${naive.verdict} — the verify blesses the exact corruption this spike exists to remove`);
      const diff = differentialVerify(preRecon, postRecon, d.rows, MSG); // FULL message
      check('i10b-differential-flags-fusion', diff.verdict !== 'delivered-verified' && diff.post.exactCount === 0,
        `differential=${diff.verdict} (post exact=${diff.post.exactCount}, post any=${diff.post.count}) — message present ONLY with user text before it ⇒ fused, not delivered`);
      d.kill();
    }

    // ================= i10c: scroll-out false loss ===========================
    {
      const d = await freshSession('expI10c');
      const kPre = d.rawLog.length;
      const preRecon = await reconFromRaw(d.rawLog.slice(0, kPre), d.cols, d.rows);
      check('i10c-gate-clean', classifyTerm(preRecon, d.cols, d.rows).clean === true, 'legit delivery: empty composer at gate time');

      const MSG = '[architect] i10scroll probe';
      await towerDeliver(d, MSG);            // a genuinely successful delivery
      await d.settle(1500, 20000); await sleep(800);
      check('i10c-delivered-for-real', d.screenText().includes('i10scroll'), 'entry rendered');

      // EARLY verify — the production one-shot at settle.
      const earlyRecon = await reconFromRaw(d.rawLog, d.cols, d.rows);
      const naiveEarly = postVerifyNaive(earlyRecon, d.cols, d.rows, 'i10scroll');
      const diffEarly = differentialVerify(preRecon, earlyRecon, d.rows, MSG); // FULL message
      check('i10c-early-verify-correct', naiveEarly.verdict === 'delivered-visible' && diffEarly.verdict === 'delivered-verified',
        `early: naive=${naiveEarly.verdict} differential=${diffEarly.verdict} — at-settle both oracles are right (and this is the claude positive-branch differential proof)`);

      // Now the transcript grows until the entry leaves the viewport. Under
      // the dead API claude has two render modes for the fillers — real
      // entries, or (mid-retry) a one-row-per-message queued list — and both
      // consume viewport rows monotonically; the cap must cover the slower
      // queued mode (~1 row/filler against a 32-row viewport).
      let scrolled = false;
      for (let i = 0; i < 34 && !scrolled; i++) {
        await towerDeliver(d, `filler entry ${i} qqz`);
        await sleep(700);
        scrolled = !screenOfTerm(d.term, d.rows).join('\n').includes('i10scroll');
      }
      d.snapshot('i10c-after-scroll');
      check('i10c-scrolled-out', scrolled, 'the successful entry left the viewport');

      // LATE verify — what a delayed or re-run naive verify would say.
      const naiveLate = postVerifyNaive(d.term, d.cols, d.rows, 'i10scroll');
      check('i10c-naive-false-loss', naiveLate.verdict === 'lost',
        `late naive=${naiveLate.verdict} — a SUCCESSFUL delivery classifies as the auto-re-hold signature ⇒ duplicate redelivery`);
      const marker = entryLines(d.term, d.rows, 'i10scroll').markerPresent;
      check('i10c-conjunction-refuses', marker === true,
        `composer marker present on the healthy session — the sound lost rule (token-absent AND no-marker, i8c) does NOT fire`);
      const lateRecon = await reconFromRaw(d.rawLog, d.cols, d.rows);
      const diffLate = differentialVerify(preRecon, lateRecon, d.rows, MSG); // FULL message
      check('i10c-differential-never-lost', diffLate.verdict !== 'lost',
        `late differential=${diffLate.verdict} (post any=${diffLate.post.count}, scrollback-inclusive) — never the auto-re-hold verdict`);
      note('i10c-late-differential', `verdict=${diffLate.verdict} — scrollback retention of the entry is claude repaint behavior (g2d: newline-free stream), recorded not assumed`);
      d.kill();
    }
  }

  if (which === 'codex') {
    // ================= i10d: codex positive branch ===========================
    {
      const d = await freshSession('expI10d');
      const kPre = d.rawLog.length;
      const preRecon = await reconFromRaw(d.rawLog.slice(0, kPre), d.cols, d.rows);
      check('i10d-gate-clean', classifyTerm(preRecon, d.cols, d.rows).clean === true, 'empty composer at gate time');
      const preText = screenOfTerm(preRecon, d.rows).join('\n');

      // Local /status — a successful delivery-and-consumption with zero API
      // traffic (the codex arm has no dead-API submission rig).
      await d.type('/status');
      await sleep(400);
      d.send('\r');
      await d.settle(1800, 25000); await sleep(800);
      d.snapshot('i10d-after-status');
      show(d.screen().filter((l) => l), 'codex after /status delivery');

      const postRecon = await reconFromRaw(d.rawLog, d.cols, d.rows);
      const clsLive = classifyTerm(d.term, d.cols, d.rows);
      const clsRecon = classifyTerm(postRecon, d.cols, d.rows);
      check('i10d-consumed-composer-clean', clsLive.clean === true && clsRecon.clean === true,
        `live=${clsLive.reason} recon=${clsRecon.reason} — the delivery was consumed, nothing stranded`);
      const postText = screenOfTerm(postRecon, d.rows).join('\n');
      check('i10d-new-output-rendered', postText !== preText && d.rawLog.length > kPre,
        `post-write render differs and ${d.rawLog.length - kPre} new chunks arrived — a positive consumed/produced-output signature exists on codex`);
      const naive = postVerifyNaive(d.term, d.cols, d.rows, '/status');
      note('i10d-naive-verdict', `naive on token "/status": ${naive.verdict} (cls=${naive.cls.reason}) — command echo rendering is codex UI behavior, recorded`);
      d.kill();
    }
  }

  if (failures.length) {
    console.error(`FAILURES: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nALL ASSERTIONS PASSED');
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
