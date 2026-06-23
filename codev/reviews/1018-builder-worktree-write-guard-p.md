# PIR Review: Builder worktree write-guard

Fixes #1018

## Summary

Strict-mode builders run in a git worktree nested inside the main checkout; the runtime sometimes synthesizes an absolute `Write`/`Edit` path anchored at the inferred repo root, dropping the `.builders/<id>/` segment so the write silently lands in the main checkout. This PR installs a deterministic Claude **PreToolUse hook** into every builder worktree at spawn time that denies `Write`/`Edit` to paths resolving outside the worktree root (allowlisting temp dirs and `~/.claude`), turning a silent main-checkout pollution into a loud, correctable deny. A role-doc backstop documents the failure mode and the relative-path discipline that covers the Bash write surface.

## Files Changed

- `packages/codev/src/agent-farm/utils/worktree-write-guard.ts` (+233 / -0) — new; single source of truth (guard script string + `buildWorktreeGuardFiles()`)
- `packages/codev/src/__tests__/worktree-write-guard.test.ts` (+214 / -0) — new; 14 cases exercising the emitted script + the file builder
- `packages/codev/src/agent-farm/utils/harness.ts` (+12 / -2) — `CLAUDE_HARNESS.getWorktreeFiles` emits the guard; signature gains `worktreePath`
- `packages/codev/src/agent-farm/commands/spawn-worktree.ts` (+9 / -4) — `writeWorktreeFiles` `mkdir -p`s the target dir; both call sites pass `worktreePath`
- `packages/codev/src/agent-farm/__tests__/harness.test.ts` (+11 / -4) — contract update (CLAUDE_HARNESS now has `getWorktreeFiles`)
- `codev/roles/builder.md` (+21 / -0) — worktree path-discipline backstop
- `codev-skeleton/roles/builder.md` (+21 / -0) — identical mirror
- `codev/resources/arch.md` (+9 / -0) — COLD: write-guard mechanism under Worktree Management
- `codev/resources/lessons-learned.md` (+3 / -0) — COLD: deterministic-guard / scope-the-hazard / mkdir-before-write lessons

## Commits

