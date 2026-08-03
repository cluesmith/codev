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
the architect, 2026-08-03). Selecting `gemini` — by explicit `builderHarness`/`architectHarness` or
by auto-detection from a `gemini …` command (string or array form) — fails **closed** with one clear
retirement message, never a silent Claude fallback (harness.ts:392) and never an `undefined`/TypeError
(harness.ts:387). The change then surfaces cleanly at the two places a user meets it — a spawn/launch
attempt and `codev doctor` — and the README stops presenting Gemini as a supported shell. The
`agy` / `consult -m gemini` subsystem is untouched.

Three phases, each an independently committable unit that leaves the build and full test suite green:
core resolver + its tests; clean surfacing (doctor + spawn/launch failure); user-facing docs.

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
- [ ] Spawn and architect-launch surface the retirement as a **clean, actionable failure**, not an
      uncaught crash.
- [ ] `codev doctor` no longer says gemini is "supported for builders"; it presents the retirement
      and flags a `gemini` **builder** config, verified via structured `issue:`/`recommendation:` fields.
- [ ] README "other shells" line, autonomous-flags table, and **both** architect+builder config-example
      lines updated, with a plain retirement note + custom-harness pointer.
- [ ] Claude, Codex, OpenCode, and custom harnesses resolve/spawn unchanged (criterion 3).
- [ ] Each removed gemini test is **replaced** by a retirement-behavior test (coverage-by-replacement).
- [ ] Governance docs (`arch.md`/`lessons-learned.md`) updated (Review phase, via `update-arch-docs`).
- [ ] `agy` / `consult -m gemini` untouched; `pnpm --filter @cluesmith/codev build` + full test suite green.

## Phases (Machine Readable)

<!-- REQUIRED: porch uses this JSON to track phase progress. -->

```json
{
  "phases": [
    {"id": "phase_1", "title": "Retire gemini in the shared resolver (core + resolver/config tests)"},
    {"id": "phase_2", "title": "Surface the retirement cleanly: doctor + spawn/launch failure"},
    {"id": "phase_3", "title": "Update user-facing README presentation"}
  ]
}
```

## Phase Breakdown

### Phase 1: Retire `gemini` in the shared resolver (core + resolver/config tests)
**Dependencies**: None

#### Objectives
- Make `gemini` a **retired** harness name that fails closed on every `resolveHarness` exit, for both
  builder and architect resolution, with one clear retirement message.
- Remove the `GEMINI_HARNESS` provider and its registry entry so gemini is no longer enumerated as
  supported — without reintroducing either footgun.

#### Deliverables
- [ ] `agent-farm/utils/harness.ts`:
  - [ ] New retired-names registry, e.g. `RETIRED_HARNESSES: Record<string, string>` mapping the name
        to its retirement explanation, plus a small helper that throws a consistent error.
  - [ ] Remove the `GEMINI_HARNESS` provider (harness.ts:177-186) and the `gemini:` entry in
        `BUILTIN_HARNESSES` (:212).
  - [ ] **Keep** the `gemini` case in `detectHarnessFromCommand` (:338) so the auto-detect path lands
        on the retirement, not the Claude default.
  - [ ] In `resolveHarness`: consult `RETIRED_HARNESSES` (a) when an explicit `harnessName` is given
        (before the generic "Unknown harness" throw) and (b) right after `detectHarnessFromCommand`
        resolves a name (before `return BUILTIN_HARNESSES[detected]` at :387 and the final
        `return CLAUDE_HARNESS` at :392). Custom harnesses still take precedence over the retired
        check for the *explicit* path only if a user has intentionally redefined the name (a custom
        `gemini` key wins — the retirement targets the built-in name; document this ordering).
  - [ ] Update the module header comment (:4-6) to drop Gemini from the "built-in providers" list.
