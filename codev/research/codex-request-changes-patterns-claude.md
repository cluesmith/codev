# Investigation Report: Universal Codex REQUEST_CHANGES Patterns

**Investigator**: Claude (Consultant role)
**Protocol**: RESEARCH Phase 2 (Investigate)
**Issue**: #753
**Files covered**: 71 of 73 rebuttal files (2 files in project 671 confirmed empty — no Codex content)
**Projects covered**: 22 distinct projects

---

## 1. Executive Summary

### Top 8 Universal Patterns Codex Correctly Flags

1. **Spec completeness gaps** — Codex consistently catches missing default values, unspecified error behaviors, and undefined edge cases in specifications. (~30 objections across 7+ projects)
2. **Missing test coverage for specific code paths** — Codex identifies untested lifecycle, reconnect, and error paths that the builder missed. (~15 objections across 6+ projects)
3. **Input validation gaps** — Empty strings, NaN parsing, mutual exclusivity of flags, truthiness vs strict checks. (~10 objections across 5 projects)
4. **Incomplete removal/migration sweeps** — When code or concepts are removed, Codex systematically finds leftover references the builder missed. (~10 objections across 4 projects)
5. **Resource lifecycle bugs** — Orphaned processes on partial failure, missing close-event cleanup, dead sessions never removed from maps. (~12 objections across 3 projects)
6. **API/interface contract mismatches** — Implementation data shapes diverging from spec/plan interface definitions. (~8 objections across 4 projects)
7. **Documentation-reality misalignment** — Catches when documentation claims don't match actual system behavior. (~8 objections across 4 projects)
8. **Security hardening** — Shell injection vectors, file permission enforcement, safety constraint gaps. (~5 objections across 3 projects)

### Top 7 Universal False-Alarm Categories

1. **Demanding Playwright/E2E tests from builders in worktrees** — Codex requests Playwright tests without understanding that builders can't run them from isolated worktrees (no Tower running). (4 projects)
2. **"Tests don't exercise the actual handler" for thin orchestrators** — Codex flags contract-style testing as insufficient when handlers are thin wrappers over already-tested primitives. (4 projects)
3. **Misreading porch pending-gate semantics as "incomplete"** — Codex flags pending human-approval gates or porch-managed status.yaml state as deliverable gaps. (3 projects)
4. **Re-raising already-rebutted concerns across iterations/phases** — Codex repeats the same objection even after the builder provided a valid rebuttal in a prior iteration. (4 projects)
5. **Scope-creeping beyond explicitly bounded spec/plan** — Codex requests features or coverage the spec explicitly excluded or deferred. (4 projects)
6. **Flagging missing code that exists outside the diff** — Codex only sees the diff and misses existing tests, pre-existing code, or files not yet staged. (3 projects)
7. **Treating intentional design deviations as spec violations** — When a builder makes a deliberate improvement over the spec's literal wording, Codex flags it as non-compliant without evaluating merit. (4 projects)

### Overall Classification Rate

Across ~199 deduplicated Codex objections in 71 rebuttal files:
- **(a) Genuinely actionable**: ~123 (62%) — Codex caught a real problem
- **(b) Pre-addressed / spec-plan clarity issue**: ~36 (18%) — concern was valid but spec/plan already covered it
- **(c) Hallucinated / out-of-context**: ~40 (20%) — Codex was wrong; builder correctly rebutted

The architect's prior estimate of ~24% false-positive rate aligns closely with the 20% category-(c) rate. When (b) items are included as "not a Codex error but not useful either," the combined noise rate is ~38%.

---

## 2. Detailed Patterns (Codex Correctly Flags)

### Pattern 1: Spec Completeness Gaps — Missing Defaults, Edge Cases, Error Behaviors

**Actionable rule**: "For every field in your response/data types, specify the default value when the source is unavailable. For every external dependency (API, CLI tool, database), specify behavior when it fails. For every user-facing format (timestamps, paths, durations), specify the exact display format."

