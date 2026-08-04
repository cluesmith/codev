# spir-1338 — Retire Gemini CLI as a builder harness

## Phase: Specify (started)

Strict-mode SPIR builder. Porch drives; I write artifacts + `porch done`.

### Architect constraint (2026-08-03T19:12Z)
We are NOT cluesmith/codev maintainers on this repo. The PR needs an upstream
maintainer to approve/merge — do NOT expect self-merge. Spec/plan/impl must stand
on their own for external review; architect handles merge coordination.

### Scope (issue #1338)
Retire the standalone **Gemini CLI (`gemini`) builder harness**. NON-goals (leave
alone): `agy`/Antigravity consult lane, `consult -m gemini`, `agy` architect (#1063).
No "Baked Decisions" section in the issue body.

### Verified surface (builder-harness only)
Core: `packages/codev/src/agent-farm/utils/harness.ts`
  - 177-186 `GEMINI_HARNESS` (GEMINI_SYSTEM_MD injection)
  - 212 `gemini:` in `BUILTIN_HARNESSES`
  - 338 `basename.includes('gemini')` in `detectHarnessFromCommand`
  - 358-393 `resolveHarness` (throws generic "Unknown harness" on miss; auto-detect
    branch silently returns CLAUDE_HARNESS on undetected — the footgun)
  - 4-6 module header comment
Config/types: `types.ts:207`, `lib/config.ts:26,28` — `builderHarness?: string` (free-form).
Doctor: `doctor.ts:816-828` — warns only about gemini-as-ARCHITECT; message
  "gemini is supported for builders, not architects" becomes STALE/wrong after retirement.
Reset: `reset/context.ts:414` iterates `Object.keys(BUILTIN_HARNESSES)` to recognize a
  running builder's harness (edge case if gemini leaves the registry).
Tests: `harness.test.ts`, `harness-integration.test.ts`, `discover-resume-session.test.ts`,
  `config.test.ts:138-141`.
Docs (user-facing): `README.md:392,436,448-460` (config example presents gemini builder;
  prose already has a soft "will stop working / follow-up" caveat — strengthen to "retired").
Governance (Review-phase updates): `codev/resources/arch.md:291,311,313,317`,
  `lessons-learned.md:80`.

### Corrections to Explore agent's inventory
- FALSE: `packages/codev/skeleton/resources/commands/agent-farm.md:618-627` "Builder
  harnesses" section naming gemini. That dir does NOT exist on disk; canonical
  `codev-skeleton/resources/commands/agent-farm.md` has no harness/gemini section.
  → No skeleton doc presents gemini as a builder. No dual-tree doc mirror needed for
  this change (only self-hosted `codev/resources/*` governance docs, no skeleton twin).

### Design through-line (for Solution Approaches)
Must recognize `gemini` as a RETIRED name and fail with a SPECIFIC retirement message at
BOTH resolution paths — explicit `builderHarness: "gemini"` AND auto-detected
`builder: "gemini ..."`. A pure delete (a) throws a generic "Unknown harness" on the
explicit path (no retirement explanation) and (b) SILENTLY falls back to CLAUDE_HARNESS on
the auto-detect path (#929-class dangerous mismatch). Recommend a retirement-sentinel in
the resolver + correct doctor's stale builder-support message + fix README example.

## Specify — consult iteration 1 (2026-08-03)
Verdicts: Gemini APPROVE; Codex REQUEST_CHANGES; Claude REQUEST_CHANGES. All substantive
points accepted + incorporated (rebuttal: `codev/projects/.../1338-specify-iter1-rebuttals.md`).
Key decisions locked into the spec:
- **Role-agnostic retirement**: `resolveHarness` (harness.ts:358) has NO role param and is shared
  by getArchitectHarness + getBuilderHarness → sentinel retires gemini for BOTH roles. Correct
  because the CLI is dead for both tiers regardless of role AND gemini-architect is already
  unsupported (doctor warns). Slight broadening beyond "builder-only" mechanism — will flag to
  architect at the gate.
- **Two footgun modes** (not one): remove detector+registry → silent CLAUDE_HARNESS fallback
  (harness.ts:392); remove registry only → undefined/TypeError (harness.ts:387). Sentinel must
  guard BEFORE both exits.
- **Codev product retirement** framing (Codex): consumer tiers (free/Pro/Ultra) ended 2026-06-18;
  Standard/Enterprise + API-key remain → served via CUSTOM HARNESS escape hatch. Not "CLI is gone."
- **Doctor**: redefine the gemini branch (premise inverts), ADD builder-side flagging, assert on
  structured issue:/recommendation: fields (doctor.ts:826), not console text.
- **afx reset**: DECIDED/accepted — gemini leaves BUILTIN_HARNESSES → reset won't recognize a
  pre-existing gemini builder → declines. Fine (retired harness can't reset anyway).
- **Tests**: cover getBuilderHarness, --builder-cmd gemini, array-form builder cmd, architect twin;
  coverage-by-replacement; doc-consistency criterion scoped (exempt historical + consult lane).
Next: porch done → re-verification. Expecting spec-approval gate soon → STOP for human approval.

## Spec APPROVED (2026-08-03) + architect confirmation
Human approved spec-approval gate. Architect confirmed role-agnostic retirement (one sentinel,
no role param), independently verified the footgun analysis, reaffirmed agy/consult out of scope
+ external-maintainer merge (no self-merge).

## Plan — consult iteration 1 (2026-08-03)
Verdicts: Gemini APPROVE; Codex REQUEST_CHANGES; Claude COMMENT. All points accepted; restructured
3→4 phases. Rebuttal: `codev/projects/.../1338-plan-iter1-rebuttals.md`. Key corrections (all
re-verified against source):
- **Precedence FIX**: resolveHarness is built-in→custom→unknown today; keep that. Correct order:
  built-in → custom → retired → generic throw. (My draft wrongly put custom before built-in.)
- **Spawn preflight**: spawn.ts resolves builder harness at :471 AFTER createWorktree(:429/431) +
  initPorch(:442). Need preflight BEFORE state mutation → no orphaned worktree/porch on rejected
  gemini spawn. Test asserts no state created.
- **4 getArchitectHarness sites** (tower-utils.ts): :179 buildArchitectArgs (launch), :291
  siblingRegistrationIsLive (PREDICATE — guard→return false, don't throw), :357 resolveArchitectLaunch
  (launch), :509 freshLaunch closure (launch). Per-site behavior, not blanket.
- **Doctor NOT override-aware**: reads raw persisted shell.* (not CLI/env). Scope to persisted-config.
- **2nd BUILTIN_HARNESSES consumer**: harnessProviderFor (agent-farm/commands/reset/context.ts:468)
  → null post-removal → reset refuses (accepted, no code change). Full path corrected.
- **CHANGELOG**: [Unreleased] section is live → add breaking-change entry (Phase 4).
- Escape hatch: custom `gemini` resolves ONLY via explicit builderHarness:"gemini"; auto-detect stays retired.

4 phases: (1) resolver core+tests (2) fail-closed spawn/launch (no orphaned state / no Tower crash)
(3) doctor (4) README+CHANGELOG. Governance arch/lessons → Review phase.
Next: porch done → re-verify → plan-approval gate → STOP for human approval.

## Plan APPROVED (2026-08-03) → Implement phase_1
Architect cleared plan-approval and locked two decisions (do NOT re-open):
1. Role-agnostic retirement via shared resolver — no role param.
2. Full architect-side handling in tower-utils.ts: guard siblingRegistrationIsLive (:291)
   → return false AND fail gemini-architect launches with the retirement (scope catch to the
   retirement error, rethrow others; regression-test claude/codex). [phase 2]
Governance arch/lessons deferred to Review. Small self-contained commits (external merge).

### phase_1 — retire gemini in the shared resolver (harness.ts + resolver/config tests)
Blast radius verified: GEMINI_HARNESS imported only by harness.ts (prod) + harness.test.ts,
harness-integration.test.ts, discover-resume-session.test.ts. config.test.ts uses the 'gemini'
STRING (not the export). All other gemini test refs = consult/bench/image lanes (out of scope)
or doctor.ts (phases 2–3). Two comment-only refs to sweep: spawn-worktree.test.ts:344,
tower-instances.test.ts:612 ("codex/gemini builders…").
Implementation:
- harness.ts: + RETIRED_HARNESSES registry (gemini→message w/ 2026-06-18 cause, claude/codex/
  opencode alternatives, custom-harness escape hatch, #1338) + isRetiredHarness/getRetirement/
  throwRetired (own-property check, prototype-safe). Removed GEMINI_HARNESS + its BUILTIN entry.
  Kept gemini in detectHarnessFromCommand. resolveHarness: explicit = builtin→custom→retired→
  generic throw; auto-detect = retired-check BEFORE BUILTIN_HARNESSES[detected]. Fail closed —
  never CLAUDE_HARNESS, never undefined. Updated module header + resolver doc comment.
- Tests updated: harness.test.ts (retirement + escape-hatch + built-in-not-shadowed +
  isRetiredHarness/getRetirement incl. prototype-safety), harness-integration.test.ts
  (Scenario 3 → retirement; kept codex no-GEMINI_SYSTEM_MD guard; Scenario 8 → call-site
  propagates retirement via mockImplementationOnce(throwRetired)), discover-resume-session.test.ts
  (gemini regression guard → opencode, same intent), config.test.ts (vi.hoisted mutable shell
  mock → --builder-cmd/--architect-cmd/explicit builderHarness/array-form all fail closed +
  message content; #929 builder test re-pointed gemini→codex to keep override-awareness).
  Swept 2 comment-only refs (spawn-worktree.test.ts, tower-instances.test.ts).
- Env gotcha (recorded for siblings): fresh worktree had NO node_modules and codev-core
  was unbuilt. Fix: `pnpm install --frozen-lockfile` (root) then build codev-core BEFORE codev
  (`pnpm --filter @cluesmith/codev-core build`). Without core built, ~all unit suites fail with
  `Cannot find package '@cluesmith/codev-core/*'` + `Skeleton directory not found` — purely
  environmental, not code. Also: `pnpm test -- run <files>` injects a stray `--` that makes
  vitest ignore path filters; use `pnpm --filter @cluesmith/codev exec vitest run <files>`.
- VERIFIED: `pnpm --filter @cluesmith/codev build` exit 0 (tsc clean). 4 target files 98/98.
  Full unit suite (excl. e2e) 4116 passed / 48 pre-existing skips / 0 failed. GEMINI_HARNESS
  fully gone (grep clean). Next: porch check → porch done (build-complete) → 3-way consult.

### phase_1 CONSULT — iter1 UNANIMOUS APPROVE (2026-08-03)
Gemini APPROVE/HIGH, Codex APPROVE/HIGH, Claude APPROVE/HIGH. No change requests. Porch advanced
to phase_2. NOTE: porch's chore commits only touch status.yaml — the builder commits the phase CODE
(phase_2 precondition: "previous phase committed"). Committing phase_1 code as its own commit.

## phase_2 — fail closed at spawn/launch boundaries (no orphaned state, no Tower crash)
Confirmed line refs vs source:
- spawn.ts worktree-creating entry points: spawnSpec(:314), spawnTask(:500), spawnProtocol(:575),
  spawnWorktree(:658), spawnIssueDrivenBuilder(:718). spawnShell(:633) creates NO worktree.
  getBuilderHarness currently at :471 / :850 (AFTER state creation). Plan's ~:506/:583/:662/:764
  drifted; real functions above.
- tower-utils.ts getArchitectHarness sites: buildArchitectArgs(:174 def,:179 call),
  siblingRegistrationIsLive(:286 def,:291 call — PREDICATE, guard→false),
  resolveArchitectLaunch(:334 def,:357 call), freshLaunch closure(:509 call).
Design: new `assertBuilderHarnessNotRetired(workspaceRoot?)` in config.ts (mirrors resolveHarness
precedence: builtin→return, custom-same-name→return escape hatch, retired→throwRetired, unknown→
defer to later call). Call it at top of each worktree-creating spawn fn BEFORE ensureDirectories/
createWorktree/initPorch. Architect: guard siblingRegistrationIsLive (catch retirement→false,
rethrow others); launch boundary (buildArchitectArgs) already throws retirement via getArchitectHarness
— make it a clean scoped error. Regression-test claude/codex both roles.

### phase_2 FINALIZED design (post source-trace, 2026-08-03)
Traced every caller of the 5 spawn handlers + 4 getArchitectHarness sites. Refinements vs draft:
- **SPAWN preflight = ONE guard in the `spawn()` DISPATCHER** (spawn.ts:921, after getSpawnMode),
  gated `if (mode !== 'shell')`, before `handlers[mode]()`. Cleaner + safer than per-fn: ALL 7
  createWorktree calls live in the 5 handlers, ALL under the dispatcher; shell is the only
  worktree-less mode. CRUCIAL: `createWorktree` internally calls getBuilderHarness at
  spawn-worktree.ts:912 (BEFORE spawn.ts:471) — so the preflight MUST precede handler dispatch or a
  gemini spawn orphans a half-built worktree. `assertBuilderHarnessNotRetired` already in config.ts
  (uncommitted), re-exported via utils barrel (`export * from './config.js'`). Add to spawn.ts:20 import.
- **siblingRegistrationIsLive (tower-utils.ts:291)**: real guard — try getArchitectHarness, catch
  RetiredHarnessError→return false (retired reg not live → reconcile prunes it), rethrow others.
  Verified: uncaught throw here is caught by tower-instances.ts:809 `catch(siblingErr)` but aborts the
  WHOLE sibling-reconcile pass for ALL architects — guard also stops the gemini row from reaching the
  addArchitect launch at :804 (pruned+continue at :797/:802 first).
- **Launch sites throw = correct fail-closed** (retired architect must not launch; RetiredHarnessError
  .message IS the full retirement text). Entry-point surfacing:
  · launchInstance (tower-instances.ts:564) → already clean via try/catch :814 → `{success:false,
    error:"Failed to launch: <msg>"}`. No change.
  · **addArchitect (tower-instances.ts:1070)** → NOT wrapped; throws out to tower-routes.ts:547 (HTTP)
    + workspace-add-architect CLI. GAP the snapshot missed. FIX: scoped try/catch around
    resolveArchitectLaunch → RetiredHarnessError→return `{success:false, error: err.message}`, rethrow
    others. Mirrors launchInstance, scoped. No persistent state created before :1070 (name/cmd resolve
    only) → clean bail.
  · architect() no-Tower CLI (architect.ts:31 buildArchitectArgs) → throw propagates to afx top-level
    (prints .message, same path as today's "Unknown harness"). No new gap; leave as-is.
  · freshLaunch.next() (tower-utils.ts:509) → only a shellper rerun of an ALREADY-running architect;
    unreachable for gemini (initial launch threw first). No change.
- **buildArchitectArgs (:179)**: fail-closed DOC COMMENT only — the getArchitectHarness throw is
  intentional; re-wrapping would just duplicate the message. Callers surface `.message`.
- Imports: tower-utils.ts:18 add `RetiredHarnessError` (value) from ../utils/harness.js;
  tower-instances.ts add same import.
- Reset consumers (reset/context.ts:414/:468): NO change (plan-verified degrade).

### phase_2 IMPLEMENTED + VERIFIED (2026-08-03)
Production edits:
- spawn.ts: import `assertBuilderHarnessNotRetired`; dispatcher guard `if (mode !== 'shell')` before
  `handlers[mode]()`.
- tower-utils.ts: import `RetiredHarnessError`; siblingRegistrationIsLive try/catch
  (RetiredHarnessError→false, rethrow); buildArchitectArgs fail-closed doc comment.
- tower-instances.ts: import `RetiredHarnessError`; addArchitect scoped try/catch around
  resolveArchitectLaunch (retirement→`{success:false,error}`, rethrow others).
- (config.ts assertBuilderHarnessNotRetired + harness.ts RetiredHarnessError were the pre-existing
  uncommitted phase_2 groundwork — now part of this commit.)
Tests (+12, coverage-by-addition):
- config.test.ts (+6): assertBuilderHarnessNotRetired — aborts on gemini (cmd/explicit/array),
  no-op for claude+codex, DEFERS (no throw) on unknown harness.
- tower-utils.test.ts (+4): siblingRegistrationIsLive→false (no throw) for gemini; buildArchitectArgs
  throws retirement for gemini, no-throw for codex+claude. (Fixed 1 over-strict assert: buildArchitectArgs
  loads the role from BUNDLED skeleton roles, so codex injects `-c model_instructions_file` — assert
  baseArgs preserved at front, not equality.)
- tower-instances.test.ts (+2): launchInstance + addArchitect both return `{success:false,/retired/i}`
  for a gemini architect, createSession NOT called (HOME isolated so global config can't mask).
E2E manual verify (strongest "no orphaned state" proof): scratchpad/verify-spawn-gemini.mjs drives the
REAL built `spawn()` against a REAL temp workspace (`.codev/config.json` builderHarness=gemini, real
config loader, no mocks) → threw RetiredHarnessError + 0 `.builders/` + 0 codev/projects state. PASS.
Results: `pnpm --filter @cluesmith/codev build` exit 0 (tsc clean). Full unit suite 4128 passed / 48
pre-existing skips / 0 failed (was 4116; +12 mine). freshLaunch(:509) left untouched — unreachable for
gemini (launchInstance/addArchitect throw at resolveArchitectLaunch BEFORE buildArchitectFreshLaunch is
even constructed).

### phase_2 committed + integration test added
- d200edf6 `[Spec 1338][Phase: phase_2] feat: fail closed at spawn/launch boundaries` (prod + 3 unit files).
- porch check/done → build+tests green → build-complete chore (906ff8ca).
- Promoted the scratchpad e2e proof into a COMMITTED regression test: spawn-retirement.test.ts drives the
  REAL spawn() (real temp git workspace, real config loader, no mocks) → rejects gemini with the
  retirement AND asserts 0 `.builders/` + 0 codev/projects afterward. Catches the regression class the
  unit tests miss (guard moved below state creation). Confirmed importing real spawn() in vitest is clean
  (no side-effect hang) — the spawn.test.ts "avoid side-effect import" caution doesn't bite here because
  the guard throws before Tower/GitHub are touched. Committed as a 2nd phase_2 commit (porch chore was on
  top of d200edf6, so amend wasn't clean). Next: porch next → 3-way consult (verification).

### phase_2 CONSULT iter1: Gemini APPROVE, Claude APPROVE/HIGH, Codex REQUEST_CHANGES/HIGH
Codex found TWO REAL gaps my "unreachable" analysis missed — both on RESTART/RECONNECT paths (not
initial launch), reachable when a config is edited to gemini mid-session OR Tower restarts reading a
gemini config. Verified against source (both confirmed):
1. FAIL-OPEN: resolveArchitectRestart (tower-utils.ts:455) propagates RetiredHarnessError, but BOTH
   consumers (tower-terminals.ts:717 _reconcileTerminalSessionsInner, :982 getTerminalsForWorkspace)
   catch ALL harness errors and fall back to restartOptions = { command: cmdParts[0] (= gemini),
   args: cmdParts.slice(1) } — actually relaunching the retired gemini binary (no role injection).
2. UNCAUGHT THROW: buildArchitectFreshLaunch.next() (tower-utils.ts:533) resolves the harness unguarded;
   session-manager.ts:1175 calls freshLaunch?.next() with NO try/catch → clean-exit relaunch of an
   architect whose config flipped to gemini throws into the exit handler → Tower exception.
Claude(APPROVE) flagged #2 as non-blocking ("unreachable in practice"); Codex(HIGH) is right it IS
reachable via config-change-before-clean-exit. Fixing both (Codex asks: fail closed + clean error
surfacing + regression tests for reconnect AND clean-exit paths).
FIX (all logic in tower-utils.ts; tower-terminals just calls the new helper):
- Fix 2: guard getArchitectHarness in buildArchitectFreshLaunch.next() → RetiredHarnessError → log +
  return plain { args: baseArgs, env: baseEnv } (no throw, no retired injection; baseArgs are the ORIGINAL
  supported-harness launch's, so never gemini).
- Fix 1: extract the 2 duplicated consumer try/catch blocks into ONE exported helper
  buildArchitectReconnectRestartOptions({workspacePath, architectName, cmdParts, cleanEnv,
  includeFreshLaunch, log}) in tower-utils (co-located w/ resolveArchitectRestart family; imports
  ReconnectRestartOptions type from session-manager — no cycle). Fails CLOSED on RetiredHarnessError
  (return undefined → session reconnects to a live process if any, but NEVER auto-restarts into gemini);
  keeps the plain-command fallback for OTHER harness errors. Both tower-terminals sites call it
  (includeFreshLaunch: site1=true, site2=false — preserves each site's behavior; unifies only the
  cosmetic Resuming-log text).
- Tests (tower-utils.test.ts): buildArchitectFreshLaunch.next gemini→plain/no-throw + codex/claude
  unchanged; buildArchitectReconnectRestartOptions gemini→undefined, codex/claude→opts w/ command,
  unknown→plain fallback, includeFreshLaunch toggles freshLaunch.

### phase_2 iter1 fixes COMMITTED + rebuttal written (2026-08-03, resumed session)
Resumed from state-snapshot.md. Re-verified the uncommitted Codex fixes against source (diffs clean;
no stray usages of the 3 dropped tower-terminals imports) and independently re-ran checks BEFORE
committing: build exit 0 (tsc+vite); tower-utils.test.ts 61/61 (incl. +7 new #1338 tests); consumer
suites tower-terminals+tower-instances+bugfix-430-tower-restart 133/133 (refactor = no regression).
- Committed `11527838` [Spec 1338][Phase: phase_2] fix: fail closed on architect restart/reconnect.
- Wrote 1338-phase_2-iter1-rebuttals.md: both Codex points accepted+fixed; Claude's non-blocking
  (a) dispatcher-centralized preflight + (b) session-manager.ts:1175 freshLaunch.next() — note (b) is
  the SAME site as Codex C2, now actively guarded (not "unreachable by design"). Both recorded for the
  final review doc. Gemini/Claude approvals stand.
NOTE: line refs in the iter1 consult note above are pre-fix (tower-utils.ts:455/533, etc.); post-fix
refs are in the rebuttal (helper def :589, freshLaunch guard :544, reconnect guard :630).
Next: porch done 1338 → re-verification → iter2 3-way consult on the fixed code.

### phase_2 CONSULT iter2: Gemini APPROVE, Claude APPROVE/HIGH, Codex REQUEST_CHANGES/HIGH
Codex found a THIRD, deeper gap (C3) that the iter1 C2 fix missed AND both approving reviewers missed.
Verified real against source:
- C3 FAIL-OPEN (clean-exit relaunch): my iter1 C2 fix returned {args,baseEnv} from
  buildArchitectFreshLaunch.next() on retirement — stops the throw but NOT the relaunch. FreshLaunch.next()
  can only change args/env; session-manager.ts RETAINS session.options.command and respawns it. If the
  retained command IS the retired binary (custom `gemini` harness later removed, or config flip before a
  clean exit), gemini is respawned. Claude's iter2 "safe: freshLaunch only wired when harness resolved
  cleanly" reasoning missed that a CUSTOM gemini resolves cleanly at wire time.
FIX (commit 9ec14c4d):
- Extended FreshLaunch contract with a fail-closed `{ stop: true }` (session-manager.ts:73) — the only way
  a factory can prevent a respawn it can't re-command. Clean-exit handler honors it (:1184): no respawn,
  removeDeadSession, surface reason via session-gave-up → PtySession.notice (same UX as fast-exit valve).
- buildArchitectFreshLaunch.next() returns { stop: true } on RetiredHarnessError (tower-utils.ts:551).
- E2E regression (session-manager.test.ts:2493): real clean-exit handler, retained command:"gemini",
  {stop:true} freshLaunch → spawn NOT called, session removed, `retired` reason surfaced. (iter1 test only
  checked returned args — missed the retained command, exactly Codex's ask.)
- Addressed Claude's non-blocking nit: isolateHarnessEnv() (HOME + TOWER_ARCHITECT_CMD/TOWER_BUILDER_CMD)
  wired into all three retirement describes in tower-utils.test.ts.
- Blast radius: FreshLaunch is architect-only (1 implementer, 1 consumer) — contained core change.
- Verified: build exit 0; tower-utils+session-manager 152/152; consumers 133/133.
Wrote 1338-phase_2-iter2-rebuttals.md. Next: porch done → re-verify → iter3 consult.

### phase_2 CONSULT iter3: UNANIMOUS APPROVE (Gemini APPROVE, Codex APPROVE/HIGH, Claude APPROVE/HIGH)
Codex (the C1/C2/C3 finder) now: "Phase 2 fails closed across builder spawn, architect launch, reconnect,
and clean-exit paths, with adequate regression coverage. KEY_ISSUES: None." Claude independently verified
tsc exit 0 + 283/283 affected suites. All four retirement boundaries fail closed: spawn preflight (builder),
buildArchitectArgs launch (architect), buildArchitectReconnectRestartOptions→undefined (reconnect),
buildArchitectFreshLaunch.next()→{stop:true} (clean-exit). Phase_2 DONE.
CLAUDE's 4 non-blocking notes → carry to REVIEW doc (codev/reviews/1338-*.md), do NOT fix now (all 3
approved; fixing = wasteful re-consult of an approved phase):
1. siblingRegistrationIsLive→false PRUNES persisted sibling rows for a retired-architect config (matches
   approved plan; deliberate trade-off; `true`="unlaunchable not dead" is the conservative alt if it bites).
2. CRASH-restart path (non-clean exit) respawns launch-time-baked args, never re-resolves harness → a
   retained custom-`gemini` (later removed) can crash-restart gemini. IN-SPEC ("already-running sessions
   unaffected"), no mis-injection risk (baked args are from that custom harness). Documented trade-off,
   NOT a gap — distinct from C3's clean-exit path which MINTS a fresh session (re-resolves → retirement matters).
3. --shell exemption correct (startShellSession resolves no harness; gemini shell.builder runs bare; Phase 3
   doctor covers user education).
4. Minor test gap: no POSITIVE test that a supported-harness config PASSES the preflight — optional 1-liner
   in spawn-retirement.test.ts to lock the "doesn't over-block" half. Consider in Review-phase refinement.
Next: porch next → advance to phase_3 (doctor: retirement guidance + builder-side flagging).

## phase_3 — codev doctor: retirement guidance + builder-side flagging
Porch advanced phase_2→phase_3 (89d25fca). doctor.ts is at packages/codev/src/commands/doctor.ts
(NOT commands/doctor.ts under agent-farm — plan/spec path was loose); stale gemini branch was at :816-828
("The Gemini CLI is retiring (#778); gemini is supported for builders, not architects").
IMPLEMENTED (packages/codev/src/commands/doctor.ts):
- Added getRetirement to the harness import (already had detectHarnessFromCommand).
- Factored a shared local `resolvedShellHarness(role)` helper (raw shell.<role>/<role>Harness, array-or-string,
  via detectHarnessFromCommand) used by BOTH architect+builder branches → no drift. NOT override-aware
  (reads raw persisted config, not CLI/env) — matches spec's persisted-config scope.
- getRetirement() truthiness = single source of truth for "retired" (returns msg iff retired). Architect
  branch: opencode (unchanged) → retired (both-role framing + full retirement msg, replaces the inverted
  "builder-only" text) → codex (unchanged). NEW builder branch: flags a retired builder harness.
- Updated structured issue:/recommendation: strings (stable assertion target): "<h> configured as
  {architect,builder} shell (harness retired)".
TESTS (doctor.test.ts, +4, new describe 'shell-harness retirement flagging (#1338)'): gemini builder →
structured issue/rec + 2026-06-18 surfaced; gemini architect → structured issue/rec + asserts NO
"supported for builders"/"builder-only"; explicit builderHarness:gemini detected; supported (claude
builder+codex architect) → no "harness retired". Workspace fixture: codev/ marker + .codev/config.json,
chdir, mocked child_process (modeled on existing structure-checks describe).
VERIFIED: build exit 0; doctor.test.ts 21/21 (17 existing + 4 new). Doctor never calls resolveHarness so
it never throws — detects+reports only. Next: porch check → done → iter1 3-way consult.

### phase_3 CONSULT iter1: Gemini APPROVE, Codex REQUEST_CHANGES/HIGH, Claude REQUEST_CHANGES/HIGH
Two blockers, both accepted; the reviewers converged:
1. CORRECTNESS (Codex C1 + Claude #1): doctor false-flagged the sanctioned custom-`gemini` escape
   hatch — `resolvedShellHarness` returned only a name and the caller ran `getRetirement` on it
   unconditionally, ignoring `config.harness`. So explicit `builderHarness/architectHarness: "gemini"`
   backed by a custom `harness.gemini` def was reported retired even though it resolves + spawns fine
   (contradicts resolveHarness precedence built-in→custom→retired, and the retirement msg's own
   "configure a custom harness" advice).
2. TEST-QUALITY (Claude #2): the new negative test was vacuous — chalk mock lacked `gray`, so the
   codex-architect "supported" branch (`chalk.gray`) threw into the shell-section `catch {}` BEFORE the
   builder branch ran; the "supported-config not flagged" test asserted nothing about its guarded path.
Also: Claude #3 recommendation misdirects on the explicit-harness path (explicit <role>Harness beats
the command); Claude #4 nits (no array-form test; duplicate retirement paragraph when both roles gemini).

### phase_3 iter1 fixes IMPLEMENTED + VERIFIED (resumed from state-snapshot.md)
Production (doctor.ts): `resolveShell(role)` now returns `{ name, retirement }` and encodes the
resolver's precedence so doctor can't drift from spawn:
- explicit `shell.<role>Harness` with a `config.harness` own-prop of that name ⇒ retirement suppressed
  (escape hatch honored; prototype-safe hasOwnProperty check);
- auto-detected `shell.<role>` command ⇒ retirement ALWAYS applies (never consults custom harnesses —
  mirrors resolveHarness's auto-detect-is-always-retired rule);
- both role recommendations + inline guidance now name `shell.<role>` AND `shell.<role>Harness`.
Tests (doctor.test.ts): +`gray` to chalk mock; STRENGTHENED the supported-config test with a POST-gray
assertion (`Select the architect harness via .codev/config.json …`) — the `✓ supported` line prints
BEFORE the gray call so it can't detect the vacuity; the post-gray line proves the section completed and
the builder branch was reached. Empirically confirmed: removing `gray` makes the test FAIL on that
assertion, restore → green. Added escape-hatch tests (builder + architect), the crucial
auto-detect-gemini-with-custom-harness-STILL-flagged distinction, and an array-form test; updated the 2
recommendation assertions to both-selector wording.
VERIFIED: build exit 0; doctor.test.ts 25/25; full unit suite (excl e2e) 4145 passed / 48 skipped / 0
failed. Wrote 1338-phase_3-iter1-rebuttals.md. Next: commit fix + docs → porch check → done → next →
iter2 3-way consult on the fixed code.
Committed `3119e93f` (fix: escape hatch + non-vacuous tests) + `92d1f5d8` (docs: rebuttal + thread).
NOTE on porch flow: on resume, porch was still at iter1 pre-re-iteration (the earlier session had
launched the iter1 consult but paused before porch recorded verdicts). Running porch check→done→next
consumed the on-disk iter1 verdicts, re-iterated to iter2, and emitted the "fix iter1 issues" task —
which my committed fixes already satisfy. Re-ran porch check→done→next for iter2 → fresh 3-way consult
on the fixed HEAD (rebuttal passed as reviewer context).

### phase_3 CONSULT iter2: UNANIMOUS APPROVE (Gemini APPROVE/HIGH, Codex APPROVE/HIGH, Claude APPROVE/HIGH)
Codex (the C1 finder): "correctly diagnoses retired Gemini harnesses for both roles, preserves the
explicit custom-harness escape hatch, robust regression tests. KEY_ISSUES: None." Gemini: all iter1
feedback addressed. Claude INDEPENDENTLY re-verified both disputed findings from disk — including
empirically commenting out the gray mock and confirming the supported-config test fails at the POST-gray
assertion (doctor.test.ts:756) while the 'supported' line still passes → validated the strengthened guard
is the correct one, not just the mock addition. Build + full suite green (4145/0).
CLAUDE's 3 non-blocking notes → carry to REVIEW doc (do NOT fix in approved phase_3; fixing = wasteful
re-consult):
1. doctor.ts:790 block comment still reads "Warn if OpenCode… (unsupported)" but the block now covers
   opencode + retirement (both roles) + codex + builder flagging. One-line comment refresh next time the
   file is touched.
2. resolveShell uses hasOwnProperty vs resolveHarness's `in` — harmless (doctor's form is safer under
   prototype pollution). Leave it.
3. Doctor is persisted-config-only by design (TOWER_BUILDER_CMD=gemini not flagged; spawn still rejects
   it) — decided at plan review + documented in the code comment. Don't re-litigate at PR.
porch advanced phase_3 → phase_4 (chore 1648db64). phase_3 DONE.

## phase_4 — user-facing docs: README + CHANGELOG (started)
Final implement phase. Scope: README (:392 "other shells" line; :433-436 autonomous-flags table gemini
row; :448-460 config example — both architect+builder lines + prose → retired framing with custom-harness
pointer, PRESERVE the agy consult-lane note) + CHANGELOG [Unreleased] Removed/breaking-change entry with
migration pointer + scoped doc-consistency grep (EXEMPT historical artifacts codev/specs|plans|reviews|
projects|docs/releases + every `consult -m gemini`/`agy` ref; re-grep BOTH codev/ AND codev-skeleton/).
Governance arch/lessons (arch.md :291/:311-317, lessons-learned.md :80) → Review phase via update-arch-docs.