- [ ] Replace/adjust affected tests (retirement behavior, not `GEMINI_HARNESS`):
  - [ ] `__tests__/harness.test.ts` — remove `GEMINI_HARNESS` import + its `describe` block and the
        `resolveHarness('gemini')`/auto-detect-gemini/explicit-beats-detect assertions; add: explicit
        `gemini` throws retirement; auto-detected `gemini …` throws retirement and returns **neither**
        `CLAUDE_HARNESS` **nor** `undefined`; an unrelated unknown name still throws the **generic**
        "Unknown harness" error; `detectHarnessFromCommand('gemini')` still returns `'gemini'`.
  - [ ] `__tests__/harness-integration.test.ts` — replace the `GEMINI_SYSTEM_MD`/gemini-script
        assertions (:116-125, :242-249) with a retirement assertion; keep the codex "no
        `GEMINI_SYSTEM_MD`" guard.
  - [ ] `__tests__/discover-resume-session.test.ts` — the gemini regression guard (:106-112) imports
        `GEMINI_HARNESS`; re-express using a still-valid non-resuming harness (e.g. codex) or delete
        if fully subsumed, preserving the "no stale-Claude-jsonl resume" intent.
  - [ ] `__tests__/config.test.ts` — `--builder-cmd gemini` (:138-141) now asserts the **retirement
        throw** from `getBuilderHarness`; add `--architect-cmd gemini` → `getArchitectHarness` throws;
        add **array-form** `builder: ["gemini", "--yolo"]` fails closed.
  - [ ] Grep `__tests__` for any other assertion that `gemini` is a recognized/builtin harness
        (e.g. reset tests referencing `BUILTIN_HARNESSES` membership) and update.

#### Implementation Details
- **Retirement message** (single source in `RETIRED_HARNESSES['gemini']`) must contain: that the
  built-in Gemini CLI harness is **retired**; the cause (Google ended Gemini CLI availability for
  consumer accounts — free/Pro/Ultra — on **2026-06-18**); the supported alternatives (**claude,
  codex, opencode**); and the **custom-harness** escape hatch in `.codev/config.json` for retained
  (Standard/Enterprise/API-key) access; and a pointer to issue #1338. Exact wording finalized in
  implementation; these elements are required.
- **Interception order** in `resolveHarness`: explicit name → custom-harness match (unchanged) →
  **retired check** → builtin lookup → generic unknown throw; auto-detect branch → **retired check on
  the detected name** → builtin lookup. This guarantees no path can reach `BUILTIN_HARNESSES['gemini']`
  (removed → would be `undefined`) or fall through to `CLAUDE_HARNESS` for a gemini command.
- No production file imports `GEMINI_HARNESS` by name (verified: only `harness.ts` + tests reference
  it), so removing the export breaks only tests, which are updated in-phase.

#### Acceptance Criteria
- [ ] `resolveHarness` throws the retirement message for explicit `gemini` and for auto-detected
      `gemini …`; returns neither `CLAUDE_HARNESS` nor `undefined` on any gemini path.
- [ ] Unrelated unknown names still throw the generic "Unknown harness" error listing available names
      (without `gemini`).
- [ ] `claude`, `codex`, `opencode`, and a custom harness resolve exactly as before.
- [ ] `pnpm --filter @cluesmith/codev build` and the unit test suite pass (all updated tests green).

#### Test Plan
- **Unit Tests**: as enumerated in Deliverables (harness.test.ts, harness-integration.test.ts,
  discover-resume-session.test.ts, config.test.ts). Explicitly assert fail-closed (`not CLAUDE_HARNESS`,
  `not undefined`) as the encoded security property.
- **Integration Tests**: `getBuilderHarness`/`getArchitectHarness` retirement via config.test.ts
  (string, array, and CLI-override forms).
- **Manual Testing**: none required at this phase (surfacing is Phase 2).

#### Rollback Strategy
Single-commit phase; `git revert` restores `GEMINI_HARNESS`, its registry entry, and the prior tests.
No data/migration state involved.

#### Risks
- **Risk**: Interception misses one resolver exit → footgun reopens.
  - **Mitigation**: Tests assert all three exits (explicit, auto-detect, default) fail closed; make it
    a required acceptance criterion.
