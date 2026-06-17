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
