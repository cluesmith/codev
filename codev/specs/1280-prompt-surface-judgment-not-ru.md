# Specification: Prompt surface — judgment-not-rules rewrite (>50% always-on reduction)

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
Per-surface WORD CEILINGS are stated here because they are the measurable
acceptance criteria. WHICH sentences get cut, in what order, over how many
phases, belongs in codev/plans/1280-prompt-surface-judgment-not-ru.md.

The record of how this spec evolved (13 findings in CMAP round 1, 9 in round 2,
none disputed) lives in codev/projects/1280-*/1280-specify-iter{1,2}-rebuttals.md
and codev/state/spir-1280_thread.md — deliberately not narrated here.
-->

## Metadata
- **ID**: spec-2026-07-31-prompt-surface-judgment-not-rules
- **Status**: draft (compressed; CMAP rounds 1–2 incorporated)
- **Created**: 2026-07-31
- **Issue**: #1280
- **Protocol**: SPIR

## Clarifying Questions Asked

Issue #1280 carries a complete charter, so no clarifying questions were put to the architect
before drafting. Four were resolved against the repository or by architect ruling:

1. **What is the always-on surface, as served?** — Read the live composition path
   (`commands/porch/prompts.ts`, `lib/skeleton.ts`, `lib/managed-block.ts`,
   `agent-farm/commands/spawn-worktree.ts`) and measured this builder's own served artifacts
   (`.builder-prompt.txt` 4,921w, `.builder-role.md` 1,837w). See **Inventory**.
2. **Is the committed measurement script fit to score this project?** — No; three defects, one
   disqualifying. Criterion **M0**; architect verified against source and endorsed.
3. **How wide is the rewrite target?** — Architect scope directive: the **entire** prompt
   surface — architect roles, builder roles and spawn wrappers, consultant/CMAP prompts, phase
   prompts and their template includes, `protocol.md` texts — with the instrument **segmented
   by audience** so a cut in one segment masking growth in another stays visible.
4. **Where are the eight ratified scar rules?** — Recovered verbatim from
   `builder/spir-1252:codev/resources/scar-rules.yaml`.

## Problem Statement

A Codev builder consumes **34,255 served always-on words** before reading a line of the code it
was spawned to change. Almost none is information it could not derive; it is *process
narration* — recipes for how to be an agent, written when the fleet could not be trusted to
infer them.

Spec 1252 proved the obvious remedy fails: deduplication yields **−7.0%**, because the surface
is not duplicated, it is **over-instructed**. Three compounding costs:

1. **It crowds out judgment.** A model given a 3,703-word procedure follows the procedure;
   given a 700-word contract and a goal, it reasons about the goal. Anthropic's published
   account of the Claude-5-generation rewrite reports >80% of Claude Code's system prompt
   deleted with no measurable performance loss.
2. **Nobody reads it, so it rots.** 1252 found the *served* SPIR builder prompt had silently
   lost its entire `Verify Phase` section, with a detector reporting the drift, unread, for
   months. A surface too large to read is too large to maintain.
3. **It makes its own success unmeasurable.** The committed script scores a directory the
   runtime never loads.

Deletion on judgment-trust grounds was an explicit **Non-goal** of Spec 1252.

### Principle: the instrument is part of the deliverable

This is the second measurement defect in the 1252 lineage — the first being that 1252
originally shipped with no measurement plan at all, caught at a human gate, not by CMAP.
Neither was found by reading the instrument's code; both by asking *what does this claim to
measure, and does it?*

> **The instrument is part of the deliverable, and instruments get reviewed against what they
> claim to measure — not merely against whether they run.** A measurement script, check, or
> baseline artifact is subject to the same adversarial review as the feature it scores.
> "Deterministic and committed" is not "correct."

Load-bearing here because this project's headline criterion is a number one shell script emits.
It is why **M0 precedes M1**, why **M0c** exists (an always-on metric cannot tell deletion from
relocation), and why **M5** inventories prompt text rather than the config files this project
does not touch.

## Current State

### Inventory — every prompt-bearing surface, by audience

Served and expanded words (`{{> …}}` includes resolved `codev/` → `codev-skeleton/`), captured
2026-07-31 at `047f92f7`.

**SHARED — every agent in this repo**

