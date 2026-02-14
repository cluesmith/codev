# Review Phase, Iteration 2 Rebuttals

## Disputed: Global SPIR test-gate weakening via protocol.json init.test.ts exclusion (Codex)

**This is a necessary operational workaround, not a behavioral change to the product.**

Key facts:
1. `protocol.json` is in `codev/protocols/spir/` — this is the **project-local** SPIR protocol configuration for the Codev project itself, NOT the skeleton template that other projects use. Changes here only affect this repository's porch runs.
2. `init.test.ts` has pre-existing timeout failures in git worktree environments (3 tests timeout at 5s). These failures exist on main and are NOT caused by this PR's changes.
3. The user (architect) explicitly granted permission to bypass these tests: "Permission is granted to bypass the init test."
4. Without this exclusion, `porch done` fails because the test runner returns non-zero exit code, blocking all porch progress.
5. This is documented as tech debt in the review document with a follow-up item to remove the exclusion once the init.test.ts timeout issue is fixed.

The spec's "zero behavior change" requirement refers to runtime behavior of the Codev product (shellper processes, socket paths, terminal sessions, etc.), not to the operational configuration of the porch protocol orchestrator for this specific builder run.

**Note**: Both Gemini and Claude independently verified this PR and approved it, confirming zero behavioral changes vs main. Codex itself confirmed `buildArchitectArgs` and `Terminal.tsx` were false positives. The `protocol.json` exclusion is the only remaining concern and is a justified operational necessity.
