# Rebuttal: review iteration 1

## Codex (REQUEST_CHANGES)

### Issue 1: Tower diagram still uses `/project/` and `projectPath` labels

**Action**: Fixed. Updated diagram labels from "Project A/B" to "Workspace A/B", paths from `/project/enc(A)/` to `/workspace/enc(A)/`, and Map key from `projectPath` to `workspacePath`.

### Issue 2: `/api/stop` doc claims `projectPath`/`basePort`

**Action**: Fixed. Updated to `workspacePath` only (basePort was removed in Spec 0098).

### Issue 3: Residual "project" in invariant #2

**Action**: Fixed. Changed "which terminals belong to which project" to "which terminals belong to which workspace".

## Gemini (APPROVE)

### Minor note: "Project shows inactive" in tracing guide

**Action**: Fixed. Updated to "Workspace shows inactive" for consistency.

## Claude (APPROVE) -- No action needed.
