# Codex REQUEST_CHANGES Patterns — Data-Derived Tips

## Methodology

This analysis covers all 71 `*iter*-rebuttals.md` files under `codev/projects/` as of 2026-05-17, spanning 29 distinct projects (IDs 104, 112, 116, 117, 118, 120, 124, 126, 386, 403, 422, 438, 446, 456, 462, 467, 468, 469, 587, 589, 653, 671, 723). Two files (671 hermes-consult plan and specify) are empty and were excluded. The remaining 69 files document builder responses to 3-way CMAP review (Codex, Gemini, Claude); this analysis extracts ONLY Codex's REQUEST_CHANGES bullets and the builder's resolution. Time period covered is roughly late-2025 through mid-2026 based on dates embedded in files. The data captures what Codex *flags* and what the *builder did about it* — it does NOT capture (a) Codex's full original critique text, (b) cases where Codex APPROVED without comment, (c) what was fixed silently without a rebuttals file, or (d) whether the architect agreed with the builder's rebuttal at PR time. Files were read in full; this is not a filename-only summary.

Across these 69 files I count roughly **155 distinct Codex REQUEST_CHANGES points** (some files have 1, the heaviest — Project 653 plan — has 7). Of these, ~99 were ACCEPTED/FIXED by the builder, ~38 were REBUTTED (builder pushed back), and ~18 were ACKNOWLEDGED-but-deferred (counted with rebuttals here). The rebuttal rate is high (~36%) — Codex is genuinely useful but also genuinely over-eager. Both signals are extracted below.

## TL;DR — Top Tips

1. **Spell out every test case the plan implies.** Half of all Codex REQUEST_CHANGES include some form of "missing tests" — the biggest cluster by far (~33 cases). When the plan says "add tests for X," enumerate the *specific* test cases (happy path, each error code, each edge case, each branch) and the test file they go in. Vague "Testing Expectations" sections invite this objection.
2. **List every file you'll touch, including consumers and skeleton mirrors.** When a plan calls for renaming/refactoring an identifier, Codex repeatedly catches missed consumer files (`overview.ts`, `status.ts`, `tower-server.ts`) and missed `codev-skeleton/` copies. Always include a full-repo grep result in the plan, not just `packages/codev/src/`.
3. **Use `execFile` + args arrays, never `exec` + interpolation.** Codex flags shell-injection patterns aggressively, including `git push` flags (`-u origin HEAD`), `--allow-empty` masking, and any string-interpolated `gh`/`git` calls. Bake "no string-built shell commands" into the plan's risk section.
4. **Validate every CLI arg explicitly: `Number.isInteger`, `> 0`, non-empty, mutual exclusivity.** Repeatedly flagged across phases — `parseInt(NaN)`, truthy checks on `0`, missing-value handling, conflicting flags. Whenever the spec adds a CLI flag, include input validation in the acceptance criteria.
5. **Define defaults and degraded-mode behavior for every external dependency.** When `gh`, network, GitHub auth, or a config file can fail, the spec must state what the system returns (zero counts, null averages, empty arrays, cached data, or hard fail). Specs that leave this implicit get REQUEST_CHANGES every time.
6. **Specify exact error messages and exit codes in the spec, not "appropriate error."** Codex flagged "Error message phrasing" with hardcoded spec-matching strings as a fix at least three times. If the spec gives the exact wording, the plan and code line up automatically.
7. **Lock matrices, mappings, and "we'll decide in implementation" lists at plan-approval time.** Codex calls out under-specified algorithms (relative path derivation, label defaults, subsystem-to-pattern mapping) as plan-phase failures. Anything labeled "TBD in implementation" tends to draw a REQUEST_CHANGES.
8. **State backward-compat boundaries explicitly.** When a migration applies to "all projects" vs "only projects with feature X," Codex flagged this gap in 653-plan-iter1 ("universal migration vs gated migration"). Specify the *exact* condition that triggers the migration and what gets stranded otherwise.

