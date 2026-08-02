# Review: afx send — Mailbox-First Delivery (Never Force-Inject)

## Summary

Replaced `afx send`'s timer-based, in-memory, force-flushing delivery with a **mailbox-first**
pipeline: every message is persisted to `global.db` before the send returns, and its body is only
ever written to a prompt a headless-terminal replay proves is empty. Nine implement phases landed
the durable store, the rendered-empty gate (claude/codex/agy profiles), delivery orchestration with
per-PTY write serialization, fast delivery triggers, cron rerouting, the `afx inbox` visibility
surface, dashboard/VSCode held-count indicators, and docs. Corruption is eliminated **by
construction** — there is no force path — and no accepted message is ever silently lost.

## Spec Compliance

- [x] AC1: The #1265 repro is dead — draft held (`busy`), untouched, delivers after the line clears (Phase 4; automated e2e `send-mailbox-repro.test.ts`)
- [x] AC2: Idle delivery unchanged in feel — gate measured 19.2ms (bound ≤ ~50ms at seed cap) (Phase 2)
- [x] AC3: No loss across Tower crash/shutdown; no shutdown force-flush — `SendBuffer` deleted, rows persist in SQLite (Phase 1, Phase 4)
- [x] AC4: Wrapper screens (relaunch / crash-restart) don't eat messages — gate holds on non-clean screens (Phase 2, Phase 4)
- [x] AC5: Concurrent sends serialize — per-PTY FIFO `write-queue.ts`, completion-chained (Phase 4)
- [x] AC6: Cron parity — busy → held, per-task supersede, honest run-log outcomes (Phase 6)
- [x] AC7: Escalation is visible — `afx inbox` + dashboard/VSCode attention state; no log-reading needed (Phase 7, Phase 8)
- [x] AC8: Held reasons distinguishable — `busy` / `no-profile` / `no-live-pty` in response, `afx inbox`, logs (Phase 4, Phase 7)
- [x] AC9: **agy is a working target (blocking)** — trust dialog → not-clean via color-keyed rule; idle → clean (Phase 3)
- [x] AC10: `--interrupt` / `noEnter` behave as documented; unknown-app targets hold visibly (`no-profile`) (Phase 4)
- [x] AC11: Unit tests cover mailbox lifecycle + gate classification vs fixtures (claude/codex/agy); e2e covers the repro (Phases 1–4)
- [x] AC12: Docs updated — afx reference (send vocab, `afx inbox`, mailbox config), CLAUDE/AGENTS byte-identical, skeleton mirrors (Phase 9)
- [x] AC13: No test-coverage reduction; build/lint/typecheck green (all phases; validated by porch build-complete each phase)

All 13 spec success criteria met. The blocking agy criterion (Baked Decision 12) was satisfied at
the gate level via a net-new empirical measurement (see Phase 3 note below); a live agy delivery
smoke is deferred to the verify phase per the plan.

## Deviations from Plan

- **Phase 4 — helper module split**: the plan named `message-write.ts (extend) or a sibling write-queue.ts`
  and folded delivery into `handleSend`. Implementation extracted three focused new modules —
  `write-queue.ts` (per-PTY FIFO), `mailbox-delivery.ts` (the gated drain driver + escalation), and
  `mailbox-wiring.ts` (Tower-boot lifecycle + trigger wiring) — rather than growing `handleSend` and
  `message-write.ts`. Cleaner separation; same behavior. `send-buffer.ts` and its test were deleted as planned.
- **Phase 6 — dedicated `cron-delivery.ts`**: the plan routed cron through Phase 4's entrypoint in place
  (`tower-cron.ts`). Implementation added a thin `cron-delivery.ts` seam so cron's supersede-key path and
  outcome-logging are unit-testable in isolation; it calls the same single gated enqueue path (one gate, as required).
- **Phase 5 — user-input consolidation (from review)**: Codex found the submit trigger was wired only through
  `tower-websocket.ts`, not the `pty-manager.ts` input path, so "deliver on submit" was inconsistent across
  clients. Root cause was duplicated input handling; the fix consolidated both paths through a single
  `handleUserInput` chokepoint on `PtySession`. Not a plan deviation per se — a correctness fix that also
  removed pre-existing duplication.
