import { describe, it, expect } from 'vitest';

// Intentional failure for CI channel smoke test (throwaway branch test/ci-channel-smoke).
// This file should never reach main — the branch is deleted after verifying the alert.
describe('ci-channel smoke', () => {
  it('intentionally fails to trigger a CI alert', () => {
    expect(1).toBe(2);
  });
});
