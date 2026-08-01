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
- Committed "Plan with multi-agent review" (5989fa48). `porch done` → porch ran iteration-2 re-consult.

### 2026-08-01 — Plan 3-way consult (iteration 2)
- Verdicts: Gemini APPROVE, Codex REQUEST_CHANGES, Claude APPROVE — all HIGH. Gemini + Claude verified every
  iter-1 fix landed + all file refs accurate. Codex found 3 deeper implementation-seam gaps (all verified in code,
  all fixed):
  1. **Dead-session resolver seam**: `resolveTarget` (tower-messages.ts:152) resolves only LIVE terminals;
     handleSend 404s with no PTY (tower-routes.ts:1479-1486). So `no-live-pty` hold was unreachable. Added
     agent-registry fallback (global.db builders/architect via state.ts) + handleSend restructure (persist, not 404).
  2. **PtySession app-identity seam**: command/args are PRIVATE (only label/cwd public). Named the getter/
     appProfileKey seam resolveProfile needs. Phase 2.
  3. **`afx send --all`**: sendToAll (send.ts:200) pushes to sent on any ok (line 232). Extended client contract
     to cover --all, not just single-send. Phase 4.
- Claude cosmetic: GLOBAL_CURRENT_VERSION is in index.ts (already targeted); tower-client shape is
  {ok,resolvedTo,error} not ...terminalId (fixed description).
- Two of three already APPROVE. Committing iter-2 revisions + rebuttal; `porch done` → porch decides (re-consult
  iter-3 or gate). Codex's seams are legit + finite; if it keeps finding ever-finer detail, that's implement-phase
  territory and the human gate decides "good enough."
- Committed iter-2 revisions (0d2855ee). `porch done` → advanced straight to **plan-approval gate** (porch did
  NOT force iter-3; 2 APPROVE + all Codex concerns addressed was enough).

### 2026-08-01 — ⛔ STOPPED at plan-approval gate (awaiting human)
- `porch gate 1313` registered. Architect notified via `afx send`.
- **Waiting for human**: `porch approve 1313 plan-approval --a-human-explicitly-approved-this`.
- On approval → `porch next 1313` → **Implement phase**. Phase 1 (mailbox store) first.
- Reminder to self before implementing: fetch branch `spike-1265` for the classifier fixtures + POC harness
  (spec Dependencies); this is needed by Phase 2/3.

### 2026-08-01 — ✅ plan-approval APPROVED → Implement phase
- Architect approved plan-approval gate (commit 36582b2d). Architect decisions:
  1. **Keep 9-phase structure as planned — NO merges.** (Declined the 2+3 / 4+5 / 7+8 collapse knobs I offered.)
  2. **Standing constraint: we are NOT cluesmith/codev maintainers.** Single PR at the very end (after Phase 9),
     do NOT self-merge — maintainers merge. (Overrides the generic "merge your own PR after approval" role text.)
- `porch next 1313` → implement / phase_1 / iteration 1. Porch scope-restricts to phase_1 ONLY.
- Starting Phase 1 (Mailbox persistence layer): mailbox table in GLOBAL_SCHEMA + migration v15 (bump 14→15) +
  db/mailbox.ts repo + db/types.ts row types + __tests__/mailbox.test.ts (+ v14→v15 migration test).
- Note: spike-1265 fetch is a Phase 2/3 need (classifier fixtures), NOT Phase 1 — Phase 1 is pure DB/store work.