- **Risk**: A custom `gemini` harness definition is unintentionally blocked.
  - **Mitigation**: Preserve custom-match precedence for the explicit path; add a test that a custom
    `gemini` key still resolves to the custom provider.

---

### Phase 2: Surface the retirement cleanly — `codev doctor` + spawn/launch failure
**Dependencies**: Phase 1

#### Objectives
- Ensure the two places a user actually meets the retirement — a spawn/architect launch, and
  `codev doctor` — communicate it clearly, and that a gemini config never causes an uncaught crash.

#### Deliverables
- [ ] `commands/doctor.ts` (816-828): redefine the `gemini` branch — its "supported for builders"
      premise has fully inverted:
  - [ ] Message presents the **retirement** (both roles), not "supported for builders."
  - [ ] Additionally detect and flag a `gemini` **builder** configuration (resolve the builder
        command/harness the same override-aware way the architect branch does), with the retirement
        explanation.
  - [ ] Update the structured `issue:`/`recommendation:` strings accordingly (stable assertion target).
- [ ] Clean-failure verification/handling for the spawn and architect-launch paths (a gemini config now
      makes `getBuilderHarness`/`getArchitectHarness` throw):
  - [ ] **Builder spawn** (`spawn-worktree.ts:912`, `spawn.ts:471/850` via `getBuilderHarness` and
        `discoverResumeSession`): confirm the throw surfaces as a clear CLI error; if it would abort a
        broader flow uncleanly, wrap the resolution so the failure is reported as the retirement
        message against the offending builder, leaving other state intact.
  - [ ] **Architect launch** (`tower-utils.ts` `buildArchitectArgs`:179, and 291/357/509;
        `afx architect`): confirm the throw is caught by the launch path and reported as a clear
        "architect launch failed: <retirement>" rather than crashing Tower; add a guard if not.
- [ ] Tests:
  - [ ] Doctor: assert the structured fields for a `gemini` **architect** config *and* a `gemini`
        **builder** config; assert no output asserts "supported for builders."
  - [ ] Spawn/launch: an integration-level test that a gemini builder config fails closed with the
        retirement message (and, for the architect path, does not throw uncaught).

#### Implementation Details
- Doctor already imports `detectHarnessFromCommand` and resolves the architect harness override-aware
  (`doctor.ts:797-803`). Mirror that resolution for the builder command (`shell.builder` /
  `shell.builderHarness`, array-or-string) to flag a gemini builder. Keep severity as a **warning**
  (consistent with the existing branch) unless review argues for error.
- Prefer catching the retirement at the narrowest launch boundary so the message reaches the user
  verbatim; do not swallow it into a generic failure.

#### Acceptance Criteria
- [ ] `codev doctor` on a gemini **builder** config emits a retirement `issue:`/`recommendation:`; on a
      gemini **architect** config the message no longer claims builder support.
- [ ] Spawning a gemini builder fails closed with the retirement message; launching a gemini architect
      fails cleanly (no uncaught Tower crash).
- [ ] Build + full test suite green; supported-harness spawn/launch paths unaffected.

#### Test Plan
- **Unit Tests**: doctor output assertions on structured fields (both roles).
- **Integration Tests**: gemini builder spawn fails closed; gemini architect launch fails cleanly.
- **Manual Testing**: `codev doctor` against a temp config with `shell.builder: "gemini --yolo"` and,
  separately, `shell.architect: "gemini --yolo"`; a `afx spawn … --builder-cmd gemini` dry attempt to
  observe the clean failure. (Per CLAUDE.md, run any longer commands in the background.)

#### Rollback Strategy
Single commit; `git revert` restores the prior doctor branch and removes any added launch guards.

#### Risks
- **Risk**: Adding a catch at a launch site changes error semantics for *other* harnesses.
  - **Mitigation**: Scope the catch to the retirement error (rethrow anything else); regression-test a
    claude/codex launch resolves unchanged.
- **Risk**: Doctor builder-detection duplicates architect logic and drifts.
  - **Mitigation**: Factor the override-aware resolve into a shared local helper used by both branches.

---

### Phase 3: Update user-facing README presentation
**Dependencies**: Phase 2

