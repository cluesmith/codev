# PIR Review: Gitignore Architect State Files Across init/adopt/update/doctor

Fixes #1192

## Summary

Architect state files (`codev/state/<name>.md`, read/written by `/arch-init` from PR #1136) are per-person and were neither tracked nor gitignored, risking cross-team collisions if ever committed. This PR adds the ignore rule pair `codev/state/*.md` / `!codev/state/*_thread.md` to the single constant all three scaffold commands (`init`, `adopt`, `update`) already share, so the fix lands in all three at once, and adds a new `codev doctor` audit (`auditStateFileIgnore`) that verifies the split is actually in effect by probing real `git check-ignore` behavior rather than string-matching `.gitignore` text — which also catches an already-tracked architect state file and a shadowed-negation ordering bug that string matching would miss.

## Files Changed

- `packages/codev/src/lib/gitignore.ts` (+88) — rule pair added to `CODEV_GITIGNORE_ENTRIES` via two named constants (`STATE_IGNORE_RULE`, `THREAD_KEEP_RULE`), new `auditStateFileIgnore()` function
- `packages/codev/src/commands/doctor.ts` (+4) — wires the audit into `checkCodevStructure`'s existing warnings list
- `packages/codev/src/__tests__/gitignore.test.ts` (+128) — new suites for the rule pair, an end-to-end `git check-ignore` validity test, and 5 `auditStateFileIgnore` cases
- `packages/codev/src/__tests__/doctor.test.ts` (+24) — extended the "properly migrated" mock to answer the new `git check-ignore`/`ls-files` calls realistically
- `packages/codev/src/__tests__/update.test.ts` (+4) — updated two pre-existing #880 regression tests whose `gitignoreAdded` expectations were exact-array-equality and needed the two new entries appended
- `.gitignore` (+4) — this repo's own gitignore gained the rule pair
- `.claude/skills/arch-init/SKILL.md` / `codev-skeleton/.claude/skills/arch-init/SKILL.md` (+3 each, byte-identical) — one-line versioning-stance note
- `codev/plans/1192-gitignore-architect-state-file.md`, `codev/state/pir-1192_thread.md` — plan + builder thread log

## Commits

- `573b2e79` [PIR #1192] Plan draft
- `5fde36cf` [PIR #1192] Gitignore architect state files across init/adopt/update, audit in doctor
- `c867ce14` [PIR #1192] Repo gitignore rule pair and arch-init versioning note (both trees)
- `7638b065` [PIR #1192] Single-source the state-file gitignore rule pair

## Test Results

- `pnpm --filter @cluesmith/codev build`: ✓ pass
- `pnpm --filter @cluesmith/codev test`: ✓ pass (3528 passed, 48 skipped, 0 failed; 8 new tests)
- `npx tsc --noEmit`: ✓ pass
- Manual verification (dev-approval gate):
  - Built CLI `codev init` in a scratch dir → `.gitignore` contains the rule pair; `git check-ignore codev/state/main.md` ignored, `git check-ignore codev/state/x_thread.md` not ignored.
  - Built CLI `codev update` against a pre-#1192 `.gitignore` → appends exactly the two lines under a dated header.
  - Compiled `auditStateFileIgnore()` exercised directly against scratch git repos: emits the "not gitignored" warning when the rule is absent, and the "tracked by git" warning (naming the file, recommending `git rm --cached`) when an architect state file was force-added.
  - In this worktree: `git check-ignore codev/state/main.md` succeeds; `git check-ignore codev/state/pir-1192_thread.md` does not — confirming the split is live here too.

## Architecture Updates

Added to `codev/resources/arch.md`, appended to the existing `/arch-init` paragraph in **Agent Farm Internals** (the section already described `codev/state/<name>.md` state recovery, so the versioning fact belongs right next to it): the per-person/gitignored vs. builder-thread/versioned split, which constant sources the rule pair, and which function audits it.

No `arch-critical.md` (HOT tier) change — the file is at its 10-fact cap, and this fact is narrow enough (specific to the `codev/state` directory and `/arch-init`) that it doesn't warrant displacing an existing cross-cutting fact. The hot-tier map already points readers to "Agent Farm Internals" for state/terminal/messaging topics, which now covers this detail too.

## Lessons Learned Updates

Added to `codev/resources/lessons-learned.md` under **Testing**: probe the tool's actual resolved behavior (`git check-ignore` on a phantom path) rather than string-matching config text when auditing config-driven behavior — string matching misses rule-ordering bugs (a negation shadowed by a later conflicting rule) and false-positives on a user's equivalent-but-differently-worded rule. This generalizes beyond gitignore to any "is this configuration actually in effect" check, so it's cold-tier reference rather than a hot-tier behavior-changer.

No `lessons-critical.md` (HOT tier) change, for the same cap/narrowness reasoning as above.

## Things to Look At During PR Review

- **`STATE_IGNORE_RULE`/`THREAD_KEEP_RULE` single-sourcing** (`gitignore.ts:16-37`): these were originally duplicated as separate literals inside `auditStateFileIgnore`'s warning strings and in `CODEV_GITIGNORE_ENTRIES`. Refactored during dev-approval review to define them once and have `CODEV_GITIGNORE_ENTRIES` interpolate them, removing the duplicate declaration. Worth a second look that the constants are exported cleanly and nothing else in the file still hardcodes the literal strings.
- **Why `git check-ignore` over string-matching** (`gitignore.ts:181-232`): discussed at length at the dev-approval gate — string-matching each line of `CODEV_GITIGNORE_ENTRIES` for presence in `.gitignore` would miss the shadowed-negation ordering bug (the `warns when a later rule shadows the thread-file negation` test case) and false-positive on a user's differently-worded-but-equivalent rule. Kept as probing real git behavior; the reasoning is captured as a lessons-learned entry above.
- **Scope boundary**: the audit only checks the two rules this issue introduces, not the other five entries in `CODEV_GITIGNORE_ENTRIES` (`.agent-farm/`, `.consult/`, etc.) — those already self-heal silently via `codev update`/`adopt` and have a materially lower failure cost (clutter, not a per-person collision hazard). A general "verify all Codev gitignore entries" audit was intentionally left as a possible separate follow-up, not folded into this PR.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-1192` → **Review Diff**
- **Run dev**: `afx dev pir-1192` (not applicable here — this is a CLI-only change with no dev server)
- **What to verify**:
  - `cd packages/codev && pnpm build && pnpm test` — build and full suite green
  - In a scratch dir, run the built `codev init`, then `git init` and confirm `git check-ignore codev/state/main.md` succeeds while `git check-ignore codev/state/x_thread.md` fails
  - Run the built `codev update` against a `.gitignore` missing the rule pair — confirm it backfills both lines under a dated header
  - Run the built `codev doctor` in a repo missing the rule — confirm the new warning appears; force-add a fake `codev/state/main.md` and confirm doctor flags it as tracked

## Flaky Tests

None encountered.
