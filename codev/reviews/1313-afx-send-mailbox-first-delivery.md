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
- [x] SC11 — **Tests + docs**: unit coverage for the mailbox lifecycle and gate classification against captured claude/codex/agy fixtures (idle/draft/menu/picker/trust/wrapper/boot); e2e drives the #1265 cycle; the `afx` reference (`agent-farm.md`) documents the `delivered`/`held` outcomes and `afx inbox`, mirrored to the skeleton, with the mailbox-first invariant in the `arch-critical.md` hot tier. (all phases; Phase 9) *(CLAUDE.md/AGENTS.md were intentionally left untouched — Spec 1280 owns those two prompt surfaces; see Deviations / Technical Debt.)*

## Deviations from Plan

- **Phase 7 force-advanced at the 3-iteration safety ceiling.** Each of iters 1–3 had a distinct, real Codex `REQUEST_CHANGES` (escalation not firing `overview-changed`; `afx inbox` defaulting Tower-wide vs the workspace-scoped Baked Decision 8; `POST /api/inbox/:id/dismiss` reachable by GET) that was fixed; Gemini + Claude approved every round. The final fix (`af21e608`) landed just before porch's ceiling force-advance, so it was not re-consulted by a 4th round — the architect verified it against source and the full diff is re-reviewed at the pr gate.
- **Major post-pr-gate scope, same PR (#1330).** After the pr gate was first approved and the project entered verify, live testing on installed code surfaced real defects that were fixed in-branch rather than deferred: (a) `afx send architect` always `held(no-profile)` — architect sessions had no persisted `command`, so identity resolution fell through (migration v16 + restart-safe identity SSOT); (b) render-gate false-`busy` on real claude output — the classifier had only ever been validated against a *synthesized* `claude-idle` fixture (whole-ring rewrite; over-ceiling hold removed; per-`ringToken` verdict memo). The architect authorized a **verify→implement rollback** to fold these in; this review reflects the CURRENT implementation after that arc.
- **Merged `origin/main` into the branch** (was 83 behind; PR had gone CONFLICTING). Send-path conflicts resolved preserving Spec 1273's `submitToSession` per-terminal lock on the human-bypass paths (escape/interrupt) — not a regression (main already serialized interrupt via the old else-branch).
- **Touched another spec's test, then restored it, then resolved the collision at the source** (`spec-1280` T16 manifest guard). During the main-merge an earlier session scoped its `origin/main...HEAD` predicate (it mis-fires on any branch touching a prompt surface post-merge), and the integration-review round briefly deleted it as "vestigial." **Both were reverted** — Issue #1280 is OPEN and T16 is a live Phase-0 guard, so the file was restored to `main` exactly (never scoped/skipped/deleted). **Resolved (architect change round, 2026-08-05):** rather than modify another active project's guard, 1313 reverted its *only* edit to those two prompt surfaces — the 9-line "Send outcomes" section — back to `origin/main` (both files now byte-identical to `origin/main`'s tip and to each other). 1313 introduces no *net* change to those files versus `origin/main`, so the cross-project conflict is closed and T16 passes **in the rebased/merged state**. (Verified caveat: on the *un-rebased* branch — 285 commits behind — T16's three-dot `origin/main...HEAD` diff compares HEAD against the stale merge-base `3f622fe6`, which predates `main`'s own newer build-doc edit to these two files, so T16 still lists them and stays red until the branch is rebased/merged onto current `origin/main`.) The user-facing send-outcomes docs remain in the `afx` reference (`agent-farm.md`) + skeleton mirror + `arch-critical.md`. (see Technical Debt / Follow-up)

## Key Metrics

- **Commits**: 54 `[Spec 1313]` commits on the branch (137 total including porch `chore(porch)` status.yaml bookkeeping), `origin/main..HEAD`.
- **Tests**: full unit suite **4551 passing** (48 pre-existing skips, 0 failures) at last green (2026-08-06, after the round-2 persistent-mirror fix + hygiene items; `send-integration.e2e` 7/7). New suites: `mailbox`, `render-gate`, `send-delivery`, `send-mailbox-repro`, `write-queue`, `cron-delivery`, `inbox-cli`, `inbox-routes`, `spec-1313-migration`, `spec-1313-registry-resolve`, `spec-1313-resolve-agent-for-session`, `send-architect-identity`, `pty-session-delivery-signals`, `session-screen` (round 2), plus dashboard `HeldCountBadge`, VSCode `mailbox-indicators`/`mailbox-escalation-toast`, and the Playwright `spec-1313-held-count-indicator` e2e.
- **Files created** (selected): `db/mailbox.ts`, `servers/render-gate.ts`, `servers/gate-profiles.ts`, `servers/write-queue.ts`, `servers/mailbox-delivery.ts`, `servers/mailbox-wiring.ts`, `servers/cron-delivery.ts`, `commands/inbox.ts`, `apps/web/src/components/HeldCountBadge.tsx`, `apps/vscode/src/mailbox-indicators.ts`, `apps/vscode/src/notifications/mailbox-escalation-toast.ts`, gate fixtures (`__tests__/fixtures/gate/`, incl. 5 gzipped real claude rings — the 5th, `claude-ghost-suggestion-empty`, is the 2026-08-06 ghost-cursor regression fixture).
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
| Verify: render-gate ghost-cursor | 1 (architect live-test) | architect (live) | Idle-agent false-`busy` — claude's suggested-command ghost inverse cursor cell miscounted as user text; fixed by the ghost-signature cursor-cell exemption |

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
- **🟡 Cleanup — `spec-1280` guard → REVERSED on new information.** Codex (and the earlier round) read T16 as a vestigial `main`-resident no-op. But Issue #1280 is **OPEN** — its `status.yaml` shows `phase_0_instrument` in progress, phases 1–10 pending, and phase_1 edits `CLAUDE.md`/`AGENTS.md`. T16 is a **live** guard 1280 pre-positioned in Phase 0 for its upcoming prompt-surface phases; deleting or scoping another active project's guard would be wrong.
  - **Addressed (restored)**: `git checkout main -- …/spec-1280-phase-manifest.test.ts` — reverting BOTH this session's deletion AND the earlier `isProject1280` scoping in one shot. Not made to pass / scoped / skipped. → **Resolved in a follow-on architect change round (2026-08-05)** — instead of touching another project's guard, 1313 reverted its CLAUDE/AGENTS "Send outcomes" section to `origin/main`, so it introduces no net change to those prompt surfaces vs `origin/main`'s tip; T16 passes in the rebased/merged state (red on the un-rebased branch — see the Architect Change Round below / Technical Debt).
- **🟡 Cleanup — stale `SendBuffer`/`deliverBufferedMessage` comments** in `session-submit.ts`.
  - **Addressed**: rewrote the "Ordering is not atomicity" and "Exactly what it covers" passages to the mailbox-delivery model. Also corrected two adjacent staleness bugs of the same class in that doc-block: the cron bullet (Phase 6 of *this* spec removed cron's blind `writeMessageToSession`, so its "writes directly" claim was likewise false) and the "escape and immediate-delivery" wording (the normal immediate send now routes through the per-agent mailbox serializer, not this per-session lock — only `escape`/`interrupt` still take it).

### Architect Change Round (2026-08-05) — CLAUDE.md/AGENTS.md reverted to resolve the 1280 collision

- **Change requested:** revert 1313's *only* edit to the two byte-identical prompt surfaces (`CLAUDE.md`, `AGENTS.md`) — the 9-line "Send outcomes: delivered vs held" section — back to `origin/main`, keeping every other doc change (`arch.md`, `arch-critical.md`, `lessons-learned.md`, `codev/resources/commands/*.md`, and the skeleton twins). Spec 1280 Phase 1 owns and is actively rewriting those two files; 1313 must not touch them.
  - **Addressed:** `git checkout origin/main -- CLAUDE.md AGENTS.md`. Verified: zero diff vs `origin/main`'s tip (two-dot), byte-identical to each other, section absent from both. No source code touched; the send-outcomes docs remain in the `afx` reference (`agent-farm.md`) + skeleton mirror + `arch-critical.md` hot tier.
  - **Verified caveat on T16 timing.** The `spec-1280` T16 completeness guard uses a **three-dot** `origin/main...HEAD` diff, which compares HEAD against the **merge-base** (`3f622fe6`), not `origin/main`'s tip. This branch is **285 commits behind** and `main` advanced these two files (a build-doc paragraph) since that merge-base — so HEAD's now-`origin/main`-tip version (blob `916f75de`) still differs from the merge-base version (blob `7fa8c9b6`), and T16 continues to list CLAUDE.md/AGENTS.md → **red on the un-rebased branch** (confirmed: 1 of 4 T16 sub-tests fails). It goes **green once the branch is rebased/merged onto current `origin/main`** — the same maintainer-side rebase already needed to clear the CONFLICTING PR — because 1313 makes no net change to these files. Reverting to the *merge-base* version instead would force T16 green now but make the PR **revert `main`'s build-doc text** (a regression), so matching `origin/main`'s tip (the architect's directive) is the correct final-state fix.

### Architect Live-Test Round (2026-08-06) — render-gate ghost-cursor false-`busy`

Live PR-testing on the installed build (dist md5-matching this worktree) found `afx send`s to an **idle** agent stranding as `held(busy)` while the composer was visibly empty (held row `a21b6c64` → `main`). The architect root-caused it byte-level against the live ring and handed off a findings doc + a captured fixture (`codev/spir-1313-captures/`).

- **Finding (verified, not inferred).** claude 2.1.220 paints a **suggested-command ghost** into the idle composer when its own last reply mentioned a runnable command. The ghost's first char doubles as the software block cursor — **SGR-7 inverse at normal intensity** — while the rest of the ghost is SGR-2 dim (`❯ ␛[7ma␛[27m␛[2mfx cleanup…␛[22m`). The universal dim rule skipped the ghost body but **counted the lone inverse cursor cell** → `user-text`/`busy` permanently on an idle terminal. Fail-safe (never misdeliver) becomes **fail-forever** for the exact unattended agent `afx send` exists to wake (a human present at the line would clear it on the next submit; an idle one never does).
- **Fix (this round).** `classifyScreen` exempts exactly that cell — the cell at the headless cursor position, **inverse + non-dim + with a dim/empty tail on its row** (the measured ghost signature; the findings' conservative option C). Deliberately **not** a blanket inverse skip (the finding's explicit warning): an inverse *selection* over a real draft fails the dim-tail test and, even if it passed, keeps every other cell counted, so a real draft can never be false-cleaned.
- **Cross-app checked against live terminals** per the finding's instruction. codex (task-shxz, ghost "Write tests for @filename") renders its *whole* ghost **dim** including the cursor cell → already CLEAN via the dim rule, never hit by this bug; the exemption is generic, so a hypothetical codex inverse-ghost is handled identically. A real claude draft (task-vdfd "dfsd") stays `busy` — typed chars are never inverse-rendered and the inverse block cursor rests on trailing whitespace (skipped as whitespace).
- **Regression coverage.** The captured `claude-ghost-suggestion-empty.replay.bin.gz` (139×63, gzipped) is wired as a fixture — **CLEAN post-fix, `busy/user-text(1)` pre-fix** (recorded before the change) — plus synthetic branch tests (ghost→clean; inverse-cursor-over-real-text→busy; real-draft-inverse-trailing→busy; codex-signature→clean; and — after the CMAP below — empty-tail→busy). All existing fixtures classify unchanged.
- **CMAP round + tightening (Codex RC, same day).** The architect's 3-way re-consult returned **Gemini APPROVE/HIGH · Claude APPROVE/HIGH · Codex REQUEST_CHANGES/HIGH** — one blocking item, architect-verified and agreed: the first cut exempted the cursor cell on a dim-**or-empty** tail, so a 1-char draft with the cursor on its only char (an inverse cell, empty tail) false-cleaned — a fail-toward-hold / no-new-corruption-vector violation, **not** the acceptable residual it had been documented as. **Addressed**: `isGhostCursorCell` now requires **positive ghost evidence** (≥1 dim, non-whitespace/non-chrome tail cell); an empty / whitespace-only tail stays `busy`. The real ghost is unaffected (its dim command body is 23 cells). Added the empty-tail regression test → render-gate suite **40/40**, all fixtures unchanged, real ghost still CLEAN. Architect confirmed the prior build was already local-installed and **E2E-proven** (held row `a21b6c64` delivered 1.6 s post-restart). Re-parked at the pr gate (no self-approve, no merge).

### Architect Round-2 (2026-08-06) — capped-ring tear → persistent bounded headless screen

Integration review round 2 (Codex re-consult) surfaced a **merge-blocker the round-1 whole-ring rewrite reintroduced one layer down**, confirmed by architect repro. The branch carries `[PIR #1205]`'s cap on the RingBuffer's newline-free `partial` (2 MiB; `trimPartial` halves to ~1 MiB). The gate re-rendered `ringBuffer.getAll().join('\n')` each check — but a claude/codex alt-screen frame is one giant newline-free partial, so once a busy long-lived agent's frame crossed the cap the ring handed the gate a **torn front** → `no-composer-marker`/`no-region-end` → mail held **permanently**. The over-ceiling outage, resurrected for exactly the busiest agents. The prior big-capture tests masked it by feeding `classifyScreen` the raw capture directly, bypassing the ring's cap.

- **Fix (architect-preferred, Option a): persistent bounded headless screen per session.** Each session mirrors its output into one long-lived `@xterm/headless` Terminal (`SessionScreen`, terminal layer), fed incrementally at `PtySession`'s output chokepoint; the gate reads that mirror's bounded viewport. The cap is now irrelevant (the mirror needs the live byte stream, not the whole ring), the live-ring tear is gone, each classify is O(viewport) not O(ring size), and the whole-render era's #1047 unbounded-`partial` OOM residual is **closed**. Four required changes landed: (1) persistent screen; (2) production-path regression tests (both real >2 MiB captures pushed through a real `RingBuffer` AND a real `SessionScreen` in 64 KiB chunks → ring path BUSY/torn, mirror path CLEAN); (3) monotone `ringToken` via a new cumulative `RingBuffer.bytesWritten` (the old `currentSeq:partialBytes` fell on a trim and could alias a stale verdict); (4) stale-doc fixes (render-gate header + arch.md §7).
- **3-way CMAP on the round-2 diff.** Gemini **APPROVE/HIGH**, Claude **APPROVE/HIGH**, Codex **REQUEST_CHANGES/HIGH**. Codex's blocker (= Claude's non-blocking obs-c, the same finding): the adopt/reconnect path (`tower-terminals.ts:775`/`:1034`) caps the replay seed to 1 MiB via `capRingSeed` before `attachShellper`, so an adopted long-lived alt-screen session's mirror can be **born torn**, and an idle unattended agent has no repaint nudge → false-`busy` forever, via a different door.
- **Adjudication (code-verified) + architect decision.** `attachShellper` seeds the mirror the **identical capped bytes** the ring already got pre-round-2 (`pushData(replay)` is pre-existing; `feedGateScreen(replay)` mirrors it), so the adopt-path tear is **pre-existing, not a round-2 regression**, and fails safe (holds, never misdelivers). The HIGH/HIGH split (Codex blocking vs Claude non-blocking-with-caveat) on a design-choice fix the architect had pre-flagged was **escalated**, not self-resolved. The architect independently verified in-code and chose **Option A: ship round-2 now, defer the adopt-path residual** as a fast-follow (**#1361**, proposing the uncapped-≤8 MiB mirror seed; a repaint-nudge is the total-guarantee alt). Round-2 is a strict (Pareto) improvement — it fixes the confirmed live-ring tear and worsens nothing.
- **Three hygiene items folded in before re-park (per architect, apply regardless of A/B):** (1) **docs** — qualified the "from birth"/"tear is gone" overclaims across `session-screen.ts`, `render-gate.ts`, `pty-session.ts` (`feedGateScreen`), and arch.md §7 (live path mirrored from first byte + live-ring tear gone; adopt/reconnect seed is 1 MiB-capped → can be born torn → fail-safe HOLD, self-heals on repaint/viewer; ref #1361); (2) **test** — an adopt-path regression (`pty-session-attach.test.ts`) driving a >1 MiB replay through the real `capRingSeed`→`attachShellper` and asserting the fail-safe HOLD (busy) for both real captures, pinning the behavior against a future false-CLEAN; (3) **hardening** — Claude's one-liner: `SessionScreen.dispose()` settles `pending` and `read()` early-returns when disposed, closing a theoretical drainer wedge if a screen is disposed mid-read. Also corrected Claude's obs-a (the `read()` TOCTOU comment now says the buffer reflects **at least** `bytesWritten`'s output, never less).
- **Verified green:** production build exit 0; full unit suite **4551 pass / 48 skip / 0 fail** (the +2 over the pre-hygiene 4549 is the new adopt-path regression); `send-integration.e2e` **7/7**. Re-parked at the pr gate (no self-approve, no merge, status.yaml untouched).

### Maintainer Round (2026-08-07) — durable `--delay`, delayed-interrupt reshape, reachable starvation alarm

The maintainer (waleedkadous) reviewed PR #1330 and asked for **three changes before merge** plus four take-or-file follow-ups; the architect independently verified every claim against head `e8070fb6` (all real) and the human adjudicated the one open design question. The `pr` gate's prior approval (2026-08-06) was treated as **withdrawn** — superseded by the review — and porch's advance to `verify` was ignored as ahead-of-reality. Work order: `codev/projects/1313-…/1313-maintainer-review-directive.md` (committed alongside the changes).

**Change 1 — `--delay` is now durable (persist `not_before`).** *Verified defect:* `deliverAfter` was honored only on the live-writable path; all three hold paths (registry / dead / unwritable) enqueued the row delay-less, and the CLI never told the sender the delay was discarded — a regression the mailbox re-homing introduced over the old #1335 timer. *Decision (human-adjudicated):* add a nullable `not_before INTEGER` to the mailbox table (base `CREATE TABLE` for fresh installs **and** migration **v17**, PRAGMA-gated `ADD COLUMN` mirroring v16 — v15 is never edited in place). **Every** delayed send now persists its row at REQUEST time with `not_before = now + delay*1000` (resolution / authz / formatting stay at request time, preserving the documented security property). Drain eligibility is `status='held' AND (not_before IS NULL OR not_before <= now)`, delivering the oldest **eligible** row so a pre-due row never blocks later due mail; escalation age is `max(created_at, not_before)` so a pre-due row never escalates.
  - **Explicit decision — conscious reversal of Spec 1307's drop-on-restart semantics.** Spec 1307 deliberately kept a pre-due delayed send OUT of the durable mailbox (an in-memory timer only) on the rationale that a delayed message's *timing* was chosen against a world a restart has already invalidated, so delivering it late could be worse than dropping it (`delayed-send.ts:17-28`). This round **reverses that for the message body**, approved by architect + maintainer. Justification: the render gate — which did not exist when 1307 was written — now supplies the protection that rationale actually wanted. A post-restart delivery still only lands on a render-verified **empty** prompt (never fused with a draft, never mid-turn), and a stale pending row is now **visible and cancellable** via `afx inbox` / `afx inbox dismiss`. Durability-behind-a-gate strictly dominates silent-drop. The in-memory registry is retired for the body; only the ^C nudge (change 2) remains in memory. Response/CLI now returns `mailboxId` + `notBefore`; both "dropped if Tower restarts" messages were removed; the `--delay` docs were re-trued in **both** trees.

**Change 2 — delayed-interrupt seam closed by a reshape (preferred shape taken).** *Verified defect:* the old due-callback checked `isStillLive()` at timer time only, ran `markMailboxDelivered` **before** the write, never re-checked inside the lock, and wrote via `writeMessageToSession` (no #1198 drop detection) — a dead-socket drop was completely silent. *Decision:* take the directive's **preferred reshape**, not the fallback. On the delayed-`--interrupt` path the body is already a durable `not_before` row (change 1); the in-memory timer now fires **only the Ctrl+C** at due time, re-checking `isStillLive()` + re-fetching the session + `writable` **inside** the submission lock before writing the ^C, and calls `markMailboxDelivered` **nowhere**. The body then delivers through the normal gated drainer after the ^C ends the turn, inheriting the drainer's written-boolean gating, re-hold-on-drop, and no-double-delivery. *Behavioral delta (documented):* the delayed message now lands via the gate **after** the ^C rather than atomically with it; if the post-^C screen isn't clean it holds (and escalates per change 3) instead of force-injecting — strictly more aligned with the no-force principle. A restart during the wait loses only the ^C nudge, never the message (matches the pre-existing "only the interrupt semantics gracefully degrade" boundary). The **immediate** `--interrupt` path keeps its documented claim-first tradeoff, unchanged. **Invariant 2 has no exception under this shape** — the fallback would have introduced one, and was avoided.

**Change 3 — a reachable alarm for residue starvation (both pieces).** *Verified gap:* one stray visible char classifies `busy` → all an autonomous builder's mail (incl. cron nudges, which ride the same mailbox) holds; escalation was SSE-only + Tower log, and `afx status` had zero mailbox awareness, so headless flows starved silently. *Fix:* (a) `afx status` now surfaces per-builder `heldCount` + escalated state + a workspace total (reusing the overview payload, not re-deriving) with a remedy hint when escalated; (b) a held row addressed to a **non-architect** agent past a held-age threshold (a multiple of `escalationMs`) enqueues ONE coalesced (supersede-keyed) gate-delivered mailbox notice to its `spawnedByArchitect` (fallback main→first architect, mirroring `afx send architect`), with cron-style guards — no notice-about-notice, superseded/cleared when the agent's held set drains. Alarms stay **visibility-only** (invariant 4); `busy` streaks remain excluded from liveness telemetry.

**Take-now follow-ups (same pass):** (B) `afx cleanup` now transitions a removed agent's held rows to `dismissed` (audit-preserving) so they stop pinning `heldCount`/escalated forever; (C) docs — both `agent-farm.md` trees re-trued (`--delay` Not-persisted→durable, Ordering re-trued to eligibility semantics, the stale "typing-aware send buffer" phrase dropped); (D) hot-tier swap — restored the Spec 987 tier-routing meta-rule to `arch-critical.md` and displaced the `git add -A` line (still enforced by the CLAUDE.md/AGENTS.md Git Workflow banner every session and surviving in cold `arch.md`), net hot-fact count unchanged. Plus two doc over-claim rewords: `mailbox-delivery.ts`'s "exactly one place a body is written" header (scoped to gated deliveries + the named interrupt/escape exceptions) and arch.md §mailbox item 5 (**per-PTY → per-agent** serializer keyed by `agentKey`; the interrupt/escape per-terminal lock is disjoint, so a gated delivery *can* interleave with an interrupt — the accepted `session-submit.ts` boundary — plus the oldest-**eligible** drain qualifier).

**Filed, not in this PR (#1365):** serializer convergence — route the mailbox write edge through `submitToSession` so gated deliveries serialize against interrupt/escape (in-code pointers `tower-routes.ts:1881-1886`, `session-submit.ts:44-68`; no lock-cycle hazard, as the per-terminal lock would be a leaf taken inside the per-agent serializer).

**Pre-commit adversarial review pass (this session).** Before committing the inherited round, an independent full-diff faithfulness + invariant review was run (all five invariants held; all changes faithful; suite + typecheck green). It surfaced **two LOW-severity issues, both fixed**:
- **Held count included pre-due rows.** `heldSummaryForWorkspace` (the shared `overview.heldCount` source feeding `afx status` **and** the dashboard/VSCode badge) had no `not_before` filter, so a scheduled (pre-due) `--delay` counted as stuck "held" mail — inconsistent with every other round-3 surface (`findHeldForAgent`, `findEscalatable`, `findStarvingAgents`, and `afx inbox`'s "scheduled" label) and with the round's own "scheduled, not stuck" principle. Added the `not_before IS NULL OR not_before <= now` eligibility filter (the `escalated` bit was already pre-due-safe). **Note the deliberate blast radius:** this also makes the dashboard/VSCode held badge count deliverable-but-stuck mail only — the correct attention semantics, but a surface the maintainer's directive did not explicitly name; flagged to the architect for the re-review. Pre-due rows remain fully visible/cancellable in `afx inbox`.
- **Delayed-`--interrupt` re-checked writability outside the lock.** The ^C path re-fetched the session + checked `writable` *before* `submitToSession` and passed the captured reference in, re-checking only `isStillLive()` inside. Moved the session re-fetch + `writable` check **inside** the lock (the directive's literal preferred shape), so a session death/respawn during the lock-wait fires no stray ^C. Invariant 2 held either way (no body, nothing marked delivered); this closes the literal deviation and the stray-^C-to-stale-session window.

**Verified green:** production build exit 0; full unit suite **4586 pass / 48 skip / 0 fail** (+35 over the round-2 4551 — the round-3 durable-delay / interrupt-reshape / starvation-alarm / cleanup-dismiss tests, the migration-meta v17 bump, and the pre-commit pre-due-count regression test); `send-integration.e2e` **7/7**. Re-parked at the `pr` gate (no self-approve, no merge, status.yaml untouched). The `pr` gate stays held pending architect + maintainer re-review.

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
- **Routed: COLD** (`arch.md` §7, 2026-08-06 architect live-test round) — added the classifier's **ghost-cursor exemption** to the "zero normal-intensity cells" clause: the render gate exempts claude's suggested-command ghost cursor cell (inverse + non-dim, at the headless cursor, with a dim/empty tail — `isGhostCursorCell`), so an idle composer showing a ghost classifies CLEAN and delivers instead of holding `busy` forever. One sentence; the full mechanism + safety reasoning lives in `render-gate.ts`. **No HOT change** — the mailbox-first invariant is unchanged; this is a classifier reference detail.
- **Routed: COLD (`arch.md` §7, 2026-08-06 round-2 capped-ring-tear fix).** Superseded the whole-ring §7 description: point 2 now documents the persistent bounded `SessionScreen` mirror (fed at `PtySession`'s output chokepoint; live path mirrored from birth → live-ring tear gone; classify O(viewport); the monotone `RingBuffer.bytesWritten` change-token; `bigRing`/backoff machinery retired; #1047 whole-render OOM residual **closed**), with an explicit caveat that the adopt/reconnect seed is `capRingSeed`-capped (1 MiB), so a long-lived alt-screen frame can be born torn → fail-safe HOLD, self-heals on repaint/viewer (deferred #1361). **No HOT change** — the mailbox-first invariant is unchanged.
- **Routed: HOT + COLD (2026-08-07 maintainer round).** *HOT* (`arch-critical.md`): **restored** the Spec 987 tier-routing meta-rule ("Governance docs are two-tier … route new facts/lessons by tier; never grow a hot file past its cap") and **displaced** the `git add -A` line to make room (net 10 facts, cap held) — the git-staging rule survives in the always-injected CLAUDE.md/AGENTS.md Git Workflow banner and in cold `arch.md`, so nothing is lost. *COLD* (`arch.md` §mailbox item 5): corrected two over-claims — the write serializer is keyed **per-agent** (`agentKey`), not per-PTY, and the `escape`/`interrupt` per-terminal submission lock is **disjoint**, so a gated delivery can interleave with an interrupt (the accepted `session-submit.ts` boundary) — and added the oldest-**eligible** drain qualifier (pre-due `not_before` rows excluded). **No new HOT fact for durable `--delay`** — it is a refinement of the incumbent mailbox-first fact, not a new invariant; kept cold at the cap.
- These `codev/resources/` governance files are user-evolved (not framework files), so **no `codev-skeleton/` mirror is required** (CLAUDE.md/AGENTS.md pull the hot files via `@`-import, so they reflect the hot edit automatically and stay byte-identical).

## Lessons Learned Updates

- **Routed: COLD** (`lessons-learned.md`) — Process: "Trace a contract change end-to-end before calling it specified" (the `delivered`/`held` client-surfacing gap). Testing: "When a spec names a specific repro, the automated e2e must exercise *that* scenario." **This session** added a third: "Validate a screen/output classifier against REAL captured terminal output across real app states, not synthesized fixtures" — the single most expensive lesson of the project (it forced the rollback).
- **No HOT (`lessons-critical.md`) change** — the incumbent hot lessons ("'tests pass' is not 'it works' — verify the real user path end-to-end" and "when guessing fails, build a minimal repro — captured raw data beats speculation") already dominate; the new render-gate lesson is a spec-narrow refinement of them and belongs in the cold archive. Bias toward KEEP at the cap.

## Technical Debt

- **`spec-1280` T16 guard — cross-project conflict RESOLVED** (Review round 3 → architect change round, 2026-08-05). Issue #1280 is OPEN (phase_0 instrument in progress; phases 1–10 pending; phase_1 edits CLAUDE/AGENTS), so T16 is a **live** Phase-0 guard — the guard itself was restored to `main` exactly (`git checkout main -- …`, reverting both this session's deletion and the earlier `isProject1280` scoping) and never scoped/skipped/deleted. The conflict — T16 flagged 1313's CLAUDE.md/AGENTS.md edits for absence from a 1280 manifest — was **resolved by removing 1313's edits to those files**: the 9-line "Send outcomes" section was reverted to `origin/main`'s tip (both files byte-identical to `origin/main` and to each other), so 1313 makes **no net change** to those files. **T16 passes in the rebased/merged state.** Verified timing caveat: on the *un-rebased* branch (285 behind), T16's three-dot `origin/main...HEAD` diff compares HEAD against the stale merge-base `3f622fe6`, which predates `main`'s own newer edit to these two files — so T16 still lists them and stays red until the branch is rebased/merged onto current `origin/main` (the rebase already needed to clear the CONFLICTING PR). Forcing it green now via the merge-base version would revert `main`'s newer build-doc text — a regression — so matching `origin/main`'s tip is the correct fix. The send-outcomes docs live on in the `afx` reference (`agent-farm.md`) + skeleton mirror + `arch-critical.md`; Spec 1280 retains sole ownership of CLAUDE.md/AGENTS.md.
- **Ghost-cursor exemption — the 1-char-draft false-clean was CLOSED (Codex CMAP, 2026-08-06), not accepted; a deferred liveness diagnostic remains.** The first cut exempted the cursor cell on a dim-**or-empty** tail, which false-cleaned a 1-char draft with the cursor on its only char (an inverse cell with an empty tail). Codex's CMAP correctly called this a **spec violation** (no-new-corruption-vector / fail-toward-hold), not an acceptable residual — architect-verified and agreed. **Fixed**: `isGhostCursorCell` now requires **positive ghost evidence** — ≥1 dim, non-whitespace/non-chrome tail cell — so an empty / whitespace-only tail stays `busy`; the real ghost is unaffected (its dim command body is 23 cells). Regression test added (inverse non-dim cursor, empty tail → `busy/user-text`). Separately, the finding's optional hardening — flag a sustained `user-text` hold whose counted-cell set is exactly {the cursor cell} as chrome in the classifier-stuck liveness net — is **deferred**: the exemption stops this drift class from producing a hold at all, so it no longer manifests; the net-level diagnostic would be belt-and-suspenders.
- **Silent-loss fix — benign partial-write residual.** If the text lands but the Enter is dropped mid-pace, the row is held `no-live-pty` while a draft sits in the composer. This never loses or double-delivers a message: a dead session is torn down and the agent-addressed row drains to its respawn; a recovered session shows a draft, so the render gate holds until the next clean prompt and delivers then. Recorded for completeness — no action needed.
- **Architect-identity SSOT is fail-closed, not fully authoritative**: the durable fix persists `command` on the session row + a legacy self-heal; a WELCOME-frame hydration (the fully-authoritative source) was deferred (needs a protocol change).
- **Migration tests use a faithful replica** of the production migration block, not the private `ensureGlobalDatabase` runner (repo precedent; source guards pin the real statements). Filed: extract `runGlobalMigrations(db)` for real migration tests.
- **`#1047` unbounded `partial` — CLOSED by round-2 (2026-08-06).** The whole-ring render that accepted an OOM residual on a pathological runaway is gone: the persistent bounded `SessionScreen` mirror classifies an O(viewport) screen and never allocates a whole-ring string, so the multi-hundred-MB-string OOM path no longer exists. (The "persistent xterm" this note deferred is exactly what round-2 built.)
- **agy `AGY_MARKER` (`/^> /`) is loose** and the interrupt-vs-mailbox-delivery cross-path is not fully serialized (architect-ratified as an accepted boundary; the convergence cleanup — route the mailbox write through `submitToSession` — is **filed as #1365**, out of scope for this PR).

## Flaky Tests

- **`render-gate.test.ts` perf assertion** — the seed-cap/whole-ring render-budget assertion flaked on loaded CI runners (best-of-5 125–142ms vs a 75ms local ceiling). Per architect direction, mitigated with a **CI-aware bound** (`process.env.CI ? 800 : 250` ms; earlier 500 for the seed-cap era) rather than a blanket skip, so the tight local steady-state signal survives while CI asserts only a catastrophic-regression ceiling. Documented; a deterministic op-count check is the intended replacement (Follow-up).
- **Whole-suite environmental flakiness** (not a single test): a `getcwd: cannot access parent directories` signature from a parallel-vitest-worker + git-subprocess temp-dir race (aggravated by 9+ concurrent sibling builders), and a build-race when `npm run build` (which `rm -rf`s `dist/`/`skeleton`) runs *concurrently* with vitest. Handled by not running the build concurrently with the suite and by retry; a direct suite run was always clean (0 failures). No individual test was skipped (none reproduced in isolation).
- **`session-manager.test.ts` auto-restart timing test** starved under full-suite parallelism (passed in isolation, ~472ms). No skip needed — it did not repeat.

## Follow-up Items

- ~~Resolve the T16-vs-1313 prompt-surface-manifest conflict with the 1280 owner (waleedkadous)~~ **DONE (2026-08-05):** resolved by reverting 1313's CLAUDE.md/AGENTS.md edits to `origin/main`'s tip — 1313 makes no net change to those prompt surfaces; Spec 1280 retains sole ownership of those files. T16 passes in the rebased/merged state (stays red on the un-rebased branch, which is 285 behind — its three-dot diff compares against the stale merge-base; clears with the maintainer rebase already needed for the CONFLICTING PR).
- Replace the render-gate perf wall-clock assertion with a deterministic op-count check.
- **#1361 (round-2 fast-follow):** close the adopt/reconnect torn-seed liveness gap — seed the gate mirror from the uncapped ≤8 MiB replay while the ring stays 1 MiB-capped (token-safe constant offset), or a repaint nudge on adopt for a total guarantee. Pre-existing + fail-safe today (holds, self-heals on repaint/viewer); tracked separately so round-2 stays scoped.
- Bound the VSCode escalation-toast `seen` Set (dedupe by mailboxId with eviction) — negligible today.
- Fuller close of the gate→write **input** race (a human keystroke between snapshot and write — `R7` staleness guard) and the input-echo-lag residual.
- Tighten `AGY_MARKER`; consider WELCOME-frame identity hydration; `#1047` persistent-xterm root cause.
- Extract `runGlobalMigrations(db)` so migration tests can drive the real production runner.
