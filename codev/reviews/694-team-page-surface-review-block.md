# Review: Team page — surface review-blocking relationships

## Summary

Added a new "Review blocking" section to each member card on Tower's team tab that renders human-readable sentences like *"You're waiting for Waleed to review #688"* (on the author's card) and *"Amr is waiting for you to review #688"* (on the reviewer's card). Four plan phases delivered in one builder session. PR #695 open against `main`.

## Spec Compliance

- [x] AC: Sentences render in the form "`<Author>` is waiting for `<Reviewer>` to review `<PR link>`" (second-person variant on subject's own card) (Phase 3)
- [x] AC: Each relationship appears on both author and reviewer cards (Phase 2 derivation + Phase 3 rendering)
- [x] AC: Only `codev/team/people/*.md` members generate sentences; external and Team reviewers skipped (Phase 2)
- [x] AC: `APPROVED`, draft, and "no team reviewer" PRs do not appear (Phase 2)
- [x] AC: Empty section omitted entirely (Phase 3)
- [x] AC: Existing team tab data unchanged (verified by running unchanged activityFeed test suite)
- [x] AC: Unit tests cover all 12 spec test scenarios (Phase 2)
- [x] AC: Documentation updated — arch.md cites spec 694 alongside 587 (Phase 4)
- [x] AC: `pnpm build`, type-check, and `npm test` all pass
- [x] AC: VS Code extension compiles unchanged (additive wire-type field)

## Deviations from Plan

- **Phase 4 docs**: `codev/resources/commands/team.md` documents the team **CLI**, not the Tower UI, so no edit was made there. Only `codev/resources/arch.md` was updated (citation bump). Documented in the PR body.
- **Phase 3 manual browser test**: Not executed in-session. Unit and E2E coverage stands in; manual walkthrough is listed as a test-plan item on the PR.
- **Porch state bug**: The porch state machine got stuck in an `implement → implement` loop because `plan_phases` was never populated from the plan's JSON block (root cause unclear; project 494 shows the same symptom). Worked around by creating the PR manually after unanimous consultation approval. See Follow-up Items.

## Key Metrics

- **Commits**: 9 human-authored commits + 15 porch state commits on the branch (ahead of main by 24).
- **Tests**:
  - `team-github.test.ts`: **33** (was 18; +15 for `deriveReviewBlocking`, extended query, and end-to-end parser)
  - `activityFeed.test.ts`: **12** (was 8; +4 for `relativeAge`)
  - Full codev suite: **2537 passing, 13 skipped, 0 failing** (`npm test --exclude='**/e2e/**'`)
  - New Playwright test added to `team-tab.test.ts`: contract assertion + mocked render
- **Files created**: `codev/specs/694-*.md`, `codev/plans/694-*.md`, `codev/reviews/694-*.md`, 9 consultation output `.txt` files in `codev/projects/694-*/`.
- **Files modified**:
  - `packages/types/src/api.ts`, `packages/types/src/index.ts`
  - `packages/codev/src/lib/team-github.ts`
  - `packages/codev/src/__tests__/team-github.test.ts`
  - `packages/codev/src/agent-farm/__tests__/e2e/team-tab.test.ts`
  - `packages/dashboard/src/components/TeamView.tsx`
  - `packages/dashboard/src/index.css`
  - `packages/dashboard/src/lib/api.ts`
  - `packages/dashboard/__tests__/activityFeed.test.ts`
  - `codev/resources/arch.md`
- **Files deleted**: none
- **Net LOC impact (non-artifact code + tests)**: approximately +700 / -10 lines across the above.

## Timelog

All times PT, 2026-04-21 evening.

| Time | Event |
|------|-------|
| 19:57 | Builder spawned (`porch init` commit pre-existed) |
| 19:58 | First spec draft committed |
| 20:03 | 3-way spec consultation complete (Gemini/Codex/Claude all APPROVE/COMMENT HIGH) |
| 20:05 | Spec revision with consultation feedback committed |
| 20:07 | Initial implementation plan committed |
| 20:13 | 3-way plan consultation complete (all HIGH confidence) |
| 20:14 | Plan revision committed |
| 20:16 | Phase 1 (wire type) committed |
| 20:19 | Phase 2 (query + parser + unit tests) committed |
| 20:22 | Phase 3 (dashboard UI + CSS) committed |
| 20:23 | Phase 4 (E2E + relativeAge tests + arch.md) committed |
| 20:27 | 3-way implementation consultation complete (Gemini APPROVE, Codex COMMENT, Claude APPROVE, all HIGH/MEDIUM confidence) |
| 20:29 | Polish commit addressing consultation feedback |
| 20:35 | Porch state-machine diagnosed as stuck; architect notified |
| 20:36 | PR #695 created |

### Autonomous Operation

| Period | Duration | Activity |
|--------|----------|----------|
| Spec + Plan | ~17 min | Two artifacts with one consultation round each |
| Implementation → PR | ~22 min | Four plan phases + impl consultation + polish + PR creation |
| Porch debugging | ~10 min | State-machine investigation after implement wouldn't advance |

**Total wall clock** (first commit → PR created): **~38 min**
**Context window resets**: 0.

## Consultation Iteration Summary

9 consultation files produced (3 rounds × 3 models). **All unanimous pass** in one round per phase: **7 APPROVE, 2 COMMENT, 0 REQUEST_CHANGES**.

| Phase | Iters | Who Blocked | What They Caught |
|-------|-------|-------------|------------------|
| Specify | 1 | — (unanimous pass) | Codex requested pagination + `Team` reviewer clarifications; Claude called out VS Code extension consumer & duplicate type; Gemini called out missing `createdAt` and server-side name resolution |
| Plan | 1 | — (unanimous pass) | Codex flagged incorrect package name (`codev-core` → `codev-types`), `activityFeed.test.ts` fixture updates, harness doesn't mock `/api/team`; Claude echoed the E2E harness point and suggested `relativeAge` unit tests |
| Implement | 1 | — (unanimous pass) | Codex + Claude flagged E2E test could skip when team tab disabled (→ mocked `/api/state`); Codex suggested `gh.reviewBlocking ?? []` guard |

**Most frequent blocker**: None — no reviewer required a second iteration. Codex consistently raised the most specific nits (package names, file paths), which is the pattern expected from a codebase-focused reviewer.

### Avoidable Iterations

None — every phase passed on the first review round. Feedback in every phase was additive polish, not blocking.

## Consultation Feedback

### Specify Phase (Round 1)

#### Gemini (APPROVE, HIGH)
- **Concern**: Missing `createdAt` in the query — needed for age sorting/label.
  - **Addressed**: Added `createdAt` to the plan's Approach 1 description and solution approach.
- **Concern**: Two-pass derivation needed to distribute to both author and reviewer.
  - **Addressed**: Spec's Approach 1 was rewritten to describe the two-pass distribution explicitly.
- **Concern**: Server-side display-name resolution avoids UI roster lookups.
  - **Addressed**: Spec's Rendering section now states names are resolved server-side; entry shape carries `otherName`.

#### Codex (COMMENT, HIGH)
- **Concern**: Missing explicit `reviewRequests(first: N)` pagination.
  - **Addressed**: Added `first: 20` explicitly and noted the existing 20-PR-per-author cap.
- **Concern**: Empty-state behavior is ambiguous ("omit" vs "show empty state").
  - **Addressed**: Spec now resolves the open question — section is omitted when empty.
- **Concern**: Vague documentation targets.
  - **Addressed**: Named `codev/resources/arch.md` and `codev/resources/commands/team.md` in success criteria.
- **Concern**: Missing test scenario for `CHANGES_REQUESTED` with another pending reviewer.
  - **Addressed**: Added test scenario 10.

#### Claude (APPROVE, HIGH)
- **Concern**: VS Code extension is an unlisted wire-type consumer.
  - **Addressed**: Added `packages/vscode/src/views/team.ts` to dependencies as out-of-scope (additive change remains compatible).
- **Concern**: `TeamMemberGitHubData` is duplicated in `packages/types` and `packages/codev/src/lib/team-github.ts`.
  - **Addressed**: Added to constraints and plan Phase 1 deliverables.

### Plan Phase (Round 1)

#### Gemini (APPROVE, HIGH)
- **Concern**: Plan claims E2E harness already stubs `/api/team` — it doesn't.
  - **Addressed**: Plan Phase 4 corrected; builder uses `page.route()` to inject the mock.

#### Codex (COMMENT, HIGH)
- **Concern**: `@cluesmith/codev-core build` referenced, but canonical type lives in `@cluesmith/codev-types`.
  - **Addressed**: Phase 1 acceptance criteria corrected.
- **Concern**: `activityFeed.test.ts` fixtures must include the new required `reviewBlocking` field.
  - **Addressed**: Phase 1 now explicitly lists the fixture updates.
- **Concern**: Contract E2E test should assert `reviewBlocking` exists.
  - **Addressed**: Phase 4 deliverable added.
- **Concern**: Display-name fallback framing — `loadTeamMembers()` already skips members without a `name`.
  - **Addressed**: Phase 2 reframed as defensive-only.

#### Claude (APPROVE, HIGH)
- **Concern**: Suggest adding 2-3 `relativeAge` unit tests.
  - **Addressed**: Added to Phase 4 deliverables and implemented.

### Implement Phase (Round 1)

#### Gemini (APPROVE, HIGH)
- No concerns — approved as-is.

#### Codex (COMMENT, MEDIUM)
- **Concern**: E2E render test says it intercepts state but only mocks `/api/team`; could skip in CI without teamEnabled.
  - **Addressed**: Added `page.route('**/api/state', …)` that patches `teamEnabled: true`; replaced `test.skip` with `await expect(teamTab).toBeVisible()`.
- **Concern**: `gh.reviewBlocking` assumed present in TeamView.
  - **Addressed**: Added `?? []` guard for additive/backward compatibility.

#### Claude (APPROVE, HIGH)
- **Concern**: Same as Codex on the `/api/state` mock.
  - **Addressed**: Same fix as above.

## Lessons Learned

### What Went Well
- **Pure-function derivation**: Extracting `deriveReviewBlocking(prsByAuthor, members)` as a pure function (accepting pre-parsed PR nodes, returning a Map) made the 12 spec scenarios trivially testable without any GraphQL mocking. Every scenario is a 5-10 line test.
- **Server-side name resolution**: Pre-resolving `otherName` on the server eliminated cross-member roster lookups in the UI and made the wire contract self-describing.
- **Additive wire-type change**: Adding `reviewBlocking` as a required field (not optional) meant the parser always emits an array, so the UI never has to distinguish `undefined` from `[]`. The VS Code consumer still compiles cleanly because it doesn't reference the new field.
- **First-round consultation pass in every phase**: Because the spec and plan were already thorough and the three reviewers flagged non-overlapping concerns, every phase advanced on a single round.

### Challenges Encountered
- **Porch state-machine loop**: After the 3-way implementation consultation completed with unanimous approval, `porch next` kept returning the initial implement tasks and `porch done` kept creating alternating `build-complete` and `phase-transition` commits without actually advancing to review. Root cause: `plan_phases` was never populated from the plan's JSON block during the plan→implement transition, so the `implement.transition.on_complete: "implement"` (intended for the multi-phase case) loops back to itself forever. Resolution: bypass porch and create the PR directly; escalate the bug to the architect.
- **Local-install dependency build order**: The dashboard type-check initially failed because `@cluesmith/codev-core` and `@cluesmith/codev-types` hadn't been built, so the `dist/*.d.ts` files were missing. Resolution: `pnpm --filter @cluesmith/codev-core build && pnpm --filter @cluesmith/codev-types build` before re-running type-check.

### What Would Be Done Differently
- **Check `plan_phases` is populated** before signalling build-complete during implement. A builder check like `grep -q 'plan_phases: \[\]' status.yaml && echo WARNING` would have surfaced the porch bug sooner and let me escalate before wasting cycles.
- **Verify porch's plan-phase extraction on a dry run** — the plan's JSON block parses cleanly with `python3 -c 'import json; json.load(…)'`, so the porch-side extractor has a bug or is called at the wrong time.

## Architecture Updates

- Updated `codev/resources/arch.md` line 595: `TeamView.tsx` now cites spec 694 alongside spec 587 and lists "review-blocking" in the feature inventory.
- No other architecture surface changes — this is a data-layer + UI addition on top of the existing team-tab infrastructure.

## Lessons Learned Updates

No global `lessons-learned.md` additions — the lessons captured here are project-specific. One cross-cutting lesson is the porch state bug, which belongs in a porch-focused review rather than the general lessons file.

## Technical Debt

- **Duplicate `TeamMemberGitHubData` type** remains in two places (`packages/types/src/api.ts` canonical + `packages/codev/src/lib/team-github.ts` internal). Spec 694 did not introduce this duplication but required keeping them in sync. Consolidating them is a follow-up (not blocking).
- **No cap on visible review-blocking entries**. For members with many stale PRs, cards could grow tall. A `+N more` pattern is noted in the spec's Risks and Mitigation as a possible follow-up.

## Follow-up Items

1. **Porch `plan_phases` extraction bug** (high priority): ASPIR projects appear to have `plan_phases: []` in `status.yaml` even when the plan's JSON block is well-formed. This breaks the `on_all_phases_complete → review` transition. Affects this project and project 494 (likely others).
2. **VS Code extension parity**: The extension reads `TeamApiResponse` but won't surface review-blocking relationships in the tree view. Explicitly out of scope for #694 — file a follow-up if desired.
3. **Team-aggregate header on the team tab**: "Team has N review-blocking relationships" — mentioned in the spec's Nice-to-Know open questions.
4. **GraphQL complexity telemetry**: The spec lists a 500,000-point complexity budget as a known risk. If team size grows past ~15, add an instrumentation point around the batched query.
