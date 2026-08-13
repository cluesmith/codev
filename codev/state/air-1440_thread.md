# air-1440 — Stream Deck polish follow-ups (dedicated action icons)

## Scope (architect-authoritative, issue comment 5274852386)
- AIR, mechanical. RENDER two action icons from the glyph vectors already in
  `apps/streamdeck/src/face.ts` GLYPHS — `comment` → `send-queue`, `terminal` → `open-terminal`.
- Outputs per icon: `icons/<name>.png` (72), `icons/<name>@2x.png` (144),
  `icons/list/<name>.png` (20), `icons/list/<name>@2x.png` (40). Repoint manifest `Icon` +
  `States[].Image` off the shared `action` asset.
- Delete six verified-dead PNGs: approve-gate-empty, approve-gate-pending, gate-nav (+@2x each).
  KEEP approve-gate.* and list/approve-gate.* (live).
- Profile work OUT. No key-face / press-behaviour change.
- **Do NOT edit face.ts or actions.ts** — bugfix-1431 is in flight there. Diff = manifest.json
  + icon files (+ a committed render script, justified below).

## Decisions
- **Single source honored by parsing face.ts at build time.** The render script reads
  `src/face.ts`, extracts the `comment`/`terminal` GLYPHS path data + the `stroked()` wrapper,
  and rasterizes — so the PNGs derive from the exact same vector the runtime key face uses, with
  zero duplication and zero edit to face.ts.
- **Rasterizer: system `rsvg-convert` (librsvg), no new npm dep.** Architect asked to prefer
  repo-available tooling over adding a dependency for a one-time asset build. Script committed at
  `apps/streamdeck/scripts/render-action-icons.mjs` for reproducibility; it shells to
  rsvg-convert (documented in PR body).
- Frame matches existing convention measured from live assets: key image = rounded rect rx=12
  fill `#1C2128` + white glyph; list icon = transparent + white glyph.

## Status
- Implemented. 8 PNGs rendered (send-queue←comment, open-terminal←terminal), manifest repointed,
  6 dead PNGs removed. Render script committed. Two vitest files added.
- Verified: check-types ✓, esbuild build ✓ (after building @cluesmith/codev-sdk dist — the
  pre-existing "cannot find codev-sdk" errors are a fresh-worktree artifact, not from this change),
  `streamdeck validate` ✓, vitest 160 passed. Glyphs visually confirmed (comment bubble + terminal
  window); key-image bg/corner pixels byte-match the existing action.png convention.
- Next: commit, open PR with review in body (no review file — AIR).