**Evidence** (7 distinct projects):
- `456-specify-iter1-rebuttals.md` — Missing default error values for every field (accepted), time range semantics undefined (accepted), PR-to-project mapping edge cases (accepted), missing testing strategy (accepted). 4/4 Codex objections accepted.
- `467-specify-iter1-rebuttals.md` — Missing path base definition (accepted), idle time display format (accepted), status indicator specifics (accepted), fallback behavior for absent lastDataAt (accepted), test split unclear (accepted). 5/5 accepted.
- `469-specify-iter1-rebuttals.md` — No deterministic decision algorithm (accepted), missing PR context handling (accepted), no behavior when `gh` unavailable (accepted). 3/4 accepted.
- `0126-specify-iter1-rebuttals.md` — PR-to-issue linkage rules undefined (accepted), label defaults (accepted), testing strategy missing (accepted), error handling for `gh` auth (accepted). 4/6 accepted.
- `446-specify-iter1-rebuttals.md` — JSON output on error (accepted), scaffold skip counting (accepted), stderr in dry-run (accepted), version source ambiguity (accepted), --force reporting (accepted). 5/6 accepted.
- `723-specify-iter1-rebuttals.md` — Factual error about directory existence (accepted), fuzzy triggering criteria (accepted), weak deliverables (accepted), overbroad test scope (accepted), safety constraint missing (accepted). 5/5 accepted.
- `653-specify-iter0-rebuttals.md` — Ownership contradictory (accepted), terminal-state terminology wrong (accepted), cold-start underspecified (accepted), skip reason required (accepted), dependency decision unresolved (accepted). 5/9 accepted.

**Why it generalizes**: Specifications are inherently forward-looking documents written before implementation details are known. Codex's training on large codebases gives it exposure to the kinds of edge cases that surface during implementation. Its spec reviews have an ~85% acceptance rate because it asks "what happens when X fails?" for concrete X values that spec authors overlook.

---

### Pattern 2: Missing Test Coverage for Specific Code Paths

**Actionable rule**: "For every new code path (error handler, reconnect flow, cleanup on failure, permission check), explicitly list the test that covers it in the plan. If no test is listed, Codex will flag it — and it's usually right."

**Evidence** (6 distinct projects):
- `0104-phase_2-iter1-rebuttals.md` — Missing createSession/killSession integration tests (accepted, shared with Gemini)
- `0104-phase_2-iter6-rebuttals.md` — Missing integration tests for stop/reconnect/replay cycle (accepted)
- `0118-phase_1-iter2/iter3-rebuttals.md` — Backpressure test doesn't exercise `socket.write() === false` path (accepted after two iterations)
- `587-auto_updates-iter1-rebuttals.md` — Spawn event detection regex broken (accepted)
- `456-api_endpoint-iter1-rebuttals.md` — Missing endpoint unit tests (accepted)
- `653-verify_phase-iter1-rebuttals.md` — Missing tests for verify gate auto-request and state migration (accepted)

**Why it generalizes**: Builders focus on making the happy path work; they add tests for what they built, not for what could go wrong. Codex systematically checks for path coverage in a way that complements the builder's implementation focus.

---

### Pattern 3: Input Validation Gaps

**Actionable rule**: "Validate all CLI flag values: check for NaN on numeric flags, empty strings on name inputs, mutual exclusivity of conflicting flags, and use strict equality (`!== undefined`) instead of truthiness for optional flags."

**Evidence** (5 distinct projects):
- `653-pr_tracking_and_worktree-iter1-rebuttals.md` — Flag parsing too permissive (NaN, missing values), truthiness checks, mutual exclusivity of --pr/--merged. All 3 accepted.
- `587-review-iter1-rebuttals.md` — `detectAuthor()` can return empty string. Accepted.
- `587-backend_api-iter1-rebuttals.md` — GraphQL aliases starting with digits produce invalid queries. Accepted.
- `468-phase_3-iter1-rebuttals.md` — Empty-name handling missing in rename command. Accepted.
- `469-specify-iter1-rebuttals.md` — No behavior specified when `gh` CLI unavailable. Accepted.

**Why it generalizes**: Input validation is systematically under-prioritized in implementation because builders test with valid inputs. Codex's mechanical checking finds these gaps because it evaluates each parameter against its type signature.

---

### Pattern 4: Incomplete Removal/Migration Sweeps

**Actionable rule**: "When removing a concept, protocol, or renaming a term, generate a comprehensive grep list of all references BEFORE starting. Include: source files, test files, documentation, templates/skeleton, CLI flag registrations, and type definitions. Codex will find the ones you miss."

**Evidence** (4 distinct projects):
- `653-tick_removal-iter1-rebuttals.md` — CLAUDE.md/AGENTS.md still reference TICK (accepted), skeleton templates still reference TICK (accepted), spawn.ts --amends logic still present (accepted), cli.ts --amends flag still registered (accepted). 4/5 objections were real missed references.
- `653-review-iter1-rebuttals.md` — TICK in types.ts still present. Accepted.
- `422-review-iter1-rebuttals.md` — Tower diagram uses stale `projectPath` labels (accepted), `/api/stop` doc claims stale params (accepted), residual "project" in invariant (accepted). 3/3 accepted.
- `438-documentation-iter1-rebuttals.md` — CLAUDE.md/AGENTS.md ASPIR sections not identical (accepted), wording says "auto-approved" instead of "removed" (accepted). 2/2 accepted.

