# Rebuttal — PR / Review, iteration 3

Verdicts: **Gemini APPROVE, Claude APPROVE (HIGH), Codex REQUEST_CHANGES (HIGH)** — 2:1.

Codex's single KEY_ISSUE: focus tracking on two terminal edges. Split into its two concrete parts:

## 1. Terminal-in-editor-area tabs read as editor focus — FIXED
A terminal moved into the editor area (`TabInputTerminal`) was bucketed as `other`, so activating
that tab ran the editor-focus path in `onTabEvent` and demoted a focused builder terminal to
Attention. **Fixed:** `classifyTab` now returns `kind:'terminal'` for `TabInputTerminal`; `onTabEvent`
skips the editor-focus note when the newly-active tab is a terminal (that activation is terminal focus,
already tracked by `onDidChangeActiveTerminal`). Regression test added (focused builder terminal stays
Builder Inspector across a terminal-tab activation). Verified `TabInputTerminal` exists in the pinned
`@types/vscode` 1.105.

## 2. Re-entering an already-active custom editor from a builder terminal — ACCEPTED RESIDUAL
terminal → an already-open `codev.markdownPreview` changes neither the active tab nor the active *text*
editor, so VS Code fires **no event** and the panel can stay on Builder Inspector until the next editor
interaction. This is the same inherent event-gap as the terminal re-entry case; closing it fully needs
focus polling, which the design deliberately avoids. **Gemini and Claude both APPROVE**, and Claude
reviewed this exact path and called the residual "real and documented … accepted trade-off." Documented
under **Known Limitations (focus tracking)** in the review with the other bounded, self-healing
residuals. No builder's content can render as another builder's; the skeleton is not blocked.

## Result
78 files / **919 tests** (+1), check-types (both tsconfigs) + eslint + esbuild clean. The classifiable
part of Codex's finding is fixed; the unclosable part is an owner/architect call at the pr gate, now
explicitly documented rather than silently shipped.
