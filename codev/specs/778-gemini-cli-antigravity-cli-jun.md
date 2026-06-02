# Specification: Survive the Gemini CLI Retirement (June 18, 2026)

## Metadata
- **ID**: spec-2026-06-01-778-gemini-cli-retirement
- **Status**: draft (revised after 3-way consultation, iteration 1)
- **Created**: 2026-06-01
- **Issue**: #778
- **Deadline**: 2026-06-18 (17 days from spec authoring)

## Clarifying Questions Asked

No spec pre-existed and the issue contains no "Baked Decisions" section, so the builder did not
block on clarifying questions (per SPIR strict-mode flow, the architect decides at the
spec-approval gate). The builder resolved the open questions through research and a codebase audit,
and surfaces the one genuinely architectural fork (Open Questions → Critical) for the architect to
settle at the gate.

Questions the builder answered through research (sources in **References**):

1. **What precisely is retired on June 18, 2026, and for whom?**
   The *subscription / OAuth serving path* through the **Gemini CLI** and **Gemini Code Assist
   IDE extensions** stops serving requests for **Google AI Pro**, **Google AI Ultra**, and **free
   "Gemini Code Assist for individuals"** users. Gemini Code Assist for GitHub is also affected
   (no new org installs on June 18; existing requests stop in the following weeks). **Enterprise**
   customers (Standard / Enterprise licenses, Google Cloud access) are *unaffected* and may keep
   using the Gemini CLI.

2. **Is the Gemini API itself retired?**
   **No.** The Gemini **Developer API** (via `GEMINI_API_KEY`, Google AI Studio) and **Vertex AI**
   remain fully operational; the API is explicitly *not* deprecated. Separately, from **June 19,
   2026** Google blocks *unrestricted* API keys — keys must be scoped to the **Generative Language
   API** in Cloud Console or they stop working with Gemini. This is a configuration note for
   API-key users, not a deprecation.

3. **Is "Antigravity CLI" a drop-in replacement for our usage?**
   **Not currently.** Antigravity CLI (binary reportedly `agy`, written in Go) is an *agent-first,
   asynchronous, multi-agent* terminal product. Its non-interactive / JSON / model-flag contract is
   **unconfirmed**, and as of late May 2026 `agy` was **not published to any public package
   manager**. The official migration guide page carried no extractable technical detail at spec
   time.

## Problem Statement

Codev's multi-agent consultation system (`consult`) treats **Gemini** as one of three default
reviewer "lanes" (alongside Codex and Claude). The Gemini lane works by shelling out to the
Google **Gemini CLI** binary (`gemini`). For the large class of Codev users authenticated through
the free / Pro / Ultra **subscription path**, that binary stops serving requests on **June 18,
2026**.

When that happens, every Codev workflow that runs a 3-way review — SPIR/ASPIR/MAINTAIN spec, plan,
and PR consultations; BUGFIX/AIR/PIR PR consultations; ad-hoc `consult -m gemini` — will have its
Gemini lane **fail at runtime** for affected users. Because `gemini` is in the *default* model list
for these protocols, this is not an opt-in feature that quietly no-ops; it is a default code path
that breaks. Worse, in porch-orchestrated protocols a failing lane does not merely drop out: porch's
verdict parser **defaults missing/short/error output to `REQUEST_CHANGES`** (`verdict.ts:27,46-47`)
and treats `CONSULT_ERROR`/`REQUEST_CHANGES` as approval-blocking — so a dead Gemini lane will
**block phase progression**, not just reduce review coverage. The failure is *silent-until-invoked*:
nothing surfaces today, then on June 18 a core review path starts erroring (and blocking) for a major
user segment, on a hard calendar deadline.

This spec defines WHAT Codev must do to keep its "Gemini perspective" working past June 18, 2026,
and to stop steering users toward a serving path that is going away — WITHOUT depending on a
product (Antigravity CLI) that does not yet expose the contract Codev requires.

## Current State

Codev depends on the `gemini` CLI binary at these surfaces (audited 2026-06-01, line numbers
verified):

**Consultation dispatch (the load-bearing dependency)**
- `packages/codev/src/commands/consult/index.ts:37-40` — `MODEL_CONFIGS.gemini = { cli: 'gemini',
  args: ['--model', 'gemini-3.1-pro-preview'], envVar: 'GEMINI_SYSTEM_MD' }`.
