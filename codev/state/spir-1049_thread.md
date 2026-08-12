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
