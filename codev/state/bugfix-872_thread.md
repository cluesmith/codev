# bugfix-872 thread

## Issue
porch: emit explicit `pr_ready_for_human` state field when CMAP completes.

PR #844 used `blocked === 'PR review'` (i.e. `pr` gate pending) to gate Needs Attention, which silently dropped BUGFIX PRs (no `pr` gate; transitions straight to `phase: verified` after CMAP).

## Plan
Canonical signal lives in `status.yaml` as `pr_ready_for_human: boolean`. Porch sets it true at the moment CMAP-emitting state exits for the PR-creating phase, in all 5 protocols.

### State-machine touchpoints (the only 3 places that need a write)
- **handleVerifyApproved (next.ts)** — fires for SPIR/ASPIR/PIR review (build_verify, gate=pr). When gate becomes pending → set `true`.
- **done (index.ts), auto-request `pr` gate** — fires for AIR pr (once, gate=pr). When `pr` gate gets `requested_at` → set `true`.
- **advanceProtocolPhase (index.ts) → 'verified'** — fires for BUGFIX pr (once, no gate, terminal). When transitioning from a PR-creating phase to verified → set `true`.

### Reset to false
- handleBuildVerify REQUEST_CHANGES → rebuttal cycle → explicit `false` (defensive; the field probably wasn't true anyway since rebuttal happens at iter1 and gate hasn't been requested yet).

### PR-creating phase detection
- Has `gate === 'pr'` (AIR/SPIR/ASPIR/PIR), OR
- Has `consultation` block in protocol.json (BUGFIX type:once).

I'll preserve a `hasConsultation: boolean` on normalized ProtocolPhase so we can detect BUGFIX-style PR phases without a gate.

### Consumer fallback (v3.1.3-compat)
overview.ts computes `prReady` from status.yaml's field if present, else falls back to:
`blocked === 'PR review' || (phase === 'verified' && protocol === 'bugfix')`

This restores BUGFIX visibility for in-flight projects that pre-date this PR.

## Implementation done
- types.ts: `ProjectState.pr_ready_for_human?: boolean` + `ProtocolPhase.hasConsultation?: boolean`
- protocol.ts: parse `consultation` block from JSON; add `isPrCreatingPhase` helper (gate==='pr' OR hasConsultation)
- next.ts handleVerifyApproved: set true at pr-gate-request (covers SPIR/ASPIR/PIR review)
- index.ts done(): set true at pr-gate auto-request (covers AIR pr)
- index.ts advanceProtocolPhase(): set true on transition out of PR-creating phase (covers BUGFIX pr → verified)
- index.ts approve(): reset false when `pr` gate is approved
- index.ts rollback(): reset false on rollback
- overview.ts: parseStatusYaml learns `pr_ready_for_human`; add `derivePrReady` with v3.1.3 fallback + BUGFIX gap closure; new `prReady` field on `BuilderOverview`
- types/api.ts: add `prReady` to shared `OverviewBuilder`
- NeedsAttentionList.tsx: gate on `b.prReady` instead of `b.blocked === 'PR review'`

## Tests
- New file: `pr-ready-872.test.ts` — 8 tests covering SPIR/ASPIR/PIR review-shape, AIR pr once-phase, BUGFIX pr once-phase, REQUEST_CHANGES, pr-gate-approve reset, rollback reset
- overview.test.ts: 6 tests for `derivePrReady` (explicit + fallback + BUGFIX gap)
- NeedsAttentionList.test.tsx: updated existing tests + 2 new (BUGFIX visibility, blockedSince fallback)
- All 3152 porch+codev tests pass (148 files); all 17 dashboard tests pass
- Pre-existing failure in `scrollController.test.ts` (terminal scroll, unrelated to this work)

