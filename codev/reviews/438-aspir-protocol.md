# Review: ASPIR Protocol — Autonomous SPIR

## Summary

Implemented the ASPIR protocol as a complete copy of SPIR with the `spec-approval` and `plan-approval` gates removed. The protocol is available in both the skeleton (for other projects) and the codev instance (for our own use). Documentation updated across all four required files.

Total implementation: 25 new files created across `codev-skeleton/protocols/aspir/` (15 files) and `codev/protocols/aspir/` (10 files), plus documentation updates to 4 existing files (root CLAUDE.md, root AGENTS.md, skeleton templates CLAUDE.md and AGENTS.md).

No changes to SPIR files, porch source code, or protocol schema.

## Spec Compliance

- [x] ASPIR protocol directory exists at `codev-skeleton/protocols/aspir/` (15 files)
- [x] ASPIR protocol directory exists at `codev/protocols/aspir/` (10 files)
- [x] `protocol.json` has `"name": "aspir"`, no `alias`, `"version": "1.0.0"`
- [x] `protocol.json` has no `gate` property on the `specify` phase
- [x] `protocol.json` has no `gate` property on the `plan` phase
- [x] `protocol.json` retains `"gate": "pr"` on the `review` phase
- [x] All phases, checks, and verify blocks identical to SPIR (except gate removal)
- [x] `af spawn N --protocol aspir` discovers the protocol (filesystem-based discovery)
- [x] `protocol.md` documents the protocol and when to use it
- [x] ASPIR added to Protocol Selection Guide in `CLAUDE.md` and `AGENTS.md`
- [x] ASPIR added to Available Protocols in skeleton templates
- [x] No changes to SPIR protocol files (verified via `git diff`)
- [x] No changes to porch source code
- [x] No changes to `protocol-schema.json`
- [x] Build passes, all tests pass

## Deviations from Plan

- **Phase 3 documentation wording**: The plan suggested specific bullet points for the CLAUDE.md/AGENTS.md ASPIR section. During implementation, the root CLAUDE.md was written first with slightly different wording than what was later applied to AGENTS.md. Consultation reviewers caught the desync, and CLAUDE.md was updated to match AGENTS.md (the more technically accurate version using "removed" instead of "auto-approved").

## Lessons Learned

### What Went Well
- **Protocol-as-data works**: The entire ASPIR protocol was implemented without touching a single line of porch source code. Filesystem-based protocol discovery and the `gate` property model made this purely a file-copy exercise.
- **3-way consultation caught a real issue**: All three reviewers independently flagged the CLAUDE.md/AGENTS.md content desync in Phase 3 — an issue that would have shipped if not caught.
- **Phased plan was well-suited**: Separating skeleton and instance into distinct phases was correct, since they have different file structures and different protocol.json contents.
- **File-count verification approach**: Verifying byte-identity of copied files against SPIR originals provided high confidence in correctness.

### Challenges Encountered
- **`consult` multi-project detection**: The `consult` CLI fails when `codev/projects/` has multiple directories, because the project auto-detection finds all of them. Workaround: used `--prompt-file` general mode. The `--project-id` flag exists but didn't resolve the issue for protocol-mode consultations.
- **Gemini unavailability**: Gemini returned 503 on every consultation attempt throughout the session. Created placeholder SKIPPED files with rebuttals explaining the unavailability. Both Codex and Claude provided thorough reviews.
- **Context loss**: The session ran out of context during Phase 3, requiring a session continuation. The summary mechanism preserved all critical state.

### What Would Be Done Differently
- **Verify consult compatibility before starting**: Would test `consult` in protocol mode early to avoid the multi-project workaround for every phase.
- **Use consistent wording from the start**: The CLAUDE.md/AGENTS.md content divergence could have been avoided by writing the text once and applying it to both files.

### Methodology Improvements
- The `consult` CLI should support `--project-id` in protocol mode to disambiguate when multiple project directories exist in `codev/projects/`. This is a recurring issue for builder worktrees that inherit project directories from main.

## Technical Debt
- **File duplication**: ASPIR's prompts, templates, and consult-types are copies of SPIR's. Changes to SPIR must be manually propagated. Consider a MAINTAIN task to periodically check for drift.
- **consult multi-project bug**: The `--project-id` flag doesn't fully work for protocol-mode consultations. Filed as a known issue.

## Consultation Feedback

### Specify Phase (Round 1)

#### Gemini
- Unavailable (503)

