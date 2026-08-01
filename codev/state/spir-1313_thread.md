# spir-1313 thread — afx send: mailbox-first delivery

Builder for Issue #1313 / Spec 1313. STRICT mode (porch-orchestrated). SPIR protocol.

## Architect constraints (standing)
- **2026-08-01 — Do NOT merge my own PR.** We are NOT cluesmith/codev maintainers. Create the PR, get it
  reviewed, then STOP. Repo maintainers handle the merge. Everything else follows SPIR as normal.

## Log

### 2026-07-31 — Specify phase start
- Spawned into existing worktree. Spec already authored by architect (commit fef6bddf) and is thorough:
  12 baked decisions, 11 success criteria, 15 functional + 3 non-functional test scenarios, risks table,
  perf bounds. Follows canonical spec template.
- Verified the spec's current-state claims against the real codebase (grounding check):
  - `shouldDefer` is exactly at `tower-routes.ts:1570` ✓
  - `handleSend` at `tower-routes.ts:1425`, routed from `POST /api/send` ✓
  - `SendBuffer` (`send-buffer.ts:36`) has `stop()`, `flush(forceAll)`, max-age force path ✓
  - `pty-session.ts` uses `RingBuffer` ✓
  - `@xterm/headless` is NOT yet a production dep of packages/codev (spike-only) — spec correctly says
    "confirm/add as a production dependency". Accurate.
- No internal contradictions among the 12 baked decisions. Nothing to flag to architect.
- Ran specify-phase checks (spec_exists, spec_has_required_sections) → both pass. `porch done 1313` → build complete.

### 2026-07-31 — Spec 3-way consultation (iteration 1)
- Verdicts: Gemini APPROVE, Codex REQUEST_CHANGES, Claude COMMENT — all HIGH confidence. Unanimous: spec is
  technically sound, feasible, well-grounded. Only unanimous defect: missing `## Expert Consultation` heading.
- Addressed all feedback (4 surgical edits, no baked-decision changes):
  1. Added `## Expert Consultation` section (the consultation log) — unanimous ask.
  2. Decision 8: made `afx inbox` workspace-scope + dismiss authorization explicit; noted attention-state
     visual is plan-level (Codex scope Q + Claude "which human?" + Claude visual contract).
  3. Decision 6: stated supersede keys are cron-only; non-cron sends never supersede (Claude).
  4. Test scenarios: added #16 dedicated escalation-age-threshold scenario (Claude).
- Codex verified `@xterm/headless` gap + ring-buffer path independently against the repo; matched the spec.
- Committed "Specification with multi-agent review" (c483f88b) + rebuttal (6697add8). Ran `porch done` →
  advanced to **spec-approval gate** (porch commit ba58c147).

### 2026-07-31 — ⛔ STOPPED at spec-approval gate (awaiting human)
- `porch gate 1313` registered the gate. Architect notified via `afx send architect`.
- **Waiting for human**: `porch approve 1313 spec-approval --a-human-explicitly-approved-this`.
- I will NOT call porch approve (human-only). On approval I resume with `porch next 1313` → Plan phase.

### 2026-08-01 — Plan phase start (spec-approval PASSED)
Architect approved spec-approval gate + told me to continue to Plan. Grounded the architecture for the plan:
- **Mailbox store**: new `mailbox` table → add `CREATE TABLE IF NOT EXISTS` to `GLOBAL_SCHEMA` (db/schema.ts)
  AND a new migration v15 in `db/index.ts` (bump `GLOBAL_CURRENT_VERSION` 14→15). `cron_tasks` is the
  workspace-scoped table to mirror. Repository → new `agent-farm/db/mailbox.ts` (pure SQL, unit-testable).
- **Gate**: new `agent-farm/servers/render-gate.ts` (@xterm/headless replay→classify) + `gate-profiles.ts`
  (claude/codex/agy marker+region+intensity rules). `@xterm/headless` NOT yet a prod dep — add to
  packages/codev/package.json. Open design point: session→app-profile resolver (from session command/args/label).
