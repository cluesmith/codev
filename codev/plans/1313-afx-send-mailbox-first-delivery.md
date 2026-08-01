# Plan: afx send — Mailbox-First Delivery (Never Force-Inject)

## Metadata
- **ID**: 1313
- **Status**: draft
- **Specification**: [codev/specs/1313-afx-send-mailbox-first-delivery.md](../specs/1313-afx-send-mailbox-first-delivery.md)
- **Created**: 2026-08-01

## Executive Summary

Implements the spec's chosen approach — **mailbox persistence + rendered-empty gate + write serialization** —
by construction: a message is persisted before the send returns, and its body is only ever written to a prompt
a headless-terminal replay proves is empty. There is no force path.

The work is decomposed so the **safety-critical core lands and is provably correct early**, and the
higher-surface-area pieces (cron, CLI, UI, docs) layer on afterward:

1. **Mailbox store** (durable rows) — kills silent loss; no send-behavior change yet.
2. **Gate** (headless replay + claude/codex profiles) — the sole delivery authority; pure + fixture-tested.
3. **agy profile** (net-new measurement, **blocking**) — front-loaded to surface schedule risk.
4. **Delivery orchestration** — rewire `handleSend`: persist → serialize → gate → deliver/hold; retire
   `SendBuffer` and every force path; response vocabulary `delivered | held+id+reason`.
5. **Fast delivery triggers** — submit + quiescence, so held mail delivers near-immediately once the human clears the line.
6. **Cron rerouting** — the most-unguarded writer joins the one gated path; per-task supersede.
7. **`afx inbox` + broadcasts + escalation** — visibility backend (CLI + API + WS events + escalation age).
8. **Dashboard + VSCode indicators** — count-only held indicators consuming the broadcasts.
9. **Docs + skeleton mirror** — send vocabulary, `afx inbox`, CLAUDE/AGENTS (byte-identical), skeleton.

The corruption-elimination invariant is fully in force at the end of Phase 4; Phases 5–9 add latency polish,
parity, visibility, and documentation. Nothing after Phase 4 can reintroduce a force path — there is none to
reintroduce.

