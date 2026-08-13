# Builder thread: spir-1049 — vscode contextual bottom panel

## Project
Issue #1049 — vscode: contextual bottom panel that adapts to active editor (mode resolver + Attention fallback).
Protocol: SPIR (strict mode). Umbrella feature: panel skeleton + ModeResolver + mode switching only.
Actual per-mode rendering is out of scope (owned by participating-feature issues #1037, Files-not-yet-reviewed, #807, etc.).

## Log

### 2026-08-12 — Specify phase start
- porch status: PHASE=specify, no spec/plan/thread yet. Started fresh.
- No literal "Baked Decisions" heading in issue, BUT the architect has baked strong direction:
  Architecture (ModeResolver + PanelRenderer split), Mode mapping v1 (4 modes), and 5 plan-gate
  "leans". Treating these as the architect's decisions — honor them, don't relitigate.
- Launched Explore agent to map current bottom-panel architecture (existing Codev scaffold tab +
  Codev: Dev tab, webview providers, active-editor APIs, Needs Attention view, persistence, tests).
- Next: write spec to codev/specs/1049-vscode-contextual-bottom-panel.md, signal SPEC_DRAFTED.

### 2026-08-12 — Spec drafted + 3-way consultation
- Wrote spec (all template sections). Explore agent confirmed: ext at apps/vscode; panel container
  `codevPanel` holds `codev.placeholder` (repurpose target) + `codev.dev` (leave alone); NO
  WebviewViewProvider exists yet (this is the first); all 3 data sources exist (ReviewQueueStore,
  SDK review-markers, OverviewCache).
- 3-way consult (porch-driven): Gemini APPROVE; Codex + Claude REQUEST_CHANGES (both HIGH conf).
  Convergent, high-quality feedback. Verified every source claim before acting:
  * getActiveBuilderId() @ terminal-manager.ts:450 (Codex fix — resolveBuilderTerminal is inverse). ✓
  * codev-diff: is base/LEFT side; right is file: (Claude fix). ✓
  * onDidChangeDiffInjectRegistry @ diff-inject-codelens.ts:235; registry populates AFTER diff
    activates → editor-only trigger reads stale key on first open. ✓
  * activeEditorIsBuilderFile true for ANY registered builder file (even normal tab) → real
    overlap: a builder's codev/specs/*.md in a diff session matches BOTH Doc-Review + Code-Review. ✓
  * markdownPreview customEditor priority:"option" → activeTextEditor undefined when reading spec
    via Codev preview → editor-centric model falls to Attention (breaks headline dev-approval). ✓
- Revised spec: (1) explicit predicate PRECEDENCE as required criterion (order = plan-gate
  decision; recommend terminal>diff>artifact>attention); (2) TAB-BASED context (window.tabGroups),
  not activeTextEditor; trigger set incl tab-group + terminal + diff-registry events; (3) VSCode-free
  resolver signature (SurfaceContext + ModeOverride, no Memento); (4) unified override model w/
  defined lifetime (session vs pinned); (5) webview security (nonce/CSP/localResourceRoots/escape);
  (6) expanded tests (overlap, custom-editor, event wiring, msg contract, pin round-trip); (7) pin
  scope reconciled with issue's per-window out-of-scope (workspaceState = per-folder).
- Left as plan-gate decisions (not overriding architect): precedence order, active-surface
  semantics, override clearing, pin scope, sticky-input.
- Next: commit "with multi-agent review", porch next → likely spec-approval gate.

### 2026-08-13 — At spec-approval gate: architect design iteration (NO PINNING)
- Reached spec-approval gate (porch gate 1049), notified architect. During gate review the
  architect drove several design refinements via conversation:
  1. Builder ATTACHMENT is derived, not chosen: terminal→getActiveBuilderId(), diff→registry
     DiffInjectSessionEntry.builderId. No global "current builder". Verified both in source.
  2. Builder-scoped modes (Code Review, Builder Inspector) have SUMMARY⇄DETAIL shape: detail =
     one builder; summary = cross-builder list (drill-in). Losing the surface rolls back to
     summary, never blanks. Attention = the global summary/fallback.
  3. **PINNING REMOVED ENTIRELY** (architect decision, reverses issue #1049's baked pin feature).
     Panel is purely contextual. Mode pills are TRANSIENT NAVIGATION (browse other modes/builders
     without touching editor), discarded on ANY active-surface change. Nothing persisted — NO
     codev.contextualPanel.pinnedMode, no workspaceState/globalState/config key.
- Rewrote spec to no-pin contextual + transient-nav model: Desired State (summary/detail table +
  attachment + transient nav), Success Criteria (no-persistence, transient nav, level in
  ModeDescriptor), Constraints (no-pin, transient host-side selection cleared on surface change,
  no persistence surface), Solution Approaches, Open Questions (dropped pin-scope + override-
  lifetime + pin-visual; kept precedence, active-surface semantics, reset-granularity, sticky-
  input), Test Scenarios (transient-clear invariant, summary/detail), Risks (stuck-off-context,
  auto-switch-yanks-input). Swept for lingering pin/override/persist — all remaining are intentional.
- Resolver signature now: (SurfaceContext, ManualSelection|null) → ModeDescriptor{mode, level,
  context}. ManualSelection is transient, never persisted; host clears it on surface change.
- Interpretation flagged to architect: "any active-surface change resets transient nav" (incl
  tab-switching between open editors), not only new-file-open. Awaiting confirm.
- NOTE: issue #1049 body still describes pinning; architect should amend it. Spec records the
  supersession explicitly (Constraints).
- Gate still OPEN — spec revised in place (pre-approval). Need to ask architect: fresh consult on
  revised design, or approve as-is? Did NOT advance porch state.

### 2026-08-13 — Issue updated + iter2 cmap (architect-requested)
- Architect: "update the issue to match the specs" then "run cmap". Done both.
- Updated issue #1049 body surgically: removed all pinning (proposed pattern, panel header,
  architecture, ACs, plan-gate decisions, out-of-scope), added summary/detail + derived attachment
  + tab-based context, fixed marker format + trigger-set facts. Rest preserved.
- Ran cmap iter2 (manual, architect-requested — outside porch's iteration tracking; porch still at
  spec-approval gate). Verdicts: Gemini APPROVE, Codex REQUEST_CHANGES, Claude COMMENT (all HIGH).
  Claude re-verified all codebase claims: "unusually high" accuracy. Design validated.
- Strongest finding (Codex+Claude, source-verified): my "most-recently-focused surface wins" lean
  has NO backing VSCode event for the EXIT path — returning focus from a builder terminal to an
  already-active editor fires none of tab-group/terminal/diff-registry events and activeTerminal
  stays set → Builder Inspector can't exit. Reframed as plan-gate API-feasibility question
  (candidate: onDidChangeTextEditorSelection + webview/terminal focus signal; accept some returns
  fire nothing). Added "never EXITS" risk row (had only "never triggers").
- Other iter2 fixes adopted: (a) locked precedence order in spec (terminal→diff→artifact→attention);
  (b) navigability per mode — CodeReview/BuilderInspector/Attention always navigable, DocReview
  disabled w/o artifact; (c) REMOVED sticky-input from umbrella (contradicted "immediate follow
  context"; draft preservation → participating mode); (d) dropped stale "amend issue" clause
  (already done); (e) placeholder retired + named 3 breaking manifest tests; (f) 7 render targets
  (no {document-review,summary}); (g) split ~50ms feel-check from O(1) automated assertion; (h)
  defined minimum summary/drill-in UI (builder-id stub) for umbrella scope.
- Rebuttal: 1049-specify-iter2-rebuttals.md. Gate still OPEN; porch state untouched.
- Next: report verdicts to architect; ready for spec-approval when they approve.