- `index.ts:43` — `SDK_MODELS = ['claude', 'codex']` (these lanes already use SDKs, not CLIs).
- The Gemini lane spawns the `gemini` subprocess with `--output-format json`, passes the reviewer
  **role** via `GEMINI_SYSTEM_MD` (a temp file path), delivers the **prompt over stdin** (avoiding
  `E2BIG` / V8 heap exhaustion on large PR diffs — bugfix #680), bumps `NODE_OPTIONS` heap, and
  parses a JSON result with token/usage stats.
- `index.ts:54-58` — alias `pro → gemini`.

**The Gemini lane relies on the reviewer being a filesystem-capable AGENT (critical — see Approach A)**
- The PR/impl review prompts assume the reviewer can read files from disk:
  - `index.ts:884` — "**Read the diff file** from `${diffPath}` ..." (`buildPRQuery` writes the full
    diff to a temp file and points the model at the path).
  - `index.ts:885,1042,1154` — "**full filesystem access** — read project files from disk ...".
  - `index.ts:1051` — "**Explore the filesystem** to find and review the implementation changes."
  - `index.ts:664,1588` — "You have file access. Read files directly from disk to review code."
- The retiring `gemini` CLI is an **agent** (it reads files itself; doctor even uses `--yolo`). A
  plain single-shot Gemini Developer API `generateContent` call **cannot read files from disk**.
  This is the single most important constraint on the migration and is addressed head-on in
  Approach A below.

**Defaults & schema (why the breakage is a default, not opt-in)**
- `packages/codev/src/lib/config.ts:88` — default consult models = `['gemini', 'codex', 'claude']`.
- `codev-skeleton/protocols/{spir,aspir,maintain}/protocol.json` — phases default to
  `["gemini", "codex", "claude"]`; `{air,pir,bugfix}/protocol.json` default to `["gemini", "codex"]`.
- `codev-skeleton/protocol-schema.json:155` — consultation model enum = `["gemini","codex","claude"]`.
- `packages/codev/src/commands/porch/next.ts:51` — `VALID_MODELS = ['gemini','codex','claude','hermes']`
  (note: `hermes` is valid in porch but **absent** from the schema enum — a pre-existing precedent
  that the two lists can diverge).

**Porch gate semantics (why a skipped lane is not free)**
- `packages/codev/src/commands/porch/verdict.ts:27,46-47` — missing / unparseable / short consult
  output defaults to `REQUEST_CHANGES`; `CONSULT_ERROR` and `REQUEST_CHANGES` block approval (`:55`).
  Therefore "skip Gemini" must be given **explicit non-blocking semantics**, not left implicit.

**Health checks & cost**
- `packages/codev/src/commands/doctor.ts:153-163` — `gemini` presence check (`required: false`),
  install hint → `github.com/google-gemini/gemini-cli`.
- `doctor.ts:266-274` — auth verification runs `gemini --yolo 'Reply with just OK'`; hint: "Run:
  gemini (interactive) then /auth, or set GOOGLE_API_KEY".
- `packages/codev/src/commands/consult/usage-extractor.ts` — pricing entry keyed `gemini-3.1-pro`.

**Other Gemini-touching surfaces (scoped explicitly under "Scope" below)**
- `packages/codev/src/agent-farm/utils/harness.ts:114,240` — a **Gemini-CLI builder harness**
  (`GEMINI_HARNESS`): Codev can spawn a *builder agent* that uses the `gemini` CLI as its coding
  agent. This path also breaks for affected tiers.
- `packages/codev/src/commands/generate-image.ts` — uses the Gemini **API** (`GEMINI_API_KEY`)
  already; **unaffected** by the CLI retirement.
- `packages/codev/src/agent-farm/commands/bench.ts` — benchmarking defaults reference `gemini`.
- `cli.ts` references (flag wiring); docs in `CLAUDE.md`, `AGENTS.md`, `README.md`,
  `codev-skeleton/resources/commands/consult.md`, the consult skill, `DEPENDENCIES.md`.

**Tests**: ~60 cases across `consult.test.ts`, `consult.e2e.test.ts`, `metrics.test.ts`,
`consultation-models.test.ts`, `doctor.test.ts`, `config.test.ts`.

**Net assessment**: the *behavioral* dependency is concentrated in the consult Gemini dispatch and
its prompt builders; everything else is configuration, gate semantics, health-checks, naming, docs,
and tests that orbit it. The migration is **narrow in behavior, wide in surface** — with one sharp
correctness constraint (filesystem access) that shapes the whole design.

## Desired State

After June 18, 2026:
- A Codev user running any 3-way consultation still gets a **working Gemini perspective**, OR a
  **clear, graceful, non-blocking degradation** if they have not configured a working Gemini
  credential — never a silent failure and never a porch-blocking `REQUEST_CHANGES`/`CONSULT_ERROR`
  caused merely by the lane being unavailable.
- The default Gemini lane reaches Gemini through a surface Google has stated will keep working (the
  Gemini Developer API), and the reviewer receives **enough review content to do its job without
  relying on filesystem access** (see Approach A).
- **Enterprise / CLI users are not regressed by Codev**: the legacy `gemini` CLI remains available
  as an **explicitly-selectable optional backend** for those whose CLI still works; the **API path
  is the new default** for the `gemini` lane.
- `codev doctor` reflects how the default Gemini lane now authenticates (API credential), stops
  pointing users solely at the soon-dead OAuth setup, and surfaces the June 19 key-restriction
  caveat as guidance.
- Docs (`CLAUDE.md`, `AGENTS.md`, `README.md`, skeleton consult docs, consult skill) describe the
  current, supported Gemini setup.
- No regression to the **Codex** and **Claude** lanes.

## Stakeholders
- **Primary Users**: Codev users on Google AI Pro / Ultra / free Gemini Code Assist who currently
  use `consult`'s Gemini lane via the subscription-authenticated `gemini` CLI.
- **Secondary Users**: All Codev users running SPIR/ASPIR/BUGFIX/AIR/PIR/MAINTAIN consultations
  (Gemini is a default reviewer); enterprise Gemini-CLI users.
- **Technical Team**: Codev maintainers (consult, doctor, porch, skeleton, docs).
- **Business Owners**: @waleedkadous, @amrmelsayed (issue stakeholders).

## Success Criteria
- [ ] Running a 3-way consultation (e.g. SPIR PR review) after June 18 either returns a real Gemini
      review **with adequate context** (diff + relevant files) or degrades gracefully — verified
      **end-to-end** by actually running `consult -m gemini` on a spec, a plan, and a PR (per the
      "headline path" lesson), not solely by mocked unit tests.
- [ ] The **default** Gemini lane works for a user who has only a Gemini **API key** configured
      (no Gemini CLI installed, no OAuth login).
- [ ] The Gemini-API reviewer produces a usable review **without** depending on filesystem access:
      review content (PR diff, impl diffs, spec/plan, changed-file context) is delivered to the model
      by Codev, and the prompt no longer instructs the API reviewer to "read files from disk".
- [ ] When no working Gemini credential is present, **porch-orchestrated** consultations still
      advance: the skipped lane does **not** produce a blocking `REQUEST_CHANGES`/`CONSULT_ERROR`,
      and the remaining lanes (Codex, Claude) complete. The user is told why Gemini was skipped.
- [ ] Enterprise/CLI users retain a functional path: the legacy `gemini` CLI is still selectable as
      an optional backend; nothing forces them off it.
- [ ] `codev doctor` reports the default Gemini lane's real status (credential present / reachable /
      absent) and gives correct, current setup guidance, including the June 19 key-restriction note.
