/**
 * Render-empty gate (Spec 1313, Phase 2) — classifier + profile tests.
 *
 * The fixture suite classifies REAL captured byte streams from claude 2.1.212 and
 * codex (captured under a PTY the same way the spike measured them; see
 * `codev/spikes/1265-poc/exp-g2-glite-prod-path.mjs`). Each fixture is the raw
 * PTY output for one screen state; the test pushes it through the production
 * `RingBuffer` and classifies the reconstruction — the exact
 * `ringBuffer.getAll().join('\n')` data path the live gate uses. Filenames encode
 * the expected verdict: `<app>-<state>.<clean|busy>.txt`.
 *
 * Synthetic ANSI cases pin the individual classifier branches deterministically;
 * `resolveProfile` cases pin the strict, fail-safe app-identity mapping.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import xtermHeadless from '@xterm/headless';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import { RingBuffer } from '../../terminal/ring-buffer.js';
import { SessionScreen } from '../../terminal/session-screen.js';
import { classifyScreen, classifyBuffer } from '../servers/render-gate.js';
import type { RingSnapshot, GateProfile, GateVerdict } from '../servers/render-gate.js';
import { CLAUDE_PROFILE, CODEX_PROFILE, AGY_PROFILE, resolveProfile } from '../servers/gate-profiles.js';

// Default-imported for the same CJS-interop reason `render-gate.ts` documents (the named export
// is not statically analyzable); the negative control below builds its own throwaway terminal.
const { Terminal } = xtermHeadless;

const COLS = 110;
const ROWS = 32;
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const INV = '\x1b[7m'; // SGR-7 inverse (claude's software block cursor over the ghost's first char)
const INV_OFF = '\x1b[27m'; // SGR-27 inverse off
const PAL8 = '\x1b[38;5;8m'; // agy's placeholder gray
const PAL12 = '\x1b[38;5;12m'; // agy's marker / selected-option bright blue
const FG = '\x1b[39m'; // reset foreground to default

/** Production data path: raw PTY bytes → RingBuffer.pushData → getAll().join('\n'). */
function snapshotFromRaw(raw: string, cols = COLS, rows = ROWS): RingSnapshot {
  const ring = new RingBuffer(1000);
  ring.pushData(raw);
  return { replay: ring.getAll().join('\n'), cols, rows };
}

/** Build a raw \r\n-terminated screen from lines. */
function screen(...lines: string[]): string {
  return lines.map((l) => l + '\r\n').join('');
}

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/gate', import.meta.url));

function profileForFixture(name: string): GateProfile {
  if (name.startsWith('codex')) return CODEX_PROFILE;
  if (name.startsWith('agy')) return AGY_PROFILE;
  return CLAUDE_PROFILE; // claude-* and the marker-less wrapper/boot fixture
}

describe('render-gate — real captured fixtures (Spec 1313)', () => {
  const fixtures = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.txt')).sort();

  it('the required states are all captured (claude+codex idle/draft/menu/picker, agy idle/draft/trust, wrapper/boot)', () => {
    for (const required of [
      'claude-idle.clean',
      'claude-draft.busy',
      'claude-menu.busy',
      'claude-picker.busy',
      'codex-idle.clean',
      'codex-draft.busy',
      'codex-menu.busy',
      'codex-picker.busy',
      'agy-idle.clean',
      'agy-draft.busy',
      'agy-trust.busy',
      'wrapper-boot.busy',
    ]) {
      expect(fixtures.some((f) => f.startsWith(required))).toBe(true);
    }
  });

  for (const name of fixtures) {
    const expectClean = name.includes('.clean.');
    it(`${name} → ${expectClean ? 'clean' : 'busy'}`, async () => {
      const raw = readFileSync(`${FIXTURE_DIR}/${name}`, 'utf8');
      const verdict = await classifyScreen(snapshotFromRaw(raw), profileForFixture(name));
      expect(verdict.clean).toBe(expectClean);
      if (!expectClean) expect(verdict.reason).toBe('busy');
    });
  }

  it('a marker-less screen is busy under BOTH profiles (wrapper/boot is app-agnostic)', async () => {
    const raw = readFileSync(`${FIXTURE_DIR}/wrapper-boot.busy.txt`, 'utf8');
    const snap = snapshotFromRaw(raw);
    expect((await classifyScreen(snap, CLAUDE_PROFILE)).detail).toBe('no-composer-marker');
    expect((await classifyScreen(snap, CODEX_PROFILE)).clean).toBe(false);
  });
});

