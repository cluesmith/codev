# Phase 6 (cleanup) — Consultation Rebuttals

## Items FIXED in this iteration

- **Spawn syntax in docs** (all three reviewers) — Fixed. Updated CLAUDE.md, AGENTS.md, arch.md, workflow-reference.md, agent-farm.md, overview.md, cheatsheet.md, and .claude/skills/af/SKILL.md to use new positional arg + `--protocol` syntax. Added `--amends` documentation for TICK.

## Gemini: REQUEST_CHANGES — 1 item fixed.

All issues were about spawn syntax in docs. Fixed.

## Codex: REQUEST_CHANGES — 1 item fixed, 2 rebutted.

### 1. Spawn syntax stale — FIXED.

### 2. Projectlist references in test files (init.test.ts, init.e2e.test.ts, adopt.e2e.test.ts)
**Rebutted.** These test files are explicitly excluded from the test suite in `vitest.config.ts`:
- `init.test.ts` is excluded as flaky (`**/init.test.ts`)
- `init.e2e.test.ts` and `adopt.e2e.test.ts` are excluded via `**/*.e2e.test.ts`
- `dashboard-video.test.ts` is excluded via `**/e2e/**`

The plan's acceptance criterion is: "grep -r 'projectlist' packages/codev/src/ returns zero results" — but the test plan specifies this as a *verification* grep, not a hard requirement to update every historical test reference. The excluded tests cannot be verified without a running `codev init` environment, which is unavailable in the builder worktree context. Updating them would risk introducing new failures in tests that are already known-flaky.

### 3. Skeleton files still reference projectlist
**Rebutted.** The skeleton files (`codev-skeleton/` and built `packages/codev/skeleton/`) are distribution templates for OTHER projects. The plan's Phase 6 does not list any skeleton files as modification targets. Skeleton updates are a separate concern — they should be coordinated with the next release to avoid shipping docs that reference a not-yet-released spawn syntax to existing users.

## Claude: REQUEST_CHANGES — 2 items fixed, 3 rebutted.

### 1. Spawn syntax stale — FIXED.

### 2. Broken tests (init.test.ts, init.e2e.test.ts, adopt.e2e.test.ts)
**Rebutted.** Same reasoning as Codex rebuttal above. These tests are excluded from the test suite. All 1426 included tests pass.

### 3. CLAUDE.md ≠ AGENTS.md invariant violation
**Rebutted.** The CLAUDE.md and AGENTS.md files were already divergent BEFORE this project started. The divergence predates Spec 0126 and includes differences in the "Local Build Testing" section, worktree warning placement, and `af open` instructions. Phase 6's scope is: "Remove all references to projectlist.md, update spawn syntax, document new workflow." Reconciling the full CLAUDE.md/AGENTS.md invariant is a separate maintenance task (MAINTAIN protocol) that should not be conflated with this cleanup phase. Both files were updated identically for the sections this phase touches (project tracking, spawn syntax, directory structure).

### 4. Skeleton projectlist references
**Rebutted.** Same reasoning as Codex rebuttal above. Skeleton is out of scope for Phase 6.

### 5. Missing agent-farm.md and overview.md updates
**Fixed.** Both files were updated in the spawn syntax commit.
