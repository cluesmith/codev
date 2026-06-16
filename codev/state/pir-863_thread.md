# PIR #863 — vscode markdown preview marker-aware features

## Plan phase (in progress)

Investigated the post-#859 world. Key findings:

- The rendering surface is **`packages/artifact-canvas/`** (React package), NOT a VSCode
  markdown-it plugin. The issue's original "Implementation sketch" (markdown-it plugin +
  previewScripts) is stale; the update section confirms this.
- The canvas is mounted as a **`CustomTextEditor`** (`packages/vscode/src/markdown-preview/
  preview-provider.ts` + `webview/main.ts`). It REPLACES the source editor — there is no
  separate "source editor" to click-to-jump into. So inline-card click-to-jump is reframed.
- Current marker rendering: `ArtifactCanvas.tsx` shows markers two ways — (a) a left inset
  accent bar (`.codev-canvas-has-marker`) on the block, and (b) an absolutely-positioned
  hover overlay marker-list anchored at the block's `offsetTop`. The overlay marker-list is
  the thing that **overlaps content** (the issue's "new concrete symptom").
- #861 floating TOC does NOT exist yet (no grep hits) — "compose with TOC" is forward-looking;
  I just need to not preclude it.
- Theme tokens: 8 `--codev-canvas-*` vars in `default-theme.css`, mapped to `--vscode-*` in
  `preview-template.ts`. Reuse existing tokens; no host changes needed for theming.
- Tests: vitest + @testing-library/react (jsdom). jsdom has no layout, so minimap position
  tests must assert structure (dot count, hidden-when-empty, click→scrollIntoView spy), not px.

Decision: implement entirely in the artifact-canvas package (so all hosts inherit it):
1. Move marker display from the hover overlay to always-visible **inline-below card stacks**.
2. Add a **right-edge minimap** component (dots, hover tooltip, click→smooth-scroll).
3. (Bundled, from issue comment) anchor the `+` affordance to the first line's vertical center.

Writing plan to codev/plans/863-vscode-markdown-preview-marker.md.

## Implement phase (in progress)

plan-approval gate approved. Implementing in the artifact-canvas package:
1. ArtifactCanvas.tsx — inject inline-below card stacks (DOM siblings, in flow);
   drop the overlapping hover overlay marker-list; keep the "+" affordance; anchor "+"
   to the first line's vertical center (bundled polish from the issue comment).
2. MarkerMinimap.tsx (new) — right-edge fixed dot column; hover title; click→smooth-scroll;
   hidden when zero markers.
3. default-theme.css — card stack + minimap styles (existing --codev-canvas-* tokens only).
4. Tests — update the old overlay-marker-list test to assert inline cards; add minimap tests.
