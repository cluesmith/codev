# Codex REQUEST_CHANGES Patterns: Universal Tips + False-Alarm Map

> **Status**: Synthesis (Phase 3/4). Final critique-phase changes appear at end.
> **Source brief**: [codex-request-changes-patterns-brief.md](codex-request-changes-patterns-brief.md)
> **Companion deliverable**: [codex-false-alarm-prompt.md](codex-false-alarm-prompt.md)
> **Source issue**: [#753](https://github.com/cluesmith/codev/issues/753)

---

## Scope summary

We have **71 Codex-containing rebuttal files** across **21 distinct projects** (corpus has 23 project directories total; project 671 contains no Codex content in its 2 rebuttal files, and project 589 had Codex skipped by architect instruction). These document `REQUEST_CHANGES` verdicts Codex issued during CMAP cycles. Two questions, one synthesis:

1. **Universal patterns Codex flags correctly** — recurring, *generalizable* objections we can pre-empt by writing tighter specs/plans up front. (This file.)
2. **Universal patterns Codex consistently false-alarms on** — categories where Codex is reliably wrong because of a structural limitation, fed into a drop-in prompt fragment Codex sees on every consult. ([codex-false-alarm-prompt.md](codex-false-alarm-prompt.md).)

Three investigators (Gemini 3 Pro, Codex/GPT-5.4, Claude Opus 4.7) each read all 71 rebuttals plus the corresponding specs/plans (PR diffs were dropped — investigators lack shell). Findings below are organized by topic, with model-consensus flagged.

**In scope**: 71 Codex-containing rebuttals under `codev/projects/*/`, the consult-type prompts Codex already receives, and the current repo state for ground-truth checking.
**Out of scope**: direct-merge PRs without CMAP rebuttals, rebuttals filed since `bugfix-742` that were never committed to main, Gemini/Claude REQUEST_CHANGES patterns.

---

## Executive summary

- Across **71 rebuttal files** containing **~195–199 deduplicated Codex objections**, the genuinely-actionable rate is **~61–62%**, false-alarm (category c) rate is **~20–36%**, and the gap is "pre-addressed but builder failed to defend" (b: ~3–18% depending on classifier strictness).
- **Codex's strongest mode is spec/plan review** (~80–85% acceptance), where it systematically surfaces missing defaults, error semantics, and edge cases that spec authors overlook. This is the highest-leverage place to harvest its signal.
- **Codex's weakest mode is final-review / late-iteration code review**, where it re-litigates settled concerns, demands tests it can't see (outside-diff blindness), and misreads orchestration state. ~half of all (c) objections concentrate here.
- **The most durable false alarm is "demand Playwright/E2E"** — Playwright **does** exist in this repo (verified: 7 test files under `packages/codev/src/agent-farm/__tests__/e2e/`, `playwright.config.ts`, `test:e2e:playwright` script). The structural problem is that builders in isolated worktrees **can't run Tower**, so they can't author new E2E tests during the implementation phase. Codex sees the framework, demands tests, doesn't model the runtime constraint.
- **The current `impl-review.md` already tells Codex to "Verify Before Flagging"** and to read "Previous Iteration Context" — and it isn't sticking. The false-alarm prompt needs to be **more assertive and more specific** than the existing generic guidance.

---

## TL;DR — top 8 tips for architects and builders

These are the highest-frequency, highest-generalizability patterns Codex correctly flags. Pre-empting them at spec/plan time avoids the iteration.

1. **Specify defaults, nullability, fail-fast/degraded behavior, and input-validation handling for every new field, flag, parser, or external dependency.** [Consensus — Codex, Gemini, Claude; input-validation sub-bullet from Claude] — Codex's #1 spec-review move. Sub-checklist for validation surfaces: empty strings, NaN, mutual exclusivity of conflicting flags, strict-equality vs truthiness, behavior on unknown values.
2. **Per-phase test matrix in the plan**: name the test layer (unit / handler / integration / Playwright), the file(s), and what counts as sufficient coverage. Flag layers deferred to later phases explicitly. [Consensus]
3. **Lock external contracts early**: ID shapes, response payload nesting, fallback matching rules, cache keys, summary-vs-detail level. [2/3 — Codex, Claude]
4. **For phased migrations, name the legacy code that intentionally survives this phase, why, and the phase it dies in.** Mark dual-mode segments in the plan. [Consensus]
5. **For deprecation/removal sweeps, list every reference site up front**: source, tests, CLI flag registrations, types, *docs*, *skeleton templates*, examples. Codex catches the stragglers. [Consensus]
6. **For protocol/state-machine work (porch, gates, status.yaml), write the command/state flow explicitly**: who runs each command, which transitions are automatic vs human, what "pending" means. [Codex] — Codex misfires here unless state is prose, not just bullets.
7. **For thin orchestrator handlers, point Codex at where the real logic is tested.** A one-line "underlying primitives X, Y, Z are tested in `…test.ts`; this handler is integration-tested via Z" pre-empts the test-coverage objection. [Consensus] — also feeds the false-alarm prompt.
8. **List documentation-touchpoint files (arch.md, CLAUDE.md/AGENTS.md, skeleton template docs, INSTALL.md) as explicit deliverables in the plan.** Don't leave them to post-implementation cleanup. [Consensus 2/3]

*See also*: **Watchlist W1** (security hardening — parameterized commands, explicit permissions, scoped tool constraints) — single-investigator, threshold-only, but high stakes.

---

## Detailed patterns

Each pattern names the rule, evidence (≥3 distinct projects with rebuttal file paths), and why it generalizes. Consensus level annotates how many investigators independently surfaced it.

### Pattern 1: Spec completeness — defaults, errors, edge cases [Consensus 3/3]

**Rule**: When a spec introduces a new field, flag, or dependency, write down the default value, the behavior when the source is unavailable (fail-fast vs degraded), nullability, parsing rules, and the exact user-facing format (timestamps, paths, durations). Do this in the spec itself, not in a rebuttal.

**Evidence** (≥7 distinct projects):
- `446-specify-iter1-rebuttals.md` — JSON output on error, scaffold-skip counting, stderr in dry-run, version-source ambiguity, --force reporting (5 of 6 accepted)
- `456-specify-iter1-rebuttals.md` — Missing default error values for every field, time-range semantics, PR-to-project mapping edge cases, missing testing strategy (4/4 accepted)
- `467-specify-iter1-rebuttals.md` — Path base definition, idle-time display format, fallback for absent `lastDataAt`, test split (5/5 accepted)
- `469-specify-iter1-rebuttals.md` — Deterministic decision algorithm, behavior when `gh` unavailable (3/4 accepted)
- `0126-specify-iter1-rebuttals.md` — PR-to-issue linkage rules, label defaults, testing strategy, `gh` auth error handling (4/6 accepted)
- `446-plan-iter1-rebuttals.md`, `0104-phase_2-iter2-rebuttals.md`, `723-specify-iter1-rebuttals.md` — additional concurrent confirmations
- `653-specify-iter0-rebuttals.md` — ownership, terminal-state terminology, cold-start, skip-reason (5/9 accepted)

**Why it generalizes**: Specs are written before implementation surfaces edge cases. Codex's training exposes it to the failure modes spec authors haven't lived through yet. This explains its ~85% acceptance rate on spec reviews — it asks "what happens when X fails?" for concrete X values the author overlooked.

---

### Pattern 2: Per-phase test matrix — layer, files, acceptance target [Consensus 3/3]

**Rule**: In the plan, write a test matrix that names the test layer (`unit` / `handler` / `integration` / `Playwright/E2E`), the expected file(s), and when lower-layer tests are an acceptable substitute. For each new code path, list the test that covers it. Explicitly defer test layers to later phases when appropriate ("E2E coverage deferred to Phase 4").

**Evidence** (≥6 distinct projects):
- `0104-phase_2-iter1-rebuttals.md` — Missing `createSession`/`killSession` integration tests (accepted)
- `0104-phase_2-iter6-rebuttals.md` — Missing integration tests for stop/reconnect/replay cycle (accepted)
- `0118-phase_1-iter2/iter3-rebuttals.md` — Backpressure test doesn't exercise `socket.write() === false` path (accepted after 2 iterations)
- `456-api_endpoint-iter1-rebuttals.md` — Missing endpoint unit tests (accepted)
- `456-plan-iter1-rebuttals.md`, `456-specify-iter1-rebuttals.md` — Missing testing strategy at spec/plan level
- `467-plan-iter1-rebuttals.md` — Playwright requirement underspecified
- `587-auto_updates-iter1-rebuttals.md` — Spawn event detection regex test missing (accepted)
- `653-verify_phase-iter1-rebuttals.md` — Missing tests for verify gate auto-request and state migration (accepted)
- `653-pr_tracking_and_worktree-iter1-rebuttals.md`, `468-phase_3-iter1-rebuttals.md` — negative-path tests

**Why it generalizes**: Builders test what they built (happy path); they don't test what could go wrong. Codex's mechanical path-coverage check complements the implementation focus. The test-layer specification *also* preempts the most common false alarm (FA1 + FA2 below), making this a double-leverage tip.

---

### Pattern 3: Lock external contracts and data shapes early [Consensus 2/3 — Codex, Claude]

**Rule**: When a change crosses a boundary (API, GraphQL, CLI ↔ data, persistence ↔ rendering), specify exactly: ID contract (which field, which source), response shape (flat vs nested, field names), fallback matching rules, cache key derivation, numeric limits, and whether outputs are summary-level or rich. Pin these in the plan, not the implementation.

**Evidence** (≥4 distinct projects):
- `587-backend_api-iter1-rebuttals.md` — GraphQL variable substitution bug (all 3 reviewers caught), API response shape mismatch (4/4 accepted)
- `456-plan-iter1-rebuttals.md` — Cache key differs from spec, `--limit 500` conflicts with spec's 1000-item expectation (4/4 accepted)
- `456-review-iter1-rebuttals.md` — Field shape drift
- `468-phase_2-iter1-rebuttals.md` — Response `id` should match session ID from request path (accepted)
- `0104-phase_2-iter6-rebuttals.md` — Missing protocol version field in WELCOME frame (accepted)
- `446-specify-iter1-rebuttals.md`, `0126-github_integration-iter1-rebuttals.md`, `0126-review-iter1-rebuttals.md` — contract ambiguity flagged

**Why it generalizes**: Spec-to-implementation drift is natural as builders adapt to runtime constraints. Codex compares the plan's interface definition against the diff and catches mechanical mismatches that humans miss because humans review behavior, not shape.

---

### Pattern 4: For phased migrations, declare what legacy code intentionally survives this phase [Consensus 3/3]

**Rule**: When migration is phased, name the legacy path that remains active *this phase*, *why* it remains, and *which phase removes it*. Use words like "dual-mode," "transitional fallback," or "intentional coexistence" in the plan. Without this annotation, Codex reads intentional coexistence as incomplete migration.

**Evidence** (≥4 distinct projects):
- `0104-phase_3-iter1/iter2/iter3-rebuttals.md` — tmux fallback flagged across 3 iterations despite plan defining dual-mode for Phase 3
- `0118-phase_1-iter1-rebuttals.md` — `clientType || 'tower'` fallback flagged as violating "Required" spec; was backward-compat for rolling deploy
- `468-phase_1-iter1-rebuttals.md` — Missing env-var injection flagged; was intentional (would mislead in non-persistent sessions)
- `0120-plan-iter2-rebuttals.md` — SDK-driven deviation flagged as spec violation
- `456-data_layer-iter1-rebuttals.md` — `gh pr list --search` flagged for not matching spec's `gh search prs` (functionally equivalent improvement)

**Why it generalizes**: Codex performs literal spec ↔ implementation comparison. Functional equivalence or transitional coexistence is invisible to literal comparison; it has to be stated in prose. This pattern is the positive corollary of FA4 (re-raising rebutted concerns).

---

### Pattern 5: Deprecation/removal — list every reference site explicitly [Consensus 3/3]

**Rule**: When removing a concept, terminology, or feature, the plan must enumerate the reference surfaces to clean: source files, tests, CLI flag registrations, type definitions, **docs (CLAUDE.md, AGENTS.md, arch.md)**, **skeleton templates**, and examples. Run the grep up-front, list the hits, and treat each as an explicit deliverable. Codex will catch what you miss.

**Evidence** (≥4 distinct projects):
- `653-tick_removal-iter1-rebuttals.md` — CLAUDE.md/AGENTS.md still referenced TICK; skeleton templates still referenced TICK; `spawn.ts` `--amends` logic still present; `cli.ts` `--amends` flag still registered (4 of 5 real)
- `653-review-iter1-rebuttals.md` — TICK in `types.ts` still present
- `422-review-iter1-rebuttals.md` — Tower diagram uses stale `projectPath` labels; `/api/stop` doc claims stale params; residual "project" in invariant (3/3 accepted)
- `438-documentation-iter1-rebuttals.md` — CLAUDE.md/AGENTS.md ASPIR sections not identical; "auto-approved" wording instead of "removed" (2/2 accepted)
- `0126-cleanup-iter1-rebuttals.md` — leftover references in scope-applicable surfaces

**Why it generalizes**: Removal is a search problem. Builders search the obvious source-code locations and miss secondary references (docs, templates, type defs, CLI registrations). Codex's diff-scope scan is genuinely better at this than humans.

---

### Pattern 6: For protocol/state-machine work, write the command and state flow as prose [Codex 1/3, partial in Claude FA3]

**Rule**: When a change touches porch, gates, or project status, the spec/plan must include the exact command flow, who runs each command (builder vs human), which transitions are automatic vs human-driven, and what `pending` means in this context. Diagram or numbered prose works better than bullets.

**Evidence** (≥3 distinct projects):
- `653-specify-iter0-rebuttals.md`, `653-plan-iter1-rebuttals.md`, `653-review-iter1-rebuttals.md`, `653-verify_phase-iter1-rebuttals.md` — state semantics underspecified across multiple phases
- `0124-phase_5-iter1-rebuttals.md` — PR/gate flow misread (also feeds FA3)
- `723-phase_2-iter1-rebuttals.md` — `status.yaml` state misread as deliverable gap
- `0126-review-iter1-rebuttals.md` — phase transition semantics ambiguity

**Why it generalizes**: Codex's training on conventional CLIs gives it no prior for protocol orchestrators. Without prose state-machine definitions, Codex defaults to "if state says `in_progress`, work is incomplete" — which is wrong for porch. Note: this pattern also drives FA3 in the false-alarm prompt.

---

### Pattern 7: Resource lifecycle — trace partial-failure, crash, shutdown, reconnect [Consensus 2/3 — Claude, Gemini]

**Rule**: For every resource created (process, socket, session, file, connection), explicitly specify behavior in four scenarios: partial creation failure (rollback?), unexpected termination (cleanup?), planned shutdown (drain?), reconnection (replay?). Add negative-path tests for state-machine guards.

**Evidence** (≥3 distinct projects):
- `0104-phase_2-iter1-rebuttals.md` — `cleanupStaleSockets` deletes live sockets (accepted)
- `0104-phase_2-iter2-rebuttals.md` — Orphan shepherds on partial failure, error emission crashes Tower, restart timer bypasses `maxRestarts` (3 accepted)
- `0104-phase_2-iter3-rebuttals.md` — Dead sessions never removed from map on natural exit (accepted)
- `0104-phase_2-iter4-rebuttals.md` — Missing close-event handling for crash cleanup (accepted)
- `0104-phase_2-iter6-rebuttals.md` — `shutdown()` kills shepherds instead of disconnecting (accepted)
- `0104-phase_2-iter7-rebuttals.md` — Socket file created without explicit 0600 permission (accepted)
- `0116-plan-iter2-rebuttals.md`, `587-review-iter1-rebuttals.md`, `468-phase_3-iter1-rebuttals.md` — concurrent confirmations
- `0118-phase_1-iter3-rebuttals.md` — Negative-path / backpressure transition tests

**Why it generalizes**: Process/session lifecycle has many edge cases; implementation focus is naturally on happy path. Codex systematically checks unhappy paths. *Caveat*: project 0104 contributes most of the evidence here — pattern still generalizes (similar bugs in 0116, 587, 468), but the volume is skewed.

---

### Pattern 8: List documentation-touchpoint files in the plan as deliverables [Consensus 2/3 — Claude, Gemini]

**Rule**: In the plan, enumerate every documentation file (arch.md, CLAUDE.md, AGENTS.md, lessons-learned.md, skeleton template docs, INSTALL.md, README excerpts) that the change will affect, and list each one as an explicit deliverable. When the plan names them, the builder won't forget them and Codex reviews against the plan rather than the omission. After implementation, re-verify each listed doc matches what the code actually does.

**Evidence** (≥4 distinct projects):
- `723-review-iter1-rebuttals.md` — Docs overstated template propagation behavior; `codev init` doesn't produce new templates as claimed (accepted)
- `422-review-iter1-rebuttals.md` — 3 stale terminology references in docs (all accepted)
- `438-documentation-iter1-rebuttals.md` — ASPIR docs use incorrect "auto-approved" language (accepted)
- `386-final_verification-iter1-rebuttals.md` — Release notes coverage claim inaccurate; INSTALL.md references stale (accepted)

**Why it generalizes**: Documentation drifts. Builders update code and tests but forget prose docs, especially in secondary locations. Codex's mechanical compare is better at this than human reviewers who fatigue on prose.

---

### Pattern 9: Input validation — write the validation checklist into the plan [Claude 1/3 — single-source; consider sub-bullet of Pattern 1]

**Rule**: For every CLI flag, parser, or external input, the plan must list: empty-string handling, NaN handling for numeric flags, mutual exclusivity of conflicting flags, strict-equality vs truthiness for optional flags, and behavior on unknown values. Don't leave this to "obvious" defensive coding.

**Evidence** (4 distinct projects):
- `653-pr_tracking_and_worktree-iter1-rebuttals.md` — Flag parsing too permissive (NaN, missing values), truthiness checks, mutual exclusivity of `--pr/--merged` (3/3 accepted)
- `587-review-iter1-rebuttals.md` — `detectAuthor()` can return empty string (accepted)
- `587-backend_api-iter1-rebuttals.md` — GraphQL aliases starting with digits produce invalid queries (accepted)
- `468-phase_3-iter1-rebuttals.md` — Empty-name handling missing in rename command (accepted)
- `469-specify-iter1-rebuttals.md` — No behavior specified when `gh` CLI unavailable (accepted)

**Confidence note**: only Claude surfaced this as a standalone pattern; Codex/Gemini fold it into Pattern 1 (spec completeness). Retained because the evidence count is strong and the actionability is sharper than the general "defaults" rule.

---

### Watchlist (lower-confidence patterns)

These appeared at exactly the 3-project threshold from a single investigator (Claude). They're listed for future validation rather than promoted into the core tips list — but each carries enough stakes (or sharp enough actionability) to be worth flagging.

**W1: Security hardening** — parameterized commands, explicit permissions, scoped tools. For shell-command construction, use `execFile` with args array (never string interpolation); for file/socket creation, set explicit permissions (0600 / 0700); for tools/skills that run commands, write an explicit safety-constraint section. Evidence (3 projects): `653-plan-iter1-rebuttals.md` (shell injection risk in `writeStateAndCommit`), `0104-phase_2-iter7-rebuttals.md` (socket missing 0600 enforcement), `723-specify-iter1-rebuttals.md` (skill needed destructive-command constraint). Confidence note: lowest-frequency, threshold-only, single-source, reads as general security hygiene rather than a distinctively-Codex pattern. Kept on the watchlist because cost-of-miss is high.

---

## Codex false alarms

These categories feed the drop-in prompt at [codex-false-alarm-prompt.md](codex-false-alarm-prompt.md). Order is by evidence breadth × structural durability.

### FA1: Demand Playwright/E2E tests in contexts that can't run them [Consensus 3/3]

Codex sees `playwright.config.ts` and the 7 existing E2E test files (verified: `packages/codev/src/agent-farm/__tests__/e2e/`), concludes Playwright is a reasonable expectation, and demands new E2E tests. The structural blind spot: Playwright tests require Tower; builders in isolated worktrees don't have Tower. The framework exists, the tests exist — they can't be authored or run in the builder's execution context.

**Evidence** (4 projects):
- `0104-phase_3-iter1/iter2/iter3-rebuttals.md` — "Integration tests don't cover Tower behaviors" repeated 3 consecutive iterations despite same rebuttal each time
- `0126-work_view-iter1-rebuttals.md` — "Missing Playwright tests"; Tower unavailable in worktree
- `467-frontend_component-iter1-rebuttals.md` — "Required component and Playwright tests missing"; React test runner not available
- `0112-plan-iter1-rebuttals.md` — "Playwright/E2E test scenarios needed for UI route changes"; excessive for a rename-only change

---

### FA2: Demand direct tests on thin orchestrators / handlers [Consensus 3/3]

Codex applies a generic "if there's a handler, there should be a test that calls it." It doesn't distinguish handlers with real logic (worth direct testing) from thin wrappers over already-tested primitives (where contract-style testing of the primitives is more maintainable). When the handler requires mocking ~10–15 dependencies to test directly, the cost of direct tests exceeds their value.

**Evidence** (4 projects):
- `468-phase_1/phase_2/phase_3/review-iter1-rebuttals.md` — "Tests don't exercise the actual rename handler" raised in ALL 4 phases; handler needs ~15 mocks; builder used contract-style testing; Gemini and Claude both approved
- `587-frontend_tab-iter1-rebuttals.md` — "Missing unit tests for `useTeam`/`TeamView`"; project has zero frontend component unit tests; all dashboard testing uses E2E
- `386-tier_3_skeleton-iter1-rebuttals.md` — Template-sync validation beyond spec-required diff check
- `653-status_commit_infra-iter1-rebuttals.md` — "Tests should mock git ops"; codebase lacks DI / module-mock infrastructure

---

### FA3: Misread porch / status.yaml / pending-gate semantics as "incomplete" [Consensus 3/3]

Codex sees `status.yaml` with `phase: X / build_complete: false`, or a `pending` gate, and interprets it as "the builder hasn't finished." In reality these are deliberate orchestration artifacts: pending gates await human approval, `status.yaml` is managed by porch's state machine (builders don't edit it), and porch advances state on `porch done` only.

