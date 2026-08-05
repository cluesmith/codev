# Builder thread: pir-1037

Issue #1037: codelens-driven review comments in the unified diff editor (per-builder queue, batched submit to PTY). Protocol: PIR (strict).

## 2026-08-06 Plan phase

- Investigated #789's actual surface: lenses are file/symbol/changed-run anchored (`diff-inject-ref.ts`), not literal hunk headers; multi-file `vscode.changes` editor suppresses codelens (context menu is the affordance there). Comments API already used in `comments/plan-review.ts` (#1055 edit pattern) against the pinned engine, so no new API surface needed.
- Architect instruction (mid-turn, 2026-08-05): scope is #1037 ONLY, no #1049 panel views; deliverable standalone via palette command + status bar. Weigh gitignore mechanism explicitly. Preserve #789 semantics exactly. Submit stays human-in-the-loop (no auto-Enter). Verify comments API vs engines ^1.105. Plan for a running-flow demo at dev-approval.
- Key design find: PTY injection is raw bytes (`sendText` → `handleInput` → WebSocket), so a multi-line batched message would submit on every `\n` in the Claude REPL. Locked design: bracketed-paste wrapping (`\x1b[200~…\x1b[201~`, `\n`→`\r`); flagged as the top risk, spike first in implement, first item in the dev-approval script.
- Gitignore decision: managed block in `$GIT_COMMON_DIR/info/exclude` written by the extension at first queue write; family glob `.builder-*` also silences the scaffolding-file class; committed-.gitignore alternative weighed and documented in the plan.
- Plan written to `codev/plans/1037-vscode-codelens-driven-review-.md`; sitting at plan-approval gate.
