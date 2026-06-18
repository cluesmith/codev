# PIR #1053 — typography tokens for the Codev Markdown Preview (artifact canvas)

## Plan phase (in progress)

Investigated the codebase:
- `packages/artifact-canvas/src/styles/default-theme.css` — ships 8 color-only `--codev-canvas-*` tokens. Prose elements inherit everything else.
- `packages/artifact-canvas/src/types.ts` — D4 "locked public contract" comment; contract to amend.
- `packages/vscode/src/markdown-preview/preview-template.ts` — inline `<style>` binds the 8 color tokens to `--vscode-*`. This is the tier-2 host-mapping seam.
- VSCode preview mounts `<ArtifactCanvas>` (webview/main.ts), whose prose lives under `.codev-artifact-canvas-body`. CSS prose rules must target that container's descendants.
- Rendered prose elements: h1-h6, p, ul/ol/li, blockquote, pre, code, table (markdown-it output, sanitized).

Key plan-gate decisions captured in the plan: final token list, heading granularity (per-level vs scale+ratio), github-markdown-css version pin, prose-max-width default, tier-3 scope.

Writing plan to `codev/plans/1053-vscode-typography-tokens-for-t.md`.

## Plan approved (silent on the 5 decisions) → proceeded with recommendations.

Locked: 21-token vocabulary (8 color + 13 typography), per-level heading tokens (h1-h6,
github's non-geometric scale can't be a single ratio), github-markdown-css v5.8.1 pin,
`prose-max-width: none` default, Tier 3 included (2 settings, low-risk).

## Implement phase — done, awaiting dev-approval

- `default-theme.css`: +13 typography tokens with github v5.8.1 defaults + prose/heading/code
  CSS rules scoped to `.codev-artifact-canvas-body` (chrome untouched).
- `types.ts`: D4 contract amendment comment (#1053 doc trail).
- `README.md`: typography token table + baseline pin (doc trail).
- `default-theme.test.ts` (new): inline-snapshot of the 21-token list + non-empty + default
  assertions.
- `preview-template.ts` (Tier 2): code-font-family → editor font; prose keeps the sans stack
  (documented why); Tier-3 user overrides emitted into the host `<style>`.
  Gotcha: backticks inside the CSS comment broke the surrounding template literal — removed them.
- `preview-provider.ts` + `package.json` (Tier 3): `codev.markdownPreview.fontSize` /
  `.lineHeight` settings, read in renderHtml, live-reflow via onDidChangeConfiguration.

Tests: canvas 54/54, vscode 442/442 unit; both typechecks + esbuild bundle clean. Verified the
new tokens + prose rules land in the bundled `dist/webview/markdown-preview.css`.
(Had to build codev-core + codev-types first — they weren't built in the fresh worktree; the
resolution errors were environmental, not from my diff.)

## dev-approval gate — reviewer Q&A

Reviewer probed the Tier-3 plumbing (config listener, buildUserTypographyOverrides): all of it
exists only to make the two `codev.markdownPreview.*` settings reflow live. Reviewer confirmed
Tier 3 is "essential" → KEEP it. Settings are controlled via VSCode's standard Settings editor /
settings.json only (no in-preview UI).
- Per reviewer: documented the two settings in `packages/vscode/README.md` Settings table.
- Per reviewer: filed #1070 (area/vscode) for an in-preview zoom control affordance + write-back
  (the UI piece, deliberately out of scope here; tokens + settings already shipped by #1053).
