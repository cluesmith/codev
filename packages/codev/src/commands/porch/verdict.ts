/**
 * Verdict parsing for porch consultation reviews.
 *
 * Extracted from run.ts so it can be shared by next.ts.
 */

import type { Verdict, ReviewResult } from './types.js';

/**
 * Parse verdict from consultation output.
 *
 * Looks for the verdict line in format:
 *   VERDICT: APPROVE
 *   VERDICT: REQUEST_CHANGES
 *   VERDICT: COMMENT
 *
 * Also handles markdown formatting like:
 *   **VERDICT: APPROVE**
 *   *VERDICT: APPROVE*
 *
 * Safety: If no explicit verdict found (empty output, crash, malformed),
 * defaults to REQUEST_CHANGES to prevent proceeding with unverified code.
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
      if (value.startsWith('REQUEST_CHANGES')) return 'REQUEST_CHANGES';
      if (value.startsWith('APPROVE')) return 'APPROVE';
      if (value.startsWith('COMMENT')) return 'COMMENT';
    }
  }

  // No valid VERDICT: line found — default to REQUEST_CHANGES for safety
  return 'REQUEST_CHANGES';
}

/**
 * Check if all reviewers approved (unanimity required).
 *
 * Returns true only if ALL reviewers explicitly APPROVE.
 * COMMENT counts as approve (non-blocking feedback).
 * CONSULT_ERROR and REQUEST_CHANGES block approval.
 */
export function allApprove(reviews: ReviewResult[]): boolean {
  if (reviews.length === 0) return true; // No verification = auto-approve
  return reviews.every(r => r.verdict === 'APPROVE' || r.verdict === 'COMMENT');
}

