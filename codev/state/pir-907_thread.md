# PIR #907 — builder flashes into UNCATEGORIZED during cleanup

## Plan phase (2026-06-06)

Investigated the area-grouping / cleanup data flow.

**Key findings:**
- `area` is derived server-side per overview build in `OverviewCache.getOverview`, defaulting to `UNCATEGORIZED_AREA` and enriched from the **open-issues** cache (`overview.ts:880-888`).
- `gh issue list` (the `issue-list` concept) is **open-only** by default — a closed issue silently drops out of `issueAreaMap`, so the `if (area)` guard fails and the record keeps the `Uncategorized` default.
- The mis-classification only becomes visible while the builder still passes the **active-session filter** (`overview.ts:796-799`); cleanup kills the terminal first but the registry/SSE refresh lags → the observed 2-5s window.
- `OverviewCache` is a process-lifetime singleton (`tower-routes.ts:100`), so per-builder memo state persists across refreshes; `invalidate()` only clears fetch caches.

**Chosen fix:** last-known-good `area` memoization in `OverviewCache` (Map keyed by `worktreePath`). Fall back to the last resolved area only when the issue is absent / fetch failed; write-through only on resolve, so genuine no-area builders still classify as `Uncategorized`. Robust to all three candidate sub-triggers (issue closed / metadata torn down / `issues === null`). No wire-field change, no cross-process plumbing.

Acceptance criterion #1 (reproduction with logging) deferred to implement phase: temporary debug logging will confirm which sub-trigger fires before the targeted fix lands.

Plan written to `codev/plans/907-vscode-builder-briefly-appears.md`. Awaiting `plan-approval`.

## Implement phase (2026-06-06)

`plan-approval` granted.

**Reproduction with logging (criterion #1):** wrote regression tests asserting the fixed behavior and ran them against the *unfixed* code first. Output deterministically reproduced the root cause — `area` resolved to `'Uncategorized'` (Received) when the issue left the open-issues list or the `issue-list` fetch failed, while the builder was still present. Confirmed sub-triggers (a) issue closed/absent and (c) fetch failed are the live conditions; (b) soft-mode teardown still enriches when the issue is open, so it only manifests once the issue is also absent. All three funnel into the same "present but un-enrichable" defect.

**Fix:** `OverviewCache.lastKnownArea` Map (keyed by `worktreePath`). Enrichment now distinguishes resolved (issue present → set + memoize, even when it's a genuine `Uncategorized`) from unresolved (issue absent / `issues === null` → reuse last-known-good, else keep default). Self-prunes to live builders each refresh; deliberately not cleared by `invalidate()`. No wire-field change.

**Verification:** overview suite 162/162 green (4 new); `pnpm --filter @cluesmith/codev build` ✓; full codev suite 3233 passed / 13 skipped (skips pre-existing). Live VSCode visual verification is the dev-approval reviewer's step (criterion #4).

Awaiting `dev-approval`.

## Implement phase — generalization (2026-06-06)

Architect feedback at the gate: (1) "last-known" is the wrong term — a builder maps to one issue with one fixed area, so the value is a stable fact being *cached across a source outage*, not a changing value being tracked; (2) generalize the backup-value mechanism before closing out, so other issue-derived fields can reuse it.

**Refactor:** extracted `ResolvedEnrichmentCache` (keyed by `worktreePath`, holding a `ResolvedEnrichment` snapshot per builder). `resolve(builderKey, field, sourceAvailable, freshValue)` write-through on reachable / replay-cached on unreachable; `prune(liveKeys)`. The load-bearing contract — gate on issue *reachability*, never value-emptiness — is encoded in the signature so a reachable-but-unlabeled issue still caches a genuine `Uncategorized` and a stale entry can't mask a live label change. Adding a new sticky field = extend the `ResolvedEnrichment` interface + one `resolve(...)` call at the enrichment site. `area` is the sole field today; `issueTitle` deliberately opts out (it has a local slug fallback).

Renamed field/comments/test wording off "last-known" → "resolved". Added 6 direct unit tests for the generic cache contract (availability-gate, sentinel caching, no-mask-on-change, per-builder isolation, prune).

**Verification:** overview suite 168/168; build ✓; full codev suite 3239 passed / 13 skipped.
