# Spec 0106 — Iteration 1 Rebuttals

## Disputed: Dual-path fallback / backward-compatibility logic for session continuity

**Raised by**: All three reviewers (Gemini, Codex, Claude)

All reviewers suggested the spec needs dual-path probing, symlink strategies, or fallback logic for existing sessions. This is unnecessary complexity for a development tool.

**Evidence**:
- Codev is a development tool, not a production server. Sessions are ephemeral (typically minutes to hours).
- The migration (v8) renames columns, updates stored socket path values, AND renames physical socket files on disk. This covers the complete path.
- If an actively-running shepherd process can't have its socket renamed, marking that session stale is acceptable — the user simply restarts it.
- Adding dual-path probing or backward-compatibility shims contradicts the project CLAUDE.md principle: "Do not add unnecessary complexity" and "NEVER IMPLEMENT FALLBACKS."

**Resolution**: The updated spec now explicitly states "clean break is acceptable" with clear migration steps (column rename + value UPDATE + file rename). No fallback logic needed.

## Disputed: Security/logging/privacy verification needed

**Raised by**: Codex

The spec is a pure rename — socket permissions, file locations, and trust boundaries are completely unchanged. Verifying that a search-and-replace didn't change security properties is redundant when the rename is mechanical and the test suite validates behavior.

**Resolution**: No change needed. The acceptance criteria (tests pass, build succeeds, grep clean) are sufficient for a rename refactor.

## Disputed: Rollback/downgrade handling in migration

**Raised by**: Codex

SQLite migrations in this codebase are forward-only. There is no downgrade path in the existing migration system. Adding one for a rename would be scope creep.

**Resolution**: No change needed. Consistent with existing migration pattern (v1-v7 are all forward-only).