**Why it generalizes**: Removal is a search problem. Builders search the obvious places but miss secondary references in docs, templates, CLI registration, and type definitions. Codex's ability to scan the full diff surface makes it good at catching stragglers.

---

### Pattern 5: Resource Lifecycle Bugs

**Actionable rule**: "For every resource that is created (process, socket, session, connection), explicitly trace: (1) what happens on partial creation failure, (2) what happens on unexpected termination, (3) what happens during shutdown, (4) what happens on reconnection. Codex catches missing cleanup in all four categories."

**Evidence** (3 distinct projects):
- `0104-phase_2-iter1-rebuttals.md` — cleanupStaleSockets deletes live sockets (accepted)
- `0104-phase_2-iter2-rebuttals.md` — createSession leaks orphaned shepherds on partial failure (accepted), error emission crashes Tower (accepted), restart timer bypasses maxRestarts (accepted)
- `0104-phase_2-iter3-rebuttals.md` — Dead sessions never removed from map on natural exit (accepted)
- `0104-phase_2-iter4-rebuttals.md` — Missing close-event handling for crash cleanup (accepted)
- `0104-phase_2-iter6-rebuttals.md` — shutdown() kills shepherds instead of disconnecting (accepted)
- `0116-plan-iter2-rebuttals.md` — Multiple lifecycle cleanup concerns across 7 iterations (mixed: some accepted, some hallucinated about workspace deactivation)
- `587-review-iter1-rebuttals.md` — Gate approval false positives from mtime changes (accepted)

**Why it generalizes**: Process/session lifecycle management is inherently complex with many edge cases. The implementation focus is naturally on the happy path (create → use → destroy). Codex systematically checks the unhappy paths (create-fail, crash, reconnect).

---

### Pattern 6: API/Interface Contract Mismatches

**Actionable rule**: "When the plan specifies an interface type or response shape, verify the implementation returns exactly that shape. Check: field names match, nesting matches (flat vs nested), ID fields reference the correct source, numeric limits match between spec and implementation."

**Evidence** (4 distinct projects):
- `587-backend_api-iter1-rebuttals.md` — GraphQL variable substitution bug (accepted, all 3 reviewers caught), API response shape mismatch (accepted)
- `456-plan-iter1-rebuttals.md` — Cache key differs from spec (accepted), `--limit 500` conflicts with spec's 1000-item expectation (accepted)
- `468-phase_2-iter1-rebuttals.md` — Response `id` should match session ID from request path (accepted)
- `0104-phase_2-iter6-rebuttals.md` — Missing protocol version field in WELCOME frame (accepted)

**Why it generalizes**: Spec-to-implementation drift is natural as builders adapt to runtime constraints. Codex's ability to compare the plan's interface definition against the diff catches mechanical mismatches that human reviewers skip because they focus on behavior rather than shape.

---

### Pattern 7: Documentation-Reality Misalignment

**Actionable rule**: "After implementation, re-read every documentation claim you've written (arch.md, CLAUDE.md, template docs) and verify it matches what the code actually does. Codex catches stale references, incorrect propagation claims, and outdated parameter names."

**Evidence** (4 distinct projects):
- `723-review-iter1-rebuttals.md` — Documentation overstates template propagation behavior; `codev init` doesn't produce new templates as claimed (accepted)
- `422-review-iter1-rebuttals.md` — 3 stale terminology references in docs (all accepted)
- `438-documentation-iter1-rebuttals.md` — ASPIR docs use incorrect "auto-approved" language (accepted)
- `386-final_verification-iter1-rebuttals.md` — Release notes coverage claim inaccurate, INSTALL.md references stale (accepted)

**Why it generalizes**: Documentation drifts from code. When the builder modifies behavior, they update the code and immediate tests but forget to update prose docs, especially in secondary locations (skeleton templates, getting-started guides, architectural docs).

---

### Pattern 8: Security Hardening

**Actionable rule**: "For every shell command construction, use execFile with args array (never string interpolation). For every file/socket creation, set explicit permissions (0600/0700). For every tool/skill that runs commands, add explicit safety constraints on what it can do."

**Evidence** (3 distinct projects):
- `653-plan-iter1-rebuttals.md` — writeStateAndCommit uses shell string interpolation → shell injection risk. Builder switched to execFile with args array. (accepted)
- `0104-phase_2-iter7-rebuttals.md` — Socket file created without explicit permission enforcement (0600). Builder added chmodSync. (accepted)
- `723-specify-iter1-rebuttals.md` — Skill should be constrained to guidance only, no destructive commands. Builder added explicit constraint and output contract. (accepted)

**Why it generalizes**: Security is systematically deprioritized during feature development. Codex applies mechanical security patterns (parameterized commands, restrictive permissions, principle of least privilege) that catch real attack surfaces.

---

## 3. Detailed False Alarms

