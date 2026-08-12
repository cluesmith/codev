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

## PR (2026-08-13)

- PR #1434 opened (`Fixes #1433`).
- CMAP 3-way review: **gemini=APPROVE, codex=APPROVE, claude=APPROVE** (all HIGH).
- Note: consult auto-detect couldn't disambiguate the project; had to pass
  `--project-id bugfix-1433` explicitly.
- Claude's non-blocking notes (surfaced to architect, no code change per scope directive):
  a 5-word comment could explain why `pr` needs an explicit row (acronym the fallback can't
  produce); the row breaks lifecycle ordering (cosmetic); the test `it(...)` title is slightly
  overstated. All cosmetic; architect scoped this to exactly one line + one test.
- Handed off at the `pr` gate; awaiting architect approval before merge.

## Flaky Tests (CI on PR #1434, 2026-08-13)

CI "Unit Tests" job failed twice with **two different pre-existing flakes**, neither related
to the one-line `face.ts` label change (which is in `apps/streamdeck`; both flakes are in
`packages/codev` / external CLI):

1. Run 1 — `streamdeck validate` step: `TypeError: fetch failed` /
   `SocketError: other side closed` (`UND_ERR_SOCKET`) reaching a remote host over TLS. The
   Elgato CLI fetches validation rules over the network; a transient socket close aborted it.
   The `build` step itself passed.
2. Run 2 — `packages/codev/src/commands/consult/__tests__/agy-auth-cache.test.ts` >
   "re-probes after the unauth TTL lapses" (line 325): `expected null to be 'unauth'`. The
   test sets `CODEV_AGY_AUTH_CACHE_TTL_UNAUTH_MS=50` then does `await runLane(1)` (spawns a
   process) before asserting the cached `unauth` verdict is still present. Under CI load
   `runLane` exceeds 50ms, so the cache entry expires first → `null`. Classic TTL-vs-latency
   race. 4838 passed, 1 failed.

My change's own suite is green: streamdeck 108/108, `pnpm build` + `check-types` clean.
Decision on the flaky consult test (skip/annotate vs. separate fix) left to the architect —
outside this BUGFIX's one-line + one-test scope.
