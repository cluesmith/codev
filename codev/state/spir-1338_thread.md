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