- **Delivery**: `tower-routes.ts` handleSend (1425-1598) rewrite; `SendBuffer` lifecycle = `start/stopSendBuffer`
  in tower-server.ts (587 start / 185 stop); retire send-buffer.ts. Write serialization near message-write.ts.
- **Cron**: `tower-cron.ts` deliverMessage (303-323) blind `writeMessageToSession` → route through mailbox+gate,
  supersede key = task.name.
- **Broadcasts**: `tower-messages.ts:430 broadcastMessage(MessageFrame)`.
- **afx inbox**: commander pattern in `cli.ts` + new `agent-farm/commands/inbox.ts` (mirror commands/send.ts) +
  new Tower API routes in tower-routes.ts.
- **Indicators (dashboard + VSCode)**: Explore agent mapping exact paths now.
- Leaning toward ~8-9 small phases (store → gate → agy → delivery-core → fast-triggers → cron → inbox/broadcasts
  → indicators → docs). Will offer merge options to architect at plan-approval gate.

### 2026-08-01 — Plan drafted (9 phases). Key correction from UI exploration:
- **UIs use SSE, not WebSocket.** Both dashboard (`apps/web/`) and VSCode (`apps/vscode/`) live-update via
  `/api/events` (SSE) → refetch `/api/overview`. So the held-count indicator is surfaced by adding `heldCount`
  to shared `OverviewData` (`packages/types/src/api.ts`), populated in `overview.ts`, signalled by
  `overview-changed` (`ctx.broadcastNotification`, precedent tower-routes.ts:1307). Escalation = distinct SSE
  `notification` event. The inter-agent `broadcastMessage` (tower-messages.ts) stays for message delivery only.
- VSCode badge has an exact precedent: `updateActivityBadge()` (extension.ts:405-426) + fan-out at
  extension.ts:453-458. Mailbox being agent-addressed makes per-builder heldCount clean (old SendBuffer was
  sessionId-keyed).
- Package layout (real): dashboard `apps/web/`, VSCode `apps/vscode/`, types `packages/types/`, Tower `packages/codev/`.
- 9 phases: 1 store, 2 gate+claude/codex, 3 agy(blocking), 4 delivery-core+serialization, 5 fast-triggers,
  6 cron, 7 inbox+SSE+escalation, 8 indicators, 9 docs+skeleton. Offered merge knobs (2+3, 4+5, 7+8 → 6) to
  architect in plan Notes. All plan checks pass.
- ⚠️ Watch cwd: porch resolves project from worktree ROOT — a stray `cd` into packages/ made `porch check` fail
  with "Project not found." Always run porch from the worktree root.
- Committed "Initial implementation plan" (0884addb). `porch done` → 3-way plan consult.

### 2026-08-01 — Plan 3-way consult (iteration 1)
- Verdicts: Gemini APPROVE, Codex REQUEST_CHANGES, Claude APPROVE — all HIGH. Claude verified every file ref +
  full spec coverage. Codex's 4 blockers were all real (repo-verified); addressed all:
  1. Client-side send contract: `tower-client.ts` return type + `commands/send.ts:332` (was unconditional
     "Message sent") → print delivered vs held+reason. Added to Phase 4.
  2. Automated e2e for #1265: added Phase 4 deliverable `__tests__/send-mailbox.e2e.test.ts` via
     `vitest.e2e.config.ts`. (Real e2e path = `src/agent-farm/__tests__/*.e2e.test.ts`, NOT the
     `packages/codev/tests/e2e/` CLAUDE.md cites — doc drift, flag in Phase 9.)
  3. Config loader named: `packages/codev/src/lib/config.ts` (CodevConfig/DEFAULT_CONFIG/loadConfig) for
     escalation-age (Ph7) + retention-days (Ph1).
  4. Exec summary "WS events" → "SSE events".
- Gemini: pruneTerminal invocation (boot + backstop, Ph4) + liveness telemetry tracked in Ph4 drainer. Fixed.
- Claude: Phase 5 coalescing test + optional Phase 7 split (7a inbox/API, 7b overview/SSE/escalation). Added.
- Next: commit "Plan with multi-agent review" + rebuttal, `porch done` → STOP at plan-approval gate.