- [ ] Token/usage accounting and cost reporting still work for the Gemini-API lane (no `NaN`/missing
      cost rows; pricing key resolves).
- [ ] Docs and the consult skill reference only supported setup; no dangling instructions to a dead
      path.
- [ ] All existing consult/doctor/config/porch tests pass; new tests cover the API path, the
      no-credential non-blocking degradation, the `pro` alias, and (if retained) optional CLI backend
      selection. Coverage does not regress.
- [ ] No behavioral regression for the Codex and Claude lanes.

## Constraints

### Technical Constraints
- **Hard deadline**: behavior must be correct by **2026-06-18**. Solutions depending on an external
  artifact that does not yet exist publicly (e.g. an `agy` package with a documented headless
  contract) carry unacceptable schedule risk.
- **Filesystem-access reality**: the PR/impl review prompts currently assume an agentic, file-reading
  reviewer. Any non-agentic backend must be *fed* the content it needs (the design must change the
  prompt construction for that backend), or implement a tool-use loop. This is a first-class design
  requirement, not an afterthought.
- **Porch gate semantics**: a skipped/unavailable lane must be made explicitly non-blocking (verdict
  parser defaults to `REQUEST_CHANGES`).
- Must preserve token/usage extraction so cost reporting keeps working (`usage-extractor.ts`).
- The four-tier resolver means skeleton protocol JSONs and any `codev/` copies must stay consistent;
  any model-name/default change touches both trees.