## Patterns (by frequency)

### Pattern 1: Missing or under-specified tests (~33 occurrences across 21 projects)

**What Codex flags:** Tests that the plan implicitly promised but the implementation doesn't deliver — missing unit tests for new functions, missing edge-case coverage, missing integration tests for newly-added endpoints, missing tests that exercise the *actual* code path (vs. an adjacent helper). Also: "no evidence the full test suite was run."

**Concrete examples:**
- Project 0104 phase_2 iter1: missing `createSession`, `killSession`, and auto-restart tests on SessionManager
- Project 0118 phase_1 iter2-iter3: backpressure test patched the wrong-side socket — didn't exercise the `socket.write() === false` branch at all
- Project 0124 phase_5: "no evidence of full test suite run" (test-results.json was empty)
- Project 0456 api_endpoint iter1: missing unit tests for the route handler (6 tests added: dispatch/JSON, 400 invalid range, default range, refresh passthrough, empty workspace, range=all)
- Project 0456 data_layer iter1: missing test for single PR linking to multiple issues (`Fixes #42, Closes #73, Resolves #99` → 3 distinct project IDs)
- Project 0467 backend_last_data_at iter1: missing integration test for `/api/state` including `lastDataAt` in shell entries
- Project 0468 phase_2 iter1: tests don't exercise the actual rename handler — only adjacent primitives (REBUTTED — handler requires too many mocks)
- Project 0468 phase_3 iter1: tests don't exercise the actual `rename()` function (REBUTTED — fatal()+process.exit fragile to mock)
- Project 0587 af_team_cli iter1: missing author auto-detection tests (`gh api user` → `git config` fallback chain)
- Project 0587 backend_api iter1: missing graceful-degradation tests for `fetchTeamGitHubData` (empty members, all-invalid handles, gh failure)
- Project 0653 plan iter1: "Testing gaps" — acceptance criteria didn't cover multi-PR recording flow, verify approval+skip paths, afx status styling, git mock tests
- Project 0653 pr_tracking_and_worktree iter1: missing 4 tests (record PR, mark merged, --pr without --branch throws, --merged nonexistent throws)
- Project 0723 plan iter1: smoke test underspecified (`dist/cli.js` not present in worktree)

**Tip:** **In the plan's "Testing" section, enumerate every test case by name** (e.g. `"counts multiple issues from single PR"`, `"400 on invalid range"`, `"empty workspace returns timeRange from request"`) and the exact test file each lives in. Pair every new public function and every new error code with at least one named test case. If the test target is hard to mock (process-spawning, `process.exit`, native modules), say so in the plan's risk section and justify the contract-level test substitute up front — don't wait for Codex to flag the gap.

---

### Pattern 2: Missed consumer files / incomplete files-touched list (~15 occurrences across 9 projects)

**What Codex flags:** When a rename, refactor, or migration is happening, the plan lists some files but misses others. The agent-farm directory is a frequent omission, and so are the `codev-skeleton/` mirror copies of any template/skill/doc that lives in `codev/`.

**Concrete examples:**
- Project 0112 plan iter1: dashboard/, codev-hq/, SQL columns missing from grep verification
- Project 0124 phase_4 iter1: "Tower route consolidation not done" — turned out audit found no overlap, REBUTTED but plan should have stated that up front
- Project 0386 final_verification iter1: deprecated files (INSTALL.md, MIGRATION-1.0.md) not listed as allowed exceptions in verification report
- Project 0386 tier_3_skeleton: `afx spawn` synopsis still showed `-p, --project` in agent-farm.md
- Project 0438 documentation iter1: CLAUDE.md and AGENTS.md ASPIR sections diverged after the build (the same file pair that triggers this is well-known)
- Project 0446 plan iter1: `codev/resources/commands/codev.md` missing from documentation updates section
- Project 0469 plan iter1: missing `codev-skeleton/resources/commands/consult.md` from Phase 2 deliverables
- Project 0653 plan iter1: Phase 4 missed 3 agent-farm files (`overview.ts`, `status.ts`, `overview.test.ts`)
- Project 0653 tick_removal iter1: deeper TICK references in CLAUDE.md/AGENTS.md, skeleton templates, spawn.ts `--amends` logic, cli.ts flag registration
- Project 0723 specify iter1: factual error — claimed `codev-skeleton/` does NOT have `.claude/skills/`, but it does

