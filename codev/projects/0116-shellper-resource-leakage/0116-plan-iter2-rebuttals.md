# Plan Iteration 2 Rebuttals

## Disputed: Teardown semantics must use workspace deactivation, not terminal DELETE

**Codex concern**: The spec requires workspace deactivation in `afterEach`/`afterAll`, but the plan uses terminal DELETE in `afterAll` only, which "leaves intra-suite leak windows open."

**Rebuttal**: The reviewer conflates two different terminal creation paths that require different cleanup strategies:

1. **Workspace-activated terminals** (created via `POST /api/workspaces/.../activate`): These are cleaned up by calling `deactivateWorkspace()`, which triggers `stopInstance()` → `killSession()` → full cleanup. Two E2E files use this path:
   - `tower-baseline.e2e.test.ts` — already has `deactivateWorkspace()` in `afterEach` (lines 250-253, 329-330, 377-378, 441-444)
   - `bugfix-202-stale-temp-projects.e2e.test.ts` — already deactivates inline within each test (lines 132, 167)

   **These files already have proper workspace deactivation. No changes needed.**

2. **API-created terminals** (created via `POST /api/terminals`): These are NOT created through workspace activation and are NOT associated with a workspace. Calling `deactivateWorkspace()` would not clean them up. The correct cleanup path is `DELETE /api/terminals/{id}`. Three E2E files use this path:
   - `tower-terminals.e2e.test.ts`
   - `tower-api.e2e.test.ts`
   - `bugfix-199-zombie-tab.e2e.test.ts`

**The plan's approach is correct for each creation path.** The spec's general principle ("deactivate workspaces for cleanup") is satisfied where applicable. For API-created terminals, terminal DELETE is the semantically correct cleanup, not workspace deactivation.

**Evidence**: Verified by reading the E2E test source files and the Tower route handlers. `POST /api/terminals` creates terminals independently of workspace state; `deactivateWorkspace()` only cleans up terminals registered to that workspace's instance.