| Surface | Words | How served |
|---|---:|---|
| `CLAUDE.md` | 5,815 | session, harness auto-load |
| ↳ `@codev/resources/arch-critical.md` | 416 | **transcluded at session launch** (#1119) |
| ↳ `@codev/resources/lessons-critical.md` | 320 | same |
| `AGENTS.md` | 5,815 | byte-identical twin; one loads per session, never both |

**Session shared total: 6,551.**

**ARCHITECT** — `roles/architect.md` 2,048 (read at `arch-init`, every session);
`.claude/skills/*/SKILL.md` ×10 = 6,672 (on-demand — progressive disclosure working as
intended).

**BUILDER — spawn, once per builder**

| Surface | Words | | Surface | Words |
|---|---:|---|---|---:|
| `roles/builder.md` (inlined) | 1,837 | | `protocols/pir/protocol.md` | 2,066 |
| `protocols/spir/protocol.md` | 3,703 | | `protocols/maintain/protocol.md` | 1,949 |
| `protocols/spir/builder-prompt.md` | 824 | | `protocols/release/protocol.md` | 1,626 |
| `protocols/pir/builder-prompt.md` | 898 | | `protocols/research/protocol.md` | 1,278 |
| `protocols/aspir/builder-prompt.md` | 820 | | `protocols/experiment/protocol.md` | 1,023 |
| `protocols/research/builder-prompt.md` | 556 | | `protocols/spike/protocol.md` | 920 |
| `protocols/air/builder-prompt.md` | 537 | | `protocols/aspir/protocol.md` | 810 |
| `protocols/experiment/builder-prompt.md` | 472 | | `protocols/bugfix/protocol.md` | 699 |
| `protocols/bugfix/builder-prompt.md` | 429 | | `protocols/air/protocol.md` | 643 |
| `protocols/spike/builder-prompt.md` | 400 | | `protocols/maintain/builder-prompt.md` | 374 |

**SPIR builder spawn total: 6,364** (role 1,837 + wrapper 824 + protocol 3,703).

**PHASE — per porch task delivery, ×I.** Hot tier (736) rides on *every* phase prompt.

| Protocol | Prompts (expanded) | Mean |
|---|---|---:|
| spir / aspir | specify 1,402 · plan 1,169 · implement 1,065 · review 1,957 | **1,398** |
| pir | review 2,414 · implement 1,151 · plan 741 | 1,435 |
| bugfix | pr 491 · fix 352 · investigate 290 | 378 |
| air | pr 471 · implement 442 | 457 |
| maintain | maintain 402 · review 310 | 356 |

**CONSULTANT — per CMAP review.** `roles/consultant.md` 252 + one consult-type: spir/aspir spec
514 · impl 421 · phase 421 · plan 406 · pr 392; bugfix pr 726 / impl 641; pir pr 475 / impl
507; air pr 455 / impl 420; maintain 421 / 392. **SPIR per review: 683.**

**DEAD** — `codev-skeleton/porch/prompts/**`, 10 files, 4,009 words, no runtime consumer.

### Buckets and audience loads are different things

**Surface buckets are exclusive** and partition the authored surface with no overlap or gap:
`SHARED` (6,551) · `ARCHITECT` (2,048) · `BUILDER_SPAWN[p]` · `PHASE[p]` · `CONSULTANT[p]` ·
`DEAD` (4,009). **Audience loads are derived** and deliberately overlap:

```
HOT                      = arch-critical + lessons-critical                    = 736
ALWAYS_ON(builder,p,I)   = SHARED + BUILDER_SPAWN[p] + I × (HOT + mean PHASE[p])
ALWAYS_ON(architect)     = SHARED + ARCHITECT
ALWAYS_ON(consultant,p)  = roles/consultant.md + mean CONSULTANT-type[p]

ALWAYS_ON_WORDS  ≡  ALWAYS_ON(builder, spir, 10)
                 =  6,551 + 6,364 + 10 × (736 + 1,398)  =  34,255      ← the headline
```

Architect load 8,599; consultant 683. `I = 10` is 1252's proxy, consistent with B4's 3.06
review rounds/project across 4–6 phases — a comparison constant, identical before and after.

Fleet-wide the consultant surface is not small: 683 × 3 models × ~10 reviews ≈ **20,500
words/project**, comparable to the entire builder load. It sits outside the headline because it
is per-review, not because it is negligible.

### Coverage is per-surface, not per-protocol × surface-type

Verified on disk: `codev/protocols/` holds **ten** protocols, `codev-skeleton/protocols/`
**nine** — `release` is project-local by design, has only `protocol.md` (1,626w, no
`protocol.json`, no `builder-prompt.md`), is human-invoked prose an agent reads, and is
therefore in scope but not porch-orchestrated. `experiment`, `research`, `spike` and `release`
have no `prompts/` or `consult-types/`; those absences are intentional.

Ceilings and sweep criteria therefore apply to **each surface that exists after resolution**,
enumerated from disk across both trees and unioned. Absence never fails a check; an
**unmeasured** present surface does.

### The measurement defects (why M0 exists)

1. **Dead directory.** `measure-prompt-surface.sh:89` derives `PORCH_PROMPT_MEAN` from
   `codev-skeleton/porch/prompts/*.md` (mean 400). The live resolver
   (`commands/porch/prompts.ts:78`, `loadPromptFile`) loads
   `protocols/<protocol>/prompts/<file>.md`, mean **1,398**. The dead tree is a Ralph-SPIR-era
   leftover ("You are the **Spec Writer** hat in a Ralph-SPIR loop").
2. **Omits the inlined role.** `spawn-worktree.ts:854` writes `roles/builder.md` to
   `.builder-role.md` for harness injection — 1,837 always-on words, uncounted.
3. **Stale hot-tier accounting.** The script's comment asserts CLAUDE.md "already inlines" the
   hot files. Since #1119 (`managed-block.ts:59-67`) it carries `@import` lines, transcluded at
   session launch, so `wc -w CLAUDE.md` **excludes** 736 always-loaded words.

Net: the reported baseline (21,702) understates the phase term ~3.5×, omits the role file, and
under-counts the session term by 736. **And the metric cannot see this project's primary
target** — cutting SPIR phase prompts 1,398 → 430 moves `ALWAYS_ON_WORDS` by exactly zero. A
>50% claim scored on it would be phantom savings.

The dead tree has no *runtime* consumer but does have a **test** consumer:
`review-prompt-routing.test.ts:29` asserts on `codev-skeleton/porch/prompts/review.md` (a Spec
987 hot/cold-routing protection). M6 handles it.

### What landed, what is deferred

On `main` from the 1252 harvest: drift reconciliation, the audit, two word baselines, the
behavioural baseline (B1 = 51.88% REQUEST_CHANGES, n=160, self-excluded; B2 1.12 rounds/phase),
and the measurement tooling. Deferred here by architect ruling: the **scar registry and its
eight ratified wordings**, with enforcement rebuilt *after* the shrink.

Issue #1279 is partly overtaken — SPIR prompts now inline templates via `{{> …}}`, which is what
makes each phase prompt ~600 words heavier than it reads. Two *separate* constraints govern
template shape and must not be conflated: `checks.ts:149-154` (`REQUIRED_SPEC_SECTIONS`)
requires only **four** headings; the 20-heading pressure comes from the `spec-review` consult
type, advisorily.

## Desired State

**One prompt form, written for frontier models, that states contracts and trusts judgment.** A
builder's always-on context says what it owns, what artifacts it must produce and their shape,
where the human gates are, and what is irreversible — then gets out of the way. Everything else
is reachable on demand.

### Rewrite principles

1. **Contract, not recipe.** State the required outcome and its shape; delete the procedure.
2. **Interface, not example.** A heading skeleton with one line of intent per heading replaces
   an annotated template with filler prose.
3. **No worst-case padding.** Delete instructions guarding failure modes frontier models do not
   exhibit (all-caps prohibitions, "⚠️ BLOCKING" banners, checklists restating the body).
4. **Progressive disclosure.** How-to content moves to skills / on-demand files, addressed by
   name. Relocation is *not* deletion and is measured separately (M0c).
5. **Budgets are cheap words worth keeping.** Frontier models honour stated budgets precisely
   but never invent them; budget/scope lines are exempt from cuts.
6. **Scar rules are verbatim and exempt from rewriting** — but **counted** in ceilings.
7. **The instrument is part of the deliverable.** A ceiling not measured on served words is not
   a ceiling.

### Per-surface ceilings (GROSS — scar words count inside every ceiling)

Applied to the SPIR instance as the measured proxy and swept across every existing surface in
both trees.

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

### Post-rewrite always-on, by audience

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

No segment grows. Consultant cuts least because `roles/consultant.md` is already lean at 252 —
reported rather than averaged into the headline.

The phase term is 73% of the post-rewrite builder budget, and the **exempt** hot tier is 7,360
of the 16,016 total (46%). What survives is overwhelmingly curated judgment, not process — and
that exemption bounds how far this project can go without reopening it.

### Rollout: the corrected instrument lands on `main` first (M0b)

**No prompt-surface word is cut before the corrected instrument is on `main`.** A cut scored by
the current script is unfalsifiable, and 1252's published baselines cite dead-tree figures while
being shared knowledge other work reads.

**PR-1 (early, standalone) contains exactly:**

| In | Out (deliberately) |
|---|---|
| Corrected `measure-prompt-surface.sh` — all seven M0 items | Any edit to any prompt surface |
| Its tests (T1, T1b, T2, T11, T12, T15). The script has **no test at all** today, which is how three defects survived in a "committed and reproducible" instrument | The scar registry (rebuilt after the shrink, per Baked Decision 2) |
| `codev/resources/1280-word-baseline.md` — corrected, segmented pre-rewrite baseline (34,255) | The dead-tree deletion (has a test consumer → M10 governance) |
| In-place annotation of `1252-word-baseline.md` and `1252-word-after-phase7.md`: originals **preserved**, marked superseded, reason + pointer | Re-derivation of 1252's behavioural baseline (B1 stands; M8 re-runs post-merge) |

**Timing**: end of the first implement phase — instrument correct and tested, before any cut.
**Verified safe**: no test asserts on either 1252 word-count artifact (the frozen-sample test at
`prompt-behavior-metrics.test.ts:184` pins the *behavioural* sample, a different instrument), so
the annotation carries no re-baselining cost.

The one argument against early landing — that the corrected baseline is meaningful only
alongside the cuts it scores — fails: the baseline's value is precisely that it is *pre-cut*,
and publishing it early is what makes the eventual −53.2% claim checkable by someone who did not
watch it being produced.

### Scar-rule carriage plan

The eight rules ratified 2026-07-28 ship **verbatim** (~188 words of canonical text):
`git-add-explicit`, `never-destroy-worktrees`, `no-destructive-git`, `human-gates`,
`no-hand-edit-status`, `afx-from-root`, `shellper-verified-orphan`, `tower-restart-permission`.

- The registry is **rebuilt after the shrink** — each rule's `must_appear_on` re-derived against
  the post-rewrite surface, since most 1252-listed files will be rewritten or deleted.
- Carriage is **exempt from rewriting but counted in ceilings**: a ceiling a surface cannot meet
  while carrying its scar rules is a wrong ceiling, raised deliberately — never met by trimming
  scar text.
- Enforcement is a byte-identical-presence test, pinned at 8 rules and their ids.
- A scar rule may be compressed **only by architect ratification**, never by a builder applying
  principle 1.

## Stakeholders

- **Primary Users**: builder agents; CMAP reviewer agents; architect agents.
- **Secondary Users**: humans who must read and maintain the surface (protected by M2b);
  downstream adopters receiving it via `codev update`.
- **Technical Team**: this builder; the architect at both gates.
- **Business Owners**: Waleed — ratifies scar wordings, rules on the A/B verdict and on any
  ceiling change.

## Success Criteria

- [ ] **M0 — the metric measures what is served, segmented by audience.** The corrected script
      (a) sources phase prompts from the directory `loadPromptFile` resolves; (b) resolves
      **per-file through the full four-tier chain** as `resolveCodevFile` does, not two-tier
      directory-level selection, so mixed per-file overrides measure correctly; (c) counts the
      inlined `roles/builder.md`; (d) counts hot-tier `@import` transclusion in the session term
      **and corrects the stale inlining comment**; (e) expands `{{> …}}` includes; (f) reports
      **exclusive bucket subtotals and derived audience loads separately**, per the stated
      formulas, never presenting overlapping audience figures as a sum; (g) reports **total
      authored prompt-surface words** (both trees + `.claude/skills/`) alongside always-on.
      Tests assert (a) and (b) against the real resolver.
- [ ] **M0b — the corrected instrument and baseline land on `main` early**, as a small
      standalone PR (precedent #1290), per **Desired State → Rollout**.
- [ ] **M0c — deleted words are distinguished from relocated words.** Relocation to skills
      scores identically to deletion under an always-on-only metric — the phantom-savings class
      T2 catches on the *include* axis, unmonitored on the *relocation* axis. A −53% headline is
      equally consistent with −30% deleted + −23% relocated, and only deleted content satisfies
      Problem Statement claim 1. The review **decomposes the always-on reduction into deleted vs
      relocated**, evidenced by M0(g).
- [ ] **M1 — >50% reduction (derived, arithmetically implied by M2).** `ALWAYS_ON_WORDS` falls
      from 34,255 to **≤16,100**, measured before and after by the same corrected script, both
      figures committed; audience loads reported, none regressed. Meeting every ceiling yields
      ≤16,016 (−53.2%), so M1 cannot fail while M2 passes — but it clears >50% by only **3.2
      points ≈ 1,100 words**, so no ceiling has slack to give away. The reachable contingency is
      **denominator movement**: if correcting the instrument surfaces always-on content not yet
      found, the baseline and every ceiling are re-derived to preserve >50%, and that
      re-derivation goes to the architect rather than being absorbed silently.
- [ ] **M2 — per-surface ceilings met (binding).** Every ceiling, **gross**, on **every surface
      existing after resolution**, enumerated from disk across both trees and unioned. Absence
      never fails; an unmeasured present surface does.
- [ ] **M2b — CLAUDE.md stays human-readable.** At 5,815 → ≤1,900 the rewritten file must retain
      a navigable heading structure and be reviewed by the architect for human usability at the
      gate — twin-parity bytes are not a readability check.
- [ ] **M3 — sweep completeness.** Surfaces enumerated from disk (both trees, unioned), never a
      hardcoded list; no surface retains pre-rewrite content. Includes
      `codev/protocols/release/protocol.md` (1,626w), which has no skeleton twin.
- [ ] **M4 — scar rules intact.** Eight canonicals byte-identical on every registered surface;
      test fails on reword or deletion; count pinned at 8.
- [ ] **M5 — no capability lost, proven against the prompt text.** A committed
      `capability-inventory.json` extracted pre-rewrite with explicit recognition rules —
      artifact paths (`codev/(specs|plans|reviews)/…` literals and `{{artifact_name}}` forms),
      gate names, signal names (`<signal …>` tags), porch check names, notification triggers —
      normalized (lowercase, strip backticks/punctuation, dedupe).

      **The inventory is over the resolved, expanded prompt surface, not over `protocol.json` or
      source call sites.** Extracting gate and check names from an unchanged `protocol.json`, or
      notifications from unchanged `afx send` call sites, would report every capability present
      even if every corresponding instruction vanished from the served prompts. Each item must
      be evidenced as **represented in served prompt text** via a contract-presence assertion.
      This is the primary defence for the most aggressive row, `protocol.md` 3,703 → ≤700
      (−81%), the builder's only map of gates, artifacts and phases.

      **Severity**: a removal is a hard failure **unless** the retired name appears in a
      committed `codev/resources/1280-retirements.md` in the same commit, naming the capability,
      why it is obsolete, and the architect approval. Retirements will occur (M6 deletes a tree;
      `protocol.md` drops ~3,000 words), so the exception path is explicit rather than
      improvised.
- [ ] **M6 — the dead tree is gone, with its consumer handled.**
      `codev-skeleton/porch/prompts/` deleted. Verification is **not** a bare grep: an
      untruncated repo-wide search reconciled against the full hit list shows zero *runtime*
      consumers, and the one **test** consumer (`review-prompt-routing.test.ts:29`, a Spec 987
      protection) is updated under M10 naming Spec 987.
- [ ] **M7 — A/B non-inferiority passes** per the pre-registered decision rule; gates
      `verify-approval`.
- [ ] **M8 — behavioural baseline re-run.** `measure-prompt-behavior.ts` re-run and committed;
      B1 compared directionally to 51.88% (n=160) with the sample documented.
- [ ] **M9 — rollback rehearsed** by group, per **Rollback Plan**.
- [ ] **M10 — prose-pinned test re-baselining is deliberate and enumerated.** ~25 test files
      assert exact prose in the surfaces being cut; the hardest is
      `agent-farm/__tests__/baked-decisions.test.ts:143-148`, enforcing a **pure-addition diff**
      against committed baselines for `protocols/{spir,aspir,air}/builder-prompt.md` —
      incompatible with 824 → ≤420. Also `bugfix-744-spir-pr-strategy.test.ts`,
      `spec-1273-wait-discipline-docs.test.ts`, `bugfix-619-aspir-prompt.test.ts`,
      `template-delivery.test.ts`, `framework-ref-audit.test.ts`, `governance-sweep.test.ts`,
      `review-prompt-routing.test.ts`. **Each assertion is a prior spec's protection encoded as a
      grep, so retiring one is a governance act.** Every modified or retired assertion is listed
      in the review with (i) the originating spec, (ii) whether the protected behaviour survives
      in the rewritten prose, (iii) the replacement assertion, or an explicit architect-visible
      retirement. Pure-addition re-baselining only with the originating spec named and the new
      baseline committed in the same commit. Silent deletion to make the suite green is a
      project failure, not a test fix.
- [ ] All tests pass **after M10's enumerated re-baselining**; no coverage reduction. New tests
      cover M0, M3, M4, M5.
- [ ] Documentation routed by tier; `CLAUDE.md`/`AGENTS.md` byte-identical.

## Constraints

### Technical Constraints

Verbatim from issue #1280's **Baked Decisions** — fixed, not re-litigated by this spec, the
plan, or CMAP reviewers:

- **All prompt consumers are frontier models** (Claude 5, GPT 5.6, Gemini 3.6 class). No
  weak-model tier, no fallback scaffolding variant, no tiering mechanism. One form.
- **Scar rules are exempt and verbatim** — the eight compressed canonicals developed in Spec
  1252 Phase 5 (six repo rules + shellper verified-orphan + Tower-restart permission) ship with
  the rewrite; the registry/enforcement concept from 1252 is rebuilt fit-for-purpose around the
  post-shrink surface, not before it.
- **Validation is A/B, not observational**: same issues executed by builders on old vs new
  prompts, compared on outcomes (gate friction, review rounds, correctness). Spec 1252's M12
  established that observational baselines (n=17) can only detect large regressions —
  insufficient at deletion scale. The A/B design is a first-class spec section.
- Spec must define a rollback story (prompt surfaces are files; reverting is cheap — say so
  concretely).

Arising from the repository and the scope directive:

- **Scope is the full prompt surface, segmented**; measurement reports per-segment.
- **Both trees**; `CLAUDE.md` ≡ `AGENTS.md`.
- **Four-tier resolution, per file.** No fetch-by-path instruction for a file that may not exist
  on disk (deliver-don't-fetch).
- **No porch behaviour changes** — content rewrite plus a measurement-script fix.
- **Template shape is governed by two separate constraints** (porch's 4 headings; the consult
  type's advisory 20) which must not be conflated.

### Business Constraints

- Two human gates (`spec-approval`, `plan-approval`) plus `pr`; the A/B verdict is the
  architect's call.
- Adopters consume the skeleton via `codev update`, so rollback is a revertible unit per
  **group**.
- Scar wordings are architect-ratified; a builder may not compress them.
- **The corrected instrument ships early, as its own PR** (M0b); remaining phase-commits ship as
  a single later PR.

## Assumptions

- The eight scar wordings on `builder/spir-1252` remain the ratified set.
- `I = 10` remains the agreed proxy — a comparison constant, identical both sides.
- Frontier-model behaviour is stable across the A/B window (mitigated by pairing, same base
  commit, pinned model/config versions).
- `builder/spir-1252` stays undeleted — sole source of the ratified registry.
- CMAP reviewers are blind to the builder's prompt surface by construction.

## Solution Approaches

### Approach 1: In-place judgment rewrite, surface by surface (RECOMMENDED)

Rewrite each file to the seven principles, keeping file layout, resolver and porch untouched.
Templates become heading interfaces; how-to content relocates to skills; the dead tree goes; the
instrument is corrected first.

**Pros**: zero mechanism risk; every change a reviewable text diff; rollback granularity equals
cut granularity; compatible with deliver-don't-fetch.
**Cons**: discipline-dependent (mitigated by T3); large diff across 10 protocols × 2 trees, so
sweep completeness is the main risk; collides with ~25 prose-pinned test files (M10).
**Complexity**: Medium · **Risk**: Low-Medium

### Approach 2: Generate prompts from `protocol.json`

Synthesize phase prompts at runtime from the state machine, with a small per-phase prose delta.

**Pros**: structurally prevents re-growth and drift; would have made the 1252 drift bug
impossible.
**Cons**: introduces a code path between authoring and serving — new failure mode, harder to
review and revert — and changes porch behaviour (an explicit constraint). Couples the shrink to
a mechanism change, making any A/B regression un-attributable: deletion or generator?
**Complexity**: High · **Risk**: Medium-High
**Verdict**: right idea, wrong project; a plausible successor over a 16,000-word surface.

### Approach 3: Shared kernel + per-protocol deltas

One protocol-agnostic builder kernel included by every protocol, plus a short per-protocol delta.

**Pros**: attacks cross-protocol duplication the per-surface table does not; uses the existing
include mechanism, so it is served-word-honest.
**Cons**: 1252 proved dedup buys ~7% on *served* words — an include expands, so moving text
changes ownership, not the bill. Risks re-creating the shadow-tree bug class.
**Verdict**: adopt selectively *inside* Approach 1 where a kernel reduces served words for the
reader, and only after the shrink.

## Open Questions

### Critical (Blocks Progress)

*None outstanding.* Both former Critical questions are resolved: the corrected baseline is
architect-endorsed; and gate friction (not minable from history — no `rejected` state,
`requested_at` overwritten) is scored prospectively by the architect and demoted to
**advisory-with-a-tripwire**, so incomplete scoring cannot block the decision.

### Important (Affects Design)

- [ ] **A/B sample size.** ≥6 pairs specified; more buys power at real builder and consult cost
      (~$1,478/30d at current rates). The architect sets the ceiling — see architect load under
      **Execution and sequencing**.
- [ ] **Do SPIR templates survive as interfaces, or disappear?** Recommendation: survive as
      ≤150-word heading interfaces — porch requires only 4 headings, but the interface is what
      makes the artifact contract legible without narration.
- [ ] **Is the hot tier's 736 genuinely exempt?** It is the one surface already built to these
      principles, but it is 7,360 of the 16,016-word post-rewrite builder budget (46%), so it
      bounds how far this project can go without reopening the exemption.
- [ ] **`roles/architect.md` 2,048 → ≤700** — the architect segment was outside 1252's analysis
      entirely. Confirm nothing in it is load-bearing for multi-architect coordination (Specs
      755/786/823) before cutting.

### Nice-to-Know (Optimization)

- [ ] Does trimming consult-type prompts move CMAP verdict *quality*, or only cost?
- [ ] Are the ~17,000 words of `.claude/skills/` the right destination for relocated how-tos, or
      does that surface need its own budget?

## Performance Requirements

- **Builder always-on**: ≤16,100 words (from 34,255) — M1.
- **Per-segment**: architect ≤3,400 (from 8,599); consultant ≤460 (from 683); none regresses.
- **Per-surface ceilings**: as tabulated — M2, binding.
- **Measurement runtime**: <5s, deterministic — same commit ⇒ byte-identical output.
- **Token/cost effect** (advisory): ~18,200 fewer always-on words ≈ ~24,000 tokens per
  builder-project; recorded before/after, keying no threshold.

## Security Considerations

- **The scar rules are the security surface.** All eight guard irreversible acts (destroying
  uncommitted work or worktrees, killing live sessions, bypassing a human gate). Weakening one is
  the highest-severity failure this project can produce — hence verbatim carriage,
  byte-identical enforcement, counted-not-exempt ceilings, and a hard rollback trigger on any
  observed violation.
- **Human-gate integrity.** The rewrite must not weaken "a gate message is a notification to the
  human, not authorization." Gate semantics are content, and this project edits content.
- **No secrets in prompt surfaces** — existing property, re-verified after the rewrite.
- **Adopter blast radius.** Skeleton changes ship on `codev update`; a weakened prohibition
  propagates silently. Hence grouped, rehearsed rollback.

## Test Scenarios

### Functional Tests

1. **T1 — Instrument sources the served directory** (M0 item a). Asserted against the real
   resolver, not a hardcoded string.
2. **T1b — Instrument resolves per-file, four-tier** (M0 item b). A fixture with a `.codev/`
   override of *one* prompt while others resolve from the skeleton measures each file at its
   winning tier — kills the directory-level-selection defect class.
3. **T2 — Include expansion (phantom-savings proof).** Moving text from prompt into template
   produces **zero** change in the reported total.
4. **T3 — Ceilings (M1/M2).** Each surface at or under its gross ceiling, per protocol, per
   tree; failure names surface and overage. Runs in CI as the anti-re-growth guard.
5. **T4 — Scar integrity (M4).** Every canonical byte-identical on every registered surface;
   count pinned at 8; reword or deletion fails.
6. **T5 — Capability inventory (M5).** Post-rewrite extraction over served prompt text ⊇
   pre-rewrite, using M5's recognition and normalization rules; unlisted removals fail.
7. **T6 — Sweep completeness (M3).** Surfaces enumerated from disk across both trees and
   unioned; each existing surface satisfies T3. Absence of `prompts/`/`consult-types/` for a
   protocol that has none must **not** fail; a newly added protocol or surface fails until
   written to budget. Covers `release` (`codev/` only).
8. **T7 — Twin parity.** `CLAUDE.md` ≡ `AGENTS.md`; `codev/` and `codev-skeleton/` copies
   consistent.
9. **T8 — Dead-tree removal (M6).** Tree absent; no runtime reference; the Spec 987 routing test
   updated per M10 and still protecting hot/cold routing on its remaining files.
10. **T9 — Live spawn probe.** A builder spawned end-to-end on the rewritten surface receives a
    spawn prompt containing every element of the artifact contract, and its first `porch next`
    returns a well-formed task. ("It compiled" is not "it works.")
11. **T10 — Rollback rehearsal (M9).** Reverting a rollback **group** on a scratch branch
    restores that group byte-for-byte and leaves the suite green.
12. **T11 — Bucket and audience reporting** (M0 item f). The script emits the six **exclusive
    bucket** subtotals, which sum to the authored total, *and separately* the derived audience
    loads, which overlap by design and are asserted against the stated formulas rather than a
    naive sum. A fixture where one bucket grows and another shrinks shows both movements, not a
    netted zero.
13. **T15 — Relocation visibility (M0c).** A fixture moving a block from an always-on surface
    into `.claude/skills/` shows always-on falling **and** total-authored holding steady — so
    relocation can never be reported as deletion.

### Non-Functional Tests

1. **T12 — Determinism.** Two runs at the same commit emit byte-identical output.
2. **T13 — Behavioural re-measurement (M8).** `measure-prompt-behavior.ts` re-run post-merge
   with self-exclusion; B1/B2/B4 committed and compared directionally.
3. **T14 — A/B execution (M7).** The full pre-registered protocol below.

## A/B Validation Design

*(First-class section per Baked Decision 3. A **non-inferiority** trial: the claim under test is
"deleting ~53% of the always-on surface does not degrade outcomes", not "it improves them".)*

### Unit and arms

The unit is an **issue-pair**: one GitHub issue executed twice, by two freshly-spawned builders
in separate worktrees, from the same base commit. **Control (A)** = pre-rewrite commit;
**treatment (B)** = post-rewrite. No code differs — the prompt surface is file-resolved, so the
arms are two checkouts.

### Sample and eligibility

- **≥6 pairs (12 runs)**, stratified: ≥3 SPIR/ASPIR (exercises spec/plan/implement/review
  prompts, both gates, templates) and ≥3 lighter protocols (BUGFIX/AIR).
- Issues drawn from the backlog, selected **before** either arm runs, then frozen.
- **Eligibility exclusion**: an issue is ineligible if it modifies any surface under test —
  otherwise the treatment arm's prompt surface is simultaneously instrument and subject.

### Contamination controls

- **Pin the environment**: model ids and reasoning efforts, consult backend versions, and
  `.codev/config.json` frozen for the trial window and recorded with the results.
- **Arm isolation**: the second arm of a pair must not see the first arm's branch, PR, or thread.
  Sequential with the intervening branch unpushed, or concurrent in isolated worktrees; which was
  used is recorded per pair.
- **Arm order alternates** per pair.
- **Recording**: one committed artifact (`codev/resources/1280-ab-results.md`), a row per run —
  pair id, arm, protocol, issue, base commit, order, isolation mode, every outcome, and any
  exclusion with its reason. Post-hoc exclusions must be justified there, never silently dropped.

### Execution and sequencing

- **M7 gates `verify-approval`, not the PR merge.** The rewrite PR merges on M0–M6 and M8–M10
  plus architect review; the A/B then runs against merged `main` as treatment and a pinned
  pre-rewrite commit as control. This matches where the rollback triggers point, keeps a 12-run
  trial off the PR's critical path, and is the only ordering under which "treatment arm = what
  builders actually get" is literally true. Consequence, stated plainly: a SHIP failure means
  rolling back a merged change — which is what the grouped, rehearsed rollback plan is for.
- **Arm disposition**: the treatment arm's PR is the merge candidate; the control arm's closes
  unmerged once its outcomes are recorded (and vice versa if the treatment arm is defective on
  O3). So **~6 of 12 runs produce merged work, not 12** — the trial's real cost is 6 duplicated
  implementations plus consult spend.
- **Architect load is a scheduling dependency**: 6 pairs with ≥3 SPIR-class implies up to **~24
  gate approvals and 12 PR reviews by one person**, each SPIR gate requiring O1 rubric scoring at
  approval time. This is the trial's binding constraint and why the pair count is the architect's
  call. If capacity forces a smaller n, the consequence is stated in the power paragraph — not a
  quietly reduced sample.

### Pre-registered outcomes

| ID | Outcome | Instrument | Role |
|---|---|---|---|
| **O1** | Gate friction | Architect scores each gate at approval time on a 3-item rubric — *artifact complete as specified? / rework required before approval? / clarifying message needed?* — each 0 (none) / 1 (minor) / 2 (blocking), recorded at scoring time | advisory + tripwire |
| **O2** | Review rounds | Iterations to terminal state per phase from `status.yaml`; CMAP REQUEST_CHANGES rate (comparable to B1 = 51.88%) | gate |
| **O3** | Correctness | **At the SHIP decision**: architect PR-review findings by severity, observable pre-merge on both arms. **Post-merge defects are excluded from the SHIP gate** — they cannot be evaluated when the decision is made — and act as a **14-day rollback signal** after the merged arm lands | gate (pre-merge) + rollback signal (post-merge) |
| **O4** | Protocol compliance | Binary per-run checklist: required artifacts with required headings · stopped at every human gate · no `status.yaml` hand-edit · no `git add -A` · no scar violation · thread committed | **zero tolerance** |
| **O5** | Cost & duration | Tokens, wall-clock, `consult stats` delta | advisory |

### Blinding

CMAP reviewers are blind by construction. The architect is not and cannot be; mitigations: O2 and
O4 are extracted mechanically from committed artifacts, and O1/O3 are scored against a rubric
written **before** any run.

### Decision rule (pre-registered)

**SHIP** iff all of:

1. **O4 = zero violations** in the treatment arm. Any scar violation, skipped gate, or missing
   required artifact is an immediate hard stop, independent of everything else.
2. **O2**: treatment mean review rounds ≤ control **+ 0.5 rounds/phase**, and treatment
   REQUEST_CHANGES rate ≤ control **+ 10 percentage points**.
3. **O3 (pre-merge part only)**: no treatment-arm finding of severity ≥ "would block merge"
   absent from its paired control run.
4. **O1 tripwire**: no pair where the treatment arm scored **2 (blocking)** at a gate its control
   scored 0, for the same reason. If O1 scoring is incomplete for any pair, O1 reports incomplete
   and SHIP rests on 1–3.

Otherwise **HOLD** (fix and re-run the failing pairs) or **ROLLBACK**.

### Honest power statement

With n=6 pairs this detects only **large** effects — roughly a doubling of review rounds or a
≥20-point REQUEST_CHANGES shift. It cannot certify the absence of a subtle regression, and this
spec does not claim it can. It is nonetheless strictly stronger than 1252's observational
baseline, because each pair is matched on the issue itself — the dominant variance source.
**O4's zero-tolerance criterion is where the real protection lives**: compliance is binary,
observable in every run, and is the failure mode deletion would plausibly cause.

## Rollback Plan

Prompts, included templates, registry mappings and integrity tests are coupled, so rollback is by
**group** — each internally consistent and independently revertible:

| Group | Contents |
|---|---|
| **G1 instrument** | measurement script + its tests + baseline artifacts |
| **G2 shared** | `CLAUDE.md` + `AGENTS.md` + hot-tier wiring |
| **G3 builder-spawn** | `roles/builder.md` + all `builder-prompt.md` + all `protocol.md` + their prose-pinned tests |
| **G4 phase** | all `prompts/*.md` + their `templates/*.md` + porch check expectations |
| **G5 consultant** | `roles/consultant.md` + all `consult-types/*.md` |
| **G6 architect** | `roles/architect.md` + relocated skill content |
| **G7 scar registry** | `scar-rules.yaml` + its enforcement test |

- **Dependency rule**: reverting **G7** requires reverting every group carrying scar text (G2,
  G3, G4, G6) — registry and copies must agree. All other groups are mutually independent.
- **Mechanism**: `git revert` restores prior bytes. No migration, state, schema, or data.
  Rehearsed under T10 before the PR merges.
- **Blast radius**: effective for the next spawned builder — in-flight builders keep the surface
  they were spawned with (prompts read at spawn/phase time). For adopters the revert ships in the
  next release; an adopter can also pin the prior `@cluesmith/codev` version.
- **Triggers**: (a) any O4 violation — immediate, no deliberation; (b) an observed scar violation
  in any real project post-merge; (c) O2/O3 outside pre-registered margins; (d) the 14-day
  post-merge O3 window; (e) architect judgment at the `pr` or `verify-approval` gate.
- **Partial rollback is the expected shape** — revert the offending group, keep the rest.
- **Cost**: one revert, one release. No irreversible step exists anywhere in this project.

## Dependencies

- **External Services**: none. (`gh` for issue/PR reads during the A/B; consult backends
  unchanged.)
- **Internal Systems**: four-tier resolver (`lib/skeleton.ts`); porch prompt composition
  (`commands/porch/prompts.ts`) — read, not modified; managed-block hot-tier wiring
  (`lib/managed-block.ts`); role injection (`agent-farm/commands/spawn-worktree.ts`);
  consult-type resolution (`commands/consult/index.ts`); both measurement scripts.
- **Artifacts**: `builder/spir-1252` (ratified registry — must not be deleted);
  `codev/resources/1252-*.md` baselines.
- **Test suites**: the ~25 prose-pinned files in M10 — a dependency in the real sense that the
  cuts cannot land without deliberately re-baselining them.
- **Libraries/Frameworks**: none new.

## References

- Issue #1280 (charter); #1279 (dead spec/review templates); #1276, #1277 (filed by 1252 —
  superseded here or out of scope); #1032/#1033 (agy `--type` review limitation).
- PR #1278 (Spec 1252, closed unmerged) and `builder/spir-1252`; PR #1290 (early-PR precedent).
- `codev/reviews/1252-prompt-architecture-single-own.md`; `codev/resources/1252-*.md`;
  `codev/state/spir-1252_thread.md`.
- *The new rules of context engineering for Claude-5-generation models* —
  https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models
- `codev/resources/arch.md` (four-tier resolution, include directive, hot-tier injection);
  `codev/resources/lessons-learned.md` (sweep-scope failures, served-surface dedup).

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| A deleted instruction was load-bearing; loss is silent | Medium | High | M5 inventory over served prompt text (unlisted removals fail); O4 zero-tolerance; grouped rollback |
| A scar rule weakened or dropped | Low | **Critical** | Verbatim carriage; counted-in-ceiling so it is never trimmed to fit; byte-identical enforcement pinned at 8; hard rollback trigger; architect-only rewording |
| Prose-pinned tests silently gutted to go green | **High** | **High** | M10: every retired assertion named with its originating spec and its behaviour re-asserted or explicitly retired; pure-addition re-baselining only with spec named and baseline committed together |
| Sweep misses a protocol, tree, or segment | High | Medium | T6 enumerates from disk (both trees, unioned); T7 twin parity; T11 bucket reporting. Sweep-scope failure was 1252's dominant review cost |
| Relocation reported as deletion, inflating the claim | Medium | Medium | M0c + M0(g) + T15 |
| A/B underpowered; subtle regression ships | Medium | Medium | Power statement; O4 binary compliance carries the protection; T13 post-merge behavioural re-measurement as a second net |
| A further instrument defect ships undetected | Medium | High | Principle 7; T1/T1b/T11/T15 assert the instrument against the live resolver; M0b puts it under public review early; the script gets its first tests |
| A/B costs more than the shrink saves | Medium | Low | ~6 of 12 runs produce merged work; O5 tracks it; architect sets the pair ceiling |
| Architect review capacity is the trial's bottleneck | High | Medium | Load stated explicitly (~24 gates + 12 PR reviews); pair count is the architect's call; smaller n reported honestly in the power statement |
| Surface re-grows after the project | High | Medium | T3 runs the ceilings in CI |
| `builder/spir-1252` deleted, losing the registry | Low | High | Registry content quoted in this project's thread; rebuilt registry committed to `main` early |

## Expert Consultation

**Round 1** — 2026-07-31 · Codex (GPT-5.6 Sol) + Claude Opus 5 · both REQUEST_CHANGES (HIGH) ·
**13 findings, none disputed**.
**Round 2** — 2026-07-31, architect-directed re-review of the revision · same models · both
REQUEST_CHANGES (HIGH) · **9 findings, none disputed**.

Every finding was verified against source (and both arithmetic claims independently recomputed)
before acceptance; all are folded into the criteria, tests, and design sections above rather than
narrated here. The finding-by-finding record is in
`codev/projects/1280-prompt-surface-judgment-not-ru/1280-specify-iter{1,2}-rebuttals.md`.

Four of the corrections were errors in this spec's own analysis, three sharing a single root
cause — **enumerating from a convenient source instead of the authoritative one** (a truncated
grep; skeleton-only protocol enumeration; the measurement script's stale comment). That is the
sweep-scope class 1252 named as its dominant review cost, and it is why M3's "enumerate from
disk" is specified as a **test** rather than an instruction.

Gemini/`agy` did not participate: the known `--type` review limitation (#1032/#1033). Per current
lane policy this 2-way review is correct and needs no remedy.

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [ ] Expert AI Consultation Complete

## Notes

**What this project deliberately does not do.** No prompt generator (Approach 2), no tiering of
any kind (Baked Decision 1), no porch behaviour changes, and not 1252's full enforcement
machinery — only the minimum scar-integrity check the deletion makes necessary, plus the ceiling
test that prevents re-growth. Enforcement built around a still-moving surface is enforcement
built twice.

**On the deferred decision from 1252.** The architect's pr-gate ruling was that structural
machinery is not worth carrying for a surface about to halve. That sequencing is honoured: shrink
first, then enforce what remains. T3 is the smallest useful enforcement primitive, and it only
becomes meaningful once the ceilings exist.
