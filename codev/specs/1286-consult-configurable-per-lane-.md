# Specification: consult — configurable per-lane models and per-review-type lane selection

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
-->

## Metadata
- **ID**: spec-2026-07-29-consult-configurable-lanes
- **Status**: draft
- **Created**: 2026-07-29
- **Issue**: #1286

## Clarifying Questions Asked

No human clarification round was run: this is an ASPIR project, the issue body is unusually
specific, and every open item below was answerable from the issue plus the code. The questions
that mattered, and the answers used:

1. **Q: Is "fail fast on an unknown/invalid model id" meant to be a static allowlist of ids?**
   A (derived): No — and it must not be. An allowlist of model ids is precisely the artifact that
   goes stale and blocks newer models, which is the problem being reported. This repo's own
   standing lesson is to never assert a model id doesn't exist from a cached catalog. The
   fail-fast requirement is therefore satisfied by *structural* validation plus *provider
   authority*: reject malformed config loudly at load time, and when the provider rejects an id,
   fail the consultation loudly with the provider's message and no fallback to the hardcoded
   default. See "Fail-fast semantics" under Desired State.

2. **Q: Does the `gemini` (agy) lane get a configurable model too, or is it claude/codex only?**
   A (verified): `agy --help` exposes `--model  Model for the current CLI session`, and Codev
   currently passes no `--model` (so agy's default, Flash, is used). All three lanes are therefore
   configurable. The gemini lane stays configurable-but-unset-by-default so behavior is unchanged
   for existing workspaces.

3. **Q: Does per-protocol scoping ("PIR CMAP-2 cost invariant") ride along in this spec, or is it
   deferred?**
   A (from the issue's Note): it rides along. Without it, a workspace-wide `porch.consultation`
   override silently inflates lighter protocols — the exact failure PIR's design calls out. A
   config mechanism that only lets you *widen* lane composition globally would ship a new
   footgun while removing an old one.

4. **Q: Should defaults change (e.g. drop the gemini lane, given the offered production evidence)?**
   A (scoping decision): No. Changing default lane composition is a separate, evidence-driven
   decision with cost/quality consequences for every adopter. This spec ships the *mechanism*;
   defaults stay byte-identical. Out of scope, recorded below.

5. **Q: Should the `--model` escape hatch exist on the `consult` CLI itself?**
   A (scoping decision): Yes, as a COULD — a per-invocation override is cheap and useful for
   ad-hoc comparisons, but the config surface is the load-bearing deliverable.

## Problem Statement

`consult` pins the model id for each lane in source:

- the `claude` lane is pinned to `claude-opus-4-6`
- the `codex` lane is pinned to `gpt-5.4` at `medium` reasoning effort
- the `gemini` lane passes no model at all, so it runs the Antigravity CLI's default (Flash)

A workspace that wants to run a newer model — `claude-opus-5` for spec/plan reviews, `gpt-5.6` on
the codex lane — has no sanctioned mechanism. The observed workarounds are patching `dist/` in the
installed package (erased by the next `codev update`) or shadow-forking framework files.

Separately, **which lanes run** is fixed per protocol by `protocol.json`'s `verify.models`, with a
single global escape hatch (`porch.consultation.models`) that applies to every protocol and every
review type at once. A workspace that wants, say, two lanes at `spec`/`plan` and one at `impl`
cannot express that. The reporting workspace implemented it by tier-2-shadowing the `spir`,
`aspir`, and `pir` `protocol.json` files — which works, and which recreates exactly the
stale-shadow-copy rot class that produced 17 drifted files in this repo (fixed in PR #1281).

Both gaps push users toward forking framework files. The fix is to make the two things they
actually want — *which model per lane* and *which lanes per review type* — first-class config.

## Current State

### Where the pins live

| Location | Pin |
|---|---|
| `packages/codev/src/commands/consult/index.ts:417-419` | `thread = codex.startThread({ model: 'gpt-5.4', modelReasoningEffort: 'medium', ... })` |
| `packages/codev/src/commands/consult/index.ts:558` | `claudeQuery({ options: { model: 'claude-opus-4-6', ... } })` |
| `packages/codev/src/commands/consult/index.ts` (agy args, ~`:846`) | `args = ['--sandbox', '--print-timeout', ...]` — no `--model`, so agy's default is used |

None of these read config. `loadConfig` is already imported by `consult/index.ts` (it is used for
`consult.integrationBranch`), so the plumbing exists but is not used for model selection.

### How lane composition resolves today

`porch.consultation.models` (config) overrides `verify.models` (protocol). Precedence is
implemented **twice**:

- `packages/codev/src/commands/porch/next.ts:63-90` — `resolveConsultationModels()`. Validates each
  name against `VALID_MODELS = ['gemini', 'codex', 'claude', 'hermes']`; supports the special
  string modes `"none"` (skip consultation) and `"parent"` (delegate to an architect gate).
- `packages/codev/src/commands/porch/index.ts:436-452` — an inline copy inside `porch done` that
  applies the same precedence **without validation** and swallows config-load errors
  (`catch { /* use protocol defaults */ }`).

The two copies must agree, because `porch next` emits the consult commands and `porch done`
enforces that a review file exists for each effective model. They are a single-source-of-truth
violation waiting to bite.

Configuration is flat: one list for all protocols and all review types. Review types actually in
use across shipped protocols are `spec`, `plan`, `impl`, `pr`, `investigation`, and `critique`.

### Cost and observability coupling

- `CODEX_PRICING` (`consult/index.ts:386`) hardcodes gpt-5.4's per-1M rates and is used to compute
  `cost_usd` for every codex consultation. Point the lane at a differently-priced model and the
  recorded cost is silently wrong.
- Claude's cost comes from the Agent SDK result (`total_cost_usd`), so it tracks the model
  automatically.
- `consultation_metrics.model` stores the **lane** name (`'codex'`), not the model id. Once ids are
  configurable, metrics can no longer answer "which model produced this review, and at what cost".

### Workarounds in the field

1. Patch the installed `dist/` — lost on `codev update`.
2. Shadow-fork `protocol.json` into `.codev/protocols/<name>/` — works, drifts silently, and is the
   documented rot class from PR #1281.
3. Do nothing and run older models.

## Desired State

### Ask 1 — per-lane model ids

```jsonc
// .codev/config.json (or any layer of the existing 5-layer config stack)
{
  "consult": {
    "models": {
      "claude": "claude-opus-5",
      "codex":  "gpt-5.6",
      "gemini": "gemini-3-pro"       // passed through to `agy --model`
    },
    "reasoningEffort": {
      "codex": "high"                // currently pinned to "medium"
    }
  }
}
```

Every key is optional. An unset lane keeps today's hardcoded default, so an existing workspace with
no `consult.models` block behaves byte-identically.

Because config is loaded through the existing five-layer stack (defaults → framework cache →
`~/.codev/config.json` → `.codev/config.json` → `.codev/config.local.json`), a user can set model
ids globally for every project, per-project, or per-engineer with no new machinery.

### Ask 2 — per-review-type and per-protocol lane selection

```jsonc
{
  "porch": {
    "consultation": {
      "models": ["gemini", "codex", "claude"],          // existing key, unchanged
      "modelsByType": {
        "spec": ["codex", "claude"],
        "plan": ["codex", "claude"],
        "impl": ["codex"],
        "pr":   ["codex", "claude"]
      },
      "byProtocol": {
        "pir": { "models": ["gemini", "codex"] }        // preserve PIR's CMAP-2 footprint
      }
    }
  }
}
```

**Resolution precedence** for a verify step of protocol `P` and review type `T`, highest first:

1. `porch.consultation.byProtocol[P].modelsByType[T]`
2. `porch.consultation.byProtocol[P].models`
3. `porch.consultation.modelsByType[T]`
4. `porch.consultation.models`
5. `protocol.json` → `verify.models`

This is the existing "config > protocol" rule, refined from one level to four. The special string
modes `"none"` and `"parent"` are accepted wherever a lane list is accepted, at every level, and
short-circuit as they do today.

`byProtocol` is what preserves PIR's CMAP-2 cost invariant: a workspace can widen SPIR without
inflating PIR, which today's flat override cannot express.

### Fail-fast semantics

The issue asks for fail-fast on invalid ids. The mechanism matters, because the obvious
implementation — an allowlist of known model ids — is itself the rot being reported. The split is:

**Validated strictly (hard error, no fallback):**
- Unknown *lane key* in `consult.models` / `consult.reasoningEffort` → error naming the valid lanes.
- Model id that is not a non-empty string, or that contains whitespace or shell metacharacters →
  error. (The gemini lane passes its id as a CLI argument; the check is a correctness *and* a
  hygiene requirement.)
- Unknown *lane name* in any `porch.consultation.*` list → error (today's behavior, extended to the
  new keys **and** to the `porch done` path, which currently skips validation entirely).
- Malformed shape anywhere (e.g. `modelsByType` not an object, a lane list that isn't an array of
  strings) → error.
- Unknown key in `byProtocol` or `modelsByType` → error, validated against protocols/review types
  discoverable through the four-tier resolver rather than a hardcoded list. See Open Questions.

**Not validated locally — the provider is the authority:**
- The model id itself. Codev never asserts an id does or doesn't exist. If the Agent SDK, the Codex
  SDK, or `agy` rejects the id, the consultation fails loudly: the provider's error text is
  surfaced, the process exits non-zero, no review file is written, and **there is no fallback to
  the hardcoded default**. A silent downgrade is the failure mode this spec exists to prevent.

The error message on provider rejection must name the config key and layer that supplied the id, so
the user can find it (the id may come from any of five config layers).

### Cost and observability

- The resolved model id is recorded alongside the lane in consultation metrics, so cost figures
  remain auditable after ids become configurable.
- Codex cost math is driven by rates that can be overridden in config; when the codex lane runs a
  non-default model with no rate override, the recorded cost is marked unknown (`null`) rather than
  computed from stale rates. Reporting a confidently wrong number is worse than reporting none.

### Documentation

`codev/resources/commands/consult.md` and its `codev-skeleton/` counterpart document both config
blocks, the precedence ladder, and the fail-fast contract — including the explicit statement that
Codev does not validate model ids and defers to the provider.

## Stakeholders
- **Primary Users**: workspaces running Codev consultations who need current models or a lane mix
  that differs from the shipped defaults — including the production workspace that filed #1286.
- **Secondary Users**: this repo's own architects and builders (every porch protocol runs through
  consult); adopters who inherit the skeleton's protocol files.
- **Technical Team**: Codev maintainers (`consult`, `porch`, `lib/config`).
- **Business Owners**: the Codev repo owner, who directed the request.

## Success Criteria
- [ ] `consult.models.{claude,codex,gemini}` in any config layer changes the model id actually sent
      to the corresponding backend (Agent SDK `model`, Codex SDK `model`, `agy --model`).
- [ ] `consult.reasoningEffort.codex` changes the Codex SDK's `modelReasoningEffort`; unset keeps
      `medium`.
- [ ] With no `consult` model config present, every lane's request is byte-identical to today's
      (`claude-opus-4-6`, `gpt-5.4` @ `medium`, agy default with no `--model`).
- [ ] `porch.consultation.modelsByType[T]` selects lanes for review type `T`, overriding
      `porch.consultation.models` and `protocol.json`'s `verify.models`.
- [ ] `porch.consultation.byProtocol[P]` scopes both `models` and `modelsByType` to protocol `P` and
      outranks the unscoped keys.
- [ ] `"none"` and `"parent"` behave identically at every precedence level.
- [ ] `porch next` and `porch done` resolve lane composition through **one shared, validated code
      path** — the duplicated inline resolver in `porch/index.ts` is gone, and the `done` path
      validates config instead of silently falling back to protocol defaults.
- [ ] Every malformed-config case listed under Fail-fast semantics produces a hard error naming the
      offending key and the valid alternatives.
- [ ] A provider-rejected model id fails the consultation loudly and non-zero, writes no review
      file, and never falls back to a hardcoded default.
- [ ] Consultation metrics record the resolved model id, not only the lane name.
- [ ] A codex consultation on a non-default model with no rate override records `cost_usd` as
      unknown rather than a figure computed from gpt-5.4 rates.
- [ ] The shadow-fork workaround is no longer needed: everything the reporting workspace achieved by
      forking `spir`/`aspir`/`pir` `protocol.json` is expressible in `.codev/config.json`.
- [ ] Documentation updated in **both** `codev/resources/commands/consult.md` and
      `codev-skeleton/resources/commands/consult.md`.
- [ ] All tests pass; new behavior covered by unit tests (see Test Scenarios).

## Constraints

### Technical Constraints
- **No `Baked Decisions` section in issue #1286** — no architect-pinned decisions to copy verbatim.
- Config must flow through the existing `loadConfig` five-layer stack in `packages/codev/src/lib/config.ts`;
  no new config file, no new loader.
- Defaults must not change. Absent config → today's exact behavior, ids included.
- The `model` column of `consultation_metrics` currently stores the lane name and is grouped on by
  `consult stats`; its meaning must not change under existing readers.
- The `gemini` lane dispatches to `agy`, whose model id space is agy's, not Google's API's; Codev
  passes the string through unexamined.
- Framework files must be mirrored across `codev/` and `codev-skeleton/`.
- No static allowlist of model ids anywhere in the implementation — this is a hard constraint, not a
  preference.

### Business Constraints
- Requested by the repo owner on behalf of a production workspace currently blocked on older models.
- Must not increase consultation cost for any workspace that does not opt in; must give workspaces a
  way to *reduce* cost (PIR's CMAP-2 footprint) rather than only widen it.

## Assumptions
- The Claude Agent SDK, the Codex SDK, and `agy` each error clearly on an unknown model id rather
  than silently substituting one. If any backend silently substitutes, that lane's fail-fast
  guarantee is bounded by the provider's behavior — noted as a risk, not designed around.
- `agy --model <id>` composes with the existing `--sandbox --print-timeout --add-dir --print`
  argument order (confirmed present in `agy --help`; exact interaction verified during implementation).
- Review-type strings in `verify.type` remain the stable key space for `modelsByType`.
- `hermes` remains a registered lane name in `VALID_MODELS` for the purposes of this spec; whether
  the backend is still viable is out of scope.

## Solution Approaches

### Approach 1: Config-driven resolution behind one shared resolver (recommended)
**Description**: Extend `CodevConfig` with `consult.models` / `consult.reasoningEffort` and
`porch.consultation.modelsByType` / `.byProtocol`. Consult resolves its lane model id at dispatch
time from the already-loaded config. Porch's lane-composition precedence moves into a single
exported, validated resolver used by both `porch next` and `porch done`.

**Pros**:
- Uses the config stack that already exists, with its global/project/per-engineer layering for free.
- Removes the incentive to shadow-fork `protocol.json` — the stated goal.
- Consolidating the duplicated precedence logic pays down an existing single-source-of-truth debt.
- Absent config, behavior is provably unchanged.

**Cons**:
- Grows the config surface; four-level precedence must be documented precisely or it becomes folklore.
- Validation of `byProtocol` / `modelsByType` keys needs a discovery step to stay fail-fast without
  a hardcoded list.

**Estimated Complexity**: Medium
**Risk Level**: Low

### Approach 2: Environment-variable overrides
**Description**: Read `CODEV_CONSULT_CLAUDE_MODEL`, `CODEV_CONSULT_CODEX_MODEL`, etc.

**Pros**: Trivial to implement; no config schema change.
**Cons**: Not shareable with a team, invisible in review, doesn't address Ask 2 at all, and
multiplies into an unusable matrix for per-type/per-protocol selection. Codev's convention is
config-file-driven.

**Estimated Complexity**: Low
**Risk Level**: Medium (encourages per-machine drift — a different flavor of the reported problem)

### Approach 3: Express everything in `protocol.json` (per-type lanes and model ids in the protocol)
**Description**: Extend the protocol schema so each `verify` block names its lanes and their ids.

**Pros**: Keeps review policy next to the protocol that defines it.
**Cons**: A workspace still cannot customize without shadow-forking the protocol file — which is the
exact rot the issue asks to eliminate. Solves neither ask for the reporting workspace.

**Estimated Complexity**: Medium
**Risk Level**: High (entrenches the problem)

### Approach 4: CLI-flag-only override (`consult --model-id <id>`)
**Description**: Add a per-invocation flag; no config.

**Pros**: Useful for ad-hoc A/B comparison between models.
**Cons**: Porch generates the consult commands for every protocol review, so a flag alone can't set
workspace policy without templating it into protocol files. Complementary, not sufficient.

**Estimated Complexity**: Low
**Risk Level**: Low

**Selected**: Approach 1, with Approach 4 as an optional COULD escape hatch layered on top.

## Open Questions

### Critical (Blocks Progress)
- None. The issue is specific enough to implement; every remaining question below has a stated
  default that can be implemented and revisited at review.

### Important (Affects Design)
- [ ] **How are `byProtocol` and `modelsByType` keys validated without a hardcoded list?**
      A typo'd key (`"spir "`, `"implement"`) that silently no-ops violates fail-fast. Proposed
      default: enumerate protocols resolvable through the four-tier chain and the `verify.type`
      values they declare, and hard-error on a key outside that union. Fallback if enumeration
      proves unreliable: validate values strictly and emit a loud warning for unmatched keys.
- [ ] **Should `consult.reasoningEffort` be a general per-lane map or a codex-only key?** Only the
      codex lane exposes a reasoning-effort knob today. Proposed default: a lane-keyed map with
      only `codex` honored, erroring on any other lane key — extensible without a rename later.
- [ ] **Codex cost when the model is overridden**: null-out (proposed) vs. an optional
      `consult.pricing.codex` rate override vs. keep computing with stale rates (rejected).
      Proposed default: support the optional override, and record `null` when a non-default model
      runs with no override.
- [ ] **Does recording the model id need a metrics schema migration?** `consultation_metrics` is
      created with `CREATE TABLE IF NOT EXISTS` and has no migration mechanism, so adding a column
      needs an idempotent `ALTER TABLE`. Proposed default: add the column with an idempotent
      migration; the existing `model` column keeps its lane-name meaning so `consult stats` is
      unaffected.

### Nice-to-Know (Optimization)
- [ ] Should `codev doctor` report the effective per-lane model ids and lane composition? A
      one-line "here's what will actually run" would make misconfiguration self-diagnosing.
- [ ] Should the review file or its header record which model id produced it, so a stale review from
      a since-changed model is recognizable?
- [ ] Is the reporting workspace's lane-value data (offered in the issue) worth folding into shipped
      defaults? Out of scope here; worth a follow-up issue with the data attached.

## Performance Requirements
- **Response Time**: config resolution adds no measurable latency (`loadConfig` is already called on
  every consult invocation; resolution is in-memory object traversal). Consultation wall-clock is
  dominated by the model, which is the thing being made configurable.
- **Throughput**: N/A — consult is invoked a handful of times per project phase.
- **Resource Usage**: no change.
- **Availability**: N/A — local CLI.

## Security Considerations
- **Argument injection**: the gemini lane's model id becomes a CLI argument to `agy`. It is passed
  via the existing `spawn(bin, args)` array form (no shell), and the id is additionally validated as
  a single whitespace-free token, so it cannot expand into extra flags or shell syntax.
- **Config trust boundary**: config is read from the repo and the user's home directory — already
  trusted inputs that can set `shell.builder` and `worktree.postSpawn`. A model id is strictly less
  powerful than what config already controls. No new trust boundary is crossed.
- **Cost as a safety property**: a config typo that silently widens lane composition costs real
  money. Fail-fast validation and per-protocol scoping are the mitigations; both are MUSTs.
- **No secrets**: model ids are not credentials; nothing new is logged or persisted beyond the id.

## Test Scenarios

### Functional Tests
1. **Happy path, per-lane ids** — config sets `consult.models.claude`; the Agent SDK receives that
   id. Same for codex (`model`) and gemini (`--model` present in the spawned argv).
2. **Default preservation** — with no `consult` block, the three backends receive exactly today's
   arguments: `claude-opus-4-6`; `gpt-5.4` @ `medium`; agy argv containing no `--model`.
3. **Reasoning effort** — `consult.reasoningEffort.codex: "high"` reaches the Codex SDK; unset →
   `medium`.
4. **`modelsByType` selection** — protocol declares three lanes for `impl`; config sets
   `modelsByType.impl: ["codex"]`; `porch next` emits exactly one consult command, and `porch done`
   is satisfied by exactly one review file.
5. **`byProtocol` scoping** — a workspace-wide three-lane `models` plus
   `byProtocol.pir.models: ["gemini","codex"]`; a PIR verify step emits two lanes while a SPIR
   verify step emits three. (Directly guards the CMAP-2 cost invariant.)
6. **Precedence ladder** — all four config levels populated simultaneously; the most specific wins,
   and removing each level in turn falls through in the documented order down to `verify.models`.
7. **`none` / `parent` at every level** — including `byProtocol.pir.models: "none"`.
8. **next/done agreement** — the lane set `porch next` emits is exactly the set `porch done`
   enforces, under every precedence combination above (regression guard for the removed duplicate).
9. **Invalid lane key** — `consult.models.gpt` → hard error naming valid lanes.
10. **Invalid model id shape** — empty string, non-string, embedded whitespace, `; rm -rf /` → hard
    error before any backend is invoked.
11. **Invalid lane name in `modelsByType`** — `["codexx"]` → hard error, from both `porch next` and
    `porch done`.
12. **Provider rejection** — backend rejects the configured id → non-zero exit, provider error text
    surfaced, config key named, **no review file written**, no fallback to the default id.
13. **Metrics** — the resolved model id is recorded; the `model` column still holds the lane name.
14. **Codex cost with an overridden model** — `cost_usd` is `null` absent a rate override, and
    computed from the override when one is present.
15. **Docs parity** — `codev/resources/commands/consult.md` and the skeleton copy stay in sync.

### Non-Functional Tests
1. **Performance**: N/A — no hot path is touched. Config resolution is already on the call path.
2. **Security**: covered by scenario 10 (argv hygiene for the agy lane).
3. **Load**: N/A.

## Dependencies
- **External Services**: Anthropic (Agent SDK), OpenAI (Codex SDK), Google/Antigravity (`agy`) —
  each is the authority on which model ids it accepts.
- **Internal Systems**: `packages/codev/src/lib/config.ts` (loader + `CodevConfig` type),
  `packages/codev/src/commands/consult/index.ts`, `packages/codev/src/commands/porch/next.ts`,
  `packages/codev/src/commands/porch/index.ts`, `packages/codev/src/commands/consult/metrics.ts`.
- **Libraries/Frameworks**: `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `better-sqlite3`,
  `vitest`. No new dependency.

## References
- Issue #1286 — consult: configurable per-lane models and per-review-type lane selection
- PR #1281 — the 17-drifted-shadow-copy cleanup that motivates avoiding protocol forks
- `codev/resources/commands/consult.md` — consult CLI reference (to be updated)
- `codev/resources/protocol-format.md` — protocol definition format, incl. `verify.models`
- Issues #1032 / #1033 — degraded agy/gemini lane (context for why lane composition is contested)
- `codev/resources/arch.md` → Installation Architecture (the four-tier resolver)

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| A static id allowlist creeps into the implementation and re-rots | Medium | High | Hard constraint in this spec; a test asserting an arbitrary unknown-to-Codev id reaches the backend unmodified |
| A backend silently substitutes a model instead of erroring, defeating fail-fast | Low | Medium | Record the resolved id in metrics so substitution is detectable after the fact; document the bound |
| Four-level precedence becomes folklore and is applied inconsistently | Medium | Medium | One shared resolver (no second copy); precedence table in the docs; scenario 6 pins the ladder |
| Config widening silently inflates cost on lighter protocols | Medium | Medium | `byProtocol` scoping (scenario 5) is a MUST, not a follow-up |
| Codex cost figures go stale against the configured model | High | Low | Null-out absent a rate override; record the id for later recomputation |
| `porch next` and `porch done` disagree on lane composition, wedging a project | Low | High | Shared resolver + scenario 8 as an explicit regression guard |
| Config-key validation (protocol/type discovery) proves brittle across the four-tier resolver | Medium | Low | Documented fallback: strict value validation plus a loud warning on unmatched keys |
| Skeleton/`codev/` doc drift | Medium | Low | Docs parity is a success criterion (scenario 15) |

## Expert Consultation
**Date**: pending
**Models Consulted**: pending — porch runs the 3-way consultation (Gemini, Codex, Claude) at the
verify step of this phase.
**Sections Updated**: pending.

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [ ] Expert AI Consultation Complete

## Notes

**Explicitly out of scope** (each is a defensible follow-up, none is required to unblock #1286):

- Changing shipped default lane composition or default model ids, including acting on the
  production lane-value evidence offered in the issue. This spec ships the mechanism; the evidence
  deserves its own issue.
- Retiring or repairing the `gemini`/agy lane (#1032 / #1033).
- Per-lane knobs beyond model id and codex reasoning effort (turn limits, `maxBudgetUsd`, sandbox
  mode). The config shape chosen here extends to them without a rename.
- Any change to how protocols themselves declare `verify.models` — `protocol.json` stays the
  lowest-precedence default and its schema is untouched.

**Why the fail-fast requirement is met without validating ids**: the request says "fail fast on an
unknown/invalid id (no silent fallback to the hardcoded default)". The load-bearing clause is *no
silent fallback*. Codev satisfies it by never substituting a default when a configured id fails —
the run dies loudly. Codev does not, and cannot correctly, decide which ids exist; the provider is
the only authority, and any local list of ids would be exactly the stale artifact this issue was
filed about.