### FA1: Demanding Playwright/E2E Tests from Builders in Worktrees

**Why Codex falls for it**: Codex sees `playwright.config.ts` in the repo and 7 existing Playwright test files (in `src/agent-farm/__tests__/e2e/`), so it concludes Playwright tests are a reasonable expectation. What it doesn't understand is that Playwright tests require Tower to be running, and builders in isolated git worktrees don't have Tower available. The config exists, the tests exist — but they can't be authored or run from the builder's execution context.

**Evidence** (4 distinct projects):
- `0104-phase_3-iter1/iter2/iter3-rebuttals.md` — "Integration tests don't cover Tower behaviors" repeated 3 consecutive iterations despite the same rebuttal each time
- `0126-work_view-iter1-rebuttals.md` — "Missing Playwright tests" flagged; builder explains Tower infrastructure unavailable in worktree
- `467-frontend_component-iter1-rebuttals.md` — "Required component and Playwright tests missing"; React test runner not available, Playwright requires Tower
- `0112-plan-iter1-rebuttals.md` — "Playwright/E2E test scenarios needed for UI route changes"; excessive for a rename-only change

**Suggested prompt fragment**: "Playwright/E2E tests exist in this project but require Tower to be running. Builders work in isolated worktrees without Tower. Do not request new Playwright tests during implementation phases unless the plan explicitly lists them as a phase deliverable."

---

### FA2: "Tests Don't Exercise the Actual Handler" for Thin Orchestrators

**Why Codex falls for it**: Codex applies a generic test-coverage heuristic — "if there's a handler, there should be a test that calls it." It doesn't distinguish between handlers with complex logic (where direct testing is valuable) and thin orchestrators that merely wire together already-tested primitives (where contract-style testing of the primitives is sufficient and more maintainable).

**Evidence** (4 distinct projects):
- `468-phase_1/phase_2/phase_3/review-iter1-rebuttals.md` — "Tests don't exercise the actual rename handler" raised in ALL 4 phases. Handler requires mocking ~15 dependencies. Builder used contract-style testing. Gemini and Claude both approved.
- `587-frontend_tab-iter1-rebuttals.md` — "Missing unit tests for useTeam/TeamView." Project has zero frontend component unit tests; all dashboard testing uses E2E. Codex applied generic pattern without codebase-convention awareness.
- `386-tier_3_skeleton-iter1-rebuttals.md` — Template sync validation beyond the spec-required diff check.
- `653-status_commit_infra-iter1-rebuttals.md` — "Tests should mock git ops." Codebase lacks DI/module mocking infrastructure.

**Suggested prompt fragment**: "When handlers are thin orchestrators that wire together already-tested primitives, contract-style testing of those primitives is a valid testing strategy. Do not request direct handler tests if (a) the handler has many dependencies requiring extensive mocking, and (b) the underlying primitives are independently tested."

---

### FA3: Misreading Porch Pending-Gate Semantics as "Incomplete"

**Why Codex falls for it**: Codex sees `status.yaml` showing `phase: X, state: in_progress` or a pending gate, and interprets this as "the builder hasn't finished." In reality, pending gates are intentional — they're human-approval checkpoints. Similarly, `status.yaml` is managed by porch's state machine, not by the builder manually.

**Evidence** (3 distinct projects):
- `0124-phase_5-iter1-rebuttals.md` — "PR not created / gate pending." PR #312 already existed; pending gate is by design (awaiting human approval).
- `723-phase_2-iter1-rebuttals.md` — "status.yaml shows phase_2 in_progress / build_complete: false." Codex flagged porch-managed internal state as a deliverable gap. Builder correctly rebutted that status.yaml is managed by porch, not manually editable.
- `0117-review-iter1-rebuttals.md` — JSONL parsing failure caused porch to default to REQUEST_CHANGES when actual Codex verdict was APPROVE. (Tooling bug, but classified here because the effect was a false REQUEST_CHANGES.)

**Suggested prompt fragment**: "The `status.yaml` file and gate states are managed by porch (the protocol orchestrator), not by the builder. A pending gate means 'awaiting human approval,' not 'incomplete work.' Do not flag pending gates or in-progress status.yaml fields as deliverable gaps."

---

### FA4: Re-Raising Already-Rebutted Concerns

**Why Codex falls for it**: Each CMAP iteration provides Codex with the diff and the consultation prompt, but Codex does not reliably process "Previous Iteration Context" sections that explain why prior concerns were addressed or rebutted. It re-evaluates from scratch and re-discovers the same apparent issues.

