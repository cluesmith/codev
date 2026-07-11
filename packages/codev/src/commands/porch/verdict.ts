/**
 * Verdict parsing for porch consultation reviews.
 *
 * Extracted from run.ts so it can be shared by next.ts.
 */

import type { Verdict, ReviewResult } from './types.js';

/**
 * Marker line emitted by consult's lane-skip artifacts (see agySkipContent in
 * consult/index.ts): `SUMMARY: <Lane> lane skipped — <reason>`. Detected
 * independently of the VERDICT line so legacy skip stubs that shipped with
 * `VERDICT: COMMENT` are still recognized as SKIPPED, not as a passing review.
 */
const SKIP_SUMMARY_MARKER = /^SUMMARY:.*\blane skipped\b/im;

/**
 * Parse verdict from consultation output.
 *
 * Looks for the verdict line in format:
 *   VERDICT: APPROVE
 *   VERDICT: REQUEST_CHANGES
 *   VERDICT: COMMENT
 *   VERDICT: SKIPPED
 *
 * Also handles markdown formatting like:
 *   **VERDICT: APPROVE**
 *   *VERDICT: APPROVE*
 *
 * A lane that did not actually review parses as SKIPPED, never as a passing
 * verdict. That covers three shapes:
 *   - an explicit `VERDICT: SKIPPED` artifact,
 *   - a legacy skip stub (`VERDICT: COMMENT` + the skip SUMMARY marker),
 *   - output with no VERDICT line at all (the consult ran but produced no
 *     parseable review).
 * SKIPPED is non-blocking for progression but excluded from approval math —
 * see allApprove. Previously the no-verdict fallback returned COMMENT, which
 * counted as an approving reviewer; a skip stub nearly passed a defective
 * money-critical spec through a gate that way (entriq #2467).
 *
 * Empty or near-empty output still means the consult itself failed —
 * REQUEST_CHANGES, so a crashed lane gets retried rather than skipped.
 */
export function parseVerdict(output: string): Verdict {
  // Empty or very short output = something went wrong
  if (!output || output.trim().length < 50) {
    return 'REQUEST_CHANGES';
  }

  // Scan lines LAST→FIRST so the actual verdict (at the end) takes priority
  // over template text echoed by codex CLI at the start of output.
  // Skip template lines containing "[" (e.g., "VERDICT: [APPROVE | REQUEST_CHANGES | COMMENT]")
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    // Strip markdown formatting (**, *, __, _, `) and trim
    const stripped = lines[i].trim().replace(/^[\*_`-]+|[\*_`-]+$/g, '').trim().toUpperCase();
    // Match "VERDICT: <value>" but NOT template "VERDICT: [APPROVE | ...]"
    if (stripped.startsWith('VERDICT:') && !stripped.includes('[')) {
      const value = stripped.substring('VERDICT:'.length).trim();
      if (value.startsWith('SKIPPED')) return 'SKIPPED';
      if (value.startsWith('REQUEST_CHANGES')) return 'REQUEST_CHANGES';
      if (value.startsWith('APPROVE')) return 'APPROVE';
      if (value.startsWith('COMMENT')) {
        // Legacy skip stubs said `VERDICT: COMMENT`; the skip SUMMARY marker is
        // authoritative for those. Only COMMENT is reinterpreted — an explicit
        // APPROVE/REQUEST_CHANGES stays what it says.
        return SKIP_SUMMARY_MARKER.test(output) ? 'SKIPPED' : 'COMMENT';
      }
    }
  }

  // No valid VERDICT: line found — the lane produced no parseable review.
  // SKIPPED: does not block the other reviewers, does not count as approval.
  return 'SKIPPED';
}

/**
 * The reviews that actually happened: everything except lane skips.
 */
export function effectiveReviews(reviews: ReviewResult[]): ReviewResult[] {
  return reviews.filter(r => r.verdict !== 'SKIPPED');
}

/**
 * Check if all reviewers approved (unanimity required).
 *
 * Returns true only if ALL reviewers explicitly APPROVE.
 * COMMENT counts as approve (non-blocking feedback).
 * CONSULT_ERROR and REQUEST_CHANGES block approval.
 *
 * SKIPPED lanes are excluded: a skip neither approves nor blocks, so a phase
 * still advances on the strength of the remaining reviewers (the Spec 778
 * progression guarantee). But if EVERY lane skipped, no review happened at
 * all, and a verify gate must not pass on zero evidence.
 */
export function allApprove(reviews: ReviewResult[]): boolean {
  if (reviews.length === 0) return true; // No verification = auto-approve
  const effective = effectiveReviews(reviews);
  if (effective.length === 0) return false; // Every lane skipped = zero real reviews
  return effective.every(r => r.verdict === 'APPROVE' || r.verdict === 'COMMENT');
}
