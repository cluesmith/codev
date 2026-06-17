# PIR Plan: Typography tokens for the Codev Markdown Preview (artifact canvas)

> Issue #1053 · area/vscode · extends the locked 8-token color vocabulary from #945 (spec 945 D4)
> with a typography token tier so prose (specs, plans, reviews) reads cleanly in the VSCode preview.

## Understanding

The Codev Markdown Preview surfaces the `@cluesmith/codev-artifact-canvas` component inside a
VSCode `CustomTextEditor` webview (`packages/vscode/src/markdown-preview/`). The canvas ships
`default-theme.css` with **eight `--codev-canvas-*` tokens that are colors only** (spec 945 D4
deliberately capped the v1 vocabulary at colors). Everything about *type* — size, family,
line-height, paragraph rhythm, heading scale, prose width — falls through to the webview's
inherited defaults, which are tuned for code (the workbench UI font ~13px, line-height ~1.4),
not for sustained reading of long-form documents.

Concretely, in `packages/artifact-canvas/src/styles/default-theme.css` the
`.codev-artifact-canvas` block sets only `color`/`background` and the eight color custom
properties; there is **no rule** that sizes `body`, `p`, `h1`–`h6`, `ul`/`ol`, `blockquote`,
`pre`/`code`, or `table`. In the VSCode host, `preview-template.ts`'s inline `<style>` binds the
eight color tokens to `--vscode-*` variables but adds no typography. The webview body therefore
renders prose at `--vscode-font-size` (UI font, not `--vscode-editor-font-size`) with the
editor's tight inherited line-height.

