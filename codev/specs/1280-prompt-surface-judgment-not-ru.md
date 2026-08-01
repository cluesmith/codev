# Specification: Prompt surface — judgment-not-rules rewrite (>50% always-on reduction)

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
Per-surface WORD CEILINGS are stated here because they are the measurable
acceptance criteria. WHICH sentences get cut, in what order, over how many
phases, belongs in codev/plans/1280-prompt-surface-judgment-not-ru.md.
-->

## Metadata
- **ID**: spec-2026-07-31-prompt-surface-judgment-not-rules
- **Status**: draft (iteration 2 — CMAP round 1 incorporated)
- **Created**: 2026-07-31
- **Issue**: #1280
- **Protocol**: SPIR

## Clarifying Questions Asked

Issue #1280 carries a complete charter (goal, attack order, four Baked Decisions,
required prior art), so no clarifying questions were put to the architect before
drafting. Four questions were resolved against the repository or by architect ruling:

1. **"What exactly is the always-on surface, as served?"** — Resolved by reading the live
   composition path (`commands/porch/prompts.ts`, `lib/skeleton.ts`, `lib/managed-block.ts`,
   `agent-farm/commands/spawn-worktree.ts`) and by measuring this builder's own served
   artifacts (`.builder-prompt.txt` 4,921w, `.builder-role.md` 1,837w). Full enumeration
   in **Current State → Inventory**.
2. **"Is the committed measurement script fit to score this project?"** — No; three
   defects, one of them disqualifying. Criterion **M0**. Architect verified both original
   claims against source and **endorsed M0 as specced** (2026-07-31).
3. **"How wide is the rewrite target?"** — **Architect scope directive (2026-07-31)**: the
   entire prompt surface, not CLAUDE.md/AGENTS.md — architect role prompts, builder roles
   and spawn wrappers, consultant/CMAP review prompts, porch phase prompts and their
   template includes, and `protocol.md` texts. The instrument must **segment by audience**
   so a cut concentrated in one segment while another grows is visible, not averaged away.
4. **"Where are the eight ratified scar rules?"** — Recovered verbatim from
   `builder/spir-1252:codev/resources/scar-rules.yaml`. Carriage plan in **Desired State**.

## Problem Statement

A Codev builder consumes **~34,300 served always-on words** before it reads a line of the
code it was spawned to change. Almost none of that is information the builder could not
derive; it is *process narration* — recipes for how to be an agent, written when the fleet
could not be trusted to infer them.

Spec 1252 measured the surface and proved the obvious remedy does not work: deduplication
yields **−7.0%**, because the surface is not duplicated, it is **over-instructed**.

Over-instruction has three compounding costs:

1. **It crowds out judgment.** A frontier model given a 3,700-word procedure follows the
   procedure. Given a 700-word contract and a goal, it reasons about the goal. Anthropic's
   published account of the Claude-5-generation rewrite reports >80% of Claude Code's
   system prompt deleted with no measurable performance loss.
2. **Nobody reads it, so it rots unnoticed.** 1252 found the *served* SPIR builder prompt
   had silently lost its entire `Verify Phase` section, with a detector reporting the drift,
   unread, for months. A surface too large to read is too large to maintain.
3. **It makes its own success unmeasurable.** The committed measurement script scores a
   directory the runtime never loads. Nothing about the prompts a builder actually receives
   has been under measurement.

Deletion on judgment-trust grounds was an explicit **Non-goal** of Spec 1252 and has never
been attempted here.

### The instrument is part of the deliverable

This is the **second** measurement defect in the 1252 lineage. The first: Spec 1252
originally shipped with no measurement plan at all — caught at a human gate, not by CMAP.
The second is documented below: a committed, tested, reproducible script that measures the
wrong directory, so its numbers are precise and wrong. Neither was caught by reading the
instrument's code; both by asking *what does this claim to measure, and does it?*

Hence an explicit project principle, adopted at the architect's direction and binding on
every criterion here:

> **The instrument is part of the deliverable, and instruments get reviewed against what
> they claim to measure — not merely against whether they run.** A measurement script, a
> check, or a baseline artifact is subject to the same adversarial review as the feature it
> scores. "Deterministic and committed" is not "correct."

It is load-bearing: this project's headline criterion is a number one shell script emits.
Discovering *before* drafting that the metric was structurally blind to the project's own
largest target is the correct order of operations, and is why M0 precedes M1.

**The principle applied to this spec, iteration 1 → 2.** CMAP round 1 found two further
instrument-class errors in my own Current State — a stale claim inherited from the script's
comments, and a conclusion drawn from a truncated grep. Both are corrected below and both
are recorded, not quietly fixed: a spec that argues instruments get audited must show its
own being audited.

## Current State

### Inventory — every prompt-bearing surface, by audience

Word counts are **served and expanded** (`{{> …}}` includes resolved through the
`codev/` → `codev-skeleton/` chain), captured 2026-07-31 at `047f92f7`.

**SHARED — every agent working in this repo**

