# Render-gate fixtures (Spec 1313, Phases 2–3)

Each `*.txt` is the **raw PTY byte stream** for one composer state. `render-gate.test.ts`
pushes it through the production `RingBuffer` (`pushData` → `getAll().join('\n')`) and
classifies the reconstruction — the exact data path the live gate uses. The filename
encodes the expected verdict: `<app>-<state>.<clean|busy>.txt`.

## Provenance

- **codex-*.txt** — **real captures** from `codex` running under a PTY in this repo
  (idle, draft, menu, model-picker). This environment renders codex faithfully: the
  idle placeholder is SGR-**dim**, typed text is normal-intensity, so the classifier
  distinguishes them exactly as the spike measured (`codev/spikes/1265-poc`).
- **claude-draft.busy.txt, claude-menu.busy.txt** — **real captures** from `claude`
  (Claude Code 2.1.212) under a PTY. Typed text renders at the default foreground /
  normal intensity, which the classifier counts as occupancy → busy. Faithful.
- **claude-idle.clean.txt** — **synthesized** to match the spike's *real-claude*
  measurement (placeholder rendered **dim**, `g2a`: `dim=1`). The `claude` binary in
  this sandbox is the `ez-cli` proxy shim, which renders the *idle* placeholder
  **without** de-emphasis (default foreground, attribute-identical to typed text) — an
  environment artifact, not how real claude renders. No attribute-based classifier can
  separate a non-de-emphasized placeholder from user text (and the spike deliberately
  rejected text allowlists), so this one clean-state fixture is modeled on the
  spike-measured real-claude attributes instead of the shim's atypical output.
- **claude-picker.busy.txt** — **synthesized** claude `/model` picker (same reason
  as claude-idle: the sandbox `claude` is the shim, so no real picker to capture).
  Its highlighted row begins with the **same `❯` glyph** claude uses for the
  composer marker; model names render normal-intensity. This pins the guard that a
  picker's selection-cursor `❯` + list is classified **busy** (via the user-text
  path — the marker matches the cursor, the model names count as occupancy), never
  mistaken for an empty composer. Mirrors the real **codex-picker** capture, whose
  `› 1. …` selection cursor exercises the same path.
- **agy-\*.txt** — **real captures** from `agy` (Antigravity CLI **1.1.13**) running under
  a PTY at 110×32, one per composer state (#1474; they replace the Phase 3 fixtures, which
  were synthesized from the 1.1.8 measurement because no authenticated agy was available
  then). agy's banner embeds the authenticated **account email** and the session cwd, so
  each capture is sanitized before committing: both are replaced with **same-length**
  placeholders, which leaves the rendered screen byte-for-byte equivalent. Nothing else is
  edited — no attribute is retouched. The seven states:

  | fixture | what it is | why it is here |
  |---|---|---|
  | `agy-idle.clean.txt` | empty composer, accept-edits mode | the baseline clean screen: `> ` marker (palette-12) + palette-8 gray hint |
  | `agy-baremarker.clean.txt` | empty composer, no-hint mode | agy renders a **bare `>`** here; the old `/^> /` never matched it, so every send held forever |
  | `agy-draft.busy.txt` | a typed, unsent draft | default-fg text in the region ⇒ occupancy |
  | `agy-menu.busy.txt` | the `/` slash-command menu | its selection cursor is **also `> `, also palette-12, and renders BELOW the composer** — last-match-wins picked it, not the composer |
  | `agy-trust.busy.txt` | the per-folder trust dialog | selected `> Yes, I trust this folder` is palette-12, with **no composer on screen at all** |
  | `agy-turn-echo.clean.txt` | a settled answer above an empty composer | agy echoes every submitted turn as `> <message>` (palette-4) — a `> ` row that must not steal the marker |
  | `agy-torn-echo.busy.txt` | the same stream **cut mid-repaint** | real bytes, composer not yet repainted; the only `> ` row left is the palette-4 echo (the tear shape #1361 documents) |

  The capture + sanitization harness is committed at `codev/air-1474-captures/` — re-measuring
  against a future agy starts there, not from scratch.

  Measured attribute facts these encode: the marker glyph is **palette-12** (bright blue)
  in every mode; the idle mode-hint (`Accept-edits mode: …`) is **palette-8 (gray)** at
  normal intensity (dim=0); user-typed text is **default-fg**; the transcript echo of a
  submitted turn is **palette-4**; and in every settled state the **cursor rests on the
  composer row**. Markdown blockquotes render as `│`, not `> `.
- **wrapper-boot.busy.txt** — **synthetic** builder launch-loop screen (a born-dirty
  state with no composer marker). App-agnostic: no marker → busy under any profile.

## Classifier assumption

CLEAN requires a composer marker **and** zero normal-intensity, non-whitespace,
non-chrome cells in the composer region. "A composer marker" is more than a text match
where the profile says so: agy additionally requires the marker row to hold the **cursor**
and the marker glyph to render in the profile's palette (`markerRequiresCursorRow` /
`markerFgPalette`, #1474), because `> ` alone matches its menu cursor, its dialog options
and its transcript echoes as readily as its composer. Placeholder/hint text is excluded by an
**attribute** the profile names: claude/codex de-emphasize it with SGR-**dim**
(universal skip); agy uses a **foreground color** instead (palette-8), declared per
profile as `placeholderFgPalette`. Either way the exclusion is attribute-based, never
a text allowlist. A future TUI (or a shim) that renders a plain, un-de-emphasized
placeholder trips toward *busy* (fail-safe: a message is held, never misdelivered);
classifier-health telemetry (Phase 4/7) surfaces such a profile drift.
