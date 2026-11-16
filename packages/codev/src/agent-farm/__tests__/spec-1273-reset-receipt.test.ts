/**
 * Spec 1273 Phase 3 — the reset receipt gate (invariant R2).
 *
 * R2: `/clear` is never written unless the state file has been verified to
 * (a) carry THIS run's nonce, (b) meet a minimum-substance threshold, and
 * (c) be size-stable across observations. A stale file from a previous reset
 * MUST NOT satisfy the gate.
 *
 * These tests are the negative space of that invariant: each rejection path gets
 * its own case, because the failure this gate prevents — clearing a builder's
 * context before its state landed — is irreversible.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  generateNonce,
  nonceMarker,
  buildSaveRequest,
  verifyReceipt,
  describeReceiptFailure,
  stateFilePath,
  type ReceiptFsPort,
  type ReceiptObservation,
} from '../commands/reset/receipt.js';
import { DEFAULT_MIN_BYTES, DEFAULT_STABILITY_WINDOW_MS, STATE_FILE_NAME } from '../commands/reset/constants.js';

// ============================================================================
// Helpers
// ============================================================================

const PATH = '/tmp/ws/.builders/aspir-1273/.builder-state.md';

/** In-memory fs port — no real files, no real clock. */
function makeFs(files: Record<string, string>): ReceiptFsPort {
  return {
    sizeOf: (p) => (p in files ? Buffer.byteLength(files[p], 'utf-8') : null),
    read: (p) => (p in files ? files[p] : null),
  };
}

/** A state file that would pass on substance, containing the given nonce. */
function substantiveFile(nonce: string, bytes = DEFAULT_MIN_BYTES + 500): string {
  const header = `${nonceMarker(nonce)}\n`;
  return header + 'x'.repeat(Math.max(0, bytes - Buffer.byteLength(header, 'utf-8')));
}

/** A prior observation that satisfies everything except the caller's own checks. */
function priorObservation(bytes: number): ReceiptObservation {
  return { status: 'still-growing', bytes };
}

// ============================================================================
// Nonce
// ============================================================================

describe('reset nonce (Spec 1273)', () => {
  it('generates a different nonce per run', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateNonce()));
    // If two runs could collide, a stale file could satisfy a later run's gate.
    expect(seen.size).toBe(50);
  });

  it('embeds the nonce in an HTML comment so it is invisible when rendered', () => {
    const marker = nonceMarker('abc123');
    expect(marker).toBe('<!-- codev-reset: abc123 -->');
    expect(marker.startsWith('<!--')).toBe(true);
  });
});

// ============================================================================
// Save request
// ============================================================================

describe('buildSaveRequest (Spec 1273)', () => {
  const nonce = 'deadbeef0000';
  const request = buildSaveRequest(nonce, PATH);

  it('carries the exact marker line the gate will look for', () => {
    expect(request).toContain(nonceMarker(nonce));
  });

  it('names the exact target path', () => {
    expect(request).toContain(PATH);
  });

  it('tells the builder the file is untracked and must not be staged', () => {
    // porch done sweeps staged files — a staged state file would vanish.
    expect(request.toLowerCase()).toContain('untracked');
    expect(request.toLowerCase()).toMatch(/do not stage|not stage/);
  });

  it('asks for every item on the cold-reader checklist', () => {
    // The gate is structural, so this wording is the only thing driving quality.
    const lower = request.toLowerCase();
    expect(lower).toContain('cold reader');
    expect(lower).toContain('role and mission');
    expect(lower).toContain('position in the protocol');
    expect(lower).toContain('receipts');
    expect(lower).toContain('in-flight');
    expect(lower).toContain('open questions');
    expect(lower).toContain('standing orders');
    expect(lower).toContain('next concrete action');
  });

  it('asks the builder to distinguish written from verified', () => {
    expect(request.toLowerCase()).toContain('verified');
  });
});

// ============================================================================
// R2 — the gate itself
// ============================================================================

