# Rebuttal — Spec 1049, Specify iteration 1

Gemini APPROVED. Codex and Claude requested changes; both were high-confidence and, on verification against the actual `apps/vscode` source, correct. I verified every source-level claim before acting (per the "verify reviewer claims against the actual file" lesson) and adopted essentially all of them. Summary below, grouped by point, with the verification and the change made.

## Verified before acting

| Claim | Verified against | Verdict |
|---|---|---|
| Active-terminal→builder is `getActiveBuilderId()`, not `resolveBuilderTerminal` (which is the inverse) | `apps/vscode/src/terminal-manager.ts:450`, `terminal-resolve.ts:71` | Correct — adopted |
| `codev-diff:` is the base/**left** side; right is a `file:` worktree doc (the side the context key keys off) | `apps/vscode/src/commands/view-diff.ts:13–21,38,133–140` | Correct — adopted |
| `onDidChangeDiffInjectRegistry` exists and the registry populates **after** the diff activates | `apps/vscode/src/diff-inject-codelens.ts:186–192,235` | Correct — adopted |
| `codev.activeEditorIsBuilderFile` is true for **any** registered builder file, incl. a normal tab | `diff-inject-codelens.ts:178` | Correct — grounds the overlap point |
| `codev.markdownPreview` is a `priority:"option"` custom editor → `activeTextEditor` is `undefined` when reading a spec via Codev preview | `apps/vscode/package.json:49–58` | Correct — adopted |

## Codex (REQUEST_CHANGES) — point by point

1. **Terminal-vs-editor focus semantics / how returning to an editor exits Builder Inspector.**
   Agreed. Added a Constraint requiring the adapter to resolve active-surface (most-recently-focused editor tab vs terminal) and an Important open question defining the exit rule (editor focus supersedes terminal, terminal focus supersedes tab; Builder Inspector holds only while the terminal is most-recent).

2. **Pin/override underspecified (lifetime, pinning inapplicable modes, context for a pinned builder-dependent mode).**
   Agreed. Unified session-override and pin into one `ModeOverride { mode, persistent }` model with a defined lifetime in Success Criteria, and added an Important open question covering the clearing rule and pinning of builder-dependent modes (any mode pinnable; renders an empty "no builder" state when context is absent).

3. **Terminal source was wrong (`resolveBuilderTerminal`).**
   Correct and adopted — Current State and Constraints now cite `getActiveBuilderId()` and note `resolveBuilderTerminal` is the inverse helper.

4. **Define plain, VSCode-free `activeContext` / state / applicability / precedence / `ModeDescriptor.context`; rename ambiguous `workspaceState`.**
   Agreed. The resolver signature is now VSCode-free: input is a plain `SurfaceContext` + `ModeOverride | null` (no `Memento`); the host adapter reads the persisted override before calling. Applicability of all four modes is part of the return. Precedence is now an explicit required criterion.

5. **Webview security criteria (nonce CSP, resource roots, message allowlist, escape labels).**
   Agreed. Added as a Success Criterion, a Constraint, Test Scenarios (CSP/nonce/escaping), and a Risk row.

6. **Automated coverage beyond resolver+manifest (provider wiring, webview messages, override reset, pin persistence).**
   Agreed. Added a "Provider / integration" test-scenario block covering exactly these, plus updated the testing criterion.

## Claude (REQUEST_CHANGES) — point by point

1. **No precedence rule for overlapping predicates (a builder `codev/specs/*.md` in a diff session matches both Document Review and Code Review).**
   This was the load-bearing gap for a resolver spec. Agreed and adopted: precedence is now a required, total, tested criterion; the recommended order (terminal → builder-diff → artifact-path → attention) is stated, with the final order flagged as a plan-gate decision. Added the overlap case to Test Scenarios.

2. **Editor-centric context model fails on custom-editor / multi-diff surfaces (opening a spec via Codev preview falls to Attention; registry populates after activation → stale key on first open).**
   Agreed and adopted: context is now derived from the active **tab** input (`window.tabGroups`), not `activeTextEditor`; the trigger set explicitly includes tab-group changes, terminal-focus changes, and `onDidChangeDiffInjectRegistry`. Added test scenarios for custom-editor-active → Document Review and multi-diff-tab (pre-registry) → Code Review.

3. **"Session override" is an undeclared fourth resolver input with undefined lifetime.**
   Agreed. Folded into the unified `ModeOverride` model with a defined lifetime and clearing rule (Success Criteria + Open Questions).

4. **Imprecise `codev-diff:` claim (it is the left/base side; tracked side is `file:`).**
   Correct and adopted in Current State.

5. **Pin-scope recommendation contradicts issue #1049's out-of-scope "each window keeps its own pin state."**
   Agreed — reframed. I no longer recommend reversing the issue. The spec now reconciles the two statements: `workspaceState` is per-workspace-folder, so distinct-folder windows already keep distinct pins; only the rare identical-folder-multi-window case shares. Presented as an architect decision at the gate, defaulting to honoring both statements for the common case.

6. **Security unaddressed for the webview substrate (CSP/nonce/`localResourceRoots`, escape path/builder-id-derived header text).**
   Agreed and adopted (same additions as Codex #5).

## Gemini (APPROVE) — adopted suggestions

- **VSCode-free resolver signature** (plain `SurfaceContext`/`ModeKind`, extract override from `workspaceState` before calling): adopted (also matches Codex #4).
- **Sticky-input orchestration** (`postMessage({ type: 'userEditingStateChanged', isEditing })` so the host defers re-resolution): folded into the sticky-input open question.

## Points not adopted / scoped out

- None outright rejected. Where reviewers asked for a *decision* (precedence order, active-surface semantics, override-clearing affordance, pin scope), I recorded a recommendation but deliberately left the final choice to the plan gate rather than baking it into the spec — these are the architect's calls and are listed under Open Questions (Important).