- `93f455de` [PIR #1018] Add worktree write-guard hook for Claude builders
- `d5ec7156` [PIR #1018] Test the write-guard script and CLAUDE_HARNESS wiring
- `84b2f7b1` [PIR #1018] Document worktree path-discipline backstop in builder role
- `10aa6095` [PIR #1018] Update builder thread for implement phase
- (plus the review/retrospective commit on top)

## Test Results

- `npm run build`: ✓ pass (porch check, 6.8s)
- `npm test`: ✓ pass (porch check, 20.2s; 3358 passed, 0 failed, 48 skipped) — 14 new tests in `worktree-write-guard.test.ts`
- Manual verification (human, at the `dev-approval` gate): the running worktree was reviewed and approved.

Note on running the suite: a full `npm run build` must precede `npm test`. The terminal `session-manager` *integration* tests spawn and connect to the built shellper binary; without a prior full build they fail to connect. This is environmental and unrelated to this change — confirmed by the suite passing cleanly after `npm run build`.

## Architecture Updates

**COLD** — added a "Worktree Write-Guard (Issue #1018)" subsection to `codev/resources/arch.md` under Worktree Management: the failure mode, the hook mechanism, where it's wired (`CLAUDE_HARNESS.getWorktreeFiles` → `writeWorktreeFiles`), the allowlist, fail-open behavior, baked-in `CODEV_WORKTREE_ROOT` with `git rev-parse` fallback, and scope (write surface / Claude only / architect unaffected / #1092 separate).

**HOT** — no change. The hot `arch-critical.md` is capped and full; this fact is reference detail that belongs in the cold archive, and the existing "Worktrees in `.builders/` are Agent-Farm-managed" hot fact already covers the always-on invariant.

## Lessons Learned Updates

**COLD** — added three entries to `codev/resources/lessons-learned.md` (Architecture):
1. Against a moving runtime, only a deterministic guard holds — instructions/memory/bisect don't.
2. A guard's surface and blast radius must match the hazard, not the role (builder-only, write-only by design; architect owns `main`; reads stay unguarded to preserve cross-checkout reads).
3. `writeFileSync` doesn't create parent dirs and git only materializes dirs with tracked files — `mkdir -p` before writing a generated file into a worktree subdir.

**HOT** — no change. `lessons-critical.md` is capped and full; the closest existing hot lesson ("When guessing fails, build a minimal repro") is adjacent but distinct, and these are spec-narrow recipes better kept cold.

## 3-Way Consultation Outcome (single advisory pass)

- **Gemini**: APPROVE (HIGH). **Claude**: APPROVE (HIGH). **Codex**: REQUEST_CHANGES (HIGH).
- **Codex finding (addressed):** the guard was only emitted in the *role-bearing* spawn branches, so a Claude builder spawned **without a role** fell through the unguarded `else` branches in `startBuilderSession` and `buildWorktreeLaunchScript` and never received the guard — not deterministic across all spawn modes. Real gap; fixed. Harness-file installation is now role-independent via a shared `installHarnessWorktreeFiles()` helper called from **all four** fresh-spawn branches (role + no-role, both functions). Added two regression tests in `spawn-worktree.test.ts` asserting the guard files are written for Claude both with and without a role; the no-role one fails without this fix.
- **Claude minor observation (noted, not changed):** if an adopter already has a `.claude/settings.local.json` containing its own `hooks.PreToolUse`, `writeWorktreeFiles`'s shallow merge (`{...existing, ...incoming}`) overwrites the whole `hooks` key. Near-zero risk today (fresh worktree; the file is generated/untracked), so deferred — flagged here for a future deep-merge iteration if needed.
- **Known edge (not a spawn-mode gap):** the `--resume` path reuses an existing worktree and does not re-emit; a worktree first spawned *before* this feature and later resumed won't retroactively get the guard. `afx setup` or a fresh spawn covers it.
- PIR is single-pass — none of the above was independently re-reviewed by the models. The human at the `pr` gate is the remaining check on the fix.

## Things to Look At During PR Review

- **Allowlist policy** (`worktree-write-guard.ts`): temp dirs + `$HOME/.claude`. The `~/.claude` entry is deliberate so builder *memory* writes are not blocked. A consequence worth a conscious nod: symlinked shared root config (`.codev/config.json`, `.env`) resolves outside the worktree and is **denied** for writes — judged correct (a builder should not mutate shared root config), but it is a behavior boundary.
- **Fail-open philosophy**: any error (bad JSON, unresolvable root) allows the call. A safety net must never brick a builder; worst case reverts to today's unguarded behavior.
- **Path canonicalization**: realpath-of-longest-existing-ancestor + re-append tail, so non-existent new files resolve correctly and macOS `/tmp`→`/private/tmp` is normalized. Covered by tests, but the trickiest part to get right.
- **Determinism vs. fallback**: `CODEV_WORKTREE_ROOT` is baked at spawn (absolute); `git rev-parse --show-toplevel` is the runtime fallback. Both are canonicalized.
- **Scope decision** (recorded at the plan gate): builder-only. The architect/builder asymmetry rationale is in the Lessons Learned. #1092 (consult sub-agent read surface) is intentionally out of scope; the guard module is factored so its boundary logic could later back a consult-side hook.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-1018` → **Review Diff**
- **Run dev server**: VSCode sidebar → **Run Dev Server**, or `afx dev pir-1018`
- **What to verify** (spawn a throwaway builder against this branch):
  - A `Write` to a main-checkout path (e.g. `<repo>/codev/plans/zzz.md`) is **blocked** with a re-root message.
  - A `/tmp` (or scratchpad) write **passes**.
  - A genuine sibling-thread / cross-checkout **read** still works (reads unaffected).
  - A `~/.claude/...` memory write **passes**.
  - A correctly worktree-rooted Write **passes** and lands in the worktree; the main checkout is untouched.
