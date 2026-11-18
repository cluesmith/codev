/**
 * Issue #1922 — the predicate that decides whether launchers.windows.test.ts may stop
 * the Tower on 4100. Getting it wrong stops the developer's live Tower.
 */
import { describe, it, expect } from 'vitest';
import { holdsOnlyOwnTower } from './helpers/tower-ownership.js';

describe('holdsOnlyOwnTower (#1922)', () => {
  it('refuses when the listener query failed', () => {
    expect(holdsOnlyOwnTower(null, [100])).toBe(false);
  });

  it('refuses when nothing is listening', () => {
    expect(holdsOnlyOwnTower([], [100])).toBe(false);
  });

  it('refuses when any listener is not the Tower this file started', () => {
    expect(holdsOnlyOwnTower([29272], [100])).toBe(false);
    expect(holdsOnlyOwnTower([100, 29272], [100])).toBe(false);
  });

  it('refuses when this file recorded no Tower of its own', () => {
    expect(holdsOnlyOwnTower([29272], [])).toBe(false);
  });

  it('allows the stop when the port is held exactly by its own Tower', () => {
    expect(holdsOnlyOwnTower([100], [100])).toBe(true);
    expect(holdsOnlyOwnTower([100, 101], [100, 101])).toBe(true);
  });
});
