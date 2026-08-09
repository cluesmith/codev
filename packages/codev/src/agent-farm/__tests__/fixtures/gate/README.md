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
- **agy-idle.clean.txt, agy-draft.busy.txt, agy-trust.busy.txt** — **synthesized** to
  the **Phase 3 live measurement** of agy (Antigravity CLI 1.1.8). agy was captured
  under the spike harness (`agy-measure.cjs`), but its banner embeds the authenticated
  **account email**, so the raw capture is not committed; the fixtures reproduce the
  measured *attributes* with sanitized content. Measured facts they encode: agy's
  marker is `> ` (palette-12 bright blue), its idle mode-hint (`Accept-edits mode: …`)
  renders in **palette-8 (gray)** at normal intensity (dim=0), user-typed text is
  **default-fg**, and the per-folder trust dialog's selected `> Yes, I trust this
  folder` option is **palette-12**. So idle → clean (gray hint ignored), draft → busy
  (default-fg text counts), trust → busy (palette-12 option counts — a blind Enter
  never confirms filesystem trust). The raw measurement (with real render + per-cell
  fg attributes) is archived in the Phase 3 review.
- **kimi-idle.clean.txt, kimi-draft.busy.txt, kimi-trust.busy.txt** — **real captures**
  from Kimi Code CLI **0.34.0** under a PTY at the same 110×32 the suite classifies at
  (harness: `codev/spikes/pir-1201-kimi-gate-measure.mjs`, Issue #1201). Committed raw:
  unlike the agy captures these embed no account identity — only throwaway `/tmp`
  worktree paths. Measured facts they encode: kimi draws its composer inside a **rounded
  box**, so the input row is `` │ > `` with the marker at **column 3**, not the row start
  (hence its own `markerPattern`, and the classifier's marker exemption spanning the
  matched region rather than column 0); an idle kimi composer carries **no placeholder
  text at all** — just the marker and an inverse-space block cursor, which the whitespace
  rule already skips — so kimi needs **neither** a dim rule nor a `placeholderFgPalette`;
  typed text is **default-fg at normal intensity** → counted → busy; and the 0.33.0+
  **folder-trust dialog** has no marker at a row start → `no-composer-marker` → busy, so
  a blind Enter can never confirm filesystem trust (the same guarantee agy's trust dialog
  gets). The box bottom (`` ╰───╯ ``, indented one column) is kimi's sole region-end
  pattern — the shared rule pattern requires the rule glyph to start the line and so
  cannot bound it.
- **kimi-multiline.busy.txt, kimi-multiline-bare.busy.txt, kimi-newline-bare.busy.txt,
  kimi-menu.busy.txt, kimi-picker.busy.txt** — **real captures** (0.34.0, same harness)
  of the multi-row composer states, which is where a LAST-match marker search goes
  wrong. kimi renders a two-line draft as `` │ > <line one> `` / `` │   <line two> ``, so
  a continuation row beginning with `>` matches the marker too and the search settles
  on it, leaving line one *above* the scanned region. `kimi-multiline-bare` is that
  false-CLEAN with a real draft above the bare `>` — closed by the profile's
  `regionStartPatterns` (anchor the region to the box top). `kimi-newline-bare` is the
  residual the region bound alone cannot close (architect review, 2026-08-09): a
  newline then `>` renders `` │ > `` / `` │   > `` — row one empty, row two's `>`
  span-exempted as chrome — so the draft is real but has **zero countable cells** no
  matter how the region is bounded. It is held on the composer's *shape* instead
  (`multi-row-draft`), which is sound because box growth was **measured** to be
  exclusive to multi-line drafts on 0.34.0 (harness:
  `codev/spikes/pir-1201-kimi-box-growth.mjs` — idle, single-line draft, `/` menu, `@`
  picker and the post-reply steady state all hold at one interior row; and
  `pir-1201-kimi-working-states.mjs` — mid-generation, mode chrome, and a draft typed
  while the agent works, likewise one row). The menu and picker captures pin that kimi
  draws those lists *outside* the box, below its bottom rule, so neither grows the
  scanned region. The rule is armed by the profile's `growsWithDraft` flag, **not** by
  `regionStartPatterns`: `codex-idle.clean.txt` is a real, genuinely empty composer that
  already spans two interior rows, so arming on the scan bound alone would hold codex
  mail forever the day codex declared one.
- **wrapper-boot.busy.txt** — **synthetic** builder launch-loop screen (a born-dirty
  state with no composer marker). App-agnostic: no marker → busy under any profile.

## Classifier assumption

CLEAN requires a composer marker **and** zero normal-intensity, non-whitespace,
non-chrome cells in the composer region. Placeholder/hint text is excluded by an
**attribute** the profile names: claude/codex de-emphasize it with SGR-**dim**
(universal skip); agy uses a **foreground color** instead (palette-8), declared per
profile as `placeholderFgPalette`. Either way the exclusion is attribute-based, never
a text allowlist. A future TUI (or a shim) that renders a plain, un-de-emphasized
placeholder trips toward *busy* (fail-safe: a message is held, never misdelivered);
classifier-health telemetry (Phase 4/7) surfaces such a profile drift.
