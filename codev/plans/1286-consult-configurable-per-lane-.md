# Plan: consult — configurable per-lane models and per-review-type lane selection

## Metadata
- **ID**: plan-2026-07-29-consult-configurable-lanes
- **Status**: draft
- **Specification**: [codev/specs/1286-consult-configurable-per-lane-.md](../specs/1286-consult-configurable-per-lane-.md)
- **Created**: 2026-07-29
- **Issue**: #1286

## Executive Summary

Implements the spec's Approach 1 (config-driven resolution behind one shared resolver), plus its
Approach 4 as a small escape hatch. The work splits along a natural seam: **what model a lane runs**
(consult's concern) and **which lanes run** (porch's concern). They share only the config type, so
Phase 1 lands the schema and validators both sides need, and the two halves proceed independently
afterward.

Ordering is driven by one asymmetry: **all validation is front-loaded into Phase 1**. Every
fail-fast requirement in the spec is a pure function of config, so building the validators before
any consumer means later phases wire up already-trusted values instead of re-deriving trust. It also
means the riskiest requirement — "no local allowlist of model ids" — is pinned by tests before any
code is in a position to violate it.

Two spec requirements need explicit call-outs because they are easy to implement wrongly and are the
places where a passing test suite could still ship the wrong thing:

1. **The reasoning-effort enum must be *bound to* `@openai/codex-sdk`'s exported `ModelReasoningEffort`
   type**, not retyped as a literal list. The binding is what makes local validation safe here while
   model ids are validated only for syntax. Phase 1 uses `satisfies readonly ModelReasoningEffort[]`
   so an SDK upgrade that changes the union is a **compile error**.
2. **The agy lane's skip-vs-hard-failure split** (Phase 3). Today every non-zero agy exit becomes a
   non-blocking `VERDICT: COMMENT`. Getting this wrong silently reintroduces the exact hole the spec
   was amended to close, and it fails *quietly* — the phase advances and looks fine.

**Status caveat carried forward from Specify**: the spec was force-advanced at `max_iterations: 3`,
not approved. Codex returned REQUEST_CHANGES on all three iterations, each time on a different valid
defect; its iteration-3 fix is committed but was never re-reviewed. This plan implements the spec as
written and does not attempt to re-litigate it, but the PR gate should treat the spec as
"out of review budget" rather than "signed off".

## Success Metrics

Inherited from the spec's Success Criteria (all 20), plus implementation-specific metrics:

- [ ] All specification criteria met
- [ ] `pnpm build` clean; `pnpm test` green in `packages/codev/`
- [ ] New unit tests cover all 19 spec test scenarios
- [ ] Zero behavior change with no config present — verified by assertion, not inspection, and
      written so it survives issue #1288's defaults change without edits (see Phase 2)
