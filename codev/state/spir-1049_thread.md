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
