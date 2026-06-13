# Phase 3 (overlay) — Rebuttal to implement consult iteration 4

**Verdicts:** Codex REQUEST_CHANGES (HIGH); Claude APPROVE; Gemini COMMENT. Codex's single item was
**accepted and fixed** (commit `a1fbf0d4`), with explicit architect authorization for the
contract/spec change it required.

## Codex — REQUEST_CHANGES (addressed)

- **No-watcher refresh contract unmet.** Spec D6 said a host without a `FileAdapter` watcher could
  "force the same refresh by re-rendering the component," but the effect's stable deps mean a
  same-props re-render does not re-fetch (which is correct React). Codex is right that the contract
  as written wasn't honored.
  - **This required touching the LOCKED `ArtifactCanvasProps` interface**, so I escalated rather than
    fix unilaterally. The **architect authorized** a purely additive fix.
  - **Fixed (`a1fbf0d4`):** added an optional `refreshKey?: number | string` to
    `ArtifactCanvasProps` (no-op default — hosts with a watcher omit it, behavior unchanged) and
    included it in the effect deps, so a no-watcher host forces a fresh read + marker-list by
    bumping it. **Spec D6 wording corrected** to name `refreshKey` as the contract (host bumps it on
    data change; a plain re-render does not re-fetch). Test added: `refreshKey` 1→2 triggers a
    second read + new content with no watcher involved. 29/29 green.

## Claude — APPROVE; Gemini — COMMENT. No further changes required.

Net: the no-watcher-refresh gap is closed via the additive `refreshKey` prop + the D6 tightening
(architect-blessed). This is the only iter-4 item.

---
**Phase 3 consult arc (for the record):** 4 Codex iterations — watch-guard bug, async race,
warn-once, no-watcher refresh — each a legitimate, progressively smaller refinement, all fixed;
Claude APPROVED since iter-2; Gemini COMMENT throughout. The architect confirmed the loop was
working as designed (each iter shipped better software than iter-1 would have).