#### Objectives
- Stop presenting the standalone Gemini CLI as a supported shell in the one current, user-facing
  harness-selection doc (README), and point users to supported harnesses + the custom-harness path.

#### Deliverables
- [ ] `README.md`:
  - [ ] "Other shells (Codex, Gemini) are also supported…" (:392) — drop Gemini (or explicitly mark
        the built-in Gemini CLI harness retired).
  - [ ] Autonomous-flags table (:433-436) — remove or annotate the `Gemini CLI | --yolo` row as retired.
  - [ ] Config example (:448-460) — replace the gemini block (**both** `"architect"` and `"builder"`
        lines) with a supported harness, and rewrite the prose to a plain statement that the built-in
        Gemini CLI harness is **retired** (consumer tiers ended 2026-06-18), with the custom-harness
        pointer for retained access. Preserve the `agy` **consult lane** distinction already noted.
- [ ] Scoped documentation-consistency check: grep confirms no **current user-facing
      harness-selection** doc still presents `gemini` as a supported builder shell. **Exempt**:
      historical artifacts (`codev/specs`, `plans`, `reviews`, `projects`, `docs/releases/*`) and every
      `consult -m gemini` / `agy` reference. Re-grep **both** `codev/` and `codev-skeleton/` (verified
      today that no skeleton doc presents gemini as a builder — re-confirm before claiming done).

#### Implementation Details
- Governance docs (`codev/resources/arch.md` :291/:311-317, `lessons-learned.md` :80) carry the stale
  "Gemini is builder-only" framing. Per SPIR + the spec, these are updated in the **Review** phase via
  the `update-arch-docs` skill (hot/cold routing) — tracked in Documentation Updates below, not in this
  phase. README is the user-facing feature doc and belongs here.
- No `codev-skeleton/` twin exists for these README/governance edits (README is top-level; arch/lessons
  are self-hosted), so no dual-tree mirror is required for this change — but the re-grep guards that.

#### Acceptance Criteria
- [ ] README no longer presents Gemini as a supported shell (all three spots updated); the consult-lane
      distinction remains intact.
- [ ] Scoped doc-consistency grep passes (historical + consult refs exempt).
- [ ] Build + test suite still green (docs-only; no code change).

#### Test Plan
- **Unit Tests**: none (docs-only).
- **Integration Tests**: the scoped grep check.
- **Manual Testing**: read the rendered README section for coherence.

#### Rollback Strategy
Single commit; `git revert` restores the prior README text.

#### Risks
- **Risk**: The grep flags an out-of-scope historical/consult reference and prompts an over-broad edit.
  - **Mitigation**: The check is explicitly scoped with exemptions; do not touch `consult -m gemini`,
    `agy`, or historical artifacts.

---

## Dependency Map
```
Phase 1 (core resolver + tests) ──→ Phase 2 (doctor + spawn/launch surfacing) ──→ Phase 3 (README)
```
Governance-doc updates (arch.md / lessons-learned.md) happen in the Review phase, after Phase 3.

## Resource Requirements
### Development Resources
- **Engineers**: one builder (this agent); familiarity with the agent-farm harness subsystem.
- **Environment**: local dev; `pnpm --filter @cluesmith/codev build` + `test`.

### Infrastructure
- No database changes, new services, or config-schema changes (the `builderHarness`/`architectHarness`
  fields stay free-form `string`; only their *resolution* changes). No monitoring additions.

## Integration Points
### External Systems
- **System**: Standalone Gemini CLI — **Integration Type**: builder/architect harness (being retired).
  **Phase**: 1. **Fallback**: supported harnesses (claude/codex/opencode) or a user custom harness.

### Internal Systems
- **`resolveHarness` / `BUILTIN_HARNESSES` / `detectHarnessFromCommand`** (harness.ts) — Phase 1.
- **`getBuilderHarness` / `getArchitectHarness`** (config.ts) — inherit retirement via the shared
  resolver — Phases 1 (tests) & 2 (surfacing).
