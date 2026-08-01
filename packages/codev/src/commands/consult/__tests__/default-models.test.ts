import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  computeCodexCost,
} from '../index.js';

/**
 * Guard rail for the shipped consult lane defaults (#1288).
 *
 * These ids were live-probed before being adopted; a drive-by "correction"
 * (most likely dropping the unusual `-sol` suffix, which Codex rejects on a
 * ChatGPT account) must fail here rather than silently landing. Changing a
 * default is legitimate — but it has to be a deliberate edit to this file too,
 * accompanied by a fresh live probe.
 *
 * CI-safe: no network, no model CLIs, no API calls.
 */
describe('shipped consult lane defaults', () => {
  it('pins the claude lane to claude-opus-5', () => {
    expect(DEFAULT_CLAUDE_MODEL).toBe('claude-opus-5');
  });

  it('pins the codex lane to gpt-5.6-sol at medium reasoning effort', () => {
    // The `-sol` suffix is load-bearing: plain `gpt-5.6` and `gpt-5.6-codex`
    // are both rejected by Codex with a ChatGPT account.
    expect(DEFAULT_CODEX_MODEL).toBe('gpt-5.6-sol');
    expect(DEFAULT_CODEX_REASONING_EFFORT).toBe('medium');
  });
});

describe('computeCodexCost', () => {
  it('prices the default codex model at published gpt-5.6-sol rates', () => {
    // 1M uncached input @ $5.00 + 1M cached input @ $0.50 + 1M output @ $30.00
    const cost = computeCodexCost(DEFAULT_CODEX_MODEL, 2_000_000, 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(35.5, 6);
  });

  it('discounts cached input tokens', () => {
    const allUncached = computeCodexCost(DEFAULT_CODEX_MODEL, 1_000_000, 0, 0);
    const allCached = computeCodexCost(DEFAULT_CODEX_MODEL, 1_000_000, 1_000_000, 0);
    expect(allUncached).toBeCloseTo(5.0, 6);
    expect(allCached).toBeCloseTo(0.5, 6);
  });

  it('returns null for a model with no published rates on file', () => {
    // Rather than billing an unknown model at another model's rates — a
    // confidently wrong number is worse than none.
    expect(computeCodexCost('gpt-5.4', 100_000, 0, 10_000)).toBeNull();
    expect(computeCodexCost('some-future-model', 100_000, 0, 10_000)).toBeNull();
  });
});
