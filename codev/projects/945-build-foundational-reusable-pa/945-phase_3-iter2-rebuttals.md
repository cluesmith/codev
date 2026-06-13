# Phase 3 (overlay) — Rebuttal to implement consult iteration 2

**Verdicts:** Codex REQUEST_CHANGES (MEDIUM); Claude APPROVE; Gemini COMMENT. Codex's two items
were **accepted and fixed** (commit `76dfa9a7`). (Claude approved iter-2 — the iter-1 fixes
satisfied it.)

## Codex — REQUEST_CHANGES (both addressed)

1. **Async race: `read()`/`list()` applied with no sequencing guard.** A slow initial `read()` or an
   older `list()` could overwrite newer state after a `watch` update (stale content/markers).
   **Fixed:** added **request-versioning** — a `seqRef` counter; each load (initial read or a watch
   change) takes a monotonically increasing seq, and content/markers are applied only while that
   seq is still the latest (`applyLoad` guards before `setContent`, before `setMarkers`, and in the
   catch). Regression test added: a slow initial `read()` resolving *after* a newer `watch` update
   does not overwrite the newer content.

2. **The "failed list keeps prior markers" test never rendered prior markers first.** **Fixed:**
   added a proper test — render a marker, then a *later* `list()` rejects on a `watch` update, and
   assert the prior marker UI (`.codev-canvas-has-marker`) remains visible.

Tests now 28/28 green.

## Claude — APPROVE; Gemini — COMMENT. No further changes required.

Net: both Codex iter-2 items resolved in `76dfa9a7`; no scope creep.
