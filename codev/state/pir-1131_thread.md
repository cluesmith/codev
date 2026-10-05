# pir-1131 thread

## 2026-10-05 plan phase
- Verified the architect's rescope: there is no format v2. The canonical codec is now `packages/sdk/src/review-markers.ts` (codev-sdk, not codev-core). `plan-review.ts` carries a duplicate local regex.
- No dashboard or Tower code parses markers today, so "cross-host" in practice means older installed VS Code extensions plus raw-markdown readers and editors.
- Traced each format option through the shipped regexes. Recommending an in-tag attribute on the same tag, `REVIEW(@amr, resolved)`: old parsers still match it and treat `amr, resolved` as the author, so the cost is cosmetic. A companion RESOLVED line breaks old `parseReviewMarkers` anchoring and `markerAppendLine`. A v2 tag is invisible to old hosts. A sidecar needs ids that markers don't have.
- No stable ids minted: state lives on the marker, so the positional `markerLine` + verify is enough. The attribute slot is reserved for a future `id=`.
- #860 (summary) is unbuilt, so the "unresolved only" filter is deferred.
- Contract surfaces flagged for main: the sdk codec, plus the artifact-canvas `types.ts` additions.
