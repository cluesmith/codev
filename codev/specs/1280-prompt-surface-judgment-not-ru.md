# Specification: Prompt surface — judgment-not-rules rewrite (principle conformance)

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.

ACCEPTANCE MODEL (Waleed, 2026-07-31): "I don't think the goal should be a
particular size. That's not the right criteria. It should be to stick to the
principles outlined in the blog post." Principle conformance is pass/fail.
Word counts are measured and reported, but nothing passes or fails on them.

Round-by-round review history lives in
codev/projects/1280-*/1280-specify-iter{1,2}-rebuttals.md and
codev/state/spir-1280_thread.md — deliberately not narrated here.
-->

## Metadata
- **ID**: spec-2026-07-31-prompt-surface-judgment-not-rules
- **Status**: draft (acceptance model revised to principle conformance)
- **Created**: 2026-07-31
- **Issue**: #1280
- **Protocol**: SPIR

## Clarifying Questions Asked

Issue #1280 carries a complete charter, so no clarifying questions were put to the architect
before drafting. Five were resolved against the repository or by architect ruling:

1. **What is the always-on surface, as served?** — Read the live composition path
   (`commands/porch/prompts.ts`, `lib/skeleton.ts`, `lib/managed-block.ts`,
   `agent-farm/commands/spawn-worktree.ts`) and measured this builder's own served artifacts
   (`.builder-prompt.txt` 4,921w, `.builder-role.md` 1,837w). See **Inventory**.
2. **Is the committed measurement script fit for this project?** — No; three defects, one
   disqualifying. Criterion **M0**; architect verified against source and endorsed.
3. **How wide is the rewrite target?** — The **entire** prompt surface: architect roles,
   builder roles and spawn wrappers, consultant/CMAP prompts, phase prompts and their template
   includes, `protocol.md` texts.
4. **Where are the eight ratified scar rules?** — Recovered verbatim from
   `builder/spir-1252:codev/resources/scar-rules.yaml`.
5. **What is the acceptance criterion?** — **Principle conformance, not size** (Waleed, above).
   Measurement is retained for honesty, not for grading.

## Problem Statement

Codev's prompt surface was written for a fleet that could not be trusted to infer process. It
tells agents how to be agents: ordered procedures, all-caps prohibitions, checklists restating
the phase body, annotated templates. A builder consumes **34,255 served always-on words**
before reading a line of the code it was spawned to change.

Spec 1252 proved the obvious remedy fails: deduplication yields **−7.0%**, because the surface
is not duplicated, it is **over-instructed**. Anthropic's published account of the
Claude-5-generation rewrite reports:

> "We removed over 80% of Claude Code's system prompt for models like Claude Opus 5 and Claude
> Fable 5 with no measurable loss on our coding evaluations."

Three compounding costs:

1. **It crowds out judgment.** A model given a 3,703-word procedure follows the procedure;
   given a contract and a goal, it reasons about the goal.
2. **Nobody reads it, so it rots.** 1252 found the *served* SPIR builder prompt had silently
   lost its entire `Verify Phase` section, with a detector reporting the drift, unread, for
   months. A surface too large to read is too large to maintain.
3. **It makes its own success unmeasurable.** The committed measurement script scores a
   directory the runtime never loads.

Deletion on judgment-trust grounds was an explicit **Non-goal** of Spec 1252.

### Principle: the instrument is part of the deliverable

This is the second measurement defect in the 1252 lineage — the first being that 1252 shipped
without a measurement plan at all, caught at a human gate, not by CMAP. Neither was found by
reading the instrument's code; both by asking *what does this claim to measure, and does it?*

> **The instrument is part of the deliverable, and instruments get reviewed against what they
> claim to measure — not merely against whether they run.** "Deterministic and committed" is
> not "correct."

Under the revised acceptance model the instrument no longer *grades* the work — but it still
keeps the project honest about what actually happened, which is why **M0**, **M0b** and
**M0c** survive the demotion of every word target.

## Current State

### Inventory — every prompt-bearing surface, by audience

Served and expanded words (`{{> …}}` includes resolved `codev/` → `codev-skeleton/`), captured
2026-07-31 at `047f92f7`. **Reported for observability; no figure here is a target.**

**SHARED — every agent in this repo**

