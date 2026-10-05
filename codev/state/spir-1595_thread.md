# spir-1595 thread

## 2026-10-05 specify
- Spawned. Owner ruling (issue comment 2026-10-05): #1595 ships before #1672; issue body scope stands; enum+row shape in codev-types is ours; contract sections go to main before plan gate.

- Research: HarnessProvider (packages/codev/src/agent-farm/utils/harness.ts) has getWorktreeFiles (Claude-only write-guard). writeWorktreeFiles shallow-merges JSON (hooks key would clobber; known deferral from #1018). Architects get no settings injection. No child-PID liveness reaches overview; dead builders just go lastDataAt=null.
- Empirical (claude 2.1.289): hooks given via `--settings <json>` AND .claude/settings.local.json BOTH fire (concatenate); `async: true` command hooks work. Stop payload includes `background_tasks` + `last_assistant_message`. Claude docs: Stop does not fire on user interrupt; Notification types incl permission_prompt/idle_prompt/elicitation_dialog.
- Prior art: codev/research/mobile/decisions/askuserquestion-detection.md recommends hook emission + harness-neutral Tower contract (same shape as this). Spec 1313 rejected hooks as a *delivery* channel (different concern).