**Evidence** (2 projects — at threshold; see note):
- `0124-phase_5-iter1-rebuttals.md` — "PR not created / gate pending"; PR #312 already existed; pending gate is by design
- `723-phase_2-iter1-rebuttals.md` — "`status.yaml` shows `phase_2 in_progress / build_complete: false`"; flagged porch-managed internal state as deliverable gap

**Threshold note**: 0117 was originally cited here but removed during critique — Codex's actual verdict on 0117 was APPROVE; the REQUEST_CHANGES outcome was caused by porch's JSONL parser failing to extract Codex's verdict, not by Codex misreading porch semantics. The 0117 case is a tooling bug, not addressable by prompting Codex. FA3 therefore falls to 2 distinct projects, one short of the brief's ≥3 threshold. Retained because (a) all three investigators independently flagged porch-semantics confusion as a real false-alarm pattern in their commentary, and (b) the fix is cheap (one prompt-fragment line). Reclassify or remove if a future audit finds it remains at 2 projects.

---

### FA4: Re-raise concerns already rebutted in a prior iteration [Claude 1/3 — but extremely high signal] {#fa4-re-raise}

Each CMAP iteration provides Codex with the diff and consultation prompt, including a "Previous Iteration Context" section. Codex doesn't reliably process that context — it re-evaluates from scratch and re-discovers the same apparent issues. This is the false alarm with the highest *cost* (each repeat triggers another iteration cycle).