- [ ] No literal list of model ids anywhere in the diff (grep-verifiable)
- [ ] Documentation complete and identical across `codev/` and `codev-skeleton/`

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Config schema, validators, and resolvers"},
    {"id": "phase_2", "title": "Consult lane model wiring (claude, codex)"},
    {"id": "phase_3", "title": "Agy lane model passthrough and fail-fast split"},
    {"id": "phase_4", "title": "Cost accounting and metrics model-id column"},
    {"id": "phase_5", "title": "Porch lane-selection resolver consolidation"},
    {"id": "phase_6", "title": "Documentation and skeleton parity"}
  ]
}
```

## Phase Breakdown

### Phase 1: Config schema, validators, and resolvers
**Dependencies**: None

#### Objectives
- Land every new config key in the `CodevConfig` type.
- Implement all fail-fast validation as pure, independently testable functions.
- Provide the two resolvers (lane model id; lane composition) that later phases consume.

#### Deliverables
- [ ] `CodevConfig` extended: `consult.models`, `consult.reasoningEffort`, `consult.pricing`,
      `porch.consultation.modelsByType`, `porch.consultation.byProtocol`
- [ ] New module `packages/codev/src/lib/consult-lanes.ts` — validators + resolvers
- [ ] **`listProtocolNames()` added to `lib/skeleton.ts`** — cross-tier protocol + alias enumeration
      (new API; no existing function does this)
- [ ] Validators invoked from `loadConfig()`, alongside the existing harness validation
- [ ] `config.ts` file-header comment corrected: "three layers" → five (in-scope drive-by per spec Notes)
- [ ] Unit tests for every validation rule and both resolvers

#### Implementation Details

**Types** (`packages/codev/src/lib/config.ts`):

```ts
consult?: {
  integrationBranch?: string;                       // existing
  models?: Partial<Record<'claude'|'codex'|'gemini', string>>;
  reasoningEffort?: { codex?: ModelReasoningEffort };
  pricing?: { codex?: { inputPer1M: number; cachedInputPer1M: number; outputPer1M: number } };
};
porch?: {
  consultation?: {
    models?: string | string[];                     // existing
    modelsByType?: Record<string, string | string[]>;
    byProtocol?: Record<string, {
      models?: string | string[];
      modelsByType?: Record<string, string | string[]>;
    }>;
  };
};
```

Types are permissive where config is user-authored (a `Record<string, …>` for the discovered key
spaces) — the *validators*, not the type system, produce the user-facing errors. Typing
`modelsByType` as a closed union would make a typo a TS error in our own tests while still
type-checking nothing at runtime, where the JSON actually arrives.

**The reasoning-effort binding** (the requirement most likely to be implemented as a plain literal):

```ts
import type { ModelReasoningEffort } from '@openai/codex-sdk';
const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const
  satisfies readonly ModelReasoningEffort[];
