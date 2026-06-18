# PIR Review: Typography tokens for the Codev Markdown Preview (artifact canvas)

> Issue #1053 · area/vscode · Fixes #1053

## Summary

The Codev Markdown Preview (`@cluesmith/codev-artifact-canvas` mounted by `MarkdownPreviewProvider`)
inherited the host's code-tuned typography: prose rendered at the workbench UI font with a tight
line-height and no paragraph rhythm, heading scale, or prose-element styling. Spec 945 D4 had
deliberately capped the v1 `--codev-canvas-*` vocabulary at colors, so there was no lever for any
of it.

This PR extends the canvas theming contract with a **typography token tier** (github-markdown-css
v5.8.1 as the pinned baseline) and wires it through the VSCode host, in three tiers:

1. **Package tokens + element styling** (`default-theme.css`) — 13 typography tokens (font
   size/family, line-height, paragraph spacing, optional prose-width cap, per-level heading sizes,
   code font family/size) plus the CSS rules that consume them. The element pass also styled the
   block elements that were falling through to user-agent defaults: inline `code` chips, fenced
   `pre`, blockquotes, tables, `hr`, images, and list indentation.
2. **Host mapping** (`preview-template.ts`) — binds code to the editor font while prose keeps the
   readable sans stack, and pairs inline code with VSCode's theme-tuned `textPreformat-*` tokens.
3. **User settings** (`package.json` + `preview-provider.ts`) — `codev.markdownPreview.fontSize`
   and `.lineHeight`, with live reflow on change.

Two color/layout correctness fixes landed during dev-approval review (see Lessons Learned): a
dark-mode inline-code contrast bug, and a page-level horizontal-scroll bug from unbreakable long
tokens.

The token vocabulary is a "locked public contract" (spec 945 D4), so the expansion carries a
spec-amendment doc trail across `types.ts`, the package README, this review, and the issue.

## Architecture Updates

No changes needed to `arch.md` / `arch-critical.md`. This PR extends an existing, documented
subsystem (the spec-945 canvas theming contract) along the seam it was designed to extend — CSS
custom properties overridden by the host. It introduces no new module, process boundary, state
store, or invariant. The canvas's Model-A theming (CSS variables, not JS `resolve()`) is unchanged;
only the token *vocabulary* grew, which is documented in the package itself (`default-theme.css`,
README) and in the `types.ts` contract comment, the correct homes for it.

## Lessons Learned Updates

No changes needed to the HOT `lessons-critical.md` (it is capped and these are domain-specific, not
high-blast-radius cross-cutting rules). Three reusable lessons are recorded in the COLD
`lessons-learned.md` under **UI/UX** (added in this PR):

