# Builder thread: pir-1012

Issue #1012 — scaffold: `codev init` bootstraps `codev/resources/` with arch.md + lessons-learned.md starters. Protocol: PIR (strict, porch-driven).

## Plan phase

- Investigated scaffold flow. Root cause confirmed: `createUserDirs` (scaffold.ts:23) only creates specs/plans/reviews; nothing in init/adopt creates `codev/resources/`.
- Found `copyResourceTemplates` (scaffold.ts:113) is **dead code** — exported, tested, but no command calls it. It would copy the skeleton's rich template stubs plus framework docs (cheatsheet.md, lifecycle.md → #1011 territory). Plan proposes inline minimal starters instead, leaving the dead function untouched (flagged as an open question at the plan gate).
- `codev update` already never touches resources — acceptance criterion satisfied by status quo; adding a guard test.
- `codev adopt` aborts when `codev/` exists, so the "don't clobber" criterion is structurally unreachable; new function uses per-file skip-if-exists anyway.
- Plan written to `codev/plans/1012-scaffold-codev-init-bootstraps.md`. Awaiting plan-approval gate.
- Gate discussion: architect asked about VSCode extension behavior on uninitialized workspaces (answer: extension never invokes init/adopt; degrades gracefully, user bootstraps manually) and whether adopt should backfill pre-fix projects. Adopt can't (aborts when `codev/` exists), so architect approved a scope amendment: `codev update` backfills missing-only resources files (create-if-missing, never modifies existing). Plan revised accordingly.

## Rebase on main (2026-06-13)

- Rebased onto origin/main (was 63 behind). **Spec 987 had landed** — two-tier governance docs (HOT arch-critical.md/lessons-critical.md + COLD arch.md/lessons-learned.md). This re-scopes the issue significantly.
- 987 already wired `copyHotTierDefaults` into init/adopt/update (incl. update-backfill via skipExisting + dryRun handling) — but ONLY for the HOT tier. The COLD files (arch.md, lessons-learned.md), which #1012 is actually about, are STILL not materialized.
- COLD files are already in USER_DATA_PATTERNS (templates.ts:83-84) so update never overwrites them — they're just never created.
- The update-backfill "scope amendment" I discussed with the architect is now MOOT: 987 already ships update backfilling resources. Extending to cold is consistent house style, not a deviation.
- Revised plan: add `copyColdTierDefaults` (sibling of `copyHotTierDefaults`) + wire into the same 3 sites. Main open question for the gate: copy skeleton cold templates (consistent with 987) vs the issue's original "minimal inline content" preference. Plan recommends skeleton templates; awaiting architect sign-off.
- Dead `copyResourceTemplates` still dead; 987's own comment flags it. Out of scope.

## Gate iter: "why copy at all / use the proper code path"

- Architect challenged the inline-content idea: don't fork the mechanism, use the existing materialization code.
- Verified: (a) NO production code reads templates/arch.md or templates/lessons-learned.md (pure copy sources — safe to edit); (b) no resolver/lazy path serves cold files — review prompts read literal `codev/resources/arch.md`, which is project-owned user-data (templates.ts:83-84) with no fallback by design. So the file MUST physically exist; materialization is unavoidable.
- Also found: the skeleton `templates/arch.md` has a "Note on propagation" section asserting it is NOT copied into projects — copying it verbatim would be self-contradicting. That's the real reason inline content was tempting.
- Final design (plan revised): generalize `copyHotTierDefaults` body into a private `copyResourceDefaults(files,...)`, redefine hot in terms of it (no behavior change), add `copyColdTierDefaults` for ['arch.md','lessons-learned.md']; wire at the same 3 sites. Fix the SOURCE: trim the propagation note from skeleton arch.md + false footer from lessons-learned.md. One mechanism, one source of truth, no inline strings.
- Open sub-decision for gate: how lean to trim the templates (light trim keeping structural stubs [recommended] vs ultra-minimal one-liner).

## Second rebase on main (2026-06-13)

- Rebased again (was 38 behind). Verified NONE of the 38 new commits touched any plan-target file (scaffold.ts, init/adopt/update.ts, templates.ts, skeleton templates, review prompts). All plan assumptions re-confirmed: hot-tier mechanism intact, cold files still user-data with no fallback, propagation note still in skeleton arch.md:116, no production reader of cold template sources, review prompts still reference cold files. Plan unchanged. Force-pushed. Still at plan-approval gate.

## Content decision settled: one-line placeholders

- Architect chose the one-line placeholder option (issue's suggested text verbatim) over copying/trimming the rich skeleton templates.
- This SIMPLIFIES the plan: skeleton templates are NOT edited at all (rich templates + their manual-cp note stay as-is). No `copyHotTierDefaults` refactor needed.
- Final implementation: `createColdTierDefaults(targetDir, opts)` in scaffold.ts writes two small placeholder consts (arch.md, lessons-learned.md) with skip-if-exists; wired at the same 3 sites next to copyHotTierDefaults; update backfills (consistent with 987). copyHotTierDefaults left completely untouched.
- Plan finalized. No open decisions remain. Awaiting plan-approval.

## Implement phase

- plan-approval approved; advanced to implement.
- Added `createColdTierDefaults` + `COLD_TIER_STARTERS` to scaffold.ts; wired into init/adopt/update next to copyHotTierDefaults. copyHotTierDefaults + skeleton templates untouched.
- Tests: new cold-tier-materialization.test.ts (7 tests: create/placeholder-marker/skip-existing/user-data-protection/update-backfill/customized-survives/dry-run); init.test.ts comment flipped to positive assertions for all 4 resource files; adopt.test.ts asserts cold files.
- Build: needed full `pnpm build` from worktree root first (codev-core wasn't built — pre-existing infra, not my change). Then green.
- Full suite: 163 files / 3310 tests pass, 48 pre-existing skips. Awaiting dev-approval gate.

## dev-approval iter: convention fix (skeleton-sourced content)

- Architect flagged: inline `COLD_TIER_STARTERS` constants in scaffold.ts break the copy-from-skeleton convention. Chose (via question) "minimal starter files in skeleton".
- Refactored: added `codev-skeleton/templates/arch.starter.md` + `lessons-learned.starter.md` (the 4-line placeholders); replaced inline `createColdTierDefaults` with copy-based `copyColdTierDefaults(targetDir, skeletonDir, opts)` that maps starter→dest (arch.starter.md→arch.md). Rich `templates/{arch,lessons-learned}.md` left untouched (manual-cp reference). copyHotTierDefaults untouched.
- COLD_TIER_FILES is now `[{src,dest}]`. Callers pass skeletonDir/templatesDir and use `.copied`.
- Tests updated to mock a skeleton dir; full suite green (163/3310). Smoke: init copies starters → arch.md/lessons-learned.md, no .starter.md leaks into project.
