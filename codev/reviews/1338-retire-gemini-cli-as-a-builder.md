# Review: Retire Gemini CLI as a builder harness

## Summary

Retired the standalone **Gemini CLI** as a supported built-in builder/architect harness (issue #1338).
Delivered across four implementation phases: a retirement sentinel in the shared harness resolver that
fails closed on both the explicit and auto-detect paths; fail-closed guards at every spawn / architect
launch / reconnect / clean-exit boundary (no orphaned worktree, no Tower crash); `codev doctor`
retirement flagging for both roles with the sanctioned custom-harness escape hatch preserved; and
user-facing docs (README). The Review phase aligned the three retirement-guidance
touchpoints (runtime message, `doctor` recommendation, README) to name the explicit
`shell.builderHarness` / `shell.architectHarness` selector, and refreshed the governance docs.

## Spec Compliance

- [x] AC1: Gemini CLI is no longer presented or treated as a supported builder option (Phases 1, 4) —
      built-in `GEMINI_HARNESS` removed from the registry; README no longer presents it as a
      built-in shell.
- [x] AC2: A user selecting Gemini CLI as a builder receives a clear explanation that the option has
      been retired (Phases 1–3) — `resolveHarness` throws a `RetiredHarnessError` carrying a specific
      retirement message (2026-06-18 cause, migration targets, escape hatch); spawn fails closed with it;
      `codev doctor` flags a persisted `gemini` builder/architect config with the same message.
- [x] AC3: Existing Claude, Codex, OpenCode, and custom builder support remains unaffected (all phases) —
      built-ins untouched (regression-tested both roles); the explicit custom-`gemini` escape hatch
      resolves and spawns (retained-access path preserved).
- [x] AC (fail-closed, from spec): neither footgun survives — the auto-detect path no longer silently
      falls back to `CLAUDE_HARNESS`, and the explicit path no longer throws a generic "unknown" error.
- [x] AC (consult lane untouched): the `gemini` **consult lane** (now `agy`) and `agy` architect (#1063)
      are out of scope and unchanged.

## Deviations from Plan

- **Phase 2 grew from the planned single-preflight design to four fail-closed boundaries.** Codex's
  consultation (3 iterations) surfaced three reachable paths the plan's "initial launch" framing missed:
  architect **restart/reconnect** (`buildArchitectReconnectRestartOptions` → fail closed to `undefined`),
  and clean-exit **relaunch** (`FreshLaunch` gained a `{ stop: true }` contract so a factory can veto a
  respawn it can't re-command). Net: the retirement fails closed at spawn preflight, launch, reconnect,
  and clean-exit — a stronger invariant than the plan specified. Documented in the phase_2 iter1/iter2
  rebuttals.
- **Governance-doc + three-touchpoint alignment deferred to Review (as planned/endorsed).** The plan
  routed arch/lessons updates to Review; the cross-phase runtime-message/doctor-rec selector alignment
  was accepted-and-deferred across phase_4 iterations with all three reviewers' endorsement, and landed
  here.
- **Integration-review adjustments (post-PR #1342, architect review).** Four changes after the PR opened:
  (1) the drafted CHANGELOG `[Unreleased]` retirement entry was **reverted** — contributors don't edit the
  upstream release changelog; the breaking change is documented via README + the runtime/`doctor`
  retirement messaging instead. (2) The spawn preflight was made **unconditional** (previously gated
  `if (mode !== 'shell')`): `spawnShell` still runs `commands.builder` and persists a shell row, so a
  retired `gemini` `shell.builder` now fails closed too — regression-tested (no PTY, no row). (3) The
  `doctor` custom-harness recommendations interpolate `role.name` instead of a hard-coded `"gemini"`, so
  the advice stays correct as `RETIRED_HARNESSES` grows. (4) `siblingRegistrationIsLive` logs the
  retirement reason when it prunes a retired-architect row, so the reconcile loop's generic "no resumable
  session" line can't misattribute the cause.

## Key Metrics

- **Commits**: 47 on the branch (≈21 `[Spec 1338]` artifact/code commits + porch orchestration chores).
- **Tests**: 4145 passing, 48 pre-existing skips, 0 failing (full unit suite, e2e excluded). Substantial
  new coverage added: `spawn-retirement.test.ts` (new — real `spawn()` against a real temp workspace,
  asserts 0 orphaned state), plus additions across `harness`, `config`, `doctor`, `tower-utils`,
  `tower-instances`, and `session-manager` tests.
- **Files created**: `packages/codev/src/agent-farm/__tests__/spawn-retirement.test.ts`;
  `codev/reviews/1338-retire-gemini-cli-as-a-builder.md`.
- **Files deleted**: none (the built-in `GEMINI_HARNESS` export + its registry entry were removed
  in-place from `harness.ts`).
- **Net LOC impact**: ≈ +1,300 / −230 across ~20 source + doc files (heavily test-weighted).

## Timelog

All times America/New_York (EDT, −0400), 2026-08-03 (spec through phase_4 iter2), with phase_4 iter3 +
Review completed after a resume the following UTC day.

| Time | Event |
|------|-------|
| 15:12 | Session start (porch `started_at`) |
| 15:25 | First commit: Initial specification draft |
| 15:28 | Spec consult (Gemini APPROVE, Codex/Claude REQUEST_CHANGES) |
| — | **GATE: spec-approval** (human approval required) |
| 15:35 | spec-approval approved |
| 15:42 | Plan consult (Gemini APPROVE, Codex REQUEST_CHANGES, Claude COMMENT) |
| — | **GATE: plan-approval** (human approval required) |
| 15:52 | plan-approval approved; implementation begins |
| 16:20 | Phase 1 complete (1 iter, unanimous) → phase_2 |
| 18:09 | Phase 2 complete (3 iters; Codex C1/C2/C3) → phase_3 |
| 20:05 | Phase 3 complete (2 iters) → phase_4 |
| 20:46 | Phase 4 iter2 committed; paused at architect request (state snapshot) |
| — | Resume ("unpause") → phase_4 iter3 unanimous APPROVE → Review |
| — | **GATE: pr** (pending at time of writing) |

### Autonomous Operation

| Period | Duration | Activity |
|--------|----------|----------|
| Spec + Plan | ~40m | Draft + 2 gated consults |
| Human gate waits | ~short | spec-approval + plan-approval approved same session |
| Implementation → phase_4 | ~5h | 4 phases, 9 implement consult rounds (1+3+2+3) |
| Pause → resume → Review | — | phase_4 iter3 + Review-phase alignment + PR |

**Total wall clock** (first commit → PR): spec 15:25 → PR (Review phase, next UTC day).
**Context window resets**: ~3 (phase_2 iter1 fixes, phase_3 iter1 fixes, and this Review resume — each
recovered from `state-snapshot.md` + the thread log; all resumed automatically without losing state).

## Consultation Iteration Summary

33 consultation files (11 rounds × 3 models) + 7 rebuttal files. Verdicts trended APPROVE as iterations
converged; every phase ended unanimous APPROVE.

| Phase | Iters | Who Blocked | What They Caught |
|-------|-------|-------------|------------------|
| Specify | 1 | Codex, Claude | Product-retirement framing (consumer tiers vs "CLI gone"); role-agnostic sentinel scope; doctor premise inversion |
| Plan | 1 | Codex | Resolver precedence (built-in→custom→retired); spawn preflight must precede state mutation; per-site architect handling |
| Phase 1 | 1 | — | Unanimous APPROVE, no changes |
| Phase 2 | 3 | Codex | C1 reconnect fail-open, C2 clean-exit uncaught throw, C3 clean-exit relaunch mints a retired session — all reachable via config-flip/restart |
| Phase 3 | 2 | Codex, Claude | Doctor false-flagged the sanctioned custom-`gemini` escape hatch; a vacuous negative test (missing `chalk.gray` mock) |
| Phase 4 | 3 | Codex, Claude | Escape-hatch guidance omitted the explicit selector (iter1); README snippet used `--system` instead of `GEMINI_SYSTEM_MD` (iter2) |
| Review | (at PR) | — | pending PR consult |

**Most frequent blocker**: **Codex** — blocked in 5 of the 6 pre-PR rounds it reviewed, focused on
reachability of "unreachable" failure paths (restart/reconnect/clean-exit) and executable-doc accuracy.

### Avoidable Iterations

1. **Trace every resolution/launch call site up front.** Phase 2 cost 2 extra iterations because the
   initial design reasoned "unreachable in practice" about the reconnect and clean-exit relaunch paths.
   A caller-by-caller grep of `getArchitectHarness` / `FreshLaunch` before the first consult would have
   surfaced C1/C2/C3 without reviewer prompting. (Captured as a lessons-learned entry.)
2. **Verify doc snippets against the real mechanism before the consult.** Phase 4 cost 2 iterations on
   the escape-hatch snippet: first the missing explicit selector, then `--system` vs `GEMINI_SYSTEM_MD`.
   Checking the retired provider's actual injection (`git show e222b9ef^`) before writing the snippet
   would have collapsed both into zero. (Captured as a lessons-learned entry.)

## Consultation Feedback

### Specify Phase (Round 1)

#### Gemini
- No concerns raised (APPROVE).

#### Codex
- **Concern**: Frame as a *product* retirement (consumer tiers ended 2026-06-18; Standard/Enterprise +
  API-key remain), served via a custom-harness escape hatch — not "the CLI is gone."
  - **Addressed**: Spec reframed; escape hatch made a first-class requirement.

#### Claude
- **Concern**: Make the sentinel role-agnostic (shared `resolveHarness` has no role param) and guard
  both footgun modes (silent `CLAUDE_HARNESS` fallback; undefined/TypeError) before both exits.
  - **Addressed**: Spec specifies a sentinel checked before both exits; flagged the role-agnostic
    broadening to the architect, who confirmed it at the gate.

### Plan Phase (Round 1)

#### Gemini
- No concerns raised (APPROVE).

#### Codex
- **Concern**: Keep resolver precedence built-in→custom→retired→generic; spawn preflight must run
  *before* `createWorktree`/`initPorch` (which themselves resolve the harness) to avoid orphaned state;
  handle the 4 `getArchitectHarness` sites per-site (predicate vs launch).
  - **Addressed**: Plan restructured 3→4 phases; preflight centralized in the spawn dispatcher before
    handler dispatch; per-site architect behavior enumerated.

#### Claude
- **Concern (COMMENT)**: CHANGELOG `[Unreleased]` is live — add a breaking-change entry; the escape hatch
  resolves only via the explicit selector.
  - **Addressed**: The explicit-selector guidance landed in Phase 4 (README). The CHANGELOG `[Unreleased]`
    entry was drafted in Phase 4 and later **reverted** at integration review — contributors don't edit
    the upstream release changelog (see Deviations); the breaking change is documented via README + the
    runtime/`doctor` retirement messaging.

### Phase 1 (Round 1)
- No concerns raised — all three APPROVE (HIGH). The resolver retirement + coverage-by-replacement tests
  landed cleanly.

### Phase 2 (Rounds 1–3)

#### Codex
- **Concern (iter1)**: Two fail-open paths on restart/reconnect — `resolveArchitectRestart` consumers
  fall back to relaunching the raw `gemini` command.
  - **Addressed**: Extracted `buildArchitectReconnectRestartOptions` (fails closed → `undefined`);
    guarded `buildArchitectFreshLaunch.next()`.
- **Concern (iter2)**: C3 — the iter1 fresh-launch fix stopped the throw but not the *relaunch*
  (session retains `options.command`); a retained custom-`gemini` respawns gemini on clean exit.
  - **Addressed**: Extended `FreshLaunch` with a fail-closed `{ stop: true }` contract; clean-exit
    handler honors it (no respawn, session removed, reason surfaced).
- **Concern (iter3)**: None — "fails closed across builder spawn, architect launch, reconnect, and
  clean-exit paths, with adequate regression coverage."

#### Gemini / Claude
- APPROVE across iters; Claude flagged C2 as non-blocking (Codex proved it reachable) and independently
  verified tsc + 283 affected suites at iter3.

### Phase 3 (Rounds 1–2)

#### Codex
- **Concern (iter1)**: Doctor false-flagged the sanctioned custom-`gemini` escape hatch (ran
  `getRetirement` on the name unconditionally, ignoring `config.harness`).
  - **Addressed**: `resolveShell(role)` now encodes the resolver precedence (explicit `<role>Harness` +
    own-prop custom def ⇒ retirement suppressed; auto-detect ⇒ always retired).
- **Concern (iter2)**: None — escape hatch preserved, robust regression tests.

#### Claude
- **Concern (iter1)**: The new negative test was vacuous — a missing `chalk.gray` mock threw into the
  section `catch {}` before the builder branch ran.
  - **Addressed**: Added `gray`; strengthened with a post-gray assertion that proves the section ran to
    completion (empirically confirmed the test fails without the fix).

### Phase 4 (Rounds 1–3)

#### Codex
- **Concern (iter1)**: Escape-hatch guidance needs the explicit `shell.builderHarness`/`architectHarness`
  selector; `opencode` is builder-only.
  - **Addressed**: README requires the explicit selector and is role-specific.
- **Concern (iter2)**: README snippet used `roleArgs: ["--system", …]`; the retired built-in injected via
  the `GEMINI_SYSTEM_MD` env var.
  - **Addressed**: Snippet reproduces the retired provider verbatim (`roleEnv`/`roleScriptEnv`); the
    same-named escape-hatch test realigned to assert the `GEMINI_SYSTEM_MD` shape.
- **Concern (iter3)**: None (HIGH) — the example matches the retired built-in's env injection.

#### Claude
- **Concern (iter1/iter2)**: Same two blockers as Codex; plus (non-blocking, deferred with endorsement)
  the runtime message + doctor rec omit the explicit selector.
  - **Addressed**: Blockers fixed in-phase; the deferred touchpoints landed in this Review phase.
- **Concern (iter3)**: None blocking — verified the fix end-to-end from disk (validation, template
  expansion, script emission, spawn preflight). (An optional CHANGELOG `GEMINI_SYSTEM_MD` pointer was
  added in Phase 4, then reverted with the rest of the CHANGELOG entry at integration review — see
  Deviations.)

#### Gemini
- APPROVE every round.

## Lessons Learned

### What Went Well
- **The retirement-sentinel design held under adversarial review.** Framing the change as "fail closed at
  every resolution path" (not "delete the entry") meant every reviewer concern was about *coverage of
  paths*, never about the core mechanism — the mechanism never needed rework.
- **Coverage-by-replacement kept the suite honest.** Re-pointing existing `gemini` fixtures to
  `codex`/`opencode` (rather than deleting them) preserved the override-awareness and resume-seam
  regression tests that would otherwise have silently disappeared with the harness.
- **The thread + state-snapshot survived three context resets** with zero lost state — each resume
  re-oriented from `codev/state/spir-1338_thread.md` and continued the exact porch step.

### Challenges Encountered
- **"Unreachable" paths were reachable.** Phase 2's restart/reconnect/clean-exit relaunch paths each
  looked unreachable from the initial-launch mental model but were reachable via config-flip-before-exit
  or Tower-restart-reading-a-gemini-config. Cost 2 iterations; resolved by a fail-closed
  `FreshLaunch.{ stop: true }` contract and a shared reconnect helper.
- **An executable doc snippet that validates but doesn't run.** The escape-hatch config passed Codev's
  own validation yet used a role-injection mechanism the Gemini CLI never accepted. Cost 2 iterations
  (Phase 4); resolved by reproducing the retired provider verbatim and locking it with a same-shaped test.

### What Would Be Done Differently
- Grep every call site of a shared resolver/launcher (including restart/reconnect/clean-exit) **before**
  the first consultation, rather than relying on "unreachable in practice" reasoning.
- Verify any documented config/escape-hatch snippet against the real (or retired) implementation before
  writing it, and assert its real shape in a behavior-named test in the same change.

### Methodology Improvements
- **SPIR worked as designed here** — Codex's per-phase consultation caught three genuinely reachable
  fail-open paths that solo review missed; the value of the 3-way review was concentrated in one
  reviewer's reachability analysis.
- Minor tooling note (already in lessons-learned/cold): the `agy`/Gemini consult lane reviews against an
  empty sandbox and can default to `REQUEST_CHANGES`; not encountered as a blocker this project.

## Architecture Updates

Routed to the **COLD** archive (`codev/resources/arch.md`) — reference detail about a subsystem's current
shape, not a cross-cutting invariant that earns a capped hot-tier slot. No `arch-critical.md` (HOT) change:
the hot facts are broad invariants (resolver tiers, dual trees, gates), and a single harness's retirement
is narrower than any current hot entry, so nothing was displaced; the hot file's "Map of arch.md" stays
accurate (no top-level sections were added or renamed).

- Routed: **cold** — *Architect Role Prompt Injection* (`arch.md:291`) — dropped `gemini` from the
  built-in `HarnessProvider` injection list; noted the built-in provider was retired (#1338) with a
  pointer to the escape hatch.
- Routed: **cold** — *Supported Architect Harnesses & Conversation Resume* (`arch.md:311`) — replaced the
  stale "**Gemini is builder-only**" framing with current state: the built-in `gemini` harness is retired
  for **both** roles (#1338), fails closed at spawn/launch/reconnect/clean-exit, and is reachable only via
  an explicit custom `gemini` harness selected through `shell.builderHarness`/`architectHarness`. Also
  refreshed the now-stale override-awareness example (`--builder-cmd gemini` → `--builder-cmd opencode`,
  since a bare `gemini` command now fails closed rather than resolving a harness).

## Lessons Learned Updates

Routed both new lessons to the **COLD** archive (`codev/resources/lessons-learned.md`) — durable patterns,
but reference-depth rather than must-know-up-front, so no `lessons-critical.md` (HOT) change / displacement
(the hot cap is full of broader rules). The historical `[From #929]` resume-seam lesson (`:80`) was left
intact — its `gemini` mention is an accurate record of a past bug, not a current-support claim.

- Routed: **cold — Architecture** — *Retiring a shared resolver/registry entry must fail closed at every
  resolution path* (explicit-name path throws generic "unknown"; auto-detect path silently falls back to
  the default provider — a dangerous mis-injection). Keep the retired name in the detector, add a
  retirement sentinel before both exits, and grep every caller (spawn preflight, launch, and especially
  reconnect/clean-exit relaunch paths that mint fresh sessions).
- Routed: **cold — Documentation** — *A documented config/escape-hatch snippet must reproduce the tool's
  real mechanism, verified against the actual/retired implementation.* A snippet that passes internal
  validation but the underlying CLI rejects is worse than none; assert the real shape in a
  behavior-named test so the docs can't drift back.

## Technical Debt

- None introduced. The built-in `gemini` name is intentionally retained in `detectHarnessFromCommand` (so
  a `gemini` command is *recognized* and retired, not misclassified as unknown) — a deliberate design
  point, documented in `harness.ts` and the resolver tests, not debt.

## Flaky Tests

- No flaky tests encountered. The full unit suite ran deterministically (4145 passed / 48 pre-existing
  skips / 0 failed) across every phase and Review verification.

## Follow-up Items

- **`agy` as a builder harness** — explicitly out of scope for #1338 (issue non-goal). Would need its own
  issue if desired; `agy` architect support is separately tracked at #1063.
- **Generic unknown-harness error (`harness.ts:451`)** — its "configure a custom harness" advice omits the
  explicit-selector requirement too. Not part of the flagged gemini-retirement touchpoints (it fires for
  any unknown name), so intentionally left as-is; a candidate for a small consistency follow-up.
- **`arch.md:1062` caveat** — the pre-existing "unrecognized override commands default to the claude
  harness" footgun (cluesmith/codev#1062) is untouched by this work and remains tracked upstream.
