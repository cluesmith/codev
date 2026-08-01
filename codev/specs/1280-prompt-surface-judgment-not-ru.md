# Specification: Prompt surface — judgment-not-rules rewrite (>50% always-on reduction)

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
Per-surface WORD TARGETS are stated here because they are the measurable
acceptance criteria. WHICH sentences get cut, in what order, over how many
phases, belongs in codev/plans/1280-prompt-surface-judgment-not-ru.md.
-->

## Metadata
- **ID**: spec-2026-07-31-prompt-surface-judgment-not-rules
- **Status**: draft
- **Created**: 2026-07-31
- **Issue**: #1280
- **Protocol**: SPIR

## Clarifying Questions Asked

Issue #1280 carries a complete charter (goal, attack order, four Baked Decisions,
required prior art). Per the specify-phase rule, no clarifying questions were put to
the architect. Three questions were resolved against the repository instead:

1. **"What exactly is the always-on surface, as served?"** — Resolved by reading the
   live composition path (`packages/codev/src/commands/porch/prompts.ts`,
   `packages/codev/src/lib/skeleton.ts`) and by measuring this builder's own served
   spawn artifacts (`.builder-prompt.txt` 4,921w, `.builder-role.md` 1,837w). See
   **Current State**.

2. **"Is the committed measurement script fit to score this project?"** — No. It
   measures a directory no code reads, and is blind to the project's largest target.
   Finding and consequences in **Current State**; correction is criterion **M0**.
   Raised with the architect via `afx send` on 2026-07-31 (non-blocking).

3. **"Where are the eight ratified scar rules?"** — Recovered verbatim from
   `builder/spir-1252:codev/resources/scar-rules.yaml` (the preserved reference
   branch). Carriage plan in **Desired State**.

## Problem Statement

A Codev builder consumes **~33,500 served always-on words** before it reads a single
line of the code it was spawned to change (corrected measurement, below). Almost none
of that is information the builder cannot derive; it is *process narration* — recipes
for how to be an agent, written when the fleet could not be trusted to infer them.

Spec 1252 measured the surface and proved the obvious remedy does not work:
deduplication yields **−7.0%** (21,856 → 20,324 on its own proxy), because the surface
is not duplicated, it is **over-instructed**. Its review states the conclusion plainly —
the largest remaining block is single-owned prose.

Over-instruction is not merely a token bill. It has three compounding costs:

1. **It crowds out judgment.** A frontier model given a 3,700-word procedure follows
   the procedure. Given a 700-word contract and a goal, it reasons about the goal.
   Anthropic's published account of the Claude-5-generation rewrite reports >80% of
   Claude Code's system prompt deleted with no measurable performance loss, by
   replacing rules with judgment, deleting worst-case padding, designing interfaces
   instead of examples, and using progressive disclosure.
2. **Nobody reads it, so it rots unnoticed.** 1252 found the *served* SPIR builder
   prompt had silently lost its entire `Verify Phase` section, and a detector had been
   reporting the drift, unread, for months. A surface too large to read is a surface
   too large to maintain.
3. **It makes its own success unmeasurable.** The committed measurement script scores
   a directory the runtime never loads (below). Nothing about the prompts a builder
   actually receives has been under measurement.

The blog operation — deletion on judgment-trust grounds — was an explicit **Non-goal**
of Spec 1252 and has never been attempted in this repo.

### The instrument is part of the deliverable

This is the **second** measurement defect in the 1252 lineage. The first: Spec 1252
originally shipped with no measurement plan at all — caught at a human gate, not by
CMAP. The second is the one this spec documents below: a committed, tested, reproducible
script that measures the wrong directory, so its numbers are precise and wrong. Neither
defect was caught by reading the instrument's code; both were caught by asking *what
does this claim to measure, and does it?*

Hence an explicit project principle, adopted at the architect's direction and binding on
every criterion in this spec:

> **The instrument is part of the deliverable, and instruments get reviewed against what
> they claim to measure — not merely against whether they run.** A measurement script,
> a check, or a baseline artifact is subject to the same adversarial review as the
> feature it scores. "Deterministic and committed" is not "correct."

It is load-bearing here in a way it was not for 1252: this project's headline success
criterion is a number that one shell script emits. Discovering — *before* writing the
spec — that the metric was structurally blind to the project's own largest target is the
correct order of operations, and it is the reason M0 precedes M1.

## Current State

### How the always-on surface is composed

| Stage | Content | Served words |
|---|---|---:|
| Session | `CLAUDE.md` (hot tier inlined) — `AGENTS.md` is the byte-identical twin, one loads per session | 5,815 |
| Spawn (once) | `protocols/spir/builder-prompt.md` (824) + inlined `protocols/spir/protocol.md` (3,703) + inlined `roles/builder.md` (1,837) | 6,364 |
| Every phase task (×I) | hot tier (`arch-critical.md` 416 + `lessons-critical.md` 320 = 736) + the resolved phase prompt **with its `{{> templates/…}}` includes expanded** (mean 1,398) | 2,134 each |

