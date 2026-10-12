# pir-1131 thread

## 2026-10-05 plan phase
- Verified the architect's rescope: there is no format v2. The canonical codec is now `packages/sdk/src/review-markers.ts` (codev-sdk, not codev-core). `plan-review.ts` carries a duplicate local regex.
- No dashboard or Tower code parses markers today, so "cross-host" in practice means older installed VS Code extensions plus raw-markdown readers and editors.
- Traced each format option through the shipped regexes. Recommending an in-tag attribute on the same tag, `REVIEW(@amr, resolved)`: old parsers still match it and treat `amr, resolved` as the author, so the cost is cosmetic. A companion RESOLVED line breaks old `parseReviewMarkers` anchoring and `markerAppendLine`. A v2 tag is invisible to old hosts. A sidecar needs ids that markers don't have.
- No stable ids minted: state lives on the marker, so the positional `markerLine` + verify is enough. The attribute slot is reserved for a future `id=`.
- #860 (summary) is unbuilt, so the "unresolved only" filter is deferred.
- Contract surfaces flagged for main: the sdk codec, plus the artifact-canvas `types.ts` additions.

## 2026-10-05 plan revisions
- Listed every skeleton twin by path (architect:vscode).
- Main approved the sdk section (same-tag format) with five conditions, all folded into section A and the Test Plan:
  - C1: matchesExpectedMarker compares the parsed author.
  - C2: rewrite keeps attrs.
  - C3: v1 output stays byte-identical.
  - C4: attribute grammar pinned: author up to the first comma, then bare-flag or key=value attrs, unknown ones kept verbatim and in order.
  - C5: the codec stays pure.
- Lockstep: the sdk and canvas ReviewMarker types gain `resolved` in the same phase.

## 2026-10-13 owner discussion: delivery half added
- The owner asked how plan/spec comments reach the builder. Nothing delivers them today; an idle builder at a gate does not watch files.
- Merged origin/main (132 behind). #1559 (panel Code Review body, PR #1769) and #1562 (sent record, PR #1768) have both landed.
- Revised the plan:
  - New Decision 6 + section G: fill in the panel Document Review body (list, open/resolved counts, resolve toggles) and add an explicit "Send N open comments to <builder>" button. It reuses the Submit Review mechanics (open the terminal, bracketed paste, no Enter). The message is self-describing.
  - No sent ledger: the comments stay in the file until resolved, so the file is the record.
- Protocol prompt edits dropped; builder.md keeps a short rule for non-button paths.
- contextual-panel/* fence: asked architect:vscode to confirm it is lifted now that #1559 has merged.
- 2026-10-12: architect:vscode lifted the contextual-panel/* fence; #1131 now owns the Document Review body (#1049 participating feature). Folded in their asks: drop the stale #859/#945 placeholder citation, keep the builder.md rule byte-identical in both trees.