describe('render-gate — synthetic branch coverage (Spec 1313)', () => {
  it('marker + dim placeholder only → clean', async () => {
    const snap = snapshotFromRaw(screen(`❯ ${DIM}Try "refactor doctor.ts"${RESET}`, '──────────────────────'));
    expect(await classifyScreen(snap, CLAUDE_PROFILE)).toMatchObject({ clean: true, detail: 'empty' });
  });

  it('marker + normal-intensity user text → busy (user-text)', async () => {
    const snap = snapshotFromRaw(screen(`❯ ${RESET}deploy the hotfix to prod`, '──────'));
    const v = await classifyScreen(snap, CLAUDE_PROFILE);
    expect(v.clean).toBe(false);
    expect(v.reason).toBe('busy');
    expect(v.detail).toBe('user-text');
  });

  it('a single normal char among dim placeholder flips clean → busy', async () => {
    const clean = snapshotFromRaw(screen(`❯ ${DIM}placeholder text here${RESET}`, '──────'));
    const dirty = snapshotFromRaw(screen(`❯ ${DIM}placeholder ${RESET}x${DIM} here${RESET}`, '──────'));
    expect((await classifyScreen(clean, CLAUDE_PROFILE)).clean).toBe(true);
    expect((await classifyScreen(dirty, CLAUDE_PROFILE)).clean).toBe(false);
  });

  it('codex-style bold/colored marker + dim placeholder → clean; region ends at the status line', async () => {
    const snap = snapshotFromRaw(screen(
      `${BOLD}›${RESET} ${DIM}Explain this codebase${RESET}`,
      '  gpt-5.6-sol   high: on   ~/repo',
      'this normal text is BELOW the status line and must NOT count',
    ));
    expect((await classifyScreen(snap, CODEX_PROFILE)).clean).toBe(true);
  });

  it('no composer marker → busy (no-composer-marker), never a false clean', async () => {
    const snap = snapshotFromRaw(screen('builder@host:~/repo$ ', 'Press Enter to relaunch'));
    const v = await classifyScreen(snap, CLAUDE_PROFILE);
    expect(v.clean).toBe(false);
    expect(v.detail).toBe('no-composer-marker');
  });

  it('marker + NO region-end boundary, only dim/empty below → busy (no-region-end; closes a latent false-CLEAN)', async () => {
    // Spec 1313 D1 hardening. Previously an unbounded region scanned to lines.length;
    // with only dim/empty rows below (no rule/status line to bound the composer) it
    // counted 0 user cells and returned CLEAN — a false-clean on a partial/mid-repaint
    // frame. Now a missing lower bound is indeterminate ⇒ hold. (Marker + dim below,
    // NO `─────` rule.)
    const snap = snapshotFromRaw(screen(`❯ ${DIM}Try "refactor doctor.ts"${RESET}`, `${DIM}dim tail, no rule line${RESET}`));
    const v = await classifyScreen(snap, CLAUDE_PROFILE);
    expect(v.clean).toBe(false);
    expect(v.detail).toBe('no-region-end');
  });

  it('agy: `> ` marker + palette-8 (gray) hint → clean; default-fg draft → busy', async () => {
    // agy de-emphasizes its idle hint with a FOREGROUND COLOR (palette-8), not
    // SGR-dim — so the placeholder rule is color-keyed for agy (placeholderFgPalette).
    const idle = snapshotFromRaw(screen(`${PAL12}>${FG} ${PAL8}Accept-edits mode: file edits auto-approved${FG}`, '──────'));
    const draft = snapshotFromRaw(screen(`${PAL12}>${FG} review the mailbox change`, '──────'));
    expect((await classifyScreen(idle, AGY_PROFILE)).clean).toBe(true);
    expect((await classifyScreen(draft, AGY_PROFILE)).clean).toBe(false);
  });

  it('agy: only palette-8 is placeholder — a non-gray (palette-12) option still counts (trust-dialog guard)', async () => {
    // The trust dialog's selected `> Yes, I trust this folder` renders palette-12,
    // NOT gray — so it must count as occupancy (busy), else a blind Enter would
    // confirm a filesystem-trust decision. Pins that the color rule ignores ONLY
    // the profile's placeholder palette, not every non-default color. A rule line
    // bounds the region so the color-counting branch runs and palette-12 is the sole
    // occupancy signal. (Dual protection: a real dialog with NO rule below fails safe
    // the OTHER way — via the no-region-end guard — also busy, never a blind confirm.)
    const trust = snapshotFromRaw(screen(`${PAL12}>${FG} ${PAL12}Yes, I trust this folder${FG}`, '──────'));
    const v = await classifyScreen(trust, AGY_PROFILE);
    expect(v.clean).toBe(false);
    expect(v.detail).toBe('user-text');
  });

  it('an empty replay is busy (a session with no output is not a verified-empty prompt)', async () => {
    expect((await classifyScreen(snapshotFromRaw(''), CLAUDE_PROFILE)).clean).toBe(false);
  });
});

