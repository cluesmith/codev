/**
 * Spec 1470 — the driven and self refresh paths must not drift apart.
 *
 * Baked Decision 1 says to reuse the `afx refresh` machinery rather than build a
 * parallel save/clear path. Reuse was only possible for part of it: `runReset`
 * as a whole cannot be self-invoked, because its receipt and quiescence gates
 * poll a builder that would be mid-turn for the entire poll. So the reading the
 * architect accepted at the spec gate is *reuse the modules* — with a structural
 * test pinning it, which is this file.
 *
 * The risk this guards is specific and slow-moving. Nothing stops a future
 * change from adding a second, subtly different receipt check "just for the self
 * path" — and because both paths would still pass their own unit tests, the
 * divergence would be invisible until one of them cleared a builder on a save
 * the other would have rejected. A test that fails the moment a second
 * implementation appears is the only thing that makes that loud.
 *
 * Deliberately scoped to VERIFICATION and ASSEMBLY. The save REQUEST text is
 * intentionally specialized per path (`buildSaveRequest` is written for a
 * mid-phase reset; `buildBoundarySaveRequest` for a protocol boundary), so
 * asserting sameness there would fail on a difference the spec asks for.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const RESET_DIR = resolve(__dirname, '../commands/reset');
const SRC_ROOT = resolve(__dirname, '../..');

function read(file: string): string {
  return readFileSync(join(RESET_DIR, file), 'utf-8');
}

/** Every .ts file under src/, so "does a second copy exist anywhere" is answerable. */
function allSourceFiles(dir = SRC_ROOT, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) allSourceFiles(full, acc);
    else if (full.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

describe('shared refresh machinery', () => {
  it('both paths import receipt verification from the same module', () => {
    const driven = read('index.ts');
    const self = read('self.ts');

    for (const [name, source] of [
      ['driven (index.ts)', driven],
      ['self (self.ts)', self],
    ] as const) {
      expect(source, `${name} must import verifyReceipt`).toMatch(/verifyReceipt/);
      expect(source, `${name} must import it from ./receipt.js`).toMatch(
        /from '\.\/receipt\.js'/,
      );
    }
  });

  it('both paths import re-orientation assembly from the same module', () => {
    const driven = read('index.ts');
    const self = read('self.ts');

    for (const [name, source] of [
      ['driven (index.ts)', driven],
      ['self (self.ts)', self],
    ] as const) {
      expect(source, `${name} must import assembleReorientation`).toMatch(
        /assembleReorientation/,
      );
      expect(source, `${name} must import it from ./reorient.js`).toMatch(
        /from '\.\/reorient\.js'/,
      );
    }
  });

  it('both paths take their thresholds from the same constants module', () => {
    // A forked DEFAULT_MIN_BYTES would mean one path clears on a save the other
    // rejects — the exact silent divergence this file exists to prevent.
    const driven = read('index.ts');
    const self = read('self.ts');

    expect(driven).toMatch(/from '\.\/constants\.js'/);
    expect(self).toMatch(/from '\.\/constants\.js'/);
    expect(self).toMatch(/DEFAULT_MIN_BYTES/);
    expect(self).toMatch(/DEFAULT_STABILITY_WINDOW_MS/);
  });

  it('exactly ONE implementation of verifyReceipt exists in the tree', () => {
    const definitions = allSourceFiles()
      .filter(f => !f.includes('__tests__'))
      .filter(f => /export function verifyReceipt\b/.test(readFileSync(f, 'utf-8')));

    expect(
      definitions,
      `Expected one verifyReceipt; found ${definitions.length}. A second implementation ` +
        `means the driven and self paths can accept different saves.`,
    ).toHaveLength(1);
    expect(definitions[0]).toMatch(/reset[/\\]receipt\.ts$/);
  });

  it('exactly ONE implementation of assembleReorientation exists in the tree', () => {
    const definitions = allSourceFiles()
      .filter(f => !f.includes('__tests__'))
      .filter(f => /export function assembleReorientation\b/.test(readFileSync(f, 'utf-8')));

    expect(
      definitions,
      `Expected one assembleReorientation; found ${definitions.length}. A second ` +
        `implementation means one path can clear on a frame the other would reject (R3).`,
    ).toHaveLength(1);
    expect(definitions[0]).toMatch(/reset[/\\]reorient\.ts$/);
  });

  it('the self path does not re-implement the nonce marker', () => {
    // Freshness is proved by the builder reproducing a marker the gate matches.
    // Two spellings of that marker would silently never match.
    const definitions = allSourceFiles()
      .filter(f => !f.includes('__tests__'))
      .filter(f => /export function nonceMarker\b/.test(readFileSync(f, 'utf-8')));

    expect(definitions).toHaveLength(1);
    expect(read('self.ts')).toMatch(/nonceMarker/);
  });

  it('the save request is deliberately NOT shared, and both spellings exist', () => {
    // The one intentional divergence, asserted so a later reader does not
    // "fix" it by collapsing the two into one.
    const receipt = read('receipt.ts');
    const self = read('self.ts');

    expect(receipt).toMatch(/export function buildSaveRequest\b/);
    expect(self).toMatch(/export function buildBoundarySaveRequest\b/);
    // The boundary request must not simply delegate to the mid-phase one.
    expect(self).not.toMatch(/buildSaveRequest\(/);
  });
});
