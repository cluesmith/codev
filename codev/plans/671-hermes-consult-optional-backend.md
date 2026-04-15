# Plan 671: Hermes Consult Backend (Optional, Not Default)

## Metadata
- Specification: `codev/specs/671-hermes-consult-optional-backend.md`
- Issue: https://github.com/cluesmith/codev/issues/671
- PR: https://github.com/cluesmith/codev/pull/670

## Executive Summary
Implement Hermes as an additional consult backend with explicit model selection, preserve default 3-way consultation models, and document Hermes as optional. Ensure large prompts avoid ARG_MAX/E2BIG via temp-file indirection.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Backend wiring and validation"},
    {"id": "phase_2", "title": "Docs and tests alignment"}
  ]
}
```

## Phase Breakdown

### Phase 1: Backend wiring and validation
Objectives:
- Add Hermes model config and routing in consult command.
- Add Hermes to porch model validation.
- Preserve default consultation model set.
- Add large-prompt guard for CLI argument limits.

Deliverables:
- `packages/codev/src/commands/consult/index.ts`
- `packages/codev/src/commands/porch/next.ts`
- No default change in `packages/codev/src/lib/config.ts`

Acceptance criteria:
- Hermes path is reachable via `-m hermes`.
- Large prompt path uses temp-file indirection.
- Default consultation models remain `['gemini', 'codex', 'claude']`.

### Phase 2: Docs and tests alignment
Objectives:
- Update CLI help and docs to include Hermes.
- Ensure docs frame Hermes as optional.
- Add/adjust tests for Hermes support and large prompt behavior.

Deliverables:
- `packages/codev/src/cli.ts`
- `codev/resources/commands/consult.md`
- `codev-skeleton/resources/commands/consult.md`
- `packages/codev/src/__tests__/consult.test.ts`
- `packages/codev/src/__tests__/cli/consult.e2e.test.ts`
- `packages/codev/src/commands/consult/__tests__/persistent-output.test.ts`

Acceptance criteria:
- Source and skeleton docs are synchronized.
- Examples show default 3-way and optional Hermes usage.
- Test commands pass from `packages/codev/`.

## Validation Commands
Run from `packages/codev/`:
- `pnpm build`
- `pnpm exec vitest run src/commands/porch/__tests__/consultation-models.test.ts src/commands/consult/__tests__/persistent-output.test.ts src/__tests__/consult.test.ts`
- `pnpm exec vitest run --config vitest.cli.config.ts src/__tests__/cli/consult.e2e.test.ts`
