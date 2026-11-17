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