- `@google/genai` (`^1.0.0`) is **already a dependency** in `packages/codev/package.json` (it backs
  `generate-image`), so the API client is available without adding a new package.

### Business Constraints
- The free subscription quota that made the Gemini CLI attractive goes away for affected tiers; an
  API-key requirement is acceptable but must **degrade gracefully** when no key is set.
- Keep the 3-way review's *diversity value* (a genuinely independent Gemini perspective) wherever
  feasible — silently dropping Gemini permanently is a last resort, not the goal.

## Assumptions
- The Gemini **Developer API** (`GEMINI_API_KEY` / Google AI Studio) remains available past
  June 18, 2026 (Google's stated position as of spec time).
- An official, headless-capable, package-managed Antigravity CLI is **not** reliably available
  before the deadline. (If false before implementation, Approach B re-enters consideration.)
- Codev maintainers and most affected users can obtain a Gemini API key (free-tier keys exist via
  AI Studio).
- `gemini-3.1-pro-preview` maps to an available API model id; the exact id + matching pricing key is
  a Plan-phase verification (flagged in Open Questions).
- For the deadline fix, **inlining review content** into the Gemini-API prompt gives sufficient
  review quality for spec/plan/PR review; a tool-use loop is a later fidelity upgrade if needed.

## Solution Approaches

### Approach A: Default the Gemini lane to the Gemini Developer API; keep the CLI as an optional backend (RECOMMENDED)
**Description**: Make the `gemini` consult lane reach Gemini through the **Developer API** (via the
already-present `@google/genai` SDK) using `GEMINI_API_KEY` (fallback `GOOGLE_API_KEY`), joining the
existing SDK-based Claude/Codex lanes. **Crucially**, because a single API call cannot read files,
the lane must *deliver the review content to the model*:

- **A1 (recommended for the deadline) — Inline content**: for the API backend, change prompt
  construction so the PR diff, per-phase impl diffs, and relevant spec/plan/changed-file text are
  **embedded directly in the request** instead of being written to a temp file with a "read this
  path" instruction; drop the "you have filesystem access / explore the filesystem" instructions for
  this backend. Large inputs are sent in the request body (verify against the Gemini API input-size
  limit in the Plan; the #680 stdin work already assembles large inline prompts).
- **A2 (optional fidelity upgrade / future) — Tool-use loop**: implement a Gemini function-calling
  loop exposing read-only file tools (read/glob/grep), mirroring the Claude SDK lane
  (`CLAUDE_MAX_TURNS`), so the reviewer can explore surrounding context. Higher complexity; explicit
  future enhancement unless the architect wants it now.

Map `GEMINI_SYSTEM_MD` (role file) → API `systemInstruction`; parse token usage from the API
response into the existing usage/cost pipeline (pricing key `gemini-3.1-pro`).

**Enterprise/CLI retention**: keep the existing CLI dispatch code as an **optional backend** that
users can explicitly select (mechanism is a Plan detail — e.g. a `consult.gemini.backend: api|cli`
config knob, or a distinct selectable model id). The lane **defaults to API**. This honors the
"don't regress unaffected enterprise users" goal without steering anyone toward a dying default. It
is a single conditional, not a generic multi-provider gateway (which stays out of scope).

**Pros**:
- Targets a surface Google says is **not** retiring — robust past June 18.
- Architecturally consistent with the existing SDK-based Claude/Codex lanes.
- No new dependency (`@google/genai` already present).
- Buildable today against a stable API; no reliance on an unreleased CLI.
- Enterprise users keep a working path (optional CLI backend).

**Cons**:
- Requires a Gemini **API key**; the free OAuth subscription quota is no longer the default path.
- Re-implements role-injection + usage parsing for the API shape, and **requires reworking prompt
  construction** so the reviewer gets content without filesystem access (A1) — non-trivial because
  the PR/impl reviews are diff-and-context heavy.
- A1 means the Gemini reviewer sees only what Codev inlines (no free-form repo exploration) unless A2
  is later added.
- Must surface the June 19 unrestricted-key caveat in docs/doctor.

**Estimated Complexity**: Medium (A1) / High (A2)
**Risk Level**: Low (A1) / Medium (A2)

### Approach B: Adopt Antigravity CLI (`agy`) as the Gemini lane backend
**Description**: Swap the lane's CLI from `gemini` to `agy` and translate Codev's contract onto
whatever non-interactive mode `agy` exposes. Matches the issue's literal framing.

**Pros**: follows the vendor's recommended migration and the issue title; could reuse subscription
auth if `agy` supports it.

**Cons**: `agy` is agent-first/async/multi-agent (poor fit for one-shot review); **no confirmed**
headless/`--prompt`/stdin/`--output-format json`/`--model` contract; **not on any public package
manager** (late May 2026) → not a reliable `doctor`/CI dependency; "no 1:1 parity at launch."
Schedule + correctness risk against a hard date.

**Estimated Complexity**: High (partly **blocked** on external availability)
**Risk Level**: High

### Approach C: Graceful degradation as the universal safety net (adopted as part of A)
**Description**: Treat a missing/non-working Gemini credential as a defined **skip** with explicit
porch-safe semantics, rather than a failure. Two acceptable mechanisms (Plan selects):
- **C1**: exclude the uncredentialed lane from the **effective model set** for that run, so porch
  never expects a Gemini review file for it; or
- **C2**: emit a defined non-blocking "skipped" artifact that `verdict.ts`/gate logic treat as
  neutral (neither APPROVE nor blocking).
This is **not** a standalone strategy — it is the required fallback behavior layered onto Approach A.

**Pros**: guarantees nothing hard-breaks or blocks on June 18; sensible regardless of primary path.
**Cons**: when triggered, reduces the 3-way to 2-way for that run (acceptable for no-key users).
**Estimated Complexity**: Low–Medium (porch semantics need care)
**Risk Level**: Low

### Recommendation
**Adopt Approach A1 (API default + inlined review content) with Approach C (porch-safe graceful
skip) as its built-in fallback, and retain the legacy CLI as an optional backend.** Treat A2
(tool-use loop) as a future fidelity upgrade. Keep Approach B (Antigravity CLI) explicitly out of
scope for this deadline, revisitable once `agy` is packaged with a documented headless contract.

This diverges from the issue's literal title ("Gemini CLI > Antigravity CLI"): research shows the
Antigravity path is the *higher-risk* one for our use case right now, and the robust way to honor the
issue's intent ("keep working past the retirement") is the API pivot. **This divergence is flagged to
the architect for the spec-approval gate.**

## Open Questions

### Critical (Blocks Progress — architect decides at the gate)
- [ ] **Strategy choice**: Approve Approach A1 + C (+ optional CLI backend), or does the architect
      want Antigravity-CLI adoption (B) despite the schedule/contract risk, or A2 (tool-use loop) now
      instead of later?

### Important (Affects Design)
- [ ] Exact API model id replacing `gemini-3.1-pro-preview`, and confirmation the pricing key
      `gemini-3.1-pro` still matches its billing. *(Plan verifies.)*
- [ ] Default-list policy is **decided** (keep `gemini` in defaults; see Decisions) — but confirm
      whether the optional CLI backend is exposed via a config knob vs a distinct model id.
- [ ] Depth of Vertex AI support this round (ADC/project auth) — recommended: document as optional,
      do not build enterprise Vertex auth flows now.

### Nice-to-Know (Optimization)
- [ ] A config knob to pick the Gemini model id (future-proofing against renames).
- [ ] Whether to later add A2 (tool-use loop) for repo-exploration parity.

## Decisions (resolved from iteration-1 consultation; previously open)
- **Filesystem access**: the API lane will be **fed inlined review content** (A1); the "read from
  disk / explore filesystem" instructions are removed for the API backend. (Resolves Gemini's fatal
  finding.)
- **Enterprise contradiction**: the contradictory "no behavioral change for enterprise" goal is
  **dropped**. Replaced with: API is the default; the legacy CLI is **retained as an optional
  backend** so enterprise/CLI users are not regressed. (Resolves Gemini + Codex finding.)
- **Default model lists**: **keep `gemini` in the defaults**, paired with porch-safe graceful skip
  (C) when uncredentialed — so key-holders keep the 3-way and no-key users get a clean, non-blocking
  2-way with a one-line notice (rather than silently dropping Gemini for everyone). (Resolves the
  default-list question both reviewers raised.)
- **Porch degradation semantics**: a skipped lane MUST be non-blocking via C1 or C2 (Plan selects);
  it must not surface as `REQUEST_CHANGES`/`CONSULT_ERROR`. (Resolves Codex's fatal finding.)
- **Doctor**: do **not** attempt to proactively detect unrestricted-key status (not reliably
  detectable locally). Doctor reports credential presence + reachability and surfaces the June 19
  restriction as guidance / on auth-failure hint. (Resolves Codex's over-specification finding.)

## Scope

**In scope (must fix for the deadline)**
- The consult **Gemini lane**: API-default dispatch (A1), porch-safe graceful skip (C), optional CLI
  backend retention, usage/cost parity.
- Orbiting surfaces required for correctness: default model lists + schema/`VALID_MODELS`
  consistency, `doctor` Gemini check + auth guidance, `consult` docs + skill, `DEPENDENCIES.md`,
  `CLAUDE.md`/`AGENTS.md`/`README.md` Gemini setup text.
- Tests for all of the above.

**Separate surfaces — explicitly addressed**
- `harness.ts` **Gemini-CLI builder harness** (`GEMINI_HARNESS`): **out of scope** for the deadline
  fix, but **acknowledged** — spawning a *builder* that uses the `gemini` CLI as its coding agent
  will stop working for affected tiers. Recommend a docs note (use Claude/Codex builders, or the
  enterprise CLI) and a follow-up issue rather than rebuilding the builder harness on the API now.
- `generate-image.ts`: **intentionally unchanged** — already uses the Gemini **API**; unaffected.
- `bench.ts`: benchmarking defaults — update naming only if a model id changes; **not** behavior
  critical.

**Out of scope**
- Building/shipping an Antigravity CLI (`agy`) backend (future).
- A generic multi-provider gateway / model-router abstraction.
- Changes to Codex/Claude lanes beyond keeping the 3-way run coherent.
- Enterprise Vertex AI auth flows beyond optional documentation.

## Performance Requirements
- Gemini-lane latency comparable to today's CLI path (single API call; no perceptible regression).
- Must handle large review payloads (PR diffs > 500 KB) — verify against the Gemini API request-size
  limit; if the limit is exceeded, define deterministic behavior (e.g. truncate-with-notice or fall
  back to diffstat + changed-file inlining), never a silent partial review.

## Security Considerations
- API key handling: read from environment (`GEMINI_API_KEY` / `GOOGLE_API_KEY`); never log/echo the
  key; never write it into committed files or status artifacts.
- Document the **June 19, 2026** unrestricted-key block: guide users to scope keys to the Generative
  Language API in Cloud Console.
- Transport changes from local CLI to a direct HTTPS API call; ensure parity in *what* is
  transmitted (prompt + role + inlined review content) and that nothing extra leaks.

## Test Scenarios
### Functional Tests
1. **Happy path (API)**: Gemini-API lane with a valid key returns a real review with parsed token
   usage and a correct cost row.
2. **No credential (non-blocking skip)**: with no `GEMINI_API_KEY`/`GOOGLE_API_KEY`, a
   porch-orchestrated 3-way consult **advances** (Codex + Claude complete; Gemini reported skipped;
   no blocking `REQUEST_CHANGES`/`CONSULT_ERROR`).
3. **Inlined content / no-filesystem reviewer**: a PR review via the API backend produces a usable
   verdict from inlined diff + context, with the "read from disk" instruction absent for that
   backend.
4. **Large payload**: a >500 KB PR diff is handled per the defined behavior (success or
   deterministic truncate/fallback with notice) — no crash, no silent empty review.
5. **Role injection**: the reviewer role/system instruction is honored (verdict format parses, e.g.
   APPROVE/REQUEST_CHANGES).
6. **`pro` alias**: `consult -m pro` resolves to the Gemini-API lane (Claude's note).
7. **Optional CLI backend** (if retained): explicitly selecting the CLI backend still spawns the
   `gemini` subprocess as before.
8. **End-to-end headline path**: actually run `consult -m gemini` on a spec, a plan, and a PR.

### Non-Functional Tests
1. Cost/usage extraction parity (no `NaN`; pricing key resolves).
2. `codev doctor` reports correct Gemini status under: key present, key absent; surfaces June 19
   guidance.
3. No regression in Codex/Claude lanes (existing consult e2e green).
4. Schema/`VALID_MODELS`/protocol-JSON consistency across skeleton and `codev/` trees.

## Dependencies
- **External Services**: Gemini Developer API (Google AI Studio).
- **Internal Systems**: `consult` dispatch + prompt builders, `usage-extractor` pricing/parsing,
  `porch` verdict/gate + consultation config, `doctor`, skeleton protocol JSONs, four-tier resolver.
- **Libraries/Frameworks**: `@google/genai` (already a dependency).

## References
- Issue #778.
- Google Developers Blog — *Transitioning Gemini CLI to Antigravity CLI*:
  https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/
- Antigravity migration guide (no extractable technical detail at spec time):
  https://antigravity.google/docs/gcli-migration
- The Register coverage (`agy`, Go, agentic/async, availability):
  https://www.theregister.com/ai-ml/2026/05/20/bye-bye-gemini-cli-google-nudges-devs-toward-antigravity/
- Gemini Developer API vs. Enterprise / API not deprecated:
  https://ai.google.dev/gemini-api/docs/migrate-to-cloud
- Prior related work: bugfix #680 (large-prompt heap handling), bugfix #878 (gemini lane model id).

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|---------------------|
| Antigravity-only path can't be built in time | High | High | Choose Approach A (API), buildable today against a stable surface. |
| API reviewer lacks context without filesystem access | High | High | A1: inline diff + spec/plan + changed-file content; drop "read from disk" for API backend; A2 tool-loop as future upgrade. |
| Skipped lane blocks porch via default REQUEST_CHANGES | Med | High | Define non-blocking skip semantics (C1/C2); add porch test scenario #2. |
| Enterprise/CLI users regressed by removing CLI | Med | Med | Retain CLI as optional backend; API is default only. |
| Users lack an API key on June 18 | Med | High | Graceful non-blocking skip + clear doctor/docs guidance. |
| June 19 unrestricted-key block breaks new keys | Med | Med | Document Generative Language API restriction; surface in doctor guidance. |
| Gemini API request-size limit < large PR diffs | Med | Med | Verify limit in Plan; define deterministic truncate/fallback behavior. |
| Model id / pricing key mismatch | Med | Med | Pin model id + verify pricing key in Plan; usage-parity test. |
| Skeleton vs `codev/` config drift | Low | Med | Update both trees; schema/config consistency test. |
| Scope creep into a generic gateway | Med | Med | Keep to the Gemini lane; optional CLI backend is one conditional, not a gateway. |

## Expert Consultation
**Date**: 2026-06-01 (iteration 1, via porch 3-way)
**Models Consulted**: Gemini, Codex, Claude
**Verdicts**: Gemini REQUEST_CHANGES · Codex REQUEST_CHANGES · Claude APPROVE

**Sections Updated in response**:
- **Current State / Approach A / Risks** — added the **filesystem-access** constraint (Gemini, fatal):
  the API lane must inline review content (A1) or run a tool-use loop (A2); removed the incorrect
  "single-shot, no agentic behavior needed" framing.
- **Decisions / Desired State / Success Criteria** — resolved the **enterprise contradiction**
  (Gemini + Codex): dropped "no behavioral change for enterprise"; API is default, CLI retained as
  optional backend.
- **Problem Statement / Approach C / Decisions / Test #2** — specified **porch-safe non-blocking
  skip** semantics (Codex, fatal), citing `verdict.ts` default-to-REQUEST_CHANGES behavior.
- **Decisions / Success Criteria / Non-Functional Test #2** — **relaxed doctor** unrestricted-key
  detection to guidance (Codex).
- **Scope** — added explicit in-scope vs separate-surface vs out-of-scope, covering `harness.ts`,
  `generate-image.ts`, `bench.ts`, and the `hermes` schema/`VALID_MODELS` precedent (Codex + Claude).
- **Constraints / Approach A** — noted `@google/genai` is **already a dependency** (Claude),
  lowering A1 cost; added **`pro` alias** test (Claude) and **API request-size** risk/behavior
  (Claude).

## Approval
- [ ] Architect review (spec-approval gate)
- [x] Expert AI Consultation Complete — iteration 1 (Gemini/Codex/Claude); revised herein

## Notes
**Narrow in behavior, wide in surface**, with one sharp correctness constraint (filesystem access).
Plan sequencing: (1) Gemini-API dispatch + inlined-content prompt construction + porch-safe skip
(the behavioral core); (2) optional CLI backend retention; (3) defaults/schema/doctor/docs/tests,
keeping skeleton and `codev/` copies in lockstep.

---

## Amendments

<!-- TICK amendments, if any, recorded here. -->
