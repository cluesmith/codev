# Rebuttal — PR / Review, iteration 2 (post purely-contextual reshape)

Verdicts: Gemini APPROVE, Codex REQUEST_CHANGES, Claude REQUEST_CHANGES. All adopted.

## Correctness
- **Terminal RE-ENTRY not detected** (Codex): editor → same terminal fired no `onDidChangeActiveTerminal`, so Builder Inspector didn't re-activate. **Fixed:** `onDidChangeActiveTextEditor(undefined)` (fires as focus leaves the editor) now re-activates the terminal when a builder terminal is active and the active tab is not a custom editor (`SurfaceContextReader.terminalFocusLikely()`); the markdownPreview-holds-focus case is excluded. Regression test added (terminal → editor → same-terminal → Builder Inspector). Residual false-positive (focus to another non-editor UI while a builder terminal is active) documented; self-heals on the next editor interaction.

## Dead code from the removal (Codex, Claude)
- **`DevTreeProvider` (`views/dev.ts`)** had zero importers → **deleted**.
- **`codev.dev.showSidebar` / `hideSidebar`** were unreachable (`when:false` palette + deleted view/title menu) → **removed** everywhere: command defs + palette entries (package.json), registrations + import (extension.ts), and the `showCodevSidebar`/`hideCodevSidebar` functions (dev-actions.ts).
- **`formatUptime` / `extractDevPort`** (now test-only) → **retained and documented** in `dev-format.ts` (pure, tested, `vscode`-free helpers for a future dev surface); `formatTargetName` still backs the chip.

## Review doc stale (Codex, Claude)
- **Spec Compliance rewritten** around the shipped purely-contextual design; the pills / navigability / transient-nav / summary+detail / drill-in / "Codev Dev untouched" checkboxes are gone (marked SUPERSEDED); dev-approval marked done.
- **Deviations** now explicitly document the dev-approval redirect as a **frozen-spec deviation by owner direction**, and the zoom-out / A2-navigation items as **withdrawn / moot** (per the architect).
- **Stale comments** fixed (`surface-context.ts`, `no-persistence.test.ts`, `template.test.ts`).

## Dev chip (architect directive)
- Retargeted from the dead `codev.dev.focus` to **reveal the running dev PTY's terminal** (`terminalManager.revealDevTerminal()` + `codev.dev.reveal`); tooltip updated ("Click to show the dev terminal").

## EPERM (both)
- Reviewer-sandbox temp-dir failure; N/A — the suite passes here (918) and in CI.

## Result
78 files / 918 tests, check-types (both tsconfigs) + eslint + esbuild clean.
