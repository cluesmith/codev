# air-1474 — Render gate: tighten the loose agy prompt marker

Protocol: AIR (strict). Issue #1474. Branch `builder/air-1474`.

## What the issue asks

`AGY_MARKER = /^> /` in `gate-profiles.ts:72` treats *any* line starting with `> ` as agy's
composer prompt. Tighten it using signals the agy classifier already has (cursor row,
placeholder-fg palette, region boundary). Risk direction is **false-CLEAN** — deliver onto a
busy screen — so every ambiguity resolves to HOLD.

## Real-agy measurement (this is the load-bearing part)

agy 1.1.13 is authenticated in this environment, so the fixtures are **real captures**, not
synthesized. Captured under `node-pty` at 110×32 (`TERM=xterm-256color`), one capture per state,
then rendered through `@xterm/headless` and probed cell-by-cell.

| state | last `> `-matching row | that row's fg | cursor row | today's marker pick | actual composer |
|---|---|---|---|---|---|
| idle (accept-edits) | 11 | palette 12 | 11 | 11 ✅ | 11 |
| idle (bare `>`, no hint) | none — `trimEnd()` leaves `>` | palette 12 | 11 | **-1 ✗ false-HOLD** | 11 |
| draft | 24 | palette 12 | 24 | 24 ✅ | 24 |
| slash menu (`/`) | 13 — *menu selection cursor* | palette 12 | 11 | **13 ✗ wrong row** | 11 |
| trust dialog | 8 — *selected option* | palette 12 | 12 (off-row) | **8 ✗ wrong row** | none |
| settled after an answer | 20 | palette 12 | 20 | 20 ✅ | 20 |
| mid-repaint (torn prefix) | 10 — *user-turn echo* | palette **4** | varies | **10 ✗ wrong row** | absent |

Three findings that changed the design:

1. **agy echoes every submitted user turn into the transcript as a `> ` line** (SGR 34;1 →
   palette 4). So non-composer `> ` rows are not hypothetical — they accumulate one per turn.
2. **The slash menu's selection cursor is also `> ` and also palette-12**, and it renders
   *below* the composer — so `findMarkerRow`'s last-match-wins picks the menu item, not the
   composer. A palette anchor alone does NOT separate these; the **cursor row does**.
3. **In agy's no-hint mode the composer row is a bare `>`**, which `/^> /` never matches →
   the gate holds every message forever in that mode. Pre-existing false-HOLD, fixed here
   (the marker must match the *actual* composer, which is the issue's ask).

Markdown blockquotes render as `│`, not `> ` — so the issue's "quoted output" risk arrives via
the user-turn echo rather than via blockquotes.

I could not reproduce an actual false-CLEAN from the real captures: on every mis-bounded frame
the wrong region still contained counted text, so the verdict landed busy anyway. The defect is
real (the classifier bounds the wrong region on real frames); the corruption is latent. Said
plainly in the PR rather than overclaimed.

## Design

Two new optional `GateProfile` fields, both per-app data, both set only on agy:
`markerRequiresCursorRow` (the marker row must hold the cursor) and `markerFgPalette` (the
marker glyph cell must render in that palette index). Marker text pattern relaxed to
`/^>(\s|$)/` so the bare-`>` mode matches. Net effect: strictly more evidence required to call a
row the composer, and no new false-CLEAN surface.

Known accepted cost: a mid-repaint frame can park the cursor on the status line for one frame,
which now HOLDs where it previously classified clean. Transient and fail-safe — retried on the
next check — and every *settled* capture puts the cursor on the composer row.

## Pre-existing e2e failures (NOT from this change)

The AIR `pr` phase's `e2e_tests` check is `npm run test:e2e … || echo 'skipped'` and the repo root
has no `test:e2e` script, so it passes in 0.1s having run nothing. Ran the real suite instead
(`pnpm --filter @cluesmith/codev test:e2e`): **3 failed | 171 passed | 21 skipped**, all three in
`tower-api.e2e.test.ts` — `POST /api/terminals` returning 500 where 201 is expected.

Confirmed pre-existing, not flaky: reverted both changed source files to the branch base
(141b4935), rebuilt, re-ran that file — **identical 3 failures**. Restored the files afterwards
(everything was committed, so lossless; verified clean against HEAD). Not skipped or annotated,
since they are neither mine nor flaky — flagged for the maintainer instead. Plausibly
environmental: this box is running four-plus live builder sessions plus Tower, and the failures
are all PTY-spawn-via-API.

## Status

- [x] Real agy fixtures captured across idle / draft / trust / menu / echo / bare-marker / torn
- [x] Classifier + profile change
- [x] Tests (55 pass; build ✓, unit ✓ via `porch check`)
- [x] PR #1491 opened — parked for maintainer review
- [ ] `pr` gate: awaiting an explicit human decision (this cohort does not merge)
