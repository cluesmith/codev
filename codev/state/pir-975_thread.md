# PIR #975 — gate builder-row Run/Stop Dev Server on `worktree.devCommand`

## Plan phase (iteration 1)

Investigated the surface. Root cause confirmed: builder-row dev menu entries
(`package.json:386-394`) gate on view+viewItem family only, no config gate. The
Workspace view rows work because their `viewItem` (`workspace-dev-start/stop`) is
only emitted when `devCommand` is set (`workspace.ts:185`).

Key findings driving the plan:
- Config resolves via `loadWorktreeConfig()` → Tower's 5-layer merge (already
  shared+local layered). Reuse it; no new resolver.
- Live-refresh precedent: `WorkspaceProvider` re-renders on the
  `worktree-config-updated` SSE envelope (`workspace.ts:43-53`). Mirror that for
  the context key → satisfies acceptance #5 (no reload).
- `.codev/config.json` is always symlinked into worktrees ⇒ devCommand identical
  across builder rows ⇒ a single global `codev.hasDevCommand` key is the truth.
  Per-row metadata = future work only.
- Latent bug: `workspace.ts:185` uses `devCommand !== null`, so `"devCommand": ""`
  would show a Start row that errors on click. dev-shared.ts uses `!devCommand`.
  Resolving with a shared `hasRunnableDevCommand` (trim non-empty) helper used by
  both surfaces.

Decisions (issue's 6 design Qs): live SSE-driven key; layered config; single
global key; gate keybindings + palette too; empty-string = absent. All laid out
in the plan for the reviewer to redirect at the gate.

Plan written to `codev/plans/975-vscode-run-stop-dev-server-con.md`. Awaiting
plan-approval.

## Implement phase (iteration 1)

> **Superseded** — the render-path mechanism described in this section was
> reverted in the Review phase (consult REQUEST_CHANGES). Final implementation
> uses the global `onStateChange` + `worktree-config-updated` SSE listener in
> extension.ts. See the Review-phase section below for the final state.

Plan approved. Implemented the `codev.hasDevCommand` context-key gate.

Design evolved during pre-commit review with the architect:
- Started with an SSE-driven key (mirrors WorkspaceProvider: onStateChange +
  `worktree-config-updated` envelope). Architect pushed back: the context menu
  is on-demand/ephemeral, unlike the always-on Workspace view — it doesn't
  warrant a constant config-file listener.
- Considered a visibility-snapshot (refresh on Builders view `onDidChangeVisibility`).
  Rejected: split wiring + staleness if config edited while view already visible.
- **Landed on render-path**: `BuildersProvider.refreshDevCommandContext()` called
  fire-and-forget from `getChildren`'s root branch. The key tracks the same
  cadence as the rows the menu gates; no dedicated listener; fully co-located in
  the provider (extension.ts only passes connectionManager). Liveness: picks up
  config edits on the next tree refresh (overview poll / tree event).

Also fixed a latent empty-string bug: `workspace.ts` used `devCommand !== null`
(would show a Start row for `"devCommand": ""` that errors on click). Both
surfaces now share `hasRunnableDevCommand()` (trim non-empty).

Surfaces gated: builder-row context menu (the bug), dev keybindings, and
workspace-dev palette entries; builder-row dev palette entries pinned `when:false`
(need a row arg — same as view{Spec,Plan,Review}File).

Build + type-check clean; 276 unit tests pass (incl. 2 new test files:
has-runnable-dev-command + menu-when-clauses additions). Lint clean.

Pushing and signaling dev-approval — reviewer verifies the running worktree.

## Review phase (iteration 1)

dev-approval approved (incl. a constructor-param-grouping tweak at the gate:
moved connectionManager ahead of the transient workspaceState param).

Wrote `codev/reviews/975-vscode-run-stop-dev-server-con.md`. No arch.md /
lessons-learned.md changes (UI-gating bug within existing TreeView+when-clause
pattern; the one transferable note lives in code comments + the review). Opened
PR #978, recorded with porch.

### Consult: 2 REQUEST_CHANGES (Gemini, Codex; HIGH) vs 1 APPROVE (Claude)

Both dissents were correct and identical: the render-path refresh left the
*global* keybindings/palette stale when the Builders tree wasn't rendered
(cmd+alt+r could silently no-op with a devCommand configured). Real defect, not
a rebuttal. Gemini also caught a factual error in the review draft (render-path
isn't "consistent with" buildersAutoCollapse/buildersGroupBy — those are
onDidChangeConfiguration-driven).

Surfaced to architect; they chose **Option B (global listener)**. Reverted
builders.ts to original; restored the global `syncHasDevCommandContext` in
extension.ts (onStateChange + worktree-config-updated SSE + seed) — the
original pre-render-path approach. All three surfaces now live + consistent.
Fixed review file (mechanism + factual error + Codex coverage note). Build +
typecheck + 276 tests + lint all green. PIR is single-pass: escalating the
REQUEST_CHANGES + fix disposition to the human at the pr gate.
