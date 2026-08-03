# Plan: Retire Gemini CLI as a Builder Harness

## Metadata
- **ID**: plan-2026-08-03-retire-gemini-cli-builder
- **Status**: draft
- **Specification**: [codev/specs/1338-retire-gemini-cli-as-a-builder.md](../specs/1338-retire-gemini-cli-as-a-builder.md)
- **Created**: 2026-08-03
- **Issue**: #1338

## Executive Summary
Implement the spec's recommended **Approach 1 — a retirement sentinel in the shared harness
resolver**. `resolveHarness` (`agent-farm/utils/harness.ts`) is role-agnostic and shared by both
`getArchitectHarness` and `getBuilderHarness`, so a single retired-name registry, consulted on every
resolver exit, retires `gemini` for **both** roles (architect-path retirement explicitly accepted by
the architect, 2026-08-03). Selecting `gemini` — by explicit `builderHarness`/`architectHarness` or by
auto-detection from a `gemini …` command (string or array form) — fails **closed** with one clear
retirement message, never a silent Claude fallback (harness.ts:392) and never an `undefined`/TypeError
(harness.ts:387).

The retirement then surfaces cleanly where a user meets it: a builder **spawn preflight** rejects it
*before* any worktree/porch/db state is created (resolution currently happens at spawn.ts:471, after
`createWorktree`/`initPorchInWorktree` — a raw throw would orphan state); the four `getArchitectHarness`
call sites are handled per-site so a gemini architect fails cleanly without crashing Tower; `codev
doctor` diagnoses it for both roles; and the README + CHANGELOG stop presenting Gemini as a supported
builder. The `agy` / `consult -m gemini` subsystem is untouched.

Four phases, each an independently committable unit that leaves `build` + the full test suite green.
(Committable ≠ individually shippable: after Phase 1 the resolver throws but nothing surfaces it yet —
do not stop before Phase 3.)

## Success Metrics
Copied from the spec's Success Criteria, plus implementation-specific checks:
- [ ] `gemini` removed from `BUILTIN_HARNESSES` and absent from the resolver's "Available harnesses"
      listing (spec criterion 1).
- [ ] Explicit `builderHarness: "gemini"` → clear **retirement** error naming alternatives (criterion 2).
- [ ] Auto-detected `builder: "gemini …"` (string form) → same retirement error; **neither**
      `CLAUDE_HARNESS` **nor** `undefined` returned (criterion 1+2; both footguns closed).
- [ ] Real config paths fail closed: `getBuilderHarness`, `--builder-cmd gemini`, and **array-form**
      `builder: ["gemini", "--yolo"]`.
- [ ] Architect path fails closed: `getArchitectHarness` / `--architect-cmd gemini`.
- [ ] A rejected gemini **spawn creates no worktree/porch/db state** (preflight before mutation).
- [ ] A gemini **architect** config fails cleanly at every `getArchitectHarness` site — no uncaught
      Tower crash (including the non-launch predicate at tower-utils.ts:291).
- [ ] `codev doctor` no longer says gemini is "supported for builders"; it presents the retirement and
      flags a `gemini` **builder** config, verified via structured `issue:`/`recommendation:` fields.
- [ ] README "other shells" line, autonomous-flags table, and **both** architect+builder config-example
      lines updated; a CHANGELOG `[Unreleased]` entry records the breaking change.
- [ ] Claude, Codex, OpenCode, and custom harnesses resolve/spawn unchanged (criterion 3); a custom
      `gemini` definition still resolves via explicit selection (escape hatch).
- [ ] Each removed gemini test is **replaced** by a retirement-behavior test (coverage-by-replacement).
- [ ] Governance docs (`arch.md`/`lessons-learned.md`) updated (Review phase, via `update-arch-docs`).
- [ ] `agy` / `consult -m gemini` untouched; `pnpm --filter @cluesmith/codev build` + full test suite green.

## Phases (Machine Readable)

<!-- REQUIRED: porch uses this JSON to track phase progress. -->

