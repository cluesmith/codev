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

## Follow-ups
- If additional CLI backends are added later, keep default fan-out stable unless explicitly changed by product decision.
- Preserve large-prompt transport tests for each CLI backend to prevent ARG_MAX regressions.