## Success Metrics
Inherited from the spec's Success Criteria (all must hold at project completion):
- [ ] The #1265 repro is dead (draft/menu held; delivers cleanly after the line clears).
- [ ] Idle delivery unchanged in feel (gate adds ≤ ~50ms).
- [ ] No loss across Tower crash/shutdown; no shutdown force-flush.
- [ ] Wrapper screens (relaunch / crash-restart) don't eat messages.
- [ ] Concurrent sends serialize (N in → N cleanly separated, in order).
- [ ] Cron parity (busy → held, superseded by next run, real outcomes logged).
- [ ] Escalation is visible (`afx inbox` + indicator attention state; no log-reading needed).
- [ ] Held reasons distinguishable (`busy` / `no-profile` / `no-live-pty`).
- [ ] **agy is a working target (blocking)** — trust dialog held; delivers when clean.
- [ ] `--interrupt` / `noEnter` behave as documented; unknown-app targets hold visibly.
- [ ] Unit tests: mailbox lifecycle + gate classification vs captured fixtures (claude/codex/agy); e2e: the repro.
- [ ] Docs updated (afx reference, CLAUDE/AGENTS + skeleton mirrors).
- [ ] No test-coverage reduction; build/lint/typecheck green.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Mailbox persistence layer"},
    {"id": "phase_2", "title": "Rendered-empty gate + claude/codex profiles"},
    {"id": "phase_3", "title": "agy classifier profile (blocking measurement)"},
    {"id": "phase_4", "title": "Delivery orchestration + write serialization"},
    {"id": "phase_5", "title": "Fast delivery triggers (submit + quiescence)"},
    {"id": "phase_6", "title": "Cron rerouting through mailbox + gate"},
    {"id": "phase_7", "title": "afx inbox CLI + broadcasts + escalation"},
    {"id": "phase_8", "title": "Dashboard + VSCode held-count indicators"},
    {"id": "phase_9", "title": "Documentation + skeleton mirror"}
  ]
}
```

## Phase Breakdown

### Phase 1: Mailbox persistence layer
**Dependencies**: None

#### Objectives
- Give every `afx send` a durable home so nothing is lost to a Tower crash, restart, or shutdown.
- Establish the row model + lifecycle transitions (held → delivered | superseded | dismissed) as pure,
  unit-testable data operations, decoupled from delivery — so Phase 4 wires against a proven store.

#### Deliverables
- [ ] `mailbox` table added to `GLOBAL_SCHEMA` (`packages/codev/src/agent-farm/db/schema.ts`).
- [ ] Migration **v15** in `packages/codev/src/agent-farm/db/index.ts` (`CREATE TABLE IF NOT EXISTS mailbox …`;
      bump `GLOBAL_CURRENT_VERSION` 14 → 15; insert `_migrations` row).
- [ ] `packages/codev/src/agent-farm/db/mailbox.ts` — repository: `enqueue`, `listHeld(workspacePath?)`,
      `findHeldForAgent(workspacePath, agent)`, `markDelivered(id)`, `supersede(workspacePath, supersedeKey, newRow)`,
      `dismiss(id)`, `pruneTerminal(retentionDays)`, `getById(id)`.
- [ ] Row types in `packages/codev/src/agent-farm/db/types.ts`.
- [ ] Unit tests: `packages/codev/src/agent-farm/__tests__/mailbox.test.ts`.

#### Implementation Details
Row shape (additive table; addresses **agents, not PTYs** per Baked Decision 4):
```
mailbox(
  id TEXT PRIMARY KEY,                 -- uuid
  workspace_path TEXT NOT NULL,        -- addressing scope
  to_agent TEXT NOT NULL,              -- recipient agent identity (drains across respawn)
  terminal_id TEXT,                    -- last-known PTY hint (nullable; not the identity)
  from_agent TEXT, from_workspace TEXT,
  body TEXT NOT NULL,                  -- raw message (never logged)
  formatted_message TEXT NOT NULL,     -- what gets written to the PTY
  no_enter INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'held'
    CHECK(status IN ('held','delivered','superseded','dismissed')),
  reason TEXT CHECK(reason IN ('busy','no-profile','no-live-pty')),  -- why-held; null once delivered
  supersede_key TEXT,                  -- cron-only (Baked Decision 6); null for direct sends
  escalated INTEGER NOT NULL DEFAULT 0,-- set once escalation age crossed (visibility only)
  created_at INTEGER NOT NULL,         -- epoch ms (enqueue order per agent)
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER                  -- delivered/superseded/dismissed timestamp
)
```
Indexes: `(workspace_path, status)` for held listing; `(workspace_path, to_agent, status)` for per-agent drain;
`(supersede_key)` for cron supersede. `enqueue` order per agent = `created_at ASC` (Baked Decision 5).
Mirror `cron_tasks`' workspace-scoping style. **New table only** → fresh installs get it from `GLOBAL_SCHEMA`;
existing installs get it from migration v15. No rows to migrate (the old buffer was in-memory).

Timestamps are epoch-ms integers set by the repository (`Date.now()` at the call site), not SQLite `datetime`,
so ordering and age math are trivial and test-injectable.

#### Acceptance Criteria
- [ ] Fresh DB and a simulated pre-v15 DB both converge on the `mailbox` table (migration test, mirrors
      `pir-832-migration.test.ts`).
- [ ] Lifecycle transitions enforce the state machine (no delivered→held; supersede only replaces a *held* row).
- [ ] `pruneTerminal` removes only terminal rows older than the window; never a held row.
- [ ] All existing DB tests still pass; no coverage reduction.

#### Test Plan
- **Unit**: enqueue/list/deliver/supersede/dismiss/prune; per-agent enqueue ordering; restart recovery
  (reopen DB → held rows present); supersede replaces held, not delivered.
- **Integration**: migration v14→v15 on a seeded legacy DB.
- **Manual**: none.

#### Rollback Strategy
Revert the phase commit. The table is additive and unread by any live path until Phase 4, so reverting is inert
(a created table on already-migrated dev DBs is harmless and ignored).

#### Risks
- **Risk**: schema churn complicates upgrades. **Mitigation**: additive new table + migration-on-boot (the
  established pattern); no existing-column changes.

---

### Phase 2: Rendered-empty gate + claude/codex profiles
**Dependencies**: None (parallelizable with Phase 1; ordered second for review focus)

#### Objectives
- Build the single authority that answers "is this screen a clean, empty prompt?" by replaying the existing
  output ring buffer through a headless terminal — the same reconstruction the dashboard reconnect uses.
- Ship verified classifier profiles for the two apps the spike already measured (claude, codex).

#### Deliverables
- [ ] `@xterm/headless` added to `packages/codev/package.json` dependencies (promote from spike-only).
- [ ] `packages/codev/src/agent-farm/servers/render-gate.ts` — `classifyScreen(snapshot, profile): {clean: boolean; reason?: 'busy'}`;
      replays a seed-capped ring snapshot through `@xterm/headless`, reads the composer region, applies the profile.
- [ ] `packages/codev/src/agent-farm/servers/gate-profiles.ts` — profile registry + `resolveProfile(session)`
      (maps a session to claude/codex/`null` via its command/args/label); claude + codex profiles
      (marker regex, composer region, text-intensity/dim-placeholder rule) from spike facts.
- [ ] Screen fixtures under `packages/codev/src/agent-farm/__tests__/fixtures/gate/` (claude + codex: idle,
      draft, menu, picker, wrapper/boot).
- [ ] Unit tests: `packages/codev/src/agent-farm/__tests__/render-gate.test.ts`.

#### Implementation Details
The gate consumes a **seed-capped** ring snapshot (Performance Requirements: bounded by the ring seed cap, not
raw ring size) obtained from `PtySession.ringBuffer` (`getAll()` / a capped variant). It writes that byte stream
into a `@xterm/headless` `Terminal` sized to the session's cols/rows, then inspects the buffer:
- **marker present** (app prompt marker in the expected region) **AND**
- **composer region carries zero normal-intensity text** (dim placeholder is OK) → `clean`.
- else → `{clean:false, reason:'busy'}`.

`resolveProfile(session)` returns the app profile or `null` (unknown app). The gate never authorizes on
input-idleness; a wrong scheduling trigger only costs a failed check (message stays held — the safe direction).
Classifier design and per-app constants are lifted from spike 1265 (fetched branch `spike-1265`; see Dependencies).

**App detection** is an explicit sub-task: derive app identity from the session's launch command/args/label.
If detection is ambiguous, treat as unknown (`no-profile`) — fail-safe.

#### Acceptance Criteria
- [ ] claude + codex fixtures classify correctly across idle/draft/menu/picker/wrapper/boot.
- [ ] Idle (clean) fixtures → `clean:true`; every non-idle fixture → `clean:false, reason:'busy'`.
- [ ] A single classification stays within the spec's ≤ ~50ms bound at the seed cap (assert an upper bound;
      measured 2ms @ 13KB / 22ms @ 1MB cap in the spike).
- [ ] Unknown app (no profile) → caller-visible "no profile" outcome (not a false clean).

#### Test Plan
- **Unit**: classify each fixture; boundary cases (empty screen, dim placeholder present, marker absent).
- **Performance**: assert classification time under the bound on the largest (cap-sized) fixture.
- **Manual**: none (fixtures are captured byte streams).

#### Rollback Strategy
Revert the phase commit; `render-gate.ts`/`gate-profiles.ts` are unreferenced by any live path until Phase 4.
Removing the `@xterm/headless` dep is a `package.json` revert.

#### Risks
- **Risk**: classifier false-clean on an unmodeled screen → misdelivery. **Mitigation**: conservative rule
  (marker AND empty region); unknown states default not-clean.
- **Risk**: app detection misidentifies the app. **Mitigation**: unknown → `no-profile` (held), never a guessed profile.

---

### Phase 3: agy classifier profile (blocking measurement)
**Dependencies**: Phase 2

#### Objectives
- Derive agy's classifier rule empirically (net-new; the spike observed agy's `> ` marker + normal-intensity
  hint text break the claude/codex dim-placeholder assumption) and make agy a working, fail-safe target.
- Satisfy the **blocking** agy success criterion (Baked Decision 12).

#### Deliverables
- [ ] agy profile added to `gate-profiles.ts` (its own marker + composer-region + intensity rule).
- [ ] agy fixtures under `…/fixtures/gate/` (trust dialog = canonical born-dirty; idle; draft).
- [ ] Tests extending `render-gate.test.ts` for agy.
- [ ] Short measurement note appended to the review (how the agy rule was derived, via the spike harness).

#### Implementation Details
Front-loaded per the spec risk table. Use the spike POC harness (branch `spike-1265`, `codev/spikes/1265-poc/`)
to capture agy screen states and derive the rule. The **trust dialog must classify not-clean** (a blind Enter
there would confirm a filesystem-trust decision). agy stays fail-safe at runtime regardless: any screen that
doesn't classify clean → held + visible.

#### Acceptance Criteria
- [ ] agy trust dialog → not-clean (never Enter-confirmed).
- [ ] agy idle prompt → clean; agy draft → not-clean.
- [ ] agy profile does not regress claude/codex fixtures (shared registry stays isolated per app).

#### Test Plan
- **Unit**: agy fixtures (trust/idle/draft).
- **Manual**: one live agy smoke (fresh agy terminal → trust dialog held) if an authenticated agy is available;
  otherwise fixtures + note. Documented in the review.

#### Rollback Strategy
Revert the phase commit; agy simply reverts to unknown/no-profile handling (still fail-safe).

#### Risks
- **Risk**: agy measurement is net-new; no spike-verified rule. **Mitigation**: this is why it's its own early
  phase — surfaces schedule risk before the delivery wiring depends on it; runtime stays fail-safe meanwhile.

---

### Phase 4: Delivery orchestration + write serialization
**Dependencies**: Phase 1, Phase 2 (Phase 3 recommended-precedes so agy is real when delivery ships; not a
hard code dependency — delivery treats a missing profile as `no-profile`)

#### Objectives
- Rewire the send path so corruption is eliminated by construction: **persist → serialize → gate → deliver or
  hold**. Retire `SendBuffer` and every force path. This is the phase that makes the whole feature correct.

#### Deliverables
- [ ] `handleSend` rewrite in `packages/codev/src/agent-farm/servers/tower-routes.ts`: persist the row (before
      the response), then attempt delivery through the gate; return `delivered` or `held`+id+reason.
- [ ] Per-session **write serialization** (FIFO, completion-chained) — `packages/codev/src/agent-farm/servers/message-write.ts`
      (extend) or a sibling `write-queue.ts`; a message's text and its Enter are one unit.
- [ ] Delivery driver + **poll backstop** replacing `SendBuffer`'s timer: `startSendBuffer`/`stopSendBuffer`
      call sites in `tower-server.ts` (587 / 185) become the mailbox drainer's lifecycle; **delete**
      `send-buffer.ts` and its test (behavior migrated).
- [ ] Delivery moments in this phase: **enqueue-time** check + **poll backstop** (a periodic held-row drain that
      runs the gate). (Submit/quiescence triggers are Phase 5.)
- [ ] Additive response fields on `POST /api/send` (`held`, `mailboxId`, `reason`) preserving `ok`/`terminalId`/
      `deferred` for old binaries (`held` ⇒ still `ok:true`).
- [ ] Dead-session → held (`no-live-pty`), unknown-app → held (`no-profile`) — the WARN/ERROR drop paths removed.
- [ ] Tests: `packages/codev/src/agent-farm/__tests__/send-delivery.test.ts` (+ update send-buffer callers).

#### Implementation Details
- **Persist-first**: enqueue the mailbox row before writing the HTTP response; the response reports the real
  first outcome (an idle clean prompt delivers at enqueue-time → `delivered`; otherwise `held`+reason).
- **Gate before every automated write** (Baked Decision 3). The sole bypass is `--interrupt`, unchanged
  (`session.write('\x03')` then write without a gate check). `escape` path unchanged.
- **Serialization**: writes to one live PTY chain on completion (reuse the paced-write completion time already
  returned by `writeMessageToSession`). Held rows drain in `created_at` order per agent.
- **Retire force paths**: no `flush(true)` on shutdown; no max-age force. Shutdown just stops the drainer;
  held rows persist in SQLite.
- **Respawn drain**: rows address the agent, so a new terminal for the same agent drains predecessor mail on
  its first clean gate pass.
- `noEnter`: gate-checked staging (writes text, no Enter) → reports `delivered` (the write completed).

#### Acceptance Criteria
- [ ] #1265 repro: draft in target, send → held (`busy`), draft untouched; after the line clears + backstop
      poll, delivers cleanly.
- [ ] Idle empty prompt → immediate `delivered`, correct rendering.
- [ ] Menu/picker/trust-dialog/wrapper → held; delivers after clean.
- [ ] Tower restart with held rows → rows survive; delivery only after a clean gate pass.
- [ ] Respawned agent (new terminal id) drains predecessor's held mail.
- [ ] Concurrent sends → serialized, ordered, no blobbing (spike `w1a` scenario).
- [ ] Dead-session send → held (`no-live-pty`); unknown-app → held (`no-profile`).
- [ ] `--interrupt` bypasses holding; `noEnter` stages without submit and a follow-up holds behind it.
- [ ] Old-binary response shape intact (`ok`, `terminalId`, `deferred` still present).

#### Test Plan
- **Unit**: gate-pass → write; gate-fail → held with reason; serialization ordering; response field shape.
- **Integration**: full `handleSend` against a fake session + gate (idle/draft/menu); restart recovery;
  respawn drain; concurrent-send serialization.
- **Manual**: reproduce #1265 by hand against a live builder terminal (draft, pause, send from a sibling).

#### Rollback Strategy
This phase changes live behavior. Rollback = revert the phase commit, which restores `SendBuffer` (kept in git
history) and the prior `handleSend`. Because Phases 1–3 are inert without this wiring, reverting Phase 4 alone
returns the system to today's behavior cleanly.

#### Risks
- **Risk**: process swap in the gate→write gap (wrapper transition race). **Mitigation**: accepted residual
  (spec Risks); a failed gate or errored write leaves the row held; only a completed write marks delivered.
- **Risk**: removing `SendBuffer` disturbs its callers/tests. **Mitigation**: grep all `sendBuffer`/`SendBuffer`
  sites (tower-server.ts, tower-routes.ts, two tests) and migrate them in this phase; "who calls this?" sweep.

---

### Phase 5: Fast delivery triggers (submit + quiescence)
**Dependencies**: Phase 4

#### Objectives
- Reduce held-message latency from "next backstop poll" to "near-immediate once the human clears the line," by
  scheduling a gate-check + drain on user-submit and on output quiescence.

#### Deliverables
- [ ] Submit trigger: on detecting a user submit for a session (Enter), schedule that session's held-row drain.
- [ ] Quiescence trigger: when a session's output goes quiet (using `lastDataAt`), schedule a drain.
- [ ] Wiring in `pty-session.ts` (emit/track the signals) + the mailbox drainer (consume them). No new gate
      logic — triggers only *schedule* the existing gate check.
- [ ] Tests extending `send-delivery.test.ts`: held message delivers on submit/quiescence without waiting for
      the backstop.

#### Implementation Details
Triggers are cheap schedulers, never authority (spec Constraint). A missed trigger only delays delivery to the
next backstop poll — it can't corrupt anything, so the detection heuristics stay deliberately simple. Submit
detection reuses existing input tracking (`recordUserInput`/composing signals); quiescence reuses Spec 467's
`lastDataAt`.

#### Acceptance Criteria
- [ ] After a draft is submitted, a previously-held message delivers on the submit trigger (before the backstop
      would fire), on a now-clean prompt.
- [ ] A message held during agent output delivers shortly after output quiesces.
- [ ] A missed/spurious trigger never delivers onto a non-clean screen (gate still decides).

#### Test Plan
- **Unit**: trigger → drain scheduled → gate decides. **Integration**: submit-then-deliver; quiesce-then-deliver;
  spurious trigger on a dirty screen → still held.

#### Rollback Strategy
Revert the phase commit; delivery falls back to enqueue-time + backstop (Phase 4 latency), still correct.

#### Risks
- **Risk**: trigger storms cause redundant gate checks. **Mitigation**: coalesce per session (a pending drain
  supersedes another); gate cost is single-digit ms at realistic sizes.

---

### Phase 6: Cron rerouting through mailbox + gate
**Dependencies**: Phase 4

#### Objectives
- Bring the most-unguarded writer onto the single gated path, with per-task supersede and honest run logs.

#### Deliverables
- [ ] `deliverMessage` in `packages/codev/src/agent-farm/servers/tower-cron.ts` (303–323) routes through the
      mailbox + gate instead of the blind `writeMessageToSession`.
- [ ] Per-task **supersede key** = task name (Baked Decision 6): a newer run replaces the older *held* row.
- [ ] Cron run log records the real outcome (`delivered` / `held` / `superseded`), not unconditional "delivered".
- [ ] Tests: `packages/codev/src/agent-farm/__tests__/cron-delivery.test.ts`.

#### Implementation Details
Cron becomes an ordinary mailbox sender with a supersede key. Reuse Phase 4's enqueue + delivery entrypoint so
there is exactly one gated path. Non-cron sends never supply a supersede key (spec Decision 6 — cron-only).

#### Acceptance Criteria
- [ ] Cron message onto a busy/menu screen → held (never blind-written).
- [ ] A newer run of the same task supersedes the older held row (no backlog).
- [ ] Run log shows the real outcome.

#### Test Plan
- **Unit**: cron enqueue with supersede key; supersede replaces held. **Integration**: busy target → held;
  second run supersedes; log assertions.

#### Rollback Strategy
Revert the phase commit; cron returns to its prior direct write (regains its old bug, but isolated).

#### Risks
- **Risk**: cron backlog if supersede key is wrong. **Mitigation**: key = task name (stable); test supersede
  explicitly.

---

### Phase 7: afx inbox CLI + broadcasts + escalation
**Dependencies**: Phase 1, Phase 4

#### Objectives
- Make held messages discoverable and actionable without reading Tower logs: `afx inbox` (list + dismiss), the
  two broadcast events that keep indicators live, and the escalation-age visibility transition.

#### Deliverables
- [ ] `packages/codev/src/agent-farm/commands/inbox.ts` — `afx inbox` (list all held rows workspace-wide: id,
      reason, from→to, age) and `afx inbox dismiss <id>`.
- [ ] Command registration in `packages/codev/src/agent-farm/cli.ts` (commander, mirroring `send`).
- [ ] Tower API: `GET /api/inbox` + `POST /api/inbox/:id/dismiss` in `tower-routes.ts`.
- [ ] **Held state surfaced through the existing overview/SSE channel** (not the inter-agent `broadcastMessage`
      channel): add a workspace `heldCount` (and optional per-agent `heldCount`) to `OverviewData`/`OverviewBuilder`
      in `packages/types/src/api.ts`, populated from the mailbox in
      `packages/codev/src/agent-farm/servers/overview.ts`. Fire `overview-changed`
      (`ctx.broadcastNotification`, precedent `tower-routes.ts:1307`) on every held-state change
      (hold/deliver/supersede/dismiss) so both UIs refetch and the count stays live — this is the spec's
      **held-state-change broadcast**.
- [ ] **Escalation event**: a distinct SSE `notification` event (per the `packages/types/src/sse.ts` contract)
      plus an attention flag in the overview payload — the spec's **escalation broadcast**.
- [ ] Escalation-age handling in the mailbox drainer: a held row past the threshold (default 60s; configurable
      via `.codev/config.json`) → set `escalated`, emit the escalation `notification` + a loud log; **never** deliver.
- [ ] Liveness telemetry: repeated not-clean verdicts with recent output → loud log/broadcast (broken-profile
      discoverability, spec Constraint).
- [ ] Tests: `…/__tests__/inbox.test.ts` + escalation-age test.

#### Implementation Details
Dismiss is a soft transition (mark `dismissed`, not delete — auditable; pruned later by Phase 1's `pruneTerminal`).
Dismissal is workspace-human-authorized (any operator may dismiss any held row; no per-recipient check —
spec Decision 8). Bodies never appear in logs — ids + metadata only (spec Security). Because mailbox rows are
**agent-addressed** (`workspace_path` + `to_agent`), the overview's `heldCount` computes directly per agent/
workspace — cleaner than the retired `SendBuffer`, which was PTY-`sessionId`-keyed and would have needed a
session→builder mapping to surface a per-builder count.

#### Acceptance Criteria
- [ ] `afx inbox` lists every held row with its why-held reason immediately after it's held.
- [ ] `afx inbox dismiss <id>` marks it dismissed, drops it from the held set, and never delivers it.
- [ ] Crossing the escalation age emits the escalation broadcast + attention log; no delivery is triggered.
- [ ] Reasons (`busy`/`no-profile`/`no-live-pty`) are distinguishable in `afx inbox` and the send response.
- [ ] Message bodies never appear in Tower logs (assert on captured log output).

#### Test Plan
- **Unit**: inbox list/dismiss; escalation threshold transition; body-redaction in logs. **Integration**:
  held row → `afx inbox` shows it → dismiss → gone from list, not delivered.

#### Rollback Strategy
Revert the phase commit; held rows still exist (Phase 1) and still drain (Phase 4) — only the visibility surface
is lost. No delivery-safety regression.

#### Risks
- **Risk**: escalation logic accidentally triggers delivery. **Mitigation**: escalation only sets a flag +
  broadcasts; delivery is gate-only; explicit test that escalation triggers no write.

---

### Phase 8: Dashboard + VSCode held-count indicators
**Dependencies**: Phase 7

#### Objectives
- Surface the held count (and an attention state on escalation) in the dashboard and the VSCode sidebar —
  count-only, read-only (dismissal stays CLI-only, spec Decision 8).

#### Deliverables
- [ ] **Dashboard** (`apps/web/`, `@cluesmith/codev-web`): held-count badge in the app header controls
      (`src/components/App.tsx:347-356`), fed by the overview `heldCount` via the existing `useOverview` hook
      (`src/hooks/useOverview.ts` — already refetches on `overview-changed`). Attention state modeled on the
      compact dot pill in `src/components/CloudStatus.tsx` and/or the `NeedsAttentionList.tsx` treatment.
- [ ] **VSCode** (`apps/vscode/`, `codev-vscode`): fold the held count into the Agents-view badge by extending
      `updateActivityBadge()` (`src/extension.ts:405-426`), hooked at the existing overview fan-out
      (`src/extension.ts:453-458`, `overviewCache.onDidChange`). Optionally reflect it in the status-bar counts
      (`src/extension.ts:355-367`). Escalation → the `notification` SSE event (handled via `src/sse-client.ts` /
      `src/connection-manager.ts`) raises a VSCode notification.
- [ ] Attention state on escalation (distinct, log-free; specific visual is this phase's UI choice).
- [ ] Tests: Playwright for the dashboard indicator (per `codev/resources/testing-guide.md`); VSCode per its
      existing test pattern.

#### Implementation Details
Both surfaces are read-only consumers of Phase 7's broadcasts; neither computes held state independently
(single source of truth = the mailbox, surfaced via broadcast/API). Count reflects **all** currently-held rows.

#### Acceptance Criteria
- [ ] Held count appears and updates live as rows hold/resolve.
- [ ] Escalation moves the indicator into its attention state; it clears when the row resolves.
- [ ] No dashboard regression (Tower regression check per testing-guide).

#### Test Plan
- **Playwright** (dashboard): count updates on a broadcast; attention state on escalation. **VSCode**: indicator
  renders the count from the update channel. **Manual**: visual check of both surfaces.

#### Rollback Strategy
Revert the phase commit; `afx inbox` (Phase 7) remains the working visibility surface.

#### Risks
- **Risk**: UI claimed-working but untested. **Mitigation**: Playwright is mandatory for UI (CLAUDE.md);
  Tower regression check before done.

---

### Phase 9: Documentation + skeleton mirror
**Dependencies**: Phases 1–8

#### Objectives
- Document the new send response vocabulary and `afx inbox`, keep CLAUDE.md/AGENTS.md byte-identical, and mirror
  every framework change into `codev-skeleton/`.

#### Deliverables
- [ ] `codev/resources/commands/agent-farm.md` — send response vocabulary (`delivered`/`held`+reason), `afx inbox`.
- [ ] CLAUDE.md + AGENTS.md inter-agent messaging section updated (byte-identical); skeleton copies mirrored.
- [ ] `codev-skeleton/` mirrors of any changed framework/doc files.
- [ ] arch/lessons routing via the `update-arch-docs` skill (hot/cold tiers) — deferred to the Review phase if
      cleaner, but the doc-sync belongs here.

#### Implementation Details
Follow the "mirror every framework change in BOTH trees" invariant and the CLAUDE≡AGENTS byte-identical rule.
Grep both `codev/` and `codev-skeleton/` after edits.

#### Acceptance Criteria
- [ ] afx reference reflects the real response + `afx inbox` usage.
- [ ] `diff CLAUDE.md AGENTS.md` is empty.
- [ ] Skeleton mirrors present for every changed framework file.

#### Test Plan
- **Manual/CI**: byte-identical check; link/path sanity. **Manual**: run the documented `afx inbox` commands.

#### Rollback Strategy
Revert the phase commit; code behavior unaffected (docs-only).

#### Risks
- **Risk**: CLAUDE/AGENTS drift or skeleton not mirrored. **Mitigation**: explicit diff check + both-tree grep.

---

## Dependency Map
```
phase_1 (mailbox store) ─┐
                         ├─→ phase_4 (delivery core) ─→ phase_5 (fast triggers)
