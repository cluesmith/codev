# Builder thread: pir-1140

PIR strict mode. Issue #1140: `afx workspace recover` respawns builders with the recovery shell's architect instead of their original `spawned_by_architect`.

## Plan phase

- Confirmed the root cause exactly as the issue describes: `BuilderInfo` has no architect field, `deriveBuilderInfo` reads only porch state, and `respawnBuilder` spawns `afx spawn` with inherited env so `CODEV_ARCHITECT_NAME` leaks from the operator's shell into the new builder row.
- Key find: `lookupBuilderSpawningArchitect(builderId, workspacePath)` in `state.ts:537` already implements the needed DB read (string / null / undefined three-valued return) and is already unit-tested. The plan reuses it instead of writing new SQL, keeping recover and message-routing on one source of truth.
- Design choices: keep `deriveBuilderInfo` pure; add an injectable `deriveBuilderInfoWithArchitect(state, lookup)` wrapper (matches the existing DI style of `evaluateEligibility`); add a pure exported `respawnEnv` helper so the env construction is unit-testable; widen the existing try/finally so DB reads finish before `closeGlobalDb()` (which today runs before the row-building loop that will now do lookups).
- Null fallback: legacy rows (null/missing `spawned_by_architect`) pass the caller's env through unchanged, reproducing today's behavior for those rows only; no second copy of the `main` default in recover.
- Plan written to `codev/plans/1140-afx-workspace-recover-respawne.md`, committed, pushed. Sitting at `plan-approval` gate.