describe('render-gate — whole-ring render at any size (Spec 1313 D2 + over-ceiling removal)', () => {
  it('renders a realistic large (~4MB) ring WHOLE (no tail slice, no size cap)', async () => {
    // The D2 fix renders the whole coherent ring (no 1MB tail slice). Build ~4MB of
    // newline-free filler so it lands in the ring's unbounded `partial` (the claude
    // full-screen-TUI shape, #1047) rather than being truncated by the 1000-line cap;
    // a busy composer tail follows. The whole ring renders (no slice, no size cap) — the
    // real steady-state path (largest real capture ≈ 3MB).
    // (This test carried a wall-clock budget until #1471; the classifier's COST is now
    // pinned deterministically by the op-count suite below, which measures the production
    // mirror path rather than this transient one. What survives here is the correctness
    // half: a 4MB ring renders whole and classifies its busy tail.)
    const filler = 'x'.repeat(4 * 1024 * 1024);
    const raw = filler + '\r\n' + screen('❯ occupied prompt tail', '──────');
    const snap = snapshotFromRaw(raw);
    expect(snap.replay.length).toBeGreaterThan(4 * 1024 * 1024);

    const verdict = await classifyScreen(snap, CLAUDE_PROFILE);
    expect(verdict.clean).toBe(false); // the tail is a busy prompt
  });

  it('renders a ring ABOVE the old over-ceiling WHOLE and classifies its empty composer CLEAN', async () => {
    // The removed `over-ceiling` hold used to reject any ring past a fixed 8M-unit size
    // UNRENDERED → a permanent delivery outage for the busiest agents (a live ~14M-unit
    // empty-composer terminal was stuck until relaunch). Now the whole ring renders at any
    // size: a >8M-unit #1047 basin (newline-free filler in the partial — the claude
    // alt-screen shape) that ENDS in a clean empty composer classifies CLEAN and delivers.
    // Deliberately past the old ceiling — this is exactly the regression the change fixes.
    const filler = 'x'.repeat(9 * 1024 * 1024);
    const raw = filler + '\r\n' + screen(`❯ ${DIM}Try "refactor doctor.ts"${RESET}`, '──────────────────────');
    const snap = snapshotFromRaw(raw);
    expect(snap.replay.length).toBeGreaterThan(8 * 1024 * 1024); // past the removed 8M ceiling
    const v = await classifyScreen(snap, CLAUDE_PROFILE);
    expect(v.clean).toBe(true);
    expect(v.detail).toBe('empty');
  });
});