**Evidence** (4 distinct projects):
- `0104-phase_3-iter1/iter2/iter3` — "tmux still in fallback" flagged in iter1 and iter2 despite plan explicitly defining dual-mode for Phase 3. "Integration tests don't cover Tower" flagged 3 consecutive iterations.
- `456-data_layer AND review-rebuttals.md` — `gh pr list` vs `gh search prs` concern raised in both data_layer phase AND review phase despite being thoroughly rebutted.
- `0126-github_integration/review/work_view` — "heading-only summary (no first paragraph)" raised across 3 phases despite the same rebuttal each time.
- `468-phase_1/phase_2/phase_3/review` — "contract-style tests" raised in all 4 phases.

**Suggested prompt fragment**: "If 'Previous Iteration Context' is provided, read it carefully. If a concern was already raised and rebutted in a prior iteration, do not re-raise it unless you have NEW evidence that the rebuttal was incorrect."

---

### FA5: Scope-Creeping Beyond Spec/Plan Boundaries

**Why Codex falls for it**: Codex evaluates completeness against its general understanding of what a feature "should" include, rather than against the explicit scope boundaries in the spec. It suggests additions (multi-repo support, full-paragraph summaries, skeleton template updates) that were deliberately excluded.

**Evidence** (4 distinct projects):
- `0126-specify-iter1-rebuttals.md` — Multi-repo/forks support requested for a single-repo tool. `/api/overview` security flagged for a localhost-only dashboard.
- `0126-github_integration-iter1-rebuttals.md` — Missing issue body/comments requested when phase deliverable was explicitly title-only summary.
- `0126-cleanup-iter1-rebuttals.md` — Skeleton files flagged when they're a distribution template not in this phase's scope.
- `653-specify-iter0-rebuttals.md` — Security section for standard defensive coding patterns that don't warrant spec-level treatment.

**Suggested prompt fragment**: "Before flagging missing functionality, check whether the spec or plan explicitly scopes it out or defers it. An 'Out of Scope' section is a deliberate boundary, not an oversight. Do not request features listed in out-of-scope sections."

---

### FA6: Flagging Missing Code That Exists Outside the Diff

**Why Codex falls for it**: Codex reviews the diff, not the full codebase. When tests or code exist in files that weren't modified, Codex doesn't see them and concludes they're missing. Similarly, when files haven't been staged yet (review fires before commit), Codex sees them as "untracked."

**Evidence** (3 distinct projects):
- `468-phase_1-iter1-rebuttals.md` — "No tests added." A 372-line test file (17 tests) already existed but wasn't in the diff. Claude independently verified.
- `467-backend_last_data_at-iter1-rebuttals.md` — "Missing unit tests for lastDataAt tracking." Tests already existed (`pty-last-data-at.test.ts` with 5 tests) but weren't in the diff.
- `723-phase_1-iter1-rebuttals.md` / `723-implement-phase_1-iter1-rebuttals.md` — "Skill files are still untracked." Review fired before the commit; builder hadn't staged yet.

**Suggested prompt fragment**: "You are reviewing a diff, not the full codebase. Before claiming tests or code are missing, consider that they may exist in files not modified by this change. The absence of a file from the diff does not mean it doesn't exist."

---

### FA7: Treating Intentional Design Deviations as Spec Violations

**Why Codex falls for it**: Codex performs a literal comparison between the spec's wording and the implementation's behavior. When a builder makes a deliberate improvement (using a better API, adding backward compatibility, choosing a more testable architecture), Codex flags the divergence without evaluating whether the deviation is an improvement.

**Evidence** (4 distinct projects):
- `456-data_layer-iter1-rebuttals.md` — `gh pr list --search` flagged as not matching spec's `gh search prs`. Both achieve the same result; the builder's approach has better repo scoping.
- `0118-phase_1-iter1-rebuttals.md` — `clientType || 'tower'` fallback flagged as violating "Required" spec. It's backward-compat defensive coding for rolling deployments.
- `0116-plan-iter2-rebuttals.md` — Terminal DELETE flagged as insufficient; Codex demanded workspace deactivation. But API-created terminals aren't workspace-associated, so workspace deactivation wouldn't clean them up.
- `468-phase_1-iter1-rebuttals.md` — Missing env var injection flagged. Builder correctly explained: injecting env vars into non-persistent sessions would create misleading UX.

**Suggested prompt fragment**: "When the implementation uses a different approach than the spec's literal wording, evaluate whether the deviation achieves the same outcome or is an improvement. Functional equivalence with better properties (testability, backward compat, error safety) is acceptable. Only flag deviations that lose functionality or violate intent."

---

## 4. Per-Rebuttal Coverage Table

