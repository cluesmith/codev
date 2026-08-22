# Builder pir-1536 — thread log

Issue #1536: extend the #1018 worktree write-guard to Bash (reads/executions, not just writes).

## PLAN phase (2026-08-22)

- Investigated the #1018 guard: single source of truth is
  `packages/codev/src/agent-farm/utils/worktree-write-guard.ts` — the emitted `.cjs`
  string (`WORKTREE_WRITE_GUARD_SCRIPT`) + `buildWorktreeGuardFiles()` (settings matcher
  `Write|Edit|MultiEdit`). Wired into spawn via `harness.ts:174` (`getWorktreeFiles`).
- Guard currently derives ONE root (worktree). Main checkout = worktree minus the trailing
  `/.builders/<id>` — cheap to derive in the hook.
- Architect pre-plan notes: (1) the ONLY open gate decision is the escape-hatch shape —
  present options + recommendation + failure modes; everything else in the fix sketch is
  settled. (2) Self-test by pipe-testing the emitted `.cjs` with synthetic JSON + extending
  the vitest suite; my own live hook came from the INSTALLED package, editing source won't
  change my session. (3) cwd-instability observation is out of scope.
- Wrote plan to `codev/plans/1536-builder-bash-commands-can-sile.md`. Escape-hatch
  recommendation: **Option B — per-command sentinel comment** (`# codev:allow-main-checkout`),
  non-sticky, loud, auditable. Rejected A (sticky env toggle — reintroduces the silent hole).
  C (no hatch) offered as a strict fallback.
- Files to change: guard source (`.cjs` + matcher + doc), its test, harness.test.ts matcher
  assertion, and the worktree-discipline prose in BOTH builder role docs.
- Irony noted: I am a builder subject to the exact trap I'm fixing; keeping verification
  commands relative / worktree-absolute.

Next: awaiting plan-approval gate.