**Tip:** **Before writing the plan, run a full-repo grep for every identifier being renamed/removed and paste the output into the plan.** Don't restrict to `packages/codev/src/` — include `codev-skeleton/`, `dashboard/`, `codev-hq/`, `*.md`, `agent-farm/`, test files, and `.claude/skills/`. For any docs change that affects CLAUDE.md, force-include AGENTS.md in the same commit (the divergence is a recurring trap). For a clean rename, the plan should literally contain the grep command and its expected post-change zero-hit result.

---

### Pattern 3: Spec ambiguity / under-specified algorithms (~14 occurrences across 10 projects)

**What Codex flags:** Spec or plan defines a behavior in fuzzy terms ("appropriate", "summary", "first heading", "relative path") without nailing the precise algorithm, default value, or precedence rule. Codex demands a deterministic algorithm.

**Concrete examples:**
- Project 0126 specify iter1: PR-to-issue linkage rules unspecified (which keywords? `Fixes`, `Closes`, `[Spec N]`?)
- Project 0126 specify iter1: label defaults for missing/ambiguous labels (no `type:*` → ?; multiple `priority:*` → ?)
- Project 0126 github_integration iter1: spec-file fallback "first heading + first paragraph" or just heading? (REBUTTED — heading only)
- Project 0456 specify iter1: time range semantics — calendar week vs rolling window from now?
- Project 0456 specify iter1: default values for every field when GitHub is unavailable (counts → 0, averages → null, collections → empty)
- Project 0456 plan iter1: cache key — `range` only or `range + workspace`?
- Project 0467 plan iter1: relative-path derivation algorithm — locked to "basename + parent directory" with full-path tooltip
- Project 0469 specify iter1: no deterministic decision algorithm for risk triage ("highest individual factor wins" added)
- Project 0653 plan iter1: terminal rename scope — what to rename (`complete` → `verified`) and what NOT to rename (`PorchNextResponse.status: 'complete'`)
- Project 0723 specify iter1: skill discovery criteria "too fuzzy" — replaced with deterministic literal-content checks (frontmatter must contain "arch.md", "lessons-learned.md", "MAINTAIN"; body must contain 7 named sections)

**Tip:** **Every spec section that prescribes a behavior must answer "what exact string/value/algorithm does the implementation produce?"** Avoid prose like "appropriate," "summary," "graceful degradation" without saying *what specific output* is appropriate. When a fallback chain is involved (`gh api user` → `git config` → `'unknown'`), list every tier and what triggers it. When a regex/format is involved, paste the exact regex and an example match. Codex will not accept "the builder will decide during implementation" for anything that's user-facing.

---

### Pattern 4: External-tool error handling / degraded mode (~12 occurrences across 8 projects)

**What Codex flags:** Spec or plan doesn't say what happens when `gh` fails, `gh` is unauthenticated, network is down, a config file is malformed, or an API call returns partial data. Builder is expected to specify behavior explicitly (fail-fast vs partial-data vs cached vs default).