- **`codev doctor`** (doctor.ts) — Phase 2.
- **Builder spawn / architect launch** (spawn-worktree.ts, spawn.ts, tower-utils.ts) — Phase 2
  (clean-failure surfacing).
- **`afx reset`** (reset/context.ts) — no code change; the decided/accepted "won't recognize a
  pre-existing gemini builder" outcome (spec Assumptions); a reset test asserting gemini recognition,
  if any, is updated in Phase 1.
- **OUT OF SCOPE (do not touch)**: `agy` consult lane, `consult -m gemini`, `agy` architect (#1063).

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| A resolver exit left unguarded reopens a footgun | Medium | High | Tests assert all 3 exits fail closed; required acceptance criterion | builder |
| Architect-launch throw crashes Tower instead of failing cleanly | Medium | High | Phase 2 verifies/handles the launch boundary; integration test | builder |
| Retiring the shared resolver breaks a supported architect (codex/claude) | Low | High | Sentinel keys only on `gemini`; regression tests for claude/codex/opencode/custom, both roles | builder |
| Scope creep into `agy`/`consult -m gemini` | Low | Medium | Non-goals pinned in spec+plan; doc check exempts consult refs | builder |
| A skeleton/framework doc missed | Low | Low | Re-grep both trees before done; verified no skeleton builder-doc today | builder |

### Schedule Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| External-maintainer review latency (no self-merge) | Medium | Low | Keep phases small, self-contained, and clearly reviewable; architect coordinates merge | architect |

## Validation Checkpoints
1. **After Phase 1**: resolver fails closed on all gemini paths; supported harnesses unchanged; unit
   suite green.
2. **After Phase 2**: doctor + spawn/launch communicate the retirement cleanly; no uncaught crash.
3. **Before PR**: full `build` + `test` green; scoped doc check passes; spec success criteria mapped.

## Monitoring and Observability
### Metrics to Track
- N/A — no runtime metrics; this is a retirement of a code path plus diagnostics/doc edits.

### Logging Requirements
- The retirement error/message is the only new user-visible output; no new persistent logging.

### Alerting
- N/A.

## Documentation Updates Required
- [ ] README.md — Phase 3 (user-facing harness-selection presentation).
- [ ] `codev/resources/arch.md` (harness section :291/:311-317) — **Review phase**, via `update-arch-docs`
      (retire the "Gemini is builder-only" framing).
- [ ] `codev/resources/lessons-learned.md` (:80, #929 note) — **Review phase**, if the retirement
      changes its accuracy.
- [ ] Confirm CLAUDE.md/AGENTS.md need no change (no gemini-builder guidance there today; re-grep).

## Post-Implementation Tasks
- [ ] Full test suite + build green.
- [ ] Scoped documentation-consistency grep (both trees).
- [ ] Security/behavioral: fail-closed assertions present and passing.
- [ ] (Review) Governance-doc routing via `update-arch-docs`.
- [ ] N/A: load testing, perf validation (no runtime perf surface).

## Expert Review
**Date**: (pending porch 3-way consultation on this plan)
**Model**: Gemini (via agy), Codex, Claude
**Key Feedback**:
- (pending)

**Plan Adjustments**:
- (pending)

## Approval
- [ ] Technical Lead Review
- [ ] Engineering Manager Approval
- [ ] Resource Allocation Confirmed
- [ ] Expert AI Consultation Complete

## Change Log
| Date | Change | Reason | Author |
|------|--------|--------|--------|
| 2026-08-03 | Initial plan draft | Spec approved; Approach 1 selected; role-agnostic retirement confirmed | builder |

## Notes
- **Phase file counts**: Phase 1 touches `harness.ts` + 4 test files because the behavioral change flips
  every gemini-resolution path at once — those tests must move together to keep the suite green (the
  phase's atomicity is behavioral, not per-file). This is deliberate, not a phase that should be split.
- **Role-agnostic retirement** is intended and architect-approved: one sentinel in the shared resolver
  covers architect + builder; no role parameter is threaded.
- The retirement targets the **built-in `gemini` name**; a user's own custom `gemini` harness definition
  still resolves (custom precedence on the explicit path).