```

`satisfies` is the load-bearing token. If a future SDK drops or renames a member, this line fails to
compile — which is the spec's stated requirement (drift must break the build, not the behavior).
A `const x: string[] = [...]` would satisfy the tests and violate the spec.

**Model-id syntax** — exactly the spec's rule, as a single named constant so it is greppable and
reviewable:

```ts
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
```

**Validators** (each throws with the offending key, the valid alternatives, and — where resolvable —
the config file that supplied the value):
- `validateConsultModels` — keys ⊆ `{claude, codex, gemini}`; values match `MODEL_ID_RE`.
- `validateReasoningEffort` — keys ⊆ `{codex}`; values ∈ `REASONING_EFFORTS`.
- `validatePricing` — `codex` present ⇒ all three numeric rate keys present (partial = error).
- `validateLaneComposition` — every lane name ∈ `VALID_MODELS`, or the whole value is `"none"` /
  `"parent"`; applied at all four precedence levels.
- `validateKeySpaces` — `byProtocol` keys ⊆ discovered protocol names; `modelsByType` keys ⊆
  discovered review types. Hard error, no warn mode.

**Where validation runs — `loadConfig()`, not at point of use.** Every validator above is invoked
from `loadConfig()` in `lib/config.ts`, immediately after the existing custom-harness validation
block, so malformed config is a **config-load-time** error as the spec requires. This is not a new
pattern: `loadConfig` already calls `validateCustomHarnessConfig` for exactly this reason, and that
call is the precedent to follow.

Deferring validation to consult/porch resolution time would satisfy the phase's unit tests while
violating the spec — a typo would survive until the moment a consultation runs, which is precisely
the late failure the fail-fast requirement exists to prevent. Stating it here because a builder
reading only "pure validators" could reasonably wire them at the call sites instead.

*Accepted blast radius*: because `loadConfig` is shared, a malformed `consult.models` will fail
unrelated commands (`afx status`, etc.), not just consultations. That is the intended fail-fast
behavior and matches how a malformed `harness` block already behaves today. It is called out so it
is recognized as a deliberate choice at review rather than an accident.

**Key-space discovery** — the spec's deliberate asymmetry, and the part of this plan most likely to
be misread:
- *Protocol names* = **union across all four tiers** (`.codev/protocols/`, `codev/protocols/`,
  runtime cache, installed skeleton). A name visible anywhere is runnable, so configuring it is legal.
- *Review types* = `verify.type` values from the **resolved** `protocol.json` per name only (tier
  precedence `.codev/` > `codev/` > cache > skeleton). A shadowed skeleton copy's types must **not**
  leak in — that file will never execute.

**This requires a new shared enumeration API — it does not exist today.** Verified: `lib/skeleton.ts`
exposes `resolveCodevFile` (single file, four tiers) and `listSkeletonFiles` (skeleton tier only);
neither enumerates protocol names across tiers. `porch/protocol.ts:53-77` walks protocol directories
for alias lookup, but only three tiers — it **omits the framework cache** — and it stops at the first
alias match rather than building a set. Neither is reusable as-is, so "reuse the resolver" would have
left the builder to improvise the most correctness-sensitive part of the phase.

Add to `lib/skeleton.ts`, beside the tier logic it belongs with:

```ts
/** All protocol names visible at any tier, plus their aliases. Union, not precedence. */
export function listProtocolNames(workspaceRoot?: string): Set<string>
```

It walks all **four** tier directories (matching `resolveCodevFile`'s tier list, not
`findProtocolFile`'s three-tier one) and, for each protocol directory found, includes both the
directory name and any `alias` declared in its `protocol.json`.

**Aliases must be included**, or the validator rejects legitimate config: protocols may declare an
`alias`, `porch` resolves by it, and a user may reasonably write `byProtocol.<alias>`. Rejecting an
alias the CLI itself accepts would be a fail-fast rule that fails correct config — worse than the
gap it closes.

Review-type discovery then reads the **resolved** `protocol.json` per name via the existing
`resolveCodevFile` (precedence, one file per name) and unions their `verify.type` values.

*Noted, not fixed here*: `findProtocolFile`'s alias scan skipping the cache tier is a pre-existing
inconsistency. It is out of scope for this issue; the new API is simply written correctly rather than
copying the bug. Worth a follow-up issue.

**Resolvers**:
- `resolveLaneModel(config, lane): { id?: string; source?: string }` — returns the configured id and
  a human-readable source for error messages; `undefined` id means "use the backend's current
  hardcoded default", which is how zero-config behavior is preserved.
- `resolveLaneComposition(config, protocol, reviewType, protocolModels)` — the four-level ladder,
  returning `{ models, mode }` exactly like today's `resolveConsultationModels` so Phase 5 is a
  substitution rather than a rewrite.

#### Acceptance Criteria
- [ ] Every validator rejects its invalid inputs and accepts its valid ones, with the offending key named
- [ ] **Malformed config throws from `loadConfig()`**, not at consult/porch resolution time — asserted
      by a test that calls `loadConfig` alone and expects a throw
- [ ] `listProtocolNames()` returns names from all four tiers and includes declared aliases
- [ ] `resolveLaneComposition` reproduces today's behavior when only `porch.consultation.models` is set
- [ ] Unknown-to-Codev model ids (e.g. `future-model-9`) pass validation — the no-allowlist guarantee
- [ ] Namespaced / vendor-prefixed / tagged ids pass unmodified, including `gpt-5.6-sol` (a real id
      whose `-sol` suffix is load-bearing — see Notes on #1288)
- [ ] Removing a member from the local effort list fails `tsc` (binding is real, verified manually once)
- [ ] All tests pass

#### Test Plan
- **Unit**: spec scenarios 6 (precedence ladder), 7 (`none`/`parent` at every level), 9, 10, 11, 16,
  17, 18; pricing completeness; reasoning-effort enum accept/reject.
- **Integration**: none — this phase has no consumers yet, by design.
- **Manual**: temporarily edit `REASONING_EFFORTS` to include a bogus member; confirm `pnpm build` fails.

#### Rollback Strategy
Self-contained and unreferenced by any consumer: revert the commit. No runtime behavior exists yet
to roll back.

#### Risks
- **Risk**: key-space discovery is implemented by re-walking directories instead of the resolver,
  and drifts from how porch actually loads protocols.
  - **Mitigation**: mandated reuse of `lib/skeleton.ts`; a test asserting a locally-shadowed protocol
    contributes its name but not the skeleton copy's review types.
- **Risk**: the effort enum is written as a plain literal, silently voiding the spec's binding requirement.
  - **Mitigation**: called out here and in the acceptance criteria; verified by the manual `tsc` check.

---

### Phase 2: Consult lane model wiring (claude, codex)
**Dependencies**: Phase 1

#### Objectives
- The two SDK lanes run the configured model and reasoning effort.
- A provider-rejected id fails loudly with no fallback.

#### Deliverables
- [ ] `runClaudeConsultation` takes its model from `resolveLaneModel(config, 'claude')`
- [ ] `runCodexConsultation` takes model + `modelReasoningEffort` from config
- [ ] Provider-rejection errors name the config key that supplied the id
- [ ] `consult --model-id <id>` per-invocation override (spec COULD; outranks config)
- [ ] Unit tests asserting the id reaching each SDK

#### Implementation Details
`consult/index.ts` already imports `loadConfig` and calls it for `integrationBranch`; resolve lane
config once in `runConsultation` and thread it to the two runners rather than calling `loadConfig`
inside each.

Both runners already `throw` on SDK error and their `finally` blocks record metrics with a non-zero
exit — so the "loud failure, no review file" contract holds *for these two lanes* with no change to
control flow. The only addition is wrapping the thrown error to name the config key. **Do not add a
catch that substitutes a default id** — that is the specific regression this phase must not
introduce, and it would look like defensive programming in review.

Keep the hardcoded ids as the literal fallback when config is absent, so zero-config behavior is
preserved by construction rather than by a default written somewhere new.

**Test the default in two layers, not with literal ids** (see Notes on issue #1288, which changes
the shipped defaults to `claude-opus-5` and `gpt-5.6-sol`):

- **Layer A — behavioral, rebase-proof**: with no config, assert the SDK receives *the module's
  default constant*. This is what actually guards the config plumbing, and it stays correct across a
  defaults change with no edit.
- **Layer B — one deliberate pin**: a single test asserting those constants equal the ids the repo
  ships at this commit. One line to update when defaults change, and it fails loudly if a default
  drifts by accident.

Layer A alone is tautological — it would pass even if someone changed a default constant
unintentionally — which is exactly why B exists as a separate, intentionally-edited line. Writing
literal ids into every assertion instead would scatter the same edit across the suite and silently
rot the moment #1288 lands.

#### Acceptance Criteria
- [ ] Configured ids reach `claudeQuery({ options: { model } })` and `codex.startThread({ model })`
- [ ] Unset config → the module default constants @ `medium`, byte-identical to pre-change behavior
      (Layer A), with one pinned test asserting what those constants currently are (Layer B)
- [ ] `--model-id` outranks config; invalid values rejected by the same syntax rule
- [ ] Provider rejection → non-zero exit, no output file, error names the config key
- [ ] All tests pass

#### Test Plan
- **Unit**: spec scenarios 1, 2, 3 (SDK-mocked, following `codex-sdk.test.ts`'s existing pattern), 12.
- **Integration**: one real `consult -m codex --prompt "reply OK"` with a configured current model.
- **Manual**: configure a deliberately bogus id; confirm the failure is loud and no review file lands.

#### Rollback Strategy
Revert; the hardcoded literals remain in place as the fallback path, so reverting restores today's
behavior exactly.

#### Risks
- **Risk**: an SDK swallows a bad id and silently substitutes, defeating fail-fast.
  - **Mitigation**: Phase 4 records the resolved id, making substitution detectable after the fact;
    the spec documents this bound.

---

### Phase 3: Agy lane model passthrough and fail-fast split
**Dependencies**: Phase 1

#### Objectives
- The gemini lane accepts a configured model via `agy --model`.
- Separate *environment* failures (skip, as today) from *configuration* failures (hard fail).

#### Deliverables
- [ ] `--model <id>` appended to agy args when configured; omitted entirely when not
- [ ] Cause-based failure split in `runAgyConsultation`
- [ ] Tests covering both directions of the split

#### Implementation Details
This is the phase with the quiet failure mode, so the split is stated as an invariant rather than a
description: **`settleSkip` may only be reached for environment causes.**

- No `consult.models.gemini` configured → today's behavior, untouched. Auth markers, timeout,
  non-response, and non-zero exit all still `settleSkip(...)` with `VERDICT: COMMENT`.
- `consult.models.gemini` configured → the **guaranteed floor** from the spec: a non-zero exit is a
  hard failure (reject/throw), not a skip. Opting into a model is opting out of "quietly proceed
  without this lane".
- Auth and timeout paths remain skips **in both cases** — they are environment causes, and the spec
  is explicit that a degraded agy lane (#1032 / #1033) keeps its non-blocking property.
- Marker-based detection of agy's model-rejection text is the spec's *preferred* mechanism but is
  explicitly not required: agy's rejection text is not contractual. Implement the deterministic floor
  first. If a stable marker is observed while testing, add it to sharpen the error message — never as
  the mechanism the guarantee depends on.

Argv order: append `--model <id>` **before** the existing `--print <prompt>` terminal argument, since
the file's own comment records that agy parses `--print` as string-valued and its value must
immediately follow it.

#### Acceptance Criteria
- [ ] Unconfigured lane: unauthenticated/timed-out agy still yields a non-blocking `COMMENT` skip
- [ ] Configured lane: non-zero exit yields a hard failure, no review file, porch does not advance
- [ ] `--model` absent from argv when unconfigured (zero-config parity)
- [ ] All tests pass

#### Test Plan
- **Unit**: spec scenario 19, both directions; argv assertion for presence/absence of `--model`.
- **Integration**: if `agy` is authenticated locally, one run with a valid model and one with a
  bogus one, confirming skip vs. hard failure.
- **Manual**: verify porch does not advance the phase after a configured-lane hard failure — the
  behavior the spec change exists to produce, and not observable from a unit test alone.

#### Rollback Strategy
Revert. The skip path is the pre-existing behavior, so a revert is strictly a return to
non-blocking-everything.

#### Risks
- **Risk**: the split is implemented as "any non-zero exit is now a hard failure", breaking the
  degraded-lane property for unconfigured workspaces and wedging their phases.
  - **Mitigation**: the invariant is stated as *may only skip for environment causes*, and the
    unconfigured-lane regression test fails loudly if the condition is inverted.

---

### Phase 4: Cost accounting and metrics model-id column
**Dependencies**: Phases 2 **and 3**

#### Objectives
- Record which model actually ran.
- Stop reporting confidently wrong codex costs.

#### Deliverables
- [ ] Idempotent `ALTER TABLE` migration adding a model-id column, guarded by `PRAGMA table_info`
- [ ] `MetricsRecord` carries the resolved id; all `recordMetrics` call sites updated
- [ ] Codex cost uses `consult.pricing.codex` when set; `null` for a non-default model without it
- [ ] Tests

#### Implementation Details
`consultation_metrics` is created via `CREATE TABLE IF NOT EXISTS` with no migration mechanism, so
add one narrowly: read `PRAGMA table_info(consultation_metrics)`, add the column if absent. Must be
safe against an existing `~/.codev/metrics.db` with rows, and re-runnable.

**The `model` column keeps storing the lane name.** `consult stats` groups on it; repurposing it
would silently change every existing report. The model id goes in the new column.

**All three lanes must populate it, which is why this phase depends on Phase 3 as well as Phase 2.**
The agy lane records metrics through its own paths — including `settleSkip`, which writes a metrics
row for a skipped consultation. If Phase 4 landed on Phase 2 alone, the codex and claude lanes would
record ids while the gemini lane silently wrote `NULL`, and the resulting gap would look like a data
bug rather than an unfinished phase. Sequencing after Phase 3 means every call site that can produce
a metrics row already knows its resolved id. For a skipped agy run the id is recorded when one was
configured, and left null when none was — null then means "no model was chosen", not "we forgot".

Cost logic, in order: `consult.pricing.codex` if set → use it; else configured non-default model →
`costUsd: null`; else → today's `CODEX_PRICING`. Claude is untouched (the SDK reports
`total_cost_usd` directly); the agy lane emits no usage data at all.

#### Acceptance Criteria
- [ ] Migration runs twice against the same DB without error, preserving rows
- [ ] Resolved id recorded; `model` still holds the lane name; `consult stats` output unchanged
- [ ] Non-default codex model without pricing → `cost_usd` null; with pricing → computed from it
- [ ] All tests pass

#### Test Plan
- **Unit**: spec scenarios 13, 14; migration idempotency against a fixture DB built on the old schema.
- **Integration**: run `consult stats` before and after migration; output must be identical.
- **Manual**: inspect `~/.codev/metrics.db` schema after a real consultation.

#### Rollback Strategy
Code revert only — an added SQLite column is harmless to leave in place, and the guarded migration
makes re-application a no-op. Do **not** add a down-migration that drops the column; dropping a
column with data is a worse failure mode than an unused column.

#### Risks
- **Risk**: the migration corrupts an existing metrics DB.
  - **Mitigation**: `ADD COLUMN` is non-destructive; tested against a fixture on the old schema.

---

### Phase 5: Porch lane-selection resolver consolidation
**Dependencies**: Phase 1

#### Objectives
- One validated code path for lane composition, used by both `porch next` and `porch done`.
- The four-level precedence ladder in production use.

#### Deliverables
- [ ] `porch/next.ts`'s `resolveConsultationModels` delegates to Phase 1's resolver
- [ ] The inline duplicate at `porch/index.ts:436-452` is **deleted** and calls the shared resolver
- [ ] `porch done`'s silent `catch` around config loading removed — config errors surface
- [ ] Tests, including next/done agreement

#### Implementation Details
The duplicate in `porch done` differs from `next`'s in three ways confirmed during Specify: no lane
validation, a `catch` that swallows config errors into protocol defaults, and no single-string
normalization. All three are removed by substitution, not patched in place.

Removing the `catch` is a deliberate behavior change and the only user-visible regression risk in
this phase: a workspace with malformed config that currently limps along on protocol defaults will
now fail loudly at `porch done`. That is the spec's fail-fast requirement applied to an existing
latent bug — worth stating in the review so it is not mistaken for an accident.

`findReviewFiles` and the missing-model logic already take the effective list as a parameter, so they
need no change beyond receiving the new resolution.

#### Acceptance Criteria
- [ ] `modelsByType` and `byProtocol` select lanes in `porch next`'s emitted consult commands
- [ ] `porch done` enforces review files for exactly the same set `porch next` emitted
- [ ] Malformed config fails `porch done` loudly instead of falling back
- [ ] No second copy of precedence logic remains (grep-verifiable)
- [ ] All tests pass

#### Test Plan
- **Unit**: spec scenarios 4, 5 (the PIR CMAP-2 guard), 6, 7, 8 (next/done agreement), 11.
- **Integration**: existing porch tests (`next.test.ts`, `done-verification.test.ts`,
  `consultation-models.test.ts`) must pass unmodified — they pin today's behavior and are the
  regression net for this substitution.
- **Manual**: `porch next` on this very project with a temporary `modelsByType` override; confirm
  the emitted commands change accordingly.

#### Rollback Strategy
Revert. Both call sites return to their current (duplicated) implementations.

#### Risks
- **Risk**: existing porch tests mock config in ways that assume the old resolution shape, producing
  false failures that get "fixed" by loosening the tests.
  - **Mitigation**: keep the resolver's return shape identical to today's `{ models, mode }`;
    treat any required test change as a signal to re-examine the code, not the test.

---

### Phase 6: Documentation and skeleton parity
**Dependencies**: Phases 1–5

#### Objectives
- Document both config blocks, the precedence ladder, and the fail-fast contract.
- Keep `codev/` and `codev-skeleton/` identical.

#### Deliverables
- [ ] `codev/resources/commands/consult.md` — config reference, precedence table, fail-fast contract
- [ ] `codev-skeleton/resources/commands/consult.md` — identical
- [ ] Explicit statement that Codev does **not** validate model ids and defers to the provider
- [ ] A worked `byProtocol` example showing PIR's CMAP-2 footprint preserved under a widened global default

#### Implementation Details
Documentation must state the *asymmetry* plainly — ids are provider-authoritative, reasoning effort
is a locally-validated closed enum — because a user who reads only "fail fast on invalid values"
will reasonably expect Codev to reject a bad model id at config time, and it will not.

Per this repo's own lesson, `diff` the two files as the parity check rather than eyeballing them.
CLAUDE.md / AGENTS.md need no change: no protocol, gate, or workflow rule changes here.

#### Acceptance Criteria
- [ ] `diff codev/resources/commands/consult.md codev-skeleton/resources/commands/consult.md` is empty
- [ ] Every new config key documented with its valid values and failure mode
- [ ] Precedence ladder documented as an ordered list matching the implementation

#### Test Plan
- **Unit**: none.
- **Integration**: none.
- **Manual**: `diff` parity check; follow the docs from scratch to configure a lane and confirm the
  documented behavior is what actually happens.

#### Rollback Strategy
Revert; docs-only.

#### Risks
- **Risk**: docs drift between the two trees.
  - **Mitigation**: `diff` as an explicit acceptance criterion.

---

## Dependency Map
```
Phase 1 (config + validators + resolvers)
   ├──→ Phase 2 (claude/codex wiring) ──┐
   ├──→ Phase 3 (agy passthrough + split)┼──→ Phase 4 (cost + metrics) ──→ Phase 6 (docs)
   └──→ Phase 5 (porch resolver consolidation) ──────────────────────────────┘
