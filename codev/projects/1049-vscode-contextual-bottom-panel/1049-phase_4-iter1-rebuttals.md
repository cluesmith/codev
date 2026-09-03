# Rebuttal — Phase 4, iteration 1

Verdicts: Gemini APPROVE, Claude APPROVE, Codex REQUEST_CHANGES.

## Codex (REQUEST_CHANGES) — adopted
1. **Active pill was not clickable**, so a drilled-in Code Review / Builder Inspector detail had no in-mode path back to its summary (contradicting summary ⇄ detail / "always navigable"). **Fixed:** added a pure `pillIsInteractive(state)` (true unless disabled); the `Pill` now attaches the navigate handler for the active pill too. Clicking the active builder-scoped pill sends `mode-navigate` (no builderId) → the provider resolves the summary, dropping the builder attachment. Tests: `pillIsInteractive` unit test + a provider round-trip (drill-in → detail, then navigate the active mode → summary with no builderId). CSS active-pill cursor/hover updated to read as clickable.
2. **Changelog text not actually present.** **Fixed:** added the `apps/vscode/CHANGELOG.md` and `docs/releases/UNRELEASED.md` entry text to `spir-1049_thread.md` for the architect's post-merge `docs/vscode-changelog` workflow (the entry is not committed on this feature branch by convention).

## Claude (non-blocking)
- Active-pill-back-to-summary — same as Codex #1, fixed.
- Disabled-pill tooltip artifact-worded: safe because only Document Review can be inapplicable (the resolver keeps the other three always-applicable — covered by the applicability tests); left as-is.
- Changelog text — provided, as above.

## Result
74 files / 892 tests, check-types (both tsconfigs) + eslint + build clean.
