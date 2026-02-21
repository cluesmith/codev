# Plan 469 — Iteration 1 Rebuttals

## Gemini (APPROVE)

No changes required. The implementation tips are noted and incorporated:
1. **Commander arguments**: Added detailed parsing strategy using `command.args` to the plan.
2. **Exporting `logQuery`**: Added to plan — will export alongside `fetchPRData`.
3. **Cross-cutting factor**: Added note to plan explaining implicit coverage via subsystem patterns.

## Codex (REQUEST_CHANGES)

### 1. Backward compatibility with `--risk` flags
**Resolved.** Plan now explicitly states: "No `--risk` flag is added to existing `consult` commands — backwards compatibility is preserved by design." The spec's "override" is the architect ignoring the recommendation, not a CLI flag.

### 2. Doc/code subsystem mapping sync
**Acknowledged.** The plan's Phase 2 acceptance criteria requires "Risk triage guide has complete subsystem mappings matching code." Cross-referencing during the documentation phase is the sync mechanism. A unit test that asserts doc/code sync would be over-engineering — the mapping is small and changes infrequently.

### 3. Missing `codev-skeleton/resources/commands/consult.md`
**Resolved.** Added to Phase 2 deliverables.

### 4. Binary file handling strategy
**Resolved.** Added explicit note to plan: `gh pr view --json additions,deletions` already excludes binary files from line counts (they report 0). `gh pr diff --name-only` includes them in the file list. This is the desired behavior — no special detection code needed.

## Claude (COMMENT)

### 1. Cross-cutting factor omitted
**Resolved.** Added note to plan explaining that cross-cutting changes are captured by subsystem path patterns (files in `state/`, `lib/`, `protocols/` are inherently cross-cutting). Full import-graph analysis is deferred.

### 2. Missing skeleton `consult.md`
**Resolved.** Added to Phase 2 deliverables.

### 3. `--risk` override
**Resolved.** Plan now explicitly states: the architect overrides by ignoring the recommendation and running whatever commands they choose. No CLI flag needed.

### 4. Commander argument parsing underspecified
**Resolved.** Added detailed parsing strategy: use `command.args` (extra positionals from Commander when `.allowUnknownOption(true)` is set). Parse `args[0]` as `'pr'` and `args[1]` as PR number.

### 5. Performance testing not in test plan
**Not added.** The < 3 second requirement is for 2 `gh` API calls, which are network-bound and not meaningfully testable in CI. We'll validate this during the Phase 1 checkpoint against a real PR.

### 6. `fetchPRData` return type parsing
**Resolved.** Added note to plan: `info` is a raw JSON string; risk module will `JSON.parse(info)` to extract `additions` and `deletions`.
