# pir-1553 thread — Attention fallback body from OverviewCache

Participating feature of #1049 (contextual bottom panel), skeleton fast-follow. PIR protocol,
three human gates (plan-approval, dev-approval, pr). Amr owns gates; architect relays; I run
`porch approve`.

## Context inherited from #1049 (merged PR #1551, skeleton-only)
- Panel is purely contextual: NO pinning / persisted state / new workspaceState/globalState keys.
- Resolver stays pure: `(SurfaceContext) → { kind, context }`, vscode-free, source-scan guarded.
- Attention is the **fallback render** (no pills/nav/selection). I fill its body only.
- Pattern: pure core + host adapter (provider posts descriptor) + webview renders. Reuse it.

## Fences (architect kickoff 2026-08-25)
- OverviewCache is read-only consumption. All needed fields already on the wire (verified in
  packages/types/src/api.ts): builder.blocked/blockedGate/blockedSince, prReady, heldCount;
  OverviewData.heldCount/mailboxEscalated/queuedFeedback. If data were missing → stop, ask main
  architect. It is not missing.
- Sibling lane pir-1552 owns review-queue/feedback.ts + comments/builder-review.ts. Disjoint from
  my contextual-panel/* files. Do not touch theirs.
- CI "Artifact-Canvas Browser Tests" is not my lane.

## Plan (drafted, awaiting plan-approval)
Written to codev/plans/1553-contextual-panel-wire-the-atte.md. Approach:
- New pure `contextual-panel/attention.ts`: `deriveAttention(OverviewData|null) → AttentionSummary`.
- `messages.ts`: add optional `attention?` to RenderMessage (keeps ModeDescriptor/resolver pure).
- `panel-provider.ts`: inject OverviewCache; re-post on onDidChange only while kind==='attention';
  fill attention payload in post() when Attention.
- `webview/main.ts`+styles: render roll-up (pending gates / held mail / queued feedback) + honest
  empty state; other modes keep placeholders.
- `extension.ts:570`: pass overviewCache into provider ctor.
- Tests: new attention unit test; extend provider test (payload + onDidChange re-post gating).

## HOLD: who runs `porch approve` (architect instruction 2026-08-25)
Do NOT run `porch approve` for ANY gate until architect confirms who executes it. Unreconciled
convention conflict: shipped #1494 docs say builder-runs-on-relay; main architect's record says
Amr corrected to architect-runs-it (builders never) during spir-1049. Owner asked directly.
Planning/impl/gate REQUESTS proceed normally; only approve EXECUTION is held. Resolved rule comes
with the next gate relay. Applies to all three gates.

## Plan-approval APPROVED (2026-08-25T21:23Z, Amr via VS Code, relayed by architect)
Attestation: "Approve the plan review gate for 1553, please pass it to the builder." Hold on
approve-execution lifted for this gate; "pass it to the builder" = builder-executes chain (matches
shipped #1494 docs). I ran `porch approve 1553 plan-approval --a-human-explicitly-approved-this`.
Advanced to implement.

## Implement phase — DONE, at dev-approval gate
Built exactly the plan. Files:
- NEW contextual-panel/attention.ts — pure `deriveAttention(OverviewData|null)→AttentionSummary`.
- messages.ts — optional `attention?` on RenderMessage (descriptor stays pure).
- panel-provider.ts — inject OverviewCache; onDidChange re-posts only in attention mode; post()
  attaches fresh payload when kind==='attention'.
- webview/main.ts + styles.css — render pending-gates/held-mail/queued-feedback sections + honest
  empty state; other modes keep placeholders; all text via React children (no innerHTML).
- extension.ts:570 — pass overviewCache into ctor.
- NEW __tests__/contextual-panel-attention.test.ts (10 cases) + extended provider test (5 cases:
  payload present in attention / empty summary / omitted non-attention / re-post on cache change /
  no post on cache change in non-attention mode).
Verify: check-types (extension+webview tsconfigs) clean, `test:unit` 944 pass, esbuild bundle ok,
eslint 0. Env-setup: had to build codev-types + codev-sdk + artifact-canvas dist first (known
#1049 note, not a code issue).

## Evidence limitation named for dev-approval
Can't drive real blocked-builder/held-mail/queued-feedback state from the builder shell (needs live
Tower with builders at gates). Cover projection+wiring via unit tests; render/empty-state in Ext Dev
Host against present cache; owner drives the full walkthrough.