```json
{
  "phases": [
    {"id": "phase_1", "title": "Retire gemini in the shared resolver (core + resolver/config tests)"},
    {"id": "phase_2", "title": "Fail closed at spawn/launch boundaries (no orphaned state, no Tower crash)"},
    {"id": "phase_3", "title": "codev doctor: retirement guidance + builder-side flagging"},
    {"id": "phase_4", "title": "User-facing docs: README + CHANGELOG"}
  ]
}
```

## Phase Breakdown

### Phase 1: Retire `gemini` in the shared resolver (core + resolver/config tests)
**Dependencies**: None

#### Objectives
- Make `gemini` a **retired** harness name that fails closed on every `resolveHarness` exit, for both
  builder and architect resolution, with one clear retirement message — without changing precedence
  for any supported harness.
- Remove the `GEMINI_HARNESS` provider and its registry entry; expose a small `isRetiredHarness`/
  `getRetirement` predicate for downstream preflights (Phases 2–3).

#### Deliverables
- [ ] `agent-farm/utils/harness.ts`:
  - [ ] New retired-names registry, e.g. `RETIRED_HARNESSES: Record<string, string>` (name →
        explanation), plus an exported `getRetirement(name): string | undefined` (and/or
        `isRetiredHarness(name): boolean`) and a helper that throws a consistent retirement `Error`.
  - [ ] Remove the `GEMINI_HARNESS` provider (harness.ts:177-186) and the `gemini:` entry in
        `BUILTIN_HARNESSES` (:212).
  - [ ] **Keep** the `gemini` case in `detectHarnessFromCommand` (:338) — it is what makes both the
        auto-detect retirement *and* doctor's diagnosis work (doctor resolves via the detector, not
        `resolveHarness`).
  - [ ] Update `resolveHarness` with the **exact precedence below** (this corrects the ordering the
        reviewers flagged).
  - [ ] Update the module header comment (:4-6) to drop Gemini from the "built-in providers" list.
- [ ] Replace/adjust affected tests (retirement behavior, not `GEMINI_HARNESS`):
  - [ ] `__tests__/harness.test.ts` — drop the `GEMINI_HARNESS` import + describe block and the
        `resolveHarness('gemini')` / auto-detect-gemini / explicit-beats-detect assertions; add:
        explicit `gemini` throws retirement; auto-detected `gemini …` throws retirement and returns
        **neither** `CLAUDE_HARNESS` **nor** `undefined`; an unrelated unknown name still throws the
        **generic** "Unknown harness" error; `detectHarnessFromCommand('gemini')` still returns
        `'gemini'`; **custom `gemini` (explicit) resolves to the custom provider**; **built-in
        precedence preserved** (a custom `claude`/`codex`/`opencode` does NOT shadow the built-in).
  - [ ] `__tests__/harness-integration.test.ts` — replace the `GEMINI_SYSTEM_MD` / gemini-script
        assertions (:116-125, :242-249) with a retirement assertion; keep the codex "no
        `GEMINI_SYSTEM_MD`" guard.
  - [ ] `__tests__/discover-resume-session.test.ts` — the gemini regression guard (:106-112) imports
        `GEMINI_HARNESS`; re-express with a still-valid non-resuming harness (codex) or delete if
        fully subsumed, preserving the "no stale-Claude-jsonl resume for non-claude harnesses" intent.
  - [ ] `__tests__/config.test.ts` — `--builder-cmd gemini` (:138-141) now asserts the **retirement
        throw** from `getBuilderHarness`; add `--architect-cmd gemini` → `getArchitectHarness` throws;
        add **array-form** `builder: ["gemini", "--yolo"]` fails closed.
  - [ ] Grep `__tests__` for any assertion that `gemini` is a recognized/builtin harness and update.