| Surface | Resolver path | Words | How served |
|---|---|---:|---|
| `CLAUDE.md` | repo root | 5,815 | session, harness auto-load |
| ↳ `@codev/resources/arch-critical.md` | four-tier | 416 | **transcluded at session launch** (#1119) |
| ↳ `@codev/resources/lessons-critical.md` | four-tier | 320 | same |
| `AGENTS.md` | repo root | 5,815 | byte-identical twin; one loads per session, never both |

**Session shared total: 6,551.**

**ARCHITECT**

| Surface | Resolver path | Words | How served |
|---|---|---:|---|
| `roles/architect.md` | four-tier | 2,048 | read at `arch-init` (every architect session) |
| `.claude/skills/*/SKILL.md` ×10 | repo | 6,672 | on-demand (progressive disclosure — working as intended) |

**BUILDER — spawn, once per builder**

| Surface | Words | | Surface | Words |
|---|---:|---|---|---:|
| `roles/builder.md` (inlined) | 1,837 | | `protocols/pir/protocol.md` | 2,066 |
| `protocols/spir/protocol.md` | 3,703 | | `protocols/maintain/protocol.md` | 1,949 |
| `protocols/spir/builder-prompt.md` | 824 | | `protocols/research/protocol.md` | 1,278 |
| `protocols/pir/builder-prompt.md` | 898 | | `protocols/experiment/protocol.md` | 1,023 |
| `protocols/aspir/builder-prompt.md` | 820 | | `protocols/spike/protocol.md` | 920 |
| `protocols/research/builder-prompt.md` | 556 | | `protocols/aspir/protocol.md` | 810 |
| `protocols/air/builder-prompt.md` | 537 | | `protocols/bugfix/protocol.md` | 699 |
| `protocols/experiment/builder-prompt.md` | 472 | | `protocols/air/protocol.md` | 643 |
| `protocols/bugfix/builder-prompt.md` | 429 | | | |
| `protocols/spike/builder-prompt.md` | 400 | | `protocols/maintain/builder-prompt.md` | 374 |

**SPIR builder spawn total: 6,364** (role 1,837 + wrapper 824 + protocol 3,703).

**PHASE — per porch task delivery, ×I**

Hot tier (736) rides on *every* phase prompt. Expanded phase prompts:

| Protocol | Prompts (expanded) | Mean |
|---|---|---:|
| spir / aspir | specify 1,402 · plan 1,169 · implement 1,065 · review 1,957 | **1,398** |
| pir | review 2,414 · implement 1,151 · plan 741 | 1,435 |
| bugfix | pr 491 · fix 352 · investigate 290 | 378 |
| air | pr 471 · implement 442 | 457 |
| maintain | maintain 402 · review 310 | 356 |

**CONSULTANT — per CMAP review, ×3 models × ~10 reviews per project**

`roles/consultant.md` 252 (system prompt) + one consult-type: spir/aspir spec-review 514 ·
impl 421 · phase 421 · plan 406 · pr 392; bugfix pr 726 / impl 641; pir pr 475 / impl 507;
air pr 455 / impl 420; maintain 421 / 392. **SPIR consultant per review: 683.**

**DEAD**

`codev-skeleton/porch/prompts/**` — 10 files, 4,009 words, no runtime consumer.

### Always-on load, by audience

| Audience | Composition | Words |
|---|---|---:|
| **Builder** (SPIR, I=10) | 6,551 session + 6,364 spawn + 10×(736 + 1,398) | **34,255** |
| **Architect** (per session) | 6,551 session + 2,048 role | **8,599** |
| **Consultant** (per review) | 252 role + 431 mean consult-type | **683** |

The builder figure is the headline. `I = 10` phase-task deliveries is 1252's proxy,
consistent with B4's 3.06 review rounds/project across 4–6 phases; it is a *comparison*
constant, identical before and after.

### The measurement defects (why M0 exists)

**Defect 1 — the script measures a dead directory.** `measure-prompt-surface.sh:89` derives
`PORCH_PROMPT_MEAN` from `codev-skeleton/porch/prompts/*.md` (10 files, mean 400). The live
resolver (`commands/porch/prompts.ts:78`, `loadPromptFile`) loads
`protocols/<protocol>/prompts/<file>.md`. Real SPIR phase prompts average **1,398**. The
dead tree is a Ralph-SPIR-era leftover — its `specify.md` opens *"You are the **Spec
Writer** hat in a Ralph-SPIR loop."*

**Defect 2 — the script omits the inlined role.** `spawn-worktree.ts:854` writes
`roles/builder.md` to `.builder-role.md` and the harness injects it. 1,837 always-on words,
uncounted.

**Defect 3 — the script's hot-tier accounting is stale.** Its comment (lines 44–47) asserts
CLAUDE.md "already inlines the two hot-tier files." Since #1119 (`managed-block.ts:59-67`)
CLAUDE.md carries `@import` lines, which Claude Code transcludes at session launch. So
`wc -w CLAUDE.md` = 5,815 **excludes** 736 words that are always loaded. *(Found by CMAP
round 1 — an instrument-class error I inherited from the instrument's own comments, which
is precisely the failure principle 7 names.)*

Consequences: the reported baseline (21,702) understates the phase-task term ~3.5×, omits
the role file, and under-counts the session term by 736. **And the metric cannot see this
project's primary target** — cutting SPIR phase prompts from 1,398 to 430 moves
`ALWAYS_ON_WORDS` by exactly zero under the current script. A >50% claim scored on it would
be phantom savings, the precise failure 1252 built the script to prevent.

**Correction to iteration 1 of this spec.** It claimed "a repo-wide grep finds no code
reading `porch/prompts`; every hit is historical spec/plan prose." That is **false**, and
the cause is mine: I piped `grep -rn` into `head -20` and drew a conclusion from truncated
output. `packages/codev/src/__tests__/review-prompt-routing.test.ts:29` pushes
`codev-skeleton/porch/prompts/review.md` onto its assertion list (a Spec 987 hot/cold
routing protection). The tree is still dead as *prompt surface* — no runtime consumer — but
it has a **test** consumer, so M6's verification method and deletion step change accordingly.
This is the sweep-scope failure class 1252 named as its dominant review-iteration cost, and
it is exactly what a truncated grep buys.

### What already landed, and what is deferred

On `main` (the 1252 harvest): drift reconciliation, the audit, two word baselines, the
behavioural baseline (B1 = 51.88% REQUEST_CHANGES, n=160, self-excluded), and the
measurement tooling. Deferred here by architect ruling: the **scar registry and its eight
ratified wordings**, and enforcement rebuilt *after* the shrink.

Issue #1279 is partly overtaken — SPIR prompts now inline their templates via `{{> …}}`,
which is what makes each phase prompt ~600 words heavier than it reads. Two *separate*
constraints govern template shape, and conflating them would over-preserve surface:
`checks.ts:149-154` (`REQUIRED_SPEC_SECTIONS`) requires only **four** headings — Problem
Statement, Current State, Desired State, Success Criteria — while the 20-heading template
pressure comes from the `spec-review` consult type, advisorily.

## Desired State

**One prompt form, written for frontier models, that states contracts and trusts judgment.**
A builder's always-on context tells it what it owns, what artifacts it must produce and
what shape they take, where the human gates are, and what is irreversible — then gets out of
the way. Everything else is reachable on demand.

### Rewrite principles

1. **Contract, not recipe.** State the required outcome and its shape; delete the ordered
   procedure for reaching it.
2. **Interface, not example.** A heading skeleton with one line of intent per heading
   replaces an annotated template with filler prose.
3. **No worst-case padding.** Delete instructions guarding failure modes frontier models
   do not exhibit (repeated all-caps prohibitions, "⚠️ BLOCKING" banners, checklists
   restating the phase body).
4. **Progressive disclosure.** How-to content a competent agent would look up moves to
   skills / on-demand files, addressed by name, not inlined.
5. **Budgets are cheap words worth keeping.** Frontier models honour stated budgets
   precisely but never invent them; budget/scope lines are exempt from cuts.
6. **Scar rules are verbatim and exempt from rewriting** — but **counted** in ceilings
   (see carriage plan).
7. **The instrument is part of the deliverable.** Every check, script, and baseline is
   reviewed against what it claims to measure. A word ceiling not measured on served words
   is not a ceiling.

### Per-surface ceilings (GROSS — scar words count inside every ceiling)

*CMAP round 1 (both reviewers, independently) found iteration 1 stated M1 on a gross basis
while declaring ceilings "net of" scar carriage. Incompatible. Resolved: **all ceilings are
gross**, and the arithmetic below carries carriage explicitly.*

Ceilings apply to the SPIR instance as the measured proxy **and sweep across all ten
protocols in both trees** — an unswept protocol is a regression, not a deferral.

| Segment | Surface | Now | Ceiling (gross) | Scar carriage inside |
|---|---|---:|---:|---:|
| shared | `CLAUDE.md` / `AGENTS.md` | 5,815 | **≤1,900** | ~190 (all 8) |
| shared | hot tier (`@import`) | 736 | **736 unchanged** | — |
| architect | `roles/architect.md` | 2,048 | **≤700** | ~30 |
| builder | `roles/builder.md` | 1,837 | **≤600** | ~12 |
| builder | `protocols/*/protocol.md` (SPIR) | 3,703 | **≤700** | — |
| builder | `protocols/*/builder-prompt.md` (SPIR) | 824 | **≤420** | ~40 |
| phase | `protocols/*/prompts/*.md` expanded (SPIR mean) | 1,398 | **≤430** | ~14 |
| consultant | `protocols/*/consult-types/*.md` (SPIR mean) | 431 | **≤200** | — |
| consultant | `roles/consultant.md` | 252 | **≤252 unchanged** | — |
| dead | `codev-skeleton/porch/prompts/**` | 4,009 | **0 (deleted)** | — |

### Post-rewrite always-on, by audience (the segmented view the directive requires)

```
BUILDER (SPIR, I=10)
    session   (1,900 + 736)                    2,636
  + spawn     (600 + 700 + 420)                1,720
  + phase ×10 (736 + 430)                     11,660
    -----------------------------------------------
    34,255 → 16,016                          −53.2%

ARCHITECT   8,599 → 3,336  (2,636 session + 700 role)      −61.2%
CONSULTANT    683 →   452  (252 role + 200 consult-type)   −33.8%
```

No segment grows. The consultant segment cuts least because `roles/consultant.md` is
already lean at 252 words — reported rather than averaged into the headline, per the
directive.

**Margin, stated honestly.** −53.2% clears >50% by 3.2 points ≈ 1,100 words. **M2
(per-surface ceilings) is the binding criterion; M1 is derived.** If all ceilings are met
and M1 lands in 50–52%, that is a **HOLD**, not a pass — the plan must find the remainder,
with named candidates in priority order: further `protocol.md` compression, relocating
CLAUDE.md's Runnable-Worktree recipes wholesale to a skill, and the `pir`/`spir` review
prompts (2,414 / 1,957 — the two fattest phase prompts in the fleet).

Note the shape: the phase term is 73% of the post-rewrite builder budget and the **exempt**
hot tier is 63% of that term. What survives is overwhelmingly curated judgment, not process.

### Scar-rule carriage plan

The eight rules ratified 2026-07-28 (`git show
builder/spir-1252:codev/resources/scar-rules.yaml`) ship **verbatim**: `git-add-explicit`,
`never-destroy-worktrees`, `no-destructive-git`, `human-gates`, `no-hand-edit-status`,
`afx-from-root`, `shellper-verified-orphan`, `tower-restart-permission` (~188 words of
canonical text total).

- The registry is **rebuilt fit-for-purpose after the shrink**: each rule's `must_appear_on`
  is re-derived against the post-rewrite surface, since most 1252-listed files will have
  been rewritten or deleted.
- Carriage is **exempt from rewriting but counted in ceilings** — a ceiling a surface cannot
  meet while carrying its scar rules is a wrong ceiling, and gets raised deliberately, not
  met by trimming scar text.
- Enforcement is a byte-identical-presence test over the registry, pinned at 8 rules and
  their ids. Nothing larger is built until the surface it polices stops moving.
- A scar rule may be **compressed only by architect ratification**, never by a builder
  applying principle 1.

## Stakeholders

- **Primary Users**: builder agents; CMAP reviewer agents (consult-type prompts); architect
  agents (role + skills).
- **Secondary Users**: humans who must read and maintain the surface; downstream adopters
  receiving it via `codev update`.
- **Technical Team**: this builder; the architect at both gates.
- **Business Owners**: Waleed — charter holder; ratifies scar wordings, rules on the A/B
  verdict and on any ceiling change.

## Success Criteria

- [ ] **M0 — the metric measures what is served, segmented by audience.** The corrected
      script: (a) sources phase prompts from the directory `loadPromptFile` resolves;
      (b) resolves **per-file through the full four-tier chain** (`.codev/` → `codev/` →
      cache → skeleton) exactly as `resolveCodevFile` does, not two-tier directory-level
      selection, so mixed per-file overrides measure correctly; (c) counts the inlined
      `roles/builder.md`; (d) counts hot-tier `@import` transclusion in the session term and
      **corrects the stale inlining comment**; (e) expands `{{> …}}` includes; (f) reports
      **per-segment subtotals — architect / builder / phase / consultant — alongside the
      total**. Tests assert (a) and (b) against the real resolver, so these defects cannot
      silently return.
- [ ] **M0b — the corrected instrument and baseline land on `main` early**, as a small
      standalone PR (precedent: #1290), not at the end of this branch.
      `1252-word-baseline.md` and `1252-word-after-phase7.md` cite figures derived from the
      dead tree and are shared knowledge other work reads; the correction annotates them in
      place — original figures preserved, marked superseded, with the reason — and does not
      rewrite their history.
- [ ] **M1 — >50% reduction (derived).** Builder always-on falls from the corrected baseline
      (34,255) to **≤16,100**, measured before and after by the same corrected script, both
      figures committed as generated artifacts. Per-segment figures reported and none
      regressed.
- [ ] **M2 — per-surface ceilings met (binding).** Every row of the ceiling table, gross, in
      **both** trees, for **all ten protocols**.
- [ ] **M3 — sweep completeness.** Protocols enumerated from disk, not a hardcoded list; no
      protocol retains a pre-rewrite `protocol.md`, `builder-prompt.md`, prompt set, or
      consult-type set.
- [ ] **M4 — scar rules intact.** Eight canonicals byte-identical on every registered
      surface; test fails on reword or deletion; count pinned at 8.
- [ ] **M5 — no capability lost, deterministically checked.** A committed
      `capability-inventory.json` is extracted pre-rewrite by a script with **explicit
      recognition rules**: artifact paths (`codev/(specs|plans|reviews)/…` literals and
      `{{artifact_name}}` forms), gate names (from `protocol.json` `gate:` fields), signal
      names (`<signal …>` tags), porch check names (`protocol.json` `checks:` ids),
      notification triggers (`afx send architect` call sites). Normalization: lowercase,
      strip backticks/punctuation, dedupe. Post-rewrite extraction must be a superset;
      **any removal fails** and must be justified in the review as a deliberate retirement.
- [ ] **M6 — the dead tree is gone, with its consumer handled.**
      `codev-skeleton/porch/prompts/` deleted. Verification is **not** a bare grep: an
      untruncated repo-wide search (`grep -rn … | wc -l` reconciled against the full hit
      list) shows zero *runtime* consumers, and the one **test** consumer —
      `review-prompt-routing.test.ts:29`, a Spec 987 hot/cold-routing protection — is
      updated under M10's re-baselining rule, naming Spec 987 as the originating spec.
- [ ] **M7 — A/B non-inferiority passes** per the pre-registered decision rule.
- [ ] **M8 — behavioural baseline re-run.** `measure-prompt-behavior.ts` re-run and
      committed; B1 compared directionally to 51.88% (n=160) with the sample documented.
- [ ] **M9 — rollback rehearsed** per **Rollback Plan**, by group.
- [ ] **M10 — prose-pinned test re-baselining is deliberate and enumerated.** ~25 test files
      assert exact prose in the surfaces being cut; the hardest is
      `agent-farm/__tests__/baked-decisions.test.ts:143-148`, which enforces a
      **pure-addition diff** against committed baselines for
      `protocols/{spir,aspir,air}/builder-prompt.md` — logically incompatible with cutting
      824 → ≤420. Also: `bugfix-744-spir-pr-strategy.test.ts` (4 near-verbatim sentences),
      `spec-1273-wait-discipline-docs.test.ts` (16 assertions), `bugfix-619-aspir-prompt.test.ts`,
      `template-delivery.test.ts`, `framework-ref-audit.test.ts`, `governance-sweep.test.ts`,
      `review-prompt-routing.test.ts`. **Each assertion is a prior spec's protection encoded
      as a grep.** Therefore: every modified or retired assertion is listed in the review
      with (i) the spec that created it, (ii) whether the protected behaviour survives in
      the rewritten prose, (iii) the replacement assertion if the behaviour survives, or an
      explicit architect-visible retirement if it does not. Re-baselining a pure-addition
      baseline is permitted **only** with the originating spec named and the new baseline
      committed in the same commit. Silent deletion of an assertion to make the suite green
      is a project failure, not a test fix.
- [ ] All tests pass **after M10's enumerated re-baselining**; no coverage reduction. New
      tests cover M0, M3, M4, M5.
- [ ] Documentation routed by tier (`arch.md`/`arch-critical.md`,
      `lessons-learned.md`/`lessons-critical.md`); `CLAUDE.md`/`AGENTS.md` byte-identical.

## Constraints

### Technical Constraints

Verbatim from issue #1280's **Baked Decisions** — fixed, not re-litigated by this spec, the
plan, or CMAP reviewers:

- **All prompt consumers are frontier models** (Claude 5, GPT 5.6, Gemini 3.6 class). No
  weak-model tier, no fallback scaffolding variant, no tiering mechanism. One form.
- **Scar rules are exempt and verbatim** — the eight compressed canonicals developed in
  Spec 1252 Phase 5 (six repo rules + shellper verified-orphan + Tower-restart permission)
  ship with the rewrite; the registry/enforcement concept from 1252 is rebuilt
  fit-for-purpose around the post-shrink surface, not before it.
- **Validation is A/B, not observational**: same issues executed by builders on old vs new
  prompts, compared on outcomes (gate friction, review rounds, correctness). Spec 1252's
  M12 established that observational baselines (n=17) can only detect large regressions —
  insufficient at deletion scale. The A/B design is a first-class spec section.
- Spec must define a rollback story (prompt surfaces are files; reverting is cheap — say so
  concretely).

Arising from the repository and the architect's scope directive:

- **Scope is the full prompt surface, segmented**: architect roles, builder roles and spawn
  wrappers, consultant/CMAP prompts, phase prompts and template includes, `protocol.md`
  texts. Measurement reports per-segment, never averaged away.
- **Both trees**; `CLAUDE.md` and `AGENTS.md` byte-identical.
- **Four-tier resolution, per file.** No fetch-by-path instruction for a file that may not
  exist on disk (deliver-don't-fetch).
- **No porch behaviour changes.** Content rewrite plus a measurement-script fix. Changing
  the state machine, gates, or check semantics is out of scope.
- **Template shape is governed by two separate constraints** (porch's 4 required headings;
  the consult type's advisory 20) — they must not be conflated.

### Business Constraints

- Two human gates (`spec-approval`, `plan-approval`) plus `pr`; the A/B verdict is the
  architect's call.
- Adopters consume the skeleton via `codev update`, so rollback must be a revertible unit
  per **group**.
- Scar-rule wordings are architect-ratified; a builder may not compress them.
- **The corrected instrument ships early, as its own PR** (M0b) — architect-directed. The
  remaining phase-commits ship as a single later PR.

## Assumptions

- The eight scar wordings on `builder/spir-1252` remain the ratified set.
- `I = 10` remains the agreed proxy; it is a comparison constant, identical both sides.
- Frontier-model behaviour is stable across the A/B window (mitigated by pairing, same base
  commit, and pinned model/config versions).
- `builder/spir-1252` stays undeleted — sole source of the ratified registry.
- CMAP reviewers are blind to the builder's prompt surface by construction: a reviewer sees
  artifacts and diffs, not the prompt that produced them.

## Solution Approaches

### Approach 1: In-place judgment rewrite, surface by surface (RECOMMENDED)

**Description**: Rewrite each file to the seven principles, keeping file layout, resolver
and porch untouched. Templates become heading interfaces. How-to content relocates to
existing skills. The dead tree is deleted. The instrument is corrected first, so every
subsequent cut is scored honestly.

**Pros**: zero mechanism risk; every change is a reviewable text diff; rollback granularity
equals cut granularity; compatible with deliver-don't-fetch.

**Cons**: discipline-dependent (nothing structurally prevents re-growth — mitigated by T3);
large diff across 10 protocols × 2 trees, so sweep completeness is the main risk; collides
with ~25 prose-pinned test files (M10).

**Estimated Complexity**: Medium · **Risk Level**: Low-Medium

### Approach 2: Generate prompts from `protocol.json`

**Description**: Treat `protocol.json` as source of truth; synthesize phase prompts at
runtime with a small per-phase prose delta.

**Pros**: structurally prevents re-growth and drift; would have made the 1252 drift bug
impossible.

**Cons**: introduces a code path between authoring and serving — new failure mode, harder to
review and revert, and it changes porch behaviour (an explicit constraint). Couples the
shrink to a mechanism change, so an A/B regression becomes un-attributable: deletion or
generator?

**Estimated Complexity**: High · **Risk Level**: Medium-High

**Verdict**: right idea, wrong project. A generator over a 16,000-word surface is a
plausible successor.

### Approach 3: Shared kernel + per-protocol deltas

**Description**: One protocol-agnostic builder kernel (gates, artifacts, thread,
notifications, scar rules) included by every protocol, plus a short per-protocol delta.

**Pros**: attacks cross-protocol duplication the per-surface table does not; uses the
existing include mechanism, so it is served-word-honest.

**Cons**: 1252 proved dedup buys ~7% on *served* words — an include expands, so moving text
changes ownership, not the bill. Savings are maintenance, not context. Risks re-creating the
shadow-tree bug class (one edit silently changing ten protocols' served prompts).

**Verdict**: adopt selectively *inside* Approach 1 where a kernel reduces served words for
the reader, and only after the shrink.

## Open Questions

### Critical (Blocks Progress)

*None outstanding.* Both former Critical questions are resolved:

- [x] **~~Corrected measurement baseline accepted?~~** **RESOLVED 2026-07-31** — architect
      verified both claims against source (script line 89; `prompts.ts:78`) and endorsed M0
      as specced; >50% unchanged against the corrected baseline. Added M0b and principle 7.
- [x] **~~How is "gate friction" captured?~~** **RESOLVED** — 1252 established gate
      rejections are not minable (no `rejected` state; `requested_at` overwritten). A porch
      gate-event log is a behaviour change and out of scope. **Decision: O1 is scored
      prospectively by the architect on the rubric in the A/B section, and is
      *advisory-with-a-tripwire*, not a SHIP gate** — if scoring is incomplete for any pair,
      O1 is reported as incomplete and SHIP rests on O2/O3/O4. This removes the single point
      of failure CMAP flagged while keeping the signal.

### Important (Affects Design)

- [ ] **A/B sample size.** ≥6 pairs specified; more buys power at real builder and consult
      cost (~$1,478/30d at current rates). The architect sets the ceiling.
- [ ] **Do SPIR templates survive as interfaces, or disappear?** Recommendation: survive as
      ≤150-word heading interfaces — porch requires only 4 headings, but the interface is
      what makes the artifact contract legible without narration.
- [ ] **Is the hot tier's 736 genuinely exempt?** It is the one surface already built to
      these principles. The spec exempts it; a reviewer may argue it should be re-derived
      post-shrink, and it is 63% of the phase term.
- [ ] **`roles/architect.md` 2,048 → ≤700** — the architect segment was outside 1252's
      analysis entirely. Confirm nothing in it is load-bearing for multi-architect
      coordination (Specs 755/786/823) before cutting.

### Nice-to-Know (Optimization)

- [ ] Does trimming consult-type prompts move CMAP verdict *quality*, or only cost? B1 shows
      the rate; quality needs human adjudication.
- [ ] Are the ~17,000 words of `.claude/skills/` the right destination for relocated
      how-tos, or does that surface need its own budget?

*(Iteration 1's "should a word-budget check run in CI?" is withdrawn — it contradicted T3,
which already runs the ceilings as a test. T3 stands.)*

## Performance Requirements

- **Builder always-on**: ≤16,100 words (from 34,255) — M1.
- **Per-segment**: architect ≤3,400 (from 8,599); consultant ≤460 (from 683); no segment
  regresses.
- **Per-surface ceilings**: as tabulated — M2, binding.
- **Measurement runtime**: <5s, deterministic — same commit ⇒ byte-identical output.
- **Token/cost effect** (advisory): ~18,200 fewer always-on words ≈ ~24,000 tokens per
  builder-project; recorded before/after as context for the A/B, keying no threshold.

## Security Considerations

- **The scar rules are the security surface.** All eight guard irreversible acts (destroying
  uncommitted work or worktrees, killing live sessions, bypassing a human gate). Weakening
  one is the highest-severity failure this project can produce — hence verbatim carriage,
  byte-identical enforcement, counted-not-exempt ceilings, and a hard rollback trigger on
  any observed violation.
- **Human-gate integrity.** The rewrite must not weaken "a gate message is a notification to
  the human, not authorization." Gate semantics are content, and this project edits content.
- **No secrets in prompt surfaces** — existing property, re-verified after the rewrite.
- **Adopter blast radius.** Skeleton changes ship on `codev update`; a weakened prohibition
  propagates silently. Hence grouped, rehearsed rollback.

## Test Scenarios

### Functional Tests

1. **T1 — Instrument sources the served directory (M0a).** The script's phase-prompt source
   equals the directory `loadPromptFile` resolves, asserted against the real resolver.
2. **T1b — Instrument resolves per-file, four-tier (M0b).** A fixture with a `.codev/`
   override of *one* prompt while others resolve from the skeleton measures each file at its
   winning tier — kills the directory-level-selection defect class.
3. **T2 — Include expansion (phantom-savings proof).** Moving text from prompt into template
   produces **zero** change in the reported total.
4. **T3 — Ceilings (M1/M2).** Each surface at or under its gross ceiling, per protocol, per
   tree; failure names surface and overage. Runs in CI as the anti-re-growth guard.
5. **T4 — Scar integrity (M4).** Every canonical byte-identical on every registered surface;
   count pinned at 8; reword or deletion fails.
6. **T5 — Capability inventory (M5).** Post-rewrite extraction ⊇ pre-rewrite, using M5's
   recognition and normalization rules; removals fail.
7. **T6 — Sweep completeness (M3).** Protocols enumerated from disk; each satisfies T3; a
   newly added protocol fails until written to budget.
8. **T7 — Twin parity.** `CLAUDE.md` ≡ `AGENTS.md`; `codev/` and `codev-skeleton/` copies
   consistent.
9. **T8 — Dead-tree removal (M6).** Tree absent; no runtime reference; the Spec 987 routing
   test updated per M10 and still protecting hot/cold routing on its remaining files.
10. **T9 — Live spawn probe.** A builder spawned end-to-end on the rewritten surface receives
    a spawn prompt containing every element of the artifact contract, and its first
    `porch next` returns a well-formed task. ("It compiled" is not "it works.")
11. **T10 — Rollback rehearsal (M9).** Reverting a rollback **group** on a scratch branch
    restores that group byte-for-byte and leaves the suite green.
12. **T11 — Segment reporting (M0f).** The script emits architect/builder/phase/consultant
    subtotals that sum to the total; a fixture where one segment grows and another shrinks
    shows both movements, not a netted zero.

### Non-Functional Tests

1. **T12 — Determinism.** Two runs at the same commit emit byte-identical output.
2. **T13 — Behavioural re-measurement (M8).** `measure-prompt-behavior.ts` re-run post-merge
   with self-exclusion; B1/B2/B4 committed and compared directionally.
3. **T14 — A/B execution (M7).** The full pre-registered protocol below.

## A/B Validation Design

*(First-class section per Baked Decision 3. A **non-inferiority** trial: the claim under
test is "deleting ~53% of the always-on surface does not degrade outcomes", not "it improves
them".)*

### Unit and arms

The unit is an **issue-pair**: one GitHub issue executed twice, by two freshly-spawned
builders in separate worktrees, from the same base commit.

- **Control (A)**: worktree at the pre-rewrite commit.
- **Treatment (B)**: worktree at the post-rewrite commit.

No code differs between arms — the prompt surface is file-resolved, so the arms are two
checkouts.

### Sample and eligibility

- **≥6 pairs (12 runs)**, stratified: ≥3 SPIR/ASPIR (exercises spec/plan/implement/review
  prompts, both gates, templates) and ≥3 lighter protocols (BUGFIX/AIR).
- Issues drawn from the existing backlog, selected **before** either arm runs, then frozen
  (no issue-body edits mid-trial).
- **Eligibility exclusion (CMAP round 1):** an issue is ineligible if it modifies any
  surface under test. Otherwise the treatment arm's own prompt surface is simultaneously
  instrument and subject.

### Contamination controls

- **Pin the environment**: model ids and reasoning efforts, consult backend versions, and
  `.codev/config.json` frozen for the trial window and recorded with the results.
- **Arm isolation**: the second arm of a pair must not see the first arm's branch, PR, or
  thread file. Arms run **sequentially with the intervening branch unpushed**, or
  concurrently in isolated worktrees — either is acceptable; which was used is recorded
  per pair.
- **Arm order alternates** per pair to control for time-varying factors.
- **Recording**: one committed results artifact
  (`codev/resources/1280-ab-results.md`) with a row per run — pair id, arm, protocol, issue,
  base commit, order, isolation mode, every outcome value, and any exclusion with its
  reason. Exclusions after the fact must be justified in that file, not silently dropped.

### Pre-registered outcomes

| ID | Outcome | Instrument | Role in decision |
|---|---|---|---|
| **O1** | Gate friction | Architect scores each gate at approval time on a 3-item rubric — *artifact complete as specified? / rework required before approval? / clarifying message needed?* — each scored 0 (no friction) / 1 (minor) / 2 (blocking), recorded in the results artifact at scoring time | **advisory + tripwire** |
| **O2** | Review rounds | Iterations to terminal state per phase from `status.yaml` history; CMAP REQUEST_CHANGES rate (comparable to B1 = 51.88%) | gate |
| **O3** | Correctness | Architect PR-review findings by severity; any post-merge defect attributable to the run | gate |
| **O4** | Protocol compliance | Binary per-run checklist: required artifacts with required headings · stopped at every human gate · no `status.yaml` hand-edit · no `git add -A` · no scar violation · thread committed | **zero tolerance** |
| **O5** | Cost & duration | Tokens, wall-clock, `consult stats` delta | advisory |

### Blinding

CMAP reviewers are blind by construction. The architect is not and cannot be; mitigations:
O2 and O4 are extracted mechanically from committed artifacts, and O1/O3 are scored against
a rubric written **before** any run.

### Decision rule (pre-registered)

**SHIP** iff all of:

1. **O4 = zero violations** in the treatment arm. Any scar violation, skipped gate, or
   missing required artifact is an immediate hard stop, independent of everything else.
2. **O2**: treatment mean review rounds ≤ control **+ 0.5 rounds/phase**, and treatment
   REQUEST_CHANGES rate ≤ control **+ 10 percentage points**.
3. **O3**: no treatment-arm finding of severity ≥ "would block merge" absent from its paired
   control run.
4. **O1 tripwire**: no pair where the treatment arm scored **2 (blocking)** at a gate its
   control scored 0, for the same reason. If O1 scoring is incomplete for any pair, O1 is
   reported incomplete and SHIP rests on 1–3.

Otherwise **HOLD** (fix and re-run the failing pairs) or **ROLLBACK**.

### Honest power statement

With n=6 pairs this detects only **large** effects — roughly a doubling of review rounds or
a ≥20-point REQUEST_CHANGES shift. It cannot certify the absence of a subtle regression, and
this spec does not claim it can. It is nonetheless strictly stronger than 1252's
observational baseline, because each pair is matched on the issue itself — the dominant
variance source. **O4's zero-tolerance criterion is where the real protection lives**:
compliance is binary, observable in every run, and is the failure mode deletion would
plausibly cause.

## Rollback Plan

*(Required by Baked Decision 4.)*

CMAP round 1 correctly flagged that iteration 1 overstated per-surface independence: prompts,
their included templates, scar-registry mappings, and integrity tests are coupled — reverting
a prompt without its template can break a required-headings check or M4. Rollback is
therefore by **group**, each group internally consistent and independently revertible:

| Group | Contents |
|---|---|
| **G1 instrument** | measurement script + its tests + baseline artifacts |
| **G2 shared** | `CLAUDE.md` + `AGENTS.md` + hot-tier wiring |
| **G3 builder-spawn** | `roles/builder.md` + all `builder-prompt.md` + all `protocol.md` + their prose-pinned tests |
| **G4 phase** | all `prompts/*.md` + their `templates/*.md` + porch check expectations |
| **G5 consultant** | `roles/consultant.md` + all `consult-types/*.md` |
| **G6 architect** | `roles/architect.md` + relocated skill content |
| **G7 scar registry** | `scar-rules.yaml` + its enforcement test |

- **Dependency rule**: reverting **G7** requires reverting every group whose surfaces carry
  scar text (G2, G3, G4, G6) — the registry and its copies must agree. All other groups are
  mutually independent.
- **Mechanism**: `git revert` restores prior bytes. No migration, state, schema, or data.
  Rehearsed under T10 before the PR merges.
- **Blast radius**: for this repo, effective for the next spawned builder — in-flight
  builders keep the surface they were spawned with (prompts read at spawn/phase time). For
  adopters, the revert ships in the next release; an adopter can also pin the prior
  `@cluesmith/codev` version, since framework files resolve from the installed skeleton.
- **Triggers**: (a) any O4 violation — immediate, no deliberation; (b) an observed scar
  violation in any real project post-merge; (c) O2/O3 outside pre-registered margins;
  (d) architect judgment at the `pr` or `verify-approval` gate.
- **Partial rollback is the expected shape** — revert the offending group, keep the rest.
- **Cost**: one revert, one release. No irreversible step exists anywhere in this project.

## Dependencies

- **External Services**: none. (`gh` for issue/PR reads during the A/B; consult backends —
  Gemini via `agy`, Codex, Claude — unchanged.)
- **Internal Systems**: four-tier resolver (`lib/skeleton.ts`); porch prompt composition
  (`commands/porch/prompts.ts`) — read, not modified; managed-block hot-tier wiring
  (`lib/managed-block.ts`); role injection (`agent-farm/commands/spawn-worktree.ts`);
  consult-type resolution (`commands/consult/index.ts`); both measurement scripts.
- **Artifacts**: `builder/spir-1252` (ratified registry — must not be deleted);
  `codev/resources/1252-*.md` baselines.
- **Test suites**: the ~25 prose-pinned files enumerated in M10 — a dependency in the real
  sense that the cuts cannot land without deliberately re-baselining them.
- **Libraries/Frameworks**: none new.

## References

- Issue #1280 (charter); #1279 (dead spec/review templates); #1276, #1277 (filed by 1252 —
  superseded here or out of scope).
- PR #1278 (Spec 1252, closed unmerged) and `builder/spir-1252`.
- `codev/reviews/1252-prompt-architecture-single-own.md`; `codev/resources/1252-*.md`;
  `codev/state/spir-1252_thread.md`.
- *The new rules of context engineering for Claude-5-generation models* —
  https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models
- `codev/resources/arch.md` (four-tier resolution, include directive, hot-tier injection);
  `codev/resources/lessons-learned.md` (sweep-scope failures, served-surface dedup).

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| A deleted instruction was load-bearing; loss is silent | Medium | High | M5 deterministic capability inventory (removals fail); O4 zero-tolerance; grouped rollback |
| A scar rule weakened or dropped | Low | **Critical** | Verbatim carriage; counted-in-ceiling so it is never trimmed to fit; byte-identical enforcement pinned at 8; hard rollback trigger; architect-only rewording |
| **Prose-pinned tests silently gutted to go green** | **High** | **High** | **M10**: every retired assertion named with its originating spec and its protected behaviour re-asserted or explicitly retired; pure-addition re-baselining only with the spec named and baseline committed together |
| Sweep misses a protocol, a tree, or a segment | High | Medium | T6 enumerates from disk; T7 twin parity; T11 segment reporting. 1252's dominant review cost was sweep-scope failure |
| >50% margin is thin (3.2 pts) | Medium | Medium | M2 ceilings are binding and M1 derived; a 50–52% landing is a HOLD with named further-cut candidates |
| A/B underpowered; subtle regression ships | Medium | Medium | Stated in the power statement; O4 binary compliance carries the protection; T13 post-merge behavioural re-measurement as a second net |
| Instrument defect #3 ships undetected | Medium | High | Principle 7; T1/T1b/T11 assert the instrument against the live resolver; M0b puts it under public review early |
| A/B costs more than the shrink saves | Medium | Low | 12 runs on backlog issues that needed doing; O5 tracks it; architect sets the pair ceiling |
| Surface re-grows after the project | High | Medium | T3 runs the ceilings in CI |
| `builder/spir-1252` deleted, losing the registry | Low | High | Registry content quoted in this project's thread; rebuilt registry committed to `main` early |

## Expert Consultation

**Date**: 2026-07-31 (round 1)
**Models Consulted**: Codex (GPT-5.6 Sol) · Claude Opus 5. *(Gemini/`agy` was not in
porch's model set for this consultation — the known `--type` review limitation, #1032/#1033.)*
**Verdicts**: both REQUEST_CHANGES, both HIGH confidence.

**Sections updated in response** (all feedback verified against source before acting):

| Finding | Raised by | Resolution |
|---|---|---|
| Ceilings stated net-of-scar while M1 is gross — incompatible | both | All ceilings restated **gross** with carriage shown per row; arithmetic rebuilt; margin disclosed |
| M0 doesn't match the resolver (per-file four-tier vs two-tier directory selection) | Codex | M0(b) + **T1b** added |
| CLAUDE.md `@import`s the hot tier (#1119); 5,815 excludes 736 always-loaded words | Claude | Current State corrected; baseline 33,519 → **34,255**; M0(d) requires fixing the script's stale comment |
| "No code reads `porch/prompts`" is false — `review-prompt-routing.test.ts:29` | Claude | **Verified and conceded**; cause (truncated grep) recorded in Current State; M6 verification method rewritten |
| ~25 prose-pinned tests block the cuts; `baked-decisions.test.ts` pure-addition diff is incompatible with 824 → ≤420 | Claude | **New criterion M10** + new risk row + Dependencies entry |
| "Gate friction" left unresolved under Critical while the A/B assumes it | both | Resolved: O1 demoted to advisory-with-tripwire, rubric scale and recording location defined, incomplete-scoring behaviour specified |
| A/B lacks contamination controls | Codex | **Contamination controls** subsection added (env pinning, arm isolation, order, recording artifact) |
| A/B should exclude issues touching surfaces under test | Claude | Added as an eligibility rule |
| Per-surface rollback independence overstated | Codex | Rewritten as **seven rollback groups** with an explicit G7 dependency rule |
| M5's inventory diff not deterministic | Codex | Recognition + normalization rules specified; committed pre-rewrite artifact |
| T3-vs-CI open question contradictory | Claude | Open question withdrawn; T3 stands |
| Template pressure conflated (porch's 4 headings vs consult type's 20) | Claude | Named separately in Current State |
| Spec dated 2026-08-01 while project date is 2026-07-31 | Codex | Corrected to **2026-07-31** throughout — the architect's messages carried UTC timestamps (`02:50Z`), local time 19:50 on 2026-07-31 |

**Not disputed.** Every round-1 finding was accepted; no rebuttal was filed. Two were
factual errors in my own Current State, both verified against source before correction.

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [ ] Expert AI Consultation Complete

## Notes

**On the irony.** A spec arguing for deletion should not be padded. This one is long because
it carries four architect-mandated designs — cut plan, A/B, scar carriage, and now a
segmented full-surface inventory — plus an instrument correction that changes the project's
headline number twice. The artifacts it produces are the short ones.

**On what this project deliberately does not do.** No prompt generator (Approach 2), no
tiering of any kind (Baked Decision 1), no porch behaviour changes, and not 1252's full
enforcement machinery — only the minimum scar-integrity check the deletion makes necessary,
plus the ceiling test that prevents re-growth. Enforcement built around a still-moving
surface is enforcement built twice.

**On the deferred decision from 1252.** The architect's pr-gate ruling was that structural
machinery is not worth carrying for a surface about to halve. That sequencing is honoured:
shrink first, then enforce what remains. T3 is the smallest useful enforcement primitive,
and it only becomes meaningful once the ceilings exist.
