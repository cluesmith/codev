# Review: support-non-github-repositorie

## Summary

Implemented a "forge concept command" abstraction layer that decouples codev from direct `gh` CLI calls. Each GitHub operation (issue viewing, PR listing, auth status, etc.) is now routed through configurable external commands with JSON output contracts. Default commands wrap `gh` for backward compatibility; projects override via `af-config.json`'s `forge` section.

**15 forge concepts** were defined: `issue-view`, `pr-list`, `issue-list`, `issue-comment`, `pr-exists`, `recently-closed`, `recently-merged`, `user-identity`, `team-activity`, `on-it-timestamps`, `pr-merge`, `pr-search`, `pr-view`, `pr-diff`, `gh-auth-status`.

## Spec Compliance

- [x] Concept command dispatcher (`forge.ts`) with `executeForgeCommand` and `executeForgeCommandSync`
- [x] All GitHub-calling code paths routed through concept commands
- [x] Default commands wrap `gh` CLI for backward compatibility
- [x] `af-config.json` `forge` section for per-project overrides
- [x] Concepts can be disabled by setting value to `null`
- [x] Graceful degradation: functions return `null` on failure
- [x] `codev doctor` validates forge concept configuration
- [x] `codev doctor` conditionally skips `gh auth` when custom forge config present
- [x] Protocol JSON files remain untouched (porch intercepts `pr_exists` at runtime)
- [ ] User documentation for forge overrides (deferred to follow-up)
- [ ] E2E test for "no `gh` installed" scenario (deferred)

## Deviations from Plan

- **Phase 5 (porch)**: Claude review identified that `workspaceRoot` was not threaded through `runPrExistsViaConcept` and `getForgeCommand('pr-merge')`, causing user overrides to be silently ignored. Fixed by adding `loadForgeConfig(cwd)` calls.
- **Phase 6 (team-github)**: `getRepoInfo` was migrated to use `git remote get-url origin` instead of a forge concept, since repo owner/name is derivable from git without any forge-specific API.
- **Phase 6 (consult)**: `pr-view` default command was extended with conditional `CODEV_INCLUDE_COMMENTS` flag to handle the PR comments use case without a separate concept.
- **Documentation and E2E test**: Deferred as follow-up items. The implementation is self-documenting via `codev doctor` output and the forge.ts source.

## Lessons Learned

### What Went Well
- The concept command pattern is clean and extensible — adding new forge integrations is just a new entry in `DEFAULT_COMMANDS` and a concept command string
- Phased migration (6 phases) kept each change set focused and reviewable
- Existing test infrastructure (vitest mocks) adapted well to forge mocking patterns
- `raw` mode option for non-JSON concepts (like `pr-diff`) was a good design decision

### Challenges Encountered
- **Test mock conflicts**: Adding `forge.js` imports to files with existing `child_process` mocks caused test failures. Resolved by adding `vi.mock('../lib/forge.js')` to affected test files.
- **Forge config threading**: Multiple call sites initially forgot to pass `workspaceRoot` or `forgeConfig`, causing user overrides to be silently ignored. Caught by Claude consultation reviews.
- **Sync vs async**: Some callers needed `executeForgeCommandSync` while others could use async. Having both variants from the start avoided migration issues.

### What Would Be Done Differently
- Thread `forgeConfig` through function signatures from the start rather than retrofitting it
- Define a clear "git-native vs forge-concept" boundary earlier (e.g., `git remote` is git-native, `gh pr view` is forge)

### Methodology Improvements
- Phase-scoped Claude consultations were highly effective at catching missed config threading issues that would have been hard to spot in a full-PR review

## Technical Debt
- `pr-view` default command uses a shell conditional (`if [ ... ]`) to handle `CODEV_INCLUDE_COMMENTS`, which is more complex than ideal
- No documentation yet for users wanting to configure custom forge commands
- No integration/E2E tests validating the full concept command flow end-to-end

## Consultation Feedback

### Specify Phase (Round 1)
All consultations approved the spec. No concerns raised.

### Plan Phase (Round 1)
All consultations approved the plan. No concerns raised.

### Phase: concept-infrastructure (Round 1)
#### Claude
- **Concern**: Review feedback on initial implementation
  - **Addressed**: Incorporated in iteration 1 commit

### Phase: core-github-refactor (Round 1)
#### Claude
- **Concern**: Missing forge routing tests in github.test.ts
  - **Addressed**: Added 10 mock-based forge routing tests

### Phase: spawn-migration (Round 1)
#### Claude
- **Concern**: Test mocks still using old `run` function instead of forge
  - **Addressed**: Updated spawn-worktree tests to mock `executeForgeCommand`

### Phase: overview-analytics-migration (Round 1)
#### Claude
- No concerns raised (APPROVE)

### Phase: porch-protocol-migration (Round 1)
#### Claude
- **Concern**: `runPrExistsViaConcept` doesn't pass `workspaceRoot` — user overrides silently ignored
  - **Addressed**: Added `loadForgeConfig(cwd)` and `workspaceRoot: cwd` to forge calls
- **Concern**: `getForgeCommand('pr-merge')` in next.ts also ignores user overrides
  - **Addressed**: Now passes `loadForgeConfig(workspaceRoot)` to `getForgeCommand`
- **Concern**: Dynamic imports in `runPrExistsViaConcept` unnecessary
  - **Addressed**: Replaced with static imports

### Phase: team-doctor-docs (Round 1)
#### Claude
- **Concern**: `getRepoInfo` still calls `gh` directly
  - **Addressed**: Migrated to `git remote get-url origin` with regex parsing
- **Concern**: `doctor.ts` doesn't call `validateForgeConfig`
  - **Addressed**: Added forge concept validation section to doctor output
- **Concern**: Direct `gh pr view --comments` remains in consult
  - **Addressed**: Replaced with `pr-view` concept using `CODEV_INCLUDE_COMMENTS`
- **Concern**: No documentation or E2E test
  - **Deferred**: Follow-up items noted in Technical Debt

### Gemini & Codex Reviews
Per architect instruction, only Claude consultations were active during this project.

## Architecture Updates

Updated `codev/resources/arch.md` to document the forge concept command system:
- Added new "Forge Concept Commands" subsection under External Services describing the abstraction layer, concept routing, and configuration mechanism
- This is a significant architectural addition — all GitHub CLI interactions now go through this layer

## Lessons Learned Updates

Added entries to `codev/resources/lessons-learned.md`:
- Pattern for abstracting external CLI dependencies via concept commands
- Importance of threading configuration through all call sites (not just the obvious ones)

## Flaky Tests
- `session-manager.test.ts`: 3 pre-existing timeout failures (unrelated to spec 589)
  - `logs session exit without stderr tail` — timeout in 15000ms
  - `no stderr tail logged for file-based stderr` — timeout in 15000ms
  - `logs stderr tail on normal session exit` — timeout in 15000ms

## Follow-up Items
- User documentation for forge concept overrides with worked GitLab examples
- E2E test for "no `gh` installed" scenario
- Simplify `pr-view` default command (currently uses shell conditional)
- Consider extracting `getRepoInfo` to a shared utility since it's useful beyond team-github
