# pir-1070 — in-preview typography controls (zoom) for the Codev Markdown Preview

## Plan phase (2026-08-14)

Read issue #1070 + all four comments (architect analysis → main ruling → architect
correction → main correction; later comment wins). Architect kickoff message absorbed.

**Decision:** native `editor/title` icon buttons (+/−) + three commands + keybindings,
write-back to `codev.markdownPreview.fontSize`. Host-only (apps/vscode), reuses the existing
`onDidChangeConfiguration` live-reflow path. Deliberately NOT webview chrome / no shared-package
control code, no message-protocol change.

**Plan split into two workstreams so the shared-surface change is routable to main:**
- A (core, apps/vscode): commands + editor/title buttons + keybindings + pure stepping helper +
  unit test. Ships independently.
- B (packages/artifact-canvas, ROUTE TO MAIN, measurement-gated): make `--codev-canvas-column-width`
  / `-column-gap` em-relative (400px→25em, 48px→3em; byte-equal at baseline) so horizontal-mode
  measure stays constant under zoom. Rhythm scaling (paragraph-spacing 16px @test:71, gutter 1.9rem
  @test:130) EXCLUDED — touches asserted baselines; deliberate deferral. Tall-block cap effect
  (viewport-height derived, font-size independent) documented as inherent + accepted, verified at
  dev-approval, not fixed.

Verified against tree: default-theme.test.ts snapshot pins names not values; column tokens carry no
value assertions (em change free); geometry fixtures mock resolved values (unaffected).

dev-approval gate is real: must be seen running at several zoom levels in BOTH reading modes with
fences+tables in view (screenshots/recording), because the degradation is silent.

Plan written to `codev/plans/1070-vscode-in-preview-typography-c.md`. Awaiting plan-approval.

### Plan revision 1 (architect correction, 2026-08-14)

Architect caught a false safety claim: `activeCustomEditorId` tracks the ACTIVE EDITOR, not
keyboard focus (distinct: VS Code carries a separate `focusedCustomEditorIsEditable` key). My
"keybinding wins only while focused" was wrong — with the preview active but focus in the
terminal/sidebar, `cmd+=` would shadow workbench zoom. Chose option (c): **drop keybindings from
v1** (issue lists them as optional; buttons + palette meet the discoverability goal). The
`activeCustomEditorId` gate is still correct for buttons/palette (active-editor semantics, no global
binding to shadow). Focus-scoped keybinding is a verified follow-up.

Also reordered dev-approval Test Plan so the horizontal tall-block-cap check is FIRST with visual
evidence (architect standing instruction). Rhythm exclusion + cap-not-fixed unchanged.

### Plan revision 2 (architect + stakeholder review, 2026-08-14)

Two Workstream-B correctness fixes:
1. Killed the false "constant measure in characters" claim. Rendered measure = (pane-(n-1)gap)/n,
   which SAWTOOTHS as column count n drops (added architect's chars/line table, 900/1200/1600px ×
   16-28px). What em actually buys = a SCALING LOWER BOUND on the minimum column width (prevents
   measure collapsing under zoom), not constant measure.
2. Named the failure mode em introduces that px lacks: at the 1-column boundary the single column
   fills the pane with NO cap (horizontal mode sets max-width:none, default-theme.css:499-502), so
   wide-pane+high-zoom (1200px@24px) → 1 over-wide column ~100 chars where px kept 2 cols ~48. Kept
   em (right on balance, revert path exists) but stated the honest trade.

Dev-approval script additions: (a) reviewer states EXPECTED column COUNT per pane×zoom and confirms
it CHANGES as predicted (incl. a narrow-pane case collapsing to 1 col); (b) explicit wide-pane
1-col case (1200px@24px) judged for readability. Numbers use architect's; sanity-check one row vs
real render at implement time (0.5em glyph is rule-of-thumb).

### Plan revision 3 (both architects satisfied, 2026-08-14)

Reframed the em rationale + recorded the container cap as a first-class design option (NOT
implemented this lane):
- Sawtooth is inherent to stretch-to-fill multicol; px has it too; identical at 16px. em vs px
  differ only in where teeth fall + which extreme fails (px→too-narrow, em→too-wide). Issue is
  too-narrow-motivated, so em is the better DEFAULT — a preference between failure modes, not a fix.
- Whole-column container cap = cap container to n*(col+gap) centred (NOT prose-measure cap, which
  :499-502 warns against). Closed form: measure = 50 + 6/n chars → pane & font-size CANCEL, only
  column count survives (n=1→56, n=2→53, ≥8→~51). CONSTANT BY CONSTRUCTION. Original rationale was
  wrong about MECHANISM, right about GOAL: em alone ≠ constant; em + container cap = constant almost
  exactly. Derivation posted as issue #1070 comment (referenced, not reproduced).
- Cap caveats: (a) needs JS (sibling --codev-canvas-column-container-max, follows column-height
  pattern); (b) bounded dead space = pane mod (col+gap), worst at 1200px/24px (264px/side) — same
  boundary where uncapped is worst, so 1200px/24px is THE decisive dev-approval comparison; (c)
  recompute-on-zoom hazard — cap depends on font-size so observer must recompute on font-size change
  not only resize (bug class that passes tests, fails in hand); own dev-approval step if it lands.
- Dev-approval script: uncapped predictions (900@24→~75 em-win/px36; 1200@24→~100 em-lose/px48) vs
  capped comparison side-by-side; 1200@24 flagged decisive.
