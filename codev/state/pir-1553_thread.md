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

## dev-approval feedback round 1 (owner, via architect relay / direct)
Color + layout polish on the running panel (light-theme screenshots):
1. Gate amber realigned to the SIDEBAR's token `--vscode-notificationsWarningIcon-foreground`
   (matches the Builders-tree blocked bell) for both the row stripe and the badge text; was
   `editorWarning-foreground`/`charts-yellow` (near-but-different amber).
2. Count pill was grey-on-blue (descriptionForeground on badge-background) → now the
   contrast-guaranteed pair `--vscode-badge-foreground` on `--vscode-badge-background`.
3. Dropped the redundant `.cp-header` for Attention mode only: the static "Attention" label
   duplicated the "Codev" panel TAB and ate a full row. Other modes keep the header (it names
   their file/builder). Body reclaims the row.
Origin note for the record: shipped panel uses ONLY --vscode-* tokens (both themes free); the
earlier artifact mockup's hardcoded hexes never shipped. artifact-canvas uses its own Primer
palette but re-skins to --vscode-* inside a webview, so everything collapses onto VS Code tokens.
Green after: check-types, test:unit 944, esbuild, eslint.

## dev-approval feedback round 2 (owner) — badge contrast
Pale amber-on-cream badge (inputValidation-warningBackground) washed out, worse over grey row-hover.
Fix (b2efca5c3): row badges now TEXT-ONLY (no filled pill) — colored label on panel/hover bg; left
stripe already carries the semantic color. gate=notificationsWarningIcon-fg, mail=notificationsErrorIcon-fg,
queued=textLink-fg. Also fixed latent blue-on-blue queued badge (was inheriting badge-background).
Count pill stays filled blue (badge fg/bg pair). Green: check-types/944/esbuild/eslint.

## dev-approval feedback round 3 (owner) — share the projection via SDK
Owner challenged: AttentionSummary + deriveAttention should be shared, did I check types/sdk?
Finding: codev-types = wire-contracts-only (correctly excluded). codev-sdk/builder-helpers.ts is
the real precedent — it already hosts cross-client UI-policy projections over OverviewBuilder
(isIdleWaiting + threshold), explicitly to stop VSCode/dashboard drift. No symbol was duplicated
(only isIdleWaiting existed), but the projection belongs there.
DEVIATION from approved plan (which declared these extension-local): owner chose option (a) —
- MOVED deriveAttention + AttentionSummary/GateItem/CountItem/WaitingItem/AttentionBuilderRef into
  packages/sdk/src/builder-helpers.ts (pure, env-agnostic, passes import-boundary; `now` injectable).
- FOLDED IN isIdleWaiting: new `waiting` list (idle-past-threshold builders not already at a gate),
  rendered as "Waiting on input" section, stripe/badge = notificationsInfoIcon (sidebar idle color).
- Extension now imports deriveAttention (value, host-side) + types (type-only, webview) from
  @cluesmith/codev-sdk/builder-helpers. RenderMessage envelope stays extension-local.
- Deleted apps/vscode/.../attention.ts + its vscode test; added packages/sdk/.../builder-helpers.test.ts.
Must rebuild sdk dist before vscode check-types (monorepo order). Green: sdk build/check-types/119
tests; vscode check-types(both tsconfigs)/935 tests/esbuild/eslint. Record this deviation in review.

## dev-approval APPROVED (2026-08-25T22:02Z, Amr via VS Code) — I ran porch approve. Now in REVIEW.
SDK move routing: architect routed the packages/sdk deviation to MAIN architect (their contract
surface). Main's seat SATISFIED post-hoc with verification, no changes required (2026-08-25T22:04Z):
import boundary held, single source, webview bundle clean (type-only webview / host-side value import,
no dep-class transition), policy home correct, dedup+heldTotal sound. PR hold RELEASED.
Review artifact logs the deviation as main framed it. Next: commit review, push, open PR, porch runs
single CMAP pass, then pr gate. Branch freezes before pr gate; gate-record commit is last write.

## CMAP iter1: Gemini APPROVE, Codex+Claude REQUEST_CHANGES — all addressed
Both blockers were about the REVIEW ARTIFACT, not the impl (all 3 verified impl clean):
1. Review missing mandated PIR sections Commits/Test Results/How to Test Locally → added.
2. Arch/lessons routing DECLARED but not APPLIED → applied cold updates in-commit: arch.md (#1049
   contextual-panel para) + lessons-learned.md (1 Architecture + 1 UI/UX lesson).
Code nits fixed: empty-state sub-line now names "waiting"; EMPTY_ATTENTION shared singleton →
emptyAttention() factory returning fresh object (+ regression test); attention-undefined branch
renders neutral "Loading…" not an emptiness claim (Codex).
Rebutted (non-blocking): since() untested — webview module not vitest-importable (top-level
acquireVsCodeApi + CSS import); covered by manual verification.
Rebuttal doc: codev/projects/1553-*/1553-review-iter1-rebuttals.md. Green: sdk 120, vscode 935,
check-types both, esbuild, eslint. PIR single-pass — pr gate is the only remaining check.

## Evidence limitation named for dev-approval
Can't drive real blocked-builder/held-mail/queued-feedback state from the builder shell (needs live
Tower with builders at gates). Cover projection+wiring via unit tests; render/empty-state in Ext Dev
Host against present cache; owner drives the full walkthrough.