describe('render-gate — real >1MB captures render WHOLE (Spec 1313 D2 root fix)', () => {
  // Real claude ring captures (gzipped; cols×rows as captured). The false-`busy` was
  // a capReplay slice artifact: the WHOLE render classifies CLEAN, but the old 1MB
  // tail slice tore the alt-screen frame → BUSY. Source: codev/spir-1313-captures.
  const load = (name: string) => gunzipSync(readFileSync(`${FIXTURE_DIR}/${name}`)).toString('utf8');
  const CAP_1MB = 1024 * 1024;

  for (const { file, cols, rows } of [
    { file: 'claude-bgtask-empty.replay.bin.gz', cols: 139, rows: 65 }, // field "monitor→busy" ring (region-spill)
    { file: 'claude-bigring-empty.replay.bin.gz', cols: 139, rows: 65 }, // field "empty held; ↑↓ delivers" ring (marker-loss)
  ]) {
    it(`${file}: WHOLE → CLEAN, but a 1MB tail slice → BUSY (proves the fix, not a big-ring rubber-stamp)`, async () => {
      const whole = load(file);
      expect(whole.length).toBeGreaterThan(CAP_1MB);
      // The fix: the real gate renders the whole ring → CLEAN. Regression guard — this
      // fails if any tail cap ≤ the ring size is reintroduced.
      expect((await classifyScreen({ replay: whole, cols, rows }, CLAUDE_PROFILE)).clean).toBe(true);
      // Honesty: the OLD 1MB-cap slice genuinely tears (marker/rule lost) → BUSY, so
      // the fixture exercises the artifact rather than just being a clean big ring.
      const oldCapSlice = whole.slice(whole.length - CAP_1MB);
      expect((await classifyScreen({ replay: oldCapSlice, cols, rows }, CLAUDE_PROFILE)).clean).toBe(false);
    });
  }

  it('claude-justover-cap (1.07MB): CLEAN whole AND under a 1MB slice (negative control — the fix does NOT blindly clean big rings)', async () => {
    const whole = load('claude-justover-cap.replay.bin.gz');
    expect(whole.length).toBeGreaterThan(CAP_1MB);
    expect((await classifyScreen({ replay: whole, cols: 139, rows: 65 }, CLAUDE_PROFILE)).clean).toBe(true);
    expect((await classifyScreen({ replay: whole.slice(whole.length - CAP_1MB), cols: 139, rows: 65 }, CLAUDE_PROFILE)).clean).toBe(true);
  });

  it('claude-smallring-idle (6KB, 139×63): CLEAN (small-ring idle baseline — no regression)', async () => {
    const whole = load('claude-smallring-idle.replay.bin.gz');
    expect((await classifyScreen({ replay: whole, cols: 139, rows: 63 }, CLAUDE_PROFILE)).clean).toBe(true);
  });
});

describe('render-gate — PRODUCTION data path: capped ring TEARS, persistent mirror does NOT (Spec 1313 round 2)', () => {
  // The merge-blocker this round fixes. The whole-capture tests above feed classifyScreen the raw
  // capture DIRECTLY, which masks #1205: in production the gate saw the capture only AFTER it went
  // through a RingBuffer whose 2 MiB partial cap TORE the newline-free alt-screen frame. This suite
  // drives the real production data path — the same chunked dual-feed PtySession.onPtyData does
  // (ring + mirror together) — and asserts the split: the capped ring reconstruction classifies
  // BUSY (the resurrected outage), while the persistent bounded mirror classifies CLEAN (the fix).
  // Architect field repro of the tear: bgtask 2,794,991→1,680,872 chars via the ring; bigring
  // 2,991,283→1,877,164. Both empty-composer idle screens, so the TRUTH is CLEAN.
  const loadGz = (name: string) => gunzipSync(readFileSync(`${FIXTURE_DIR}/${name}`)).toString('utf8');
  const CHUNK = 64 * 1024; // PTY output arrives in chunks; 64 KiB matches the architect's repro feed

  for (const { file, cols, rows } of [
    { file: 'claude-bgtask-empty.replay.bin.gz', cols: 139, rows: 65 },
    { file: 'claude-bigring-empty.replay.bin.gz', cols: 139, rows: 65 },
  ]) {
    it(`${file}: real default RingBuffer → BUSY (torn), persistent mirror → CLEAN (proves the round-2 fix)`, async () => {
      const capture = loadGz(file);
      expect(capture.length).toBeGreaterThan(2 * 1024 * 1024); // crosses the #1205 partial cap

      // Feed the capture through BOTH objects exactly as PtySession.onPtyData does: chunked, with
      // the ring and the mirror fed the SAME bytes in lockstep. This is the real production path,
      // not the direct classifyScreen feed the whole-capture tests use.
      const ring = new RingBuffer(1000); // DEFAULT 2 MiB partial cap — the production config
      const screen = new SessionScreen(cols, rows);
      for (let i = 0; i < capture.length; i += CHUNK) {
        const chunk = capture.slice(i, i + CHUNK);
        ring.pushData(chunk);
        screen.feed(chunk);
      }

      // The capped ring genuinely tears (partial trimmed below the whole frame) → the OLD whole-ring
      // gate goes BUSY. This is the regression guard: it fails if #1205's cap is ever reverted OR if
      // the fixture stops crossing the cap.
      expect(ring.getAll().join('\n').length).toBeLessThan(capture.length); // front dropped by the trim
      const ringVerdict = await classifyScreen({ replay: ring.getAll().join('\n'), cols, rows }, CLAUDE_PROFILE);
      expect(ringVerdict.clean).toBe(false);

      // The persistent mirror folded the same bytes into a BOUNDED screen whose viewport is the real
      // current screen → CLEAN. This is the fix: the delivery outage is gone for the busiest agents.
      const { term } = await screen.read();
      expect(classifyBuffer(term, cols, rows, CLAUDE_PROFILE)).toMatchObject({ clean: true, detail: 'empty' });
      screen.dispose();
    });
  }
});

