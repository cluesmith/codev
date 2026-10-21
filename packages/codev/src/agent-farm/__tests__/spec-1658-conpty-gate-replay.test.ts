/**
 * Spec 1658, Phase 8: does `afx send` hold and deliver correctly on a Windows (ConPTY) terminal?
 *
 * ConPTY does not pass the child's bytes through. It renders the child into its own screen buffer
 * and re-emits that buffer as VT, so the stream Tower receives repaints whole rows, reorders
 * cursor moves and redraws the screen on resize, on its own schedule (#1567: assume nothing about
 * echo, resize or exit timing). The gate's mid-turn licence (#1664) rests on the composer region
 * fingerprinting identically across a streaming agent's repaints; a ConPTY that perturbed that
 * region on every frame would hold every message for the length of a turn.
 *
 * So the question is answered from captures, not reasoning: each fixture under
 * `fixtures/gate/conpty/` is a real agent TUI recorded under ConPTY by
 * `scripts/spec-1658-conpty-capture.mts`, replayed on its own clock through the production
 * delivery path (`helpers/conpty-replay.ts`). The synthetic captures below prove the replay
 * itself, including that it CAN hold, so a fixture that passes says something about ConPTY.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CAPTURE_FORMAT,
  PROBE_WINDOW_MS,
  loadCapture,
  parseCapture,
  replayProbes,
  serializeCapture,
  type Capture,
  type CaptureEvent,
  type ProbeResult,
} from './helpers/conpty-replay.js';
import { CLAUDE_PROFILE, resolveProfile } from '../servers/gate-profiles.js';
import type { DeliveryDetail } from '../servers/mailbox-delivery.js';

const CONPTY_FIXTURE_DIR = fileURLToPath(new URL('./fixtures/gate/conpty', import.meta.url));

/** The holds a human at the line may cause; anything else on a held probe is a gate failure. */
const HUMAN_HOLD_DETAILS: ReadonlyArray<DeliveryDetail | null> = ['user-text', 'recent-input', 'composer-redraw'];

// ---------------------------------------------------------------------------
// Synthetic captures: a claude-shaped screen, repainted the way a streaming TUI repaints it
// ---------------------------------------------------------------------------

const ESC = '\x1b';
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;

function frame(cols: number, spinner: string, composer: string, placeholder = ''): string {
  const rule = '─'.repeat(cols - 2);
  let composerRow = `❯ ${composer}`;
  if (composer === '' && placeholder !== '') {
    composerRow = `❯ ${DIM}${placeholder}${RESET}`;
  }
  const rows = [
    '⏺ Reading the delivery path.',
    '',
    `✽ ${spinner}`,
    '',
    rule,
    composerRow,
    rule,
    '  agent | builder/spir-1658 | Opus 5',
  ];
  return `${ESC}[H${ESC}[2J${rows.join('\r\n')}${ESC}[6;${3 + composer.length}H`;
}

function capture(state: string, expectation: 'delivered' | 'held', events: CaptureEvent[]): Capture {
  return {
    header: { format: CAPTURE_FORMAT, version: 1, app: 'claude', state, cols: 120, rows: 40, expect: expectation },
    events: [...events].sort((a, b) => a.t - b.t),
  };
}

/** A turn streaming from 0 to `endMs`: the spinner line changes every `everyMs`. */
function streaming(endMs: number, everyMs: number, composer = '', placeholderAt?: (t: number) => string): CaptureEvent[] {
  const events: CaptureEvent[] = [];
  for (let t = 0; t <= endMs; t += everyMs) {
    let placeholder = '';
    if (placeholderAt) placeholder = placeholderAt(t);
    events.push({ t, o: frame(120, `Bunning… (${Math.floor(t / 1000)}s · ↓ ${t} tokens)`, composer, placeholder) });
  }
  return events;
}

function expectAllDelivered(results: ProbeResult[]): void {
  expect(results.length).toBeGreaterThan(0);
  for (const result of results) {
    expect(result, `probe ${result.probe}`).toMatchObject({ delivered: true });
  }
}

function expectAllHeldByHuman(results: ProbeResult[]): void {
  expect(results.length).toBeGreaterThan(0);
  for (const result of results) {
    expect(result.delivered, `probe ${result.probe}`).toBe(false);
    for (const detail of result.heldDetails) {
      expect(HUMAN_HOLD_DETAILS, `probe ${result.probe} held ${String(detail)}`).toContain(detail);
    }
  }
}