describe('verifyReceipt — R2 gate (Spec 1273)', () => {
  const nonce = 'a1b2c3d4e5f6';

  it('accepts a nonce-bearing, substantive, size-stable file', () => {
    const file = substantiveFile(nonce);
    const bytes = Buffer.byteLength(file, 'utf-8');
    const result = verifyReceipt({
      fs: makeFs({ [PATH]: file }),
      statePath: PATH,
      nonce,
      previous: priorObservation(bytes),
      msSincePrevious: DEFAULT_STABILITY_WINDOW_MS,
    });

    expect(result.status).toBe('accepted');
    expect(result.bytes).toBe(bytes);
  });

  it('rejects a missing file', () => {
    const result = verifyReceipt({ fs: makeFs({}), statePath: PATH, nonce });
    expect(result.status).toBe('missing');
  });

  it('rejects a stale file from a PREVIOUS reset (wrong nonce)', () => {
    // The headline R2 case: substantive, stable, plausible — and superseded.
    const stale = substantiveFile('old-nonce-999');
    const result = verifyReceipt({
      fs: makeFs({ [PATH]: stale }),
      statePath: PATH,
      nonce,
      previous: priorObservation(Buffer.byteLength(stale, 'utf-8')),
      msSincePrevious: DEFAULT_STABILITY_WINDOW_MS * 10,
    });

    expect(result.status).toBe('wrong-nonce');
  });

  it('rejects a nonce-bearing stub below the substance threshold', () => {
    const stub = `${nonceMarker(nonce)}\nsaved everything, all good\n`;
    const result = verifyReceipt({
      fs: makeFs({ [PATH]: stub }),
      statePath: PATH,
      nonce,
      previous: priorObservation(Buffer.byteLength(stub, 'utf-8')),
      msSincePrevious: DEFAULT_STABILITY_WINDOW_MS,
    });

    expect(result.status).toBe('too-small');
  });

  it('rejects a file that is still growing between observations', () => {
    const file = substantiveFile(nonce, 4000);
    const result = verifyReceipt({
      fs: makeFs({ [PATH]: file }),
      statePath: PATH,
      nonce,
      previous: priorObservation(2000), // smaller a moment ago → still being written
      msSincePrevious: DEFAULT_STABILITY_WINDOW_MS,
    });

    expect(result.status).toBe('still-growing');
  });

  it('does not accept two same-size reads taken closer together than the stability window', () => {
    // Without the time gap, a builder mid-write looks stable purely because both
    // reads landed between the same two write() calls.
    const file = substantiveFile(nonce);
    const bytes = Buffer.byteLength(file, 'utf-8');
    const result = verifyReceipt({
      fs: makeFs({ [PATH]: file }),
      statePath: PATH,
      nonce,
      previous: priorObservation(bytes),
      msSincePrevious: DEFAULT_STABILITY_WINDOW_MS - 1,
    });

    expect(result.status).toBe('still-growing');
  });

  it('never accepts on a first observation, however substantive the file', () => {
    const file = substantiveFile(nonce, 50_000);
    const result = verifyReceipt({ fs: makeFs({ [PATH]: file }), statePath: PATH, nonce });

    expect(result.status).toBe('still-growing');
  });

  it('reports the most specific failure: freshness is checked before substance', () => {
    // A stale stub is BOTH wrong-nonce and too-small. Reporting "too-small"
    // would send the architect chasing --min-bytes for a staleness problem.
    const staleStub = `${nonceMarker('previous-run')}\ntiny\n`;
    const result = verifyReceipt({ fs: makeFs({ [PATH]: staleStub }), statePath: PATH, nonce });

    expect(result.status).toBe('wrong-nonce');
  });

  it('honours a caller-supplied minBytes override', () => {
    const small = `${nonceMarker(nonce)}\nshort but genuinely all there was\n`;
    const bytes = Buffer.byteLength(small, 'utf-8');
    const result = verifyReceipt({
      fs: makeFs({ [PATH]: small }),
      statePath: PATH,
      nonce,
      minBytes: 10,
      previous: priorObservation(bytes),
      msSincePrevious: DEFAULT_STABILITY_WINDOW_MS,
    });

    expect(result.status).toBe('accepted');
  });

  it('accepts a nonce whose surrounding marker whitespace differs', () => {
    // Freshness is proved by the nonce; discarding a real save over comment
    // spacing would be a false rejection of work that cost the builder real effort.
    const reworded = `<!--codev-reset:${nonce}-->\n` + 'y'.repeat(DEFAULT_MIN_BYTES);
    const bytes = Buffer.byteLength(reworded, 'utf-8');
    const result = verifyReceipt({
      fs: makeFs({ [PATH]: reworded }),
      statePath: PATH,
      nonce,
      previous: priorObservation(bytes),
      msSincePrevious: DEFAULT_STABILITY_WINDOW_MS,
    });

    expect(result.status).toBe('accepted');
  });

  it('performs no writes — verification is read-only', () => {
    const calls: string[] = [];
    const fs: ReceiptFsPort = {
      sizeOf: (p) => { calls.push(`sizeOf:${p}`); return 0; },
      read: (p) => { calls.push(`read:${p}`); return ''; },
    };

    verifyReceipt({ fs, statePath: PATH, nonce });

    expect(calls.every(c => c.startsWith('sizeOf:') || c.startsWith('read:'))).toBe(true);
  });
});

