# Builder thread: pir-1140

PIR strict mode. Issue #1140: `afx workspace recover` respawns builders with the recovery shell's architect instead of their original `spawned_by_architect`.

## Plan phase

- Confirmed the root cause exactly as the issue describes: `BuilderInfo` has no architect field, `deriveBuilderInfo` reads only porch state, and `respawnBuilder` spawns `afx spawn` with inherited env so `CODEV_ARCHITECT_NAME` leaks from the operator's shell into the new builder row.
- Key find: `lookupBuilderSpawningArchitect(builderId, workspacePath)` in `state.ts:537` already implements the needed DB read (string / null / undefined three-valued return) and is already unit-tested. The plan reuses it instead of writing new SQL, keeping recover and message-routing on one source of truth.
- Design choices: keep `deriveBuilderInfo` pure; add an injectable `deriveBuilderInfoWithArchitect(state, lookup)` wrapper (matches the existing DI style of `evaluateEligibility`); add a pure exported `respawnEnv` helper so the env construction is unit-testable; widen the existing try/finally so DB reads finish before `closeGlobalDb()` (which today runs before the row-building loop that will now do lookups).
- Null fallback: legacy rows (null/missing `spawned_by_architect`) pass the caller's env through unchanged, reproducing today's behavior for those rows only; no second copy of the `main` default in recover.
- Plan written to `codev/plans/1140-afx-workspace-recover-respawne.md`, committed, pushed. Sitting at `plan-approval` gate.
- Gate approved 2026-07-07 with no changes requested.

## Implement phase

- Implemented per plan: `BuilderInfo.spawnedByArchitect` (required, nullable), pure `deriveBuilderInfo` sets null, new injectable `deriveBuilderInfoWithArchitect(state, lookup)` wrapper, new pure `respawnEnv(name, baseEnv)` helper, `respawnBuilder` passes `env: respawnEnv(...)`, and the try/finally widened so all global.db reads (sessions + architect lookups via `lookupBuilderSpawningArchitect`) finish before `closeGlobalDb()`.
- Worktree was greenfield (no node_modules): ran `pnpm install --frozen-lockfile` + built codev-core before the package build would pass. Note for future recover-adjacent builders: build core first.
- 11 new tests (6 wrapper, 5 respawnEnv); updated existing `deriveBuilderInfo` expectations and `makeBuilderInfo` for the new field. Targeted file: 57/57 pass. Build clean.
- Sitting at `dev-approval` gate.
- Gate approved 2026-07-08. During the gate the human probed whether the spawning architect should also be recorded in status.yaml; assessment was no (porch is architect-agnostic, status.yaml is git-committed while architect names are workspace-local runtime identity, and duplicating the fact reintroduces the two-sources bug class this issue fixed). No scope change.

## Review phase

- Retrospective written to `codev/reviews/1140-afx-workspace-recover-respawne.md`. No arch-doc changes (fix aligns recover with the documented single-source-of-truth design). One COLD-tier lesson added to `codev/resources/lessons-learned.md` (Architecture): env-derived identity + programmatic re-invocation requires explicitly setting the env from recorded state.
- PR opened; porch ran the single-pass 3-way consultation; waiting at `pr` gate.
