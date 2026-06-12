# PIR Plan: `codev init` bootstraps `codev/resources/` with arch.md + lessons-learned.md starters

## Understanding

Fresh `codev init` projects have no `codev/resources/` directory. The review prompts of PIR, SPIR, ASPIR, and MAINTAIN unconditionally read `codev/resources/arch.md` (e.g. `codev-skeleton/protocols/spir/prompts/review.md:152` says "Read the current `codev/resources/arch.md`"), so the first review phase in a fresh project errors on a missing file.

Root cause: `createUserDirs` in `packages/codev/src/lib/scaffold.ts:23-44` creates only `specs`, `plans`, and `reviews`. Nothing in the init flow (`packages/codev/src/commands/init.ts:79-140`) creates `codev/resources/`.

These two files are project-specific (each workspace's own architecture and lessons), so the fix is bootstrap-on-init with minimal placeholder content, not resolver fallback (that framework-side concern is #1011).

### Codebase findings worth noting

1. **`copyResourceTemplates` (scaffold.ts:113-145) already exists but is dead code.** No command imports it; only `scaffold.test.ts` exercises it. It copies the skeleton's `templates/arch.md` and `templates/lessons-learned.md` (rich, instructional template stubs) plus `cheatsheet.md` and `lifecycle.md` (framework docs, the #1011 side of the audit). It was orphaned when init/adopt moved to the "minimal structure, framework files resolve from the package" model.
2. **`codev update` already never touches `resources/`** — `update.ts` has no reference to the resources dir. That acceptance criterion is satisfied by the status quo; I will add a guard test so it stays that way.
3. **`codev adopt` refuses to run when `codev/` exists** (`adopt.ts:75-77`), so the "don't clobber existing resources" criterion is structurally unreachable today. The new function still implements skip-if-exists semantics per file, so adopt is safe even if that precondition ever loosens.
4. `init.test.ts:74` carries a comment documenting the current behavior ("resources/ is NOT created in minimal structure") — it must be updated with the new expectation.

## Proposed Change

Add a new `createResourcesDir(targetDir, options)` function to `packages/codev/src/lib/scaffold.ts`, alongside `createUserDirs` / `createProjectsDir`, that:

- Creates `codev/resources/` (mkdir recursive).
- Writes `arch.md` and `lessons-learned.md` with the minimal starter content from the issue (inline string constants in scaffold.ts — no skeleton dependency, since the content is project-owned placeholder, not a framework template).
- **Always skips a file that already exists** (per-file, unconditional). Clobbering an existing arch.md is never correct in any flow, so this is not behind the `skipExisting` option flag.
- Returns `{ created: string[], skipped: string[] }` matching the existing result-shape convention.

Starter content (verbatim from the issue):

`arch.md`:
```markdown
# Architecture

This document evolves as the project grows. Update it during the review phase of any work that introduces or changes architectural patterns.

_No architecture documented yet._
```

`lessons-learned.md`:
```markdown
# Lessons Learned

Durable engineering wisdom captured across the project's work. Update it during the review phase of any work that surfaces a generally-applicable pattern, gotcha, or constraint.

_No lessons captured yet._
```

Wire it into both bootstrap commands:

- `init.ts`: call `createResourcesDir` after `createProjectsDir` (around line 90), print each created file with the existing `+` prefix pattern (`+ codev/resources/arch.md`, `+ codev/resources/lessons-learned.md`), increment `fileCount`.
- `adopt.ts`: same call after `createProjectsDir` (around line 126), same output pattern. Skip-if-exists semantics make this safe by construction.
- `update.ts`: **no change** (resources are project-owned; update must not touch them).

### Why inline content instead of reviving `copyResourceTemplates`

The dead `copyResourceTemplates` copies the skeleton's rich template stubs (~60 lines each of "how to use this template" guidance) into every project. The issue deliberately chose trivial placeholders: enough for the first review-phase `Read` to succeed, with a one-line invitation to grow the file. Seeding every workspace with the same heavyweight generic content is exactly what the issue argues against. Inline constants also remove any dependency on skeleton resolution for this path.

**Open question for the reviewer**: `copyResourceTemplates` remains dead code after this change, and two of the files it copies (`cheatsheet.md`, `lifecycle.md`) belong to the #1011 framework-file story. I propose leaving it untouched here (out of scope) and letting the architect decide whether its removal should be a separate item. If you'd rather I delete it (and its tests) in this PR, say so at this gate.

## Files to Change

- `packages/codev/src/lib/scaffold.ts` — add `createResourcesDir` + the two starter-content constants (after `createProjectsDir`, ~line 223).
- `packages/codev/src/commands/init.ts:86-90` — import and call `createResourcesDir`, print created entries.
- `packages/codev/src/commands/adopt.ts:122-126` — same, in the adopt flow.
- `packages/codev/src/__tests__/scaffold.test.ts` — new `describe('createResourcesDir')`: creates dir + both files with starter content; preserves pre-existing files (write sentinel content, call, assert unchanged and reported in `skipped`).
- `packages/codev/src/__tests__/init.test.ts:68-74` — replace the "resources/ is NOT created" note with positive assertions: `codev/resources/arch.md` and `codev/resources/lessons-learned.md` exist and contain the placeholder markers.
- `packages/codev/src/__tests__/adopt.test.ts` — extend the happy-path adopt test to assert resources files are created.
- (Guard) a test asserting `update.ts` source has no resources-write path, or simpler: an update-flow test asserting pre-existing customized `resources/arch.md` content survives `codev update`. I'll use the behavioral form if the update test harness supports it cheaply; otherwise note in the review file that update's no-touch property is by construction (no code path references resources).

Estimated net diff: ~40 LOC source + ~60 LOC tests.

## Risks & Alternatives Considered

- **Alternative: revive `copyResourceTemplates`** (copy skeleton templates at init). Rejected — see "Why inline content" above; also drags `cheatsheet.md`/`lifecycle.md` (framework files, #1011 territory) into project repos.
- **Alternative: resolver fallback to a skeleton default arch.md.** Rejected by the issue itself — these files are project-specific; a shared default defeats the purpose.
- **Alternative: extend `createUserDirs` instead of a sibling function.** Rejected — `createUserDirs` creates empty dirs with `.gitkeep`; resources needs file content and per-file skip semantics. A sibling keeps both functions simple and matches the issue's suggestion.
- **Risk: existing tests assert resources is absent.** `init.test.ts` only carries a comment (no negative assertion), so breakage risk is low; I'll run the full test suite to confirm.
- **Risk: adopt onto a repo with a hand-made `codev/resources/`.** Unreachable today (adopt aborts when `codev/` exists), and the per-file skip makes it safe regardless.

## Test Plan

- **Unit (scaffold.test.ts)**: `createResourcesDir` creates `codev/resources/arch.md` + `lessons-learned.md` with the starter markers (`_No architecture documented yet._`, `_No lessons captured yet._`); a pre-existing file with sentinel content is left byte-identical and reported as skipped.
- **Unit (init.test.ts)**: `init --yes` produces `codev/resources/` with both starter files.
- **Unit (adopt.test.ts)**: `adopt --yes` on a plain repo produces both starter files.
- **Unit (update)**: customized `resources/arch.md` survives `codev update` unchanged (or by-construction note, per Files to Change).
- **Build + full suite**: `pnpm --filter @cluesmith/codev build && pnpm --filter @cluesmith/codev test` from the worktree.
- **Manual (for the dev-approval reviewer)**:
  1. From the worktree: `pnpm build`, then run the built CLI: `node packages/codev/dist/src/cli.js init /tmp/pir1012-fresh --yes` (or the bin entry point; exact invocation confirmed at implement time).
  2. Verify the init output lists `+ codev/resources/arch.md` and `+ codev/resources/lessons-learned.md`.
  3. `cat /tmp/pir1012-fresh/codev/resources/arch.md` — starter content present; a `Read` of the path succeeds (the original failure mode).
  4. In an adopt-shaped temp dir (no `codev/`), run adopt with `--yes` and verify the same two files appear.