#### Implementation Details
- **`resolveHarness` precedence (corrected).** Preserve today's behavior exactly except for gemini:
  - *Explicit `harnessName`*: `built-in lookup → custom lookup → retired check → generic "Unknown
    harness" throw`. Built-ins keep precedence over same-named custom (so a custom `claude`/`codex`/
    `opencode` can NOT shadow a built-in — current behavior). Custom lookup precedes the retired check,
    so an explicit **custom `gemini` still resolves** (the escape hatch); with no custom `gemini`, the
    retired check fires.
  - *Auto-detect branch*: after `detectHarnessFromCommand` returns a name, run the **retired check on
    that detected name before** `return BUILTIN_HARNESSES[detected]` (:387). Auto-detection resolves
    the built-in namespace only (it never consulted custom), so an auto-detected `gemini …` command is
    **retired even if a custom `gemini` exists** — the custom escape hatch requires *explicit*
    `builderHarness`/`architectHarness: "gemini"`. This is the only unambiguous, behavior-preserving
    reading.
  - No path can reach a removed `BUILTIN_HARNESSES['gemini']` (→ `undefined`, :387) or fall through to
    `CLAUDE_HARNESS` (:392) for a gemini command.
- **Retirement message** (single source in `RETIRED_HARNESSES['gemini']`) must contain: that the
  built-in Gemini CLI harness is **retired**; the cause (Google ended Gemini CLI availability for
  consumer accounts — free/Pro/Ultra — on **2026-06-18**); the supported alternatives (**claude,
  codex, opencode**); the **custom-harness** escape hatch in `.codev/config.json` for retained
  (Standard/Enterprise/API-key) access; and a pointer to issue #1338. Exact wording finalized in
  implementation; these elements are required.
- No production file imports `GEMINI_HARNESS` by name (verified: only `harness.ts` + tests), so
  removing the export breaks only tests, which are updated in-phase.

#### Acceptance Criteria
- [ ] `resolveHarness` throws the retirement for explicit `gemini` and auto-detected `gemini …`;
      returns neither `CLAUDE_HARNESS` nor `undefined` on any gemini path.
- [ ] Unrelated unknown names still throw the generic "Unknown harness" error listing available names
      (without `gemini`); a custom `gemini` (explicit) resolves; built-ins are never shadowed by custom.
- [ ] `claude`, `codex`, `opencode` resolve exactly as before.
- [ ] `pnpm --filter @cluesmith/codev build` and the unit test suite pass.

#### Test Plan
- **Unit Tests**: as enumerated (harness.test.ts, harness-integration.test.ts,
  discover-resume-session.test.ts, config.test.ts). Assert fail-closed (`not CLAUDE_HARNESS`,
  `not undefined`), custom-`gemini`-escape-hatch, and built-in-precedence-preserved.
- **Integration Tests**: `getBuilderHarness`/`getArchitectHarness` retirement via config.test.ts
  (string, array, CLI-override forms).
- **Manual Testing**: none at this phase (surfacing is Phases 2–3).

#### Rollback Strategy
Single commit; `git revert` restores `GEMINI_HARNESS`, its registry entry, and prior tests. No state.

#### Risks
- **Risk**: An unguarded resolver exit reopens a footgun. **Mitigation**: tests assert all three exits
  fail closed; required acceptance criterion.
- **Risk**: Reordering precedence changes behavior for supported/custom harnesses. **Mitigation**:
  keep `built-in → custom` order; explicit regression tests for built-in-not-shadowed and
  custom-`gemini`-resolves.

---

### Phase 2: Fail closed at spawn/launch boundaries (no orphaned state, no Tower crash)
**Dependencies**: Phase 1

#### Objectives
- Reject a retired builder harness **before** any state is created, and make a gemini **architect**
  config fail cleanly at every `getArchitectHarness` call site — including the non-launch predicate.

#### Deliverables
- [ ] **Builder spawn preflight** (`agent-farm/commands/spawn.ts`): before `ensureDirectories` /
      `createWorktree(FromBranch)` / `initPorchInWorktree` (currently ~:423-442, i.e. *above* the
      existing `getBuilderHarness` call at :471), resolve the builder harness name (override-aware, via
      `getResolvedCommands` + `shell.builderHarness`, using `detectHarnessFromCommand` for the command
      form) and, if `getRetirement(name)` is set, abort with the retirement message. Apply the same
      preflight to the other spawn entry points that create worktrees (the sibling spawn functions
      around :506/:583/:662/:764 that call `createWorktree`) — factor a single `assertBuilderHarnessNotRetired(config)` helper.
