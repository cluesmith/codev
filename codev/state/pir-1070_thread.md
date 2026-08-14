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
evidence (architect standing instruction). Rhythm exclusion + cap-not-fixed unchanged. Revised
commit follows.
