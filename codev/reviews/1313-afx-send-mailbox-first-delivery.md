# Review: afx send — Mailbox-First Delivery (Never Force-Inject)

## Summary

Replaced Spec 403's in-memory, timer-based, force-flushing `SendBuffer` with a **mailbox-first** `afx send` pipeline: every message is persisted to `global.db` at enqueue, then delivered **only** onto a prompt that a headless-terminal render-gate proves empty — never force-injected onto a busy line. Delivered across 9 implement phases (mailbox store → render-gate + claude/codex profiles → agy profile → delivery orchestration + write serialization → fast triggers → cron rerouting → `afx inbox` + escalation → dashboard/VSCode indicators → docs/skeleton), plus a substantial post-pr-gate hardening arc (architect-identity resolution, whole-ring render-gate rewrite, over-ceiling removal + verdict memo) folded into the same PR after live testing found real defects. Net: corruption is eliminated **by construction** (a body is only ever written to a verified-empty prompt), silent loss is killed by persistence, and holds are surfaced honestly (`delivered` | `held`+reason ∈ {`busy`, `no-profile`, `no-live-pty`}).

## Spec Compliance

- [x] SC1 — **#1265 repro is dead**: draft/menu/picker in the recipient → message `held(busy)`, draft untouched, delivers on submit/quiescence (Phase 4 deterministic repro + subprocess e2e; verify-phase live test). (Phases 2, 4, 5)
- [x] SC2 — **Idle delivery unchanged in feel**: idle empty prompt delivers immediately; gate cost well under the ~50ms budget (best-of-5 ≈ 19ms measured). (Phase 2; verify live)
- [x] SC3 — **No loss across Tower lifecycle**: rows persist to `global.db` before the response; restart-recovery covered; shutdown never force-flushes (`stopMailboxDrainer()` just stops the loop). (Phases 1, 4)
- [x] SC4 — **Wrapper screens don't eat messages**: `wrapper-boot` fixture classifies not-clean → held, delivered once the agent is back at a clean prompt. (Phases 2, 4)
- [x] SC5 — **Concurrent sends serialize**: per-PTY `write-queue.ts` FIFO chains text+Enter as one unit; N parallel sends produce N cleanly separated submissions in enqueue order. (Phase 4)
- [x] SC6 — **Cron parity**: cron routes through the same gate (`deliverCronMessage`); busy → held, superseded by the next run of the same task, honest outcome logged. (Phase 6)
- [x] SC7 — **Escalation is visible**: `afx inbox` lists every held row from the moment it is held; past the escalation age it emits `mailbox-escalation` and puts the dashboard/VSCode indicator into a distinct attention state. (Phases 7, 8)
- [x] SC8 — **Held reasons distinguishable**: response, `afx inbox`, and logs distinguish `busy` / `no-profile` / `no-live-pty`. (Phases 4, 7)
- [x] SC9 — **No new corruption vector**: `--interrupt` (explicit bypass) and `noEnter` (gate-checked staging) behave as documented; unknown-app targets receive nothing and hold visibly. (Phases 2, 4)
- [x] SC10 — **agy is a working target (blocking)**: agy profile measured empirically (color-keyed `placeholderFgPalette`); trust dialog → not-clean (a blind Enter cannot confirm filesystem trust); idle → clean. (Phase 3; verify live)
- [x] SC11 — **Tests + docs**: unit coverage for the mailbox lifecycle and gate classification against captured claude/codex/agy fixtures (idle/draft/menu/picker/trust/wrapper/boot); e2e drives the #1265 cycle; `afx` reference, CLAUDE.md/AGENTS.md messaging section, and skeleton mirrors updated. (all phases; Phase 9)

## Deviations from Plan

