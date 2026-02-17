# Review Phase — PR Consultation Rebuttals

## Verdicts

- **Gemini**: APPROVE (HIGH confidence) — no changes requested.
- **Claude**: APPROVE (HIGH confidence) — no changes requested.
- **Codex**: REQUEST_CHANGES (HIGH confidence) — 6 findings.

## Codex Findings

### 1. `--resume` does not infer protocol before mode selection
**Rebutted.** The code is correct. `getSpawnMode()` routes to `spawnSpec()` by default when no `--protocol` is provided. Inside `spawnSpec()`, `resolveIssueProtocol()` calls `inferProtocolFromWorktree()` which reads the protocol from the existing worktree's status.yaml. The protocol inference happens at the right architectural layer (inside the handler, not in mode selection). Both Gemini and Claude reviewed the same code and found no issue.

### 2. Zero-padded spec ID fallback in getProjectSummary()
**Fixed.** Changed spec file matching from `f.startsWith(projectId + '-')` to a regex that extracts the leading numeric prefix and compares with leading zeros stripped. Now handles both `42-name.md` and `0042.name.md` formats.

### 3. Heading-only summary (no first paragraph)
**Rebutted.** The summary is used as a one-line project description in porch prompts and the overview API. A single heading line is appropriate for this use case — including the first paragraph would produce multi-line summaries that don't fit the UI layout (builder cards, backlog list items). The spec says "project summary" not "project description."

### 4. Bugfix builder issue numbers lost in overview
**Fixed.** Added fallback regex extraction of trailing digits from the parsed ID. `parseInt('builder-bugfix-315')` → NaN → regex match `(\d+)$` → 315. This correctly handles bugfix-style builder IDs while preserving the direct numeric parse for SPIR/TICK builders.

### 5. Collapsed file panel search is dead input
**Rebutted.** This was already addressed in Phase 5 rebuttals. The collapsed search input is an intentional UX pattern — it acts as a focus trigger that opens the full file panel with the real FileTree search. This is the same pattern used by VS Code's collapsed explorer search. The `onFocus` handler immediately opens the panel where the user can then type in the actual search input.

### 6. Terminal persistence test expects old tab/panel names
**Fixed.** Updated `tab-dashboard` → `tab-work` (3 occurrences) and `status-panel` → `work-view` (1 occurrence) in `App.terminal-persistence.test.tsx`. Note: this test runs via the dashboard's own vitest config, not the main test suite or CLI tests that porch verifies.
