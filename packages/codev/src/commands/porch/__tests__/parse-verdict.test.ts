import { describe, it, expect } from 'vitest';
import { parseVerdict } from '../verdict';

describe('parseVerdict', () => {
  it('returns REQUEST_CHANGES for empty output', () => {
    expect(parseVerdict('')).toBe('REQUEST_CHANGES');
  });

  it('returns REQUEST_CHANGES for short output', () => {
    expect(parseVerdict('ok')).toBe('REQUEST_CHANGES');
  });

  it('parses APPROVE verdict', () => {
    const output = `Some review text here that is long enough to pass the minimum length check.

---
VERDICT: APPROVE
SUMMARY: Looks good
CONFIDENCE: HIGH
---
KEY_ISSUES: None`;
    expect(parseVerdict(output)).toBe('APPROVE');
  });

  it('parses REQUEST_CHANGES verdict', () => {
    const output = `Review text that is long enough to pass the minimum length threshold for parsing.

---
VERDICT: REQUEST_CHANGES
SUMMARY: Missing tests
CONFIDENCE: HIGH
---
KEY_ISSUES:
- No unit tests`;
    expect(parseVerdict(output)).toBe('REQUEST_CHANGES');
  });

  it('parses COMMENT verdict', () => {
    const output = `Review text that is long enough to pass the minimum length threshold for parsing.

---
VERDICT: COMMENT
SUMMARY: Minor suggestions
CONFIDENCE: MEDIUM
---`;
    expect(parseVerdict(output)).toBe('COMMENT');
  });

  it('handles markdown-formatted verdict', () => {
    const output = `Review text that is long enough to pass the minimum length threshold for parsing.

**VERDICT: APPROVE**
**SUMMARY: All good**`;
    expect(parseVerdict(output)).toBe('APPROVE');
  });

  it('ignores template text with brackets and uses actual verdict', () => {
    // This is the actual bug: codex CLI echoes the prompt template which contains
    // "VERDICT: [APPROVE | REQUEST_CHANGES | COMMENT]" before the real verdict.
    const output = `Review Implementation for Project 88

End your review with a verdict in this EXACT format:

---
VERDICT: [APPROVE | REQUEST_CHANGES | COMMENT]
SUMMARY: [One-line summary of your review]
CONFIDENCE: [HIGH | MEDIUM | LOW]
---

KEY_ISSUES: [List of critical issues if any, or "None"]

OpenAI Codex v0.63.0 (research preview)
model: gpt-5.1-codex

The implementation looks correct. PORCH_VERSION is exported from version.ts
and imported in run.ts. The test verifies semver format.

---
VERDICT: APPROVE
SUMMARY: Version constant, status output, and tests all align with the spec/plan.
CONFIDENCE: HIGH
---
KEY_ISSUES: None`;
    expect(parseVerdict(output)).toBe('APPROVE');
  });

  it('ignores template text echoed TWICE by codex and uses actual verdict', () => {
    // Codex sometimes echoes the template twice (prompt + reasoning)
    const output = `VERDICT: [APPROVE | REQUEST_CHANGES | COMMENT]
SUMMARY: [One-line summary]

Some reasoning here about REQUEST_CHANGES patterns...

VERDICT: [APPROVE | REQUEST_CHANGES | COMMENT]
SUMMARY: [One-line summary]

Actual review content that mentions REQUEST_CHANGES in discussion but the real verdict is below.

---
VERDICT: APPROVE
SUMMARY: All good
CONFIDENCE: HIGH
---`;
    expect(parseVerdict(output)).toBe('APPROVE');
  });

  it('last verdict wins when multiple non-template verdicts exist', () => {
    const output = `First pass review - this is long enough to pass the minimum length check for verdict parsing.

VERDICT: REQUEST_CHANGES

After addressing feedback:

VERDICT: APPROVE`;
    expect(parseVerdict(output)).toBe('APPROVE');
  });

  it('returns SKIPPED when no verdict is found in a long output (ran but no verdict)', () => {
    // Previously this fell back to COMMENT, which counts as an APPROVING
    // reviewer — so a lane that went off-task or emitted garbage silently
    // passed the gate (entriq #2467). SKIPPED = not a review: non-blocking
    // for the other lanes, but never counted as approval.
    const output = `Review text that is long enough to pass the minimum length threshold for parsing.
But it does not contain any VERDICT: line because the reviewer went off-task or didn't write one.`;
    expect(parseVerdict(output)).toBe('SKIPPED');
  });

  it('parses explicit SKIPPED verdict', () => {
    const output = `---
VERDICT: SKIPPED
SUMMARY: Gemini lane skipped — agy CLI not found
CONFIDENCE: LOW
---

The reviewer was skipped; no review was produced.`;
    expect(parseVerdict(output)).toBe('SKIPPED');
  });

  it('reinterprets a legacy skip stub (VERDICT: COMMENT + skip SUMMARY marker) as SKIPPED', () => {
    const output = `---
VERDICT: COMMENT
SUMMARY: Gemini lane skipped — authentication required (OAuth)
CONFIDENCE: LOW
---

The Gemini (Antigravity \`agy\`) reviewer was skipped: authentication required (OAuth).
This is a non-blocking skip; the remaining reviewers still apply.`;
    expect(parseVerdict(output)).toBe('SKIPPED');
  });

  it('does NOT reinterpret a real COMMENT review that merely mentions a skipped lane', () => {
    const output = `Review text long enough for the threshold. Note: an unrelated CI lane skipped a job.

---
VERDICT: COMMENT
SUMMARY: Minor suggestions only
CONFIDENCE: MEDIUM
---`;
    expect(parseVerdict(output)).toBe('COMMENT');
  });

  it('does NOT reinterpret an explicit REQUEST_CHANGES even if a skip marker appears', () => {
    const output = `Review text long enough for the threshold.

---
VERDICT: REQUEST_CHANGES
SUMMARY: Gemini lane skipped — but an earlier pass found real issues
CONFIDENCE: HIGH
---`;
    expect(parseVerdict(output)).toBe('REQUEST_CHANGES');
  });
});