#### Codex
- **Concern**: Success criteria and tests use inconsistent phase names for consultations
  - **Addressed**: Clarified consultation phase names to match SPIR's actual verify types (spec, plan, impl, pr)
- **Concern**: Gateless auto-transition assumption needs evidence
  - **Addressed**: Cited source evidence from `getPhaseGate()` in `state.ts` and `next.ts` auto-advance logic
- **Concern**: Exact files to copy not enumerated
  - **Addressed**: Added complete per-file checklists for both skeleton (15 files) and instance (10 files)

#### Claude
- No concerns raised (APPROVE with HIGH confidence)

### Plan Phase (Round 1)

#### Gemini
- Unavailable (503)

#### Codex
- **Concern**: File inventory wrong — missing `phase-review.md` and `templates/plan.md`
  - **Addressed**: Added both files to the plan, corrected counts to 15 (skeleton) and 10 (instance)
- **Concern**: `protocol.md` rewrite and version/alias changes may violate "exact copy"
  - **Rebutted**: The spec explicitly calls for these changes (Section: Solution Approaches, protocol.json modifications)

#### Claude
- **Concern**: `consult-types/phase-review.md` missing from plan
  - **Addressed**: Added to both plan phases
- **Concern**: `templates/plan.md` incorrectly stated as missing from `codev/protocols/spir/`
  - **Addressed**: Corrected — the file exists and was added to Phase 2 deliverables
- **Concern**: Skeleton doc paths wrong (`codev-skeleton/CLAUDE.md` vs `codev-skeleton/templates/CLAUDE.md`)
  - **Addressed**: Corrected paths in Phase 3 deliverables

### Implement Phase — skeleton_protocol (Round 1)

#### Gemini
- Unavailable (503). Created SKIPPED placeholder.
  - **Rebutted**: Both Codex and Claude approved with HIGH confidence, zero issues found.

#### Codex
- No concerns raised (APPROVE with HIGH confidence)

#### Claude
- No concerns raised (APPROVE with HIGH confidence). Non-blocking observation: protocol.md documents files that only exist in skeleton, not the protocol directory itself — accepted as expected behavior.

### Implement Phase — instance_protocol (Round 1)

#### Gemini
- Unavailable (503). Created SKIPPED placeholder.
  - **Rebutted**: Both Codex and Claude approved with HIGH confidence, zero issues found.

#### Codex
- No concerns raised (APPROVE with HIGH confidence)

#### Claude
- No concerns raised (APPROVE with HIGH confidence)

### Implement Phase — documentation (Round 1)

#### Gemini
- **Concern**: CLAUDE.md and AGENTS.md ASPIR sections have divergent content
  - **Addressed**: Synced CLAUDE.md to match AGENTS.md

#### Codex
- **Concern**: CLAUDE.md and AGENTS.md not identical (violates sync requirement)
  - **Addressed**: Synced CLAUDE.md to match AGENTS.md
- **Concern**: CLAUDE.md says gates are "auto-approved" which contradicts protocol.json (gates are absent)
  - **Addressed**: Changed wording to "removed" to match the technical reality

#### Claude
- **Concern**: Root CLAUDE.md and AGENTS.md out of sync
  - **Addressed**: Synced CLAUDE.md to match AGENTS.md (the more technically accurate version)

## Flaky Tests
No flaky tests encountered.

## Architecture Updates

No architecture updates needed. ASPIR is a protocol definition (file-only, no code changes). The arch.md glossary already lists protocols generically. The existing protocol sections (SPIR, TICK, BUGFIX) describe protocols that have code implications; ASPIR is just SPIR with different config and doesn't warrant its own architecture section.

One minor update: the Glossary mentions "Protocol" with example list `(SPIR, TICK, BUGFIX, MAINTAIN, EXPERIMENT, RELEASE)` — ASPIR could be added but this is cosmetic and the list is already labeled as examples, not exhaustive.

## Lessons Learned Updates

Added entry to `codev/resources/lessons-learned.md`:

- **Documentation section**: The `consult` CLI multi-project issue was already documented in the lessons file (from specs 0386/0399/0403). No new entry needed — the existing entry already captures this exact issue.

No new generalizable lessons beyond what's already captured. The key patterns (file-based protocol discovery, full-copy approach, CLAUDE.md/AGENTS.md sync requirement) are well-established in the lessons file.

## Follow-up Items
- Consider a MAINTAIN task to periodically check ASPIR/SPIR prompt drift
- Fix `consult --project-id` for protocol-mode consultations in builder worktrees