| # | File Path | a | b | c | Notes |
|---|-----------|---|---|---|-------|
| 1 | `0104-*/0104-phase_2-iter1-rebuttals.md` | 3 | 0 | 1 | Migration approach disputed |
| 2 | `0104-*/0104-phase_2-iter2-rebuttals.md` | 3 | 0 | 0 | All genuine lifecycle bugs |
| 3 | `0104-*/0104-phase_2-iter3-rebuttals.md` | 1 | 0 | 0 | Dead session leak |
| 4 | `0104-*/0104-phase_2-iter4-rebuttals.md` | 1 | 0 | 0 | Close event handling |
| 5 | `0104-*/0104-phase_2-iter6-rebuttals.md` | 3 | 0 | 0 | Shutdown, versioning, tests |
| 6 | `0104-*/0104-phase_2-iter7-rebuttals.md` | 1 | 0 | 0 | Socket permissions |
| 7 | `0104-*/0104-phase_3-iter1-rebuttals.md` | 2 | 1 | 1 | tmux fallback (b), Tower tests (c) |
| 8 | `0104-*/0104-phase_3-iter2-rebuttals.md` | 0 | 1 | 1 | Repeats of iter1 concerns |
| 9 | `0104-*/0104-phase_3-iter3-rebuttals.md` | 1 | 0 | 1 | Kill paths (a), Tower tests repeat (c) |
| 10 | `0112-*/0112-plan-iter1-rebuttals.md` | 2 | 0 | 1 | Playwright excessive for rename (c) |
| 11 | `0116-*/0116-plan-iter2-rebuttals.md` | 0 | 0 | 1 | Workspace deactivation misapplied |
| 12 | `0117-*/0117-review-iter1-rebuttals.md` | 0 | 0 | 1 | JSONL parsing false positive |
| 13 | `0118-*/0118-phase_1-iter1-rebuttals.md` | 0 | 1 | 0 | clientType fallback = backward compat |
| 14 | `0118-*/0118-phase_1-iter2-rebuttals.md` | 1 | 0 | 0 | Backpressure test path |
| 15 | `0118-*/0118-phase_1-iter3-rebuttals.md` | 1 | 0 | 0 | Backpressure test (dedup w/ iter2) |
| 16 | `0120-*/0120-plan-iter2-rebuttals.md` | 0 | 1 | 1 | SDK limitation (c), stale text (b) |
| 17 | `0124-*/0124-phase_2-iter1-rebuttals.md` | 0 | 0 | 1 | Mischaracterized test purpose |
| 18 | `0124-*/0124-phase_3-iter1-rebuttals.md` | 0 | 1 | 0 | Plan estimate error |
| 19 | `0124-*/0124-phase_4-iter1-rebuttals.md` | 0 | 0 | 1 | Assumed overlap that didn't exist |
| 20 | `0124-*/0124-phase_5-iter1-rebuttals.md` | 0 | 1 | 2 | PR exists (c), no test evidence (c) |
| 21 | `0126-*/0126-specify-iter1-rebuttals.md` | 4 | 0 | 2 | Multi-repo (c), localhost security (c) |
| 22 | `0126-*/0126-github_integration-iter1-rebuttals.md` | 0 | 0 | 3 | All scope-creep or misreads |
| 23 | `0126-*/0126-work_view-iter1-rebuttals.md` | 2 | 2 | 0 | Backlog fix (a), Playwright (b) |
| 24 | `0126-*/0126-review-iter1-rebuttals.md` | 3 | 0 | 3 | Mixed: real fixes + re-litigations |
| 25 | `0126-*/0126-cleanup-iter1-rebuttals.md` | 1 | 0 | 2 | Skeleton out of scope (c) |
| 26 | `386-*/386-final_verification-iter1-rebuttals.md` | 2 | 1 | 1 | Auto-generated file (c) |
| 27 | `386-*/386-tier_2_developer-iter1-rebuttals.md` | 0 | 0 | 0 | Codex gave APPROVE |
| 28 | `386-*/386-tier_3_skeleton-iter1-rebuttals.md` | 0 | 0 | 1 | Intentional template difference |
| 29 | `403-*/403-message_buffering-iter1-rebuttals.md` | 2 | 0 | 1 | Double start (a), intentional behavior (c) |
| 30 | `422-*/422-review-iter1-rebuttals.md` | 3 | 0 | 0 | All stale terminology — real catches |
| 31 | `438-*/438-documentation-iter1-rebuttals.md` | 2 | 0 | 0 | ASPIR doc sync — both real |
| 32 | `446-*/446-specify-iter1-rebuttals.md` | 5 | 1 | 0 | Excellent spec review |
| 33 | `446-*/446-plan-iter1-rebuttals.md` | 4 | 1 | 0 | High-value plan review |
| 34 | `456-*/456-specify-iter1-rebuttals.md` | 4 | 0 | 0 | All accepted — spec gaps |
| 35 | `456-*/456-plan-iter1-rebuttals.md` | 4 | 0 | 0 | All accepted — plan gaps |
| 36 | `456-*/456-data_layer-iter1-rebuttals.md` | 1 | 0 | 3 | gh pr list (c), design intent (c) |
| 37 | `456-*/456-api_endpoint-iter1-rebuttals.md` | 1 | 0 | 0 | Missing endpoint tests |
| 38 | `456-*/456-dashboard_ui-iter1-rebuttals.md` | 1 | 0 | 0 | Duplicate fetch bug |
| 39 | `456-*/456-review-iter1-rebuttals.md` | 0 | 1 | 2 | Re-raised settled issues |
| 40 | `462-*/462-protocol_config-iter1-rebuttals.md` | 3 | 0 | 0 | Schema/config violations |
| 41 | `467-*/467-specify-iter1-rebuttals.md` | 5 | 0 | 0 | All accepted — spec gaps |
| 42 | `467-*/467-plan-iter1-rebuttals.md` | 2 | 0 | 0 | Path derivation, Playwright ref |
| 43 | `467-*/467-backend_last_data_at-iter1-rebuttals.md` | 0 | 1 | 0 | Tests existed outside diff |
| 44 | `467-*/467-frontend_component-iter1-rebuttals.md` | 1 | 2 | 1 | Idle duration misunderstanding (c) |
| 45 | `468-*/468-phase_1-iter1-rebuttals.md` | 0 | 0 | 2 | Env vars intentional (c), tests exist (c) |
| 46 | `468-*/468-phase_2-iter1-rebuttals.md` | 1 | 1 | 0 | Response ID (a), handler test (b) |
| 47 | `468-*/468-phase_3-iter1-rebuttals.md` | 2 | 1 | 0 | Empty name (a), error text (a) |
| 48 | `468-*/468-review-iter1-rebuttals.md` | 0 | 1 | 2 | Restart logic misread (c) |
| 49 | `469-*/469-specify-iter1-rebuttals.md` | 3 | 1 | 0 | Strong spec review |
| 50 | `469-*/469-plan-iter1-rebuttals.md` | 2 | 2 | 0 | Deliverable omission (a) |
| 51 | `587-*/587-af_team_cli-iter1-rebuttals.md` | 1 | 0 | 1 | CLI wiring tests unnecessary (c) |
| 52 | `587-*/587-auto_updates-iter1-rebuttals.md` | 2 | 0 | 0 | Regex bug + time window |
| 53 | `587-*/587-backend_api-iter1-rebuttals.md` | 4 | 0 | 0 | All genuine — GraphQL bugs |
| 54 | `587-*/587-frontend_tab-iter1-rebuttals.md` | 0 | 1 | 1 | No frontend unit tests (b), placement (c) |
| 55 | `587-*/587-review-iter1-rebuttals.md` | 2 | 1 | 0 | Real bugs + fragile test concern |
| 56 | `589-*/589-porch-protocol-migration-iter1-rebuttals.md` | — | — | — | Codex SKIPPED (architect instruction) |
| 57 | `589-*/589-team-doctor-docs-iter1-rebuttals.md` | — | — | — | Codex SKIPPED (architect instruction) |
| 58 | `653-*/653-specify-iter0-rebuttals.md` | 5 | 3 | 1 | Strong spec review |
| 59 | `653-*/653-plan-iter1-rebuttals.md` | 6 | 1 | 0 | Excellent plan review |
| 60 | `653-*/653-pr_exists_fix-iter1-rebuttals.md` | 2 | 1 | 0 | Forge script bugs |
| 61 | `653-*/653-pr_tracking_and_worktree-iter1-rebuttals.md` | 4 | 0 | 0 | All input validation |
| 62 | `653-*/653-status_commit_infra-iter1-rebuttals.md` | 1 | 1 | 0 | Dead code + mock concern |
| 63 | `653-*/653-tick_removal-iter1-rebuttals.md` | 4 | 1 | 0 | Leftover references |
| 64 | `653-*/653-verify_phase-iter1-rebuttals.md` | 3 | 1 | 0 | Workflow gaps |
| 65 | `653-*/653-review-iter1-rebuttals.md` | 3 | 1 | 1 | Sequencing bug + stale test (c) |
| 66 | `671-*/671-specify-iter1-rebuttals.md` | — | — | — | Empty file — no Codex content |
| 67 | `671-*/671-plan-iter1-rebuttals.md` | — | — | — | Empty file — no Codex content |
| 68 | `723-*/723-specify-iter1-rebuttals.md` | 5 | 0 | 0 | All accepted |
| 69 | `723-*/723-plan-iter1-rebuttals.md` | 3 | 0 | 0 | All accepted |
| 70 | `723-*/723-implement-phase_1-iter1-rebuttals.md` | 0 | 0 | 1 | Untracked before commit |
| 71 | `723-*/723-phase_1-iter1-rebuttals.md` | 0 | 0 | 1 | Duplicate of #70 |
| 72 | `723-*/723-phase_2-iter1-rebuttals.md` | 2 | 0 | 1 | status.yaml state misread (c) |
| 73 | `723-*/723-review-iter1-rebuttals.md` | 2 | 0 | 0 | Doc-reality alignment |

