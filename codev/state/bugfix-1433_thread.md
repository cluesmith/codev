# bugfix-1433 — Stream Deck `pr` phase label renders 'Pr' instead of 'PR'

## Investigate (2026-08-13)

Root cause confirmed exactly as the issue states:
- `apps/streamdeck/src/face.ts` `PHASE_LABELS` (lines 105-113) has no `pr` row.
- A builder in the `pr` phase with no blocked gate falls through `stateLabel` to
  `titleToken('pr')` → `'Pr'` (title-cased raw id).
- `GATE_LABELS.pr = 'PR'` already exists (face.ts:96) but only fires for a *blocked* gate,
  not the active `pr` phase.

Fix: add `pr: 'PR'` to `PHASE_LABELS`, plus a regression test asserting
`stateLabel({protocolPhase: 'pr'}) === 'PR'` in the phase describe block of
`apps/streamdeck/src/__tests__/face.test.ts` (after the verified/complete cases).

Scope: 1 line + 1 test. Well within BUGFIX. Architect confirmed grounding; do NOT
restructure face.ts (pir-1410 rebases over this).

## Fix (2026-08-13)

- `face.ts`: added `pr: 'PR'` to `PHASE_LABELS`.
- `face.test.ts`: added `stateLabel({protocolPhase: 'pr'}) === 'PR'` to the phase-mapping
  `it(...)` block.
- Verified regression test FAILS without fix (`Expected "PR", Received "Pr"`) and PASSES with it.
- Full suite: 108/108 pass. `check-types` clean, `build` clean.
- Note: a fresh worktree needs `pnpm build` in `packages/sdk` first, else `tsc`/esbuild can't
  resolve `@cluesmith/codev-sdk/controller` (pre-existing worktree ordering, unrelated to fix).