```
Phases 2, 3, and 5 are mutually independent once Phase 1 lands. **Phase 4 joins 2 and 3**: it must
record resolved model ids for *every* lane, and the agy lane's metrics call sites (including the
skip path) only know their id after Phase 3. Phase 6 documents the finished surface, so it comes last.

## Resource Requirements
### Development Resources
- **Engineers**: one builder; TypeScript, vitest, SQLite, and familiarity with the porch state machine.
- **Environment**: local repo; `agy` authenticated is *helpful* for Phase 3 integration testing but
  not required (the unit tests mock the spawn).

### Infrastructure
- **Database changes**: one added column on `~/.codev/metrics.db` (user-global, additive, guarded).
- **New services**: none.
- **Configuration updates**: new optional keys only; no existing config becomes invalid.
- **Monitoring additions**: none.

## Integration Points
### External Systems
- **Anthropic Claude Agent SDK** — Integration: library; Phase 2; authority on claude ids.
- **OpenAI Codex SDK** — Integration: library; Phases 2 and 4; authority on codex ids and the
  reasoning-effort union this plan binds to.
- **Antigravity CLI (`agy`)** — Integration: subprocess; Phase 3; unavailable/unauthenticated is a
  supported state (non-blocking skip), not a failure.

### Internal Systems
- **`lib/config.ts`** — Phase 1; the five-layer loader all config flows through.
- **`lib/skeleton.ts`** — Phase 1; four-tier resolver reused for key-space discovery.
- **`commands/porch/{next,index}.ts`** — Phase 5; the two call sites being consolidated.
- **`commands/consult/metrics.ts`** — Phase 4; metrics schema.

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| A model-id allowlist creeps in "for safety" | M | H | Explicit spec constraint; test asserting an unknown id passes through; grep the diff before PR | Builder |
| Effort enum written as a literal, voiding the SDK binding | M | M | `satisfies` mandated in Phase 1; manual `tsc` verification | Builder |
| agy split inverted → unconfigured lanes start hard-failing | L | H | Invariant stated as "skip only for environment causes"; regression test on the unconfigured path | Builder |
| next/done disagree after consolidation, wedging a project | L | H | Identical return shape; scenario 8 agreement test; existing porch suites unmodified | Builder |
| Removing `porch done`'s silent catch breaks a workspace with latent bad config | M | L | Intended fail-fast behavior; called out in the PR description rather than hidden | Builder |
| Metrics migration damages an existing DB | L | M | Additive `ADD COLUMN`, `PRAGMA`-guarded, fixture-tested; no down-migration | Builder |

### Schedule Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| Spec was force-advanced, not approved — a further defect surfaces mid-implementation | M | M | Stop and consult the architect rather than patching the spec silently mid-phase | Builder |
| agy behavior can't be exercised locally (unauthenticated) | M | L | Unit tests mock the spawn; integration testing is best-effort and its absence is reported, not silently skipped | Builder |

## Validation Checkpoints
1. **After Phase 1**: validators reject every spec-listed invalid input; an unknown-to-Codev model id passes.
2. **After Phase 2**: configured ids reach both SDKs; zero-config behavior byte-identical.
3. **After Phase 3**: configured-lane failure is hard; unconfigured-lane failure still skips.
4. **After Phase 4**: `consult stats` output unchanged; migration idempotent.
5. **After Phase 5**: `porch next` and `porch done` agree under every precedence combination.
6. **Before PR**: full suite green; `diff` parity on docs; diff grepped for stray id lists.

## Monitoring and Observability
### Metrics to Track
- `consultation_metrics` model-id column — reveals which model actually ran, and is the detector for
  a provider silently substituting a model.
- `cost_usd` null-rate on the codex lane — a rising rate means workspaces are running non-default
  models without pricing overrides (informational, not an error).

### Logging Requirements
- Config-validation failures: the offending key, the valid alternatives, and the supplying config
  file, at error level.
- Resolved lane model ids: existing `[MODEL] Starting consultation...` line extended with the id, so
  a run's transcript records what it actually used.

### Alerting
None. This is a local CLI with no service component.

## Documentation Updates Required
- [ ] `codev/resources/commands/consult.md` (+ skeleton copy) — the substantive update
- [ ] `config.ts` header comment (three → five layers)
- [ ] API documentation — N/A (no public API)
- [ ] Architecture diagrams — N/A (no structural change)
- [ ] Runbooks — N/A
- [ ] User guides — covered by the consult reference
- [ ] `arch.md` / `lessons-learned.md` — deferred to the Review phase's routing step, per Spec 987

## Post-Implementation Tasks
- [ ] Performance validation — N/A (no hot path touched)
- [ ] Security audit — covered by the argv-hygiene test (spec scenario 10); no new trust boundary
- [ ] Load testing — N/A
- [ ] User acceptance — the reporting workspace can express its lane setup in config without forking
      `protocol.json`; this is the issue's actual acceptance test
- [ ] Monitoring validation — confirm the model-id column populates on a real run

## Expert Review
**Date**: pending
**Model**: pending — porch runs the 3-way consultation at this phase's verify step.
**Key Feedback**: pending.

**Plan Adjustments**: pending.

## Approval
- [ ] Technical Lead Review
- [ ] Engineering Manager Approval
- [ ] Resource Allocation Confirmed
- [ ] Expert AI Consultation Complete

## Change Log
| Date | Change | Reason | Author |
|------|--------|--------|--------|
| 2026-07-29 | Initial plan | Spec force-advanced to Plan phase | Builder aspir-1286 |

## Notes

**Phase-to-PR mapping**: all six phases ship as commits on one branch in a single PR, per the
builder prompt. Phases are commit boundaries, not PR boundaries.

**On the "no allowlist" constraint**: the most likely way this implementation goes wrong is not a
bug but an instinct — a reviewer or the builder adding a "known models" list because unvalidated
strings feel unsafe. The spec forbids it, this plan repeats the prohibition in Phase 1 and the risk
table, and the pre-PR checklist includes grepping the diff for one. The counter-argument to have
ready: a stale allowlist would block exactly the model this issue was filed to enable.

**On the spec's status**: force-advanced at `max_iterations: 3`, with Codex requesting changes on
every iteration. This plan does not paper over that. If implementation surfaces a further spec
defect, the response is to raise it with the architect via `afx send`, not to quietly amend the spec
mid-phase.

**Issue #1288 changes the shipped defaults** — `claude` → `claude-opus-5`, `codex` → `gpt-5.6-sol`
(live-probed; plain `gpt-5.6` is rejected under ChatGPT-account auth, so the `-sol` suffix is
load-bearing). It is a separate project; this spec's out-of-scope call on defaults stands.

**Required before the implement phase**: rebase onto `main` and check whether #1288 has landed. The
default-preservation tests are structured in two layers (Phase 2) precisely so that this rebase
touches one deliberate line rather than silently invalidating assertions scattered across the suite.
`gpt-5.6-sol` is also carried into Phase 1's accept-vectors — a real id with a meaningful suffix is
a better check that the syntax rule isn't too tight than any invented example.

**Post-merge, architect-owned**: this repo opts into the new ids via its own `.codev/config.json`.
Deliberately not in this PR, so the PR changes no lane's behavior for anyone by default.
