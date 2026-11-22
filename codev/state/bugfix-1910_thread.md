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

## PR #1949 — CMAP iter 1

- gemini: skipped (agy CLI not installed on this host, non-blocking). codex: APPROVE.
- claude: REQUEST_CHANGES, all valid. The templates still ended with "Read the full protocol
  documentation in `codev/protocols/`" (and three cheatsheet copies), which contradicted the new
  line. The guard missed directory and `<placeholder>` forms, and it allowed any line containing
  the word "local". Fixed: reworded those sites, the templates' Key Locations line, consult.md's
  prompt-load sentence and the consult SKILL line (all four copies). The guard now flags any
  `codev/protocols|roles/` mention unless the line explains customization or resolution, or is a
  risk-triage table row.

## Owner scope addition (2026-11-22, via architect)

- Added one rule, worded the same everywhere: never search from the filesystem root; search the
  project or use built-in file search; a framework file not in the project is delivered another
  way. Placed in builder.md (new "Finding files" section), architect.md (Boundaries),
  consultant.md (File Access Rules) and the CLAUDE/AGENTS templates (File Resolution), both
  trees. The guard test pins it.
- The second full run caught the consult SKILL edit against the shipped-skill hash history.
  Regenerated with `generate-skill-hashes`.
