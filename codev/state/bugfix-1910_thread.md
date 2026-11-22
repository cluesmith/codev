# bugfix-1910 thread

## Investigate (2026-11-23)

- Reproduced by grep: shipped text names framework files by location (`protocols/spir/templates/spec.md`,
  `codev/protocols/<name>/protocol.md`, `../protocols/spir/protocol.md`, `codev/roles/<x>.md`). In an
  adopter workspace those resolve from the installed package and are not on disk, so an agent that
  reads them literally searches for them (`find /` on Windows — Spec 1658 M14).
- Architect scope (2026-11-22): cause 1 only (wording); cause 2 (orphaned children on Windows) is #1915.
  Re-grep both trees, not just the issue's list.
- Sites beyond the issue's list: `resources/workflow-reference.md`, `resources/commands/overview.md`,
  `resources/commands/consult.md`, `resources/risk-triage.md` (both trees). They are framework
  files `codev update` treats as updatable.

## Fix

- Reworded every site in both trees; CLAUDE.md/AGENTS.md templates keep their shared body and the
  two trees stay byte-identical.
- The spec-review edit trips the Spec 1280 deletion guard by design: re-baselined the two
  spec-review fixtures and logged R9 in `codev/resources/1280-retirements.md`.
- `framework-ref-audit.ts` comment called the protocol-path list "intentional"; corrected.
- New guard: `packages/codev/src/__tests__/bugfix-1910-framework-paths.test.ts`.