**Coverage summary**: 73 files listed. 67 files contain Codex objections that were classified. 4 files had Codex skipped or empty (589 x2, 671 x2). 1 file was an APPROVE (386-tier_2_developer). 1 file is a duplicate (723-implement-phase_1 = 723-phase_1).

---

## 5. Notes

### Ground-Truth Verifications

1. **Playwright/E2E infrastructure**: VERIFIED as existing.
   - `packages/codev/playwright.config.ts` exists and is configured (testDir: `./src/agent-farm/__tests__/e2e`)
   - 7 Playwright test files exist in `src/agent-farm/__tests__/e2e/`: `team-tab.test.ts`, `dashboard-terminals.test.ts`, `tower-cloud-connect.test.ts`, `terminal-controls.test.ts`, `dashboard-bugs.test.ts`, `work-view-backlog.test.ts`, `tower-integration.test.ts`
   - `package.json` has `"test:e2e:playwright": "pnpm exec playwright test"` script
   - **Conclusion**: The "no Playwright infrastructure" hypothesis is WRONG. Playwright is configured and has tests. The actual false alarm is that builders in worktrees can't RUN them because they require Tower.

2. **What consult-types already tell Codex**: The `impl-review.md` prompt (used by SPIR, ASPIR, and bugfix protocols) already includes a "CRITICAL: Verify Before Flagging" section that tells Codex to:
   - Check `package.json` for actual dependency versions
   - Read actual config files before flagging missing configs
   - Not assume training data reflects version in use
   - Read "Previous Iteration Context" before re-raising disputed concerns
   
   **Observation**: Despite this guidance, Codex still re-raises concerns (FA4) and flags based on assumptions (FA6). The guidance exists but is not sticking. This suggests the false-alarm prompt needs to be MORE specific and MORE assertive than the current generic guidance.