describe('render-gate — deterministic op count: one classify is O(viewport), not O(ring size) (#1471)', () => {
  // Replaces the wall-clock budget this file used to assert on the whole-ring render. A timing
  // bound measures the MACHINE, not the algorithm: the identical code that best-of-5'd well under
  // the 250ms local ceiling on an idle box measured 391.7ms pinned to one contended core. So the
  // bound either flakes on a loaded runner or gets loosened until it no longer catches the
  // regression it exists for (its history: 75ms → 250 → a CI-aware 800).
  //
  // The cost property the gate actually guarantees post round-2 is algorithmic, and it belongs to
  // the PRODUCTION path: classification reads the session's persistent bounded `SessionScreen`
  // mirror, so one classify touches a viewport (rows × cols cells) and nothing else, however much
  // output the session has produced. Counting the classifier's buffer reads pins exactly that — in
  // integers, which cannot flake.

  const CHUNK = 64 * 1024; // PTY output arrives in chunks; matches the production feed above
  const GATE_COLS = 139;
  const GATE_ROWS = 65;

  /** The work one classify does: buffer reads, plus any bytes it parses (it must parse none). */
  interface OpCounts {
    lineReads: number;
    cellReads: number;
    bytesParsed: number;
  }

  type MirrorLine = NonNullable<ReturnType<HeadlessTerminal['buffer']['active']['getLine']>>;
  type MirrorCell = Parameters<MirrorLine['getCell']>[1];

  /** Delegate a property to `target` with `this` bound to it — xterm's are prototype accessors. */
  function passthrough<T extends object>(target: T, prop: string | symbol): unknown {
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? (value as (...args: never[]) => unknown).bind(target) : value;
  }

  function countingLine(line: MirrorLine, ops: OpCounts): MirrorLine {
    return new Proxy(line, {
      get(target, prop) {
        if (prop !== 'getCell') return passthrough(target, prop);
        return (col: number, cell?: MirrorCell) => {
          ops.cellReads++;
          return target.getCell(col, cell);
        };
      },
    });
  }

  /**
   * A read-counting facade over a live terminal. `classifyBuffer` takes the terminal as a parameter
   * and only READS it, so the test can hand it this proxy and count the work the REAL classifier
   * does — no production instrumentation, nothing stubbed out from under the code under test.
   */
  function countingTerm(term: HeadlessTerminal, ops: OpCounts): HeadlessTerminal {
    // Resolved per access rather than captured, so the facade follows a normal→alternate buffer
    // switch the way the classifier's own `term.buffer.active` read does.
    const countingBuffer = (buffer: HeadlessTerminal['buffer']['active']) =>
      new Proxy(buffer, {
        get(target, prop) {
          if (prop !== 'getLine') return passthrough(target, prop);
          return (y: number) => {
            ops.lineReads++;
            const line = target.getLine(y);
            return line && countingLine(line, ops);
          };
        },
      });
    return new Proxy(term, {
      get(target, prop) {
        if (prop === 'write') {
          return (data: string, cb?: () => void) => {
            ops.bytesParsed += data.length; // a classify re-parsing its input would show up here
            return target.write(data, cb);
          };
        }
        if (prop !== 'buffer') return passthrough(target, prop);
        return new Proxy(target.buffer, {
          get: (bufTarget, bufProp) =>
            bufProp === 'active' ? countingBuffer(bufTarget.active) : passthrough(bufTarget, bufProp),
        });
      },
    });
  }

  /** Feed a stream into a persistent mirror exactly as `PtySession.onPtyData` does: chunked. */
  function mirrorOf(raw: string): SessionScreen {
    const mirror = new SessionScreen(GATE_COLS, GATE_ROWS);
    for (let i = 0; i < raw.length; i += CHUNK) mirror.feed(raw.slice(i, i + CHUNK));
    return mirror;
  }

  /** The production classify (`SessionScreen.read()` → `classifyBuffer`), with its ops counted. */
  async function classifyCounted(mirror: SessionScreen): Promise<{ verdict: GateVerdict; ops: OpCounts }> {
    const { term, cols, rows } = await mirror.read();
    const ops: OpCounts = { lineReads: 0, cellReads: 0, bytesParsed: 0 };
    const verdict = classifyBuffer(countingTerm(term, ops), cols, rows, CLAUDE_PROFILE);
    return { verdict, ops };
  }

  // A full repaint (ED2 + cursor home) into an idle claude composer. Both streams below END in
  // this, so the two mirrors hold the SAME final screen and differ only in the history behind it —
  // which is the whole point: identical screen ⇒ identical work, whatever the ring did.
  const IDLE_REPAINT = '\x1b[2J\x1b[H' + screen(`❯ ${DIM}Try "refactor doctor.ts"${RESET}`, '──────────────────────');
  const HUGE_HISTORY = 'x'.repeat(4 * 1024 * 1024) + '\r\n' + IDLE_REPAINT;

  it('4 MB of history and ~200 bytes of history cost byte-identical work (the wall clock cannot say this)', async () => {
    const tiny = mirrorOf(IDLE_REPAINT);
    const huge = mirrorOf(HUGE_HISTORY);
    try {
      const small = await classifyCounted(tiny);
      const big = await classifyCounted(huge);

      expect(small.verdict).toMatchObject({ clean: true, detail: 'empty' });
      expect(big.verdict).toEqual(small.verdict); // same screen ⇒ same verdict
      // The replacement assertion: 20000× the history, exactly the same classifier work.
      expect(big.ops).toEqual(small.ops);
    } finally {
      tiny.dispose();
      huge.dispose();
    }
  });

  it('one classify reads at most one viewport and parses nothing', async () => {
    // The hard geometric bound. `screenLines` reads `rows` lines; the composer scan re-reads only
    // the region rows and at most `cols` cells each. A regression that walked scrollback or
    // re-rendered history — the failure the old timing bound was there to catch — blows both.
    const mirror = mirrorOf(HUGE_HISTORY);
    try {
      const { verdict, ops } = await classifyCounted(mirror);
      expect(verdict.clean).toBe(true);
      expect(ops.lineReads).toBeLessThanOrEqual(GATE_ROWS * 2);
      expect(ops.cellReads).toBeLessThanOrEqual(GATE_COLS * GATE_ROWS);
      expect(ops.bytesParsed).toBe(0); // classification READS a parsed screen; it never re-renders
    } finally {
      mirror.dispose();
    }
  });

  it('repeated classifies of a static screen cost the same each time (no accumulation)', async () => {
    // The backstop re-checks every held agent on a timer, so per-classify cost must be flat in the
    // number of checks as well as in ring size. (The delivery path additionally memoizes the
    // verdict per `ringToken`; this pins the underlying classify, memo or no memo.)
    const mirror = mirrorOf(HUGE_HISTORY);
    try {
      const first = await classifyCounted(mirror);
      const second = await classifyCounted(mirror);
      const third = await classifyCounted(mirror);
      expect(second.ops).toEqual(first.ops);
      expect(third.ops).toEqual(first.ops);
    } finally {
      mirror.dispose();
    }
  });

  it('negative control: the retired whole-ring path re-parses the WHOLE ring per classify', async () => {
    // Honesty check — the op count above is only meaningful if it can tell the two cost models
    // apart. Rebuild the screen the pre-round-2 way (a throwaway terminal fed the whole replay per
    // classify, what `classifyScreen` still does for fixtures) and count it through the same
    // facade: same screen, same cell reads, but ~4 MB parsed per check instead of zero. That
    // difference is the regression the wall-clock budget was proxying for, now asserted directly.
    const term = new Terminal({ cols: GATE_COLS, rows: GATE_ROWS, allowProposedApi: true, scrollback: 2000 });
    const ops: OpCounts = { lineReads: 0, cellReads: 0, bytesParsed: 0 };
    try {
      const counting = countingTerm(term, ops);
      await new Promise<void>((resolve) => counting.write(HUGE_HISTORY, resolve));
      expect(ops.bytesParsed).toBe(HUGE_HISTORY.length);
      expect(ops.bytesParsed).toBeGreaterThan(4 * 1024 * 1024);
      expect(classifyBuffer(counting, GATE_COLS, GATE_ROWS, CLAUDE_PROFILE)).toMatchObject({ clean: true });
    } finally {
      term.dispose();
    }
  });
});