- [ ] **Architect call sites** — handle each of the four `getArchitectHarness` consumers explicitly
      (a gemini architect now makes each throw):
  - [ ] `buildArchitectArgs` (`servers/tower-utils.ts:179`) — the shared launch-injection helper used
        by `launchInstance` (fresh), `add-architect`, shellper reconnect (×2), and no-Tower `afx
        architect`. Add a preflight at the **architect-launch command boundary** so a gemini architect
        launch fails with the retirement message (clean CLI/log error), not an opaque stack.
  - [ ] `resolveArchitectLaunch` (`tower-utils.ts:357`) — launch-resolution; covered by the same
        launch-boundary preflight (it is only reached during a launch).
  - [ ] `freshLaunch` closure `next()` (`tower-utils.ts:509`) — lazily invoked during launch; same
        coverage.
  - [ ] `siblingRegistrationIsLive` (`tower-utils.ts:291`) — a **boolean liveness predicate**, NOT a
        launch. Guard it: catch the retirement (or check `getRetirement` first) and return `false`
        (a retired architect's registration is not live → the reconcile loop prunes it), so the throw
        never escapes a Tower-side predicate.
- [ ] Tests:
  - [ ] Spawn: a gemini builder spawn is rejected and creates **no** worktree/porch/db state (assert
        the builders dir / porch project are absent afterward).
  - [ ] Architect: a gemini architect launch fails with the retirement message; `siblingRegistrationIsLive`
        with a gemini architect returns `false` and does not throw.
  - [ ] Regression: a claude/codex architect resolves/launches unchanged (the guards are scoped to the
        retirement error only — rethrow anything else).

#### Implementation Details
- Reuse Phase 1's `getRetirement`/`isRetiredHarness` predicate everywhere so there is one source of
  truth for "retired." Prefer failing at the narrowest boundary that still carries the verbatim
  message to the user.
- Blast radius of the architect handling is narrow — only workspaces with a `gemini` architect, which
  `doctor` already warns is unsupported — but the predicate guard prevents a reconcile-loop crash.
- The path for reset consumers is documented in Integration Points; **no reset code change** is needed
  (accepted outcome).

#### Acceptance Criteria
- [ ] Rejected gemini spawn leaves zero new worktree/porch/db state.
- [ ] All four `getArchitectHarness` sites handle a gemini config without an uncaught throw;
      `siblingRegistrationIsLive` returns `false`.
- [ ] Supported-harness spawn/launch paths behave identically; build + suite green.

#### Test Plan
- **Unit Tests**: `siblingRegistrationIsLive` returns false for a retired architect (no throw);
  preflight helper detects retired builder configs (string/array/override).
- **Integration Tests**: gemini spawn creates no state; gemini architect launch fails cleanly;
  claude/codex launch unchanged.
- **Manual Testing**: `afx spawn … --builder-cmd gemini` against a temp workspace → clean rejection,
  no `.builders/<id>` left behind. Run longer commands in the background per CLAUDE.md.

#### Rollback Strategy
Single commit; `git revert` removes the preflight + guards. Resolver behavior (Phase 1) is unaffected.

#### Risks
- **Risk**: A launch-boundary catch alters error semantics for other harnesses. **Mitigation**: scope
  the catch to the retirement error; rethrow others; regression-test claude/codex.
- **Risk**: Missing a worktree-creating spawn entry point leaves an unguarded path. **Mitigation**:
  centralize in one helper and call it from every `createWorktree` entry; grep for `createWorktree`
  callers.

---

### Phase 3: `codev doctor` — retirement guidance + builder-side flagging
**Dependencies**: Phase 1 (independent of Phase 2)

#### Objectives
- Make `codev doctor` diagnose the retirement for both roles at config-check time — correcting the
  now-inverted "supported for builders" message and adding builder-side detection.

#### Deliverables
- [ ] `commands/doctor.ts` (816-828): redefine the `gemini` branch:
  - [ ] Message presents the **retirement** (both roles), not "supported for builders."
  - [ ] Additionally detect and flag a `gemini` **builder** configuration, mirroring the architect
        branch's **persisted-config** detection — read raw `shell.builder` / `shell.builderHarness`
        (array-or-string), via `detectHarnessFromCommand`. **Not** override-aware (the architect branch
        reads raw `shell.architect`/`shell.architectHarness`, not CLI/env overrides — matching the
        spec's persisted-config scope; do not claim otherwise).
  - [ ] Update the structured `issue:` / `recommendation:` strings (stable assertion target).
  - [ ] Factor the raw-config harness resolution into a shared local helper used by both the architect
        and builder branches to avoid drift.
- [ ] Tests: assert the structured fields for a `gemini` **architect** config and a `gemini`
      **builder** config; assert no output claims "supported for builders."

#### Implementation Details
- Keep severity as a **warning** (consistent with the existing branch) unless review argues for error.
- Doctor never calls `resolveHarness`, so it does not throw on a gemini config — it detects and reports.

#### Acceptance Criteria
- [ ] `codev doctor` on a gemini builder config emits a retirement `issue:`/`recommendation:`; on a
      gemini architect config the message no longer claims builder support.
- [ ] Build + suite green.

#### Test Plan
- **Unit Tests**: doctor output assertions on structured fields (both roles).
- **Manual Testing**: `codev doctor` against temp configs with `shell.builder: "gemini --yolo"` and,
  separately, `shell.architect: "gemini --yolo"`.

#### Rollback Strategy
Single commit; `git revert` restores the prior doctor branch.

#### Risks
- **Risk**: Builder detection duplicates architect logic and drifts. **Mitigation**: shared local
  helper for both branches.

---

### Phase 4: User-facing docs — README + CHANGELOG
**Dependencies**: Phase 3

#### Objectives
- Stop presenting the standalone Gemini CLI as a supported shell in current user-facing docs, and
  record the breaking change.

#### Deliverables
- [ ] `README.md`:
  - [ ] "Other shells (Codex, Gemini) are also supported…" (:392) — drop Gemini (or mark the built-in
        Gemini CLI harness retired).
  - [ ] Autonomous-flags table (:433-436) — remove/annotate the `Gemini CLI | --yolo` row as retired.
  - [ ] Config example (:448-460) — replace the gemini block (**both** `"architect"` and `"builder"`
        lines) with a supported harness, and rewrite the prose to a plain statement that the built-in
        Gemini CLI harness is **retired** (consumer tiers ended 2026-06-18), with the custom-harness
        pointer. Preserve the `agy` **consult lane** distinction already noted.
- [ ] `CHANGELOG.md` — add an entry under the maintained `## [Unreleased]` section (a "Removed" /
      breaking-change note): the built-in `gemini` builder/architect harness is retired; how to
      migrate (supported harnesses or a custom harness). This is a user-visible breaking change.
- [ ] Scoped documentation-consistency check: grep confirms no **current user-facing harness-selection**
      doc still presents `gemini` as a supported builder shell. **Exempt**: historical artifacts
      (`codev/specs`, `plans`, `reviews`, `projects`, `docs/releases/*`) and every `consult -m gemini`
      / `agy` reference. Re-grep **both** `codev/` and `codev-skeleton/` (verified today no skeleton
      doc presents gemini as a builder — re-confirm before done).

#### Implementation Details
- Governance docs (`codev/resources/arch.md` :291/:311-317, `lessons-learned.md` :80) carry the stale
  "Gemini is builder-only" framing; per SPIR + the spec they are updated in the **Review** phase via
  the `update-arch-docs` skill (hot/cold routing) — tracked in Documentation Updates, not this phase.
- No `codev-skeleton/` twin exists for the README/governance edits (README is top-level; arch/lessons
  are self-hosted), so no dual-tree mirror is required — the re-grep guards that.

#### Acceptance Criteria
- [ ] README no longer presents Gemini as a supported shell (all three spots); consult-lane note intact.
- [ ] CHANGELOG `[Unreleased]` records the breaking change with a migration pointer.
- [ ] Scoped doc-consistency grep passes (historical + consult refs exempt). Docs-only; suite green.

#### Test Plan
- **Integration Tests**: the scoped grep check.
- **Manual Testing**: read the rendered README + CHANGELOG entries for coherence.

#### Rollback Strategy
Single commit; `git revert` restores prior README + CHANGELOG text.

#### Risks
- **Risk**: The grep flags an out-of-scope historical/consult reference. **Mitigation**: the check is
  explicitly scoped with exemptions; do not touch `consult -m gemini`, `agy`, or historical artifacts.

---

## Dependency Map
```
Phase 1 (core resolver + tests)
   ├──→ Phase 2 (spawn/launch fail-closed)
   └──→ Phase 3 (doctor)  ──→ Phase 4 (README + CHANGELOG)
```
Phases 2 and 3 both depend only on Phase 1; sequenced 1→2→3→4 for a linear commit history. Governance-doc
updates (arch.md / lessons-learned.md) happen in the Review phase, after Phase 4.

## Resource Requirements
### Development Resources
- **Engineers**: one builder (this agent); familiarity with the agent-farm harness + Tower launch paths.
- **Environment**: local dev; `pnpm --filter @cluesmith/codev build` + `test`.

### Infrastructure
- No database changes, new services, or config-schema changes (`builderHarness`/`architectHarness` stay
  free-form `string`; only their *resolution* changes). No monitoring additions.

## Integration Points
### External Systems
- **Standalone Gemini CLI** — builder/architect harness being retired — Phase 1. **Fallback**: supported
  harnesses (claude/codex/opencode) or a user custom harness.

### Internal Systems
- **`resolveHarness` / `BUILTIN_HARNESSES` / `detectHarnessFromCommand`** (`agent-farm/utils/harness.ts`) — Phase 1.
- **`getBuilderHarness` / `getArchitectHarness`** (`agent-farm/utils/config.ts:280/261`) — inherit
  retirement via the shared resolver — Phases 1 (tests), 2 (surfacing).
- **Builder spawn** (`agent-farm/commands/spawn.ts`, harness resolved at :471 *after* worktree/porch
  creation) and **`spawn-worktree.ts:912`** — Phase 2 preflight.
- **Architect launch/predicate** (`agent-farm/servers/tower-utils.ts`: `buildArchitectArgs`:179,
  `siblingRegistrationIsLive`:291 [predicate], `resolveArchitectLaunch`:357, `freshLaunch`:509) — Phase 2.
- **`codev doctor`** (`commands/doctor.ts:816-828`) — Phase 3.
- **`afx reset`** (`agent-farm/commands/reset/context.ts`) — **no code change** (accepted outcome). TWO
  direct `BUILTIN_HARNESSES` consumers exist and both degrade correctly after removal:
  `harnessFromLaunchScript` (:414, name set) and `harnessProviderFor` (:468, direct index → returns
  `null` → reset refuses "this harness cannot reset"). Named here so implementation does not rediscover
  and improvise. (Note: full path is `agent-farm/commands/reset/context.ts`; the spec's shorter
  `reset/context.ts` citation is the same file.)
- **OUT OF SCOPE (do not touch)**: `agy` consult lane, `consult -m gemini`, `agy` architect (#1063).

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| A resolver exit left unguarded reopens a footgun | Medium | High | Tests assert all 3 exits fail closed; required acceptance criterion | builder |
| Rejected gemini spawn orphans worktree/porch state | Medium | High | Phase 2 preflight before any state mutation; test asserts no state created | builder |
| Architect throw crashes Tower (esp. predicate :291) | Medium | High | Per-site handling; guard the predicate to return false; regression test | builder |
| Reordering precedence shadows a built-in or breaks custom | Low | High | Keep built-in→custom order; regression tests both ways | builder |
| Scope creep into `agy`/`consult -m gemini` | Low | Medium | Non-goals pinned; doc check exempts consult refs | builder |
| A skeleton/framework doc missed | Low | Low | Re-grep both trees before done; verified no skeleton builder-doc today | builder |

### Schedule Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| External-maintainer review latency (no self-merge) | Medium | Low | Keep phases small, self-contained, reviewable; architect coordinates merge | architect |

## Validation Checkpoints
1. **After Phase 1**: resolver fails closed on all gemini paths; supported/custom harnesses correct; unit suite green.
2. **After Phase 2**: gemini spawn creates no state; all architect sites fail cleanly (no Tower crash).
3. **After Phase 3**: doctor diagnoses gemini for both roles via structured fields.
4. **Before PR**: full `build` + `test` green; scoped doc check passes; CHANGELOG updated; criteria mapped.

## Monitoring and Observability
### Metrics to Track
- N/A — retirement of a code path plus diagnostics/doc edits; no runtime metrics.
### Logging Requirements
- The retirement message is the only new user-visible output; no new persistent logging.
### Alerting
- N/A.

## Documentation Updates Required
- [ ] README.md — Phase 4.
- [ ] CHANGELOG.md `[Unreleased]` — Phase 4.
- [ ] `codev/resources/arch.md` (:291/:311-317) — **Review phase**, via `update-arch-docs` (retire the
      "Gemini is builder-only" framing).
- [ ] `codev/resources/lessons-learned.md` (:80, #929 note) — **Review phase**, if accuracy changes.
- [ ] Confirm CLAUDE.md/AGENTS.md need no change (no gemini-builder guidance there today; re-grep).

## Post-Implementation Tasks
- [ ] Full test suite + build green.
- [ ] Scoped documentation-consistency grep (both trees).
- [ ] Security/behavioral: fail-closed assertions present and passing.
- [ ] (Review) Governance-doc routing via `update-arch-docs`.
- [ ] N/A: load testing, perf validation (no runtime perf surface).

## Expert Review
**Date**: 2026-08-03 (SPIR plan review, iteration 1)
**Model**: Gemini (via agy) — APPROVE; Codex (GPT-5.6 Sol) — REQUEST_CHANGES; Claude Opus 5 — COMMENT.
**Key Feedback**:
- Corrected `resolveHarness` precedence to `built-in → custom → retired → unknown` (Codex + Claude).
- Auto-detected `gemini` stays retired even with a custom `gemini`; escape hatch is explicit-only (Codex).
- Added a **spawn preflight** before state mutation, with a "no orphaned state" test (Codex).
- Doctor detection is **persisted-config**, not override-aware; corrected wording (Codex).
- Enumerated the four `getArchitectHarness` sites with per-site behavior; `:291` is a predicate, guard
  it to return false (Claude).
- Named the second `BUILTIN_HARNESSES` consumer `harnessProviderFor` (:468) + path correction (Claude).
- Added a **CHANGELOG** deliverable for the breaking change (Claude).
- Noted Phase 1 is committable but not individually shippable (Claude).

**Plan Adjustments**: restructured 3→4 phases (resolver / fail-closed spawn+launch / doctor / docs);
all points above incorporated. Full disposition in
`codev/projects/1338-*/1338-plan-iter1-rebuttals.md`.

## Approval
- [ ] Technical Lead Review
- [ ] Engineering Manager Approval
- [ ] Resource Allocation Confirmed
- [x] Expert AI Consultation Complete (iteration 1; re-verification pending)

## Change Log
| Date | Change | Reason | Author |
|------|--------|--------|--------|
| 2026-08-03 | Initial plan draft | Spec approved; Approach 1; role-agnostic retirement confirmed | builder |
| 2026-08-03 | Iter-1 review revisions | Precedence fix, spawn preflight, per-site architect handling, doctor scope, CHANGELOG; 3→4 phases | builder |

## Notes
- **Phase 1 file count**: `harness.ts` + 4 test files move together because the behavioral change flips
  every gemini-resolution path at once — the phase's atomicity is behavioral, not per-file. Deliberate,
  not a phase to split.
- **Role-agnostic retirement** is intended and architect-approved: one sentinel in the shared resolver
  covers architect + builder; no role parameter is threaded. Phase 2 handles the architect call-site
  consequences (narrow blast radius — gemini architect is already doctor-warned).
- The retirement targets the **built-in `gemini` name**; a user's own explicit custom `gemini` harness
  still resolves (custom precedence on the explicit path; auto-detect stays retired).
