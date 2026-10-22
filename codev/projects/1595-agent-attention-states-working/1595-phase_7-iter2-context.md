### Iteration 1 Reviews
- gemini: COMMENT — Gemini lane skipped — agy exited with code 3
- codex: REQUEST_CHANGES — Surface migration is solid overall, but the contextual panel regresses fallback waiting semantics.
- claude: APPROVE — Phase 7 migrates every listed surface to the shared classifier with distinct needs-input/idle/dead rendering and architect rollups; tests, type-checks and lint all pass, with only a verification-logging gap and a cosmetic CSS width to note.

### Builder Response to Iteration 1
# Phase 7, iteration 1: rebuttals

## Codex (REQUEST_CHANGES)

1. **Contextual panel read the PTY-silence fallback as "idle".** Agreed and fixed (3cf57f3d8). The badge word now comes from a shared, vscode-free `waitWord` in `apps/vscode/src/views/attention-format.ts`: `needs input`, `agent exited`, `idle` only for a served turn end, and `waiting` when the item has no served state (the fallback). Unit-tested in `apps/vscode/src/__tests__/attention-format.test.ts`, covering both the served-idle and the fallback case.
2. **Playwright verification not recorded.** It was run before the phase commit; it is now recorded in `codev/state/spir-1595_thread.md` with the exact commands. `packages/codev/src/agent-farm/__tests__/e2e/spec-1595-agent-state.test.ts` passed 3/3 against an isolated Tower (`CODEV_AGENT_FARM_DIR` scratch dir, port 14595), covering needs-input with a hostile Markdown/HTML summary, idle, dead, working, blocked, and an architect at a question. The screenshot confirmed each state is distinct.

## Claude (APPROVE), non-blocking notes

- Browser evidence: recorded in the thread (as above).
- Needs-input label cap wider than the state column: kept deliberately. The column already grows for long gate labels; the cap only bounds the growth, and the full text is the span's `title`.
- Panel needs-input badge has no tool/summary: `WaitingItem` carries no detail by design (phase 2 summary shape); the builder row and dashboard card, which hold the builder, show it.
- `prReady` + PTY-silence count difference: pre-existing, unchanged by this phase.

## Gemini

Skipped (agy exit 3), non-blocking.


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
