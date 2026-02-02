import { describe, it, expect } from 'vitest';
import { parseVerdict } from '../run';

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
});
