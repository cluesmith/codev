# Review 671: Hermes Consult Backend (Optional, Not Default)

## Summary
Implemented Hermes as an additional consult backend and kept default consultation fan-out unchanged. Added large-prompt protection for Hermes to avoid CLI argument length failures. Updated docs and tests accordingly.

## Spec Compliance
- [x] Hermes backend available via `consult -m hermes`.
- [x] Porch validation accepts `hermes`.
- [x] Default consultation models remain `gemini`, `codex`, `claude`.
- [x] Large Hermes prompts use temp-file indirection (ARG_MAX/E2BIG mitigation).
- [x] Source/skeleton docs synchronized and clarified as optional Hermes.
- [x] Tests updated for acceptance and large-prompt behavior.

## Implementation Notes
Key changes landed in:
- `packages/codev/src/commands/consult/index.ts`
- `packages/codev/src/commands/porch/next.ts`
- `packages/codev/src/cli.ts`
- `codev/resources/commands/consult.md`
- `codev-skeleton/resources/commands/consult.md`
- `.gitignore`
- test files under `packages/codev/src/__tests__/...`

## Validation
Executed targeted build/test flow from `packages/codev/`:
- `pnpm build`
- `pnpm exec vitest run src/commands/porch/__tests__/consultation-models.test.ts src/commands/consult/__tests__/persistent-output.test.ts src/__tests__/consult.test.ts`
- `pnpm exec vitest run --config vitest.cli.config.ts src/__tests__/cli/consult.e2e.test.ts`

All passed at execution time.

## Deviations and Corrections
- Initial docs examples incorrectly implied 4-way default review.
- Corrected docs to explicitly show 3-way default and Hermes as optional.
- Initial implementation drifted from the spec by treating Hermes as a default consultation backend. Review feedback corrected this before merge by restoring 3-way defaults and moving Hermes coverage to explicit opt-in paths.

## Consultation Feedback

### Specify Phase (Round 1)

#### Gemini
- No concerns raised — approved.

#### Codex
- No concerns raised — approved.

#### Claude
- No concerns raised — approved.

#### Hermes
- No concerns raised — approved.

### Plan Phase (Round 1)

#### Gemini
- No concerns raised — approved.

#### Codex
- No concerns raised — approved.

#### Claude
- No concerns raised — approved.

#### Hermes
- No concerns raised — approved.

### Implement Phase 1 (Round 1)

#### Gemini
- No concerns raised — approved.

#### Codex
- No concerns raised — approved.

#### Claude
- No concerns raised — approved.

#### Hermes
- No concerns raised — approved.

### Implement Phase 2 (Round 1)

#### Gemini
- **Concern**: Hermes must remain optional rather than becoming part of the default fan-out.
  - **Addressed**: Restored the default consultation models to `gemini`, `codex`, `claude` and reverted default-facing fixtures to 3-way behavior.

#### Codex
- **Concern**: `afx bench` must not require Hermes by default.
  - **Addressed**: Reverted `ENGINES` to the 3-engine default set and updated the bench tests accordingly.

#### Claude
- **Concern**: Tests should distinguish between allowed backends and default backends.
  - **Addressed**: Kept Hermes in `VALID_MODELS`, restored 3-way default assertions, and added explicit opt-in Hermes test coverage.

## Architecture Updates
No architecture updates needed. The final change preserves the existing consultation architecture: Hermes remains an allowed backend, but the default orchestration and benchmark topology stay unchanged.

## Lessons Learned Updates
No lessons learned updates needed. This correction reinforces existing lessons already recorded in `codev/resources/lessons-learned.md` about preserving defaults unless product intent explicitly changes and keeping allowlists distinct from defaults.

## Flaky Tests
- No flaky tests encountered in the scoped validation flow used for this project.

## Pull Request
- Existing PR used for this work: `#670`

## Follow-ups
- If additional CLI backends are added later, keep default fan-out stable unless explicitly changed by product decision.
- Preserve large-prompt transport tests for each CLI backend to prevent ARG_MAX regressions.
