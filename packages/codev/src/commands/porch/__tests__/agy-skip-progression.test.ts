import { describe, it, expect } from 'vitest';
import { parseVerdict, allApprove, effectiveReviews } from '../verdict';
import { _agySkipContent } from '../../consult/index.js';
import type { ReviewResult } from '../types.js';

/**
 * Phase-progression guarantee for the agy backend (Spec 778), hardened per
 * entriq #2467.
 *
 * When the Antigravity CLI (`agy`) is missing, unauthenticated, or times out, the
 * gemini consult lane emits a skip artifact instead of failing the run. Porch
 * parses that artifact as SKIPPED: non-blocking (a SPIR/ASPIR/BUGFIX phase still
 * advances on the strength of the remaining reviewers) but NEVER counted as an
 * approving review — the original stub carried VERDICT: COMMENT, which counts as
 * approval, so a lane that never ran masqueraded as a passing third reviewer.
 * These tests pin the contract end-to-end against the REAL skip artifact, so a
 * regression in either the artifact wording or the verdict parser is caught.
 */
describe('agy skip parses as SKIPPED and is non-blocking for porch progression', () => {
  const skipReasons = [
    'agy CLI not found',
    'authentication required (OAuth)',
    'no response before timeout',
  ];

  for (const reason of skipReasons) {
    it(`real skip artifact (${reason}) parses as SKIPPED, never as a review verdict`, () => {
      expect(parseVerdict(_agySkipContent(reason))).toBe('SKIPPED');
    });
  }

  it('legacy skip stubs (VERDICT: COMMENT + skip SUMMARY marker) also parse as SKIPPED', () => {
    // Artifacts written by older consult versions still on disk / older installs.
    const legacy = _agySkipContent('agy CLI not found').replace('VERDICT: SKIPPED', 'VERDICT: COMMENT');
    expect(parseVerdict(legacy)).toBe('SKIPPED');
  });

  it('a 3-way phase with gemini skipped still passes (2-way effective)', () => {
    const reviews: ReviewResult[] = [
      { model: 'gemini', verdict: parseVerdict(_agySkipContent('agy CLI not found')), file: '/tmp/g.md' },
      { model: 'codex', verdict: 'APPROVE', file: '/tmp/c.md' },
      { model: 'claude', verdict: 'APPROVE', file: '/tmp/cl.md' },
    ];
    expect(reviews[0].verdict).toBe('SKIPPED');
    expect(effectiveReviews(reviews)).toHaveLength(2);
    expect(allApprove(reviews)).toBe(true);
  });

  it('the skip does NOT mask a genuine REQUEST_CHANGES from another reviewer', () => {
    const reviews: ReviewResult[] = [
      { model: 'gemini', verdict: parseVerdict(_agySkipContent('agy CLI not found')), file: '/tmp/g.md' },
      { model: 'codex', verdict: 'REQUEST_CHANGES', file: '/tmp/c.md' },
      { model: 'claude', verdict: 'APPROVE', file: '/tmp/cl.md' },
    ];
    expect(allApprove(reviews)).toBe(false);
  });

  it('a skip never counts as the approving vote: skip + APPROVE advances on the real review alone', () => {
    // The entriq #2467 shape: with the old COMMENT stub this was recorded as a
    // 2-approval round when only ONE review actually happened.
    const reviews: ReviewResult[] = [
      { model: 'gemini', verdict: parseVerdict(_agySkipContent('agy CLI not found')), file: '/tmp/g.md' },
      { model: 'claude', verdict: 'APPROVE', file: '/tmp/cl.md' },
    ];
    expect(effectiveReviews(reviews)).toHaveLength(1);
    expect(allApprove(reviews)).toBe(true);
  });

  it('ALL lanes skipped = zero real reviews = the gate must NOT pass', () => {
    const reviews: ReviewResult[] = [
      { model: 'gemini', verdict: parseVerdict(_agySkipContent('agy CLI not found')), file: '/tmp/g.md' },
      { model: 'codex', verdict: parseVerdict(_agySkipContent('no response before timeout')), file: '/tmp/c.md' },
    ];
    expect(effectiveReviews(reviews)).toHaveLength(0);
    expect(allApprove(reviews)).toBe(false);
  });

  it('skip artifact is self-describing (names the lane, the non-run, and the remediation)', () => {
    const content = _agySkipContent('authentication required');
    expect(content).toMatch(/Gemini lane skipped/);
    expect(content).toMatch(/No review was/);
    expect(content).toMatch(/antigravity\.google/);
  });
});