The canvas now has real consumers (#859 preview, #863 markers + minimap) and the colors-only
limit is a daily readability problem. This issue adds a **typography token tier** with
**github-markdown-css metrics as the chosen baseline** (the familiar mental model for reviewers
who read PRs in that style all day), and binds those tokens to sensible VSCode-theme defaults in
the host.

Prose in the preview is rendered into `.codev-artifact-canvas-body` (see
`ArtifactCanvas.tsx` — the body div holds the sanitized markdown HTML; the standalone
`MarkdownView` uses `.codev-artifact-canvas-rendered`). New prose CSS rules must target
descendants of **both** containers so the tokens work in the composed canvas *and* the standalone
view; scoping to `.codev-artifact-canvas` (the outer container, ancestor of both) covers both.

## Proposed Change

Three tiers, in the issue's order. **Tier 1 + Tier 2 are the committed scope of this PR; Tier 3
is an optional stretch** (see Decision 5).

### Tier 1 — Package typography tokens (`default-theme.css`)

Add a typography token group to `.codev-artifact-canvas` with github-markdown-css-aligned
fallbacks, plus the CSS rules that consume them. **Final token list locked here at
plan-approval** (Decision 1):

| Token | Default | Notes |
|---|---|---|
| `--codev-canvas-font-size` | `16px` | prose body; github-markdown-css base |
| `--codev-canvas-font-family` | `-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"` | github system sans stack |
| `--codev-canvas-line-height` | `1.5` | prose body |
| `--codev-canvas-paragraph-spacing` | `16px` | margin between paragraphs; lists / blockquotes / tables / `pre` derive from this |
| `--codev-canvas-prose-max-width` | `none` | optional readable-measure cap; **off by default** (Decision 4) |
| `--codev-canvas-h1-size` | `2em` | per-level heading sizes (Decision 2) |
| `--codev-canvas-h2-size` | `1.5em` | |
| `--codev-canvas-h3-size` | `1.25em` | |
| `--codev-canvas-h4-size` | `1em` | |
| `--codev-canvas-h5-size` | `0.875em` | |
| `--codev-canvas-h6-size` | `0.85em` | github renders h6 muted + smallest |
| `--codev-canvas-code-font-family` | `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace` | github mono stack |
| `--codev-canvas-code-font-size` | `0.85em` | github: code ~85% of prose |

That is **8 prose/code tokens + 6 heading tokens = 14 tokens**. The heading set is bounded
(one per element, 1:1 with the rendered tag) and reproduces github's *non-geometric* scale
exactly — see Decision 2 for why per-level beats a single ratio.

CSS rules consuming the tokens (all scoped under `.codev-artifact-canvas`, applied to the prose
container so they don't disturb the comment cards / overlay / minimap chrome):

- Body: `font-size`, `font-family`, `line-height` on the rendered prose container.
- Optional measure cap: `max-width: var(--codev-canvas-prose-max-width)` on the prose container
  (a no-op while the default is `none`).
- Paragraphs: `p { margin: 0 0 var(--codev-canvas-paragraph-spacing); }` and zero the last
  child's trailing margin.
- Lists / blockquotes / tables / `pre`: bottom margin derived from
  `var(--codev-canvas-paragraph-spacing)` for consistent vertical rhythm.
- Headings: `h1..h6 { font-size: var(--codev-canvas-hN-size); }` plus deliberate top/bottom
  margins and `line-height: 1.25` (github's heading line-height), so headings render with a
  scale instead of user-agent defaults. github's h1/h2 bottom-border is **not** copied (it reads
  as chrome in a narrow preview pane; out of scope, noted in the review).
- Code: `pre, code { font-family: var(--codev-canvas-code-font-family); }` and
  `font-size: var(--codev-canvas-code-font-size)` for inline `code` and `pre` blocks.

The existing color rules (`a`, `pre`/`code` background, marker/minimap chrome) are untouched.

### Tier 2 — Host mapping (`preview-template.ts`)

Extend the inline `<style>` `.codev-artifact-canvas` block to bind the new typography tokens,
**each binding documented inline** (Decision 3 on which bindings track VSCode vs prose-readability
defaults):

- `--codev-canvas-code-font-family: var(--vscode-editor-font-family)` — code blocks track the
  reviewer's **editor** font (the github convention: mono for code).
- `--codev-canvas-code-font-size` — left to the package default (`0.85em`), so code stays
  proportional to prose rather than jumping to the editor's absolute size.
- **Prose tokens (`font-size`, `font-family`, `line-height`, `paragraph-spacing`) are left to the
  package defaults** — i.e. the preview overrides VSCode's editor/UI font for *prose* and uses the
  github system sans stack at 16px / 1.5. Rationale (Decision 3): the editor font is frequently a
  small monospace; inheriting it is exactly the cramped baseline this issue fixes. Code still
  tracks the editor font via the binding above.

A short inline comment block explains the "prose overrides editor font; code tracks it" split so a
future maintainer doesn't "helpfully" rebind prose to `--vscode-editor-font-*`.

### Tier 3 — User settings (optional, see Decision 5)

If shipped: register `codev.markdownPreview.fontSize` and `codev.markdownPreview.lineHeight` in
`packages/vscode/package.json` `contributes.configuration`, read them in `preview-provider.ts`,
and inject them as inline `--codev-canvas-font-size` / `--codev-canvas-line-height` overrides on
the webview root (so a user value wins over the package default). Kept to two knobs to avoid a
sprawling settings surface; documented in the review.

### Spec-amendment doc trail (#945 D4 contract)

Spec 945 D4 calls the token vocabulary "the locked public contract … do not change shapes without
a spec amendment." This expansion is recorded as a docs-only trail (no protocol gate beyond that,
per the issue):

- `packages/artifact-canvas/src/types.ts` — extend the contract comment to note the typography
  tier added by #1053 (the tokens are CSS custom properties, not a TS shape, so no interface
  changes; the comment is the contract's prose home).
- `packages/artifact-canvas/README.md` — add the typography tokens to the Theming table with
  their defaults and the github-markdown-css pin.
- The plan and review files (this trail) record the amendment, satisfying "recorded in the issue,
  plan, and review."

### Reference baseline pin

Document, in `default-theme.css` and the README, the exact github-markdown-css version whose
metrics we mirror (Decision 3 below pins it), so the baseline is reproducible as that project
evolves.

## Files to Change

- `packages/artifact-canvas/src/styles/default-theme.css` — add the 14 typography tokens (with
  the version-pin comment) + the prose/heading/code CSS rules.
- `packages/artifact-canvas/src/types.ts` — amend the D4 contract comment to cover the typography
  tier (#1053 doc trail).
- `packages/artifact-canvas/README.md:112-135` — extend the Theming token table + note the
  github-markdown-css pin.
- `packages/artifact-canvas/src/__tests__/default-theme.test.ts` *(new)* — vitest snapshot/assertion
  over the `--codev-canvas-*` token list parsed from `default-theme.css` (AC: "Vitest snapshot
  covering the default-theme.css token list passes"). Reads the CSS source, extracts declared
  custom-property names, and snapshots the sorted list so any future token add/remove is a
  reviewed diff.
- `packages/vscode/src/markdown-preview/preview-template.ts:36-50` — bind the new typography
  tokens with inline rationale comments (Tier 2).
- *(Tier 3, optional)* `packages/vscode/package.json` — register
  `codev.markdownPreview.fontSize` / `.lineHeight`.
- *(Tier 3, optional)* `packages/vscode/src/markdown-preview/preview-provider.ts` — read the
  settings and inject inline token overrides on the webview root.

## Decisions to Lock at plan-approval

**Decision 1 — Final token list.** The 14-token list in the Tier 1 table. Rationale: covers every
prose lever the issue names (size, family, line-height, paragraph rhythm, optional width, heading
scale, code family+size) without inventing knobs nobody asked for. *Confirm or trim.*

**Decision 2 — Heading granularity: per-level tokens (RECOMMENDED) vs scale-base + ratio.**
github-markdown-css's heading sizes are `2 / 1.5 / 1.25 / 1 / 0.875 / 0.85 em` — **not** a clean
geometric progression. A single `--codev-canvas-heading-scale-ratio` + `calc()` *cannot reproduce
the chosen baseline* (e.g. a 1.25 ratio gives 2 / 1.6 / 1.28 / 1.024 / … — wrong at every level).
Since the issue explicitly pins github-markdown-css as the baseline and AC requires "a deliberate
scale," I recommend **per-level `--codev-canvas-h1-size` … `--codev-canvas-h6-size`** for exact
fidelity and a direct per-heading override surface. This *overrides the issue's stated lean*
(scale+ratio for headings) on the grounds that the lean is incompatible with the locked baseline;
flagging it explicitly for your call. *Alternative if you prefer fewer tokens:* `scale-base` +
`ratio` (2 tokens), accepting that headings will diverge from github's exact sizes.

**Decision 3 — VSCode-theme alignment vs prose-readability defaults, + baseline pin.** Prose
tokens override the VSCode editor font (github system sans, 16px, 1.5); `--codev-canvas-code-*`
track the editor font for code blocks. Baseline pinned to **github-markdown-css v5.8.1** (latest
stable; exact version recorded in `default-theme.css` + README). *Confirm the version to pin.*

**Decision 4 — `prose-max-width` default.** Ships as `none` (no cap) so it can't break a host
layout (the issue's stated fallback); the token exists so a host/user can opt into e.g. `72ch`.
*Confirm off-by-default.*

**Decision 5 — Tier 3 scope.** Recommend **landing Tier 1 + Tier 2 firmly** and treating Tier 3
(two settings: `fontSize`, `lineHeight`) as an **optional add within this PR** if the dev-approval
readability review goes smoothly, otherwise spun off to a follow-up issue. Tier 3 is explicitly
"nice-to-have, not gating" in the issue. *Tell me: include Tier 3 now, or defer it.*

## Risks & Alternatives Considered

- **Risk: prose rules leak into the comment cards / minimap / overlay chrome.** Those use
  `font-size: 0.9em` (cards) and fixed sizing. Mitigation: scope prose rules to the rendered prose
  container and its block descendants, not the chrome classes; verify cards/minimap visually at
  dev-approval (AC: "no regression to marker rendering, minimap, comment cards, or color
  theming").
- **Risk: `em`-based heading + code sizes compound unexpectedly** if a parent font-size changes.
  Mitigation: heading/code sizes are `em` relative to the prose body `font-size` (a single
  `px` anchor), matching github-markdown-css's own model; no nested `em` chains.
- **Risk: token bloat on a "locked public contract."** 14 tokens is the upper end. Mitigation:
  every token maps to a concrete readability lever the issue named; the heading 6 are bounded and
  1:1 with elements. Decision 2's alternative (scale+ratio) trims 4 tokens if you prefer.
- **Risk: the spec-amendment is under-recorded.** Mitigation: the doc trail touches types.ts +
  README + plan + review, exactly the surfaces #945 D4 names.
- **Alternative: bind prose to `--vscode-editor-font-*`.** Rejected — the editor font is the
  cramped baseline this issue exists to fix; only code should track it (Decision 3).
- **Alternative: a single `--codev-canvas-typography` shorthand.** Rejected — defeats per-lever
  host/user overrides and is un-snapshotable.

## Test Plan

- **Unit (vitest, new `default-theme.test.ts`):** parse `default-theme.css`, assert the full
  `--codev-canvas-*` token set (colors + new typography) is present and snapshot the sorted list;
  assert each new token has a non-empty fallback value. Run from the worktree:
  `pnpm --filter @cluesmith/codev-artifact-canvas test`.
- **Unit (existing suites):** `pnpm --filter @cluesmith/codev-artifact-canvas test` stays green
  (renderer, overlay, marker tests unaffected).
- **Type/build:** `pnpm --filter @cluesmith/codev-artifact-canvas build` and
  `pnpm --filter @cluesmith/codev-vscode build` (or the package's check-types) succeed.
- **Manual at dev-approval (load-bearing — this is why PIR):**
  - Open a long real spec/plan/review in the Codev Markdown Preview (run the worktree:
    `afx dev pir-1053`, then open the preview on e.g. `codev/specs/945-*.md`).
  - Confirm prose reads at 16px / 1.5 line-height with paragraph spacing — visibly looser than the
    cramped v3.2.0 baseline.
  - Confirm h1–h6 render with the github scale (not user-agent defaults).
  - Confirm `pre`/inline `code` stay monospace and track the **editor** font.
  - Resize the pane: confirm `prose-max-width` behavior matches Decision 4 (no cap by default).
  - Confirm **no regression**: comment cards (#863), right-edge minimap, hover-`+` overlay, and
    all color theming render unchanged in both light and dark themes.
  - *(If Tier 3 shipped)* change `codev.markdownPreview.fontSize` / `.lineHeight` and confirm the
    preview reflows live.