**Evidence** (4 projects):
- `0104-phase_3-iter1/iter2/iter3-rebuttals.md` — "tmux still in fallback" raised in iter1 and iter2 despite plan explicitly defining dual-mode; "Integration tests don't cover Tower" repeated 3 iterations
- `456-data_layer-iter1-rebuttals.md` AND `456-review-iter1-rebuttals.md` — `gh pr list` vs `gh search prs` concern raised in both phases despite thorough rebuttal
- `0126-github_integration/review/work_view-iter1-rebuttals.md` — "heading-only summary (no first paragraph)" raised across 3 phases despite same rebuttal each time
- `468-phase_1/phase_2/phase_3/review-iter1-rebuttals.md` — "contract-style tests insufficient" raised in all 4 phases

**Note**: only Claude surfaced this as a *named* false-alarm; Codex and Gemini observed it indirectly. The frequency and avoidable cost justify standalone inclusion.

---

### FA5: Sandbox / runtime-access limits converted into "tests are missing" [Consensus 2/3 — Codex, Gemini]

Codex literally cannot run tests in its sandbox (EPERM), cannot see live Tower state, cannot exercise E2E harnesses. It then conflates "I could not verify this" with "this is missing." This is structurally distinct from FA1 because it applies to *any* runtime-dependent verification, not just Playwright.

