/**
 * The tripwire must never be the thing that breaks a consultation (#1649).
 *
 * It wraps every lane, so a throw inside it takes a working review down with it.
 * That is not hypothetical: the first cut of this module assumed `execFileSync`
 * returns a string, and twenty gemini-lane tests in `consult.test.ts` — a suite
 * that stubs `node:child_process` — failed with `raw.split is not a function`
 * before the lane had run at all.
 *
 * Lives in its own file because it needs `node:child_process` mocked at module
 * scope, while every other tripwire test needs the real git.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  // The shape a careless stub returns: a mock with no implementation.
  execFileSync: vi.fn(),
}));

const { snapshotTree } = await import('../tree-tripwire.js');

describe('snapshotTree with a stubbed child_process', () => {
  it('reports the snapshot unavailable instead of throwing', () => {
    const snap = snapshotTree('/anywhere');
    expect(snap.available).toBe(false);
    expect(snap.reason).toContain('not text');
    expect(snap.entries.size).toBe(0);
  });
});
