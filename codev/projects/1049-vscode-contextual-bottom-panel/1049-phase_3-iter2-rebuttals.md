# Rebuttal — Phase 3, iteration 2

Verdicts: Gemini APPROVE, Claude APPROVE, Codex REQUEST_CHANGES. One REQUEST_CHANGES point + Claude's three non-blocking items — all adopted.

## Codex (REQUEST_CHANGES)
- **surfaceKey / activeTabResource omitted tab kind + viewType**, so a file's raw editor and its `codev.markdownPreview` (same path) were one surface — switching between them wasn't a transition (missing focus demotion / re-post / Phase 4 clear). **Fixed:** both identities now include `kind` + `viewType` (`tab:${kind}:${viewType}:${fsPath}`). Added a same-resource text→custom `surfaceKey` test.

## Claude (non-blocking, all adopted)
1. **Residual "fires nothing" not documented / comment overstated the selection proxy.** Rewrote the `onDidChangeTextEditorSelection` comment to state the residual cases accurately (clicking into the already-active editor without a cursor move, or focus paths VS Code emits no event for — accepted per spec).
2. **Selection handler ignored `event.textEditor`**, so a programmatic selection in a background visible editor could demote a focused terminal. **Fixed:** the handler notes editor focus only when `event.textEditor === window.activeTextEditor`.
3. **`pillsFromDescriptor` untested.** Extracted the pure pill model (order, labels, descriptor→state) into a React-free `pills.ts` (so it type-checks/tests under the host tsconfig, no DOM) and added `contextual-panel-pills.test.ts`; `components.ts` now consumes it.

## Result
72 files / 874 tests, check-types (both tsconfigs) + eslint + build clean.