describe('render-gate — claude suggested-command ghost (Spec 1313 render-gate hardening)', () => {
  // Live-found 2026-08-06 (PR #1330 architect integration test). An IDLE claude composer
  // paints a *suggested-command ghost* when the agent's own last reply mentioned a runnable
  // command. The ghost's first character doubles as the software block cursor: rendered SGR-7
  // INVERSE at normal intensity while the rest of the ghost is SGR-2 dim
  // (`❯ ␛[7ma␛[27m␛[2mfx cleanup…␛[22m`). The universal dim rule skipped the ghost body but
  // COUNTED the lone inverse cursor cell → `user-text`/`busy` FOREVER while the composer was
  // genuinely empty, so mail to an idle (unattended) agent was never delivered. classifyScreen
  // now exempts exactly that cell (inverse + non-dim + at the cursor + dim/empty tail).
  const loadGz = (name: string) => gunzipSync(readFileSync(`${FIXTURE_DIR}/${name}`)).toString('utf8');

  it('the real captured ghost ring (claude 2.1.220, 139×63) → CLEAN (pre-fix was busy/user-text with 1 counted cell)', async () => {
    // Captured live from a stuck main-architect terminal whose mail held on `busy` while the
    // composer was visibly empty (held mailbox row a21b6c64). The only would-be-counted cell is
    // the inverse block cursor over the ghost's first char; every other ghost cell is dim. The
    // whole ring renders (0.09 MB — nowhere near any size concern); the fix is the cursor-cell
    // exemption, not a slice change.
    const whole = loadGz('claude-ghost-suggestion-empty.replay.bin.gz');
    const v = await classifyScreen({ replay: whole, cols: 139, rows: 63 }, CLAUDE_PROFILE);
    expect(v).toMatchObject({ clean: true, detail: 'empty' });
  });

  // The exemption keys off the headless cursor cell, so these synthetic cases must leave the
  // cursor ON the composer marker row — `screen()` alone parks it on the line below. A trailing
  // CUP (`ESC[row;colH`, 1-based) parks it precisely; it rides through the RingBuffer as the
  // partial, exactly as the production `getAll().join('\n')` path would carry it.
  const withCursor = (row: number, col: number, ...lines: string[]) =>
    snapshotFromRaw(screen(...lines) + `\x1b[${row};${col}H`);

  it('the ghost signature (inverse non-dim cursor char + dim tail) → clean', async () => {
    const snap = withCursor(1, 3, `❯ ${INV}a${INV_OFF}${DIM}fx cleanup -p task-VdfD${RESET}`, '──────────');
    expect(await classifyScreen(snap, CLAUDE_PROFILE)).toMatchObject({ clean: true, detail: 'empty' });
  });

  it('an inverse cursor char with REAL (non-dim) text following → busy (no new corruption vector; NOT a blanket inverse skip)', async () => {
    // The cursor sits (inverse) on the first char of a real multi-char draft. The dim-tail test
    // fails — the following text is normal-intensity — so the cell is NOT exempted and every
    // draft cell counts. This is the guard the finding demands: the exemption cannot false-clean
    // a real draft, and an inverse selection over real text keeps every other cell counted.
    const snap = withCursor(1, 3, `❯ ${INV}d${INV_OFF}eploy the hotfix`, '──────────');
    const v = await classifyScreen(snap, CLAUDE_PROFILE);
    expect(v.clean).toBe(false);
    expect(v.detail).toBe('user-text');
  });

  it('an inverse non-dim cursor char with an EMPTY tail → busy (a lone inverse cell is not a ghost)', async () => {
    // Codex CMAP (2026-08-06): the exemption must require POSITIVE ghost evidence — at least one
    // dim suggestion-body cell after the cursor. A 1-char draft with the cursor parked on its
    // only char renders as a lone inverse cell with an empty tail; without the positive-evidence
    // rule it would false-clean (the documented "residual" was actually a spec violation —
    // no-new-corruption-vector / fail-toward-hold). An empty tail now stays busy. Genuine ghosts
    // always carry a multi-char dim command body (the real fixture's tail is 23 dim cells).
    const snap = withCursor(1, 3, `❯ ${INV}x${INV_OFF}`, '──────────');
    const v = await classifyScreen(snap, CLAUDE_PROFILE);
    expect(v.clean).toBe(false);
    expect(v.detail).toBe('user-text');
  });

  it('a real draft with the inverse block cursor on trailing whitespace → busy (claude never inverse-renders typed text)', async () => {
    // Models claude's ACTUAL real-draft rendering (measured live, task-vdfd draft "dfsd"): typed
    // characters are non-inverse and the inverse block cursor rests on the empty cell past them.
    // The whitespace cursor cell is skipped as whitespace (the exemption never even evaluates);
    // the typed cells count → busy. The sole accepted residual is a 1-char draft with the cursor
    // relocated onto its only char — documented in the review's Technical Debt.
    const snap = withCursor(1, 14, `❯ deploy prod${INV} ${INV_OFF}`, '──────────');
    const v = await classifyScreen(snap, CLAUDE_PROFILE);
    expect(v.clean).toBe(false);
    expect(v.detail).toBe('user-text');
  });

  it('cross-app: a codex-style ghost of the same signature → clean (the exemption is profile-agnostic)', async () => {
    // Measured live (task-shxz), codex renders its OWN suggestion ghost ("Write tests for
    // @filename") WHOLLY dim — already clean via the dim rule, never hit by this bug. But the
    // exemption is generic, so were codex to adopt claude's inverse-cursor rendering it is handled
    // identically. Pins that generality without committing a live builder capture.
    const snap = withCursor(1, 3, `${BOLD}›${RESET} ${INV}W${INV_OFF}${DIM}rite tests for @filename${RESET}`, '  gpt-5.6-sol   high: on   ~/repo');
    expect(await classifyScreen(snap, CODEX_PROFILE)).toMatchObject({ clean: true, detail: 'empty' });
  });
});

