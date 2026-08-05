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
    },
    "pricing": {
      "codex": {                     // USD per 1M tokens; all three keys required together
        "inputPer1M":       2.00,
        "cachedInputPer1M": 1.00,
        "outputPer1M":      8.00
      }
    }
  }
}
```

Every key is optional. An unset lane keeps today's hardcoded default, so an existing workspace with
no `consult.models` block behaves byte-identically.

**Which lanes accept a model id.** `consult.models` accepts exactly `claude`, `codex`, and `gemini`.
`hermes` is **not** a valid key: the hermes backend is invoked as `hermes chat -q` and exposes no
model selector, so accepting the key would silently do nothing. `consult.models.hermes` is a hard
error naming the three lanes that do accept ids. This is independent of `hermes` remaining a valid
*lane name* in `porch.consultation.*` lists, which it does.

**`consult.reasoningEffort` accepts exactly one key: `codex`.** It is a lane-keyed map purely so
another backend can be added later without a rename — but today the codex lane is the only one with
a reasoning-effort knob (`modelReasoningEffort`), so `claude`, `gemini`, and `hermes` are all hard
errors here. The two blocks therefore have *different* key spaces: `{claude, codex, gemini}` for
`models`, `{codex}` for `reasoningEffort`.

**Its value space is a closed enum, and — unlike model ids — it IS validated locally.** Accepted
values are exactly `minimal`, `low`, `medium`, `high`, `xhigh`; anything else is a hard error at
config-load time, before any consultation runs. Unset means `medium`, today's pinned value.

This is the deliberate opposite of the model-id rule, and the difference is not arbitrary:

| | Model ids | Reasoning effort |
|---|---|---|
| Shape of the value space | Open, provider-owned, changes between releases | Closed union, shipped as a type by the SDK Codev already depends on (`ModelReasoningEffort`, `@openai/codex-sdk`) |
| Can Codev know the valid set? | No — any local list is stale the day a model ships | Yes — it is a compile-time artifact of a pinned dependency |
| Therefore | No local validation; provider is the authority | Local validation, rejected at load time |

Because the enum is a *pinned-dependency* fact rather than a *remote-catalog* fact, validating it
locally does not recreate the staleness problem — but only if the accepted set is **bound to the
SDK's exported type** rather than retyped as a free-standing literal list. The requirement is that a
future SDK upgrade which changes the union produces a **compile error**, not a silently divergent
allowlist. A hand-copied list that drifts from the SDK would be the same class of bug as a model-id
allowlist, just slower-moving.

**`consult.pricing`** exists only because `CODEX_PRICING` is hardcoded to gpt-5.4's rates. It is
codex-only (Claude's cost comes from the SDK, and the agy lane emits no usage data at all). All
three rate keys must be supplied together — a partial object is a hard error, because silently
defaulting one rate to a stale gpt-5.4 number reintroduces the wrong-cost problem this key exists to
solve.

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
- Unknown *lane key* in `consult.models` (valid: `claude`, `codex`, `gemini`) or in
  `consult.reasoningEffort` (valid: `codex` only) → error naming that block's valid lanes.
- Model id that fails the **exact syntactic rule** below → error.

**Model-id syntax rule (exact, deliberately permissive).** A configured model id MUST match
`^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$` — i.e. 1–200 characters drawn from ASCII alphanumerics and
`. _ : / @ + -`, and not starting with `-`.

The rule is written as an explicit permitted set rather than a list of "shell metacharacters"
because a vague blocklist is the wrong shape for two reasons: it is untestable, and — given that
this spec forbids local allowlists and makes the provider the authority on ids — it risks rejecting
an id that a future provider considers valid. The permitted set is chosen to already cover the
naming conventions in use across providers today, including dotted and namespaced forms
(`us.anthropic.claude-opus-5`), vendor-prefixed forms (`openai/gpt-5.6`), and tag suffixes
(`gpt-5.6:latest`). The leading-`-` exclusion is the one hard safety requirement: the gemini lane
passes the id as a CLI argument, and an id beginning with `-` would be parsed by `agy` as a flag.

If a provider ever adopts a character outside this set, the fix is a one-line widening of the
character class — a change to *syntax*, which does go stale slowly and safely, not to a catalog of
*ids*, which goes stale immediately. That distinction is the whole point.
- Unknown *lane name* in any `porch.consultation.*` list → error (today's behavior, extended to the
  new keys **and** to the `porch done` path, which currently skips validation entirely).
- Malformed shape anywhere (e.g. `modelsByType` not an object, a lane list that isn't an array of
  strings) → error.
- A partial `consult.pricing.codex` object (fewer than all three rate keys) → error.
- Unknown key in `byProtocol` or `modelsByType` → **hard error**. Both key spaces are validated by
  discovery, never against a hardcoded list; the discovery rule is defined immediately below. There
  is no warn-and-continue mode for either — a typo that silently no-ops is precisely the
  fail-fast violation this spec is closing.

**Key-space discovery (the single definitive rule).** Both new key spaces are derived from the
protocols on disk, so they cannot go stale the way a hardcoded list would:

- **Valid `byProtocol` keys** = the set of protocol *names* visible at **any** tier of the four-tier
  chain (`.codev/protocols/` ∪ `codev/protocols/` ∪ runtime cache ∪ installed skeleton). Union, not
  precedence: a name present at any tier is a name porch can run, so configuring it is legitimate.
- **Valid `modelsByType` keys** = the union of `verify.type` values declared by the **resolved**
  `protocol.json` for each of those names — "resolved" meaning the single file the four-tier
  resolver would actually load for that name (`.codev/` > `codev/` > cache > skeleton). Precedence,
  not union: only the file that will actually execute defines which review types can occur.

The asymmetry is deliberate and is the answer to "what happens when the local and skeleton protocol
sets differ": a locally-shadowed protocol contributes its *name* to the first set and *only its own*
`verify.type` values to the second — the shadowed skeleton copy's types do not leak in, because that
file will never run. Both sets are computed by the same enumeration used everywhere else in Codev,
and both are reported in the error message so a typo is self-diagnosing.

**Not validated locally — the provider is the authority:**
- The model id itself. Codev never asserts an id does or doesn't exist. If the Agent SDK, the Codex
  SDK, or `agy` rejects the id, the consultation fails loudly: the provider's error text is
  surfaced, the process exits non-zero, no review file is written, and **there is no fallback to
  the hardcoded default**. A silent downgrade is the failure mode this spec exists to prevent.

The error message on provider rejection must name the config key and layer that supplied the id, so
the user can find it (the id may come from any of five config layers).

**Reconciling fail-fast with the agy lane's non-blocking skip.** The gemini lane does not currently
throw on failure: `runAgyConsultation` funnels *every* failure — missing binary, unauthenticated,
timeout, non-zero exit — into `settleSkip()`, which writes a `VERDICT: COMMENT` artifact that porch
treats as non-blocking (`consult/index.ts:938`). Left alone, that would swallow a bad configured
model id into a silent skip and let the phase advance — exactly the silent downgrade this spec
forbids. The two behaviors must be separated by *cause*:

- **Environment failures** (agy absent, unauthenticated, timed out, non-responsive) keep today's
  non-blocking skip. The lane is optional and degraded (#1032 / #1033); nothing about this spec
  changes that.
- **Configuration failures** (a model id the user explicitly set) are hard failures on every lane
  including gemini. The user asked for a specific model; running the phase without it, or with
  a different one, is the failure being designed against.

Two mechanisms deliver this, in order:

1. **Pre-spawn validation** catches malformed ids deterministically, before any process starts. This
   covers the syntax rule above and needs no output inspection.
2. **For a syntactically valid but provider-rejected id**, the lane must not skip. The preferred
   mechanism is marker-based detection of agy's model-rejection output, mirroring the
   `AGY_OAUTH_MARKERS` mechanism the file already uses to discriminate one failure cause from
   another. Because agy's rejection text is not contractual, the **guaranteed floor** is a
   deterministic rule that needs no markers: *when `consult.models.gemini` is explicitly set, a
   non-zero agy exit is a hard failure rather than a skip.* Opting into a specific model is opting
   out of "quietly proceed without this lane." Workspaces that leave the lane unconfigured keep
   today's skip behavior unchanged.

### Cost and observability

- The resolved model id is recorded alongside the lane in consultation metrics. `consultation_metrics`
  has no schema-migration mechanism today, so **evolving it is part of this work, not a follow-up**;
  the migration must be idempotent and safe against an existing populated `~/.codev/metrics.db`
  (mechanism is a plan concern). The existing `model` column keeps its lane-name meaning, so
  `consult stats` — which groups on it — is unaffected.
- Codex cost math uses `consult.pricing.codex` when present. When the codex lane runs a
  **non-default** model with no rate override, the recorded cost is `null` rather than computed from
  gpt-5.4's rates. Reporting a confidently wrong number is worse than reporting none.

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
      offending key and the valid alternatives — including an unknown `byProtocol` or `modelsByType`
      key, which errors rather than warning, against the discovered key spaces defined above.
- [ ] `consult.models.hermes` (or any non-`{claude,codex,gemini}` lane key) is a hard error, while
      `hermes` remains accepted in `porch.consultation.*` lane lists.
- [ ] `consult.reasoningEffort` accepts `codex` and hard-errors on every other lane key, including
      `claude` and `gemini` — a key space deliberately narrower than `consult.models`'.
- [ ] `consult.reasoningEffort.codex` accepts exactly `minimal|low|medium|high|xhigh` and hard-errors
      on any other value at config-load time; unset yields `medium`. The accepted set is bound to
      `@openai/codex-sdk`'s exported `ModelReasoningEffort` type such that an SDK upgrade changing
      the union fails the build rather than silently diverging.
- [ ] Model ids are validated against `^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$` and nothing else: a
      namespaced or tagged id (`us.anthropic.claude-opus-5`, `openai/gpt-5.6`, `gpt-5.6:latest`)
      passes through unmodified, and no id is rejected for being unknown to Codev.
- [ ] A partial `consult.pricing.codex` object is a hard error; a complete one drives codex cost math.
- [ ] A provider-rejected model id fails the consultation loudly and non-zero, writes no review
      file, and never falls back to a hardcoded default.
- [ ] On the gemini lane specifically, a configured-model failure is a **hard failure**, not a
      `VERDICT: COMMENT` skip — while agy being absent, unauthenticated, or timed out still produces
      today's non-blocking skip, unchanged, when no gemini model is configured.
- [ ] Consultation metrics record the resolved model id, not only the lane name, via an idempotent
      migration that is safe to run against an existing `~/.codev/metrics.db` and leaves the `model`
      column's lane-name meaning (and therefore `consult stats`) unchanged.
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

*(All four questions raised in the iteration-1 3-way review are now resolved in Desired State and
Success Criteria. They are recorded here with their resolutions rather than deleted, so the
reasoning survives.)*

- [x] **How are `byProtocol` and `modelsByType` keys validated without a hardcoded list?**
      **Resolved: hard error, keys discovered from disk.** `byProtocol` keys = union of protocol
      names across all four tiers; `modelsByType` keys = union of `verify.type` in each name's
      *resolved* protocol.json. No warn-and-continue mode — the earlier draft offered one as a
      fallback, which contradicted the hard-error requirement stated elsewhere. See "Key-space
      discovery" under Desired State.
- [x] **Should `consult.reasoningEffort` be a general per-lane map or a codex-only key?**
      **Resolved: a lane-keyed map that accepts only `codex`.** Any other lane key — including
      `claude` and `gemini`, which *are* valid in `consult.models` — is a hard error. The iteration-2
      review caught that Desired State had wrongly given the two blocks the same key space; they are
      now stated separately and differ deliberately. Extensible without a rename if another backend
      exposes the knob.
- [x] **What values may `consult.reasoningEffort.codex` take, and who validates them?**
      **Resolved: `minimal|low|medium|high|xhigh`, validated locally at load time**, bound to the
      SDK's exported `ModelReasoningEffort` union so it cannot drift silently. Raised in the
      iteration-3 review, which correctly noted the spec had pinned the key space but left the value
      space to a coin flip between enum-validation, pass-through, and silent acceptance. The reason
      this validates locally while model ids do not is tabulated in Desired State: a closed union
      from a pinned dependency is knowable; an open provider catalog is not.
- [x] **What exactly makes a model id syntactically invalid?** **Resolved:**
      `^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$`. The iteration-2 review correctly flagged that
      "whitespace or shell metacharacters" was both untestable and at risk of rejecting
      provider-valid ids — the opposite of this spec's intent. Replaced with an explicit permitted
      character set covering namespaced, vendor-prefixed, and tagged id conventions.
- [x] **Codex cost when the model is overridden.** **Resolved:** optional `consult.pricing.codex`
      with all three per-1M rates required together; `cost_usd` is `null` when a non-default model
      runs without it. Computing from stale rates is rejected.
- [x] **Does recording the model id need a metrics schema migration?** **Resolved: yes, and it is
      in scope** — it must be idempotent and non-destructive against an existing populated DB; the
      mechanism is left to the plan. The `model` column keeps its lane-name meaning.
- [x] **Does the `hermes` lane accept a configured model id?** **Resolved: no.** `hermes chat -q`
      exposes no model selector, so `consult.models.hermes` is a hard error; `hermes` stays valid as
      a lane name in `porch.consultation.*`.

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
  via the existing `spawn(bin, args)` array form (no shell), so shell metacharacters are inert by
  construction. The syntax rule adds defence in depth and closes the one attack the array form does
  *not* cover: an id starting with `-`, which `agy` would parse as a flag rather than a value.
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
   `medium`. All five enum values are accepted; `"highest"`, `""`, and a non-string each hard-error
   at load time, before any consultation runs.
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
10. **Model id syntax** — rejected before any backend is invoked: empty string, non-string, embedded
    whitespace, `; rm -rf /`, a leading `-` (`--print`), and a >200-character id. Accepted and passed
    through byte-for-byte: `claude-opus-5`, `us.anthropic.claude-opus-5`, `openai/gpt-5.6`,
    `gpt-5.6:latest`, and an id Codev has never heard of (the no-allowlist guarantee).
11. **Invalid lane name in `modelsByType`** — `["codexx"]` → hard error, from both `porch next` and
    `porch done`.
12. **Provider rejection** — backend rejects the configured id → non-zero exit, provider error text
    surfaced, config key named, **no review file written**, no fallback to the default id.
13. **Metrics** — the resolved model id is recorded; the `model` column still holds the lane name.
    The migration runs twice against the same DB without error and preserves existing rows.
14. **Codex cost with an overridden model** — `cost_usd` is `null` absent a rate override, and
    computed from the override when one is present. A partial `pricing.codex` object errors.
15. **Docs parity** — `codev/resources/commands/consult.md` and the skeleton copy stay in sync.
16. **Key-space discovery** — an unknown `byProtocol` key and an unknown `modelsByType` key each
    hard-error (never warn). A protocol name present *only* in the skeleton is accepted as a
    `byProtocol` key; a `verify.type` that appears only in a skeleton copy **shadowed** by a local
    protocol of the same name is *rejected*, since the shadowed file will never run.
17. **Hermes lane keys** — `consult.models.hermes` errors; `porch.consultation.models: ["hermes"]`
    still resolves.
18. **Divergent key spaces** — `consult.reasoningEffort.claude` errors even though
    `consult.models.claude` is valid.
19. **agy skip vs. hard failure** — with no `consult.models.gemini` set, an unauthenticated or
    timed-out agy still produces a non-blocking `VERDICT: COMMENT` skip (regression guard for
    existing behavior). With a gemini model configured, a non-zero agy exit produces a hard failure
    and **no** review file, so porch does not advance the phase.

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
| agy's blanket non-blocking skip swallows a configured-model failure, advancing the phase without the requested lane | High if unaddressed | High | Cause-based separation: configured-model failure = hard failure, environment failure = skip; guaranteed floor needs no output parsing; scenario 19 guards both directions |
| Four-level precedence becomes folklore and is applied inconsistently | Medium | Medium | One shared resolver (no second copy); precedence table in the docs; scenario 6 pins the ladder |
| Config widening silently inflates cost on lighter protocols | Medium | Medium | `byProtocol` scoping (scenario 5) is a MUST, not a follow-up |
| Codex cost figures go stale against the configured model | High | Low | Null-out absent a rate override; record the id for later recomputation |
| `porch next` and `porch done` disagree on lane composition, wedging a project | Low | High | Shared resolver + scenario 8 as an explicit regression guard |
| Config-key validation (protocol/type discovery) proves brittle across the four-tier resolver | Medium | Low | Discovery rule is pinned exactly (union of names across tiers; `verify.type` from the *resolved* file only) and covered by scenario 16; no warn-and-continue escape hatch that would mask a typo |
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

**Architect note (2026-07-29, recorded — no spec change required)**: keeping shipped defaults
unchanged is the correct reading of the issue. This repo will opt into `claude-opus-5` /
`gpt-5.6` through its own `.codev/config.json` **after merge**; that opt-in is a post-merge step
owned by the architect and is explicitly **not** part of this project's PR. This is the practical
demonstration that the mechanism works, and it is deliberately kept out of the diff so the PR
changes no lane's behavior for anyone by default.

**In-scope drive-by fix**: `packages/codev/src/lib/config.ts`'s file-level doc comment still says the
loader merges "three layers" and lists only defaults / global / project. The loader has had five
since the cache and `config.local.json` layers landed (the function-level docstring at `:224` is
correct; the file header is not). This spec's config surface is layered on that stack and its
documentation refers to five layers, so the stale header is corrected as part of this work rather
than left to contradict the new docs.

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
