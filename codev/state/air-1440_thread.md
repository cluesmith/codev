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
- Implemented + PR #1443 opened (review in body).
- CMAP (AIR PR): gemini=APPROVE(HIGH), claude=REQUEST_CHANGES(HIGH), codex=unavailable (external
  OpenAI billing — "no credits remaining", not our code).
- **Acted on Claude's blocking finding (verified against the PNGs first):** the first-pass list
  icons filled only ~45% of the frame vs the ~95% convention, because `listSvg` reused the
  key-frame padding and the glyphs don't fill their 24×24 box. Rewrote the render pipeline to
  rasterize the glyph, trim to its true bbox, then fit to the convention's fill fraction
  (list 0.94, key 0.56) via `magick` + `rsvg-convert`; added a self-check that fails the build if a
  list icon drops below 80% coverage. Re-measured: list @2x now 38×36 / 38×30 (sibling 38×34); key
  @2x 81×77 / 81×65 (sibling 80×68). Also addressed Claude's minors: friendly ENOENT for both
  system tools, quoted-key-safe `extractGlyph` regex, and a zero-dep PNG-dimension test guard.
- Deferred (architect's call, noted in PR): open-terminal's glyph resembles the still-shared
  `icons/action` used by catch-all "Codev Action" — re-glyphing Codev Action (to `bolt`) would
  fully resolve the picker ambiguity; the terminal→open-terminal mapping itself is baked scope.
- Verified: check-types ✓, build ✓, `streamdeck validate` ✓, vitest 162 passed.
- Next: commit fix, push, update PR body, notify architect, porch done.
