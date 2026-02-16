---
approved: 2026-02-15
validated: [architect]
---

# Spec 0121: Rebuttal-Based Review Advancement

## Problem

With `max_iterations=1`, porch runs 3-way consultations (Gemini + Codex + Claude) but the builder never reads the feedback. We pay for 3 API calls per phase that produce reviews nobody acts on. The reviews are captured in files but porch force-advances regardless, so the feedback is wasted.

The core issue: **the consultation produces feedback**, but **nothing forces the builder to engage with it**.

## Solution

Replace the build-verify-iterate loop with a **build-verify-rebuttal** flow:

1. Builder creates artifact (spec, plan, code)
2. Porch runs 3-way consultation (unchanged)
3. If all approve: advance immediately (unchanged)
4. If any request changes: **builder writes a rebuttal file**
5. Porch sees rebuttal exists: **advance immediately** (no second consultation)

The rebuttal file is proof the builder engaged with the feedback. It may contain:
- Acknowledgment of valid points and what was changed
- Reasoned disagreement with specific feedback
- Explanation of why certain suggestions don't apply

## Detailed Design

### Rebuttal File Convention

Rebuttal files follow the existing naming pattern:

```
codev/projects/<id>-<name>/<id>-<phase>-iter<N>-rebuttals.md
```

This convention already exists — builders already write rebuttal files. The change is making porch recognize them as an advancement signal.

### Porch Flow Change

Current flow in `next.ts` (simplified):

```
reviews come in → allApprove? → yes → advance
                               no  → iteration >= max? → yes → force-advance
                                                         no  → increment iter, emit fix tasks
```

New flow:

```
reviews come in → allApprove? → yes → advance
                               no  → rebuttal exists? → yes → advance (record reviews + rebuttal in history)
                                                         no  → emit "write rebuttal" task
```

The `max_iterations` config stays at 1 — the rebuttal replaces the iteration loop entirely. One consultation round, then advance via approval or rebuttal.

### What Porch Emits When Reviews Request Changes

Instead of emitting a "fix issues" task, porch emits a "write rebuttal" task:

```
Subject: "Write rebuttal for review feedback (iteration 1)"
Description:
  Reviews requested changes. Read the feedback and write a rebuttal.

  Review files:
  - 0121-specify-iter1-gemini.txt (APPROVE)
  - 0121-specify-iter1-codex.txt (REQUEST_CHANGES)
  - 0121-specify-iter1-claude.txt (APPROVE)

  Write your rebuttal to:
    codev/projects/0121-rebuttal-based-review-advancement/0121-specify-iter1-rebuttals.md

  In the rebuttal:
  - Address each REQUEST_CHANGES point
  - Note what you changed (if anything)
  - Explain why you disagree (if applicable)

  Then run: porch done 0121
```

### Detection Logic

When `porch next` or `porch done` runs after reviews are in and at least one is REQUEST_CHANGES:

1. Look for rebuttal file matching pattern: `<id>-<phase>-iter<N>-rebuttals.md`
2. If found: **advance**
3. If not found: emit "write rebuttal" task

### What Changes

| File | Change |
|------|--------|
| `packages/codev/src/commands/porch/next.ts` | After reviews come in with REQUEST_CHANGES, check for rebuttal file before incrementing iteration. If rebuttal exists, call `handleVerifyApproved()`. If not, emit "write rebuttal" task instead of "fix issues" task. |
| `packages/codev/src/commands/porch/next.ts` | The "fix issues" code path (lines ~523-560) becomes the "write rebuttal" code path. Builder is told to write rebuttal, not to revise the artifact. |
| `codev/protocols/spir/protocol.json` | No change — `max_iterations` stays at 1 |
| `codev-skeleton/protocols/spir/protocol.json` | No change — `max_iterations` stays at 1 |

### What Does NOT Change

- Consultation execution (3-way parallel review) — unchanged
- `allApprove()` fast path — if all approve, advance immediately as before
- Review file naming/format — unchanged
- Rebuttal file naming/format — already exists, unchanged
- The builder still MAY revise the artifact before writing the rebuttal (that's their choice)
- Gate approval flow — unchanged

## Success Criteria

1. When reviews come back with REQUEST_CHANGES, porch emits a "write rebuttal" task
2. When builder writes a rebuttal file, `porch done` advances past the review
3. No second consultation round runs after the rebuttal
4. If all 3 reviewers APPROVE, porch advances immediately (no rebuttal needed)
5. Existing tests updated, new tests for rebuttal detection