describe('Spec 1658 replay harness: the production delivery path on a capture clock', () => {
  it('round-trips the capture format', () => {
    const original = capture('idle', 'delivered', [{ t: 0, o: frame(120, 'idle', '') }, { t: 500, probe: 'idle' }]);
    expect(parseCapture(serializeCapture(original))).toEqual(original);
    expect(() => parseCapture('{"format":"something-else","version":1}\n')).toThrow(/not a codev-terminal-capture/);
  });

  it('idle prompt → delivered', async () => {
    const results = await replayProbes(
      capture('idle', 'delivered', [{ t: 0, o: frame(120, 'Sautéed for 15s', '') }, { t: 1000, probe: 'idle' }]),
      CLAUDE_PROFILE,
    );
    expectAllDelivered(results);
  });

  it('mid-turn, empty composer, spinner repainting every 120 ms → delivered while the turn runs (#1664)', async () => {
    const results = await replayProbes(
      capture('midturn', 'delivered', [
        ...streaming(6000, 120),
        { t: 1000, probe: 'early' },
        { t: 3000, probe: 'late' },
      ]),
      CLAUDE_PROFILE,
    );
    expectAllDelivered(results);
    for (const result of results) {
      expect(result.waitedMs).toBeLessThanOrEqual(PROBE_WINDOW_MS);
    }
  });

  it('human typing a draft → held user-text, never delivered', async () => {
    const draft = 'review the mailbox change';
    const events: CaptureEvent[] = [{ t: 0, o: frame(120, 'Sautéed for 15s', '') }];
    for (let k = 1; k <= draft.length; k++) {
      const t = 1000 + k * 60;
      events.push({ t, i: draft[k - 1] });
      events.push({ t: t + 5, o: frame(120, 'Sautéed for 15s', draft.slice(0, k)) });
    }
    const typedAt = 1000 + draft.length * 60 + 5;
    events.push({ t: typedAt, probe: 'still-typing' });
    events.push({ t: typedAt + 1500, probe: 'paused' });
    events.push({ t: typedAt + 4000, o: frame(120, 'Sautéed for 15s', draft) });
    const results = await replayProbes(capture('draft', 'held', events), CLAUDE_PROFILE);
    expectAllHeldByHuman(results);
    expect(results[1].heldDetails).toContain('user-text');
  });

  it('a keystroke the terminal has not echoed yet → held recent-input (#1473: ConPTY echo latency)', async () => {
    const results = await replayProbes(
      capture('keystroke', 'held', [
        { t: 0, o: frame(120, 'Sautéed for 15s', '') },
        { t: 1000, i: 'r' },
        { t: 1001, probe: 'before-echo' },
        { t: 1080, o: frame(120, 'Sautéed for 15s', 'r') },
      ]),
      CLAUDE_PROFILE,
    );
    expectAllHeldByHuman(results);
    expect(results[0].heldDetails[0]).toBe('recent-input');
  });

  it('resize → the mirror follows the PTY, and the repainted idle prompt delivers at the new size', async () => {
    const results = await replayProbes(
      capture('resize', 'delivered', [
        { t: 0, o: frame(120, 'Sautéed for 15s', '') },
        { t: 1000, r: [100, 30] },
        { t: 1040, o: frame(100, 'Sautéed for 15s', '') },
        { t: 2000, probe: 'after-resize' },
      ]),
      CLAUDE_PROFILE,
    );
    expectAllDelivered(results);
  });

  it('NEGATIVE CONTROL: a composer region that changes on every repaint is held composer-redraw for the whole window', async () => {
    // The replay must be able to fail. A dim placeholder classifies clean, so only the
    // fingerprint can hold this one, and the fingerprint moves every frame.
    const results = await replayProbes(
      capture('redraw', 'held', [
        ...streaming(6000, 100, '', (t) => `placeholder ${t}`),
        { t: 1000, probe: 'redrawing' },
      ]),
      CLAUDE_PROFILE,
    );
    expect(results[0].delivered).toBe(false);
    expect(new Set(results[0].heldDetails)).toEqual(new Set(['composer-redraw']));
  });
});

// ---------------------------------------------------------------------------
// Real ConPTY captures
// ---------------------------------------------------------------------------

function conptyFixtures(): string[] {
  if (!existsSync(CONPTY_FIXTURE_DIR)) return [];
  return readdirSync(CONPTY_FIXTURE_DIR).filter((name) => name.endsWith('.capture.jsonl.gz')).sort();
}

describe('Spec 1658 ConPTY captures: held/delivered per state, through the production gate', () => {
  const fixtures = conptyFixtures();
  if (fixtures.length === 0) {
    it.todo('ConPTY captures recorded on a Windows machine (owner, scripts/spec-1658-conpty-capture.mts)');
  }
  for (const name of fixtures) {
    it(`${name}`, async () => {
      const recorded = loadCapture(readFileSync(`${CONPTY_FIXTURE_DIR}/${name}`));
      expect(recorded.header.platform).toBe('win32');
      expect(name).toBe(`conpty-${recorded.header.app}-${recorded.header.state}.capture.jsonl.gz`);

      const profile = resolveProfile({ command: recorded.header.app });
      expect(profile, `no gate profile for ${recorded.header.app}`).not.toBeNull();
      if (!profile) return;

      const results = await replayProbes(recorded, profile);
      if (recorded.header.expect === 'delivered') {
        expectAllDelivered(results);
      } else {
        expectAllHeldByHuman(results);
      }
    });
  }
});