phase_2 (gate+profiles) ─┤                         └─→ phase_6 (cron)
        └─→ phase_3 (agy)┘                         └─→ phase_7 (inbox+broadcasts) ─→ phase_8 (indicators)
                                                                                  ↘
                                                        phase_9 (docs) depends on all ←──────────────┘
```
Critical path: 1 & 2 → (3) → 4 → {5, 6, 7} → 8 → 9. Phases 1 and 2 are independent and could be built in
either order; Phase 3 needs Phase 2; Phase 4 needs 1 & 2 (and wants 3 done so agy is real at ship).

## Resource Requirements
### Development Resources
- **Engineers**: single builder (this agent). Expertise: TypeScript, node-pty/xterm, SQLite (better-sqlite3), React (dashboard), VSCode extension API.
- **Environment**: local Tower on 4100; an authenticated `agy` terminal for the Phase 3 live smoke (optional — fixtures suffice otherwise).
### Infrastructure
- **Database**: additive `mailbox` table in the existing user-global `global.db` (no new store).
- **New services**: none.
- **Configuration**: `.codev/config.json` gains an optional escalation-age (and retention-days) key.
- **Monitoring additions**: liveness telemetry log/broadcast for repeated not-clean verdicts.

## Integration Points
### External Systems
- **agy / Antigravity CLI**: gate target requiring a measured profile (Phase 3). Fallback: unknown → held + visible.
### Internal Systems
- **PTY output ring buffer** (`pty-session.ts`) — gate data source (Phase 2/4/5).
- **`global.db`** — persistence (Phase 1); migration-on-boot.
- **Overview + SSE channel** (`overview.ts`, `packages/types/src/api.ts`, `ctx.broadcastNotification` →
  `/api/events` → clients refetch `/api/overview`) — held-count indicators + escalation (Phase 7/8). Inter-agent
  *message* delivery keeps using `tower-messages.ts:broadcastMessage`, unchanged.
- **Cron runner** (`tower-cron.ts`) — rerouted delivery (Phase 6).
- **`afx` CLI** (`cli.ts`, `commands/`) — `afx inbox` + extended send response (Phase 7).

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| Classifier profile drift (TUI bump) → sends to that app hold forever | Med | Med | Fail-safe (hold, never misdeliver); liveness telemetry; spike harness = version-bump smoke | builder |
| Gate false-clean on unmodeled state → misdelivery | Low | High | Conservative rule (marker AND empty region); unknown → held | builder |
| agy profile is net-new (breaks dim-placeholder assumption) | Med | Med | Front-loaded Phase 3; runtime fail-safe meanwhile | builder |
| Process swap in gate→write gap (wrapper race) | Low | Med | Accepted residual; failed gate/errored write → held; transitions print output so gate catches them outside the window | builder |
| Retiring `SendBuffer` breaks a caller/test | Low | Med | Grep all sites; migrate in Phase 4; "who calls this?" sweep | builder |
| UI indicator claimed-working but untested | Low | Med | Mandatory Playwright + Tower regression check | builder |

### Schedule Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| agy live measurement blocked (no authenticated agy) | Med | Med | Fixtures from spike harness suffice for tests; live smoke optional; front-loaded to surface early | builder |
| Spike artifacts hard to fetch (branch `spike-1265`) | Low | Med | Fetch the branch at Phase 2 start; escalate to architect if inaccessible | builder |

## Validation Checkpoints
1. **After Phase 1**: mailbox lifecycle + migration tests green; no live-path behavior change.
2. **After Phase 3**: all three profiles classify their fixtures; agy trust dialog is not-clean.
3. **After Phase 4**: the #1265 repro is dead end-to-end; corruption-elimination invariant fully in force.
4. **After Phase 6**: cron parity holds.
5. **After Phase 8**: visibility surfaces live and Playwright-verified.
6. **Before PR**: full build/test/lint/typecheck; CLAUDE≡AGENTS; both-tree mirror.

## Monitoring and Observability
### Metrics to Track
- Held-row count (surfaced by indicators); escalation events.
- Repeated not-clean verdicts per session (liveness telemetry → broken-profile signal).
### Logging Requirements
- Row ids + metadata only — **never** message bodies (spec Security). Outcomes logged (delivered/held/superseded/dismissed).
### Alerting
- Loud log/broadcast on liveness-telemetry trip and on escalation-age crossing. No external pager; the workspace human is the audience.

## Documentation Updates Required
- [ ] `codev/resources/commands/agent-farm.md` (send vocabulary, `afx inbox`)
- [ ] CLAUDE.md + AGENTS.md (inter-agent messaging) + skeleton mirrors
- [ ] arch/lessons routing (hot/cold) via `update-arch-docs` (Review phase)
- [ ] `.codev/config.json` reference (escalation-age / retention keys)

## Post-Implementation Tasks
- [ ] Performance validation (gate ≤ ~50ms at cap; idle send ≤ ~50ms added end-to-end)
- [ ] Security audit (bodies never logged; authorization unchanged)
- [ ] The #1265 repro exercised by hand on a live terminal
- [ ] Verify-phase check in the integrated codebase (post-merge)

## Expert Review
**Date**: _pending_
**Model**: _pending (porch runs Gemini + Codex + Claude at plan verify)_
**Key Feedback**:
- _to be filled after 3-way plan consultation_

**Plan Adjustments**:
- _to be filled_

## Approval
- [ ] Technical Lead Review
- [ ] Engineering Manager Approval
- [ ] Resource Allocation Confirmed
- [ ] Expert AI Consultation Complete

## Change Log
| Date | Change | Reason | Author |
|------|--------|--------|--------|
| 2026-08-01 | Initial implementation plan | Spec 1313 approved | builder spir-1313 |

## Notes
- **PR strategy** (architect direction): all phases ship as git commits within a **single PR**, opened
  during/after the final implement phase — not one PR per phase. The builder does **not** self-merge; repo
  maintainers merge (standing architect constraint).
- **Phase-count knob**: 9 phases favor small, independently-verified units over fewer big diffs. If the team
  prefers fewer 3-way consult cycles, natural merges are **2+3** (gate + all three profiles) and **4+5**
  (delivery core + fast triggers) and **7+8** (visibility backend + indicators) → collapsing to 6. I kept them
  split because agy is a blocking net-new measurement (isolating it surfaces schedule risk), delivery-core is the
  safety-critical unit that should be verified alone, and the UI surfaces need a different test harness (Playwright)
  than the CLI/API. **Open for the architect to collapse at the plan-approval gate.**
- **UI mechanism (confirmed by exploration)**: both surfaces update via **SSE** (`/api/events` → refetch
  `/api/overview`), not WebSocket. Held state is therefore surfaced by adding `heldCount` to the shared
  `OverviewData`/`OverviewBuilder` shape (`packages/types/src/api.ts`), populated in `overview.ts`, and signalled
  with an `overview-changed` event; escalation rides a distinct `notification` SSE event. Exact indicator homes
  are pinned in Phases 7–8 (dashboard `App.tsx` header controls; VSCode `updateActivityBadge`, which already
  models a numeric activity-bar badge). Package layout: dashboard `apps/web/`, VSCode `apps/vscode/`, shared
  types `packages/types/`, Tower `packages/codev/`.
- **No time estimates** (AI-age): progress is measured by completed phases, not elapsed time.
- **Spike dependency**: classifier facts + fixtures + POC harness live on branch `spike-1265`; the builder
  fetches that branch (spec Dependencies) — it does not land on main.
