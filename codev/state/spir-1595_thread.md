# spir-1595 thread

## 2026-10-05 specify
- Spawned. Owner ruling (issue comment 2026-10-05): #1595 ships before #1672; issue body scope stands; enum+row shape in codev-types is ours; contract sections go to main before plan gate.

- Research: HarnessProvider (packages/codev/src/agent-farm/utils/harness.ts) has getWorktreeFiles (Claude-only write-guard). writeWorktreeFiles shallow-merges JSON (hooks key would clobber; known deferral from #1018). Architects get no settings injection. No child-PID liveness reaches overview; dead builders just go lastDataAt=null.
- Empirical (claude 2.1.289): hooks given via `--settings <json>` AND .claude/settings.local.json BOTH fire (concatenate); `async: true` command hooks work. Stop payload includes `background_tasks` + `last_assistant_message`. Claude docs: Stop does not fire on user interrupt; Notification types incl permission_prompt/idle_prompt/elicitation_dialog.
- Prior art: codev/research/mobile/decisions/askuserquestion-detection.md recommends hook emission + harness-neutral Tower contract (same shape as this). Spec 1313 rejected hooks as a *delivery* channel (different concern).
- vscode architect standing instruction: run afx send from this worktree root (plain 'architect' reaches vscode seat; #1783). Spec gate is Amr's; contract sections go to main before plan gate.
- vscode heads-up: main's bugfix-1787 edits packages/sdk/src/builder-helpers.ts (deriveAttention pendingGates dedupe), lands first. Merge main before editing builder-helpers and again before PR gate.
- CMAP spec iter1: gemini COMMENT, codex+claude REQUEST_CHANGES. Key: (a) builder PTY child is the bash relaunch loop, agent exit -> `read -r`, no EXIT frame => dead needs process-tree probing; (b) SessionEnd fires on /clear (codev refresh) -> must not map to dead; (c) permission event unverified; (d) architect items don't fit AttentionBuilderRef; (e) lost Stop => stuck working; (f) spoofing, summary sanitization, ordering, cache-invalidation wrong mechanism (use overview-changed SSE).
- Live spike (claude 2.1.289, tmux, all hooks async):
  - PermissionRequest fires ~10ms after PreToolUse at the prompt; Notification(permission_prompt) ~6s later.
  - Approve -> PostToolUse -> Stop. DENY ("No") -> turn ends "Interrupted", NO Stop, NO PermissionDenied, and NO idle_prompt even after 70 min.
  - Normal Stop -> Notification(idle_prompt) exactly 60s later.
  - Stop with background task -> bg=1; task completion fires UserPromptSubmit then Stop bg=0 (self-clears).
  - A message queued mid-turn fires UserPromptSubmit.
  - Foreground tool running: TUI repaints elapsed counter every second (PTY fresh while working). Permission prompt pane is static.
  - Esc-interrupt and /clear could not be exercised reliably (vim-mode composer ate keys) -> verify in implementation.
