# Render-gate fixtures (Spec 1313, Phase 2)

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
- **wrapper-boot.busy.txt** — **synthetic** builder launch-loop screen (a born-dirty
  state with no composer marker). App-agnostic: no marker → busy under any profile.

## Classifier assumption

CLEAN requires a composer marker **and** zero normal-intensity, non-whitespace,
non-chrome cells in the composer region. It relies on real claude/codex rendering
placeholder/hint text de-emphasized (dim). A future TUI (or a shim) that renders a
plain placeholder trips it toward *busy* (fail-safe: a message is held, never
misdelivered); classifier-health telemetry (Phase 4/7) surfaces such a profile drift.