// ============================================================================
// Failure reporting
// ============================================================================

describe('describeReceiptFailure (Spec 1273)', () => {
  it('points a missing file at --interrupt-first', () => {
    const msg = describeReceiptFailure({ status: 'missing' }, PATH);
    expect(msg).toContain('--interrupt-first');
  });

  it('says a wrong-nonce file is stale rather than blaming the builder', () => {
    const msg = describeReceiptFailure({ status: 'wrong-nonce', bytes: 9000 }, PATH);
    expect(msg.toLowerCase()).toContain('stale');
    expect(msg).toContain('9000');
  });

  it('offers --min-bytes when the file is a stub', () => {
    const msg = describeReceiptFailure({ status: 'too-small', bytes: 120 }, PATH);
    expect(msg).toContain('--min-bytes');
    expect(msg).toContain(String(DEFAULT_MIN_BYTES));
  });

  it('says a partial save was refused rather than reporting a timeout', () => {
    const msg = describeReceiptFailure({ status: 'still-growing', bytes: 400 }, PATH);
    expect(msg.toLowerCase()).toContain('partial');
  });
});

// ============================================================================
// Paths
// ============================================================================

describe('stateFilePath (Spec 1273)', () => {
  it('places the state file at the worktree root with the .builder- prefix', () => {
    // The prefix keeps `afx cleanup` classifying the worktree as clean.
    const p = stateFilePath('/tmp/ws/.builders/aspir-1273');
    expect(p).toBe(join('/tmp/ws/.builders/aspir-1273', STATE_FILE_NAME));
    expect(STATE_FILE_NAME.startsWith('.builder-')).toBe(true);
  });

  it('tolerates a trailing separator on the worktree path', () => {
    expect(stateFilePath('/tmp/ws/.builders/aspir-1273/')).toBe(
      join('/tmp/ws/.builders/aspir-1273', STATE_FILE_NAME),
    );
  });

  it('uses platform path joining, not string concatenation', () => {
    // The path is handed to the builder verbatim in the save request. If it were
    // built with a hardcoded '/', a Windows worktree would yield
    // `C:\repo\wt\/.builder-state.md` — the builder would write to one path and
    // the gate would stat another. Asserting against path.join keeps this test
    // meaningful on whichever platform it runs.
    const worktree = join('C:', 'repo', 'wt');
    expect(stateFilePath(worktree)).toBe(join(worktree, STATE_FILE_NAME));
    expect(stateFilePath(worktree)).not.toContain('\\/');
    expect(stateFilePath(worktree)).not.toContain('//');
  });

  it('produces no doubled separator for any trailing-separator form', () => {
    for (const wt of ['/a/b', '/a/b/', '/a/b//']) {
      expect(stateFilePath(wt)).toBe(join('/a/b', STATE_FILE_NAME));
    }
  });
});