**Evidence** (4 projects):
- `0118-phase_1-iter2-rebuttals.md` — EPERM blocked test execution; flagged as missing tests
- `0124-phase_5-iter1-rebuttals.md` — "No evidence of tests passing" despite tests existing and CI green
- `0104-phase_3-iter1/iter2/iter3-rebuttals.md` — Live Tower/E2E boundary inaccessible from sandbox
- `0126-work_view-iter1-rebuttals.md` — Runtime path not exercisable from review context

---

### FA6: Repo-visibility limits — flag code/tests/artifacts outside the diff or outside the "shipped" surface [Claude 1/3 + Codex partial — merged with original FA8]

Codex reviews the diff, not the full codebase. When tests or implementation files exist in files that weren't modified, Codex doesn't see them and concludes they're missing. When files haven't been staged yet (review fires before commit), it sees them as "untracked." Adjacent failure mode: Codex sometimes flags generated artifacts, skeleton-only copies, pre-commit-staging gaps, or build outputs as if they were source defects.

**Evidence** (4 projects, including original FA8 evidence):
- `468-phase_1-iter1-rebuttals.md` — "No tests added"; a 372-line test file with 17 tests already existed but wasn't in the diff (Claude independently verified)
- `467-backend_last_data_at-iter1-rebuttals.md` — "Missing unit tests for `lastDataAt` tracking"; `pty-last-data-at.test.ts` with 5 tests already existed
- `723-phase_1-iter1-rebuttals.md` / `723-implement-phase_1-iter1-rebuttals.md` — "Skill files are still untracked"; review fired before commit; builder hadn't staged yet
- `386-final_verification-iter1-rebuttals.md` — Auto-generated file flagged as source defect (from original FA8)

