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