- **Phase 7 force-advanced at the 3-iteration safety ceiling.** Each of iters 1–3 had a distinct, real Codex `REQUEST_CHANGES` (escalation not firing `overview-changed`; `afx inbox` defaulting Tower-wide vs the workspace-scoped Baked Decision 8; `POST /api/inbox/:id/dismiss` reachable by GET) that was fixed; Gemini + Claude approved every round. The final fix (`af21e608`) landed just before porch's ceiling force-advance, so it was not re-consulted by a 4th round — the architect verified it against source and the full diff is re-reviewed at the pr gate.
- **Major post-pr-gate scope, same PR (#1330).** After the pr gate was first approved and the project entered verify, live testing on installed code surfaced real defects that were fixed in-branch rather than deferred: (a) `afx send architect` always `held(no-profile)` — architect sessions had no persisted `command`, so identity resolution fell through (migration v16 + restart-safe identity SSOT); (b) render-gate false-`busy` on real claude output — the classifier had only ever been validated against a *synthesized* `claude-idle` fixture (whole-ring rewrite; over-ceiling hold removed; per-`ringToken` verdict memo). The architect authorized a **verify→implement rollback** to fold these in; this review reflects the CURRENT implementation after that arc.
- **Merged `origin/main` into the branch** (was 83 behind; PR had gone CONFLICTING). Send-path conflicts resolved preserving Spec 1273's `submitToSession` per-terminal lock on the human-bypass paths (escape/interrupt) — not a regression (main already serialized interrupt via the old else-branch).
- **Edited another spec's test** (`spec-1280` T16 manifest guard) during the main-merge: its `origin/main...HEAD` diff mis-fires on any branch that touches a prompt surface after merging main. Scoped the predicate to branches that actually touch the 1280 manifest dir — **flagged for the 1280 owner** (see Follow-up).

## Key Metrics

- **Commits**: 54 `[Spec 1313]` commits on the branch (137 total including porch `chore(porch)` status.yaml bookkeeping), `origin/main..HEAD`.
- **Tests**: full unit suite ~4267 passing (48 pre-existing skips, 0 failures) at last green. New suites: `mailbox`, `render-gate`, `send-delivery`, `send-mailbox-repro`, `write-queue`, `cron-delivery`, `inbox-cli`, `inbox-routes`, `spec-1313-migration`, `spec-1313-registry-resolve`, `spec-1313-resolve-agent-for-session`, `send-architect-identity`, `pty-session-delivery-signals`, plus dashboard `HeldCountBadge`, VSCode `mailbox-indicators`/`mailbox-escalation-toast`, and the Playwright `spec-1313-held-count-indicator` e2e.
- **Files created** (selected): `db/mailbox.ts`, `servers/render-gate.ts`, `servers/gate-profiles.ts`, `servers/write-queue.ts`, `servers/mailbox-delivery.ts`, `servers/mailbox-wiring.ts`, `servers/cron-delivery.ts`, `commands/inbox.ts`, `apps/web/src/components/HeldCountBadge.tsx`, `apps/vscode/src/mailbox-indicators.ts`, `apps/vscode/src/notifications/mailbox-escalation-toast.ts`, gate fixtures (`__tests__/fixtures/gate/`, incl. 4 gzipped real claude rings).
- **Files deleted**: `servers/send-buffer.ts`, `__tests__/send-buffer.test.ts` (the retired `SendBuffer`).
- **Net LOC impact**: 102 files, **+12,540 / −869** (`origin/main...HEAD`, includes docs, fixtures, spec/plan/review/thread).

## Timelog

Granular per-event timestamps were not reliably tracked across a multi-day, many-resume effort; this is a date/milestone log. All dates 2026, UTC.

| Date | Event |
|------|-------|
| 07-31 | Specify: spec grounded against the codebase; 3-way spec consult; **GATE: spec-approval** (human approved) |
| 08-01 | Plan: 9-phase plan; 2 rounds of 3-way plan consult; **GATE: plan-approval** (human approved) |
| 08-01 | Implement phases 1–9 (build-verify per phase; iterate-until-approve) |
| 08-01 | Review (pre-rollback): review doc + arch/lessons routing; PR #1330 opened; review 3-way; `afx inbox show` held-gate change |
| 08-01 | **GATE: pr** approved → verify |
| 08-01 → 08-02 | Verify live testing → real defects found → architect-identity fix (CMAP r1–3); render-gate false-`busy` fix (approach + diff CMAP) |
| 08-02 | Architect-authorized **rollback verify→implement**; merged `origin/main`; over-ceiling removal + verdict memo folded in |
| 08-02 → 08-03 | Post-rollback CMAP rounds 1–4 on the render-gate change; all addressed |
| 08-03 | Walked porch forward over already-done phases → re-entered Review; review doc rewritten from scratch (this document) |

### Autonomous Operation

| Period | Duration | Activity |
|--------|----------|----------|
| Spec + Plan | ~part of a day | Spec grounding, 9-phase plan, 3 consult rounds |
| Human gate waits | multiple, hours each | Idle waiting for spec-approval, plan-approval, and pr-gate approvals |
| Implementation → PR | multi-day | 9 phases + review + a large post-pr-gate hardening arc, ~30 consultation rounds |

**Total wall clock**: multi-day (07-31 → 08-03), dominated by human-gate waits and a live-testing-driven rollback.
**Context window resets**: many — 10+ architect pauses / resumes across the effort, plus one explicit `afx reset`; every resume re-verified the uncommitted/inherited state against source before trusting it (born-dirty discipline).

## Consultation Iteration Summary

~30 consultation rounds across Specify, Plan, 9 implement phases, Review, verify-phase bug fixes, and the post-rollback render-gate arc (3 models per round: Gemini via `agy`, GPT-5 Codex, Claude). The overwhelming majority of blocking feedback came from **Codex**; Gemini and Claude approved most rounds, with Claude occasionally instrumenting real fixtures to catch subtle false-clean paths and Gemini skipping non-blockingly when `agy` was unauthenticated.

| Phase | Rounds | Who Blocked | What They Caught |
|-------|--------|-------------|------------------|
| Specify | 1 | Codex (RC), Claude (COMMENT) | Missing `## Expert Consultation` heading; `afx inbox` scope + dismiss authorization |
| Plan | 2 | Codex (RC ×2) | Client-side send contract; automated #1265 e2e; dead-session resolver seam; private `command/args` identity seam; `--all` client contract |
| Phase 1 (mailbox store) | 1 | — | Unanimous APPROVE (advanced first iteration) |
| Phase 2 (gate + claude/codex) | 2 | Codex (RC) | Missing claude-picker fixture; loose perf assertion; (bonus) latent native-ESM named-import bug |
| Phase 3 (agy profile) | 1 | — | Unanimous APPROVE |
| Phase 4 (delivery + serialization) | 2 | Codex (RC) | Prune retention 7→30; `project:agent` cross-workspace hold; the named #1265 subprocess e2e |
| Phase 5 (fast triggers) | 2 | Codex (RC) | Submit trigger only fired on one of two live-input paths (consolidated to `handleUserInput`) |
| Phase 6 (cron rerouting) | 1 | — | Unanimous APPROVE |
| Phase 7 (inbox + escalation) | 3 (force-adv) | Codex (RC ×3) | Escalation not firing `overview-changed`; workspace-scope Baked Decision; dismiss reachable by GET |
| Phase 8 (indicators) | 2 | Gemini + Codex (RC) | Missing Playwright e2e; untested extension wiring |
| Phase 9 (docs + skeleton) | 2 | Codex (RC) | Undocumented `mailbox.retentionDays`/`escalationSeconds` config knobs |
| Review | 3 | Codex (r1 RC, r2 COMMENT, r3 RC) | r1: two mailbox delivery races + missing frontmatter → fixed. r2 (fresh, post-rewrite): 2 APPROVE + non-blocking hygiene COMMENT (Status/PR-body). r3 (architect integration CMAP on PR #1330): silent-loss on a dropped PTY write (`delivered`→`held`) + two comment-staleness cleanups → fixed |
| Verify: architect-identity bug | 3 | Codex (RC ×2) | Version-constant miss; legacy-upgrade heal trap; `TOWER_ARCHITECT_CMD` precedence in reconcile |
| Verify: render-gate false-`busy` | 2 (approach+diff) | Gemini (RC), all 3 | Reject the count-default-fg inversion (proven false-clean); whole-ring reframe; over-ceiling + gate→write staleness false-cleans |
| Post-rollback: over-ceiling + memo | 4 | all 3 (RC r1/r3) | Memo staleness across PTY respawn; CPU regression (backstop backoff); interrupt outside the lock; generation TOCTOU; cooldown stale alarm |

**Most frequent blocker**: **Codex** — the dominant `REQUEST_CHANGES` source in nearly every round it reviewed, consistently on real implementation seams (dead-session resolution, race windows, TOCTOU, contract completeness). The 3-way earned its keep repeatedly: Gemini and Claude approved rounds where Codex found genuine blockers, and Claude's fixture instrumentation caught false-cleans the others missed.

### Avoidable Iterations

1. **Trace a contract change through every layer before claiming it specified.** The `delivered`-vs-`held`+reason send outcome was specified server-side but not on the client (`tower-client.ts` + `commands/send.ts`, single-send *and* `--all`), drawing repeat blocks across Plan and Phase 4. Naming every layer a contract crosses in the plan deliverable would have pre-empted them.
2. **Validate a classifier against real captured output from day one.** The render-gate was only ever exercised against a *synthesized* `claude-idle` fixture (the sandbox `claude` was a shim), so two field false-`busy` defects surfaced only during live install testing after the pr gate — the single most expensive avoidable iteration (it forced a verify→implement rollback). Capturing real rings up front would have caught them in Phase 2.
3. **Exercise the *named* repro, not an adjacent easy one.** Phase 4's first e2e checked an inert shell (`held/no-profile`) instead of the #1265 draft→held(busy)→submit→deliver cycle; Codex blocked until the real cycle was driven end-to-end.

## Consultation Feedback

Response tags: **Addressed** (changed to resolve), **Rebutted** (explained why current approach is correct), **N/A** (out of scope / moot). Round verdicts as recorded contemporaneously; a background extraction cross-checked these against the per-iteration evidence files in `codev/projects/1313-afx-send-mailbox-first-deliver/`.

### Specify Phase (Round 1)
#### Gemini — APPROVE
- No blocking concerns; spec technically sound and well-grounded.
#### Codex — REQUEST_CHANGES
- **Concern**: Missing `## Expert Consultation` section; `afx inbox` scope + dismiss-authorization under-specified.
  - **Addressed**: Added the Expert Consultation log; made Decision 8 workspace-scoped with explicit dismiss authorization; verified the `@xterm/headless` gap + ring-buffer path independently.
#### Claude — COMMENT
- **Concern**: Which human sees escalation; the indicator visual contract; supersede keys should be cron-only; add a dedicated escalation-age scenario.
  - **Addressed**: Clarified supersede keys are cron-only; noted the attention-state visual is a plan-level choice; added test scenario #16 (escalation-age threshold).

### Plan Phase (Round 1)
#### Gemini — APPROVE
- Noted `pruneTerminal` invocation points + liveness telemetry tracking. **Addressed** (folded into Phase 4).
#### Codex — REQUEST_CHANGES
- **Concern**: Client-side send contract unaddressed; no automated #1265 e2e; config-loader unnamed; "WS events" mislabel.
  - **Addressed**: Added the `tower-client.ts` + `commands/send.ts` contract work to Phase 4; added the `send-mailbox.e2e` deliverable; named `lib/config.ts`; corrected to SSE.
#### Claude — APPROVE
- Verified every file reference + full spec coverage; suggested a Phase 5 coalescing test + optional Phase 7 split. **Addressed**.

### Plan Phase (Round 2)
#### Gemini — APPROVE
- Confirmed iter-1 fixes landed; file refs accurate.
#### Codex — REQUEST_CHANGES
- **Concern**: Dead-session resolver seam (`resolveTarget` is live-only → `no-live-pty` hold unreachable); `PtySession` `command`/`args` are private (identity seam); `afx send --all` client contract.
  - **Addressed**: Added the agent-registry fallback + `handleSend` restructure (persist, not 404); named the getter/`appProfileKey` seam; extended the client contract to `--all`. Advanced to plan-approval gate.
#### Claude — APPROVE
- Cosmetic corrections (version-constant location; tower-client shape). **Addressed**.

### Implement Phase 1 — Mailbox persistence layer (Round 1)
- **Unanimous APPROVE.** No blocking concerns; DB conventions followed (schema + migration v15 + repository + lifecycle tests).

### Implement Phase 2 — Render-gate + claude/codex profiles (Round 1)
#### Gemini — APPROVE · #### Claude — APPROVE (all deliverables present)
#### Codex — REQUEST_CHANGES
- **Concern**: The plan's fixture matrix lists a picker for *both* apps but only codex had one; the perf assertion (single cold-run <500ms) was too loose.
  - **Addressed**: Added a synthesized `claude-picker` fixture; replaced with warm-up + best-of-5 min <75ms (logged ≈19ms). **Bonus**: grounding the measurement under native node exposed a latent `@xterm/headless` named-import failure under native-ESM (masked by vitest interop) — fixed to default-import.

### Implement Phase 2 (Round 2)
- **Unanimous APPROVE.** Codex flipped from RC after running the test file to verify behavior.

### Implement Phase 3 — agy classifier profile (Round 1)
- **Unanimous APPROVE.** agy profile derived empirically (color-keyed `placeholderFgPalette`, fg palette-8 gray = placeholder); trust dialog classifies not-clean.

### Implement Phase 4 — Delivery orchestration + write serialization (Round 1)
#### Gemini — APPROVE · #### Claude — APPROVE
#### Codex — REQUEST_CHANGES
- **Concern**: Prune retention default 7 vs spec's 30 (prunes audit rows 4× early); `project:agent` cross-workspace offline hold returned 404; the named #1265 subprocess e2e was only in the unit suite.
  - **Addressed**: `DEFAULT_PRUNE_RETENTION_DAYS = 30` + config knob read from user-global config; `resolveAgentInRegistry` resolves `project:<agent>` via `findWorkspaceByBasename`; added the real subprocess e2e driving draft→held(busy)→clear→backstop-redeliver.

### Implement Phase 4 (Round 2)
- **Unanimous APPROVE.** Codex flipped from RC; the three fixes cleared its concerns.

### Implement Phase 5 — Fast delivery triggers (Round 1)
#### Gemini — APPROVE · #### Claude — APPROVE ("No issues found")
#### Codex — REQUEST_CHANGES
- **Concern**: The submit trigger only fired on the tower-websocket input path, not the pty-manager standalone path — composing/submit detection was duplicated inline and drifted.
  - **Addressed**: Consolidated both paths through a single `PtySession.handleUserInput` chokepoint (SST), so neither can drift.

### Implement Phase 5 (Round 2)
- **Unanimous APPROVE.**

### Implement Phase 6 — Cron rerouting (Round 1)
- **Unanimous APPROVE.** Cron routes through the one gated path (`deliverCronMessage`); busy→held, per-task supersede, honest outcomes.

### Implement Phase 7 — afx inbox + broadcasts + escalation (Rounds 1–3; force-advanced)
Gemini + Claude APPROVE every round; **Codex REQUEST_CHANGES each round**, all real, all fixed:
- **Round 1** — Escalation didn't also fire `overview-changed` (stale attention bit); liveness was log-only and ignored the "recent output" gate; thin route coverage. **Addressed** (fire both events; `onLiveness` port + recent-output gate + broadcast; `inbox-routes.test.ts` integration).
- **Round 2** — `afx inbox` defaulted Tower-wide, violating Baked Decision 8 (workspace-scoped). **Addressed** (default to current workspace; normalize the `?workspace=` param).
- **Round 3** — `POST /api/inbox/:id/dismiss` had no method guard → a GET could dismiss mail. **Addressed** (405 before any mutation). Porch force-advanced at the 3-iteration ceiling; the final fix was architect-verified and is re-reviewed in the pr-gate diff.

### Implement Phase 8 — Dashboard + VSCode indicators (Round 1)
#### Claude — APPROVE (logic sound)
#### Gemini — REQUEST_CHANGES · #### Codex — REQUEST_CHANGES
- **Concern**: Missing a Playwright dashboard e2e (repo UI mandate); extension badge/status-bar wiring untested (only pure helpers were).
  - **Addressed**: Added the real-chromium `spec-1313-held-count-indicator` e2e (absent/held/escalated/live-update); extracted `composeStatusBarText`/`composeActivityBadge` pure composers + 10 wiring unit tests. (The builder's initial "Playwright infeasible" claim was wrong — it was installed; the CMAP earned its keep.)

### Implement Phase 8 (Round 2)
- **Unanimous APPROVE.** One non-blocking Claude note: the escalation-toast `seen` Set grows unbounded over extension lifetime (negligible; escalations rare) — see Follow-up.

### Implement Phase 9 — Documentation + skeleton mirror (Round 1)
#### Gemini — APPROVE · #### Claude — APPROVE (with the same minor note)
#### Codex — REQUEST_CHANGES
- **Concern**: The new `.codev/config.json` mailbox knobs (`mailbox.retentionDays`, `mailbox.escalationSeconds`) were undocumented despite being in scope.
  - **Addressed**: Added `### Mailbox retention and escalation` to both `agent-farm.md` trees (retentionDays prunes only terminal rows — held rows never pruned; escalationSeconds is visibility-only, never a delivery trigger).

### Implement Phase 9 (Round 2)
- **Unanimous APPROVE.**

### Review Phase — pre-rollback (Round 1)
#### Claude — APPROVE (safety invariant structurally enforced)
#### Gemini — SKIPPED (agy unauthenticated; non-blocking)
#### Codex — REQUEST_CHANGES
- **Concern**: Two real races — `deliverAgentMail` wrote `held[0]` from a stale read (a dismiss/supersede in the gate→write window could still write a resolved row); `write-completed⇒delivered` was unsound (a torn-down PTY could be marked delivered, violating "errored write → held"). Plus process: missing approval frontmatter; some commits deviate from `[Spec][Phase]`.
  - **Addressed**: `getById` re-check at the write instant + honor `markDelivered`'s guarded boolean; re-check `session.writable` at the write instant → hold `no-live-pty`; added spec/plan approval frontmatter. **Rebutted**: commit-message format — history is pushed; the repo preserves individual commits; no force-push warranted.

### Review Phase — `afx inbox show <id>` held-gate change
- Architect-directed resolution of a spec self-contradiction (Redaction named `afx inbox` a body-display surface, but the list is metadata-only). **Addressed**: kept the list metadata-only and added `afx inbox show <id>` (per-id body view, any status), amended Decision 8 + Redaction, updated both `agent-farm.md`/`overview.md` trees and `arch.md`.

### Verify Phase — `afx send architect` always `no-profile` (CMAP Rounds 1–3)
Live PR testing found sends to any architect returned `held(no-profile)` (architect sessions had no persisted `command`, so identity fell through `harnessFromLaunchScript`, which only builder worktrees carry).
- **Round 1** — Gemini APPROVE (missed the restart gap); Claude approve-after-fixes; **Codex REQUEST_CHANGES**: `GLOBAL_CURRENT_VERSION` not bumped; legacy architects (command=NULL) heal to `''` on restart → still no-profile; migration blanket-swallowed ALTER errors; `not.toBeNull()` can't tell claude from codex. **Addressed** all (bump to 16; `dbSession.command ?? restartOptions.command` self-heal at both reconstruction paths; PRAGMA-gated migration; exact `.app` assertions).
- **Round 2** — Gemini + Claude APPROVE; **Codex REQUEST_CHANGES**: the reconcile self-heal ignored `TOWER_ARCHITECT_CMD` precedence that fresh-launch honors. **Addressed** (mirror env > config > 'claude' in both reconcile derivations).
- **Round 3** — a targeted **Codex-only** re-check (Gemini + Claude had already approved the code in round 2): Codex confirmed the code APPROVED, so all three now approve the fix. Its sole remaining point was migration-test methodology (replica vs the private production runner). **Rebutted + deferred**: repo precedent is replica-based; source guards pin the exact production statements; filed "extract `runGlobalMigrations(db)`" as a repo-wide follow-up.

### Verify Phase — render-gate false-`busy` fix (Approach CMAP + Diff CMAP)
The gate reported `busy` for prompts that were actually empty (only ever validated against synthesized fixtures).
- **Approach CMAP** — all three REQUEST_CHANGES-equivalent (Gemini explicit; Codex & Claude substantively rejecting the core proposal): the proposed "count only default-fg" inversion is **unsafe** (colored user input → false-clean); Claude *instrumented the real fixtures* and proved the inversion false-cleans the agy-trust dialog. **Addressed**: dropped the inversion; adopted the architect's cap-sweep finding that the false-`busy` is a **slice artifact** → render the **whole** ring; hardened the region boundary ("no region-end ⇒ busy").
- **Diff CMAP** — all three REQUEST_CHANGES (whole-ring itself confirmed safe, but each with a pre-merge blocking ask): two false-clean paths the change introduced — an over-ceiling slice could reconstruct a clean composer while the whole ring holds a draft (**Addressed**: over-ceiling → held unrendered, then removed entirely post-rollback); gate→write staleness amplified 3–5× (**Addressed**: sample a ring change-token before classify, re-check after → change ⇒ hold). Plus observability (liveness escalation extended to classifier-stuck reasons).

### Post-rollback — over-ceiling removal + `ringToken` verdict memo (CMAP Rounds 1–4)
Folded into PR #1330 after the verify→implement rollback.
- **Round 1** — all three REQUEST_CHANGES (the removal itself endorsed as ship-worthy): memo stale across PTY respawn / `RingBuffer.clear()` (**Addressed**: bind the cache to the live session instance); CPU regression — the memo misses exactly when the ring is biggest (**Addressed**: cost-aware backstop backoff, never a hold); interrupt `\x03` outside the submission lock (**Addressed**: atomic interrupt+settle+write in one callback); the `spec-1280` predicate skipped the forgot-manifest case + a Windows path bug (**Addressed**: portable predicate); `stop()` must clear all drainer maps.
- **Round 2** — Gemini APPROVE, Claude "fixes hold", **Codex REQUEST_CHANGES**: interrupt double-delivery (enqueue-before-Ctrl+C left the row drainable — **Addressed**: sync `markDelivered` before any await); memo cached CLEAN across a delivery (input doesn't advance the ring — **Addressed**: invalidate memo after every delivery); backoff delayed the classifier-stuck escalation (**Addressed**: skipped tick re-feeds `recordStreak`); bigRing lost on TOCTOU-hold; `stop()`/`start()` lifecycle race (**Addressed**: `generation` counter).
- **Round 3** — all three REQUEST_CHANGES (verification round earned its keep): memo invalidation sat *below* the `markDelivered` guard (a row resolved mid-write skipped `memo.delete` — **Addressed**: move it above the guard); generation check preceded the await but the mutations followed it (**Addressed**: post-await gen guard in both tick + scheduleDrain); cooldown re-fed a *stale* classifier-stuck detail (**Addressed**: one fresh classify at the crossing tick); the backstop tick had no catch → an unhandled rejection could kill Tower (**Addressed**: try/catch).
- **Round 4** — Gemini APPROVE ("ship it"); **Codex REQUEST_CHANGES** (contract-level): `memo.delete` is skipped if `writeMessage` rejects — not reachable via today's binding but real at the port contract (**Addressed**: `try{await}finally{memo.delete}` + a rejecting-write test); **Claude REQUEST_CHANGES** (test-only): the round-3 `scheduleDrain` generation test was vacuous (never parked at the await) — **Addressed** (drain microtasks to actually park; revert-checked). All six round-3 runtime fixes verified correct.

### Review Phase — Round 2 (fresh 3-way after the review-doc rewrite)
Re-run on the current PR #1330 diff + the rewritten review doc (the verify→implement rollback reset review to iteration 1; this is the fresh verification the pr gate rests on). **Outcome: 2 APPROVE + 1 non-blocking COMMENT — no REQUEST_CHANGES.**
#### Gemini — APPROVE (HIGH)
- Confirmed the iter-1 races are fixed and the spec/plan approval frontmatter was added. No key issues.
#### Claude — APPROVE (HIGH)
- Verified both iter-1 race fixes against source (`getById` re-check at `mailbox-delivery.ts:383`; `session.writable` re-check at `:393`) and independent checks (tsc clean; 123/123 mailbox suites; CLAUDE≡AGENTS byte-identical; `send-buffer.ts` actually deleted). Two non-blocking notes: the `spec-1280` re-scope (already flagged) and the Phase-7 force-advance (disclosed).
#### Codex — COMMENT (MEDIUM, non-blocking)
- **Concern**: spec/plan still declare `Status: draft`. **Addressed** — spec→`specified`, plan→`approved`.
- **Concern**: PR #1330 body stale (4162 tests; agy smoke "deferred"). **Addressed** — refreshed to ~4267 passing, completed live verification, and the post-gate hardening arc.
- **Concern**: the `spec-1280` T16 re-scope makes its guard branch-dependent. **N/A** — already flagged for the 1280 owner in Technical Debt; reverting it would break the manifest guard on this branch.
- **Concern**: numerous untracked consultation artifacts. **N/A (deliberate)** — the review doc is the canonical consultation record; the transient per-round evidence files + builder-session dotfiles stay untracked.
- Environmental (the review sandbox could not rerun Vitest or refetch the remote) — not defects; the last direct run was 0 failures / 48 pre-existing skips.

### Review Phase — Round 3 (architect integration review on PR #1330)
A 3-way integration CMAP on the PR diff; the architect verified every claim against source (Claude and Codex contradicted each other on a TOCTOU point, so the code was read directly). **Outcome: Gemini APPROVE · Claude COMMENT · Codex REQUEST_CHANGES (HIGH) → CHANGES REQUESTED — the pr gate stayed parked, not approved.** One blocking defect + two cleanups. Fixed on-branch at the pr-gate state (no rollback, per architect direction); full unit suite **4275 pass / 48 skip / 0 fail** after the fix.
#### Gemini — APPROVE (HIGH)
- No blocking concerns.
#### Claude — COMMENT (non-blocking)
- Flagged the `spec-1280` vestigial guard and (with Codex) the stale `SendBuffer` comments in `session-submit.ts`.
#### Codex — REQUEST_CHANGES (HIGH)
- **🔴 Blocking — a dropped PTY write was reported `delivered` (silent loss).** `PtySession.write()` returns `false` on a dropped shellper write (#1198), but `WritableSession.write()` was typed `void`, so `writeMessagePaced` resolved on a pure timer and `deliverAgentMail` called `markDelivered` unconditionally. The `!session.writable` precheck is t=0 only, so a socket dying *during* the paced text→…→Enter sequence (10–130ms+) lost the message silently — the exact failure this spec exists to eliminate, and it was **not** in the disclosed Technical Debt (never a conscious risk-accept).
  - **Addressed**: threaded the boolean end-to-end. `WritableSession.write(): boolean`; a new drop-aware `writeMessagePaced(): Promise<boolean>` in `message-write.ts` wraps the session and records ANY dropped write across the whole paced sequence (the resolve fires after the Enter, so every write's result is observed); `DeliveryPorts.writeMessage(): boolean | Promise<boolean>`; `deliverAgentMail` now holds `no-live-pty` on a `false` result instead of marking delivered (the memo is still invalidated in the `finally`, and a genuine reject still propagates). New tests cover **BOTH** the synchronous first write and the delayed Enter/multiline writes (`spec-1313-paced-write-drop.test.ts`, 9 cases) plus the delivery-decision hold (`send-delivery.test.ts`); the four `writeMessage` port doubles and the tower-routes gate-session double were updated to the boolean contract.
  - **N/A (deferred, architect-ratified)**: Codex's companion gate→write **input-echo race** stays the tracked Follow-up item — not widened here, per architect direction.
- **🟡 Cleanup — vestigial `spec-1280` guard.** The branch-scoped `origin/main...HEAD` completeness guard is a `main`-resident no-op now that 1280 is integrated.
  - **Addressed**: deleted the guard `it()` (with its now-orphaned `execFileSync` import and `PROMPT_BEARING` const); kept the structural manifest validators. Cleaner than re-scoping (architect direction). Resolves the standing Technical-Debt / Follow-up item.
- **🟡 Cleanup — stale `SendBuffer`/`deliverBufferedMessage` comments** in `session-submit.ts`.
  - **Addressed**: rewrote the "Ordering is not atomicity" and "Exactly what it covers" passages to the mailbox-delivery model. Also corrected two adjacent staleness bugs of the same class in that doc-block: the cron bullet (Phase 6 of *this* spec removed cron's blind `writeMessageToSession`, so its "writes directly" claim was likewise false) and the "escape and immediate-delivery" wording (the normal immediate send now routes through the per-agent mailbox serializer, not this per-session lock — only `escape`/`interrupt` still take it).

## Lessons Learned

### What Went Well
- **The safety invariant held under pressure.** "A body is only ever written to a gate-verified-empty prompt, no force path" survived every review round and every post-rollback refactor — reviewers verified it *structurally* rather than case-by-case. Designing for correctness-by-construction (vs detect-and-repair) is what made the many delivery-race fixes local and bounded.
- **The 3-way consult repeatedly caught what solo review missed.** Codex found real seams (dead-session resolution, TOCTOU windows, contract gaps) round after round; Claude *instrumented the real fixtures* to prove a proposed inversion would false-clean the agy trust dialog. Trusting the protocol paid off — most blocks were genuine.
- **Born-dirty discipline on every resume.** With 10+ context resets, re-verifying inherited/uncommitted state against source (not the snapshot) caught real bugs (an invisible NUL in a serializer key; a native-ESM import failure masked by vitest).

### Challenges Encountered
- **A classifier validated only against synthesized fixtures shipped latent field bugs** — cost a full verify→implement rollback + ~7 post-rollback CMAP rounds. Resolved by capturing real rings and rendering the whole ring.
- **Architect-identity resolution had a restart-durability trap** — a creation-site-only fix would have silently reverted on the first Tower restart (reconcile rebuilds from a DB that stored no command). Resolved by making identity a persisted, restart-safe SSOT with a legacy self-heal (migration v16). Cost 3 CMAP rounds.
- **Performance of whole-ring rendering** — rendering the whole ring every 1.5s backstop tick for a large busy ring is expensive; the naive memo missed exactly the expensive case. Resolved with a cost-aware backstop backoff + session-bound `ringToken` memo.

### What Would Be Done Differently
- Capture **real** terminal fixtures for any output-classifier from the first phase, not synthesized proxies.
- In the plan, enumerate **every layer a contract crosses** (wire → client → each CLI path) as an explicit deliverable, so client surfacing isn't discovered at review time.
- When a spec names a repro, write the e2e for **that** repro immediately.

### Methodology Improvements
- **Protocol**: porch's 3-iteration force-advance ceiling let a real (fixed but un-re-consulted) change through on Phase 7 — the pr-gate diff review is the intended backstop, and it worked here, but a "final fix landed at the ceiling → require one confirming pass or explicit human sign-off" rule would tighten the seam.
- **Tooling**: a repo convention for capturing/gzipping real terminal rings as fixtures (now demonstrated in `__tests__/fixtures/gate/`) would help any future TUI-classifier work.

## Architecture Updates

- **Routed: HOT** (`arch-critical.md`) — added the mailbox-first invariant: "`afx send` is mailbox-first (Spec 1313): persist to global.db first, then deliver only onto a render-gate-verified empty prompt. Any new message writer routes through the mailbox+gate — never write a PTY directly, never force-inject. Response: `delivered` | `held`+reason." Displaced the weaker forge-concept-commands line to cold `arch.md` (already fully covered there) to respect the 10-fact cap (1:1 displacement). *(Committed during the original Review; verified present.)*
- **Routed: COLD** (`arch.md`) — rewrote the stale `### 7. Message Delivery` section (which still described the deleted `SendBuffer`) into the full mailbox-first mechanism; updated the Tower Startup boot table (`startSendBuffer()` → `startMailboxDrainer()`, no-force-flush shutdown). **This session** additionally corrected §7 for the post-rollback change: the gate renders the **whole** output ring at any size (was "seed-capped") — never a tail slice, never a delivery-blocking cap — with a per-`ringToken` verdict memo + cost-aware backstop backoff to keep whole-ring classification cheap.
- These four `codev/resources/` governance files are user-evolved (not framework files), so **no `codev-skeleton/` mirror is required** (CLAUDE.md/AGENTS.md pull the hot files via `@`-import, so they reflect the hot edit automatically and stay byte-identical).

## Lessons Learned Updates

- **Routed: COLD** (`lessons-learned.md`) — Process: "Trace a contract change end-to-end before calling it specified" (the `delivered`/`held` client-surfacing gap). Testing: "When a spec names a specific repro, the automated e2e must exercise *that* scenario." **This session** added a third: "Validate a screen/output classifier against REAL captured terminal output across real app states, not synthesized fixtures" — the single most expensive lesson of the project (it forced the rollback).
- **No HOT (`lessons-critical.md`) change** — the incumbent hot lessons ("'tests pass' is not 'it works' — verify the real user path end-to-end" and "when guessing fails, build a minimal repro — captured raw data beats speculation") already dominate; the new render-gate lesson is a spec-narrow refinement of them and belongs in the cold archive. Bias toward KEEP at the cap.

## Technical Debt

- **`spec-1280` T16 vestigial completeness guard removed** (architect integration review, Review round 3). The branch-scoped `origin/main...HEAD` completeness `it()` became a `main`-resident silent no-op once 1280 integrated; it was deleted (with its orphaned `execFileSync` import and `PROMPT_BEARING` const), keeping the structural manifest validators. This **resolves** the earlier "predicate edited — flagged for the 1280 owner" item; no scoping remains to confirm.
- **Silent-loss fix — benign partial-write residual.** If the text lands but the Enter is dropped mid-pace, the row is held `no-live-pty` while a draft sits in the composer. This never loses or double-delivers a message: a dead session is torn down and the agent-addressed row drains to its respawn; a recovered session shows a draft, so the render gate holds until the next clean prompt and delivers then. Recorded for completeness — no action needed.
- **Architect-identity SSOT is fail-closed, not fully authoritative**: the durable fix persists `command` on the session row + a legacy self-heal; a WELCOME-frame hydration (the fully-authoritative source) was deferred (needs a protocol change).
- **Migration tests use a faithful replica** of the production migration block, not the private `ensureGlobalDatabase` runner (repo precedent; source guards pin the real statements). Filed: extract `runGlobalMigrations(db)` for real migration tests.
- **`#1047` unbounded `partial`**: whole-ring rendering accepts an OOM residual on a pathological runaway (mitigated by the memo + backoff; never a delivery-blocking cap). The root cause (persistent xterm) is a separate future project.
- **agy `AGY_MARKER` (`/^> /`) is loose** and the interrupt-vs-mailbox-delivery cross-path is not fully serialized (architect-ratified as leave-as-is).

## Flaky Tests

- **`render-gate.test.ts` perf assertion** — the seed-cap/whole-ring render-budget assertion flaked on loaded CI runners (best-of-5 125–142ms vs a 75ms local ceiling). Per architect direction, mitigated with a **CI-aware bound** (`process.env.CI ? 800 : 250` ms; earlier 500 for the seed-cap era) rather than a blanket skip, so the tight local steady-state signal survives while CI asserts only a catastrophic-regression ceiling. Documented; a deterministic op-count check is the intended replacement (Follow-up).
- **Whole-suite environmental flakiness** (not a single test): a `getcwd: cannot access parent directories` signature from a parallel-vitest-worker + git-subprocess temp-dir race (aggravated by 9+ concurrent sibling builders), and a build-race when `npm run build` (which `rm -rf`s `dist/`/`skeleton`) runs *concurrently* with vitest. Handled by not running the build concurrently with the suite and by retry; a direct suite run was always clean (0 failures). No individual test was skipped (none reproduced in isolation).
- **`session-manager.test.ts` auto-restart timing test** starved under full-suite parallelism (passed in isolation, ~472ms). No skip needed — it did not repeat.

## Follow-up Items

- Replace the render-gate perf wall-clock assertion with a deterministic op-count check.
- Bound the VSCode escalation-toast `seen` Set (dedupe by mailboxId with eviction) — negligible today.
- Fuller close of the gate→write **input** race (a human keystroke between snapshot and write — `R7` staleness guard) and the input-echo-lag residual.
- Tighten `AGY_MARKER`; consider WELCOME-frame identity hydration; `#1047` persistent-xterm root cause.
- Extract `runGlobalMigrations(db)` so migration tests can drive the real production runner.