### 2026-08-01 — Phase 1 (Mailbox persistence layer) — code written
- Followed existing DB conventions closely (read schema.ts, index.ts, types.ts, consolidate.ts, and the
  migration-test trio spec-755/bugfix-826/pir-832 before writing):
  - **schema.ts**: `mailbox` table + 3 indexes appended to `GLOBAL_SCHEMA` (agent-addressed, additive).
  - **index.ts**: `GLOBAL_CURRENT_VERSION` 14→15; migration v15 block (CREATE TABLE/INDEX IF NOT EXISTS +
    `_migrations` row) mirroring v10/v14; re-exported DbMailbox/MailboxStatus/MailboxReason types.
  - **types.ts**: `DbMailbox` interface + `MailboxStatus`/`MailboxReason` unions.
  - **db/mailbox.ts** (new): repo fns take an explicit `db` handle FIRST (matches consolidate.ts, not
    state.ts's implicit getDb — chosen for testability). enqueue/getById/listHeld/findHeldForAgent/
    markDelivered/dismiss/supersede/pruneTerminal. State machine enforced via `WHERE ... AND status='held'`
    (markDelivered/dismiss/supersede only touch held rows → no delivered→held, supersede only replaces held).
    Timestamps injected via optional `now` param (default Date.now()) → deterministic tests. workspace_path
    treated as opaque key (canonicalization is Phase 4's boundary concern; mirrors cron_tasks).
  - **__tests__/mailbox.test.ts** (new): lifecycle unit tests vs a real GLOBAL_SCHEMA-seeded file DB
    (enqueue/list/deliver/dismiss/supersede/prune, per-agent ordering, state-machine no-ops, crash/reopen
    recovery, respawn-drain-by-agent).
  - **__tests__/spec-1313-migration.test.ts** (new): v15 migration test mirroring pir-832 convention
    (pre-v15 → v15 creates table+indexes; idempotent; CHECK rejects bad status; **fresh GLOBAL_SCHEMA vs
    migrated shapes converge** — ties the test to production so schema/migration drift fails loudly).
- ⚠️ Worktree had NO node_modules (`.codev` config absent → postSpawn `pnpm install` never ran; also no
  porch.checks override, so checks are protocol defaults `npm run build` + `npm test --exclude e2e`). Running
  `pnpm install --frozen-lockfile` from worktree root now (background). Then build types→core→codev + run tests.

### 2026-08-01 — Phase 1 verified GREEN
- Fixed one self-inflicted bug: a backtick inside a SQL comment (`'afx send'`) in the GLOBAL_SCHEMA **template
  literal** terminated the JS string → tsc/esbuild syntax error. Removed backticks. (Lesson: no backticks in
  SQL comments living inside a JS template-literal schema string.)
- Built types + core (their dist was missing); `tsc --noEmit` on codev src → clean; targeted vitest on the two
  new test files → **25/25 pass**.
- Full `npm run build` (incl. dashboard vite + copy-skeleton) → **exit 0**.
- ⚠️ Lesson: do NOT run `npm run build` and `vitest` **concurrently**. First combined run showed 56 "failures";
  they were an artifact — the build's `pnpm clean` + `rm -rf skeleton && cp -r` mutate dist/skeleton that tests
  read (hot-tier-injection reads skeleton/), and vite CPU contention timed out the real-shellper integration
  test. Re-running the suite ALONE → **203 files pass / 0 fail; 4066 tests pass, 48 pre-existing skips, 0 fail.**
  No DB-layer test failed in either run. Porch runs its build/test checks sequentially, so it won't hit the race.
- Committed Phase 1 code+tests: **aa51e85a** (6 files, +854/-1). Builder authors the `[Spec 1313]` code
  commits; porch authors `chore(porch): … build-complete` (status.yaml only, via writeStateAndCommit — verified
  in porch/state.ts:184-210). So I commit code myself, then `porch done` runs checks + 3-way implement review
  on `main...HEAD`.
- `porch done 1313` next → implement iteration-1 review (Gemini/Codex/Claude). STRICT mode: porch drives
  iterate-until-approve; I do not self-approve. On unanimous approve, porch advances to phase_2.

### 2026-07-31 — Resumed after `afx reset` → Phase 2 committed + re-verified GREEN
- Context was reset mid-Phase-2 (left `state-snapshot.md`). Recovered state: Phase 1 done/reviewed/advanced;
  Phase 2 code+tests written but **uncommitted** and `porch done` not yet run.
- Re-verified before trusting the snapshot (reset happened after the work): `@xterm/headless@6.0.0` installed;
  targeted `vitest run render-gate.test.ts` → **22/22 pass**; `tsc --noEmit` → **clean (exit 0)**.
- Audited every Phase 2 deliverable against the plan — all present & correct:
  - `render-gate.ts` (pure G-lite `classifyScreen`: marker AND zero normal-intensity composer cells → clean;
    seed-cap replay of the reconnect data path; dim placeholder OK; no force path).
  - `gate-profiles.ts` (claude/codex profiles + strict `resolveProfile` via `detectHarnessFromCommand`; NO claude
    fallback → agy/gemini/opencode/wrapped-launch/unknown all → null/`no-profile`). Verified `detectHarnessFromCommand`
    exists (harness.ts:329) and returns claude/codex/gemini/opencode by basename.
  - `pty-session.ts` identity seam (`get command()`/`get launchArgs()` — read-only getters over private config).
  - `@xterm/headless ^6.0.0` in package.json; pnpm-lock diff is xterm-only (verified).
  - Fixtures (real codex idle/draft/menu/picker; real claude draft/menu; **synthesized** claude-idle — sandbox
    claude is the ez-cli proxy shim that renders the idle placeholder without dim, documented in fixtures README).
- Staged EXPLICITLY (never `git add -A`); spawn/reset artifacts (`.builder-*`, `.claude/hooks/`,
  `state-snapshot.md`) deliberately left unstaged. Committed **3a79651f**.
- `porch check 1313` → **ALL CHECKS PASSED** (✓ build 14.9s, ✓ tests 28.3s — full non-e2e regression clean).
- Next: `porch done 1313` for the 3-way implement review. STRICT: porch drives iterate-until-approve; I do not
  self-approve.

### 2026-07-31 — Phase 2 implement review iter-1: Gemini+Claude APPROVE, Codex REQUEST_CHANGES → fixed
- Verdicts (all HIGH): Gemini APPROVE, Claude APPROVE (thorough, all deliverables present), Codex REQUEST_CHANGES
  with 2 legit, plan-grounded points. Fixed both rather than rebut (Codex was right):
  1. **Missing claude-picker fixture** — plan's matrix lists picker for BOTH apps; only codex had one. Added
     synthesized `claude-picker.busy.txt` (sandbox claude = ez-cli shim, so synthesized like claude-idle). Its
     highlighted row starts with the same `❯` glyph as the composer marker → pins that a picker's selection-cursor
     + list classifies busy via user-text, never false-clean. Mirrors the real codex-picker (`› 1. …`). Suite 22→23.
  2. **Perf assertion too loose** — was single cold-run <500ms. Replaced with warm-up + best-of-5 **min** <75ms.
     Min strips JIT/GC/scheduling noise (measured 42.7ms cold vs 14.5ms native steady-state). Logged best-of-5 =
     **19.2ms** — inside the spec's ≤~50ms. 75ms is the CI-noise ceiling (protocol forbids flaky tests), not a
     near-budget claim; the logged value is the evidence. 5x tighter than 500ms.
- **BONUS latent prod bug found while grounding the measurement** (ran the compiled dist under native node, not just
  vitest): `@xterm/headless` resolves to its CJS entry (no exports map / type:module) with non-analyzable named
  exports → `import { Terminal }` throws "Named export not found" under native-node ESM = how the compiled bins run
  in prod. Masked by vitest's vite interop; dormant until Phase 4 wires the gate. Fixed to default-import form
  (codebase convention, cf. `import Database from 'better-sqlite3'`) + type-only alias for the one type position.
  Lesson reaffirmed: "it compiled / vitest passes" ≠ "it works" — vitest's transform hid a real native-ESM bug.
- Verified: render-gate **23/23**, `tsc --noEmit` clean. Committed code fix **9cc8d852**; rebuttal artifact
  **(1313-phase_2-iter1-rebuttals.md)** committed separately (plan-phase precedent). Consult verdict .txt files are
  gitignored (transient) — not committed.
- `porch done 1313` next → iteration-2 re-consult. STRICT: porch decides re-review vs advance; I do not self-approve.

### 2026-07-31 — ✅ Phase 2 APPROVED (unanimous) → advanced to phase_3
- Iter-2 re-consult: **Gemini APPROVE, Codex APPROVE, Claude APPROVE — all HIGH, zero KEY_ISSUES.** Codex flipped
  from REQUEST_CHANGES after running the test file directly to verify behavior. My two fixes cleared its concerns.
- porch advanced: `57938efd chore(porch): 1313 advance plan phase → phase_3`. No human gate between implement
  phases, so no architect notification due.
- **Phase 3 — agy classifier profile (blocking measurement)** now open (iteration 1). This is net-new/empirical:
  agy's `> ` marker + NORMAL-intensity hint text break the claude/codex dim-placeholder rule, so agy needs its
  own profile/rule. Baked Decision 12 = blocking. Acceptance: agy **trust dialog → NOT clean** (a blind Enter
  there confirms a filesystem-trust decision), agy idle → clean, agy draft → not-clean, no claude/codex regression.
- Assets: spike-1265 branch exists (`builder/spike-1265`, checked out in another worktree → read via git, do NOT
  check out here). Spike POC harness at `codev/spikes/1265-poc/` on that branch. `agy` is on PATH
  (`~/.local/bin/agy`) — live smoke is OPTIONAL (fixtures + measurement note if unauthenticated; must NOT blindly
  spawn agy — #1077: an unauthed spawn opens an OAuth browser tab).

### 2026-08-01 — Phase 3 agy MEASUREMENT NOTE (how the rule was derived) + implementation
- **Method**: spawned real `agy` (Antigravity CLI 1.1.8, authenticated) under the spike harness
  (`harness.cjs` via a scratch `agy-measure.cjs`), rendered through `@xterm/headless` 6.0.0, and dumped
  per-cell SGR attributes (dim/bold/italic/inverse + **fg color mode/index**) for the composer row across
  idle/draft, plus a fresh-untrusted-dir spawn for the trust dialog. **Never sent Enter** (a blind Enter on
  the trust dialog confirms filesystem trust). exp0c only measured dim/bold (both 0 → looked identical); the
  decisive signal was **foreground color**, which I added to the probe.
- **Measured facts** (agy 1.1.8, this box):
  - Marker: `> ` at composer-row col 0, rendered **palette-12** (bright blue). NOT `❯`/`›` — own marker.
  - Idle composer: `> <Mode> mode: <hint> (shift+tab to cycle)` — hint at **palette-8 (gray), dim=0**.
  - Draft composer: `> <user text>` — text at **default fg** (fg=def).
  - Trust dialog: no rule-line composer; `> Yes, I trust this folder` selected option at **palette-12**;
    `  No, exit` at palette-8.
  - ⇒ dim/bold cannot separate idle-hint from draft (both dim=0); **fg color does** (pal8 gray = placeholder,
    default = user text, pal12 = marker/selected).
- **Derived rule**: profile gains optional `placeholderFgPalette` (agy: 8). Classifier ignores cells whose fg
  is that palette index (the color analogue of the universal `isDim()` skip). Idle → clean (gray hint ignored);
  draft → busy (default-fg counted); trust → busy (pal12 "Yes…" counted → **blind Enter can't confirm trust**).
  Only pal8 is ignored, so a non-gray option (pal12) still counts — pinned by a dedicated test (trust guard).
- **resolveProfile**: agy matched by binary basename (`agy`/`antigravity`) directly — NOT via
  `detectHarnessFromCommand` (which doesn't know agy and whose claude fallback is exactly the misID to avoid,
  constraint 10). Updated the Phase-2 "agy → null" comment + test (now agy → AGY_PROFILE, still NOT claude).
- **Fixtures**: SYNTHESIZED (idle/draft/trust) to the measured attributes with **sanitized** content — the raw
  agy capture embeds the authenticated **account email** in its banner, so it is NOT committed (scratchpad only).
  Synthesis verified through the real RingBuffer→classifier path before writing (`agy-synth.mjs`): idle=clean,
  draft=busy, trust=busy. README documents provenance + the color rule.
- **Verified**: render-gate **28/28** (was 23; +3 fixtures, +2 synthetic agy color-rule tests, agy resolveProfile
  test updated), `tsc --noEmit` clean. No claude/codex regression. agy is now a working, fail-safe target
  (Baked Decision 12 blocking criterion satisfied at the gate level; live delivery smoke is Phase 4/verify).
- Next: commit phase_3, `porch done 1313` → 3-way review.

### 2026-08-01 — ✅ Phase 3 APPROVED (unanimous) → advanced to phase_4
- Iter-1 re-consult: **Gemini/Codex/Claude all APPROVE, HIGH, zero KEY_ISSUES.** Gemini confirmed all 4
  deliverables (profile, fixtures, tests, measurement note in thread). No iteration needed. Committed:
  code **04b7959a**, thread **98ae1b79**. porch advanced to **phase_4** (iteration 1).
- **Phase 4 — Delivery orchestration + write serialization** now open. THE big integration phase (changes LIVE
  behavior; "makes the whole feature correct"). Scope (from plan):
  - `handleSend` rewrite (tower-routes.ts): **persist → serialize → gate → deliver|hold**; return `delivered` |
    `held`+id+reason. Persist row BEFORE the HTTP response.
  - Per-session **write serialization** (FIFO, completion-chained) in message-write.ts (or write-queue.ts) — a
    message's text + its Enter are one unit.
  - **Retire SendBuffer**: delete send-buffer.ts + its test; startSendBuffer/stopSendBuffer (tower-server.ts
    587/185) become the mailbox drainer lifecycle. Delivery moments this phase = enqueue-time + poll backstop
    (submit/quiescence triggers are Phase 5).
  - **Dead-session seam**: resolveTarget (tower-messages.ts:152) only resolves LIVE terminals + handleSend 404s
    → add agent-registry fallback (global.db builders/architect via state.ts) so no-live-PTY → held(`no-live-pty`),
    not 404. (Codex flagged this seam back in the plan consult.)
  - **Client contract**: extend tower-client.ts send return (+held/reason/mailboxId) + send.ts report real
    outcome on BOTH single-send (:332) and `--all` (sendToAll :200).
  - pruneTerminal wiring (boot + per-drain); liveness telemetry counter in the drainer (Phase 7 surfaces it).
  - Additive `POST /api/send` fields (held/mailboxId/reason) preserving ok/terminalId/deferred for old binaries.
  - Tests: send-delivery.test.ts + **automated e2e** for the #1265 repro (draft→send→held(busy)→submit→clean).
  - `--interrupt` stays the explicit human bypass (unchanged); no force paths, no shutdown flush.
- Starting with code reconnaissance (handleSend, send-buffer, message-write, resolveTarget, tower-server
  lifecycle, tower-client/send) before implementing. This phase will likely need >1 review iteration.

### 2026-08-01 — Phase 4 DESIGN (from full code map; recovery anchor)
Key existing shapes (verified via mapping subagent):
- `handleSend` tower-routes.ts:1425-1598 → responds `{ok, terminalId, resolvedTo, deferred}`. `shouldDefer` (:1570)
  = `!interrupt && !session.isUserIdle(3000)` (the bad 3s proxy to replace). Module singleton `sendBuffer` (:116),
  `deliverBufferedMessage` (:120) = writeMessageToSession + broadcastMessage → returns write-completion ms.
- `getGlobalDb` ALREADY imported in tower-routes.ts:78 (no RouteContext plumbing needed for the db handle).
- `writeMessageToSession(session, msg, noEnter, delayOffset=0): number` (message-write.ts) — returns completion-ms
  (NOT a promise); offset-chaining already serializes consecutive writes (#584). `WritableSession={write(data)}`.
- `resolveTarget(to, ws, from)` tower-messages.ts:152 — LIVE-ONLY (getWorkspaceTerminals in-memory map) → NOT_FOUND
  when no live terminal. Spoofing check in resolveArchitectByName (~213). handleSend 404s on getSession miss (:1479).
- PtySession: `ringBuffer.getAll()`; **cols/rows via `session.info.cols/rows` (NO get cols/rows getter!)**;
  `command`/`launchArgs`/`cwd`/`writable`/`isUserIdle` getters exist.
- mailbox.ts (Phase 1): enqueue(db, EnqueueInput, now)→row; findHeldForAgent(db,ws,agent) drain-order; markDelivered/
  dismiss/supersede(cron-only)/pruneTerminal(db,retentionDays,now); listHeld(db,ws?). reason∈busy|no-profile|no-live-pty.
- render-gate: `classifyScreen(snapshot,profile): Promise<verdict>` (ASYNC); `resolveProfile({command,args,label})`.
  ⚠ @xterm/headless MUST stay default-import (already fixed) — don't "fix" to named import.
- Client: tower-client.ts `sendMessage` DROPS deferred/terminalId (returns {ok,resolvedTo,error}). send.ts single
  (:332) + sendToAll (:200). `deferred` never shown to CLI today.

DECISIONS (non-obvious):
1. **Order of ops in handleSend** = resolve → format → gate-check (READ-ONLY) → `enqueue(db,{…,reason})` (persist
   BEFORE response) → if clean: writeMessageToSession + broadcast + `markDelivered` → respond. Gate BEFORE enqueue so
   the row carries the right reason (no updateReason API needed). Read-only gate means a crash before enqueue loses
   nothing writable; once enqueued, backstop redelivers. Row ALWAYS created (delivered ones markDelivered — audit).
2. **Wrapped-launch resolution** (CRITICAL — real builders run `.builder-start.sh`, so session.command='bash' →
   resolveProfile null → every builder send would hold no-profile). Fix in the DELIVERY layer (keep resolveProfile
   pure): `resolveProfile({command,args})` → if null, `harnessFromLaunchScript(fs, session.cwd)` (reset/context.ts:401,
   parses .builder-start.sh command-position) → `resolveProfile({command: harnessName})`. Reuse, don't reinvent.
3. **Dead-session seam**: resolveTarget NOT_FOUND → registry fallback (state.ts getBuilder/getArchitectByName by
   workspace+name) → enqueue(reason='no-live-pty'), respond held (NOT 404). Preserve spoofing constraint for architect:.
4. **Drainer replaces SendBuffer**: new `mailbox-delivery.ts` (deliverToSession/drainAgent/start+stopMailboxDrainer).
   start/stopSendBuffer hooks (tower-server.ts 587/185; tower-routes wrappers) → drainer lifecycle. Poll backstop
   (enqueue-time + periodic; submit/quiescence = Phase 5). pruneTerminal on boot + per-drain. Liveness counter
   (per-session repeated not-clean) lives in the drainer (Phase 7 surfaces). DELETE send-buffer.ts + its test; no
   shutdown force-flush (persistence subsumes it).
5. **Client contract**: widen tower-client.ts sendMessage return (+held,reason,mailboxId) + send.ts BOTH paths
   (single :332, --all sendToAll :200) report delivered vs held(reason)+id. Additive POST /api/send fields
   (held/mailboxId/reason) keep ok/terminalId/deferred for old binaries (held ⇒ ok:true).
6. `--interrupt` unchanged (Ctrl+C + write, no gate). `escape` unchanged. `noEnter` = staged write → delivered.
Build order: (a) mailbox-delivery.ts + unit tests → (b) handleSend rewrite + dead-session seam + wrapper resolve →
(c) client contract → (d) retire SendBuffer + lifecycle → (e) e2e #1265 repro. Commit once coherent+green.

### 2026-08-01 — Phase 4 RESUMED (recovery from snapshot) — foundation verified + latent bug fixed
- Re-read snapshot + thread. Verified the uncommitted foundation: `tsc --noEmit` clean, `send-delivery.test.ts` **9/10** initially.
- **FOUND + FIXED a real latent bug in mailbox-delivery.ts**: the drainer's streak-map key template literal contained an
  **invisible NUL byte** (`\x00`) where a space appeared visually — `` `${workspace_path}<NUL>${to_agent}` ``. Rendered as a
  space in every editor/Read; runtime key was `/ws\0B`. The test asserted `get('/ws B')` (space) → got undefined. A NUL
  separator is actually the *right* (collision-proof) choice, but an invisible one is a trap. Fix: extracted an explicit,
  exported `agentKey(ws, agent)` helper using a visible `\0`, used by the drainer + shared with the test + Phase 7. Now **10/10**.
  Lesson: born-dirty applies to source too — verify inherited/uncommitted code before building on it.
- Build order for the rest (unchanged): write-queue serialization → mailbox-delivery serialize wrapper → handleSend rewrite +
  dead-session seam + wrapper-profile resolve → retire SendBuffer + lifecycle → client contract → e2e #1265.
- Verified via grep: **no consumer** reads broadcast `metadata.source`/`raw` → delivered-broadcast `source:'mailbox'` is safe.

### 2026-08-01 — Phase 4 RECON complete (dead-session semantics nailed down)
Recon subagent mapped the exact surface. Decisions locked:
- **Dead-session = TWO cases.** (A) bare PTY death while Tower runs → routing entry STALE → `getSession()` returns exited
  (<30s: !writable→was 503) or undefined (>30s→was 404). resolveTarget SUCCEEDS; I already have result.workspacePath+agent →
  hold no-live-pty, NO registry needed. (B) `afx cleanup`/tab-close/tower-restart → routing entry REMOVED → resolveTarget
  NOT_FOUND → registry fallback.
- **`afx cleanup` also deletes the global.db builder row** (cleanup.ts:382 removeBuilder). So a cleaned-up builder is gone from
  BOTH registries → fallback finds nothing → 404 (correct: don't hold for a deleted builder). The registry fallback's REAL job:
  hold mail for a builder that's registered in global.db but has no live terminal (Tower restart / spawned-but-PTY-not-up).
- **Respawn (launch-loop) is NEVER dead** — `.builder-start.sh` runs `while true; do <agent>; …; done`; the harness exiting does
  not kill the PTY (bash wrapper stays live). No between-PTYs gap. The "respawned agent drains predecessor mail" criterion is the
  `afx cleanup`+new-spawn-same-id case (agent-addressed drain to the NEW terminal).
- interrupt/escape = explicit human bypass; require a LIVE writable session (no gate, no hold). Only NORMAL msg sends hold.
- to_agent stores the SPECIFIC agent name: builder id, or architect name (reverse-map result.terminalId→name via entry.architects,
  fallback 'main'). Makes getSessionForAgent + drainer redelivery deterministic across respawns.
- Wiring lives in NEW `servers/mailbox-wiring.ts`: makeDeliveryPorts + resolveLiveSessionForAgent + resolveProfileForSession
  (resolveProfile → if null, harnessFromLaunchScript(nodeFsPort, session.cwd) → resolveProfile({command:harness})) + drainer
  singleton + start/stopMailboxDrainer. resolveAgentInRegistry goes in tower-messages.ts next to resolveTarget (shares
  parseAddress + spoofing). Scope of registry fallback: bare-agent + architect/architect:<name> forms; project:agent NOT_FOUND
  falls through to 404 (rare cross-ws-to-dead edge; documented).

### 2026-08-01 — Phase 4 IMPLEMENTED (all deliverables) — build+unit green, e2e verifying
Full mailbox-first send path landed. Files:
- NEW `servers/write-queue.ts` — `KeyedSerializer` (per-agent FIFO, completion-chained). +`write-queue.test.ts` (6).
- `servers/mailbox-delivery.ts` — writeMessage port now completion-aware (awaited); added `deliverAgentMailSerialized`
  (module-singleton serializer) used by BOTH handleSend and the drainer; drainer tick routes through it. `agentKey` helper.
- NEW `servers/mailbox-wiring.ts` — `makeDeliveryPorts` (live session resolve + wrapper-profile fallback via
  harnessFromLaunchScript(nodeFsPort, session.cwd) + real classifyScreen + paced completion-aware write + broadcast) +
  `MailboxDrainer` lifecycle `start/stopMailboxDrainer` (replaces start/stopSendBuffer). NODE_FS_PORT (faithful 3-method).
- `servers/tower-messages.ts` — `resolveAgentInRegistry` (+`RegistryResolveResult{workspacePath,agent,kind}`): registry
  fallback for NOT_FOUND (bare builder exact/tail, architect/architect:<name> with spoofing; project:agent → 404, documented).
  `isResolveError` made generic `<T extends object>`.
- `servers/tower-routes.ts` — handleSend REWRITTEN: parse → resolveTarget → (NOT_FOUND→registry fallback→hold no-live-pty |
  else error) → getSession (dead/!writable → hold no-live-pty for normal; 404/503 kept for escape/interrupt) → escape (live,
  no row) → interrupt (Ctrl+C, gate-BYPASS, enqueue+write+broadcast+markDelivered, audit row) → NORMAL: enqueue(persist-first)
  → deliverAgentMailSerialized with a **request-scoped port override** delivering to the ALREADY-RESOLVED session (avoids a
  redundant/possibly-divergent re-resolve; also makes endpoint tests exercise the real gate) → getById → delivered|held resp.
  try/catch around delivery ⇒ gate/write error leaves row held (not 500). Helpers: sendJson, architectNameForTerminal
  (reverse-map tid→specific architect name so to_agent is concrete), liveTargetIdentity, formatMessageForTarget, holdAndRespond.
  Retired SendBuffer: deleted send-buffer.ts + send-buffer.test.ts; removed sendBuffer singleton/deliverBufferedMessage.
- `tower-server.ts` — start/stopSendBuffer → start/stopMailboxDrainer (mailbox-wiring).
- Client contract: `packages/core/src/tower-client.ts` sendMessage return +{delivered,held,reason,mailboxId} (additive, old
  binaries omit → reads as delivered). **REBUILT core** so codev typechecks against new .d.ts. `commands/send.ts` — single-send
  (:332) + sendToAll report delivered vs held(reason)+id, aggregate counts. lib/tower-client.ts just re-exports core (correct file).
- Response shape (POST /api/send success): {ok, terminalId|null, resolvedTo, deferred(=held), delivered, held, reason, mailboxId}.
- **Additive-field back-compat verified**; no consumer reads broadcast metadata.source → delivered broadcast uses source:'mailbox'.

Tests: `send-delivery.test.ts` (11: +serialized concurrency no-blob), `write-queue.test.ts` (6), NEW `send-mailbox-repro.test.ts`
(5: **#1265 vs the REAL gate** draft→held(busy)→clean→deliver, menu-hold, no-profile-hold, restart-recovery, respawn-drain),
`tower-routes.test.ts` (rewrote 7 send tests for gated delivery + 2 new: dead-session hold, held-busy; added in-memory getGlobalDb
mock + resolveAgentInRegistry mock + gateSession helper). **Full unit suite: 4097 pass / 48 skip / 0 fail. tsc clean.**
Existing `send-integration.e2e.test.ts` fixed (inert shells now hold; routing tests use interrupt gate-bypass path + trap-survive
shell; +1 held-behavior HTTP test). e2e runs vs dist (rebuilt) — verifying in background.
Next: confirm e2e, commit phase_4, `porch done 1313` → 3-way review. Expect >1 review iteration (big integration phase).

### 2026-08-01 — Phase 4 RESUMED (recovery) — e2e open item ROOT-CAUSED + RESOLVED; all green
Resumed from snapshot. Re-verified the uncommitted foundation: `tsc --noEmit` clean; **full unit suite 4102 pass / 48 skip /
0 fail**; phase_4 unit set (send-delivery + write-queue + send-mailbox-repro + tower-routes) 118/118.
**Resolved the one open item — the subprocess e2e (`send-integration.e2e.test.ts`).** Root cause (reproduced deterministically,
then instrumented the dist): `registerTerminal` → `POST /api/terminals` → non-persistent path → `pty-session.ts`
`const nodePty = await import('node-pty'); nodePty.spawn(...)` → **`nodePty.spawn is not a function`**. Instrumenting the dist
inside the running Tower showed the namespace has KEY `spawn` (cjs-module-lexer detected it) but `typeof nodePty.spawn === undefined`
AND `typeof nodePty.default.spawn === undefined` — a Node ESM↔CJS interop quirk where node-pty's live named bindings resolve
undefined inside Tower's deep ESM graph when loaded from built `dist/`. The SAME `await import('node-pty')` works standalone
(probed from the package tree: spawns a real PTY). This is **pre-existing and unrelated to Spec 1313**: `pty-session.ts` is
byte-identical to main (untouched by phase_4); the base e2e used the same non-persistent `/bin/sh` path (only the args differ),
so it failed identically on main. The codebase already knows this trap — `terminal/shellper-main.ts` deliberately loads node-pty
via `createRequire` with an ESM→CJS-interop comment; `pty-session.ts` does not.
**Fix (in-scope, test-only):** register the e2e terminals via the **shellper (persistent) backend** (`persistent: true`) — the
same path Tower uses for real builders/architects, which spawns in its own process and is immune to the quirk. A shellper session
reports `command: ''` (pty-manager.createSessionRaw), which still resolves to `no-profile`, so the held-behavior assertion holds.
**Result: `send-integration.e2e.test.ts` 6/6 PASS** (incl. the new mailbox-first held HTTP contract: held+mailboxId+reason=no-profile).
Did NOT touch `pty-session.ts` (out of phase_4 scope; the createRequire fix for the non-persistent path is a separate concern —
noting for a possible follow-up issue). Diagnostics (dist patch, probe scripts) fully reverted; worktree clean.
Phase_4 evidence complete: build green, full unit green, deterministic #1265 repro green, subprocess e2e green. Committing, then
`porch done 1313` → 3-way review.

### 2026-08-01 — Phase 4 review iter1 (Gemini APPROVE, Claude APPROVE, Codex REQUEST_CHANGES) → 3 fixes landed
Committed phase_4 (ff3b66eb) + thread (7988a06a); `porch done` → checks green → 3-way consult. Codex (HIGH) raised 3, all
verified against spec/plan and fixed:
1. **Prune retention default 7 → 30 (spec:147, plan:116).** Both Codex AND Claude flagged the 7-day default as a regression
   (prunes audit rows 4× too early). Fix: `DEFAULT_PRUNE_RETENTION_DAYS = 30`; added `mailbox.retentionDays` to CodevConfig +
   DEFAULT_CONFIG (30); `startMailboxDrainer` now reads it from the **user-global** `~/.codev/config.json` layer via
   `loadConfig(homedir())` (the drainer is Tower-global — prunes every workspace's rows in global.db — so a per-workspace
   config is the wrong source; malformed config falls back to 30). Test: default drainer keeps a 10-day row, prunes a 31-day one.
2. **project:agent cross-workspace offline hold (plan:264-269).** `resolveAgentInRegistry` returned NOT_FOUND (→404) for
   `project:<agent>`, so cross-workspace sends lost the mailbox hold when the recipient was offline. Fix: resolve the target
   workspace via `findWorkspaceByBasename` (the SAME mapping live `resolveTarget` uses) then hold against ITS registry. Boundary
   documented: needs the target workspace active (its agent's PTY may be dead) — same limitation live resolution has. New
   focused unit file `spec-1313-registry-resolve.test.ts` (7 cases: bare hold, tail-match, cross-ws hold, boundary NOT_FOUNDs).
3. **Subprocess #1265 full-cycle e2e (plan:313).** Plan wanted an e2e via vitest.e2e.config.ts doing draft→held(busy)→clear→
   deliver; the deterministic repro (send-mailbox-repro) does the full cycle but in the UNIT suite. Added the real subprocess
   e2e: a dedicated ws with `.builder-start.sh`=claude (so the gate resolves the claude profile for a shellper session whose
   command=''), an `stty raw -echo; cat` echo terminal whose composer bytes we drive via `/write`. De-risked with a throwaway
   Node probe FIRST (proved held(busy) then delivered-via-broadcast) before writing the test — captured raw data beats guessing.
   Result: send-integration.e2e **7/7** (draft→`held/busy`→clear→backstop redelivers `ship it` via source:'mailbox' broadcast).
Did NOT touch pty-session.ts (the node-pty quirk stays a documented pre-existing issue; the e2e uses the shellper path prod uses).
Verify: tsc clean; e2e 7/7; full unit suite re-running. Next: commit fixes → `porch next` (iter2 re-consult).

### 2026-08-01 — Phase 4 RESUMED (recovery) — iter1 fixes re-verified green; iter2 re-consult triggered
Resumed session. `porch next` confirms **iteration 2** of phase_4; the 3 iter1 Codex fixes are already committed
(`cd4a4cfd`) + thread (`a62c25b5`); working tree carries only untracked porch artifacts (iter contexts, the
`1313-phase_4-iter1-rebuttals.md` porch feeds to reviewers next round) + builder-session dotfiles.
**Independently re-verified the committed state before signaling** (born-dirty applies to inherited/uncommitted state):
- `tsc --noEmit` (packages/codev): clean, exit 0.
- Full unit suite (`vitest run --exclude '**/e2e/**'`): **4109 pass / 48 skip / 0 fail**, exit 0 — matches iter1's count.
- Confirmed both fixes in *source* (not just the commit msg): `DEFAULT_PRUNE_RETENTION_DAYS = 30` +
  `config.ts` `retentionDays: 30` + `mailbox-wiring.ts` reads `loadConfig(homedir()).mailbox?.retentionDays ?? 30`;
  `resolveAgentInRegistry` now resolves `project:<agent>` via `findWorkspaceByBasename` and holds against that registry.
- Core client contract present in built `.d.ts` (held/reason/mailboxId).
Ran `porch done 1313` (background) → re-runs checks + fires the iter2 3-way consult. Awaiting verdicts.
Rebuttals file is a *concurrence* doc (agreed + fixed all 3; no disputes) — passed to reviewers as iter2 context.

### 2026-08-01 — Phase 4 APPROVED (unanimous iter2) — advancing to phase_5
`porch done` iter2 checks green (build 14.9s, tests 28.3s). 3-way consult: **Gemini APPROVE, Codex APPROVE
(flipped from iter1 REQUEST_CHANGES), Claude APPROVE** — unanimous. Porch advanced phase_4 → **phase_5**
(commits `c2b6590a` re-iter → `e4a4e452` build-complete → `5bcdd8e3` advance). Phase_4 (the "correct by
construction" integration phase) is locked in: mailbox-first persist→serialize→gate→deliver|hold, SendBuffer
retired, no force paths, dead-session/no-profile → held, additive client contract.
**Starting phase_5: Fast delivery triggers (submit + quiescence).** Scope: schedule a per-session held-row
drain on user-submit (Enter) and on output quiescence (Spec 467 `lastDataAt`), coalesced per session. Triggers
are schedulers, never authority — the Phase-4 gate still decides; a missed trigger only defers to the backstop
poll. Wiring in pty-session.ts (emit signals) + the drainer (consume/coalesce). No new gate logic.

### 2026-08-01 — Phase 5 IMPLEMENTED (commit 62855a88) — build+unit green
Design recon first (drainer, pty-session input/output signals, wiring, test harness). Key findings that shaped it:
submit is already detected at `tower-websocket.ts:96-97` (`stopComposing()` on `\r`/`\n`, Bugfix #450) — the human
terminal path; `onPtyData` already tracks `_lastDataAt` (Spec 467) + emits `'data'`. PtyManager is NOT an
EventEmitter (no session-created hook) and `PtySession.id` is public → chose a **module-singleton signal bus**
(`terminalDeliverySignals`) over per-session subscription: sessions emit `{kind, sessionId}`, wiring subscribes once
and reverse-maps id→agent lazily. This keeps pty-session ignorant of the mailbox layer (no import) and is consistent
with the single global drainer. Files:
- `pty-session.ts`: `terminalDeliverySignals` bus + `QUIESCENCE_DEBOUNCE_MS=500`. `stopComposing()`→emit `'submit'`;
  self-rescheduling unref'd debounce keyed on `_lastDataAt`→emit `'quiescence'`, armed only when a subscriber exists
  (zero-cost when drainer off), cleared in `cleanup()`.
- `mailbox-delivery.ts`: `MailboxDrainer.scheduleDrain(ws,agent)` — coalescing per-agent (burst→one pending promise→
  one gate check; slot released just before the pass so an in-pass trigger queues exactly one follow-up; KeyedSerializer
  prevents overlap). Never rejects (logs, leaves for backstop). `recordStreak` extracted, shared with `tick`.
- `mailbox-wiring.ts`: `resolveAgentForSession` (inverse of resolveLiveSessionForAgent); subscribe/unsubscribe the bus
  in start/stopMailboxDrainer (idempotent; detaches on stop so restarts don't leak listeners).
Triggers are schedulers never authority (spec Constraint): same gated `deliverAgentMailSerialized`; missed/spurious
trigger can't corrupt — gate decides, backstop is safety net.
Tests (+14): send-delivery (trigger-delivers-no-tick, spurious→held, burst coalesces to 1 gate check, held-then-clear,
pre-start no-op), pty-session-delivery-signals (submit/quiescence emit, re-arm mid-stream, lazy zero-cost),
spec-1313-resolve-agent-for-session (builder/architect/shell reverse-map + null cases). **Full unit 4123 pass / 48
skip / 0 fail; tsc clean.** (Aside: session cwd drifted into packages/codev mid-run — a `cd x && …` re-`cd x` failed
once; harmless, re-ran from the right dir.) Next: commit thread → `porch done 1313` → phase_5 3-way consult.

### 2026-08-01 — Phase 5 review iter1 (Gemini APPROVE, Claude APPROVE, Codex REQUEST_CHANGES) → 1 fix landed (0fc26555)
`porch done` iter1 checks green (build 15s, tests 28s); 3-way consult. Codex (HIGH) raised one real issue I'd
actually noted during design: the **submit trigger only fired on the tower-websocket path**, not the pty-manager
standalone terminal-server WS handler (`pty-manager.ts:306-318` did only `recordUserInput()`+`write()`, no
`stopComposing()`). Root cause = composing/submit detection **duplicated inline** (tower-websocket had it twice) →
a 2nd input path drifted. Gemini+Claude APPROVE, no issues (Claude: "No issues found").
**Fixed by consolidation, not a 3rd copy** (SST — the lesson this bug proves): new `PtySession.handleUserInput(data)`
= the one chokepoint (recordUserInput → composing/submit detect → write); both branches of BOTH WS handlers
(tower-websocket + pty-manager) now route through it. pty-manager path now fires `'submit'` on Enter like the Tower
path; neither can drift. Delivery still calls `write()` directly → never trips submit. Verified `composing` getter has
NO prod readers (safe). tower-websocket.test.ts uses a MOCK session asserting recordUserInput/write → updated to
assert delegation to handleUserInput + added `handleUserInput` to the mock; new PtySession test drives the chokepoint
(composing tracked, both chunks written, submit only on Enter). pty-manager + typing-awareness suites unaffected.
Evidence: **tsc clean; full unit 4124 pass / 48 skip / 0 fail**; affected-4 files 55/55. Response doc written
(`1313-phase_5-iter1-rebuttals.md`, concurrence — agreed+fixed, no dispute). Next: commit thread → `porch done` (iter2 re-consult).

### 2026-08-01 — Phase 5 RESUMED (recovery) — iter-2 3-way consult launched
Resumed after architect pause (state-snapshot.md, 08:24Z). Re-oriented: phases 1–4 done+approved;
phase_5 implemented+committed (`62855a88`), iter-1 Codex fix landed (`0fc26555`, handleUserInput
chokepoint consolidation), porch already advanced to iteration 2 (`3df31816` re-iter → `eb21352f`
build-complete, green). Working tree clean except the usual untracked builder-infra/porch artifacts.
`porch next 1313` → emitted the phase_5 **iter-2** 3-way consult task. Verified the porch-generated
context file exists (`1313-phase_5-iter2-context.md`, carries iter-1 verdicts + my concurrence
response) and `consult` is on PATH, then launched all three in background (gemini/codex/claude).
Did NOT re-implement phase_5 — the fix is committed + green (tsc clean, 4124 pass/48 skip/0 fail);
only the iter-2 re-consult remained. Awaiting verdicts → then `porch next 1313` to evaluate.

### 2026-08-01 — Phase 5 APPROVED (unanimous iter-2) — porch advanced to phase_6
iter-2 3-way consult: **Gemini APPROVE (HIGH), Codex APPROVE (HIGH, flipped from iter-1
REQUEST_CHANGES), Claude APPROVE (HIGH)** — unanimous, zero KEY_ISSUES. The `handleUserInput`
chokepoint consolidation resolved Codex's one iter-1 point. `porch next 1313` advanced phase_5 →
**phase_6 (Cron rerouting through mailbox + gate)**, iteration 1. Phase_5 (fast delivery triggers)
locked in: submit + quiescence signals schedule a coalesced, gated drain; triggers are schedulers,
never authority; single input chokepoint across both live WS paths.
**Starting phase_6.** Scope (from plan): route cron's `deliverMessage` (tower-cron.ts:303-323)
through the Phase-4 mailbox+gate entrypoint instead of blind `writeMessageToSession`; add a
per-task **supersede key = task name** (Baked Decision 6, cron-only) so a newer run replaces an
older *held* row; make the cron run log record the real outcome (delivered/held/superseded).
Recon first (understand-before-coding) before touching anything.

### 2026-08-01 — Phase 6 recon done → design locked → implementing
Read the whole delivery stack: `db/mailbox.ts` already ships `enqueue`/`supersede`(atomic held-replace by
`(ws,key)`)/`getById` + the `supersede_key` column & index (Phase 1); `mailbox-delivery.ts` exposes the ONE
gated path `deliverAgentMailSerialized` (persist→serialize→gate→deliver|hold, no force path); `mailbox-wiring.ts`
`makeDeliveryPorts(log)` binds it to the live Tower; `handleSend` (tower-routes) is the reference caller
(enqueue→makeDeliveryPorts→deliverAgentMailSerialized→getById→respond). Confirmed `resolveTarget("architect")`
returns generic `agent:'architect'`, so cron — like handleSend — must reverse-map via `liveTargetIdentity`
(terminalId→specific architect name) or the mailbox can't resolve the recipient.
**Design (cron = ordinary mailbox sender, one gated path):**
- `db/mailbox.ts`: add `countHeldWithKey(db,ws,key)` — lets cron log delivered/held/**superseded** honestly.
  Race-free: better-sqlite3 is synchronous, so count-then-`supersede` with no await between is atomic.
- NEW `servers/cron-delivery.ts`: registry-free core `deliverCronMail(ports,db,target)` — supersede-enqueue
  (key=task.name, sender=`af-cron`) → the SHARED `deliverAgentMailSerialized` → real outcome from row status.
  Fake-ports + in-memory-DB testable (mirrors send-delivery.test.ts harness). No force path; busy→held.
- `tower-routes.ts`: thin exported `deliverCronMessage(task,msg,log)` — resolves identity (resolveTarget +
  liveTargetIdentity; NOT_FOUND-but-known → `resolveAgentInRegistry` dead-session fallback per spec decision 9,
  hold `no-live-pty`), formats via `formatBuilderMessage('af-cron',…)` (preserves current cron formatting).
- `tower-cron.ts`: `CronDeps` drops `resolveTarget`+`getTerminalManager` (delivery-only, now vestigial) for one
  `deliver` port; `deliverMessage` awaits it + logs the real outcome. `tower-server.ts`: wire deliver→deliverCronMessage.
- Tests: NEW cron-delivery.test.ts (core: clean→delivered, busy→held, 2nd run supersedes/no-backlog, no-pty→held);
  update tower-cron.test.ts delivery tests to assert the `deliver` port + outcome logging (drop session.write asserts).
"one gated path" = the shared `deliverAgentMailSerialized` (the sole place a body is written); cron & handleSend
each do their own address→agent resolution but funnel into it. Triggers/schedulers unchanged.

### 2026-08-01 — Phase 6 IMPLEMENTED — build + full unit green (4133 pass / 48 skip / 0 fail)
Landed as designed. Files: `db/mailbox.ts` (+`countHeldWithKey`), NEW `servers/cron-delivery.ts`
(`deliverCronMail` core + `CRON_SENDER`/`CronDeliveryResult`/`CronTarget`), `tower-routes.ts`
(+exported `deliverCronMessage` wrapper), `tower-cron.ts` (CronDeps: dropped resolveTarget+getTerminalManager
→ one `deliver` port; `deliverMessage` now async, logs delivered/held/superseded; dropped now-unused
formatBuilderMessage/broadcastMessage/writeMessageToSession/basename imports), `tower-server.ts` (wire
`deliver`→`deliverCronMessage`; dropped now-unused `resolveTarget` import). Tests: NEW cron-delivery.test.ts
(7: clean→delivered, busy→held-no-write, no-pty→held, no-profile→held, 2nd-run→superseded+no-backlog,
supersede-then-clear→delivered, distinct-keys-independent) + tower-cron.test.ts rewired (deliver-port +
outcome-logging asserts; dropped the retired tower-messages/message-format mocks the SUT no longer imports). +9 tests.
Verified: tsc clean; `npm run build` green; full unit **4133 pass / 48 skip / 0 fail**.
Confirmed no consumer keys on the old cron broadcast `source:'cron'` — delivered broadcast now unifies to
`source:'mailbox'` (consistent with "same mailbox+gate"). **Process note:** first full-suite run showed 2
`session-manager` failures = `dist/terminal/shellper-main.js` "cannot find module" — a build-race from running
`npm run build` CONCURRENTLY with vitest (that test spawns the built shellper). Re-ran the suite ALONE → green.
Lesson: don't run the dist-rebuilding `npm run build` concurrently with the suite that spawns from `dist/`.
Next: commit phase_6 (impl+tests+thread) → `porch done 1313` (build-complete + phase_6 3-way consult).

### 2026-08-01 — Phase 6 APPROVED (unanimous iter-1) — porch advanced to phase_7
Committed `e38d892d`; `porch done` checks green (build 14.7s, tests 28.3s). Phase_6 iter-1 3-way consult:
**Gemini APPROVE, Codex APPROVE, Claude APPROVE — all HIGH, zero KEY_ISSUES** (first-iteration unanimous;
Claude praised the cron-delivery.ts/deliverCronMessage split mirroring Phase-4 handleSend/mailbox-delivery).
`porch next` advanced phase_6 → **phase_7: afx inbox CLI + broadcasts + escalation** (iteration 1).
Phase_6 locked: cron = ordinary mailbox sender on the one gated path; busy→held, per-task supersede, honest outcomes.
**Starting phase_7 (largest phase).** Deliverables: (A) `commands/inbox.ts` `afx inbox` list + `dismiss <id>` +
cli.ts registration; (B) Tower `GET /api/inbox` + `POST /api/inbox/:id/dismiss`; (C) overview `heldCount`
(workspace + per-agent) in packages/types api.ts + overview.ts, fire `overview-changed` on every held-state
change (hold/deliver/supersede/dismiss) = the held-state-change broadcast; (D) escalation: config threshold
(default 60s) + drainer escalation-age → set `escalated` + emit SSE escalation notification + loud log, NEVER
deliver; (E) liveness-telemetry surfacing (drainer not-clean streak threshold → loud log/broadcast); (F) tests
(inbox.test.ts + escalation). Recon first: 2 Explore agents map (CLI→route flow) + (overview/SSE surface) while
I read spec decisions 7/8/9 + config.ts + db/mailbox current state + the drainer.

### 2026-08-01 — Phase 7 recon complete (2 agents) → full plan → implementing
Both Explore briefs in. Landed isolated pieces already: config `escalationSeconds` (default 60) + db
`findEscalatable`/`markEscalated`/`heldSummaryForWorkspace` (count-only, body-safe) + `commands/inbox.ts`
(list + dismiss, mirrors cron.ts; metadata-only rows, full id shown, global-default + `--workspace` scope,
`!` escalation marker). **Full plan (remaining):**
- sse.ts: add `'mailbox-escalation'` to SSEEventType + `MailboxEscalationPayload` (JSON in body).
- api.ts: OverviewData += `heldCount:number` + `mailboxEscalated:boolean` (required); OverviewBuilder +=
  `heldCount?:number` (OPTIONAL — plan says "optional per-agent"; avoids churn in discoverBuilders' 3 literals).
- mailbox-delivery.ts: DeliveryPorts += `onHeldStateChange()` (→SSE overview-changed) + `onEscalation(info)`
  (→SSE mailbox-escalation); deliverAgentMail fires onHeldStateChange after markDelivered; MailboxDrainer gets
  `escalationMs` + an escalation pass in tick() (findEscalatable→markEscalated→onEscalation+loud log; NEVER
  delivers) + liveness surfacing in recordStreak (streak crosses threshold → loud `[mailbox] LIVENESS:` log).
- mailbox-wiring.ts: `setMailboxBroadcaster(fn)` module singleton (mirrors setCodevConfigNotifier) + bind the 2
  new ports in makeDeliveryPorts + read escalationSeconds in ensureDrainer.
- cron-delivery.ts: fire ports.onHeldStateChange() after supersede.
- tower-routes.ts: import listHeld/dismiss; `handleInboxList` (GET /api/inbox, metadata-only projection) +
  `handleInboxDismiss` (POST /api/inbox/:id/dismiss, 404 if not held, fires overview-changed); register both
  (exact-match + regex); fire overview-changed in holdAndRespond + handleSend-held path; add heldCount/
  mailboxEscalated to the no-workspace overview literal (~:1070).
- overview.ts: in getOverview's existing readonly-DB block, `heldSummaryForWorkspace(db, normWs)` → set
  result.heldCount/mailboxEscalated + per-builder heldCount (case-normalized to_agent→roleId).
- cli.ts: register `inbox` parent (.action=list) + `dismiss <id>` child (lazy import, try/catch).
- tower-server.ts: `setMailboxBroadcaster(broadcastNotification)` at boot.
- Tests: inbox.test.ts (list/dismiss/404) + escalation test (age→escalated+broadcast, no delivery) + body-
  redaction assert; update send-delivery.test.ts + cron-delivery.test.ts fakes for the 2 new ports.
"one gated path" + "no force" invariants untouched; escalation is visibility-only.

### 2026-08-01 — RESUMED (architect) — Phase 7 IMPLEMENTED, build + full unit green
Resumed the paused Phase-7 session (state-snapshot.md confirmed: paused mid-edit, tree intentionally
non-compiling). Finished every remaining piece from the recon plan. **Files landed this session:**
- `mailbox-delivery.ts`: drainer `escalationMs` field+ctor; `tick()` now runs `escalateOverdue()` after the
  delivery loop (findEscalatable→markEscalated→`onEscalation`+loud ESCALATED log; **never delivers**, once per
  row via the `escalated=0` guard); `recordStreak` emits ONE loud `LIVENESS:` log when a **no-profile** streak
  hits `LIVENESS_STREAK_THRESHOLD` (busy streaks deliberately NOT alarmed — Constraint 1: busy = human present).
- `mailbox-wiring.ts`: `setMailboxBroadcaster(fn)` module singleton (mirrors setCodevConfigNotifier); bound
  `onHeldStateChange`→`overview-changed` + `onEscalation`→`mailbox-escalation` in makeDeliveryPorts;
  `configuredEscalationMs()` read into ensureDrainer.
- `cron-delivery.ts`: fire `onHeldStateChange()` after supersede (new held row → indicator refetch).
- `overview.ts`: `heldSummaryForWorkspace(db, normWs)` folded into getOverview's existing readonly-DB block →
  `result.heldCount`/`.mailboxEscalated` + per-builder `heldCount` (roleId = to_agent.toLowerCase(), the same key
  handleOverview uses). Defaults 0/false survive a missing/unreadable DB.
- `tower-routes.ts`: `handleInboxList` (GET /api/inbox, metadata-only projection — NO body) + `handleInboxDismiss`
  (POST /api/inbox/:id/dismiss, 404 if not held, fires overview-changed); registered (exact GET + regex POST);
  `holdAndRespond` now takes `ctx` and fires overview-changed; handleSend held-branch fires it too; no-workspace
  overview literal gets heldCount:0/mailboxEscalated:false.
- `cli.ts`: `inbox` parent (.action=list) + `dismiss <id>` child (lazy import, try/catch — mirrors cron).
- `tower-server.ts`: `setMailboxBroadcaster(broadcastNotification)` at boot (next to setCodevConfigNotifier).
- `packages/types/src/index.ts`: **re-export `MailboxEscalationPayload`** (was defined in sse.ts but NOT in the
  index's explicit named re-export list — the one real compile error; `BuilderSpawnedPayload` masked it by looking
  fine). api.ts/sse.ts/config.ts/inbox.ts/db were already landed by the prior session.
- Tests: NEW `inbox-cli.test.ts` (list table/empty/workspace-scope/escalation-`!`/404 — mirrors cron-cli fake-client
  pattern); `send-delivery.test.ts` +6 (escalate-past-age→onEscalation metadata+never-deliver, fire-once, young-row-
  not-escalated, delivery→onHeldStateChange, no-profile-streak→1 LIVENESS log, busy-streak→0); both delivery harnesses
  gained the 2 new ports; cron-delivery asserts onHeldStateChange fired.
**Design note (liveness scope):** spec line 91 says "repeated not-clean verdicts → loud log/broadcast." Scoped the
loud warning to `no-profile` (the actionable broken/unknown-classifier signal) — a busy line is a legitimate human
present (Constraint 1) and must not false-alarm. Implemented as a loud LOG (no new SSE event); the two decision-8
events stay exactly {overview-changed, mailbox-escalation}. Escalation fires ONLY mailbox-escalation (kept distinct
from overview-changed per decision 8; Phase 8 client refetches on both).
Verified: types build clean, `tsc --noEmit` on codev **exit 0**, targeted 58/58 green. Full unit suite running.
Next: confirm full suite green → commit phase_7 (impl+tests+thread) → `porch done 1313`.

### 2026-08-01 — Phase 7 iter-1 review: Gemini APPROVE, Claude APPROVE(HIGH), Codex REQUEST_CHANGES → fixed
Committed phase_7 as `8ba22a02`; `porch check` green (build 14.7s, tests 28.3s); `porch done` → build-complete;
`porch next` → ran the 3-way. **Codex raised 3 issues; verified all 3 valid against the code and fixed them**
(the 3-way earning its keep — Gemini+Claude both missed these). Rebuttal at `1313-phase_7-iter1-rebuttals.md`.
1. **Escalation didn't refresh the overview-derived `mailboxEscalated`** (only fired `mailbox-escalation`, not
   `overview-changed`) → a client refetching overview on `overview-changed` sees a stale attention bit. FIX:
   `escalateOverdue` now also calls `ports.onHeldStateChange()` once when any row escalated (both events fire).
2. **Liveness was log-only + ignored spec's "with recent output"** (spec line 91: "loud log/broadcast" +
   "with recent output"). FIX: new `onLiveness(info)` port — pure module just REPORTS the no-profile streak
   crossing (metadata only); wiring's `surfaceLiveness` applies the recent-output gate (session `lastDataAt` ≤ 30s)
   then does loud WARN log + broadcast. Broadcast rides the EXISTING generic `notification` SSE event (no new type,
   immediately visible, doesn't expand decision-8's two-event indicator contract). Still `no-profile`-scoped.
3. **No route-level/integration coverage** (plan's Test Plan explicitly wanted "held → afx inbox → dismiss → gone,
   not delivered"). FIX: NEW `inbox-routes.test.ts` (real `handleRequest` dispatch + real in-memory DB; only
   getGlobalDb remapped) — projection+body-redaction, escalated 0/1→bool, `?workspace=` scope, full dismiss
   integration + overview-changed fire, 404s; +`mailbox.test.ts` db tests for findEscalatable/markEscalated/
   heldSummaryForWorkspace; + escalation test asserts overview-changed fires.
Design note: reused `notification` (not a new `mailbox-liveness` type) for the liveness broadcast — simpler, no
Phase-8 client dependency, keeps the SSE surface minimal. Verified: tsc exit 0; targeted 6 files 75/75 green.
Full suite re-running. Next: full green → commit iter-2 fixes → `porch done 1313` (re-verify → iter2 consult).

### 2026-08-01 — RESUMED after architect pause — iter-2 fixes verified, committing
Architect resumed the paused session ("read state-snapshot.md for current state"). Re-verified the uncommitted
iter-2 fixes against the actual working tree before trusting the snapshot: (1) `escalateOverdue` fires
`onHeldStateChange()` once when any row escalated; (2) `onLiveness` port + `surfaceLiveness` recent-output gate
(`lastDataAt ≤ 30s`) → loud WARN + `notification` broadcast; (3) `inbox-routes.test.ts` (250 LOC: body-redaction,
escalated 0/1→bool, `?workspace=` scope, list→dismiss→gone integration, 404s). Rebuttal accepts all 3, disputes
none. **Build exit 0; full unit suite 4160 passed / 48 skipped / 0 failed.** Committing iter-2 delta (2 src + 5
test files + thread), then `porch done 1313` → iter-2 3-way consult. Porch artifacts under codev/projects/ and the
ephemeral state-snapshot.md stay untracked (matches prior phases' pattern).

### 2026-08-01 — Phase 7 iter-2 review: Gemini APPROVE, Claude APPROVE(HIGH), Codex REQUEST_CHANGES → fixed
iter-2 fixes committed (`18ba65b4`); `porch done` green (build 14.6s, tests 28.3s) → build-complete; ran the
iter-2 3-way. Codex accepted all 3 iter-1 fixes and raised **one NEW issue** (Gemini+Claude both APPROVE):
`afx inbox` **defaulted to Tower-wide** (all workspaces), but spec **Decision 8** (lines 148/241) pins it
**workspace-scoped**. Verified against spec+plan+code — VALID, and it's an autonomous override of a Baked
Decision (forbidden). The plan's "workspace-**wide**" = all recipient agents *within one workspace*, not
Tower-wide; and line 241 shows Codex already settled this at spec review ("resolves Codex's scope question").
No rebuttal — accepted + fixed.
**Fix (3 src + 2 test files):**
- `commands/inbox.ts`: `inboxList` defaults to the current workspace (`getConfig().workspaceRoot`, same
  resolver `afx status` uses) when no `--workspace`; always sends `?workspace=`. `--workspace <path>` = a
  different workspace. Updated interface/docstrings.
- `cli.ts`: `-w, --workspace` help "default: all workspaces" → "default: current workspace".
- `servers/tower-routes.ts` `handleInboxList`: **normalizes** the `?workspace=` param via
  `normalizeWorkspacePath` (realpath) before `listHeld` — matches the enqueue-time normalized `workspace_path`
  key (mirrors overview.ts); without it a symlinked root would miss its own rows. No-param→all retained as an
  API convenience the CLI never triggers.
- `inbox-cli.test.ts`: mock `getConfig`; default query now asserts `?workspace=<current root>`; explicit
  `--workspace` test unchanged.
- `inbox-routes.test.ts`: +1 normalization test (trailing-slash param still matches); scoping/redaction tests
  unchanged.
No `--all`/admin mode (spec intends none; YAGNI). Visibility/corruption invariants untouched (CLI scope +
route normalization only). Verified: build exit 0; **full unit suite 4161 passed / 48 skipped / 0 failed**
(+1 = the new route test). Rebuttal/response at `1313-phase_7-iter2-rebuttals.md`. Next: `porch next` (enter
iter-3) → commit fix → `porch done` → `porch next` (iter-3 consult).

### 2026-08-01 — Phase 7 iter-3 review: Gemini APPROVE, Claude APPROVE(HIGH), Codex REQUEST_CHANGES → fixed
iter-3 fix committed (`905f7071`) → `porch done` green → iter-3 3-way. Architect flagged the Claude consult
truncated on a session limit (empty output); re-ran it → APPROVE/HIGH, no issues. **Codex found a THIRD real
bug** (Gemini+Claude both missed it, both APPROVE): `POST /api/inbox/:id/dismiss` was matched by URL path only
(`tower-routes.ts:302`), and `handleInboxDismiss` took `_req` (unused) with **no method check** — so
`GET /api/inbox/<id>/dismiss` (any method) would dismiss mail. State mutation reachable by GET. Verified against
code — VALID (the GET *list* route is safe: it's in the method-keyed exact-match map; only the dynamic dismiss
route bypassed it). No dispute.
**Fix (1 src + 1 test):**
- `tower-routes.ts` `handleInboxDismiss`: `_req`→`req`; guard `if (req.method !== 'POST') → 405
  { error: 'Method not allowed' }` before any DB mutation — matches the cron action routes' convention
  (`handleCronTaskAction` run/enable/disable, and :515/:582). Docstring notes the dispatch is method-agnostic.
- `inbox-routes.test.ts`: +1 regression test — `GET /api/inbox/<id>/dismiss` → 405, row still `held`, no
  `overview-changed` broadcast.
Porch flow this round: `porch next` emitted a "write rebuttal (iter-3)" task → wrote
`1313-phase_7-iter3-rebuttals.md` (accept+fixed). Verified: build exit 0; **full suite 4162 passed / 48 skipped
/ 0 failed** (+1 405 test; note: had to run from packages/codev — a bare `pnpm test` from the worktree root
hits the root's watch-mode `vitest`). Next: commit fix → `porch done` (re-verify + mark rebuttal) → `porch next`
(iter-4 consult). Codex 3-for-3 on real issues this phase — the 3-way clearly earning its keep.

### 2026-08-01 — Phase 7 FORCE-ADVANCED at iter-3 safety ceiling → now on phase_8
`porch done` (iter-3 rebuttal) tests failed ONCE on a flake: `session-manager.test.ts:1386` "bounds a harness
that exits 0 immediately" — a timing-racy auto-restart test (**untouched by any of my phases**). Verified it
passes in isolation (472ms) but starved to 41.3s under full-suite parallelism. Retried `porch done` → clean
(build 14.5s, tests 28.3s). **No skip needed** (didn't repeat).
Then `porch next` → porch hit its **3-iteration safety ceiling** and **force-advanced** phase_7
(`58bdb65c chore(porch): implement force-advance (safety ceiling reached at iter 3)` → `1691c0e3 advance plan
phase → phase_8`). So phase_7 is ✓ complete but did NOT get a clean unanimous iter — each of iters 1/2/3 had a
distinct, real Codex REQUEST_CHANGES that I fixed (Gemini+Claude APPROVE every round):
  - iter1: escalation didn't fire overview-changed; liveness log-only + no recent-output gate; thin route tests.
  - iter2: `afx inbox` defaulted Tower-wide → violated Baked Decision 8 (workspace-scoped).
  - iter3: `POST /api/inbox/:id/dismiss` had no method guard → GET could dismiss mail.
All committed (last = `af21e608`, the method-guard fix). **Caveat: `af21e608` was committed just before the
force-advance, so it was NOT re-reviewed by a 4th consult.** Working tree clean. Notified architect + asked
whether to proceed into phase_8 (Dashboard + VSCode held-count indicators — UI, needs Playwright) or checkpoint
to review phase_7 first. Holding on phase_8 implementation pending that steer.

### 2026-08-01 — Architect steer: PROCEED into phase_8
Architect verified `af21e608` against code+test (405-before-mutation guard + regression test sound) → iter-4
caveat CLEARED. phase_8 is independent UI; the full phase_7 diff (all iters incl af21e608) still gets its
complete CMAP at the pr-gate before merge. Proceeding to implement phase_8 (Dashboard + VSCode held-count
indicators). Note: `porch next` for a phase-1 implement task emits "Implement: Build artifact" (fresh phase),
not a revision task.

### 2026-08-01 — RESUMED (architect) — phase_8 VSCode side: recon done, design locked
Re-read snapshot + thread. Verified the uncommitted **dashboard side** before building on it (born-dirty):
`HeldCountBadge.tsx`+test present; CSS vars (`--status-waiting`/`--text-muted`/`--text-secondary`) + `@keyframes
cloud-pulse` all exist; `OverviewData.heldCount`(req num)/`mailboxEscalated`(req bool) + `OverviewBuilder.heldCount?`
in types; `useOverview`→`useSSE(poll)` refetches on EVERY SSE event so attention state is automatic. Dashboard solid.
**Mapped the VSCode surface** (extension.ts:355-367 `updateStatusBarCounts`, :405-426 `updateActivityBadge`, :453-458
overview fan-out via `overviewCache.onDidChange`; `OverviewCache.refresh()` fires on EVERY SSE event too →
held-count badge updates live for free). SSE plumbing: Tower emits `{type,body}` envelopes on the `data:` field (no
`event:` name); consumers use `parseSseEnvelope`/`parseSseBody` (sse-envelope.ts). Escalation event = **`mailbox-escalation`**
(confirmed fired at mailbox-wiring.ts:230; payload `MailboxEscalationPayload{workspacePath,toAgent,mailboxId,ageMs,reason}`,
metadata-only per redaction). Precedents: `builder-spawn-handler.ts` (SSE→toast) + `notifications/gate-toast.ts`
(`activateGateToasts` + `codev.gateToasts.enabled` setting).
**Spec Decision 8 (authority):** indicator shows the count of **ALL** currently-held rows (workspace total —
`data.heldCount`, covers architect-addressed mail per-builder sums miss), count-only/read-only (dismissal CLI-only),
a **distinct log-free attention state** on escalation whose visual form is my plan-level choice; clears when the row resolves.
**Design (VSCode):**
- NEW `src/mailbox-indicators.ts` (pure, vscode-free): `heldStatusSegment(count,escalated)` (` · $(mail) N held` /
  `$(warning)` when escalated), `heldTooltipClause`, `escalationToastText(payload)` (metadata only), `escalationMatchesWorkspace`.
- `extension.ts` `updateStatusBarCounts`: append held segment; `statusBarItem.backgroundColor =
  ThemeColor('statusBarItem.warningBackground')` ONLY when escalated (the persistent attention state; clears on resolve
  via overview refetch). `updateActivityBadge`: fold held into the numeric total + append held clause to tooltip (existing
  blocked/idle phrasing preserved verbatim; guard the idle branch for held-only case).
- NEW `src/notifications/mailbox-escalation-toast.ts` `activateMailboxEscalationToasts` (mirrors gate-toast): subscribe
  onSSEEvent → parse → type-guard `mailbox-escalation` → workspace-filter → dedupe by mailboxId → `showWarningMessage`;
  gated by NEW `codev.mailboxEscalationToasts.enabled` (default true, mirrors gateToasts).
- Tests (`src/__tests__/`, vitest `test:unit`): `mailbox-indicators.test.ts` (pure) + `mailbox-escalation-toast.test.ts`
  (vi.mock('vscode'): fires/deduped/workspace-filtered/disabled/wrong-type). VSCode source is app code — NOT skeleton-mirrored.

### 2026-08-01 — Phase 8 iter-1 review: Gemini RC, Codex RC, Claude APPROVE → BOTH points fixed
3-way consult (all HIGH): **Gemini REQUEST_CHANGES** (missing Playwright dashboard test — a hard repo constraint),
**Codex REQUEST_CHANGES** (1: no Playwright for the live indicator; 2: extension.ts badge/status-bar *wiring* untested —
only pure helpers were), **Claude APPROVE** (logic sound; flagged Playwright as a non-blocking minor). 2/3 RC on test
coverage; the logic itself was unanimously called correct. **I was wrong that Playwright was infeasible** — `@playwright/test`
IS installed + chromium cached (`~/.cache/ms-playwright`); the CMAP earned its keep (trust-the-protocol). Fixed BOTH:
- **Playwright (Gemini+Codex-1):** NEW `packages/codev/src/agent-farm/__tests__/e2e/spec-1313-held-count-indicator.test.ts`
  (mirrors spec-823's route-stub pattern): stubs `/api/overview`, asserts the badge across **absent(0) / held(3,no-attn) /
  escalated(1,attn+pulsing-dot) / live-update(2→4 via the useOverview poll, no reload)**. Real chromium, real built
  dashboard bundle. Ran on an **isolated fresh Tower** (port 4137 + isolated `$HOME` so it can't touch the real Tower's
  global.db; `PLAYWRIGHT_BROWSERS_PATH` → real cache; `TOWER_ARCHITECT_CMD=bash`). **First run: 3/4 failed on a
  `route.fetch()` race** (my `/api/state` passthrough was in-flight when the page closed) — NOT an assertion failure. Fix:
  made `/api/state` a STATIC minimal `DashboardState` stub (no passthrough). **Re-run: 4/4 PASS (35.5s).** globalSetup's
  "architect terminal not ready" warning is benign (my tests stub state+overview; no terminal needed).
- **Wiring test (Codex-2):** extracted the inline extension.ts composition into pure `composeStatusBarText` +
  `composeActivityBadge` (mailbox-indicators.ts); the two closures are now thin one-liners calling tested logic. +10 unit
  tests (segment order, `$(warning)` swap, singular/plural blocked/idle phrasing preserved, held fold, undefined-when-empty).
- Verified: vscode check-types clean; indicators+toast **34 pass** (was 24). Rebuttal = concurrence (agreed+fixed both, no dispute).

### 2026-08-01 — Phase 8 IMPLEMENTED (VSCode side) — build + all suites green
Finished the VSCode side per the locked design. Files:
- NEW `apps/vscode/src/mailbox-indicators.ts` (pure, vscode-free): `heldStatusSegment`/`heldTooltipClause`/
  `heldBadgeCount`/`escalationToastText`/`escalationMatchesWorkspace`. All guard `!(n>0)` so an older Tower that
  omits `heldCount` renders nothing (never "undefined held").
- NEW `apps/vscode/src/notifications/mailbox-escalation-toast.ts` `activateMailboxEscalationToasts` — subscribe
  onSSEEvent → parse envelope → type-guard `mailbox-escalation` → workspace-filter → dedupe by mailboxId →
  `showWarningMessage`; gated by NEW setting `codev.mailboxEscalationToasts.enabled` (default true, mirrors gateToasts).
- `extension.ts`: `updateStatusBarCounts` appends held segment (`$(mail)`/`$(warning)` when escalated) + sets
  `statusBarItem.backgroundColor = ThemeColor('statusBarItem.warningBackground')` ONLY when escalated (persistent,
  log-free attention state; auto-clears when the row resolves via overview refetch). `updateActivityBadge` folds
  `heldCount` into the numeric total + appends the held clause to the tooltip (existing blocked/idle phrasing kept
  verbatim; idle branch guarded for the held-only case). `activateMailboxEscalationToasts(context, connectionManager)`
  wired next to `activateGateToasts`. Reads the authoritative workspace `data.heldCount` (covers architect-addressed
  mail a per-builder sum misses). Both surfaces update live for free — `OverviewCache.refresh()` fires on every SSE event.
- `apps/vscode/package.json`: `codev.mailboxEscalationToasts.enabled` config after `gateToasts.enabled`.
- Tests: `src/__tests__/mailbox-indicators.test.ts` (pure, 16) + `src/__tests__/mailbox-escalation-toast.test.ts`
  (vi.mock('vscode'), 8: fires/deduped/diff-id/workspace-filter/wrong-type/malformed/disabled/missing-id).
**Verification:** vscode `check-types` clean; `pnpm compile` (check-types+eslint+esbuild) exit 0; **vscode `test:unit`
667 pass / 56 files** (+24 new); **dashboard `pnpm test` 328 pass / 1 skip / 32 files**; dashboard vite build exit 0;
**`porch check 1313` → ALL CHECKS PASSED (build 14.6s, tests 28.3s)** — porch's `npm run build` builds the dashboard
via packages/codev `build:dashboard`, so my apps/web changes are on the gated path. VSCode is NOT in the root build,
verified via `pnpm compile`.
**⚠️ Playwright gap (plan Test Plan / CLAUDE.md UI mandate).** Live Playwright NOT run: the `playwright` module is not
installed in this worktree and no Tower is running on :4100 (only `packages/codev/playwright.config.ts` exists). The
dashboard delta is a PRESENTATIONAL component (`HeldCountBadge`, RTL-covered: renders count, hides at 0, attention
class on escalate) + a one-line `useOverview()` wiring; its data path (`heldCount`/`mailboxEscalated` on overview,
`overview-changed`/`mailbox-escalation` SSE, live refetch) was built+tested server-side in phase 7. Tower-regression
risk is near-zero — phase 8 touches only apps/web + apps/vscode (no Tower state/server code, cf. Spec 0090). Live
visual verification is deferred to the **verify phase** (post-merge integration). Flagging to architect; CMAP will see
this note. If the architect wants live Playwright now, it needs `playwright` installed + a Tower + a route-stubbed
`/api/overview` (heldCount>0 / mailboxEscalated) — happy to build that harness on request.

### 2026-08-01 — PAUSED (architect) mid-phase_8, dashboard side done + green
Architect asked to pause at a sensible point. Stopped at a clean boundary: **phase_8 dashboard side complete +
verified** (`HeldCountBadge.tsx` + test, `App.tsx` header wired via `useOverview()`, `.held-badge` CSS in
`index.css`; `pnpm --filter @cluesmith/codev-web build` ✓, 328 tests pass). **VSCode side not started; phase_8
uncommitted.** Explored integration points first via a subagent (data all present from phase_7: `heldCount`/
`mailboxEscalated` on OverviewData, `overview-changed`/`mailbox-escalation`/`notification` SSE; useOverview
refetches on any SSE so attention state is free; NO Playwright — dashboard tests are vitest+RTL/jsdom). Saved
high-level state to `state-snapshot.md` (overwritten) and notified architect. Resume: VSCode side → build/test
both apps + Tower regression → commit → `porch done`.
