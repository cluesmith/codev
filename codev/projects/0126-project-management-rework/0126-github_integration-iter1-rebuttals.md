# Rebuttals: Phase github_integration, Iteration 1

## Disputed: Missing issue body/comments in prompts (Codex)

Codex claims `buildPhasePrompt()` should pass richer issue context (body, comments) into the prompt template. This is out of scope for Phase 1. The plan specifies Phase 1 delivers `getProjectSummary()` with a **summary string** (the issue title), not full issue context. The spec's `getProjectSummary()` 3-tier fallback is explicitly about returning a title-level summary. Passing full issue body/comments into prompt templates would be a separate enhancement not called for in either the spec or plan.

## Disputed: Spec-file fallback is incomplete — missing first paragraph (Codex)

Codex claims the spec fallback should extract "first heading + first paragraph." The plan explicitly states "spec file first heading" as the fallback content. The implementation matches the plan exactly. Returning the heading alone is sufficient for a summary line — adding a full paragraph would bloat the prompt context unnecessarily.

## Disputed: Legacy zero-padded specs not handled in summary fallback (Codex)

Codex claims the fallback matching doesn't handle legacy zero-padded specs when `projectId` is non-padded (e.g., `"76"` vs `"0076-*.md"`). In practice, `projectId` comes from `state.id` which stores the ID exactly as initialized by porch — including leading zeros (e.g., `"0126"`). The spec file naming convention also uses leading zeros (`0126-project-management-rework.md`). The matching `f.startsWith(projectId + '-')` correctly matches `"0126-"` against `"0126-project-management-rework.md"`. This is not a real-world failure case.