- **Phase 3 — fixtures synthesized, not raw-captured**: the raw agy capture embeds the authenticated account
  email in its banner, so committed fixtures are synthesized to the measured SGR attributes with sanitized
  content, verified through the real RingBuffer→classifier path before writing. Provenance documented in the
  fixtures README. (Consistent with the plan's fixture approach; the sanitization is the only twist.)
- **arch/lessons routing** deferred from Phase 9 to this Review phase (the plan explicitly permits this; the
  Review phase has the dedicated `update-arch-docs` step). Applied in this review — see Architecture Updates
  and Lessons Learned Updates below.
- **Review phase — `afx inbox show <id>` added (architect-directed, at the `pr` gate)**: the architect held the
  `pr` gate on one reconciliation. The spec's Redaction rule (Security Considerations) named `afx inbox` as a
  legitimate body-display surface, but the implemented `afx inbox` list is deliberately metadata-only — a
  self-contradiction. Resolution (the architect's call, implemented rather than relitigated): keep the **list**
  metadata-only and add an explicit **`afx inbox show <id>`** single-row view that surfaces the body over the same
  local Tower connection the message already uses. Backed by a new `GET /api/inbox/:id` route (returns a full row
  including its body; 404 on unknown id; 405 on non-GET) and an `inboxShow` CLI handler. Spec Decision 8 + the
  Redaction bullet were amended to match; docs updated across both `agent-farm.md` trees, both `overview.md`
  tables, the CLAUDE/AGENTS messaging sections (root + skeleton templates), and `arch.md`. `show` works on a row
  of **any** status, so a resolved (delivered/superseded/dismissed) row stays inspectable by id for audit until it
  is pruned. +9 tests (5 route, 4 CLI).

## Key Metrics

- **Commits**: 80 on the branch (36 `[Spec 1313]` builder commits — 16 phase feat/fix + thread/rebuttal commits; the rest porch bookkeeping)
- **Tests**: last verified green — `packages/codev` 4162 passing / 48 skipped; VSCode 667 passing (56 files, +24 new); dashboard (`apps/web`) 328 passing / 1 skipped; render-gate 28/28; dashboard Playwright e2e 4/4. New test files: 17 (see below).
- **Files created**: 11 new source modules —
  `db/mailbox.ts`, `servers/render-gate.ts`, `servers/gate-profiles.ts`, `servers/write-queue.ts`,
  `servers/mailbox-delivery.ts`, `servers/mailbox-wiring.ts`, `servers/cron-delivery.ts`,
  `commands/inbox.ts`, `apps/web/src/components/HeldCountBadge.tsx`, `apps/vscode/src/mailbox-indicators.ts`,
  `apps/vscode/src/notifications/mailbox-escalation-toast.ts`; plus 17 test files and 13 gate fixtures.
- **Files deleted**: `servers/send-buffer.ts`, `__tests__/send-buffer.test.ts` (behavior migrated to the mailbox).
- **Net LOC impact**: +8346 total (+8351/−749 across 88 files). Code only: **+6784/−746 across 69 files** (`packages/` + `apps/`); docs/specs/plans/skeleton: +2302/−2 across 18 files. Code delta is within the spec's ~400–700 LOC *net-new-logic* estimate once tests (17 files), fixtures (13), and the migration/type churn are excluded — the production-logic core is small; tests and fixtures dominate the count.

## Timelog

All times America/New_York (EDT, −0400), 2026-07-31 → 2026-08-01.

| Time | Event |
|------|-------|
| Jul 31 21:40 | First commit: porch init spir; Specify phase begins |
| Jul 31 21:48 | Spec drafted; spec-approval requested |
| — | **GATE: spec-approval** (human approval required) |
| Jul 31 21:52 | Spec approved (~4m wait); Plan phase begins |
| Jul 31 22:17 | Plan drafted (2 consult rounds); plan-approval requested |
| — | **GATE: plan-approval** (human approval required) |
| Jul 31 22:20 | Plan approved (~3m wait); Implementation begins (Phase 1) |
| Jul 31 22:46 | Phase 1 (mailbox store) complete → Phase 2 |
| Jul 31 23:51 | Phase 2 (render-gate + claude/codex) complete after 2 iters → Phase 3 |
| Aug 1 00:15 | Phase 3 (agy profile, blocking) complete unanimous → Phase 4 |
| Aug 1 03:44 | Phase 4 (delivery orchestration) complete after 2 iters → Phase 5 |
| Aug 1 04:29 | Phase 5 (fast triggers) complete after 2 iters → Phase 6 |
| Aug 1 04:57 | Phase 6 (cron) complete unanimous → Phase 7 |
| Aug 1 08:01 | Phase 7 (inbox/broadcasts/escalation) — 3 iters, **force-advanced at iter-3 ceiling** → Phase 8 |
| Aug 1 12:57 | Phase 8 (dashboard/VSCode indicators) complete after 2 iters (incl. architect pause) → Phase 9 |
| Aug 1 13:34 | Phase 9 (docs + skeleton) complete after 2 iters → Review |
| — | **GATE: pr** (pending) |

### Autonomous Operation

| Period | Duration | Activity |
|--------|----------|----------|
| Spec + Plan | ~40m | Spec (1 round, COMMENT/APPROVE/RC) + Plan (2 rounds) |
| Human gate waits | ~7m total | spec-approval ~4m + plan-approval ~3m — fast turnaround |
| Implementation → Review | ~15h 14m wall | 9 phases, 13 consultation rounds; includes ≥1 architect-requested pause during Phase 8 |

**Total wall clock** (init to review entry): **~15h 54m**
**Total autonomous work time** (excluding gate waits + architect pauses): materially less than wall clock; Phase 8's 5h span is inflated by an architect pause between its dashboard and VSCode sides.
**Context window resets / resumes**: multiple (9 PAUSED/RESUMED markers in the thread — mix of architect-requested pauses and session resumes; all recovered from `state-snapshot.md` + thread + porch state without losing work).

## Consultation Iteration Summary

60 consultation files produced through review round 1 (20 phase-iterations × 3 models). **45 APPROVE,
13 REQUEST_CHANGES, 1 COMMENT, 1 skip** (Gemini review-round: agy unauthenticated). Every REQUEST_CHANGES
was accepted and fixed (verified against code); two minor process notes were rebutted (commit-message
format, a cosmetic skeleton-example count) with the reviewer concurring, and one was deferred.

| Phase | Iters | Who Blocked | What They Caught |
|-------|-------|-------------|------------------|
| Specify | 1 | Codex (RC), Gemini/Claude minor | Missing `## Expert Consultation` heading; `afx inbox` scope/authz to pin |
| Plan | 2 | Codex (RC ×2) | Client-side send contract + automated e2e + config loader unnamed (iter1); dead-session resolver seam + `--all` contract + `PtySession` app-identity seam (iter2) |
| Phase 1 | 1 | — (unanimous APPROVE) | — |
| Phase 2 | 2 | Codex (RC) | Incomplete fixture matrix (claude-picker); perf assertion too loose (<500ms vs ≤50ms bound) |
| Phase 3 | 1 | — (unanimous APPROVE) | — |
| Phase 4 | 2 | Codex (RC) | Missing full-cycle #1265 e2e; retention default 7d vs 30d; cross-workspace offline fallback |
| Phase 5 | 2 | Codex (RC) | Submit trigger not wired through all input paths (consolidated to one chokepoint) |
| Phase 6 | 1 | — (unanimous APPROVE) | — |
| Phase 7 | 3 | Codex (RC ×3) | Escalation didn't refresh overview + liveness broadcast + route tests (iter1); workspace-scoping (iter2); `POST dismiss` method guard (iter3) |
| Phase 8 | 2 | Gemini + Codex (RC) | Missing Playwright e2e for the indicator; untested `extension.ts` wiring (extracted pure composers) |
| Phase 9 | 2 | Codex (RC) | Undocumented `mailbox.retentionDays`/`escalationSeconds` config knobs |
| Review | 1+ | Codex | Two mailbox races (dismiss/deliver + write-completed⇒delivered) + missing approval frontmatter |

**Most frequent blocker**: **Codex — 11 of 12 REQUEST_CHANGES** (sole blocker in 10 rounds; co-blocked
Phase 8 with Gemini). Focus pattern: **contract completeness and test rigor** — client-side send contract,
automated e2e presence, config-loader wiring, route-method guards, workspace-scoping, and coverage gaps.
Gemini issued 1 RC (Phase 8 Playwright). Claude issued 0 RC (its one non-APPROVE was the Specify COMMENT).

### Avoidable Iterations

1. **Client-vs-server contract completeness**: the plan described the *server* send response but not the
   *client-side* (`tower-client.ts` / `commands/send.ts`) surfacing, and Codex blocked twice (plan + implicit)
   before it was covered on both single-send and `--all` paths. A future builder should trace a contract change
   end-to-end (wire → client → both CLI paths) before claiming it's specified.
2. **"Automated e2e" means full-cycle, not a smoke**: Phase 4's first e2e only checked an inert shell yielding
   `held/no-profile`, not the actual draft→held(busy)→submit→clean-delivery repro Codex expected. When a spec
   names a specific repro scenario, the e2e must exercise *that* scenario, not an adjacent easy one.
3. **Config knobs are code, not just docs**: retention/escalation values were introduced in code but the config
   loader (`lib/config.ts`) and later the docs lagged, drawing RCs in the plan, Phase 4, and Phase 9. Wire a new
   config key through loader + defaults + docs in the same phase it's first read.
4. **UI needs Playwright, not just unit tests** (CLAUDE.md mandate): Phase 8 shipped a React unit test first;
   both Gemini and Codex blocked for the missing Playwright e2e. Treat the Playwright requirement as non-optional
   for any dashboard-visible change from the first commit.
5. **Route method guards**: Phase 7 iter-3 caught `POST /api/inbox/:id/dismiss` accepting any HTTP method — a
   real state-changing bug. Add method guards + a non-POST regression test when introducing any mutating route.

## Consultation Feedback

Response types: **Addressed** (fixed), **Rebutted** (disagreed with reasoning), **N/A** (out of scope/moot).

### Specify Phase (Round 1)

#### Gemini — APPROVE (HIGH)
- **Concern**: Missing `## Expert Consultation` heading required by the template.
  - **Addressed**: Added the section recording all three verdicts.

#### Codex — REQUEST_CHANGES (HIGH)
- **Concern**: Missing required `## Expert Consultation` section.
  - **Addressed**: Added in canonical order.
- **Concern**: `afx inbox` scope/query + dismissal semantics should be explicit if testable.
  - **Addressed**: Pinned in Baked Decision 8 (workspace-scoped; lists row id + why-held reason; dismiss by row id).

#### Claude — COMMENT (HIGH)
- **Concern**: Missing heading; `afx inbox` dismiss authz in multi-architect workspaces; supersede-key scope implicit; "attention state" visual unspecified; no escalation-age test scenario.
  - **Addressed**: All five — Decision 8 (any workspace operator, no ownership check), Decision 6 (supersede cron-only), plan-level UI note, and new Functional Test Scenario 16.

### Plan Phase (Round 1)

#### Gemini — APPROVE (HIGH)
- **Concern**: `pruneTerminal` defined but never invoked; liveness telemetry placement.
  - **Addressed**: Phase 4 wires the Tower-boot + backstop invocation; telemetry tracking moved to the Phase 4 drainer.

#### Codex — REQUEST_CHANGES (HIGH)
- **Concern**: Client-side send contract not covered (`send.ts` hardcodes "Message sent"); no automated #1265 e2e in a concrete file; config loader for escalation/retention unnamed; exec summary says "WS" but repo is SSE.
  - **Addressed**: All — Phase 4 client-contract + e2e deliverables added; `lib/config.ts` named in Phases 1 & 7; "WS"→"SSE".

#### Claude — APPROVE (HIGH)
- **Concern**: (No key issues) minor — Phase 5 drain-coalescing test; Phase 7 density.
  - **Addressed**: Added the coalescing test; noted optional 7a/7b split.

### Plan Phase (Round 2)

#### Gemini — APPROVE
- No concerns raised (independently verified all iter-1 fixes + file refs landed).

#### Codex — REQUEST_CHANGES (HIGH)
- **Concern**: Dead-session persistence not implementable as written (`resolveTarget` resolves only live terminals; `handleSend` 404s); Phase 2 omits the `resolveProfile` metadata seam (`command`/`args` private); `--all` would misreport held as "sent".
  - **Addressed**: Added the agent-registry fallback + `handleSend` restructure; named the `PtySession` app-identity seam; extended honest reporting to `sendToAll()`.

#### Claude — APPROVE (HIGH)
- **Concern**: Cosmetic — `GLOBAL_CURRENT_VERSION` lives in `db/index.ts`; `tower-client` return shape.
  - **N/A / Addressed**: Migration already targeted `index.ts` (no change); corrected the Phase 4 return-shape description.

### Phase 1 — Mailbox persistence layer (Round 1)

#### Gemini — APPROVE (HIGH); Codex — APPROVE (MEDIUM); Claude — APPROVE (HIGH)
- No concerns raised — all consultations approved. (Claude's non-blocking observations on pruneTerminal deferral, retention config boundary, and supersede atomicity confirmed the design.)

### Phase 2 — Rendered-empty gate + claude/codex profiles (Round 1)

#### Gemini — APPROVE (HIGH)
- No concerns raised.

#### Codex — REQUEST_CHANGES (HIGH)
- **Concern**: Fixture matrix incomplete (only `codex-picker`, no claude picker); perf test asserts <500ms vs the spec's ≤~50ms bound.
  - **Addressed**: Added `claude-picker` fixture (suite 22→23); replaced perf assertion with warm-up + best-of-5 min <75ms (measured 19.2ms).

#### Claude — APPROVE (HIGH)
- **Concern**: Non-blocking — `RING_SEED_MAX_BYTES` local definition; synthesized `claude-idle` fixture.
  - **Addressed / N/A**: Reconciled in Phase 4; synthesized fixture accepted as the right tradeoff. (Builder also fixed a latent `@xterm/headless` CJS-interop bug found while grounding the perf measurement.)

### Phase 2 (Round 2)

#### Gemini / Codex / Claude — all APPROVE (HIGH)
- No concerns raised (2 cosmetic Claude notes, no change needed).

### Phase 3 — agy classifier profile (Round 1)

#### Gemini / Codex / Claude — all APPROVE (HIGH)
- No concerns raised. Gemini confirmed the agy marker `/^> /`, the `placeholderFgPalette: 8` rule, and resolver priority. Claude's non-blocking notes (shared region-end patterns, synthesized fixtures) are accepted-risk per spec.

### Phase 4 — Delivery orchestration + write serialization (Round 1)

#### Gemini — APPROVE
- No concerns raised.

#### Codex — REQUEST_CHANGES (HIGH)
- **Concern**: Added e2e checks only an inert shell (`held/no-profile`), not the planned #1265 full cycle; drainer hardcodes 7-day retention vs the 30-day config default; offline fallback refuses cross-workspace `project:agent` targets.
  - **Addressed**: Added the full-cycle subprocess e2e (draft→held→submit→clean delivery); set retention to 30 via `mailbox.retentionDays` config + regression test; offline fallback resolves via `findWorkspaceByBasename` and holds against the target workspace registry.

#### Claude — APPROVE (HIGH)
- **Concern**: Minor — retention 7d vs 30d.
  - **Addressed**: Same fix as Codex.

### Phase 4 (Round 2)

#### Gemini / Codex / Claude — all APPROVE (HIGH)
- No concerns raised; all three iter-1 items verified fixed.

### Phase 5 — Fast delivery triggers (Round 1)

#### Gemini — APPROVE (HIGH)
- No concerns raised.

#### Codex — REQUEST_CHANGES (HIGH)
- **Concern**: Submit trigger wired only through `tower-websocket.ts`, not `pty-manager.ts` — "deliver after submit" inconsistent across live clients.
  - **Addressed**: Root cause was duplicated input handling; consolidated both paths through a single `handleUserInput` chokepoint on `PtySession`.

#### Claude — APPROVE (HIGH)
- No concerns raised (praised the self-rescheduling quiescence timer + coalescing).

### Phase 5 (Round 2)

#### Gemini / Codex / Claude — all APPROVE (HIGH)
- No concerns raised.

### Phase 6 — Cron rerouting (Round 1)

#### Gemini / Codex / Claude — all APPROVE (HIGH)
- No concerns raised. Confirmed mailbox routing, task-name supersede key, honest logging. (Claude's non-blocking notes on a shared `CronOutcome` type and a `reason` fallback are accepted.)

### Phase 7 — afx inbox CLI + broadcasts + escalation (Round 1)

#### Gemini — APPROVE
- No concerns raised.

#### Codex — REQUEST_CHANGES (HIGH)
- **Concern**: Escalation doesn't fire `overview-changed` (so `mailboxEscalated` can go stale); liveness telemetry is log-only and ignores the "with recent output" condition; no route-level tests for `GET /api/inbox`, `POST dismiss`, or the SSE interaction.
  - **Addressed**: `escalateOverdue()` now fires `onHeldStateChange()`; liveness split across a pure/wired boundary via an `onLiveness` port with the 30s recent-output gate (WARN log + `notification` SSE); added `inbox-routes.test.ts` + db-level cases + tightened `send-delivery.test.ts`.

#### Claude — APPROVE (HIGH)
- No concerns raised (2 non-blocking notes).

### Phase 7 (Round 2)

#### Gemini — APPROVE
- No concerns raised.

#### Codex — REQUEST_CHANGES (HIGH)
- **Concern**: `afx inbox` defaults to all workspaces, but Decision 8 pins it workspace-scoped.
  - **Addressed**: Defaults to the current workspace via `getConfig().workspaceRoot`; route normalizes `?workspace=`; no admin/`--all` mode added (YAGNI).

#### Claude — APPROVE (HIGH)
- No concerns raised (confirmed all four prior issues resolved).

### Phase 7 (Round 3)

#### Gemini — APPROVE
- No concerns raised.

#### Codex — REQUEST_CHANGES (HIGH)
- **Concern**: `POST /api/inbox/:id/dismiss` has no method guard — any HTTP method dismisses mail (real state-changing bug); no non-POST regression test.
  - **Addressed**: Added a `req.method !== 'POST'` → 405 guard before any DB mutation, plus a 405 regression test.

#### Claude — APPROVE (HIGH)
- No concerns raised. **Note**: after this iter-3 fix landed, porch reached its 3-iteration ceiling and
  **force-advanced** rather than running a 4th consult round. The iter-3 Codex fix (method guard + regression
  test) *was* committed before the force-advance (`af21e608`), and Claude approved iter-3; there was simply no
  iter-4 re-consult to convert Codex's verdict to APPROVE. The fix is a clear-cut, tested method guard — low
  residual risk — but this is flagged honestly as the one phase that ended on a force-advance rather than a
  unanimous re-consult.

### Phase 8 — Dashboard + VSCode held-count indicators (Round 1)

#### Gemini — REQUEST_CHANGES
- **Concern**: Missing Playwright test for the dashboard indicator (UI has a hard Playwright requirement).
  - **Addressed**: Added `spec-1313-held-count-indicator.test.ts` (4/4 on real chromium, incl. a live-update test).

#### Codex — REQUEST_CHANGES (HIGH)
- **Concern**: Dashboard indicator only unit-tested (no Playwright); VSCode coverage stops at helpers/toast — the actual `extension.ts` badge/status-bar wiring is untested.
  - **Addressed**: Added the Playwright spec; extracted `composeStatusBarText`/`composeActivityBadge` pure functions with +10 unit tests (VSCode suite → 677).

#### Claude — APPROVE (HIGH)
- **Concern**: Minor — a Playwright smoke would be belt-and-suspenders, not blocking.
  - **Addressed**: That spec is the added Playwright test.

### Phase 8 (Round 2)

#### Gemini / Codex / Claude — all APPROVE (HIGH)
- No concerns raised. (Claude non-blocking: reused `cloud-pulse` keyframe; unbounded escalation-toast `seen` Set — see Technical Debt.)

### Phase 9 — Documentation + skeleton mirror (Round 1)

#### Gemini — APPROVE (HIGH)
- No concerns raised (confirmed CLAUDE/AGENTS mirrored in both trees; `agent-farm.md` + `overview.md` updated).

#### Codex — REQUEST_CHANGES (HIGH)
- **Concern**: New `mailbox.retentionDays` / `mailbox.escalationSeconds` config knobs undocumented in the command reference.
  - **Addressed**: Added a `### Mailbox retention and escalation` subsection to both `agent-farm.md` trees (body byte-identical), documenting that retention prunes only terminal rows (held rows never pruned) and escalation is visibility-only (never a delivery trigger).

#### Claude — APPROVE (HIGH)
- **Concern**: Minor — skeleton inbox examples show 2 vs codev/'s 3; config keys not in a config reference; arch/lessons routing not done.
  - **Rebutted**: Skeleton example count is intentional (option is in the options table; skeleton is deliberately leaner) — Claude concurred it's cosmetic.
  - **Addressed**: Config keys — same fix as Codex.
  - **N/A (deferred)**: arch/lessons routing deferred to this Review phase per the plan's explicit permission.

### Phase 9 (Round 2)

#### Gemini / Codex / Claude — all APPROVE (HIGH)
- No concerns raised. Codex confirmed the config knobs now documented; Claude verified CLAUDE≡AGENTS byte-identical and the config subsection byte-identical across trees.

### Review Phase (Round 1) — PR #1330

#### Claude — APPROVE (HIGH)
- No concerns raised. Confirmed the "never force-inject" guarantee is **structurally** enforced (single gated write path, `KeyedSerializer`, `SendBuffer` deleted).

#### Codex — REQUEST_CHANGES (HIGH)
- **Concern**: `deliverAgentMail` can put bytes on the wire for a row dismissed/superseded in the gate→write window (dismiss/supersede run outside the delivery serializer).
  - **Addressed**: re-read the row via `getById` at the write instant and skip if no longer `held`; also check `markDelivered`'s guarded return before broadcasting. New test covers a dismiss during the gate check.
- **Concern**: "write completed ⇒ delivered" is unsound — `writeMessageToSession` ignores `write()`'s boolean and `writeMessagePaced` resolves on a `setTimeout` timer, so a torn-down PTY is marked delivered.
  - **Addressed**: re-check `session.writable` (the #1198 live-connection signal) at the write instant → hold `no-live-pty` instead of delivering. Residual (disconnect *during* the paced write) documented as the spec's accepted post-delivery-verification non-goal. New test covers an unwritable session.
- **Concern**: the merged plan/spec lack approval frontmatter; some commits deviate from `[Spec NNNN][Phase]`.
  - **Addressed**: added `approved`/`validated` frontmatter to spec + plan (reflecting the recorded gate approvals).
  - **Rebutted** (commit format): the deviating commits are `[Spec 1313] Thread:` records; rewriting pushed history conflicts with the repo's "preserve individual commits" policy and doesn't justify a force-push. Non-blocking.

#### Gemini — skipped
- Non-blocking skip (`agy` exited 1, unauthenticated). No review content.

### Review Phase (Round 2) — `afx inbox show <id>` reconciliation (architect-directed)

Not a consult finding: the architect held the `pr` gate to direct one change (see Deviations — `afx inbox show
<id>`). The reconciliation was implemented (new `GET /api/inbox/:id` route + `inboxShow` CLI handler + 9 tests +
spec/doc amendments) and re-submitted for the review-phase iter-2 3-way. Verdicts are recorded here after that
re-consult completes; the corresponding rebuttal lives in `1313-review-iter2-rebuttals.md`.

### Review Phase (Round 3) — architect-directed bugfix: `afx send architect` always no-profile

Found in the architect's **live** PR testing (not by the suite): every `afx send` to an architect terminal held
`no-profile` and never delivered, while builders delivered fine. Root cause: `createSessionRaw` hardcoded
`command: ''`, so `resolveProfileForSession` fell back to `.builder-start.sh` — which only builder worktrees
have. Architects run in the workspace root, so they never resolved. The suite stayed green because the gate/repro
tests use a **command-populated double**, never the real empty-command `createSessionRaw` path. Fix: thread the
launch command onto the identity seam and persist it on `terminal_sessions` (migration v16) so it survives Tower
restart; new `send-architect-identity.test.ts` drives delivery through a REAL `createSessionRaw` session.

3-way CMAP on the fix:
- **Gemini — APPROVE.** Missed the restart/upgrade gap (accepted legacy NULL rows as "acceptable self-healing").
- **Claude — approve-after-fixes (HIGH).** Flagged the missing `GLOBAL_CURRENT_VERSION` bump and, decisively,
  that reconcile already computes `restartOptions.command` from live config but doesn't use it — the clean
  self-heal for pre-existing NULL rows.
- **Codex — REQUEST_CHANGES.** Same two blockers plus: the migration blanket-swallowed ALTER failures; the
  `not.toBeNull()` assertions can't tell claude from codex (shared marker/region); a missed shell call site.
- **Addressed (all converged findings):** bumped `GLOBAL_CURRENT_VERSION` 15→16; hardened the v16 migration to
  gate on `PRAGMA table_info` instead of swallowing every error; added the `?? restartOptions?.command` self-heal
  at both reconstruction paths (reconcile + on-the-fly) so an upgraded architect resolves on the **first** restart;
  threaded/persisted the shell call site; strengthened tests to exact `.app` assertions (claude AND codex) + added
  migration/self-heal source guards.
- **Re-CMAP round 2** (on the remediation): Claude + Gemini **APPROVE**; Codex **REQUEST_CHANGES** on one verified
  new hole — the self-heal derived the command from config/`claude` but not the `TOWER_ARCHITECT_CMD` env override
  that *fresh launch* honors, so a legacy `agy` architect launched that way (no matching config) would heal to the
  wrong profile. **Fixed** by mirroring fresh-launch's exact `env > config > claude` precedence at both
  reconstruction paths (also repairs a pre-existing auto-restart divergence); added a functional v16 migration test.
- **Re-CMAP round 3** (targeted Codex re-check): the command-resolution fix is **approved** ("finding resolved, no
  new inconsistency"). Codex's sole remaining point is test-methodology — the v16 migration test drives a faithful
  *replica* of the block rather than the production runner. **Rebutted / deferred**, because: (a) `ensureGlobalDatabase`
  is private and the migration chain is inline on the DB-init critical path, so exercising it directly needs an
  export/refactor of that path — high blast radius, out of scope for a delivery bugfix; (b) it matches established
  repo precedent — the v15, bugfix-826, and pir-832 migration tests are all replica-based, and `state`/`spec-755`
  *mock* `getGlobalDb`; no existing test drives the real runner; (c) production drift is already caught — the source
  guards pin the exact production v16 statements (`GLOBAL_CURRENT_VERSION = 16`, the `ALTER`, the `PRAGMA` gate), the
  replica proves the logic, and the `GLOBAL_SCHEMA` convergence proves fresh-install correctness. Filed as a
  follow-up (see Technical Debt). tsc clean; **4183** unit tests pass.
- **Deferred (documented follow-ups, fail-closed today):** WELCOME-frame command hydration as the authoritative
  SSOT (needs a shellper-protocol change + old-shellper fallback); tightening `resolveProfile`'s substring match
  to exact basenames; persisting `args` if wrapper launches (`env codex`, `npx claude`) ever need support.

## Lessons Learned

### What Went Well
- **Safety-critical-core-first decomposition paid off.** Landing the durable store (Phase 1) and the gate
  (Phase 2) before any behavior change meant the corruption-elimination invariant was provably in force at the
  end of Phase 4, and nothing after it could reintroduce a force path (there was none to reintroduce). Phases 1,
  3, and 6 passed all-APPROVE on the first round — evidence the units were well-scoped.
- **Front-loading the blocking agy measurement (Phase 3) surfaced no schedule risk** — the net-new color-keyed
  rule was derived, tested, and unanimously approved in a single round, well before delivery wiring depended on it.
- **The gate is a single mechanism that answers many questions.** One rendered-empty check correctly handles
  drafts, menus, model pickers, trust dialogs, wrapper/boot screens, and attach-typed input — exactly the
  "born dirty, converge only via rendered proof" model the spec argued for.
- **Deleting `SendBuffer` outright** (rather than adapting it) removed the in-memory buffer, the shutdown
  force-flush, and the max-age force path in one move — the "single source of truth beats distributed state" lesson in practice.

### Challenges Encountered
- **agy's placeholder breaks the dim-placeholder assumption** (1 phase, resolved in-round): agy renders its idle
  hint at *normal* intensity but in palette-8 gray, so dim/bold couldn't separate idle from draft. The decisive
  signal was foreground color; the fix added an optional `placeholderFgPalette` to the profile (the color analogue
  of the universal `isDim()` skip). Required adding fg-color mode/index to the measurement probe.
- **Phase 7 took 3 iterations** — Codex found a *distinct* real issue each round (stale escalation refresh →
  workspace-scoping → an unguarded mutating route). None were repeats; each was a genuine gap. It ended on a
  force-advance at the iteration ceiling (fix landed + Claude-approved, but no iter-4 re-consult).
- **Environmental flaky test** (see Flaky Tests): a temp-dir/`chdir` race under concurrent sibling-builder load
  intermittently failed `porch done`'s test check; the suite is green on direct run and on retry. Cost a couple
  of retry cycles, no code change.
- **Client-vs-server contract split** cost two avoidable RCs before the send outcome was surfaced end-to-end
  (wire → `tower-client.ts` → both `send.ts` single and `--all` paths).

### What Would Be Done Differently
- **Trace every contract change end-to-end in the plan.** The send-outcome contract was specified server-side but
  not client-side, and "automated e2e" was under-specified — both drew repeat RCs. Name the client surfaces and
  the exact repro scenario in the plan deliverable.
- **Wire config knobs through loader + defaults + docs in the same phase they're first read** — the retention/
  escalation keys lagged across three phases.
- **Treat Playwright as day-one for any dashboard-visible change**, not a follow-up — it's a CLAUDE.md mandate and
  cost a Phase 8 iteration.
- **Exercise an identity/seam through its REAL construction path in at least one test — never only a hand-populated
  double.** The `afx send architect` no-profile bug shipped past a fully green suite because every gate/delivery
  test built its session as a plain object with `command` set, so the real `createSessionRaw` path (which hardcoded
  `command: ''`) was never driven. "Tests pass" was true and "it works" was false — the exact lesson-critical
  trap. A double is fine for branch coverage, but the seam itself needs one test that constructs the real object.

### Methodology Improvements
- **SPIR/porch**: the 3-iteration force-advance ceiling worked as a safety valve but can advance a phase whose
  last fix wasn't re-consulted. Consider a "final fix landed after the blocking review — re-consult once even at
  the ceiling, or flag prominently for the PR gate" nudge so the human reviewer knows to look. (Flagged here in
  the review; the PR gate is the backstop.)
- **Tooling**: the environmental temp-dir/`chdir` flakiness under many concurrent builders is worth a porch-level
  mitigation (retry-once-on-`getcwd`-failure, or isolating vitest worker cwd) so it doesn't masquerade as a real
  test failure. Noted in Follow-up Items.

## Architecture Updates

Routed one hot-tier fact (behavior-changing + cross-cutting: it changes the contract every agent relies on when
sending), and reference detail to the cold archive. Applied via the `update-arch-docs` skill's discipline.

- **Routed: hot** — `codev/resources/arch-critical.md`, Critical facts — added: *"`afx send` is mailbox-first
  (Spec 1313): every send persists to `global.db` before responding, and a message body is only ever written to a
  prompt a headless-terminal render-gate proves empty — never force-injected. Response is `delivered` | `held`+reason
  (`busy`/`no-profile`/`no-live-pty`)."* This is a cross-cutting invariant a future builder must know before
  touching the send path or adding a message writer. To honor the cap, demoted the weaker forge-concept-commands
  line to `arch.md` (it is a narrower how-to already covered in the cold Integration Points).
- **Routed: cold** — `codev/resources/arch.md`, Core Components — **rewrote the stale `### 7. Message Delivery`
  section** (it still described the deleted `SendBuffer` — a retired-component graveyard) to the mailbox-first
  mechanism: the `mailbox` table (agent-addressed rows), `render-gate.ts` + `gate-profiles.ts` (claude/codex
  dim-placeholder + agy color-keyed `placeholderFgPalette` rules), per-PTY `write-queue.ts` serialization, the
  `mailbox-delivery.ts` drainer (enqueue/submit/quiescence/backstop triggers; escalation as visibility-only via
  `mailbox-escalation` + held-count via `overview-changed` SSE), cron rerouting via `cron-delivery.ts`, and the
  honest `delivered`/`held`+reason response. Also updated the **Tower Startup Sequence** boot table (Agent Farm
  Internals): step 4 `startSendBuffer()` → `startMailboxDrainer()` with no-force-flush shutdown.

## Lessons Learned Updates

Routed three lessons to the COLD archive. **No hot-tier (`lessons-critical.md`) change** — the incumbent 10
lessons are all stronger/more general than this project's takeaways, and the contract-completeness lesson, while
cross-cutting, is not decision-changing enough to displace one (bias toward KEEP per the `update-arch-docs` cap
discipline). The one hot-tier addition this project earned is architectural (the mailbox invariant), not a lesson.

- **Routed: cold** — `codev/resources/lessons-learned.md`, Process — added: *"Trace a contract change end-to-end
  before calling it specified — a send-outcome change specified server-side but not client-side
  (`tower-client.ts` + `commands/send.ts`, single AND `--all` paths) drew repeat REQUEST_CHANGES across the plan
  and Phase 4. Name every layer the contract crosses (wire → client → each CLI path) in the plan deliverable."*
- **Routed: cold** — `codev/resources/lessons-learned.md`, Testing — added two recipes: *"A dashboard-visible
  change needs a Playwright e2e from the first commit (CLAUDE.md mandate), not a follow-up; a unit test alone drew
  a Phase-8 block. Extract vscode-free pure composers so extension wiring is unit-testable."* and *"When a spec
  names a specific repro, the automated e2e must exercise *that* scenario, not an adjacent easy one (Spec 1313
  Phase 4)."* Both are spec-narrow recipes → cold, not hot.

## Technical Debt

- **Unbounded `seen` Set in the VSCode escalation toast** (`mailbox-escalation-toast.ts`): dedupes escalation
  toasts by `mailboxId` for the extension's lifetime; grows without bound. Negligible in practice (escalations are
  rare; entries are small strings), flagged by Claude in Phase 8. Bound it (LRU or resolved-row eviction) if
  escalation volume ever grows.
- **Phase 7 ended on a force-advance**, not a unanimous re-consult (see Consultation Feedback → Phase 7 Round 3).
  The final fix is tested and Claude-approved; the residual is the absence of a Codex re-confirmation.
- **Synthesized agy fixtures**, not raw captures (the raw capture leaks the authenticated account email). They are
  verified through the real classifier path, but a version bump should re-measure against live agy (the spike
  harness is the smoke test) rather than trusting the synthesized bytes indefinitely.
- **Intra-paced-write delivery residual** (review iter-1, Codex issue 2): the delivery path now re-checks
  `session.writable` and row-status at the write instant, but a disconnect (or dismiss) landing *during* the
  sub-100ms paced setTimeout writes can still drop the trailing Enter / later lines while the row is marked
  delivered. Closing this fully needs post-delivery / canonical-stream verification — an explicit spec non-goal
  ("no believed-sent claim is made"). Accepted residual, same class as the spec's wrapper-transition race.
- **Render-gate identity is command-string-derived, not authoritative** (Round 3 bugfix follow-ups): the session's
  classifier profile is resolved from the persisted `terminal_sessions.command`. Three deferred hardenings, all
  fail-closed today: (1) **WELCOME-frame hydration** — the shellper owns the actually-running command and stays
  correct across `freshLaunch`/`crashLoopFallback` swaps that the DB row goes stale on; the cleaner SSOT, but needs
  a shellper-protocol field + old-shellper fallback (DB-now / WELCOME-later). (2) **Substring→exact-basename
  matching** in `resolveProfile` — `claude-wrapper` matches claude today; safe only because the profile table is
  behaviourally uniform. (3) **`args` persistence** — needed only if wrapper launches (`env codex`, `npx claude`)
  must resolve; deliberately not scanned to avoid misclassification.
- **Migrations aren't independently testable** (Round 3 re-CMAP, Codex): the whole v1→vN migration chain is inline
  in the private `ensureGlobalDatabase`, reachable only through the `getGlobalDb()` singleton, so every migration
  test in the repo (v15, bugfix-826, pir-832) drives a hand-kept *replica* of its block rather than the production
  runner — a replica can drift from production (source guards on the exact statements are the current mitigation).
  Extracting a `runGlobalMigrations(db)` that both `getGlobalDb()` and tests call would let all migration tests
  exercise the real code. Deferred here (a DB-init-critical-path refactor is out of scope for a delivery bugfix);
  worth doing once, repo-wide, because it benefits every migration.

## Flaky Tests

- **Environmental temp-dir/`chdir` race** (not a specific named test): under concurrent sibling-builder load,
  `porch done`'s test check intermittently failed with `shell-init: … getcwd: cannot access parent directories` —
  a test that `chdir`s into a temp dir removed mid-run by a parallel vitest worker + git subprocess. **Not a code
  defect**: a *direct* `npm test -- --exclude='**/e2e/**'` from `packages/codev` passed clean (4162 passed / 48
  skipped, 0 failures), and `porch done` passed on retry. No single reproducible failing test existed to skip
  (the direct run had zero failures), so nothing was `it.skip`-ped — it is whole-suite environmental flakiness,
  handled by retry (a passing run is a valid signal). See Follow-up Items for a suggested porch-level mitigation.
- **`render-gate.test.ts` over-cap seed-cap perf assertion** (surfaced at PR-merge CI, review phase) — the
  wall-clock timing assertion (`best-of-5 classifyScreen(>1MB) < 75ms`) flaked on shared/loaded GitHub Actions
  runners: best-of-5 measured **125ms** then **142ms** on a rerun, vs the ~15–30ms this-env / ~22ms spike baseline.
  Both review-phase integration reviewers flagged this exact assertion as CI-flaky, matching the test's own
  "headroom for slower/loaded CI" caveat. **Mitigation (architect-directed — a CI-aware guard, not a blanket skip,
  so local perf signal survives):** `const budgetMs = process.env.CI ? 500 : 75` — the tight ≤75ms bound stays the
  real steady-state signal **locally**, while CI asserts only a looser catastrophic-regression ceiling (the
  pre-tightening 500ms bound — still an order of magnitude below an O(n²) blow-up at >1MB). Verified passing in both
  modes (local 75ms and `CI=true` 500ms), 28/28. The classifier code is untouched — this is purely a test-side
  bound adjustment. Follow-up below.

## Follow-up Items

- **Live agy delivery smoke** in the verify phase: the blocking agy criterion is satisfied at the gate level
  (fixtures + measurement); a live fresh-agy trust-dialog-held → accept → clean-delivery run belongs in post-merge verification.
- **Live #1265 hand-repro** against a real builder terminal (plan Post-Implementation task) — the automated e2e
  covers it; a manual sanity check in the integrated codebase is the verify-phase belt-and-suspenders.
- **Bound the escalation-toast `seen` Set** (Technical Debt above) — small, out of this spec's scope.
- **Porch/vitest cwd isolation** to remove the `getcwd`-race flakiness under concurrent builders (retry-on-`getcwd`
  or per-worker cwd) — infrastructure, not this spec.
- **Deterministic perf guard for the render-gate seed-cap test** — replace the CI-aware wall-clock bound (added to
  stop CI flakiness) with an operation-count / complexity-based check so CI regains a tight regression guard without
  runner-load sensitivity. Test infrastructure, not this spec's scope.
- **VSCode Needs-Attention view** could optionally surface held messages (spec Open Question, nice-to-have) —
  deferred; the count indicator + attention state ship now.
