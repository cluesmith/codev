# Builder thread: pir-1012

Issue #1012 — scaffold: `codev init` bootstraps `codev/resources/` with arch.md + lessons-learned.md starters. Protocol: PIR (strict, porch-driven).

## Plan phase

- Investigated scaffold flow. Root cause confirmed: `createUserDirs` (scaffold.ts:23) only creates specs/plans/reviews; nothing in init/adopt creates `codev/resources/`.
- Found `copyResourceTemplates` (scaffold.ts:113) is **dead code** — exported, tested, but no command calls it. It would copy the skeleton's rich template stubs plus framework docs (cheatsheet.md, lifecycle.md → #1011 territory). Plan proposes inline minimal starters instead, leaving the dead function untouched (flagged as an open question at the plan gate).
- `codev update` already never touches resources — acceptance criterion satisfied by status quo; adding a guard test.
- `codev adopt` aborts when `codev/` exists, so the "don't clobber" criterion is structurally unreachable; new function uses per-file skip-if-exists anyway.
- Plan written to `codev/plans/1012-scaffold-codev-init-bootstraps.md`. Awaiting plan-approval gate.