3. **Phase-review.md is identical to impl-review.md**: Confirmed. Both SPIR and ASPIR phase-review prompts are identical copies of the impl-review prompt.

### Surprises

1. **Codex's spec-review accuracy is remarkably high.** Across 7 spec-review files (456, 467, 469, 0126, 446, 723, 653), Codex's acceptance rate is ~85%. This is Codex's strongest mode by a wide margin.

2. **Codex's plan-review accuracy is also strong.** Across plan reviews (456, 467, 469, 446, 653, 723), acceptance rate is ~80%.

3. **Codex's implementation-review accuracy drops significantly.** During code review phases, the false-alarm rate roughly doubles compared to spec/plan phases. The primary failure modes are: not seeing the full codebase, demanding infrastructure-dependent tests, and re-litigating settled decisions.

4. **Codex's review-phase (final review) is the weakest.** Files like 456-review, 468-review, and 0126-review show Codex re-raising issues that were settled in prior phases. This is the highest-concentration of category (c) objections.

5. **The "Previous Iteration Context" guidance isn't working.** Despite the consult-type prompts explicitly saying "read Previous Iteration Context," Codex still repeats objections across iterations in 4 distinct projects. The guidance needs to be stronger.

6. **Project 0104 is an outlier.** Its 9 rebuttal files (7 iterations of phase_2 alone) represent an unusually deep session. Most of the lifecycle-bug patterns come from this single project. The pattern generalizes (other projects have similar bugs) but 0104 skews the frequency data.

### Confidence Calibration

- **High confidence** in the 8 genuine patterns — each is backed by 3+ diverse projects and the classification is clear from builder responses.
- **High confidence** in FA1-FA4 — these are the most persistent false alarms with clear structural explanations.
- **Medium confidence** in FA5-FA7 — these are real patterns but less frequent (3 projects each, borderline threshold).
- **The overall 62/18/20 split should be treated as approximate** — some borderline calls between (a) and (b), and between (b) and (c), could shift the numbers by ±3%.

### Gaps

- I could not access PR diffs (no shell execution). Classification relied on rebuttal text, spec/plan context, and builder explanations. For most files this is sufficient; for a few implementation-phase files, seeing the actual diff would have helped disambiguate.
- Projects 589 (2 files) had Codex explicitly skipped by the architect. Projects 671 (2 files) were empty. These 4 files are excluded from analysis.
- The 0116 project had extensive iteration history (7 iterations mentioned in the rebuttal summary) but only 1 rebuttal file was committed to main (iter2). Earlier iterations may have been cleaned up.
