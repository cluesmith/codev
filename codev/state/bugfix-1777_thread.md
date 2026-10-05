# bugfix-1777 thread

## Investigate (2026-10-05)
- Root cause: `packages/codev/src/agent-farm/servers/overview.ts` `GATE_LABELS` is an allowlist (spec/plan/dev-approval, pr, verify-approval). `detectBlocked`/`detectBlockedGate`/`detectBlockedSince` iterate only it, so a pending `experiment-complete` never sets `blocked`/`blockedGate`.
- Audit of skeleton protocol.json gates: also missing `maintain-complete` (MAINTAIN), `scope-approval` + `research-complete` (RESEARCH). Same blind spot.
- Downstream consumers (web NeedsAttentionList, vscode GATE_ICONS -> bell, streamdeck face titleToken fallback) all degrade generically once Tower reports the gate.
- Fix plan: detect ANY gate with status pending + requested_at (known gates first, preserving order), label from map with a fallback derived from the gate name; add labels for the 4 missing gates; add vscode icons (beaker etc.).
