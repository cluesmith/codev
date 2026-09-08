/**
 * #1645: ForgeRateLimiter — what may set and clear a per-budget suspension.
 */

import { describe, it, expect } from 'vitest';
import { ForgeRateLimiter, budgetKeyFor, isRateLimitError, SUSPENSION_FALLBACK_MS } from '../lib/forge-rate-limit.js';

const GRAPHQL = 'gh: API rate limit already exceeded for user ID 1';

describe('ForgeRateLimiter (#1645)', () => {
  it('recognises GitHub rate-limit errors and nothing else', () => {
    expect(isRateLimitError(GRAPHQL)).toBe(true);
    expect(isRateLimitError('{"errors":[{"type":"RATE_LIMITED"}]}')).toBe(true);
    expect(isRateLimitError('You have exceeded a secondary rate limit')).toBe(true);
    expect(isRateLimitError('no git remotes found')).toBe(false);
    expect(isRateLimitError('gh: command not found')).toBe(false);
  });

  it('keys gh REST concepts on their own budget; other backends are one budget', () => {
    expect(budgetKeyFor('gh', 'user-identity')).toBe('gh:rest');
    expect(budgetKeyFor('GH', 'pr-list')).toBe('gh');
    expect(budgetKeyFor('linear', 'user-identity')).toBe('linear');
  });

  it('suspends only on a rate-limit error, for the fallback window, without a probe', () => {
    const limiter = new ForgeRateLimiter();
    expect(limiter.noteFailure('gh', 'gh', '/ws', 'no git remotes found', 1000)).toBe(false);
    expect(limiter.isSuspended('gh', 1000)).toBe(false);
    expect(limiter.noteFailure('gh', 'gh', '/ws', GRAPHQL, 1000)).toBe(true);
    expect(limiter.isSuspended('gh', 1000)).toBe(true);
    expect(limiter.resetAt('gh', 1000)).toBe(1000 + SUSPENSION_FALLBACK_MS);
    expect(limiter.isSuspended('gh', 1000 + SUSPENSION_FALLBACK_MS)).toBe(false);
  });

  it('a success from the same tick as the suspension does not clear it; a later one does', () => {
    const limiter = new ForgeRateLimiter();
    limiter.noteFailure('gh', 'gh', '/ws', GRAPHQL, 5000);
    limiter.noteSuccess('gh', 5000);
    expect(limiter.isSuspended('gh', 5001)).toBe(true);
    limiter.noteSuccess('gh', 4000);
    expect(limiter.isSuspended('gh', 5001)).toBe(true);
    limiter.noteSuccess('gh', 5001);
    expect(limiter.isSuspended('gh', 5002)).toBe(false);
  });

  it('a success on another budget never clears this one', () => {
    const limiter = new ForgeRateLimiter();
    limiter.noteFailure('gh', 'gh', '/ws', GRAPHQL, 1000);
    limiter.noteSuccess('gh:rest', 9000);
    expect(limiter.isSuspended('gh', 9001)).toBe(true);
  });

  it('runs the probe once per fresh suspension and only for gh', async () => {
    const calls: string[] = [];
    const limiter = new ForgeRateLimiter(async (backend) => { calls.push(backend); return null; });
    limiter.noteFailure('gh', 'gh', '/ws', GRAPHQL, 1000);
    limiter.noteFailure('gh', 'gh', '/ws', GRAPHQL, 1001);
    limiter.noteFailure('glab', 'glab', '/ws', GRAPHQL, 1002);
    await new Promise(r => setTimeout(r, 0));
    expect(calls).toEqual(['gh']);
  });
});