describe('resolveProfile — strict, fail-safe app identity (Spec 1313)', () => {
  it('a claude launch resolves to the claude profile', () => {
    expect(resolveProfile({ command: 'claude', args: ['--dangerously-skip-permissions'] })?.app).toBe('claude');
  });

  it('a full-path codex launch resolves to the codex profile', () => {
    expect(resolveProfile({ command: '/home/u/.nvm/bin/codex', args: ['-c', 'foo=bar'] })?.app).toBe('codex');
  });

  it('agy resolves to the agy profile — NOT claude (Phase 3 measured; constraint 10: no claude fallback)', () => {
    expect(resolveProfile({ command: 'agy' })?.app).toBe('agy');
    expect(resolveProfile({ command: '/usr/local/bin/antigravity', label: 'main' })?.app).toBe('agy');
  });

  it('a wrapped builder launch (bash .builder-start.sh) resolves to null (fail-safe, deferred to Phase 4)', () => {
    expect(resolveProfile({ command: 'bash', args: ['.builder-start.sh'], label: 'spir-1313' })).toBeNull();
  });

  it('an unmeasured but known harness (gemini/opencode) resolves to null (no profile yet)', () => {
    expect(resolveProfile({ command: 'gemini' })).toBeNull();
    expect(resolveProfile({ command: 'opencode' })).toBeNull();
  });
});
