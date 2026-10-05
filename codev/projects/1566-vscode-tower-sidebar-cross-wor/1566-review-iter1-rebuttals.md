# PIR #1566 — Review iteration 1 rebuttals

Verdicts: Gemini **APPROVE**, Claude **APPROVE**, Codex **REQUEST_CHANGES** (2 findings).

Both Codex findings addressed in commit `8e4d6a230`. Summary below.

## Finding 1 — "`tower.ts:139,179-203` marks architect-only held mail as expandable, but `attentionRows()` returns no children when `heldTotal > 0` and `heldMail` is empty."

**Agreed — real bug. Fixed.**

`hasDetail = !attention.isEmpty && active` makes a workspace expandable whenever `deriveAttention`
reports it non-empty. `isEmpty` is false when `heldTotal > 0` even if no builder carries per-builder
`heldMail` (workspace-wide/architect-held mail). `attentionRows()` iterated only
`pendingGates`/`waiting`/`heldMail`/`queuedFeedback`, so such a row expanded to nothing — while its
collapsed summary still read "N held" (via `describeAttention`, which already uses
`heldTotal || heldMail`). Inconsistent and a real empty-expansion defect.

**Change** (`tower.ts attentionRows`): when `heldMail.length === 0 && heldTotal > 0`, render a single
workspace-level `Held mail · N` child (with the escalated suffix when `heldEscalated`). This mirrors
the contextual panel's existing fallback (`${heldTotal} held, awaiting an empty prompt`).

**Regression test** (`tower-provider.test.ts`): "expands a workspace-held-only workspace to a
workspace-level held row (no empty expansion)" — builds an overview with `heldCount>0` and no
per-builder held, asserts the row is `Collapsed` AND `getChildren` returns a `Held mail` child.
Fails without the fix (empty children array).

## Finding 2 — "`tower-cache.ts` polls while connected but refuses refreshes while disconnected — the opposite of the approved fallback behavior. Add coverage proving HTTP refresh while SSE/connection state is down."

**Partially agreed. Addressed as a missing test + an inaccurate comment — not a correctness change,
because the view already recovers.** Detail, verified against the code:

An SSE drop does not leave the connection "up with SSE down." `ConnectionManager`'s SSE
`onDisconnect` (`connection-manager.ts:232-238`) calls `setState('disconnected')` +
`scheduleReconnect()`. So "SSE down" == connection down == **Tower unreachable over HTTP too** (SSE
and the REST calls hit the same Tower). Polling `listWorkspaces()`/`getOverview()` during that window
would only fail into the last-known-good guards — a no-op with log/request noise, not a recovery.

Recovery is **reconnect-driven and already implemented**: the health-checked reconnect returns the
state to `connected`, and `TowerFleetCache` re-fetches on that transition
(`onStateChange('connected') → scheduleRefresh`). The three cases:

- **SSE silently stalls, connection still `connected`** → the 20s connected poll fetches the missed
  state. (Already tested: "polls as a fallback on the interval".)
- **SSE drops → disconnected → reconnect → connected** → reconnect-refresh fetches. (Was untested.)
- **Activation/deactivation (no SSE, connected)** → poll + the actions' manual `refresh()`.

So the fallback is effective across all three; the real gap Codex found was (a) no test for the
reconnect-recovery path and (b) a constructor comment that over-sold the poll as "the SSE-gap
fallback," implying it fires while disconnected.

**Changes**:
- Test (`tower-cache.test.ts`): "does not fetch while disconnected, then re-fetches on reconnect
  (SSE-drop recovery)" — asserts no fetch across a 20s poll window while `disconnected`, then a fetch
  once state returns to `connected`.
- Comment (`tower-cache.ts` constructor): rewritten to state the real model — reconnect-driven
  recovery for a dropped connection; the poll covers no-SSE list changes + a silently-stalled stream
  *while connected*; a disconnected tick is a deliberate no-op.

No behavior change for finding 2 — fetching while disconnected is intentionally avoided.

## Net

- Finding 1: code fix + regression test.
- Finding 2: reconnect-recovery test + accurate comment; the recovery itself was already correct.
- Full suite green on the fix: vscode 1092, sdk 144; compile (types+lint+esbuild) clean.
- Both documented in the PR body's "3-Way Consultation" section so the human reviews the disposition
  at the pr gate (PIR single-pass — this is the only remaining check on finding 2's rebuttal).