**Note**: only Claude surfaced "outside-diff" as a named false-alarm; only Codex surfaced "generated/staging" — but they share a root cause (Codex misreads the bounds of what is and isn't *committed shipped behavior*). Merged per critique. The fix (one prompt-fragment line) is cheap.

---

### FA7: Scope-creep beyond spec/plan's explicit boundaries [Consensus 2/3 — Claude, Codex (as "summary-level misread")]

Codex evaluates completeness against its general sense of what a feature "should" include, not against the spec's explicit `Out of scope` section. It suggests additions (multi-repo support, full-paragraph summaries, skeleton template updates) that were deliberately excluded.

**Evidence** (4 projects):
- `0126-specify-iter1-rebuttals.md` — Multi-repo/forks requested for a single-repo tool; `/api/overview` security flagged for a localhost-only dashboard
- `0126-github_integration-iter1-rebuttals.md` — Missing issue body/comments requested when deliverable was explicitly title-only summary
- `0126-cleanup-iter1-rebuttals.md` — Skeleton files flagged when they're distribution template, not this phase's scope
- `653-specify-iter0-rebuttals.md` — Security section requested for standard defensive coding patterns not warranting spec-level treatment

---

## Per-rebuttal coverage table

Per-investigator classifications, with totals. **a** = genuinely actionable, **b** = pre-addressed (spec/plan was right, builder failed to defend), **c** = hallucinated/out-of-context. Where Gemini and Claude disagree on classification, the synthesis defers to the more conservative read (i.e. higher **a** wins for borderline cases between **a**/**b**; higher **c** wins for borderline cases between **b**/**c**).

The full per-file table (all 71 files × 3 investigators) is kept in the individual investigation reports ([gemini](codex-request-changes-patterns-gemini.md), [codex](codex-request-changes-patterns-codex.md), [claude](codex-request-changes-patterns-claude.md)). High-level totals:

| Source | Total objections | (a) actionable | (b) pre-addressed | (c) hallucinated |
|--------|------------------|----------------|--------------------|--------------------|
| Gemini | 195 | 120 (62%) | 5 (3%) | 70 (36%) |
| Codex (self) | ~190 (a+b+c, deduped) | ~115 (61%) | ~25 (13%) | ~50 (26%) |
| Claude | ~199 | ~123 (62%) | ~36 (18%) | ~40 (20%) |
| **Synthesis** | **~195** | **~62%** | **~3–18%** | **~20–36%** |

**Why the spread on (b) and (c)**: classification is judgment-laden. When Codex flags something the spec/plan already addresses, Gemini tends to classify as (c) "Codex didn't read carefully"; Claude classifies as (b) "the spec was right but the builder didn't point to it." Both interpretations are defensible; the *aggregate* "Codex was wrong or unhelpful" rate is consistent across investigators at ~38–39%.

---

## Disagreements and resolution

1. **False-alarm rate**: Gemini 36%, Claude 20%, Codex ~26%. **Resolution**: report the range (20–36%) and note the methodological cause. The aggregate "noise" rate (b+c) is consistent at ~38% across investigators, which is the operationally relevant number.
2. **Whether input validation deserves its own pattern**: Claude says yes (Pattern 9); Codex/Gemini fold it into spec completeness. **Resolution after critique**: Codex's critique flagged Pattern 9 as over-weighted in the TL;DR (single-investigator, threshold-only); merged input-validation into TL;DR Tip 1 as a sub-checklist. Standalone Pattern 9 retained in the detailed-patterns section with confidence note for traceability.
3. **Whether security hardening deserves its own pattern**: Claude says yes (Pattern 10); others don't surface it. **Resolution after critique**: Codex's critique flagged Pattern 10 as too generic for a "Codex-derived pattern." Demoted to **Watchlist W1** — kept for visibility, removed from the numbered core patterns.
4. **Whether FA4 (re-raise rebutted concerns) is a separate false alarm**: Only Claude names it. **Resolution**: retained — Codex's coverage table shows the pattern (iter2/iter3 of 0104 phase_3 has 0/3 and 1/1 classification, dominated by re-raises), and the fix (one prompt line about Previous Iteration Context) is cheap.
5. **Whether FA6 (outside-diff blindness) is a separate false alarm**: Only Claude names it. Original FA8 (generated/staging artifacts) surfaced only by Codex. **Resolution after critique**: Codex's critique flagged FA8 as falling below threshold once 0117 evidence was removed, and noted significant overlap with FA6. Merged into a single "FA6: Repo-visibility limits" entry covering both outside-diff blindness and generated/staging artifacts.
6. **Whether to deliver one prompt fragment or per-consult-type variants**: Brief mandated one drop-in fragment. Investigators suggested per-type variants (FA1 belongs in impl-review, not spec-review). **Resolution**: ship a single fragment per the brief, but Deliverable 1 (this file) notes which patterns are phase-specific so a future split is straightforward.

---

## Methodology and gaps

- **Tool constraint**: investigators cannot run `gh` (no shell). The brief originally asked for PR-diff context per rebuttal; that requirement was dropped at dispatch time. Classification relied on rebuttal text + corresponding spec + corresponding plan. For most files this was sufficient; for a handful of late-iteration code reviews, seeing the diff might have shifted (a)/(b)/(c) calls by one or two items.
- **2 of 73 rebuttal files** (`671-specify-iter1`, `671-plan-iter1`) contain no Codex content (Codex was skipped on those iterations by architect instruction or earlier convention). Excluded from analysis.
- **2 additional files** (`589-team-doctor-docs-iter1`, `589-porch-protocol-migration-iter1`) had Codex skipped by explicit architect instruction. Excluded.
- **Project 0104 over-contributes** to lifecycle bug evidence (7 iterations of phase_2 alone). The pattern generalizes (corroborating evidence in 0116, 587, 468, 0117) but the volume is skewed by one project's depth.
- **Temporal dimension**: projects span ID 0104–0126 (older Codex era) and 386–723 (newer). Patterns observed in *both* eras are weighted higher. FA1, FA2, FA3, FA5 all show cross-era persistence and are the most durable. Some lifecycle bugs (Pattern 7) are concentrated in the older era and may reflect that era's architectural state rather than Codex's behavior.
- **Investigator role bias**: consult's default role is "consultant," which prompted Gemini and Claude to *critique* the brief on first dispatch. They were re-dispatched with an explicit investigation wrapper. The brief critiques are preserved at `codev/research/_brief-critique-gemini.md` and `_brief-critique-claude.md` for traceability — they surfaced the (valid) concerns about corpus partitioning, Codex self-investigation bias, and tool constraints that informed the second dispatch.
- **Codex investigating itself** carries reflexivity risk (Codex may rationalize its own false alarms). The investigation surfaced its own false alarms substantively, suggesting the bias risk is lower than predicted — but where Codex's classification diverges from Gemini+Claude, this synthesis weights the cross-model consensus over Codex's self-read.

---

## Changes from critique

Phase 4 sent the synthesis + drop-in prompt to Gemini, Codex, and Claude. Both Gemini and Codex returned substantive critiques. Claude's critique cited patterns and details that don't exist in the actual synthesis (referenced "Patterns 11/12" and "29 distinct projects" — the synthesis has 10 patterns and stated 22–23 projects, since reduced to exact 21); the points appear to have been hallucinated from training data rather than from the current artifacts. Claude's *valid* observations (word-count check on the prompt — confirmed ~400 of 500; soften hardcoded path in check #4 — also flagged by Gemini) were incorporated.

### Incorporated (must-fix)

1. **Pattern 8 reframed as plan-time action** (Gemini). Was: "After implementation, re-read every doc claim and verify." Now: "In the plan, enumerate every documentation file that will need updates as explicit deliverables." This restores the synthesis's "pre-empt at spec/plan time" premise.
2. **Pattern 9 evidence count corrected** (Gemini). Was "(≥5 distinct projects)" — the list actually contains 4 distinct projects (653, 587, 468, 469; 587 appears in two rebuttals but counts once). Now correctly "(4 distinct projects)."
3. **Pattern 9 demoted in TL;DR** (Codex). Single-investigator + threshold-only doesn't merit a co-equal slot with consensus patterns. Merged into TL;DR Tip 1 as a validation sub-checklist. Standalone Pattern 9 retained in the detailed section.
4. **Pattern 10 demoted to Watchlist** (Codex). Single-investigator, exactly-3 projects, and reads as general security hygiene rather than a distinctively-Codex pattern. Moved to a "Watchlist W1" appendix entry under detailed patterns.
5. **Corpus count made exact** (Codex). Was "22–23 distinct projects" (ambiguous). Now: "71 Codex-containing rebuttal files across 21 distinct projects (23 in corpus; 671 has no Codex content, 589 had Codex skipped)."
6. **FA3 evidence corrected — 0117 removed** (Codex). 0117 was not a Codex misbehavior at all: porch's JSONL parser failed to extract Codex's verdict, defaulted to REQUEST_CHANGES, and Codex's actual verdict was APPROVE. Cannot be addressed by prompting Codex. FA3 now has 2 supporting projects; retained with explicit threshold-note for transparency.
7. **FA8 merged into FA6** (Codex). After removing 0117, FA8 had 2 projects (386, 723) and substantially overlapped FA6 (both are "Codex misreads the bounds of committed shipped behavior"). Combined entry titled "Repo-visibility limits."
8. **Drop-in prompt check #1 ("Grep before claiming") softened** (Gemini, Codex). The word "Grep" assumes a tool that Codex may not have in some review contexts (e.g., PR-diff review). Replaced with "Search/inspect the codebase…" — tool-agnostic.
9. **Drop-in prompt check #4 hardcoded path removed** (Gemini, Codex, Claude). The path `packages/codev/src/agent-farm/__tests__/e2e/` violated the brief's "no rotting refs" constraint. Reworded to refer to existing infrastructure generically.
10. **Drop-in prompt items #1 and #10 merged** (Codex). Both addressed "Codex misreads what's actually in the committed/shipped surface." Combined into a single "Repo-visibility limits" check, mirroring the FA6 merge in the synthesis.
11. **Drop-in prompt check #9 strengthened with mechanical constraint** (Gemini). Existing `impl-review.md` already says "read Previous Iteration Context" and it isn't sticking. New wording requires Codex to quote the prior rebuttal explicitly when overruling it, making the check actionable rather than aspirational.
12. **Drop-in prompt check #5 simplified** (Codex). Removed over-specific mechanics (`phase: in_progress and build_complete: false change automatically after porch done…`) — the audience is Codex, which needs the rule, not the implementation detail. Now: "pending gates and porch-managed status fields are orchestration state, not by themselves deliverable gaps."

### Rejected (with rationale)

- **Claude's claim that "FA9 (re-raising) and FA10 (scope-creep) are missing from the synthesis"** — both are *already present* as FA4 and FA7. Claude appears to have reviewed a hallucinated version of the synthesis. Rejected as factually incorrect.
- **Claude's claim that the synthesis says "29 distinct projects"** — line 12 says "22–23" (now: exact "21"). Rejected as factually incorrect.
- **Claude's suggestion to add a "Pattern 11/12" and a "Mining for `gh` flag bugs" rule** — these reference content that doesn't exist in the synthesis and propose patterns not derived from this brief's corpus. Out of scope.
- **Codex's suggestion to add "Appears in X objections / Y rebuttal files / Z projects" frequency annotations to every pattern heading** — the per-pattern Evidence sections already list distinct-project counts; adding objection-count would require investigator-level recounting (Codex, Gemini, and Claude each used different deduplication rules and produced different totals). Synthesis judgment was to keep the higher-confidence "≥N projects" annotation rather than the more-precise-looking-but-less-comparable "M objections" figure. Reserved for a future deeper audit if a/b/c reliability needs revisiting.

### Summary

12 critique points incorporated (8 must-fix factual/structural, 4 prompt refinements). 4 points rejected with rationale. Of the incorporated must-fixes, 3 were independently surfaced by two investigators (drop-in #1 wording, drop-in #4 hardcoded path, FA8/FA6 overlap); 5 were surfaced by Gemini or Codex alone. Critique was substantive — Pattern 9 was demoted, Pattern 10 was demoted to a watchlist entry, FA3 evidence was rebuilt after invalidating 0117, FA6 absorbed FA8, and the drop-in prompt was tightened in 5 distinct places. This satisfies the brief's acceptance criterion that at least one tip be overturned, refined, or merged based on critique — three were.

---

## Appendix: How to use this report

**For architects** writing specs/plans for new projects:
- Run through the TL;DR checklist before publishing the spec/plan.
- Pay disproportionate attention to Patterns 1, 2, 3, 6 if the work touches data contracts, protocols, or state machines.
- For phased work (migrations, deprecations, dual-mode), Patterns 4 + 5 are mandatory annotations.

**For builders** receiving CMAP feedback:
- When Codex's REQUEST_CHANGES matches one of FA1–FA8, cite the false-alarm prompt as evidence in your rebuttal. The architect's review will weight Codex's verdict accordingly.
- When Codex's REQUEST_CHANGES matches one of Patterns 1–10, it's almost certainly real — defer to it unless you have a specific, evidence-backed reason not to.

**For the Codex consult prompt**:
- Append [codex-false-alarm-prompt.md](codex-false-alarm-prompt.md) to `codev/consult-types/integration-review.md` and the per-protocol consult-type files that Codex sees during implementation and review phases.