- **A `background` token without a matching `foreground` token is a latent contrast bug.** Inline
  code shipped (pre-#1053) with a background token but no foreground token, so its text fell through
  to the *general* body foreground; the host then paired a code-*block* background with the general
  foreground (different theme color groups, no contract that they contrast), and dark themes
  rendered low-contrast inline code. Model surface fg/bg as a **pair** bound from the same theme
  group; add the foreground in the same change as the background.
- **Prose and code want opposite overflow behavior.** Long unbreakable tokens in prose force a
  *page-level* horizontal scrollbar unless the prose container sets `overflow-wrap: break-word`;
  `pre`/`table` must not wrap and opt out via their own `overflow: auto` to scroll within the block.
- **Watch `em`-on-`em` compounding when nesting sized elements.** Sizing both `pre` and `code` to
  `0.85em` made fenced `pre code` ~72%; reset the inner `pre code` to `font-size: inherit` (and its
  chip chrome) since code inside a fence is plain text, not an inline chip.

(All three recorded in `codev/resources/lessons-learned.md` under UI/UX.)

## Files Changed

| File | Change |
|---|---|
| `packages/artifact-canvas/src/styles/default-theme.css` | +13 typography tokens, +1 color token (`code-foreground`); prose/heading/code/blockquote/table/hr/img rules; `overflow-wrap` wrap fix |
| `packages/artifact-canvas/src/types.ts` | D4 contract-amendment comment (typography tier + code-foreground) |
| `packages/artifact-canvas/README.md` | color + typography token tables; VSCode binding example; github-markdown-css v5.8.1 pin |
| `packages/artifact-canvas/src/__tests__/default-theme.test.ts` | new — token-vocabulary inline snapshot + default + contrast-token assertions |
| `packages/vscode/src/markdown-preview/preview-template.ts` | Tier-2 token bindings (code→editor font, prose→sans; inline code→`textPreformat-*`); Tier-3 user-override emission |
| `packages/vscode/src/markdown-preview/preview-provider.ts` | read `codev.markdownPreview.*`; live reflow via `onDidChangeConfiguration` |
| `packages/vscode/package.json` | register `codev.markdownPreview.fontSize` / `.lineHeight` |
| `packages/vscode/README.md` | document the two settings |

## Commits

- `[PIR #1053] Add typography token tier to canvas default-theme.css`
- `[PIR #1053] Bind typography tokens in VSCode preview + add font-size/line-height settings`
- `[PIR #1053] Document markdownPreview font-size/line-height settings in README`
- `[PIR #1053] Add code-foreground token + style code/blockquote/table/hr/img elements`
- `[PIR #1053] Pair inline code with VSCode textPreformat tokens for dark-mode contrast`
- `[PIR #1053] Break long tokens in prose to prevent page-level horizontal scroll`

(Plus thread-log commits.)

## Test Results

- `pnpm --filter @cluesmith/codev-artifact-canvas test` — **56 passed** (incl. the new
  `default-theme.test.ts` token-vocabulary snapshot, contrast-token assertion, and the
  standalone-`MarkdownView`-coverage regression test added after the 3-way consult).
- `pnpm --filter codev-vscode test:unit` — **442 passed**.
- `pnpm --filter @cluesmith/codev-artifact-canvas build`, vscode `check-types` (host + webview
  tsconfigs) and the esbuild production bundle — all clean.
- Verified the typography tokens, prose/element rules, `code-foreground`, and `overflow-wrap` all
  land in the bundled `packages/vscode/dist/webview/markdown-preview.css`.
- Manual (dev-approval): readability before/after on a long spec, dark-mode inline-code contrast,
  pane resize / no page-level horizontal scroll, per-block scroll on `pre`/tables, and live reflow
  of the two settings.

## Decisions Locked (at plan-approval, confirmed through dev-approval)

1. **Token list** — 13 typography + 1 color (`code-foreground`, added during review) = 22 total.
2. **Heading granularity** — per-level tokens (`h1-size`…`h6-size`), not scale+ratio:
   github-markdown-css's scale is non-geometric and a single ratio can't reproduce it.
3. **Prose vs editor font** — prose overrides the editor font (github sans, 16px/1.5); code tracks
   the editor font. Baseline pinned to **github-markdown-css v5.8.1**.
4. **`prose-max-width`** — ships `none` (no cap); opt-in to e.g. `72ch`.
5. **Tier 3** — included (confirmed essential by the reviewer); two settings only.

## Things to Look At

- The prose/code font split (`preview-template.ts`): code tracks the editor font, prose uses the
  github sans stack. Documented inline so a future maintainer doesn't rebind prose to the editor
  font (the cramped baseline this surface fixes).
- The two horizontal-scroll behaviors are intentionally different: `pre` + `table` scroll *within
  their block* (long code lines / wide tables shouldn't wrap); prose breaks long tokens
  (`overflow-wrap`) so it never forces a *page-level* scrollbar.

### 3-way consultation disposition (single advisory pass, `max_iterations: 1`)

- **Codex — REQUEST_CHANGES (HIGH), addressed (real defect).** The typography rules were scoped to
  `.codev-artifact-canvas-body` only, but the **exported standalone `MarkdownView`** renders
  `.codev-artifact-canvas-rendered` with no `.codev-artifact-canvas` ancestor — so the standalone
  public surface received *no* typography (not even the base font), contradicting the approved
  plan, which required both containers be covered. **Fix:** the token + base-font block now names
  both roots, and every prose element rule uses an `:is(.codev-artifact-canvas-body,
  .codev-artifact-canvas-rendered)` container group; overlay-only chrome (gutter, focus outline,
  cards, minimap) stays composed-surface-only. Added a regression test
  (`default-theme.test.ts` → "covers the standalone MarkdownView root…") that fails if a prose rule
  or the token block stops naming the standalone root. The VSCode preview (the only current
  consumer, which uses `ArtifactCanvas` → `-body`) is unaffected — `-body` is inside the `:is()`
  group. *Escalated because PIR's single-pass design did not independently re-review this fix.*
- **Claude — APPROVE (HIGH).** Flagged the same scoping gap as a non-blocking observation; its
  parenthetical that the standalone view still "gets the font baseline" is incorrect (the base font
  is on `.codev-artifact-canvas`, not an ancestor of `-rendered`), which is exactly why it was
  worth fixing rather than rebutting.
- **Gemini — no usable verdict.** Output was a sandbox/environment message, not a review (no
  VERDICT line). Nothing to action.

## Follow-ups

- **#1070** (area/vscode) — in-preview typography controls (zoom buttons / command + write-back).
  The tokens and the two settings shipped here; #1070 is purely the in-surface UI affordance,
  deliberately out of this PR's scope.

## How to Test Locally

1. `afx dev pir-1053` (or VSCode → right-click builder → Run Dev Server).
2. Open a long spec/plan/review in the Codev Markdown Preview (e.g.
   `codev/specs/945-build-foundational-reusable-pa.md`).
3. Confirm prose reads at 16px / 1.5 with paragraph spacing and a deliberate heading scale; code
   blocks are monospace + track the editor font; inline code is legible in both light and dark
   themes; tables/blockquotes/hr render deliberately.
4. Resize the pane — no page-level horizontal scrollbar; `pre`/tables scroll within their block.
5. Change `codev.markdownPreview.fontSize` / `.lineHeight` in Settings — the open preview reflows.
