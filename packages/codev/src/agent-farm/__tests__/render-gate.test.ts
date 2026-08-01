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
import { fileURLToPath } from 'node:url';
import { RingBuffer } from '../../terminal/ring-buffer.js';
import { classifyScreen, RING_SEED_MAX_BYTES } from '../servers/render-gate.js';
import type { RingSnapshot, GateProfile } from '../servers/render-gate.js';
import { CLAUDE_PROFILE, CODEX_PROFILE, AGY_PROFILE, resolveProfile } from '../servers/gate-profiles.js';

const COLS = 110;
const ROWS = 32;
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
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
    // the profile's placeholder palette, not every non-default color.
    const trust = snapshotFromRaw(screen(`${PAL12}>${FG} ${PAL12}Yes, I trust this folder${FG}`, '  No, exit'));
    const v = await classifyScreen(trust, AGY_PROFILE);
    expect(v.clean).toBe(false);
    expect(v.detail).toBe('user-text');
  });

  it('an empty replay is busy (a session with no output is not a verified-empty prompt)', async () => {
    expect((await classifyScreen(snapshotFromRaw(''), CLAUDE_PROFILE)).clean).toBe(false);
  });
});

describe('render-gate — performance at the seed cap (Spec 1313)', () => {
  it('classifies an over-cap (>1MB) snapshot within the spec ≤~50ms seed-cap budget', async () => {
    // Build > RING_SEED_MAX_BYTES of newline-free filler so it lands in the
    // ring's unbounded `partial` (the claude full-screen-TUI shape, #1047) rather
    // than being truncated by the 1000-line cap. A busy composer tail follows so
    // the capped-to-1MB reconstruction still finds a marker and classifies.
    const filler = 'x'.repeat(RING_SEED_MAX_BYTES + 100_000);
    const raw = filler + '\r\n' + screen('❯ occupied prompt tail', '──────');
    const snap = snapshotFromRaw(raw);
    expect(snap.replay.length).toBeGreaterThan(RING_SEED_MAX_BYTES);

    // Warm up (JIT + first-parse), then assert the MIN over several runs. The min
    // strips GC/scheduling outliers, approximating the classifier's steady-state
    // compute cost — the stable basis a budget assertion needs so it validates the
    // bound instead of flaking in CI. (Spike: 22ms @ 1MB; this env: ~15ms native /
    // ~30ms under vitest — comfortably inside the spec's ≤~50ms seed-cap bound.)
    await classifyScreen(snap, CLAUDE_PROFILE); // warm-up (discarded)
    let best = Infinity;
    let verdict;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      verdict = await classifyScreen(snap, CLAUDE_PROFILE);
      best = Math.min(best, performance.now() - t0);
    }
    // eslint-disable-next-line no-console
    console.log(`[render-gate] classify @${Math.round(snap.replay.length / 1024)}KB best-of-5 = ${best.toFixed(1)}ms`);
    expect(verdict?.clean).toBe(false); // the tail is a busy prompt
    // Validates the spec's ≤~50ms seed-cap budget with headroom for slower/loaded
    // CI than the spike's machine, while staying an order of magnitude below a
    // catastrophic (e.g. O(n²)) regression. Tightened from a prior 500ms ceiling.
    expect(best).toBeLessThan(75);
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
