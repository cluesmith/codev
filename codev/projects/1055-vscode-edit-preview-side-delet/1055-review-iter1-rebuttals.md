# PR-stage consult — iteration 1 dispositions (PIR #1055)

Verdicts: **Claude → APPROVE** (HIGH, no issues). **Codex-family lens → REQUEST_CHANGES** with two findings. Both findings are **accepted as real and fixed** — no rebuttal/disagreement. PIR is single-pass, so these fixes were not re-reviewed by the models; escalated to the human at the `pr` gate.

Fix commit: `[PIR #1055] Fix PR consult findings: two-sided marker normalize + composer remount on same-block re-edit`.

## Finding 1 — `matchesExpectedMarker` one-sided normalization (REAL — FIXED)

**Claim** (`packages/core/src/review-markers.ts`): the docstring promises tolerance of the codec's whitespace normalization, but the code normalized only `expectedBodyPrefix` and compared it against the *raw* parsed body `m[3]`. A hand-authored marker with irregular internal whitespace (e.g. `<!-- REVIEW(@amr): foo  bar -->`, legal since markers are human-writable) yields `normalizedExpected='foo bar'` vs `m[3]='foo  bar'`, so `startsWith()` returns false → preview edit/delete refuses with a spurious "this comment changed" toast, violating the function's own contract.

**Assessment: correct.** Verified against source. Also independently confirmed by the architect's own second lens (zen gpt-5.1-codex).

**Fix:** normalize BOTH the on-disk body and the expected prefix before the prefix compare:
```ts
const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim();
return normalize(m[3]).startsWith(normalize(expectedBodyPrefix));
```

**Regression test** (`packages/core/src/__tests__/review-markers.test.ts`): a marker whose on-disk body has a double-space *and* a tab internal run still matches when `expectedBodyPrefix` is the normalized single-space form; a genuinely different body still rejects. Guards both the edit and delete verify paths.

## Finding 2 — `CommentComposer` stale text on same-block re-edit (REAL — FIXED)

**Claim** (`packages/artifact-canvas/src/overlays/CommentComposer.tsx` + `ArtifactCanvas.tsx`): `useState(initialText)` reads its arg only on mount. When the composer is already open and the reviewer clicks edit on a *different card on the same block*, `ArtifactCanvas` swaps `editingMarker` but `composingLine` is unchanged (both cards anchor to the same block line), so the composer is not remounted and the textarea keeps the previous card's text. Saving then writes stale text to the new marker. The existing test covered only the first open.

**Assessment: correct.** This is precisely the stacked-comment scenario the feature targets, so it is load-bearing. Verified by tracing the reconciliation: same `composingLine` → same portal host → same instance reused → `useState` seed not refreshed.

**Fix:** `key` the portalled composer on the edit target so switching cards remounts it and re-seeds the textarea:
```tsx
key={`composer-${editingMarker?.markerLine ?? 'add'}-${composingLine}`}
```

**Regression test** (`packages/artifact-canvas/src/components/__tests__/marker-card-edit-delete.test.tsx`): open the composer on card #1 (bob/"first"), then click edit on card #2 (carol/"second") on the same block; assert the textarea now shows "second" (would show "first" without the remount) and that save emits `onEditComment(2, 'carol', 'second', …)`.

## Build status after fixes

core 41 ✓, artifact-canvas 73 ✓, vscode 543 ✓; typecheck (host + webview) clean. Fixes committed + pushed to `builder/pir-1055`; PR #1132 updated.