**Concrete examples:**
- Project 0120 plan iter2: SDK constraint (no `systemPrompt` option, only file path) — should spec amendment be required? (REBUTTED — implementation detail)
- Project 0126 specify iter1: `gh` auth failures / `/api/overview` degraded mode — added explicit Degraded mode section (builders still returned, PRs/backlog empty with error message)
- Project 0456 specify iter1: default error values for every field on GitHub failure
- Project 0456 data_layer iter1: partial GitHub failure surfacing — does `errors.github` fire if 1-of-3 calls fails or only all-3? (REBUTTED — only all-3)
- Project 0469 specify iter1: `gh` unavailable behavior — fail fast with clear error, no fallback (aligns with project's "no fallbacks" principle)
- Project 0587 backend_api iter1: GraphQL aliases starting with digits → invalid; `gh api graphql` variable interpolation broken
- Project 0587 auto_updates iter1: `gh pr list --state merged --search` invalid combination → use `is:merged` inside search string instead
- Project 0589 team-doctor-docs iter1: `getRepoInfo` calling `gh` directly instead of going through forge concept abstraction

**Tip:** **In the spec, add a "Degraded mode" or "External tool failures" subsection that enumerates every external dependency** (`gh`, network, config files, SQLite, npm packages) **and the exact behavior on each failure type** (auth missing, command not found, network timeout, partial response, rate-limited). Cite the project's "fail-fast, no fallbacks" principle where it applies, and pre-emptively note where partial data IS preferable (e.g., 2-of-3 GitHub calls succeed). For `gh` specifically, *test the exact flag combinations you plan to use* — `--state merged --search` is broken, `gh search prs` lacks `mergedAt`, and `--limit` caps at 1000.

---

### Pattern 5: Shell-injection / unsafe subprocess invocation (~7 occurrences across 4 projects, but very high signal)

**What Codex flags:** Use of `exec` with string interpolation, missing `execFile` with args array, `git push` without upstream tracking, `--allow-empty` commits masking bugs, dynamic imports of `child_process`.

**Concrete examples:**
- Project 0589 porch-protocol-migration iter1: dynamic imports of `child_process` and `util` (replaced with static imports)
- Project 0653 plan iter1: `writeStateAndCommit` shell injection risk (changed to `execFile` with args array)
- Project 0653 plan iter1: `git push` should be `git push -u origin HEAD` (upstream tracking)
- Project 0653 plan iter1: `--allow-empty` masks logic bugs (removed)
- Project 0653 pr_exists_fix iter1: GitLab `glab mr list` missing `--all` flag (state filter)
- Project 0653 pr_exists_fix iter1: Gitea `tea pulls list` defaults to open-only — needs `--state all`
- Project 0653 pr_tracking_and_worktree iter1: `parseInt` without `Number.isInteger`/`> 0` validation

**Tip:** **For every subprocess invocation, the plan must specify `execFile`/spawn with args array form, NOT string-interpolated `exec`.** When shelling out to `git`, include the safe-flag list explicitly: `git push -u origin HEAD` (no `--force`), no `--allow-empty`, use `git fetch origin main && git checkout -b <branch> origin/main` (don't trust a local-main checkout in a worktree). When shelling out to `gh`/`glab`/`tea`, write out the exact flag set, including state filters (`--all`, `--state all`, `--state merged`), and verify that flag combinations are actually valid before committing to them in the spec.

---

### Pattern 6: Backward compatibility / migration precision (~7 occurrences across 5 projects)

**What Codex flags:** Migration logic that's overly narrow (would strand some projects), overly wide (mutates state that shouldn't change), or missing entirely. Also: under-specified detection of "old format" vs "new format."

**Concrete examples:**
- Project 0118 phase_1 iter1: `clientType || 'tower'` fallback — backward-compat for rolling deployments (REBUTTED with strong rationale)
- Project 0468 phase_1 iter1: missing env var injection for fallback shells (REBUTTED — non-shellper sessions can't persist labels)
- Project 0653 plan iter1: "Backward compat precision" — migration must be universal (`phase === 'complete'` → `'verified'` for ALL protocols), not gated on `protocolHasVerifyPhase`. Prevents stranding BUGFIX/MAINTAIN projects.
- Project 0653 review iter1: `verify-approval` gate missing for upgraded projects — `next()` now creates gate entries when advancing, not just when requested
- Project 0653 specify iter0: backward compatibility detection mechanism — check `gates` map for `verify-approval` entry; if protocol defines verify but project's phase is `complete` with no verify gate, auto-transition to `verified`
- Project 0653 verify_phase iter1: readState migration of complete→verified — sync vs async tradeoff (acknowledged as-is)

**Tip:** **When the spec introduces a state-shape change, explicitly enumerate (a) which existing artifacts get migrated, (b) what the precise detection rule is, (c) what gets stranded under each branch, and (d) where the migration runs (read-time vs write-time vs explicit command).** Default to *universal* migrations unless you can name specific projects that should be excluded — Codex flags "gated" migrations as risky because they tend to strand corner cases.

---

### Pattern 7: CLI input validation / arg parsing (~6 occurrences across 4 projects)

**What Codex flags:** Missing validation on CLI flags — `parseInt(NaN)`, truthy checks on `0`, empty strings, missing values, conflicting flags, project-ID extraction with leading-`--` args.

**Concrete examples:**
- Project 0468 phase_3 iter1: empty-name handling — added `if (!options.name || options.name.trim().length === 0)` with `fatal()`
- Project 0468 phase_3 iter1: error message phrasing — must match spec text verbatim (`"Not running inside a shellper session"`, `"Name must be 1-100 characters"`, `"Cannot rename builder/architect terminals"`, `"Session not found — it may have been closed"`)
- Project 0653 pr_tracking_and_worktree iter1: `parseInt` without `Number.isInteger` + `> 0` validation
- Project 0653 pr_tracking_and_worktree iter1: truthiness checks for `options.pr/merged` — changed to `!== undefined`
- Project 0653 pr_tracking_and_worktree iter1: `--pr` and `--merged` mutually exclusive
- Project 0653 pr_tracking_and_worktree iter1: project ID extraction skipping args starting with `--`
- Project 0469 specify iter1: deterministic decision algorithm "highest individual factor wins"

**Tip:** **For every new CLI flag, the spec must specify (a) the parser (`Number.isInteger`, regex, enum), (b) the failure mode (`fatal()` with exact message string), (c) any mutually-exclusive flag pairs.** Pair this with a test enumeration: empty-string, NaN, 0 vs missing, conflicting flags — one test per failure path. Make the error message strings spec deliverables, not implementation choices.

---

### Pattern 8: Spec-to-plan misalignment (~5 occurrences across 4 projects)

**What Codex flags:** The plan deviates from the spec in a way that's reasonable but undocumented. Codex demands either an explicit "intentional deviation" note or a spec amendment.

**Concrete examples:**
- Project 0120 plan iter2: spec says "System prompt via SDK options, not temp file" but plan uses `experimental_instructions_file` (REBUTTED — SDK constraint)
- Project 0124 phase_2 iter1: REST API handler tests "aren't PTY-specific" — but they ARE (REBUTTED — TerminalManager.handleRequest is PTY-unique)
- Project 0124 phase_3 iter1: edge-cases file not reduced to ~13 tests — plan miscategorized which tests lived where (REBUTTED — backoff tests were in tunnel-client.test.ts)
- Project 0456 plan iter1: cache key differs from spec (workspace + range vs range only) — accepted as intentional deviation
- Project 0456 review iter1: `gh pr list` vs `gh search prs` — REBUTTED, documented in earlier phase rebuttals
- Project 0653 review iter1: verify enters before merge — fixed by reordering verify phase task steps

**Tip:** **Whenever the plan diverges from the spec, add an explicit "Deviations from Spec" subsection that names each divergence, the reason, and whether it requires a spec amendment.** This pre-empts Codex flagging it as a contradiction. Common legitimate reasons: SDK/library constraints that the spec author couldn't have known about, audit-found-no-overlap (so the planned consolidation step becomes a no-op), and intentional safety hardening (cache key includes workspace to prevent cross-workspace collisions).

---

### Pattern 9: Documentation gaps (~5 occurrences across 4 projects)

**What Codex flags:** New features/flags that lack help text, missing `codev/resources/commands/*.md` updates, CLAUDE.md/AGENTS.md divergence, missing skeleton mirror updates.

**Concrete examples:**
- Project 0386 final_verification iter1: deprecated files not listed as audit exceptions
- Project 0386 tier_2_developer iter1: `afx start`/`afx stop` instead of `afx dash start`/`afx dash stop` in arch.md (4 instances)
- Project 0438 documentation iter1: CLAUDE.md and AGENTS.md ASPIR sections diverged (gates "removed" vs "auto-approved")
- Project 0446 plan iter1: `codev/resources/commands/codev.md` missing from documentation updates
- Project 0653 pr_tracking_and_worktree iter1: help text missing new flags (`--pr/--branch/--merged`)
- Project 0653 tick_removal iter1: TICK references in CLAUDE.md/AGENTS.md, codev-skeleton/, spawn.ts, cli.ts

**Tip:** **Add a "Docs to update" checklist to every plan that touches user-facing CLI or workflow.** Standard items: `CLAUDE.md`, `AGENTS.md` (always together), `codev/resources/commands/<tool>.md`, the matching `codev-skeleton/` copy, the tool's `--help` output, any `arch.md` reference, and the relevant skill SKILL.md. Treat CLAUDE.md/AGENTS.md as one logical file with two physical copies — divergence is a recurring bug.

---

### Pattern 10: API/contract response-shape mismatches (~4 occurrences across 3 projects)

**What Codex flags:** Endpoint returns a shape that doesn't match what the plan specified, or a field is missing/flattened/renamed without coordination across producers and consumers.

**Concrete examples:**
- Project 0456 review iter1: hardcoded `timeRange: '7d'` in no-workspace fallback — should use requested range
- Project 0468 phase_2 iter1: response `id` returns `dbSession.id` instead of the request-path `terminalId` (also flagged by Claude)
- Project 0468 phase_2 iter1: CORS `Access-Control-Allow-Methods` missing `PATCH`
- Project 0587 backend_api iter1: response shape flattened GitHub data and omitted `filePath` — plan said nested under `github_data`

**Tip:** **When the spec defines an API endpoint, write the exact JSON shape (TypeScript-style interface) and treat field names/nesting as load-bearing.** Make consumers (frontend, CLI, tests) reference the same type definition. For new HTTP methods, include the CORS headers update in the plan's files-touched list. For ID-matching, the response `id` should always echo the request-path `id` regardless of internal DB id schemes.

---

### Pattern 11: E2E / Playwright tests (~4 occurrences across 4 projects, mostly REBUTTED)

**What Codex flags:** Plan promises E2E/Playwright tests but the implementation lacks them.

**Concrete examples:**
- Project 0112 plan iter1: Playwright/E2E scenarios needed for URL changes (REBUTTED — rename-only, existing E2E tests cover routes)
- Project 0126 work_view iter1: Missing Playwright tests (REBUTTED — Tower infra unavailable in builder worktree)
- Project 0456 review iter1: missing E2E tests (REBUTTED — follow-up item, all required unit and component tests in place)
- Project 0467 frontend_component iter1: missing Playwright E2E (REBUTTED — no Playwright infrastructure exists in codebase)

**Tip:** **If Playwright tests are not in scope for this builder, the plan should say so explicitly and explain why.** Common valid reasons: Tower instance unavailable in builder worktree CI, no Playwright infrastructure yet, rename-only changes covered by existing routes. Listing Playwright as "aspirational" in the spec while the plan declares it unreachable for this builder pre-empts the recurring REQUEST_CHANGES.

---

### Pattern 12: Edge cases / failure modes (~4 occurrences across 4 projects)

**What Codex flags:** Specific concrete edge cases the spec missed — zero-padded IDs, race conditions, double-init, dead session map cleanup.

**Concrete examples:**
- Project 0104 phase_2 iter6: no protocol version-mismatch handling (3 cases: older/newer/match)
- Project 0104 phase_2 iter7: socket file permission enforcement (0600/0700) missing
- Project 0126 github_integration iter1: legacy zero-padded specs vs non-padded `projectId` (REBUTTED — both use leading zeros)
- Project 0126 review iter1: zero-padded spec ID fallback in `getProjectSummary()` (fixed with regex extracting numeric prefix and comparing zero-stripped)
- Project 0126 review iter1: bugfix builder issue numbers lost in overview (`parseInt('builder-bugfix-315')` → NaN); fix with regex `(\d+)$` extraction
- Project 0403 message_buffering iter1: double-`start()` causes timer leaks
- Project 0587 backend_api iter1: GraphQL aliases starting with digits

**Tip:** **For any system that consumes IDs, dates, filenames, or external strings, include a "weird inputs" section in the spec** — leading zeros, embedded prefixes (`builder-bugfix-315`), empty strings, Unicode, control characters, digits at the start of identifiers, missing fields. Pair each with a test case. For lifecycle code (start, stop, attach, reconnect), explicitly handle double-invocation and race conditions; permission bits and version handshakes belong in the spec, not the implementation.

---

## Single-occurrence striking points

These show up only once but are notable signals:

- **Project 0104 phase_2 iter1**: `cleanupStaleSockets()` deleted live sockets without probing — fixed by adding test-connection check before delete. *Lesson: cleanup code must validate "is this actually stale" before mutating.*
- **Project 0104 phase_3 iter3**: Kill paths bypassed `SessionManager.killSession()` — only called PtySession-level kill, so auto-restart respawned "killed" sessions. *Lesson: when there are layered managers, every external entrypoint needs an explicit story.*
- **Project 0104 phase_2 iter4**: Missing `'close'` event handling caused dead-session leak on shepherd crash (no EXIT frame). *Lesson: event-driven code must handle BOTH normal-exit AND abnormal-exit signals.*
- **Project 0118 phase_1 iter3**: Builder's *previous* rebuttal claimed a test "monkey-patched write to return false" — but that code did not exist in the test file. Codex was right; previous rebuttal was wrong. *Lesson: rebuttals that reference code should quote it; otherwise verify by reading the file.*
- **Project 0124 phase_5**: PR not created / gate pending (REBUTTED — gate is human-approval by design). *Lesson: porch's pending gates are intentional and not a bug — Codex doesn't know this.*
- **Project 0126 review iter1**: Collapsed file panel search input is "dead input" (REBUTTED — intentional UX pattern, onFocus opens full panel, same as VS Code).
- **Project 0386 final_verification iter1**: `.builder-role.md` flagged as having stale references — but the file is auto-generated in the worktree (untracked, not committed). *Lesson: auto-generated files in worktrees aren't source files; the audit should skip them explicitly.*
- **Project 0587 auto_updates iter1**: Gate approval false positives — `status.yaml` mtime changes on any update, not just approval, causing re-emission of "Gate approved" events (acknowledged as v1 limitation).
- **Project 0723 specify iter1**: Factual error in spec — claimed `codev-skeleton/.claude/skills/` does NOT exist, but it does (contents: `afx codev consult generate-image porch`). *Lesson: "does the directory exist" claims belong in plan-phase verification, not spec-phase narrative.*

---

## Patterns Codex got WRONG (when builder rebutted successfully)

Of ~155 Codex REQUEST_CHANGES points, roughly **38 (24%) were successfully rebutted** by the builder — either marked as DISPUTED, INCORRECT, REBUTTED, or NOT APPLICABLE, often with Gemini/Claude endorsement. The patterns of false positives:

1. **Codex over-flags missing Playwright/E2E tests** when the codebase has no Playwright infrastructure or when the change is rename-only and covered by existing E2E. (Projects 0112, 0126, 0456, 0467 — 4 instances.) Codex doesn't seem to check whether Playwright is actually wired up in the project.

2. **Codex over-flags "tests don't exercise the actual handler"** when the handler is a thin orchestrator over heavily-tested primitives, or when mocking the handler is unrealistically complex. (Projects 0124, 0468 phase_2/3, 0653 — 5+ instances.) Builders consistently rebut with "we test the underlying primitives" and Gemini+Claude agree.

3. **Codex over-flags intentional dual-mode / migration phases** as "fallback X is still present" when the plan explicitly schedules removal for a later phase. (Project 0104 phase_3 iter1 and iter2 — same complaint two iterations in a row, both REBUTTED.) Codex doesn't re-read the plan's phase scoping.

4. **Codex over-flags porch gate-pending state as a bug.** Pending gates are human-approval points by design (Project 0124, 0653). Codex doesn't seem to know about porch's gate model.

5. **Codex sometimes hallucinates code paths.** Project 0118 phase_1 iter2 rebuttal claimed a test patched `write` — Codex was right that the patching didn't exercise the right branch, AND right that the rebuttal was misleading. But Codex was wrong on other code-path claims (Project 0468 review iter1 — claimed shellper ID lookup was broken after reconnect, when the code actually extracts the right UUID from the socket path).

6. **Codex over-flags "spec deviation"** for cases where the spec couldn't have anticipated the constraint — SDK limitations that force a temp file (Project 0120), gh CLI flag combinations that don't work (Project 0456 — `--state merged --search` is invalid, requires `is:merged` inside search).

7. **Codex can't run tests in its sandbox** (Project 0118 phase_1 iter2: "all 45 tests failed with EPERM"). So when Codex reasons about test behavior, it's purely from code-reading, which has known accuracy ceilings.

8. **Codex flags consultation-format false positives.** Project 0117 review iter1: porch's verdict parser couldn't extract text from OpenAI Agent SDK JSONL format and defaulted to REQUEST_CHANGES — the actual codex verdict was APPROVE. Worth noting as a tooling artifact rather than a Codex behavior.

**Takeaway for builders/architects:** When Codex flags missing E2E tests, missing handler tests, or "fallback still exists during a multi-phase transition," check whether the rebuttal can lean on (a) lack of Playwright infrastructure, (b) heavily-tested adjacent primitives, or (c) explicit plan-phase scoping — and verify Gemini and Claude agree before rebutting. When two of three reviewers approve, single-Codex-REQUEST_CHANGES on these patterns is usually safe to rebut.

---

## Honest gaps

This analysis is necessarily lossy: rebuttals files are *post-hoc summaries* of Codex's feedback, not Codex's verbatim critique. The builder paraphrased what Codex said, and the paraphrase often elides context. Some files (especially `0671-hermes-consult-*`) are empty stubs. I don't have a count of how many *projects had a Codex REQUEST_CHANGES that was silently fixed* without producing a rebuttals file — the denominator here is "iterations that required a rebuttals file," not "all CMAP runs." I also can't tell from these files whether Codex's *aggregate REQUEST_CHANGES rate* is rising or falling over time — there's no timestamp ordering by project, and the 723 set is densely concentrated at 2026-05-05. Several files use a non-standard format (e.g., 0104 phase_2 iter1 lumps Codex with Gemini under "Addressed: X (Codex, Gemini)") which forced judgement calls about whether to attribute issues to Codex alone. Finally, this analysis can't tell us *which tips would have actually prevented* a flag — only which patterns recur. The recommendation order in the TL;DR is by raw frequency, which is a reasonable but not airtight proxy for impact.