With `I = 10` phase-task deliveries (the proxy 1252 fixed, consistent with B4's mean of
3.06 review rounds/project across ~4–6 phases):

```
  CLAUDE.md          5,815
+ spawn              6,364
+ phase task ×10    21,340
  ----------------------
  ALWAYS_ON         33,519
```

Per-prompt detail (SPIR, expanded): `specify` 1,402 · `plan` 1,169 · `implement` 1,065
· `review` 1,957. Templates pulled in by those prompts: `spec.md` 632 · `plan.md` 649 ·
`review.md` 641. Reviewer-side (not in the builder's total, and unmeasured today):
`consult-types/*.md`, 5 files, 2,154w.

The same disease is present in every other protocol shipped from the skeleton
(`aspir` prompts 3,671 · `pir` prompts 4,306 · `pir/protocol.md` 2,066 ·
`maintain/protocol.md` 1,765 · per-protocol `consult-types` 813–2,154).

### The measurement defect (why M0 exists)

`scripts/measure-prompt-surface.sh` derives `PORCH_PROMPT_MEAN` from
`codev-skeleton/porch/prompts/*.md` — 10 files, mean 400 words. The live resolver
(`porch/prompts.ts`, `loadPromptFile`) loads `protocols/<protocol>/prompts/<file>.md`,
a different tree. A repo-wide grep (excluding `node_modules`, `dist`, `.git`) finds no
code reading `porch/prompts`; every hit is historical spec/plan prose. The tree is a
Ralph-SPIR-era leftover — its `specify.md` opens *"You are the **Spec Writer** hat in a
Ralph-SPIR loop."* It is dead authored surface.

Two consequences, both disqualifying for this project:

- The reported baseline (21,702 on today's `main`) understates the phase-task term by
  ~3.5× and omits `roles/builder.md` entirely.
- **The metric cannot see this project's primary target.** Cutting the SPIR phase
  prompts from 1,398 to 450 words moves `ALWAYS_ON_WORDS` by exactly zero under the
  current script. A >50% claim scored on it would be phantom savings — the precise
  failure mode 1252 built the script to prevent.

### What already landed, and what is deferred

On `main` (the 1252 harvest): the drift reconciliation, the audit, the two word
baselines, the behavioural baseline (B1 = 51.88% REQUEST_CHANGES, n=160, self-excluded),
and the measurement tooling. Deferred to this project by the architect's pr-gate ruling:
the **scar registry and its eight ratified rule wordings**, and enforcement rebuilt
*after* the shrink rather than before it.

Issue #1279 (dead spec/review templates) is partially overtaken by events — the SPIR
prompts now inline their templates via `{{> …}}` includes. That wiring is exactly what
makes each phase prompt ~600 words heavier than it reads, so the template question is
in scope here: an annotated 632-word template is the "examples instead of interfaces"
anti-pattern the rewrite exists to remove.

## Desired State

**One prompt form, written for frontier models, that states contracts and trusts
judgment.** A builder's always-on context tells it: what it owns, what artifacts it
must produce and what shape they take, where the human gates are, what is
irreversible — and then gets out of the way. Everything else is reachable on demand.

### Rewrite principles (the standard every cut is judged against)

1. **Contract, not recipe.** State the required outcome and its shape. Delete the
   ordered procedure for reaching it.
2. **Interface, not example.** A heading skeleton with one line of intent per heading
   replaces an annotated template with filler prose.
3. **No worst-case padding.** Delete instructions that exist for a failure mode a
   frontier model does not exhibit (repeated all-caps prohibitions, "⚠️ BLOCKING"
   banners, checklists restating the phase body).
4. **Progressive disclosure.** How-to content that a competent agent would look up
   moves to skills / on-demand files, addressed by name, not inlined.
5. **Budgets are cheap words worth keeping.** A stated scope or budget line buys
   bounded process; frontier models honour stated budgets precisely but never invent
   them. Budget/scope lines are exempt from cuts.
6. **Scar rules are verbatim and exempt.** See carriage plan below.
7. **The instrument is part of the deliverable.** Every check, script, and baseline this
   project produces is reviewed against what it claims to measure, not merely against
   whether it runs. (Stated in full in **Problem Statement**; repeated here because it
   binds the cuts too — a word target that is not measured on served words is not a
   target.)

### Per-surface cut plan (word targets)

Targets are on **served, expanded** words, measured by the corrected script (M0).
Every target applies to the SPIR instance as the measured proxy **and is swept across
all protocols in both trees** (`codev/` and `codev-skeleton/`) — an unswept protocol is
a regression, not a deferral.

| Surface | Now | Target | What survives |
|---|---:|---:|---|
| `CLAUDE.md` / `AGENTS.md` (twins) | 5,815 | **≤2,200** | repo dual nature, four-tier resolution, gates, area-label policy, the eight scar rules verbatim, the hot-tier block. Worktree recipes, CLI walkthroughs, protocol-selection prose → skills/on-demand |
| `roles/builder.md` | 1,837 | **≤600** | ownership, gates, thread contract, notification triggers, worktree path discipline |
| `protocols/*/protocol.md` (SPIR) | 3,703 | **≤800** | state machine, phase→gate map, artifact contracts, commit/branch format, consultation checkpoints |
| `protocols/*/builder-prompt.md` (SPIR) | 824 | **≤400** | mode, spec/plan/issue wiring, baked-decisions rule, PR strategy |
| `protocols/*/prompts/*.md` expanded (SPIR mean) | 1,398 | **≤450** | goal, artifact path, heading interface, signal contract |
| hot tier (`arch-critical` + `lessons-critical`) | 736 | **736 (unchanged)** | already capped, already judgment-shaped — explicitly out of scope for cuts |
| `protocols/*/consult-types/*.md` (SPIR mean) | 431 | **≤200** | rubric dimensions + verdict contract |
| `codev-skeleton/porch/prompts/**` | 4,014 authored | **0 (deleted)** | dead tree, no consumer |

Resulting always-on total: **≤15,900 words, a ≥52% reduction from 33,519.**

```
  CLAUDE.md                     2,200
+ spawn (400 + 800 + 600)       1,800
+ phase task ×10 (736 + 450)   11,860
  ---------------------------
  ALWAYS_ON                    15,860   (−52.7%)
```

Note the shape of the arithmetic: the phase-task term is 71% of the post-rewrite budget
and the hot tier — which is *not* being cut — is 62% of that term. This is deliberate.
The always-on surface that survives is overwhelmingly curated judgment, not process.

### Scar-rule carriage plan

The eight rules ratified by the architect on 2026-07-28 (`git show
builder/spir-1252:codev/resources/scar-rules.yaml`) ship with the rewrite, **verbatim**:
`git-add-explicit`, `never-destroy-worktrees`, `no-destructive-git`, `human-gates`,
`no-hand-edit-status`, `afx-from-root`, `shellper-verified-orphan`,
`tower-restart-permission`.

- The registry file is **rebuilt fit-for-purpose after the shrink**, not carried across
  it: each rule's `must_appear_on` list is re-derived against the post-rewrite surface,
  because most of the files in the 1252 lists will have been rewritten or deleted.
- Carriage is **exempt from every word target**: ~240 words of scar text per surface
  that carries them is a floor, not a cut candidate. Targets above are net of this.
- Enforcement is a byte-identical-presence test over the registry — the minimum that
  makes a reworded copy fail the build. Nothing larger is built until the surface it
  polices has stopped moving.
- A scar rule may be **compressed only by architect ratification**, never by a builder
  applying principle 1.

### What "done" looks like operationally

A builder spawned after this lands receives a spawn prompt it can read in full, a phase
task that fits on a screen, and no instruction it would not have followed anyway. The
rollback is one `git revert` away (see **Rollback Plan**).

## Stakeholders

- **Primary Users**: Codev builder agents (Claude 5 / GPT 5.6 / Gemini 3.6 class) and
  the CMAP reviewer agents that consume the consult-type prompts.
- **Secondary Users**: architects (human + AI) who must be able to read and maintain
  the surface; downstream adopters who receive it via `codev update`.
- **Technical Team**: this builder; the architect at both gates.
- **Business Owners**: Waleed (charter holder; ratifies scar-rule wordings, approves
  the A/B verdict).

## Success Criteria

- [ ] **M0 — the metric measures what is served.** `scripts/measure-prompt-surface.sh`
      derives the phase-task term from the prompts the live resolver loads
      (`protocols/<protocol>/prompts/`), includes the inlined role file, and expands
      `{{> …}}` includes. A test asserts the script's phase-prompt source directory is
      the one `loadPromptFile` resolves, so this defect cannot silently return.
- [ ] **M0b — the corrected instrument and baseline land on `main` early**, in a small
      standalone PR (precedent: #1290, the 1252 frozen-sample fix), not at the end of
      this project's branch. `1252-word-baseline.md` and `1252-word-after-phase7.md`
      cite figures derived from the dead tree; they are shared knowledge that other work
      reads, so the record is corrected while this project builds rather than after. The
      correction annotates the 1252 artifacts in place — original figures preserved,
      marked superseded, with the reason — it does not rewrite their history.
- [ ] **M1 — >50% reduction.** `ALWAYS_ON_WORDS` measured by the corrected script falls
      from the corrected pre-rewrite baseline (33,519 ± re-measurement) to **≤15,900**.
      Before and after are measured with the *same* corrected script and both figures
      are committed as generated artifacts.
- [ ] **M2 — per-surface targets met.** Every row of the cut-plan table meets its
      target, in **both** `codev/` and `codev-skeleton/`.
- [ ] **M3 — sweep completeness.** Every protocol shipped in `codev-skeleton/protocols/`
      is rewritten to the same standard; no protocol retains a pre-rewrite
      `protocol.md`, `builder-prompt.md`, prompt set, or consult-type set. A check
      enumerates protocols from disk rather than a hardcoded list.
- [ ] **M4 — scar rules intact.** All eight canonical strings present byte-identically
      on every surface in the rebuilt registry; a test fails on reword or deletion and
      pins the count at 8.
- [ ] **M5 — no capability lost.** Every artifact contract, gate, signal, check name,
      and notification trigger present before the rewrite is present after it. Verified
      by an explicit inventory diff, not by reading.
- [ ] **M6 — the dead tree is gone.** `codev-skeleton/porch/prompts/` deleted, with a
      grep proving no consumer.
- [ ] **M7 — A/B non-inferiority passes.** The pre-registered decision rule in **A/B
      Validation Design** returns SHIP.
- [ ] **M8 — behavioural baseline re-run.** `measure-prompt-behavior.ts` re-run and
      committed; B1 compared directionally against 51.88% (n=160) with the sample
      documented.
- [ ] **M9 — rollback rehearsed.** The revert path is executed once on a scratch branch
      and shown to restore the pre-rewrite surface byte-for-byte.
- [ ] All existing tests pass; no reduction in coverage. New tests cover M0, M3, M4, M5.
- [ ] Documentation updated: `arch.md`/`arch-critical.md` and
      `lessons-learned.md`/`lessons-critical.md` routed by tier; `CLAUDE.md`/`AGENTS.md`
      byte-identical after the rewrite.

## Constraints

### Technical Constraints

Copied verbatim from issue #1280's **Baked Decisions**; each is fixed and not
re-litigated by this spec, the plan, or CMAP reviewers:

- **All prompt consumers are frontier models** (Claude 5, GPT 5.6, Gemini 3.6 class). No
  weak-model tier, no fallback scaffolding variant, no tiering mechanism. One form.
- **Scar rules are exempt and verbatim** — the eight compressed canonicals developed in
  Spec 1252 Phase 5 (six repo rules + shellper verified-orphan + Tower-restart
  permission) ship with the rewrite; the registry/enforcement concept from 1252 is
  rebuilt fit-for-purpose around the post-shrink surface, not before it.
- **Validation is A/B, not observational**: same issues executed by builders on old vs
  new prompts, compared on outcomes (gate friction, review rounds, correctness). Spec
  1252's M12 established that observational baselines (n=17) can only detect large
  regressions — insufficient at deletion scale. The A/B design is a first-class spec
  section.
- Spec must define a rollback story (prompt surfaces are files; reverting is cheap —
  say so concretely).

Further technical constraints arising from the repository:

- **Both trees.** `codev/` (our instance) and `codev-skeleton/` (what adopters get)
  must be changed together; `CLAUDE.md` and `AGENTS.md` must stay byte-identical.
- **Four-tier resolution.** Framework files resolve at runtime; a rewrite must not
  introduce a fetch-by-path instruction for a file that may not exist on disk
  (deliver-don't-fetch).
- **No behaviour changes in porch.** This project rewrites content and fixes a
  measurement script. Changing the state machine, gates, or check semantics is out of
  scope.
- **The measured proxy is SPIR**, but the rewrite is fleet-wide (M3).

### Business Constraints

- Two human gates (`spec-approval`, `plan-approval`) plus the `pr` gate; the A/B verdict
  is the architect's call, not the builder's.
- Adopters consume the skeleton via `codev update` — a regression ships to them, so the
  rollback path must be a single revertible unit per surface.
- Scar-rule wordings are architect-ratified; a builder may not compress them.
- **The corrected instrument ships early, as its own PR** (M0b) — architect-directed on
  2026-08-01. This is an explicitly architect-requested PR under the issue's PR strategy;
  the remaining phase-commits still ship as a single later PR.

## Assumptions

- The eight scar-rule wordings on `builder/spir-1252` remain the ratified set; if the
  architect amends them, the registry is rebuilt from the amended set.
- `I = 10` phase-task deliveries remains the agreed proxy for a SPIR project's
  always-on load; the metric is a *comparison* instrument, so the exact multiplier
  matters less than using the same one before and after.
- Frontier-model behaviour is stable enough over the A/B window that arm differences
  are attributable to the prompt surface (mitigated by pairing and by running both arms
  from the same base commit).
- `builder/spir-1252` stays undeleted for the life of this project (it is the only
  source of the ratified registry).
- Reviewer models are blind to the builder's prompt surface by construction — a CMAP
  reviewer sees artifacts and diffs, not the prompt that produced them.

## Solution Approaches

### Approach 1: In-place judgment rewrite, surface by surface (RECOMMENDED)

**Description**: Rewrite each existing file to the six principles, keeping the file
layout, the resolver, and porch untouched. Templates become heading interfaces. How-to
content relocates to existing skills. The dead `porch/prompts/` tree is deleted. The
measurement script is corrected first so every subsequent cut is scored honestly.

**Pros**:
- Zero mechanism risk: no new code path between authoring and serving.
- Every change is a text diff — trivially reviewable, trivially revertible, per surface.
- Rollback granularity equals cut granularity (one revert per surface).
- Compatible with the deliver-don't-fetch convention already in force.

**Cons**:
- Discipline-dependent: nothing structurally prevents re-growth (mitigated by a
  budget check, below).
- Large diff across ~10 protocols × 2 trees; sweep completeness is the main risk (M3).

**Estimated Complexity**: Medium
**Risk Level**: Low

### Approach 2: Generate prompts from `protocol.json`

**Description**: Treat `protocol.json` as the single source of truth and synthesize
phase prompts (phase name, artifact path, checks, gate, signal contract) at runtime,
with a small per-phase prose delta.

**Pros**:
- Structurally prevents re-growth and drift; the state machine and the prompt can never
  disagree.
- Would have made the 1252 drift bug impossible.

**Cons**:
- Introduces a code path between authoring and serving — new failure mode, harder to
  review, harder to revert, and it changes porch behaviour (an explicit constraint
  above).
- Couples the shrink to a mechanism change, so an A/B regression becomes
  un-attributable: was it the deletion or the generator?

**Estimated Complexity**: High
**Risk Level**: Medium-High

**Verdict**: right idea, wrong project. Land the shrink first; a generator over a
15,000-word surface is a plausible successor.

### Approach 3: Shared kernel + per-protocol deltas

**Description**: One protocol-agnostic builder kernel (gates, artifacts, thread,
notifications, scar rules) included by every protocol, plus a short per-protocol delta.

**Pros**:
- Attacks duplication across the ten protocols, which the per-surface table does not.
- Uses the existing `{{> …}}` include mechanism — served-word-honest by construction.

**Cons**:
- 1252 already proved dedup buys ~7% on *served* words: an include expands, so moving
  text between files changes ownership, not the bill. The savings here are maintenance,
  not context.
- Risks re-creating the shadow-tree class of bug (one edit silently changing ten
  protocols' served prompts).

**Verdict**: adopt selectively *inside* Approach 1 where a kernel genuinely reduces
served words for the reader (not merely authored words), and only after the shrink.

## Open Questions

### Critical (Blocks Progress)

- [x] **~~Does the architect accept the corrected measurement baseline?~~** **RESOLVED
      2026-08-01** — architect verified both claims against source (script line 89;
      `prompts.ts:78`) and **endorsed M0 as specced**: fix the script first, measure
      before *and* after on the corrected instrument, >50% target unchanged against the
      corrected 33,519-word baseline. Added: land the corrected instrument and baseline
      on `main` early (M0b), and record the instrument principle explicitly (done —
      **Problem Statement**, principle 7).
- [ ] **How is "gate friction" captured?** 1252 established that gate-rejection counts
      are **not minable** from committed history (no `rejected` state; `requested_at` is
      overwritten). Either (a) the architect scores each gate prospectively on a
      three-item rubric during the A/B, or (b) a porch gate-event append-log is added.
      (b) is a porch behaviour change and therefore out of scope here — the spec
      assumes **(a)** unless the architect directs otherwise.

### Important (Affects Design)

- [ ] **A/B sample size.** The design below specifies ≥6 issue-pairs. More pairs buy
      power but cost real builder runs and consult spend (~$1,478/30d at current rates).
      The architect sets the ceiling.
- [ ] **Do the SPIR templates survive as interfaces, or disappear entirely?** Issue
      #1279's audit is in scope. Recommendation: survive as ≤150-word heading
      interfaces, since porch checks assert on headings (`spec_has_required_sections`).
- [ ] **Is the hot tier's 736 words genuinely exempt?** It is the one surface already
      built to these principles (capped, judgment-shaped, displacement-enforced). The
      spec exempts it; a reviewer may argue it should be re-derived post-shrink.

### Nice-to-Know (Optimization)

- [ ] Should a **word-budget check** run in CI (fail the build if any surface exceeds
      its target by >10%)? Cheap anti-re-growth insurance; adds a maintenance surface.
- [ ] Does trimming the consult-type prompts move CMAP verdict *quality* measurably, or
      only cost? B1 will show the rate; quality needs human adjudication.
- [ ] Are the ~17,000 words of `.claude/skills/` the right destination for relocated
      how-tos, or does that surface need its own budget?

## Performance Requirements

Not a runtime-performance feature; the requirements are on the artifact and the harness.

- **Served always-on words**: ≤15,900 per SPIR builder (from 33,519) — M1.
- **Per-surface ceilings**: as tabulated in **Desired State** — M2.
- **Measurement runtime**: `measure-prompt-surface.sh` completes in <5s and is
  deterministic — same commit ⇒ byte-identical output (existing determinism property,
  preserved).
- **Token/cost effect** (advisory, not a gate): a ~17,600-word always-on reduction is
  ~23,000 tokens per builder-project; recorded before/after from `consult stats` and
  session telemetry as context for interpreting the A/B, keying no threshold.

## Security Considerations

- **The scar rules are the security surface.** Every one of the eight guards an
  irreversible act (destroying uncommitted work, destroying worktrees, killing live
  sessions, bypassing a human gate). Deleting or weakening one is the highest-severity
  failure this project can produce — hence verbatim carriage (M4), byte-identical
  enforcement, and a hard rollback trigger on any observed violation in the A/B.
- **Human-gate integrity.** The rewrite must not weaken "a gate message is a
  notification to the human, not authorization." Gate semantics are content, not code,
  and this project edits content.
- **No secrets in prompt surfaces.** Existing property; re-verified after the rewrite
  (the surfaces contain no credentials today and must not acquire any).
- **Adopter blast radius.** Skeleton changes ship to every adopter on `codev update`;
  a weakened prohibition would propagate silently. This is why rollback is per-surface
  and rehearsed (M9).

## Test Scenarios

### Functional Tests

1. **T1 — Measurement correctness (M0).** The script's phase-prompt source directory
   equals the directory `loadPromptFile` resolves for a known protocol; asserted against
   the real resolver, not a hardcoded string. Regression-proofs the dead-tree defect.
2. **T2 — Include expansion (M0/M1).** A prompt with a `{{> …}}` include counts the
   include's words; a fixture that moves text from prompt into template shows **zero**
   change in `ALWAYS_ON_WORDS` (phantom-savings proof, preserved from 1252).
3. **T3 — Word ceilings (M1/M2).** Each surface's served word count is at or under its
   target, per protocol, per tree. Failure names the surface and the overage.
4. **T4 — Scar-rule integrity (M4).** Every canonical string appears byte-identically on
   every registered surface; the test pins the rule count at 8 and the eight ids;
   rewording or deleting any copy fails.
5. **T5 — Capability inventory (M5).** The set of {artifact paths, gate names, signal
   names, porch check names, notification triggers} extracted from the post-rewrite
   surface equals the pre-rewrite set. Additions allowed; **removals fail**.
6. **T6 — Sweep completeness (M3).** Protocols are enumerated from
   `codev-skeleton/protocols/` on disk; each must satisfy T3. A newly added protocol
   fails the test until it is written to budget.
7. **T7 — Twin parity.** `CLAUDE.md` and `AGENTS.md` byte-identical; `codev/` and
   `codev-skeleton/` copies of every rewritten framework file consistent.
8. **T8 — Dead-tree removal (M6).** `codev-skeleton/porch/prompts/` absent; no source
   file references it.
9. **T9 — Live spawn probe.** A builder spawned end-to-end on the rewritten surface
   receives a spawn prompt containing every element of the artifact contract, and its
   first `porch next` returns a well-formed task. ("It compiled" is not "it works" —
   the real spawn path is exercised, not a unit fixture.)
10. **T10 — Rollback rehearsal (M9).** Reverting the rewrite commits on a scratch branch
    restores the pre-rewrite surface byte-for-byte and `measure-prompt-surface.sh`
    reproduces the pre-rewrite figure.

### Non-Functional Tests

1. **T11 — Determinism.** Two runs of each measurement script at the same commit emit
   byte-identical output.
2. **T12 — Behavioural re-measurement (M8).** `measure-prompt-behavior.ts` re-run
   post-merge with self-exclusion; B1/B2/B4 committed and compared directionally to the
   1252 baseline.
3. **T13 — A/B execution (M7).** The full pre-registered protocol below.

## A/B Validation Design

*(A first-class section per Baked Decision 3. This is a **non-inferiority** trial: the
claim under test is "deleting 53% of the always-on surface does not degrade outcomes",
not "it improves them".)*

### Unit and arms

The unit of observation is an **issue-pair**: one GitHub issue executed twice, by two
freshly-spawned builders in separate worktrees, from the same base commit.

- **Control arm (A)**: worktree whose `codev/` + `codev-skeleton/` are at the
  pre-rewrite commit.
- **Treatment arm (B)**: worktree at the post-rewrite commit.

No code differs between arms — the prompt surface is file-resolved, so the arms are two
checkouts. This is the whole reason the design is cheap.

### Sample

- **≥6 pairs (12 builder runs)**, stratified: ≥3 SPIR/ASPIR (exercises spec, plan,
  implement, review prompts, both gates, and the templates) and ≥3 lighter protocols
  (BUGFIX/AIR — exercises the short prompts and the single consult).
- Issues drawn from the existing backlog, selected **before** either arm runs, and
  frozen (no issue-body edits mid-trial).
- Arm order alternates per pair to control for time-varying factors.

### Pre-registered outcomes

| ID | Outcome | Instrument | Direction |
|---|---|---|---|
| **O1** | Gate friction | Architect scores each gate on a 3-item rubric at approval time: *artifact complete as specified? / required rework before approval? / did the builder need a clarifying message?* (prospective — history is not minable) | non-inferior |
| **O2** | Review rounds | Iterations to terminal state per phase, from `status.yaml` history; plus CMAP REQUEST_CHANGES rate (comparable to B1 = 51.88%) | non-inferior within margin |
| **O3** | Correctness | Architect's PR review findings by severity + any post-merge defect attributable to the run | non-inferior |
| **O4** | Protocol compliance | Binary per-run checklist: required artifacts present with required headings · stopped at every human gate · no `status.yaml` hand-edit · no `git add -A` · no scar-rule violation · thread committed | **zero tolerance** |
| **O5** | Cost & duration | Tokens, wall-clock, `consult stats` delta | advisory only |

### Blinding

CMAP reviewer models are blind by construction. The architect is not blind and cannot
be; the mitigation is that O2 and O4 are extracted mechanically from committed
artifacts, and O1/O3 are scored against a rubric written **before** any run.

### Decision rule (pre-registered)

**SHIP** iff all of:

1. **O4 = zero violations in the treatment arm.** Any scar-rule violation, skipped gate,
   or missing required artifact is an immediate hard stop, independent of every other
   outcome.
2. **O2** treatment mean review rounds ≤ control mean **+ 0.5 rounds/phase**, and
   treatment REQUEST_CHANGES rate ≤ control **+ 10 percentage points**.
3. **O3** no treatment-arm correctness finding of severity ≥ "would block merge" that
   is absent from its paired control run.
4. **O1** no pair where the treatment arm required rework at a gate that its control did
   not, for the same reason.

Otherwise **HOLD** (fix and re-run the failing pairs) or **ROLLBACK** (below).

### Honest power statement

With n=6 pairs this design detects only **large** effects — roughly a doubling of review
rounds or a ≥20-point REQUEST_CHANGES shift. It cannot certify the absence of a subtle
regression, and this spec does not claim it can. It is nonetheless strictly stronger
than 1252's observational baseline, because each pair is matched on the issue itself —
the dominant source of variance. O4's zero-tolerance criterion is where the real
protection lives: compliance is binary, observable in every run, and is the failure mode
that deletion would plausibly cause.

## Rollback Plan

*(Required by Baked Decision 4. Prompt surfaces are files; reverting is cheap — here is
exactly how cheap.)*

- **Unit.** One revertible commit per surface (CLAUDE.md/AGENTS.md · role · protocol.md ·
  builder-prompt · prompts+templates · consult-types · registry · measurement script),
  in both trees. Rolling back one surface never requires rolling back another.
- **Mechanism.** `git revert <commit>` restores the prior bytes. No migration, no state,
  no schema, no data. Verified by T10 on a scratch branch before the PR merges.
- **Blast radius and propagation.** For this repo: effective for the next spawned
  builder — in-flight builders keep the surface they were spawned with (prompts are read
  at spawn/phase time, so a running builder is unaffected either way). For adopters: the
  revert ships in the next release; an adopter can also pin the prior `@cluesmith/codev`
  version, since framework files resolve from the installed skeleton (tier 4).
- **Triggers.** (a) any O4 violation in the A/B — immediate, no deliberation; (b) an
  observed scar-rule violation in any real project post-merge; (c) O2/O3 outside the
  pre-registered margins; (d) architect's judgment at the `pr` or `verify-approval` gate.
- **Partial rollback is the expected shape.** If one surface regresses (say the review
  prompt lost a contract), revert that surface and keep the rest — the whole point of
  per-surface commits.
- **Cost.** One revert, one release. There is no irreversible step anywhere in this
  project.

## Dependencies

- **External Services**: none. (`gh` for issue/PR reads during the A/B; consult backends
  — Gemini via `agy`, Codex, Claude — for CMAP, unchanged.)
- **Internal Systems**: the four-tier resolver (`lib/skeleton.ts`); porch prompt
  composition (`commands/porch/prompts.ts`) — read, not modified; the consult CLI's
  consult-type resolution; `scripts/measure-prompt-surface.sh` and
  `packages/codev/scripts/measure-prompt-behavior.ts`.
- **Artifacts**: `builder/spir-1252` (ratified scar registry — must not be deleted);
  `codev/resources/1252-*.md` (baselines).
- **Libraries/Frameworks**: none new.

## References

- Issue #1280 (this charter); Issue #1279 (dead spec/review templates); Issues #1276
  (multi-model tiering) and #1277 (controlled A/B eval), both filed by 1252 and both
  superseded here or explicitly out of scope.
- PR #1278 (Spec 1252, closed unmerged) and branch `builder/spir-1252` — surface
  inventory, ownership analysis, scar registry, enforcement machinery.
- `codev/reviews/1252-prompt-architecture-single-own.md`;
  `codev/resources/1252-word-baseline.md`, `1252-word-after-phase7.md`,
  `1252-behavior-baseline.md`, `1252-shadow-tree-audit.md`;
  `codev/state/spir-1252_thread.md`.
- *The new rules of context engineering for Claude-5-generation models* —
  https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models
- `codev/resources/arch.md` (four-tier resolution, repository dual nature);
  `codev/resources/lessons-learned.md` (sweep-scope failures, served-surface dedup).

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| A deleted instruction was load-bearing and its loss is silent | Medium | High | T5 capability-inventory diff (removals fail the build); O4 zero-tolerance in the A/B; per-surface rollback |
| A scar rule is weakened or dropped | Low | **Critical** | Verbatim carriage; byte-identical enforcement pinned at 8 rules; hard rollback trigger; architect-only rewording |
| Sweep misses a protocol or the second tree | **High** | Medium | T6 enumerates protocols from disk; T7 twin parity. 1252's top lesson was that sweep-scope failures dominated its review iterations |
| A/B underpowered; a subtle regression ships | Medium | Medium | Stated honestly in the power statement; O4 binary compliance carries the protection; T12 behavioural re-measurement post-merge as a second net |
| ~~Corrected baseline disputed at the gate~~ — **retired**, endorsed 2026-08-01 | — | — | Both figures are re-derived by one script, so any future re-scoping of the denominator recomputes mechanically |
| A *third* instrument defect ships undetected | Medium | High | Principle 7: every check and baseline is reviewed against its claim. T1/T2 assert the instrument against the live resolver; M0b puts the corrected instrument under public review early rather than at PR time |
| Surface re-grows after the project ends | **High** | Medium | Word-ceiling test (T3) run in CI is the cheap structural answer; open question on whether to gate on it |
| The A/B costs more than the shrink saves | Medium | Low | 12 runs on backlog issues that needed doing anyway; O5 tracks it; architect sets the pair ceiling |
| `builder/spir-1252` is deleted, losing the ratified registry | Low | High | Registry content is quoted in this spec's thread and will be committed to `main` as the rebuilt registry early |

## Expert Consultation

**Date**: pending
**Models Consulted**: Gemini (via `agy`), Codex (GPT-5.6 Sol), Claude Opus 5 — run by
porch at the specify-phase verify step.
**Sections Updated**: *(to be filled after the 3-way review; feedback is incorporated
directly into the sections above and summarized here)*

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [ ] Expert AI Consultation Complete

## Notes

**On the irony.** A specification arguing for deletion should not be padded. This one is
long because it carries three architect-mandated designs (cut plan, A/B, scar carriage)
plus a measurement correction that changes the project's headline number. The artifacts
it produces are the short ones.

**On what this project deliberately does not do.** It does not build a prompt generator
(Approach 2), does not add tiering of any kind (Baked Decision 1), does not change porch
behaviour, and does not rebuild 1252's full enforcement machinery — only the minimum
scar-rule integrity check that the deletion itself makes necessary. Enforcement rebuilt
around a surface that is still moving is enforcement built twice.

**On the deferred decision from 1252.** The architect's pr-gate ruling was that
structural machinery is not worth carrying for a surface about to shrink by half. That
sequencing is honoured here: shrink first, then enforce what remains. The word-ceiling
check (T3) is the successor's smallest useful enforcement primitive, and it only becomes
meaningful once the ceilings exist.
