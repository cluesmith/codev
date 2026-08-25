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

## Evidence limitation named for dev-approval
Can't drive real blocked-builder/held-mail/queued-feedback state from the builder shell (needs live
Tower with builders at gates). Cover projection+wiring via unit tests; render/empty-state in Ext Dev
Host against present cache; owner drives the full walkthrough.