| Surface | Words | How served |
|---|---:|---|
| `CLAUDE.md` | 5,815 | session, harness auto-load |
| ↳ `@codev/resources/arch-critical.md` | 416 | **transcluded at session launch** (#1119) |
| ↳ `@codev/resources/lessons-critical.md` | 320 | same |
| `AGENTS.md` | 5,815 | byte-identical twin; one loads per session, never both |

**Session shared total: 6,551.**

**ARCHITECT** — `roles/architect.md` 2,048 (read at `arch-init`); `.claude/skills/*/SKILL.md`
×10 = 6,672 (on-demand — progressive disclosure already working as intended).

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

**SPIR builder spawn total: 6,364.**

**PHASE — per porch task delivery, ×I.** Hot tier (736) rides on *every* phase prompt.

| Protocol | Prompts (expanded) | Mean |
|---|---|---:|
| spir / aspir | specify 1,402 · plan 1,169 · implement 1,065 · review 1,957 | 1,398 |
| pir | review 2,414 · implement 1,151 · plan 741 | 1,435 |
| bugfix | pr 491 · fix 352 · investigate 290 | 378 |
| air | pr 471 · implement 442 | 457 |
| maintain | maintain 402 · review 310 | 356 |

**CONSULTANT — per CMAP review.** `roles/consultant.md` 252 + one consult-type: spir/aspir spec
514 · impl 421 · phase 421 · plan 406 · pr 392; bugfix pr 726 / impl 641; pir pr 475 / impl
507; air pr 455 / impl 420; maintain 421 / 392. **SPIR per review: 683.** Fleet-wide ≈ 683 × 3
models × ~10 reviews ≈ **20,500 words/project**.

**DEAD** — `codev-skeleton/porch/prompts/**`, 10 files, 4,009 words, no runtime consumer.

### How the reported figures are composed

Buckets are **exclusive** and partition the authored surface: `SHARED` (6,551) · `ARCHITECT`
(2,048) · `BUILDER_SPAWN[p]` · `PHASE[p]` · `CONSULTANT[p]` · `DEAD` (4,009). Audience loads
are **derived** and deliberately overlap — so they are reported separately, never summed:

```
HOT                      = arch-critical + lessons-critical                    = 736
ALWAYS_ON(builder,p,I)   = SHARED + BUILDER_SPAWN[p] + I × (HOT + mean PHASE[p])
ALWAYS_ON(architect)     = SHARED + ARCHITECT
ALWAYS_ON(consultant,p)  = roles/consultant.md + mean CONSULTANT-type[p]

ALWAYS_ON_WORDS  ≡  ALWAYS_ON(builder, spir, 10)
                 =  6,551 + 6,364 + 10 × (736 + 1,398)  =  34,255
```

Architect load 8,599; consultant 683. `I = 10` is 1252's proxy — a comparison constant,
identical before and after. These definitions exist so M0's report is unambiguous; **none of
them is a target.**

### File counts — what the architect will personally inspect

| | Count |
|---|---:|
| Prompt-bearing `.md` files, both trees + `CLAUDE.md`/`AGENTS.md` | **131** |
| `codev/protocols` copies **byte-identical** to their skeleton twin | **60** |
| `codev/protocols` copies that **differ** from a twin | **0** |
| `codev/protocols` files with **no skeleton twin** (local-only) | 3 — `maintain/templates/audit-report.md`, `maintain/templates/lessons-learned.md`, `release/protocol.md` |
| `roles/*.md` — all three byte-identical across trees | 3 pairs |
| `CLAUDE.md` ≡ `AGENTS.md` | verified identical |
| **Distinct content decisions** | **~66** |

This matters for M11: reviewing all 131 diffs would mean re-reading ~65 byte-identical copies.
The inspection is over **distinct content decisions**, with twin sync verified mechanically
(**T7**), which must therefore operate on the **intersection of files that have twins** — the
three local-only files are inspected once and are not twin-parity candidates.

**Resolver precondition (load-bearing for the A/B).** Every `codev-skeleton/protocols/**` and
`roles/*.md` file currently has a `codev/` twin — verified: **0 skeleton files lack one** — so
tier 2 shadows the installed-package skeleton (tier 4) for every surface under test. The
control arm only genuinely serves the old surface while this holds. **Deleting a `codev/` file
while keeping its skeleton twin would silently drop the control arm through to the new
skeleton**, invalidating the comparison without any error. Asserted as a pre-flight in T14.

### Coverage is per-surface, not per-protocol × surface-type

`codev/protocols/` holds **ten** protocols, `codev-skeleton/protocols/` **nine** — `release` is
project-local by design, has only `protocol.md` (1,626w, no `protocol.json`, no
`builder-prompt.md`), is human-invoked prose an agent reads, and is in scope but not
porch-orchestrated. `experiment`, `research`, `spike` and `release` have no `prompts/` or
`consult-types/`; those absences are intentional. Coverage criteria therefore apply to **each
surface that exists after resolution**, enumerated from disk across both trees and unioned.

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
under-counts the session term by 736. The dead tree has no *runtime* consumer but does have a
**test** consumer: `review-prompt-routing.test.ts:29` (a Spec 987 hot/cold-routing protection).

### What landed, what is deferred

On `main` from the 1252 harvest: drift reconciliation, the audit, two word baselines, the
behavioural baseline (B1 = 51.88% REQUEST_CHANGES, n=160, self-excluded; B2 1.12 rounds/phase),
and the measurement tooling. Deferred here by architect ruling: the **scar registry and its
eight ratified wordings**, with enforcement rebuilt *after* the shrink.

Issue #1279 is partly overtaken — SPIR prompts now inline templates via `{{> …}}`. Two separate
constraints govern template shape and must not be conflated: `checks.ts:149-154`
(`REQUIRED_SPEC_SECTIONS`) requires only **four** headings; the 20-heading pressure comes from
the `spec-review` consult type, advisorily.

## Desired State

**Every prompt-bearing file conforms to the blog's principles.** Not "is smaller" — conformant.
A file that is principle-conformant at more words passes; a file that hits any size one might
have hoped for while still narrating procedure fails.

### The principles, verbatim

Quoted from *The new rules of context engineering for Claude-5-generation models*. These are
the acceptance basis; each is restated as a per-file question the architect can answer from a
diff.

| # | Blog transition | Verbatim rationale | Per-file conformance question |
|---|---|---|---|
| **P1** | "Give Claude rules" → **"Let Claude use judgement"** | "newer models have better judgement and can handle these decisions well without explicit rules." | Does this file state a *contract* (what must be true) rather than a *procedure* (what steps to take)? Is every remaining rule one a frontier model would get wrong without it? |
| **P2** | "Give Claude examples" → **"Design interfaces"** | "giving examples actually constrains them to a certain exploration space. Instead of using examples, think more about the design of your tools, scripts and files." | Has each illustrative example been replaced by an interface — a heading skeleton, a schema, a named artifact contract? |
| **P3** | "Put it all upfront" → **"Use progressive disclosure"** | "Claude Code has gotten very competent at using progressive disclosure- loading the right context at the right times." | Is everything in this always-on file needed *every* time? Has look-it-up content moved to a skill or on-demand file, addressed by name? |
| **P4** | "Repeat yourself" → **"Simple tool descriptions"** | "We found we could delete these repeat examples and put instructions on how to use tools in the tool descriptions rather than the system prompt." | Do CLI/tool how-tos live with the tool (skills, `--help`) rather than in the prompt? Is anything repeated here that another surface already owns? |
| **P5** | "Memory in CLAUDE.md files" → **"Auto-memory"** | "Claude now automatically saves memories that are relevant to the work and to you." | **N/A for this project, with reason** — auto-memory is a Claude Code harness feature, and Baked Decision 1's fleet includes GPT 5.6 and Gemini 3.6 consumers with no equivalent. Codev's governance content stays in the hot tier rather than relying on it. Declared rather than silently skipped. |
| **P6** | "Simple specs" → **"Rich references"** | "Claude can handle increasingly more complicated references. Instead of simple markdown files, Claude can reference HTML artifacts." | Where prose restates machine-readable truth (`protocol.json` gates, checks, phases), does the file reference the structured source instead of narrating it? |
| **P7** | **"Unhobbling"** — worst-case guardrails | Old guardrails existed because "we needed to be sure that Claude avoided worst case scenarios, such as deleting files." | Has defensive padding written for weaker models been deleted — **except** the ratified scar rules (below)? |

**P7 and the scar rules — the one deliberate exception.** The blog's worst-case example
("deleting files") is precisely the class Codev's scar rules guard. Baked Decision 2 keeps all
eight verbatim. This is a knowing departure from P7, not an oversight: the blog's guardrails
protected against *bad output*, which judgment now handles; scar rules protect against
*irreversible acts* — destroyed worktrees, killed sessions, bypassed human gates — where the
cost of being wrong once is unbounded and no amount of judgment makes the wager sensible. Every
other P7 candidate goes.

### Per-surface disposition and cut plan

Issue #1280's Protocol section requires the spec phase to produce "the per-surface cut plan…,
the A/B eval design, and the scar-rule carriage plan." The *word targets* are withdrawn by the
acceptance-model redirect; the **disposition mapping survives it**, and is the authoritative
answer to "which surfaces are in scope, and what is expected to change in each."

Every category is marked **rewritten**, **inspected-but-unchanged**, or **excluded with
reason** — no category is left implicit.

| Bucket | Disposition | Dominant non-conformance today | Governing principles | Relocation destination |
|---|---|---|---|---|
| `CLAUDE.md` / `AGENTS.md` | **rewritten** | CLI walkthroughs, worktree recipes, protocol-selection prose — all needed rarely, loaded always | P3, P4, P1 | `.claude/skills/` (afx, codev, porch, consult), `--help` |
| hot tier (`arch-critical`, `lessons-critical`) | **inspected-but-unchanged** | none — already capped, judgment-shaped, displacement-enforced (Spec 987) | — | — |
| `roles/architect.md` | **rewritten** | procedure narration for coordination already covered by skills | P1, P3 | `arch-init` / `afx` skills |
| `roles/builder.md` | **rewritten** | ordered procedure + repeated prohibitions | P1, P7 | — |
| `roles/consultant.md` | **inspected-but-unchanged (expected)** | already lean at 252w; rewritten only if inspection finds non-conformance | P1 | — |
| `protocols/*/protocol.md` | **rewritten** | narrates the state machine that `protocol.json` already defines; checklists restate phase bodies | **P6**, P1, P7 | reference `protocol.json` |
| `protocols/*/builder-prompt.md` | **rewritten** | worst-case padding, all-caps prohibitions | P1, P7 | — |
| `protocols/*/prompts/*.md` | **rewritten** | step-by-step process; annotated templates inlined via `{{> …}}` | **P2**, P1 | heading interfaces |
| `protocols/*/templates/*.md` | **rewritten** | annotated examples with filler prose | **P2** | heading interfaces |
| `protocols/*/consult-types/*.md` | **rewritten** | process prose around a rubric + verdict contract | P1, P2 | — |
| `.claude/skills/**` | **excluded from rewrite; in scope for measurement** | on-demand already — P3 working as intended. Receives relocated content, so it is measured (M0(g)) and grows by design | — | — |
| `codev-skeleton/porch/prompts/**` | **deleted** (M6) | dead — no runtime consumer | — | — |
| `codev/protocols/release/protocol.md` | **rewritten** | human-invoked prose, no skeleton twin, missed by earlier inventories | P1, P3 | — |

**Scope is exactly this table.** MP and M3 apply to every row marked *rewritten*; rows marked
*inspected-but-unchanged* are still inspected under M11 (the architect confirms conformance
rather than approving a diff); the one *excluded* row is excluded for a stated reason and is
still measured.

### Conformance is judged per file, by the architect

Acceptance is not a number and not a CMAP verdict. Each rewritten file carries a
**conformance record** — principles applied, what was cut and why, old and new word counts —
and the architect inspects the actual old-vs-new diff. See **M11**.

### Word counts: measured, reported, never a gate

The corrected instrument still runs before and after, still reports per-audience loads, and
still separates deletion from relocation (**M0c**) — because a project that deletes 20,000
words should be able to say truthfully where they went. **No criterion passes or fails on any
of these numbers.** The rewrite's own projection, kept purely so the reported figures have
something to be compared against, is roughly 34,255 → ~16,000 for a SPIR builder; if principle
conformance lands somewhere else, the number moves and the spec does not.

### Scar-rule carriage plan

The eight rules ratified 2026-07-28 ship **verbatim** (~188 words): `git-add-explicit`,
`never-destroy-worktrees`, `no-destructive-git`, `human-gates`, `no-hand-edit-status`,
`afx-from-root`, `shellper-verified-orphan`, `tower-restart-permission`.

- The registry is **rebuilt after the shrink** — each rule's `must_appear_on` re-derived against
  the post-rewrite surface.
- Enforcement is a byte-identical-presence test, pinned at 8 rules and their ids.
- A scar rule may be compressed **only by architect ratification**, never by a builder applying
  P1 or P7.

### Rollout: the corrected instrument lands on `main` first (M0b)

**No prompt-surface word is rewritten before the corrected instrument is on `main`.** 1252's
published baselines cite dead-tree figures while being shared knowledge other work reads.

**PR-1 (early, standalone) contains exactly:**

| In | Out (deliberately) |
|---|---|
| Corrected `measure-prompt-surface.sh` — all seven M0 items | Any edit to any prompt surface |
| Its tests (T1, T1b, T2, T11, T12, T15). The script has **no test at all** today, which is how three defects survived in a "committed and reproducible" instrument | The scar registry (rebuilt after the shrink) |
| `codev/resources/1280-word-baseline.md` — corrected, segmented pre-rewrite baseline | The dead-tree deletion (has a test consumer → M10 governance) |
| In-place annotation of `1252-word-baseline.md` and `1252-word-after-phase7.md`: originals **preserved**, marked superseded, reason + pointer | Re-derivation of 1252's behavioural baseline (B1 stands; M8 re-runs post-merge) |

**Verified safe**: no test asserts on either 1252 word-count artifact (the frozen-sample test at
`prompt-behavior-metrics.test.ts:184` pins the *behavioural* sample, a different instrument).

## Stakeholders

- **Primary Users**: builder agents; CMAP reviewer agents; architect agents.
- **Secondary Users**: humans who must read and maintain the surface (M2b); downstream adopters
  receiving it via `codev update`.
- **Technical Team**: this builder; the architect, who personally inspects every changed file.
- **Business Owners**: Waleed — sets the acceptance model, ratifies scar wordings, rules on the
  A/B verdict.

## Success Criteria

**Acceptance basis: MP1–MP7 (principle conformance) plus M11 (architect inspection). The
measurement criteria M0/M0b/M0c exist for honesty; M1 and M2 are reporting obligations that
cannot fail on a number.**

- [ ] **MP — every prompt-bearing file conforms to P1, P2, P3, P4, P6 and P7** (P5 declared
      N/A with reason), judged per file by the architect against the verbatim principle table.
      A file passes on conformance regardless of its word count. Non-conformance at any size is
      a failure.
- [ ] **M11 — architect personal inspection of every changed file.** Each implement phase ends
      with a **per-file manifest**: path · old word count · new word count · principles applied ·
      one-line rationale for what was cut. The architect reviews **actual old-vs-new diffs, file
      by file** — not samples, not summaries, not CMAP-mediated — before the phase advances.
      Batches are humanly sized: **≤12 distinct files per review batch**. Inspection is over the
      **~66 distinct content decisions**, not all 131 file-diffs — 60 `codev/protocols` copies
      are byte-identical mirrors of their skeleton twins, so reviewing both would be re-reading
      the same bytes; twin sync is verified mechanically by **T7** instead. Any file the
      architect judges non-conformant returns to the builder before the phase advances.
- [ ] **M0 — the metric measures what is served.** The corrected script (a) sources phase
      prompts from the directory `loadPromptFile` resolves; (b) resolves **per-file through the
      full four-tier chain** as `resolveCodevFile` does; (c) counts the inlined
      `roles/builder.md`; (d) counts hot-tier `@import` transclusion **and corrects the stale
      inlining comment**; (e) expands `{{> …}}` includes; (f) reports exclusive bucket subtotals
      and derived audience loads separately; (g) reports **total authored prompt-surface words**, defined
      unambiguously as **physical files on disk** — every `.md` under `codev/protocols`,
      `codev-skeleton/protocols`, `codev/roles`, `codev-skeleton/roles`, `.claude/skills`, plus
      `CLAUDE.md` and `AGENTS.md`, each counted once, **no deduplication of twins and no
      transclusion expansion**. This is deliberately a *different* basis from the always-on
      buckets (which dedupe twins and expand `@import`/`{{> …}}`), because its job is to detect
      relocation — content moved out of an always-on file must still show up somewhere. Both
      figures are reported side by side and labelled with their basis, so T11 and T15 have
      deterministic expected values. Tests assert (a) and (b) against the real resolver.
- [ ] **M0b — the corrected instrument and baseline land on `main` early**, as a small
      standalone PR (precedent #1290), per **Rollout**.
- [ ] **M0c — deleted words are distinguished from relocated words.** P3 authorizes moving
      content to skills, and relocation scores identically to deletion under an always-on-only
      metric. The review **decomposes the reduction into deleted vs relocated**, evidenced by
      M0(g). This is a reporting obligation, not a threshold.
- [ ] **M1 — before/after figures measured and published.** Same corrected script both sides;
      both committed as generated artifacts; per-audience loads reported. **No pass/fail
      threshold attaches to any of them.**
- [ ] **M2 — per-file word counts appear in every manifest** (M11), so the architect sees the
      size effect of each decision while judging conformance. **Reporting only; no ceilings.**
- [ ] **M2b — CLAUDE.md stays human-readable.** The rewritten file retains a navigable heading
      structure and is reviewed by the architect for human usability — twin-parity bytes are not
      a readability check.
- [ ] **M3 — sweep completeness.** Surfaces enumerated from disk (both trees, unioned), never a
      hardcoded list; every existing surface is rewritten and inspected. Includes
      `codev/protocols/release/protocol.md`, which has no skeleton twin.
- [ ] **M4 — scar rules intact.** Eight canonicals byte-identical on every registered surface;
      test fails on reword or deletion; count pinned at 8.
- [ ] **M5 — no capability lost, proven against the prompt text.** A committed
      `capability-inventory.json` extracted pre-rewrite with explicit recognition rules —
      artifact paths, gate names, signal names (`<signal …>` tags), porch check names,
      notification triggers — normalized (lowercase, strip backticks/punctuation, dedupe).

      **The inventory is over the resolved, expanded prompt surface, not over `protocol.json` or
      source call sites** — extracting gate names from an unchanged `protocol.json` would report
      every capability present even if every corresponding instruction vanished from the served
      prompts.

      **Representation, defined so M5 does not contradict P6.** P6 explicitly permits replacing
      narrated gate/check/phase names with a reference to the structured source. A naive
      "every extracted name must still appear in prose" rule would make a *conformant* P6
      rewrite fail. A capability is therefore **represented** if either (a) it is named in
      served prompt text, **or** (b) the served text carries an explicit, resolvable reference
      to the structured source that defines it (e.g. "gates, checks and phase order are defined
      in `protocol.json`; read it") **and** that source still defines it. (b) satisfies M5.

      **Detection limit, stated rather than implied.** Set-inclusion over names catches the
      *deletion* of a capability; it does **not** catch *inversion or gutting* of the
      instruction attached to one. "A gate message is a notification to the human, not
      authorization" could collapse to a bare mention of the gate name and still pass M5 and
      T6. That gap is covered by **M11** (the architect reads the actual diff) and **O4** (the
      A/B's zero-tolerance compliance checklist), not by M5. To narrow it further, a small
      hand-curated set of **semantic invariants** — human-gate semantics, artifact-contract
      obligations, the scar prohibitions — is asserted as *behaviour present in the served
      text*, not as name presence. This is a short list by design; the honest claim is that M5
      is a deletion detector, not a meaning detector.

      **Severity**: a removal is a hard failure **unless** the retired name appears in a
      committed `codev/resources/1280-retirements.md` in the same commit, naming the capability,
      why it is obsolete, and the architect approval.
- [ ] **M6 — the dead tree is gone, with its consumer handled.**
      `codev-skeleton/porch/prompts/` deleted. Verification is **not** a bare grep: an
      untruncated repo-wide search reconciled against the full hit list shows zero *runtime*
      consumers, and the one **test** consumer (`review-prompt-routing.test.ts:29`, a Spec 987
      protection) is updated under M10 naming Spec 987.
- [ ] **M7 — A/B non-inferiority passes** per the pre-registered decision rule; gates
      `verify-approval`. Mandatory per the charter: behavioural outcomes are the evidence the
      principles are working.
- [ ] **M8 — behavioural baseline re-run.** `measure-prompt-behavior.ts` re-run and committed;
      B1 compared directionally to 51.88% (n=160).
- [ ] **M9 — rollback rehearsed** by group, per **Rollback Plan**.
- [ ] **M10 — prose-pinned test re-baselining is deliberate and enumerated.** ~25 test files
      assert exact prose in the surfaces being rewritten; the hardest is
      `agent-farm/__tests__/baked-decisions.test.ts:143-148`, enforcing a **pure-addition diff**
      against committed baselines for `protocols/{spir,aspir,air}/builder-prompt.md`. Also
      `bugfix-744-spir-pr-strategy.test.ts`, `spec-1273-wait-discipline-docs.test.ts`,
      `bugfix-619-aspir-prompt.test.ts`, `template-delivery.test.ts`,
      `framework-ref-audit.test.ts`, `governance-sweep.test.ts`,
      `review-prompt-routing.test.ts`. **Each assertion is a prior spec's protection encoded as a
      grep, so retiring one is a governance act** — a principle matter, not a size matter. Every
      modified or retired assertion is listed in the review with (i) the originating spec,
      (ii) whether the protected behaviour survives in the rewritten prose, (iii) the replacement
      assertion, or an explicit architect-visible retirement. Silent deletion to make the suite
      green is a project failure, not a test fix.
- [ ] **M12 — no release between the rewrite merge and the SHIP verdict.** M7 gates
      `verify-approval`, not merge, so the rewritten skeleton is on `main` — and therefore
      shippable to adopters via `codev update` — before the A/B has validated it. "Pin the prior
      version" is a reactive remedy for a problem this criterion prevents. If a release must cut
      inside the window, it ships from a commit predating the rewrite merge.
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

Arising from the repository and architect rulings:

- **Principle conformance is the acceptance criterion; size is not.**
- **Both trees**; `CLAUDE.md` ≡ `AGENTS.md`.
- **Four-tier resolution, per file.** No fetch-by-path instruction for a file that may not exist
  on disk (deliver-don't-fetch).
- **No porch behaviour changes** — content rewrite plus a measurement-script fix.
- **Template shape is governed by two separate constraints** (porch's 4 headings; the consult
  type's advisory 20) which must not be conflated.

### Business Constraints

- Two human gates (`spec-approval`, `plan-approval`) plus `pr`; the A/B verdict is the
  architect's call.
- **The architect personally inspects every changed file** (M11) — this is the binding
  throughput constraint on phase design.
- Adopters consume the skeleton via `codev update`, so rollback is a revertible unit per group.
- Scar wordings are architect-ratified; a builder may not compress them.
- **The corrected instrument ships early, as its own PR** (M0b).

## Assumptions

- The eight scar wordings on `builder/spir-1252` remain the ratified set.
- Frontier-model behaviour is stable across the A/B window (mitigated by pairing, same base
  commit, pinned model/config versions).
- `builder/spir-1252` stays undeleted — sole source of the ratified registry.
- CMAP reviewers are blind to the builder's prompt surface by construction.
- The architect has capacity for ~66 file inspections across the implement phases; if not, the
  phase count grows rather than the batch size.

## Solution Approaches

### Approach 1: In-place principle rewrite, surface by surface (RECOMMENDED)

Rewrite each file to P1–P7, keeping file layout, resolver and porch untouched. Templates become
interfaces (P2); how-to content moves to skills (P3, P4); prose restating `protocol.json`
becomes a reference to it (P6); worst-case padding goes except the scar rules (P7). The
instrument is corrected first.

**Pros**: zero mechanism risk; every change is a reviewable text diff — which is exactly what
M11's per-file inspection requires; rollback granularity equals cut granularity.
**Cons**: discipline-dependent; ~66 distinct files to inspect; collides with ~25 prose-pinned
test files (M10).
**Complexity**: Medium · **Risk**: Low-Medium

### Approach 2: Generate prompts from `protocol.json`

Synthesize phase prompts at runtime from the state machine, with a small per-phase prose delta.

**Pros**: the purest expression of P6; structurally prevents drift.
**Cons**: introduces a code path between authoring and serving, changes porch behaviour (an
explicit constraint), and **defeats M11** — the architect cannot inspect old-vs-new diffs of
files that no longer exist as authored artifacts. Couples the rewrite to a mechanism change,
making any A/B regression un-attributable.
**Verdict**: right idea, wrong project — and now also incompatible with the inspection mandate.

### Approach 3: Shared kernel + per-protocol deltas

One protocol-agnostic builder kernel included by every protocol, plus a short per-protocol delta.

**Pros**: directly serves P4 (stop repeating yourself across ten protocols).
**Cons**: 1252 proved dedup buys ~7% on *served* words — an include expands, so it changes
ownership, not the reader's bill. Risks re-creating the shadow-tree bug class, where one edit
silently changes ten protocols' served prompts — which also complicates per-file inspection.
**Verdict**: adopt selectively *inside* Approach 1 where a kernel genuinely serves P4, and only
where the architect can still see what each protocol serves.

## Open Questions

### Critical (Blocks Progress)

*None outstanding.*

### Important (Affects Design)

- [ ] **Batch size for M11.** ≤12 distinct files per review batch is this spec's proposal,
      giving ~6–7 inspection batches. The architect may want smaller.
- [ ] **Do SPIR templates survive as interfaces, or disappear?** P2 says design interfaces;
      porch requires only 4 headings, while the `spec-review` consult type advisorily expects 20.
      Recommendation: survive as heading interfaces.
- [ ] **Is the hot tier in scope?** It is the one surface already written to these principles.
      This spec leaves it unchanged; a reviewer may argue P3 applies to it too.
- [ ] **`roles/architect.md`** — outside 1252's analysis entirely. Confirm nothing in it is
      load-bearing for multi-architect coordination (Specs 755/786/823) before rewriting.
- [ ] **A/B sample size.** ≥6 pairs specified; the architect sets the ceiling given the
      inspection load already on them.

### Nice-to-Know (Optimization)

- [ ] Does rewriting consult-type prompts move CMAP verdict *quality*, or only cost?
- [ ] Are the ~17,000 words of `.claude/skills/` the right destination for P3/P4 relocations,
      or does that surface need its own conformance pass?

## Performance Requirements

No runtime-performance requirement. Reporting obligations only:

- Before/after `ALWAYS_ON_WORDS` and per-audience loads, measured by the corrected script and
  committed (M1).
- Deleted-vs-relocated decomposition (M0c).
- Per-file word counts in every manifest (M2).
- Measurement runtime <5s and deterministic — same commit ⇒ byte-identical output.

None of these is a threshold.

## Security Considerations

- **The scar rules are the security surface.** All eight guard irreversible acts. Weakening one
  is the highest-severity failure this project can produce — hence verbatim carriage, the
  explicit P7 exception, byte-identical enforcement, and a hard rollback trigger on any observed
  violation.
- **Human-gate integrity.** The rewrite must not weaken "a gate message is a notification to the
  human, not authorization." Gate semantics are content, and this project edits content.
- **No secrets in prompt surfaces** — existing property, re-verified.
- **Adopter blast radius.** Skeleton changes ship on `codev update`; a weakened prohibition
  propagates silently. Hence grouped, rehearsed rollback.

## Test Scenarios

Tests verify *mechanical* properties. **Principle conformance is judged by the architect (M11),
not asserted by a test** — that is the point of the revised acceptance model.

### Functional Tests

1. **T1 — Instrument sources the served directory** (M0 item a), asserted against the real
   resolver.
2. **T1b — Instrument resolves per-file, four-tier** (M0 item b). A fixture with a `.codev/`
   override of *one* prompt while others resolve from the skeleton.
3. **T2 — Include expansion (phantom-savings proof).** Moving text from prompt into template
   produces **zero** change in the reported total.
4. **T3 — Word-count reporting.** The script emits a per-file table covering every resolved
   surface. **Asserts completeness of the report, not any ceiling.**
5. **T4 — Scar integrity (M4).** Every canonical byte-identical on every registered surface;
   count pinned at 8; reword or deletion fails.
6. **T5 — Capability inventory (M5).** Post-rewrite extraction over served prompt text ⊇
   pre-rewrite; unlisted removals fail.
7. **T6 — Sweep completeness (M3).** Surfaces enumerated from disk across both trees and
   unioned; absence of `prompts/`/`consult-types/` for a protocol that has none must **not**
   fail; a new surface fails until rewritten and inspected. Covers `release`.
8. **T7 — Twin parity.** `CLAUDE.md` ≡ `AGENTS.md`; every `codev/protocols` file **that has a
   skeleton twin** is byte-identical to it — the assertion runs on the intersection, so the
   three local-only files (`maintain/templates/audit-report.md`,
   `maintain/templates/lessons-learned.md`, `release/protocol.md`) are not failures.
   **Load-bearing for M11**: it is what makes inspecting ~66 files instead of 131 sound.
9. **T8 — Dead-tree removal (M6).** Tree absent; no runtime reference; the Spec 987 routing test
   updated per M10.
10. **T9 — Live spawn probe.** A builder spawned end-to-end on the rewritten surface receives a
    spawn prompt containing every element of the artifact contract, and its first `porch next`
    returns a well-formed task. ("It compiled" is not "it works.")
11. **T10 — Rollback rehearsal (M9).** Reverting a rollback group restores it byte-for-byte and
    leaves the suite green.
12. **T11 — Bucket and audience reporting** (M0 item f). Exclusive bucket subtotals sum to the
    authored total; derived audience loads are asserted against the stated formulas, never a
    naive sum.
13. **T15 — Relocation visibility (M0c).** A fixture moving a block from an always-on surface
    into `.claude/skills/` shows always-on falling **and** total-authored holding steady.
14. **T16 — Manifest completeness (M11).** Every file changed in a phase appears in that phase's
    manifest with all four fields. A changed file missing from the manifest fails the phase —
    the architect cannot inspect what is not listed.

### Non-Functional Tests

1. **T12 — Determinism.** Two runs at the same commit emit byte-identical output.
2. **T13 — Behavioural re-measurement (M8).** `measure-prompt-behavior.ts` re-run post-merge with
   self-exclusion; B1/B2/B4 committed and compared directionally.
3. **T14 — A/B execution (M7).** The full pre-registered protocol below, including a
   **pre-flight assertion per pair**: every surface under test resolves from tier 2 (`codev/`),
   i.e. no skeleton file lacks a `codev/` twin. If that fails, the control arm would silently
   serve the *new* skeleton and the pair is void — so the pre-flight aborts the pair rather than
   producing a comparison that looks valid and is not.

## A/B Validation Design

*(First-class section per Baked Decision 3, and unchanged by the acceptance-model revision: the
A/B is how we learn whether principle conformance actually holds up behaviourally. A
**non-inferiority** trial — the claim under test is "a principle-conformant prompt surface does
not degrade outcomes", not "it improves them".)*

### Unit and arms

The unit is an **issue-pair**: one GitHub issue executed twice, by two freshly-spawned builders
in separate worktrees.

**Arms are a prompt-only overlay on one source snapshot — not two different commits.** An
earlier draft said both "from the same base commit" *and* "control = pre-rewrite commit,
treatment = post-rewrite commit." Those are incompatible, and the naive reading also lets later
pairs inherit source changes the pinned control commit does not have. The construction is:

1. Both arms branch from the **same source commit** `S` (current `main` at pair start).
2. The **treatment** arm uses `S` unmodified — the rewritten prompt surface.
3. The **control** arm applies one **prompt-only overlay commit** on top of `S`: the rollback
   groups (G2–G6) reverted, restoring the pre-rewrite prompt surface and touching nothing else.
4. Each run records **both hashes** — source commit `S` and a `prompt-surface hash` (a digest
   over every file in the disposition table) — so any later audit can prove the arms differed
   in prompts and only in prompts.

This keeps source identical within a pair, lets `S` advance between pairs without contaminating
comparisons, and makes "no code differs" literally true rather than approximately true.

**Precondition**: control-arm isolation depends on tier 2 (`codev/`) shadowing the installed
skeleton (tier 4) for every surface under test — true today (0 skeleton files lack a `codev/`
twin) but silently breakable if the rewrite *deletes* a `codev/` file while keeping its
skeleton twin. Asserted pre-flight in T14.

### Sample and eligibility

- **≥6 pairs (12 runs)**, stratified: ≥3 SPIR/ASPIR and ≥3 lighter protocols (BUGFIX/AIR).
- Issues drawn from the backlog, selected **before** either arm runs, then frozen.
- **Eligibility exclusion**: an issue is ineligible if it modifies any surface under test —
  otherwise the treatment arm's prompt surface is simultaneously instrument and subject.

### Contamination controls

- **Pin the environment**: model ids and reasoning efforts, consult backend versions, and
  `.codev/config.json` frozen for the trial window and recorded with the results.
- **Arm isolation**: the second arm must not see the first arm's branch, PR, or thread.
  Sequential with the intervening branch unpushed, or concurrent in isolated worktrees; which
  was used is recorded per pair.
- **Arm order alternates** per pair.
- **Recording**: one committed artifact (`codev/resources/1280-ab-results.md`), a row per run —
  pair id, arm, protocol, issue, base commit, order, isolation mode, every outcome, and any
  exclusion with its reason.

### Execution and sequencing

- **M7 gates `verify-approval`, not the PR merge.** The rewrite PR merges on principle
  conformance (MP, M11) plus the mechanical criteria; the A/B then runs against merged `main` as
  treatment and a pinned pre-rewrite commit as control. A SHIP failure means rolling back a
  merged change — which is what the grouped, rehearsed rollback plan is for.
- **Arm disposition**: the treatment arm's PR is the merge candidate; the control arm's closes
  unmerged once outcomes are recorded. **~6 of 12 runs produce merged work, not 12.**
- **Architect load**: 6 pairs with ≥3 SPIR-class implies up to **~24 gate approvals and 12 PR
  reviews**, each SPIR gate requiring O1 rubric scoring at approval time — *on top of* M11's ~66
  file inspections. This is the project's binding constraint and why the pair count is the
  architect's call.
- **Release hold (M12).** Because M7 gates `verify-approval` rather than merge, the rewritten
  skeleton reaches `main` before the A/B runs, and adopters would consume it on the next npm
  release. "Pin the prior version" is purely reactive. Therefore: **no `@cluesmith/codev`
  release between the rewrite merge and the SHIP verdict.** If a release must cut inside that
  window, it ships from a commit predating the rewrite merge.

### Pre-registered outcomes

| ID | Outcome | Instrument | Role |
|---|---|---|---|
| **O1** | Gate friction | Architect scores each gate at approval time on a 3-item rubric — *artifact complete as specified? / rework required before approval? / clarifying message needed?* — each 0 (none) / 1 (minor) / 2 (blocking) | advisory + tripwire |
| **O2** | Review rounds | Iterations to terminal state per phase from `status.yaml`; CMAP REQUEST_CHANGES rate (comparable to B1 = 51.88%) | gate |
| **O3** | Correctness | **At the SHIP decision**: architect PR-review findings by severity, observable pre-merge on both arms. **Post-merge defects are excluded from the SHIP gate** and act as a **14-day rollback signal** | gate (pre-merge) + rollback signal (post-merge) |
| **O4** | Protocol compliance | Binary per-run checklist: required artifacts with required headings · stopped at every human gate · no `status.yaml` hand-edit · no `git add -A` · no scar violation · thread committed | **zero tolerance** |
| **O5** | Cost & duration | Tokens, wall-clock, `consult stats` delta | advisory |

### Blinding

CMAP reviewers are blind by construction. The architect is not and cannot be; mitigations: O2
and O4 are extracted mechanically from committed artifacts, and O1/O3 are scored against a
rubric written **before** any run.

### Decision rule (pre-registered)

**SHIP** iff all of:

1. **O4 = zero violations** in the treatment arm. Any scar violation, skipped gate, or missing
   required artifact is an immediate hard stop.
2. **O2**: treatment mean review rounds ≤ control **+ 0.5 rounds/phase**, and treatment
   REQUEST_CHANGES rate ≤ control **+ 10 percentage points**.
3. **O3 (pre-merge part only)**: no treatment-arm finding of severity ≥ "would block merge"
   absent from its paired control run.
4. **O1 tripwire**: no pair where the treatment arm scored **2 (blocking)** at a gate its control
   scored 0, for the same reason. If O1 scoring is incomplete, O1 reports incomplete and SHIP
   rests on 1–3.

Otherwise **HOLD** (fix and re-run the failing pairs) or **ROLLBACK**.

### Honest power statement

With n=6 pairs this detects only **large** effects — roughly a doubling of review rounds or a
≥20-point REQUEST_CHANGES shift. It cannot certify the absence of a subtle regression, and this
spec does not claim it can. It is nonetheless stronger than 1252's observational baseline,
because each pair is matched on the issue itself. **O4's zero-tolerance criterion is where the
real protection lives**: compliance is binary, observable in every run, and is the failure mode
an aggressive rewrite would plausibly cause.

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
  G3, G4, G6). All other groups are mutually independent.
- **Mechanism**: `git revert` restores prior bytes. No migration, state, schema, or data.
  Rehearsed under T10 before the PR merges.
- **Blast radius**: effective for the next spawned builder — in-flight builders keep the surface
  they were spawned with. For adopters the revert ships in the next release; an adopter can also
  pin the prior `@cluesmith/codev` version.
- **Triggers**: (a) any O4 violation — immediate; (b) an observed scar violation in any real
  project post-merge; (c) O2/O3 outside pre-registered margins; (d) the 14-day post-merge O3
  window; (e) architect judgment at any gate.
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
- **Test suites**: the ~25 prose-pinned files in M10 — the rewrite cannot land without
  deliberately re-baselining them.
- **Architect availability**: M11's per-file inspection is a hard dependency on one person's
  time, not a background activity.
- **Libraries/Frameworks**: none new.

## References

- Issue #1280 (charter); #1279 (dead spec/review templates); #1276, #1277 (filed by 1252 —
  superseded here or out of scope); #1032/#1033 (agy `--type` review limitation).
- PR #1278 (Spec 1252, closed unmerged) and `builder/spir-1252`; PR #1290 (early-PR precedent).
- `codev/reviews/1252-prompt-architecture-single-own.md`; `codev/resources/1252-*.md`;
  `codev/state/spir-1252_thread.md`.
- *The new rules of context engineering for Claude-5-generation models* —
  https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models
  (P1–P7 quoted verbatim in **Desired State**).
- `codev/resources/arch.md`; `codev/resources/lessons-learned.md`.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| "Principle conformance" is judged inconsistently across ~66 files | **High** | High | P1–P7 quoted verbatim with a per-file conformance question each; one architect judges all of them; the manifest records which principles were applied per file |
| A deleted instruction was load-bearing; loss is silent | Medium | High | M5 inventory over served prompt text; O4 zero-tolerance; M11 per-file inspection; grouped rollback |
| A scar rule weakened or dropped under P1/P7 | Low | **Critical** | The P7 exception is stated explicitly; verbatim carriage; byte-identical enforcement pinned at 8; architect-only rewording; hard rollback trigger |
| Prose-pinned tests silently gutted to go green | **High** | **High** | M10: every retired assertion named with its originating spec and its behaviour re-asserted or explicitly retired |
| M11 inspection load stalls the project | **High** | Medium | ≤12 files per batch; inspection scoped to ~66 distinct decisions via T7 twin parity, not 131 diffs; phase count grows rather than batch size |
| Sweep misses a protocol, tree, or surface | High | Medium | T6 enumerates from disk (both trees, unioned); T7 twin parity; T16 manifest completeness |
| Relocation reported as deletion | Medium | Low | M0c + M0(g) + T15 (now a reporting-honesty concern, not a grading one) |
| A/B underpowered; subtle regression ships | Medium | Medium | Power statement; O4 binary compliance; T13 post-merge behavioural re-measurement |
| A further instrument defect ships undetected | Medium | Medium | T1/T1b/T11/T15 assert the instrument against the live resolver; M0b puts it under public review early; the script gets its first tests |
| Surface re-grows after the project | Medium | Medium | No ceiling test exists under the revised model; re-growth is caught by the same principle review at the next MAINTAIN |
| `builder/spir-1252` deleted, losing the registry | Low | Medium | The branch exists on `origin` (verified), not only locally; registry content is also quoted in this project's thread; rebuilt registry committed to `main` early |

## Expert Consultation

**Round 1** — 2026-07-31 · Codex (GPT-5.6 Sol) + Claude Opus 5 · both REQUEST_CHANGES (HIGH) ·
**13 findings, none disputed**.
**Round 2** — 2026-07-31, architect-directed re-review · same models · both REQUEST_CHANGES
(HIGH) · **9 findings, none disputed**.
**Round 3** — 2026-07-31, on the acceptance-model revision · Codex REQUEST_CHANGES (HIGH, 5) ·
Claude COMMENT (HIGH, 6) · **11 findings, none disputed**. Both independently caught a
twin-file mislabel in this spec's own inventory (0 files differ; 3 are twinless — my `cmp -s`
loop conflated "differs" with "absent"), and both landed on M5's weakness from different angles
(P6 conflict / inversion-not-detected), which composed into one fix.

Every finding was verified against source (both arithmetic claims independently recomputed)
before acceptance; all are folded into the sections above. The finding-by-finding record is in
`codev/projects/1280-prompt-surface-judgment-not-ru/1280-specify-iter{1,2}-rebuttals.md`.

Five corrections were errors in this spec's own analysis, four sharing one root cause —
**trusting a convenient signal instead of checking the authoritative thing**: a truncated grep;
skeleton-only protocol enumeration; the measurement script's stale comment; and an overloaded
`cmp` exit code read as "differs" when it also means "absent". That is the sweep-scope class
1252 named as its dominant review cost, it is why M3's "enumerate from disk" is a **test**
rather than an instruction, and at five instances it is a `lessons-learned.md` entry the review
phase will route.

Gemini/`agy` did not participate: the known `--type` review limitation (#1032/#1033). Per
current lane policy this 2-way review is correct.

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [ ] Expert AI Consultation Complete

## Notes

**On the acceptance model.** An earlier draft made ">50% reduction" the headline criterion, with
per-surface word ceilings as the binding test. Waleed's redirect removed that: *"I don't think
the goal should be a particular size. That's not the right criteria. It should be to stick to
the principles outlined in the blog post."* This is a better criterion for a reason worth
recording — a word ceiling can be met by a file that still narrates procedure, and can be missed
by a file that is perfectly conformant but genuinely needs the words. Size was a proxy;
conformance is the thing.

**What this project deliberately does not do.** No prompt generator (Approach 2 — now also
incompatible with M11), no tiering of any kind (Baked Decision 1), no porch behaviour changes,
and not 1252's full enforcement machinery — only the scar-integrity check the rewrite makes
necessary. Enforcement built around a still-moving surface is enforcement built twice.

**On the deferred decision from 1252.** The architect's pr-gate ruling was that structural
machinery is not worth carrying for a surface about to be rewritten. That sequencing is honoured:
rewrite first, then enforce what remains.
