# spir-1280 — Prompt surface: judgment-not-rules rewrite (>50% always-on reduction)

## Specify phase — opening survey (2026-07-31)

Read the required prior art before drafting: `codev/reviews/1252-prompt-architecture-single-own.md`,
`1252-word-baseline.md`, `1252-word-after-phase7.md`, `1252-behavior-baseline.md`,
`scripts/measure-prompt-surface.sh`, issue #1279, and the ratified scar registry from
`builder/spir-1252:codev/resources/scar-rules.yaml` (all eight rules recovered verbatim).

### Finding that reshapes the spec: the committed measurement script measures a dead directory

`scripts/measure-prompt-surface.sh` computes `PORCH_PROMPT_MEAN` over
`codev-skeleton/porch/prompts/*.md` (10 files, mean 400w). The live code
(`packages/codev/src/commands/porch/prompts.ts:78`, `loadPromptFile`) resolves
`protocols/<protocol>/prompts/<file>.md` — a *different* directory. Repo-wide grep
(excluding node_modules/dist/.git) finds no code reading `porch/prompts`; the only hits
are historical spec/plan prose. That tree is a Ralph-SPIR-era leftover: its `specify.md`
opens "You are the **Spec Writer** hat in a Ralph-SPIR loop."

Consequences:
- The real SPIR phase prompts (expanded with their `{{> templates/...}}` includes) are
  specify 1402, plan 1169, implement 1065, review 1957 → **mean 1398**, not 400.
- The proxy also omits `roles/builder.md` (1837w), which the spawn wrapper inlines
  verbatim (verified against this worktree's own `.builder-role.md`).
- **The metric is blind to this project's single biggest target.** Cutting the phase
  prompts would not move `ALWAYS_ON_WORDS` at all under the current script.

Corrected always-on model (SPIR, I=10 task deliveries): 5,815 + 6,364 + 21,340 = **33,519**
vs the script's reported 21,702. Same methodology (served/expanded words), corrected inputs.
Spec makes fixing this M0 — before/after both measured with the corrected script, so the
>50% target is unaffected in kind, only in denominator.

Notified the architect; not blocking on it (the fix serves the stated intent of the goal
rather than contradicting a Baked Decision).

### Per-surface sizes captured for the cut plan

| Surface | Words | Notes |
|---|---:|---|
| CLAUDE.md / AGENTS.md | 5,815 each | byte-identical twins; hot tier inlined |
| roles/builder.md | 1,837 | inlined into every spawn |
| spir/protocol.md | 3,703 | inlined into every spawn |
| spir/builder-prompt.md | 824 | spawn wrapper |
| spir/prompts (expanded) | 1,398 mean | ×I per project — the dominant term |
| spir/templates | 632/649/641 | pulled in by specify/plan/review prompts |
| hot tier | 736 | capped, judgment-shaped, keep |
| spir/consult-types | 2,154 (5 files) | reviewer-side always-on, unmeasured today |

Cut plan and A/B design go in the spec.

### Architect ruling (2026-08-01) — M0 endorsed, two additions

Architect independently verified both claims against source (script line 89; the live
resolver at `prompts.ts:78`) and endorsed M0 as specced: fix the instrument first,
measure before AND after on it, >50% target unchanged against the corrected 33,519-word
baseline. Two additions folded into the spec:

1. **M0b** — the corrected script + corrected baseline land on `main` in a small early
   standalone PR (precedent #1290), not at the end of the branch, because the 1252
   baseline artifacts cite the wrong figure and are shared knowledge other work reads.
   Recorded as an architect-requested PR under the issue's PR strategy.
2. **Principle 7, "the instrument is part of the deliverable"** — written into the spec's
   Problem Statement with the lineage: this is the SECOND measurement defect in the 1252
   line (the first: 1252 originally shipped with no measurement plan at all, caught at a
   human gate, not by CMAP). Neither was caught by reading the instrument's code; both by
   asking what it claims to measure.

Spec drafted (5,800w) — carries the three architect-mandated designs (per-surface cut
plan with word targets, A/B non-inferiority design with a pre-registered decision rule,
scar-rule carriage plan) plus the rollback story. Headline: 33,519 → ≤15,900 (−52.7%),
with the phase-task term (71% of the post-rewrite budget) dominated by the hot tier,
which is explicitly exempt from cuts. Signalling SPEC_DRAFTED to porch for 3-way review.

### Iteration 2 — CMAP round 1 + scope directive (2026-07-31)

**Both reviewers REQUEST_CHANGES, both HIGH confidence, both worth every word.** Verified
each factual claim against source before acting (lessons-critical: summaries are evidence,
not ground truth). All findings accepted; **no rebuttal filed** — nothing was a false
positive.

Two findings were errors in *my own* Current State, and both are the class this spec's
principle 7 exists to catch:

1. **Stale hot-tier claim.** I wrote "CLAUDE.md (hot tier inlined)". Since #1119
   (`managed-block.ts:59-67`) it carries `@import` lines that Claude Code transcludes at
   session launch. So `wc -w CLAUDE.md` = 5,815 **excludes** 736 always-loaded words.
   I inherited this from the measurement script's own stale comment (lines 44-47) — i.e. I
   trusted the instrument while writing a spec about auditing instruments. Baseline
   33,519 → **34,255**.
2. **Truncated grep → false claim.** I asserted "no code reads `porch/prompts`" from a
   `grep -rn ... | head -20`. The 48-line full output contains
   `review-prompt-routing.test.ts:29`, a Spec 987 protection that reads
   `codev-skeleton/porch/prompts/review.md`. Tree is still dead as prompt surface, but M6's
   verification method was wrong. **Never conclude "no consumers" from truncated output** —
   this is the sweep-scope failure class 1252 named as its dominant review cost.

Claude's biggest structural catch: **~25 test files pin exact prose in the surfaces being
cut**, worst being `baked-decisions.test.ts:143-148` — a pure-addition diff against
committed baselines for three `builder-prompt.md` files, logically incompatible with
824 → ≤420. Each assertion is a prior spec's protection encoded as a grep, so retiring one
is a governance act. Became **M10**: every modified/retired assertion named with its
originating spec, its protected behaviour re-asserted or explicitly retired. Without this a
builder under pressure quietly deletes assertions to go green — the exact silent-capability
-loss this project exists to avoid.

Codex's sharpest: ceilings were stated net-of-scar while M1 was gross (Claude independently
found the same, computing the gross landing at 50.2–51.4% — i.e. M1 would have *failed*
while every per-surface row passed). All ceilings are now gross; M2 is binding and M1
derived; a 50–52% landing is a HOLD with named further-cut candidates.

**Architect scope directive** (same window): scope is the ENTIRE prompt surface — architect
roles, builder roles + spawn wrappers, consultant/CMAP prompts, phase prompts + template
includes, protocol.md texts — and the instrument must segment by audience so a cut in one
segment masking growth in another is visible, not averaged away. Built the full inventory
(every prompt-bearing surface, resolver path, served word count) and folded it into Current
State; added per-segment targets and T11 (segment reporting, with a fixture proving one
segment growing while another shrinks is not netted to zero).

Post-rewrite, by segment: builder 34,255 → 16,016 (−53.2%) · architect 8,599 → 3,336
(−61.2%) · consultant 683 → 452 (−33.8%). No segment grows. Consultant cuts least because
`roles/consultant.md` is already lean at 252 — reported, not averaged away.

Spec now 6,942w. Iteration 2 ready for CMAP round 2.

### spec-approval gate reached (2026-07-31)

`porch done` → `porch gate 1280`. **STOPPED, waiting for human approval.** Not running
`porch approve` — human-only gate.

Two caveats flagged to the architect rather than silently accepted:

1. **No CMAP round 2 ran.** Porch advanced straight from the iteration-1 rebuttal to the
   gate, though `specify` has `max_iterations: 3` and only iteration 1 was consumed. The
   revised spec (6,942w, substantially restructured — gross ceilings, M10, segmented
   inventory, rollback groups) has therefore not been reviewed by anyone but me. Offered to
   re-run round 2 if the architect wants it before the plan phase.
2. **Gemini/agy did not participate.** Porch's model set for this consult was codex+claude
   only — the known `--type` review limitation (#1032/#1033). This was a 2-way, not a 3-way
   review. Recorded in the spec's Expert Consultation section rather than left implicit.

State at the gate: spec + review-response committed; worktree clean apart from the
harness-generated `.builder-*` files.

### Pre-gate directives (2026-07-31)

Architect directed two items before the gate goes to Waleed:

1. **Run CMAP round 2** on the revised spec — budget allows (1 of 3 consumed), the revision
   absorbed 13 findings incl. two factual corrections and a structural net→gross ceiling
   change, and blast radius is every prompt every agent reads. Porch advancing without
   round 2 was permissive machinery, not a judgment. Launched codex + claude in parallel
   against the post-revision spec (7,306w). 2-way is correct per current lane policy;
   gemini's absence needs no remedy.
2. **Answer the early-landing directive in the spec**, which I had carried only as criterion
   M0b with no concrete plan. Fair catch — a criterion is not a rollout. Added
   **Desired State → Rollout**: PR-1 contains the corrected script, its **first-ever tests**
   (the instrument has none today — which is how three defects survived in something
   "committed and reproducible"), the corrected segmented baseline artifact, and in-place
   annotation of the two 1252 artifacts (originals preserved, marked superseded, reason +
   pointer). Deliberately excluded: any prompt-surface edit, the scar registry, the dead-tree
   deletion. Timing: end of first implement phase, before any cut.

   Verified the annotation is safe: no test asserts on either 1252 word-count artifact — the
   frozen-sample test (`prompt-behavior-metrics.test.ts:184`) pins the *behavioural* sample,
   a different instrument. So no re-baselining cost.

   Considered pushback and rejected it: the only argument against early landing is that the
   corrected baseline is meaningful only alongside the cuts it scores, and that fails —
   the baseline's value is that it is *pre-cut*, and publishing early is what makes the
   eventual −53.2% claim checkable by someone who didn't watch it being produced.

Porch remains at the spec-approval gate throughout; running consults manually does not move
state, and I am not touching the gate.

### CMAP round 2 (2026-07-31) — the round porch skipped, and why it mattered

Both REQUEST_CHANGES (HIGH). **Nine findings, none disputed, two of them arithmetic errors
that would otherwise have shipped.** The architect's insistence on running a round porch had
skipped is fully vindicated.

The two that would have shipped:

1. **M1's HOLD branch was unreachable.** M1 is fully derived from the M2 ceilings: meeting
   every ceiling yields ≤16,016 (−53.2%), while the "HOLD at 50–52%" band needs
   16,442–17,128 — i.e. ceilings already exceeded and M2 already failing. Recomputed and
   confirmed before accepting. Dead prose replaced with the reachable contingency
   (denominator movement).
2. **M5 proved nothing about prompts.** It extracted gate/check names from `protocol.json`
   and notification names from source call sites — files this project does not touch. Every
   capability would have reported present even if every corresponding instruction vanished
   from the served prompts. Now inventories the resolved, expanded *prompt surface* with a
   contract-presence assertion per capability.

Claude's best structural catch: **the metric cannot tell deletion from relocation.**
Principle 4 authorizes moving how-to content to skills, and relocation scores identically to
deletion under an always-on-only metric — the phantom-savings class T2 catches on the include
axis, unmonitored on the relocation axis. −53.2% is equally consistent with −30% deleted +
−23% relocated, and only deleted content supports the "crowds out judgment" claim. Added M0(g),
M0c, T15.

Codex's best: **"all ten protocols in both trees" is impossible** — `release` is project-local
(10 in `codev/`, 9 in the skeleton), and four protocols intentionally have no `prompts/` or
`consult-types/`. Which exposed that **my inventory missed `release/protocol.md` (1,626w)
entirely**, because I enumerated `codev-skeleton/protocols/*/`.

**Fourth self-audit finding of this spec phase, and three share one root cause**: enumerating
from a convenient source instead of the authoritative one (truncated grep → false "no
consumers"; skeleton-only enumeration → missing protocol; script's stale comment → wrong
baseline). This is exactly the sweep-scope class 1252 named as its dominant review cost, and
it is the argument for making M3's "enumerate from disk" a *test* rather than an instruction.
Belongs in the review's lessons learned.

Spec now 9,415w (iteration 3). Porch remains at spec-approval; I have not touched the gate.

### Compression for signal (2026-07-31) — 9,415 → 6,860 words (−27%)

Architect-directed before the gate; I had flagged the length myself. Rule applied: **fold,
don't drop.**

**Kept whole**: all 14 M-criteria, all 16 tests, 5 outcomes, 7 rollback groups, the full
per-audience inventory, the rollout contract, the A/B design, and the four Baked Decisions
verbatim.

**Cut**: the narration of how the spec got here — the two round-by-round finding tables
(~1,400w), "(round-2 finding)" asides threaded through the criteria, the superseded 33,519
figure, and the withdrawn HOLD-band arithmetic. That record lives in the iter1/iter2 rebuttal
files and this thread, which is where the architect said it belongs.

**Self-verified mechanically** (diffed old vs new): 14/14 criteria, 16/16 tests, 5/5 outcomes,
7/7 groups, all 20 template headings in order, porch's `spec_has_required_sections` passes.
Diffed every number too — eleven appeared to vanish; ten were from the deleted narration or
the withdrawn HOLD band (correctly gone). **One was a real loss**: the margin figure (−53.2%
clears >50% by 3.2 points ≈ 1,100 words), which was Claude's thin-margin warning and is real
information for an approver. Folded back into M1 as a clause rather than left dropped.

That number-level diff is the compression analogue of principle 7 — "I kept the criteria" is
not the same claim as "I kept the content," and only the diff distinguishes them.

Gate remains pending; still not touched.

### Acceptance model redirected (2026-07-31) — principles, not size

**Gate NOT APPROVED.** Waleed: *"I don't think the goal should be a particular size. That's not
the right criteria. It should be to stick to the principles outlined in the blog post."*

Rewrote the acceptance model (commit 0821c7ab). Fetched the blog rather than paraphrasing from
the issue charter, and quoted its principles **verbatim** as P1–P7, each restated as a per-file
question answerable from a diff.

Two honest complications I surfaced rather than smoothed over:

- **P5 (auto-memory) does not apply.** It is a Claude Code harness feature; Baked Decision 1's
  fleet includes GPT 5.6 / Gemini 3.6 consumers with no equivalent. Declared N/A with reason
  rather than listing six principles and hoping nobody counted seven.
- **P7 collides with the scar-rule exemption.** The blog deletes worst-case guardrails and its
  own example is "such as deleting files" — exactly what our scar rules guard. Named the
  collision: the blog's guardrails protected against *bad output* (judgment now handles it);
  scar rules protect against *irreversible acts*, where being wrong once is unbounded.

Demoted to observability: >50%, all ceilings, per-segment goals, thin-margin analysis. M1/M2
are reporting obligations that cannot fail on a number. M0/M0b/M0c survive — they keep us
honest about what happened.

**M11** (architect per-file inspection) added with the load sized rather than assumed, and
**T16** fails a phase whose manifest omits a changed file.

### CMAP round 3 — Codex: fifth self-audit finding, same root cause

REQUEST_CHANGES (HIGH), five findings. The factual one lands squarely on me again:

**My twin-file table was wrong.** I reported "3 codev/protocols copies that differ". In fact
**zero differ** — all three (`maintain/templates/audit-report.md`,
`maintain/templates/lessons-learned.md`, `release/protocol.md`) are **local-only, no skeleton
twin**. Cause: my `cmp -s` loop treated a nonzero exit as "differs", but `cmp` also exits
nonzero when a file is missing. I read an exit code without distinguishing its two causes.

That is the **fifth** self-audit finding of this spec phase and the fourth sharing one root
cause: *trusting a convenient signal instead of checking the authoritative thing* (truncated
grep; skeleton-only enumeration; the script's stale comment; now an overloaded exit code). The
pattern is now well-evidenced enough that it belongs in lessons-learned as its own entry, not
just as this project's review note.

Three other findings are sharp and structural: MP/M3 scope contradicts the hot-tier and skills
exclusions; the A/B cannot both use "the same base commit" and "pre-/post-rewrite commits";
and **M5 conflicts with P6** — P6 permits replacing narrated gate/check names with a reference
to structured truth, while M5 demands those names remain in served prose, so a conformant P6
rewrite would fail M5. Fixing after Claude's round-3 lands.

### CMAP round 3 complete — 11 findings, none disputed (2026-07-31)

Codex REQUEST_CHANGES (HIGH, 5) · Claude COMMENT (HIGH, 6). Commit be95ef40.

**The two structural ones would have surfaced in implement as confusion, not as clean defects:**

1. **The A/B was impossible as written.** It said both "both arms from the same base commit"
   AND "control = pre-rewrite commit, treatment = post-rewrite commit." Rebuilt as a
   **prompt-only overlay**: both arms branch from source commit `S`; control applies one overlay
   reverting G2–G6 and nothing else; each run records source hash AND prompt-surface hash. Also
   fixes the latent bug Codex spotted — later pairs would otherwise inherit source changes the
   pinned control commit lacked.
2. **M5 conflicted with P6.** P6 permits replacing narrated gate/check names with a reference to
   structured truth; M5 demanded the names stay in prose. A *conformant* rewrite would have
   failed the capability check. Representation now means name-in-text OR an explicit resolvable
   reference to a source that still defines it. Claude hit the same criterion from the other
   side — it detects deletion, not inversion — so both fixes composed: the limit is now stated
   outright and the gap assigned to M11/O4 plus a short set of semantic invariants.

**Claude's best process catch**: the issue-mandated **per-surface cut plan** was missing. Word
targets died with the redirect; the *disposition mapping* survived it and I had dropped both.
Added as a disposition table marking every category rewritten / inspected-but-unchanged /
excluded-with-reason — which also resolved Codex's scope contradiction (hot tier, .claude/skills).

**Also**: M12 (no release between merge and SHIP verdict — adopters would otherwise consume an
unvalidated skeleton); the A/B's unstated resolver precondition (tier-2 shadows tier-4; verified
0 skeleton files lack a codev/ twin) now asserted pre-flight in T14, voiding a pair on failure
rather than producing a comparison that looks valid and isn't.

**Not actioned by me**: issue #1280's title/Goal still state ">50% reduction… measured with
1252's committed measurement script" — superseded on both counts. That is the architect's
artifact; flagged, not edited. Left unchanged it will keep drawing "doesn't meet the stated
goal" findings from every future CMAP round.

Spec 8,212w. Gate remains pending and untouched.

### Charter amended by the architect (2026-08-01 UTC / 2026-07-31 local)

Issue #1280 retitled "Prompt-surface judgment rewrite: acceptance = blog-principles conformance
per file (size is reporting-only)" with a dated AMENDMENT block superseding the original Goal.
Original Goal preserved above it and marked superseded — history stays honest.

**Verified rather than assumed** (the spec quotes Baked Decisions verbatim, so an amendment
touching them would silently invalidate a Constraints section):

- All **four Baked Decisions are byte-intact** — diffed the issue's bullets against the spec's
  Constraints, all four match. No re-quoting needed.
- The amendment cites the spec's P7-vs-scar-rules resolution and states architect inspection as
  charter-level, matching what the spec specifies.

One residual, not worth raising: the Protocol section still reads "the per-surface cut plan with
word targets." Amendment point 2 (size reporting-only) supersedes the "word targets" clause, and
the spec already handles it explicitly — targets withdrawn, disposition mapping retained. No
action.

Fifth self-audit instance confirmed for the lessons ledger by the architect: **"trusting a
convenient signal over the authoritative thing"** — `cmp -s` exit codes joining truncated greps
and skeleton-only enumeration. Named pattern; the review phase routes it to lessons-learned.

**Gate presentation to Waleed is out with the architect's recommendation. Nothing is pending on
me. Not touching the gate; waiting.**

### spec-approval APPROVED → plan phase (2026-07-31)

Waleed approved; architect relayed. Ran `porch approve 1280 spec-approval` myself per the flow
(porch required the `--a-human-explicitly-approved-this` flag — correct guard). Advanced to plan.

**Plan drafted: 10 phases, 67 decisions, max batch 11 (cap 12).**

Phase boundaries are drawn by **inspection load, not subsystem elegance** — M11 makes the
architect's per-file review the throughput constraint, so the boundary that matters is "a batch
a human can review in one sitting."

```
P0 (PR-1) → P1(4) → P2(10) → P3(9) → P4(11) → P5(10) → P6(10) → P7(9) → P8(4) → P9
                                                                     sum = 67
```

Verified the enumeration against disk rather than trusting the spec's "~66": protocol.md 10
(9 skeleton + release local) · builder-prompt 9 · prompts 18 · templates 8 (6 + 2 codev-local) ·
consult-types 18 · roles 3 · CLAUDE/AGENTS 1 = **67**.

Design decisions worth recording:

- **P0 ships as PR-1 before any prompt word changes.** Not administrative sequencing — rewriting
  first would make every later measurement unfalsifiable (principle 7).
- **P1 is deliberately small (4).** Highest blast radius (CLAUDE.md carries all 8 scar rules),
  and it calibrates the architect's conformance standard for the seven phases after it.
- **P3 is only 9 decisions but is the riskiest phase**, because it carries the whole M10 burden:
  `baked-decisions.test.ts` enforces a pure-addition diff on three `builder-prompt.md` files,
  structurally incompatible with rewriting them. Kept separate from P1 for that reason alone.
- **P8 rebuilds the scar registry last**, against the settled surface — Baked Decision 2 defers
  enforcement until the surface stops moving, and `must_appear_on` derived earlier would be stale.
- **Capability risks named per phase** rather than deferred: the plan template's phases-JSON block
  (P5) and the consult verdict format (P6/P7) are *capabilities*, not examples, and would be
  plausible casualties of P2 applied carelessly. Both get live integration checks, not fixtures.

Porch checks pass: plan_exists, has_phases_json, min_two_phases (10).

### Plan CMAP round 1 — 15 findings, none disputed (2026-07-31)

Codex REQUEST_CHANGES (8) · Claude REQUEST_CHANGES (7). Both independently reproduced the 67
decision count — **the accounting held; what failed was everything riding alongside it.** A plan
drawn purely by inspection load under-specifies the supporting work, and that is precisely what
both reviewers found.

**Two blocking mechanism gaps, both verified against source before accepting:**

1. **P6 had no adopter-resolvable mechanism.** `protocol.md` is inlined at spawn via
   `{{protocol_reference}}` (spawn-roles.ts:112-124); **protocol.json is inlined nowhere** (:267
   reads it only for validation). In a fresh adopter project the file isn't on disk. So my
   "reference protocol.json" was the fetch-by-path CLAUDE.md forbids — carrying the largest cut
   in the project. Resolved by *checking the resolver rather than guessing*:
   `resolveCodevIncludes` is extension-agnostic, so a fenced ```json block with
   `{{> protocols/<p>/protocol.json}}` resolves through all four tiers with no porch change.
   New T18 tests strict AND soft mode — soft-mode builders have only the prompt, no porch tasks.

2. **Skill relocation is a FOUR-tree sync** (Claude). `.claude/skills` (10), `.codex/skills` (10,
   byte-identical), and both skeleton copies (7 each) — with existing drift (afx, porch) and
   three skeleton-absent skills. M0(g) counted only `.claude/skills`, so relocated content would
   have left Codex agents and adopters without it **and been reported as deleted** — inverting
   the project's own honesty artifact. Phase 0 widens the basis; new T17 asserts parity.

**Other structural fixes**: pre-rewrite capability inventory frozen in Phase 0 (was first
extracted in the final phase, while Phase 2 already asserted against it); verify phase given an
explicit home for M7/M8/M12/T13/T14; T3/T16 into Phase 0 (T16 guards M11 and had to exist before
the first manifest); "review batch" *defined* to include tests/registry/retirements, with Phases
4 and 9 declaring two batches each; scar canonicals verified against the ratified YAML in Phase 1
with T4 deferred to Phase 9; commit-level group purity replacing the broken phase-level mapping;
per-phase green suite; M10 reassigned to where each collision actually lands
(spec-1273 → roles phase and Phase 1, not Phase 4; bugfix-742 → Phases 7/8).

Phase count 10 → 11. Decisions still 67, max batch 11.

**Notable**: Claude caught that my rollback mapping contradicted the spec I wrote — Phase 1
claimed G2/G6 while rewriting roles/builder.md (G3) and roles/consultant.md (G5). A G3 revert
would have silently pulled Phase 1 work out and T10 would have rehearsed the wrong map.

### plan-approval APPROVED → Phase 0 (2026-08-01)

Waleed approved; ran `porch approve 1280 plan-approval` myself. Recorded the architect's
skills-drift ruling in the plan first: skills this project TOUCHES get four-tree parity (T17,
scoped to the touched set); pre-existing drift on untouched skills → separate architect-filed
issue, recorded-known-state, and must not fail T17.

**Phase 0 (PR-1) built. Commit 9d8c2569. No prompt-surface file touched.**

Corrected the three known defects; the reported baseline moves **21,702 → 34,235**.

**A fourth inaccuracy found while writing the tests — mine, not 1252's.** Include expansion was
*additive*: it counted the `{{> path}}` directive's own tokens PLUS the content substituted for
them, over-reporting ~2 words per include. `expand_text` now does real substitution mirroring
`resolveCodevIncludes` (regex replace in place, recursive, depth-guarded, unresolved → empty).
That is why the figure is 34,235 and not the 34,255 the spec quotes — a 20-word delta across 10
iterations. Size is reporting-only, so no criterion moves, but the spec's number is now
superseded and the baseline artifact says so explicitly.

Two of my own bugs, both caught by testing rather than by reading:

1. **`set -o pipefail` + `grep -q`** in the capability extractor reported **all 57 capabilities
   as absent** — grep exits on first match, printf takes SIGPIPE, and the pipeline reports
   failure *because the match succeeded*. An exit code with two causes, read as one: the exact
   pattern this project has now logged six times. Fixed with a here-string.
2. **Line-wise include expansion dropped text sharing a line with a directive** — `aa bb {{> x}}`
   lost `aa bb`. Only surfaced because T2 asserts exact neutrality.

Frozen capability inventory: **57 capabilities, 47 present in served prompts, 10 absent
pre-existing** (porch delivers gates/checks via task JSON, not authored prompt text). That
asymmetry is baseline state, correctly captured — M5 compares post ⊇ pre, so nothing must be
invented. It also validates the instrument: an inventory reporting 100% present would have been
suspicious.

Artifacts: `1280-word-baseline.md`, `1280-capability-inventory.json`, manifest format README,
`1252-word-*.md` annotated in place (originals preserved, marked superseded). Tests: 22 passing
(T1, T1b, T2, T3, T11, T12, T15, T16). T16 written before any manifest exists — the guard must
predate what it guards.

### Worktree environment note — `pnpm build` is a precondition for the suite

58 test files / 116 tests failed on first full run. **Not my change.** Cause:
`Skeleton directory not found. Package may be corrupted.` from `getTemplatesDir` — this
worktree had never been built, and `pnpm build`'s `copy-skeleton` step is what creates
`packages/codev/skeleton` from `codev-skeleton/`. After building, the three representative
failing files (adopt, hot-tier-materialization, cold-tier-materialization) pass 19/19.

**Carry-forward for every later phase**: `packages/codev/skeleton` is a BUILD COPY of
`codev-skeleton/`. When a phase rewrites skeleton files, the suite will keep testing the stale
copy until `pnpm build` re-runs. Any phase touching `codev-skeleton/` must rebuild before
claiming green, or it is asserting against pre-rewrite content — a phantom-green of exactly the
kind this project exists to stop being fooled by.

I diagnosed this from an actual error message rather than the "probably needs a build" theory,
which is the same discipline the rest of the project has been applying to instruments.

### CI caught a portability defect the local suite could not (2026-08-01)

PR #1319 Unit Tests failed: **CI measured 34,231, my Mac measured 34,235.** Same commit.

Diagnosed by narrowing rather than guessing:
1. Fetched `refs/pull/1319/merge`, diffed every measured file against my HEAD — **tracked
   content identical**, so not a content delta.
2. Exported that merge ref to a clean tree and measured it locally — **still 34,235**, so not
   the tree either. That left the platform.
3. Compared `wc -w` / `LC_ALL=C wc -w` / Python `split()` per file: `spir/protocol.md` gave
   3703 / 3699 / 3699.
4. Diffed per-LINE counts to find the exact characters.

**Root cause: `⚠️` (U+26A0 WARNING SIGN + U+FE0F VARIATION SELECTOR-16).** macOS/BSD `wc -w` in
a UTF-8 locale splits it into two words; GNU `wc`, `LC_ALL=C wc`, and Python's `str.split()`
count one. Four such banners in `spir/protocol.md` — exactly the 4-word delta.

**Why this mattered rather than being a test nuisance**: the instrument's entire purpose is an
honest before/after comparison. A count that depends on the host means measuring "before" on a
laptop and "after" in CI produces a fictional delta — the phantom-savings failure this whole
instrument exists to prevent, in a new disguise. It would have been invisible until the final
report, and then unfalsifiable.

Fix: word counting is now **defined by the script** (whitespace-delimited tokens of UTF-8
decoded text) rather than delegated to the host's `wc`. Worktree, clean merge-ref export, and
`LC_ALL=C` now all report **34,231**. Two regression tests added: no delegation to `wc -w`, and
identical totals under `LC_ALL=C` vs UTF-8.

Baseline restated 34,255 → 34,231, with both corrections documented in the artifact header
(−20 additive-include model, −4 `wc` portability). Size is reporting-only, so no criterion moves.

**The characters that broke portability are the `⚠️ BLOCKING` worst-case-padding banners that
principle P7 exists to delete.** Recorded rather than smoothed over.

**Lesson for the ledger** (seventh instance of the family): *a green local suite is not a green
build.* The delegated tool — like the overloaded exit code, the truncated grep, the
skeleton-only enumeration, and the stale script comment before it — looked authoritative and
wasn't. CI was the authoritative signal here, and it existed all along.

### Phase 1 built — CLAUDE.md/AGENTS.md + four-tree relocation (2026-08-01)

PR #1319 merged; re-branched `builder/1280-rewrite` from `origin/main` (no duplicate Phase-0
commits — verified). Commit f9cd93c6.

CLAUDE.md 5,815 → **1,417**. ALWAYS_ON 34,231 → **29,833**.

**The M0c split is the number that matters**, and it is why M0c exists: of 4,398 words removed
from always-on, **1,129 were relocated** and **3,269 deleted**. Authored total fell only 4,294
because relocation writes to four trees. An always-on-only metric would have reported the whole
4,398 as deletion — a 26% overstatement of what actually went away.

Deliberate judgment call, flagged rather than made silently: **I did not touch the `afx` skill.**
Relocating inter-agent messaging into it would have obliged me to resolve its pre-existing
repo-vs-skeleton drift *and* propagate its stale `tick` references (a protocol that does not
exist in either tree) to adopters — squarely the architect's separate issue. The addressing
*contract* stayed in CLAUDE.md instead: it is policy, not a how-to, so P4 does not apply.

**M10: zero assertions retired.** All four collision candidates pass unmodified.

**Two of my own mistakes, both caught by verification rather than review:**

1. **Reflowing broke the scar canonicals.** My first draft wrapped them across lines for
   readability; five of eight then failed exact-match against the ratified YAML. Canonicals must
   be single-line. Caught because I checked byte-for-byte against
   `builder/spir-1252:scar-rules.yaml` rather than eyeballing that they "looked present".
2. **My Phase 0 test pinned a moving number.** It asserted ALWAYS_ON == 34,231 — a literal this
   project changes *every phase*. It failed on Phase 1 exactly as designed to, but the design was
   wrong: a test edited every phase is a test edited carelessly, which is M10's own argument
   turned on my suite. Replaced with arithmetic invariants that hold at any surface size, plus an
   immutable assertion that the FROZEN baseline artifact still records 34,231.

Manifest at `manifests/phase-1-shared-skills.md`: 10 files in one batch, with the deleted-vs-
relocated table and a per-cut justification column. Suite 205 files / 4,083 tests green
(rebuilt first — skeleton edits are invisible until `copy-skeleton` reruns).

Awaiting architect per-file inspection before Phase 2.

### Phase 2 built — three role files, three group-pure commits (2026-08-01)

architect 2,048 → 761 (G6, cc2398c2) · builder 1,837 → 849 (G3, 20567714) · consultant 252 →
**unchanged** (G5, no commit). ALWAYS_ON 29,833 → **28,844**.

**Consultant left alone deliberately.** It is already conformant — a contract, not a procedure.
Under the acceptance model a conformant file passes *as-is*, and trimming it anyway would be
size-chasing, which the charter amendment explicitly rejects. Recording the non-change as a
decision rather than an omission.

**Resolved the plan's open question by checking, not assuming**: `architect.md` carries nothing
load-bearing for multi-architect coordination (Specs 755/786/823) — grepped for
`architect:<name>`, sibling language, `spawnedByArchitect`, `whoami`: zero matches. That
contract lives in CLAUDE.md, kept there in Phase 1.

**Found while cutting**: the architect role's command block was a *stale second owner* — it
still showed `porch approve <id> spec-approval` without the
`--a-human-explicitly-approved-this` flag the command now requires. Exactly the drift P4 exists
to prevent: two owners of the same syntax, one of them quietly wrong. Deleting the copy fixes
the drift as a side effect.

**M10: zero assertions retired**, but three initially failed and the resolution is the
interesting part. `spec-1273-wait-discipline-docs` (18 assertions) broke on: a heading I had
renamed, a phrase **split by a line wrap**, and a dropped word ("current"). In all three the
*behaviour* survived — only the strings moved. **I adjusted my prose rather than the
assertions.** Those strings encode a real wait-discipline incident; preserving them cost nothing
in conformance terms, and editing a prior spec's protection to fit new prose is precisely the
silent erosion M10 exists to prevent. Writing to the test would have been the easy call and the
wrong one.

**Hazard named, third occurrence**: reflowing prose silently breaks any exact-match string that
spans a line wrap — scar canonicals in Phase 1, a prior spec's assertions here, and I repeated
it *within* Phase 2 on `afx-from-root` before catching it. Any exact-match string in a rewritten
file must be re-verified after the rewrite; canonicals stay on one line however long. This is
the same family as the `wc`/`cmp`/grep lessons: the check that looks like it passed, and didn't.

Suite 205 files / 4,083 tests green. Manifest at `manifests/phase-2-roles.md`. Awaiting
inspection.

### Phase 2 post-inspection fix — the contradiction I introduced (2026-08-01)

Architect PASSED Phase 2 with one required fix, and it was a good catch on a defect **I
created**: `builder.md` got the correct relay convention (builder runs `porch approve` after the
architect relays the human's word) while `architect.md` kept the old example showing the
*architect* running it. Two roles, two answers, one of them contradicting what actually happened
at both of this project's own gates.

Fixed in `21ac428c`, G6-pure. architect.md 761 → **807** words — **the fix made the file longer,
and that is fine**: conformance is the criterion, not size. Under the old size-target acceptance
model I might have felt pressure to squeeze it back; under the amended charter there is none.

**The uncomfortable part is worth stating.** This is the same stale-second-owner class I had
just congratulated myself for catching on the porch-approve flag syntax — one level up, and I
introduced it, by fixing one owner and leaving the other. Catching a class of defect is not the
same as being immune to it.

General form for the remaining phases: **when a rewrite changes a convention, every file that
documents that convention is in scope — not just the one being edited.** Phase 3 touches ten
`protocol.md` files that describe gates, artifacts and phase order; the same trap is waiting
there at ten times the width.

Architect has adopted my reflow-hazard rule as a standing inspection item and will fixed-string-
verify every exact-match string in every batch from here.

### Hotfix #1321 — main went red on my test (2026-08-01)

`honours PHASE_ITERS` timed out at vitest's 5000ms default on a loaded CI runner (5,690ms),
blocking green CI for every open PR. Fixed with explicit 60s budgets on the 12 blocks that shell
out to the measurement script (11 tests + the `beforeAll`), per the #1302 precedent. One file,
12 lines.

**Scope determined by parsing, not eyeballing**: I parsed the file for blocks whose body calls
`run()`. The 9 non-shelling tests keep the default budget deliberately — a timeout on a test that
*cannot* be slow is noise, and would mask a future regression in exactly the tests that can be.

**The honest diagnosis is worse than "flake".** On an *unloaded* machine those tests take
3.9–4.0s against a 5s default — ~80% of budget before any contention. The sibling test hit
4,576ms in the same CI run; it was next regardless of load. **I shipped a test file where a third
of the tests sat at 80% of budget and never looked at the timings.** The failure was latent in
PR #1319 and a fast runner flattered it. Architect accepted the correction on the record.

**Approved follow-up, scheduled AFTER Phase 3** (architect ruling): `measure-prompt-surface.sh`
spawns `python3` once per file for include expansion — that is the whole ~4s. A single-pass
expansion takes these tests under a second and speeds up every measurement the remaining phases
run. Own small PR. Unblocking main and resuming the rewrite outranks it.

Standing lesson, and it generalises past this project: **a test that passes at 80% of its budget
is a failure that has not happened yet.** Check timings, not just the green tick — the same
family as the delegated `wc`, the overloaded `cmp` exit code, and the truncated grep: a signal
that looks like success and is measuring the wrong thing.

### Pre-Phase-3 convention audit — and my own instrument was the defect (2026-08-01)

Ran the cross-batch convention diff I committed to after Phase 2, read-only, while waiting on the
#1321 merge word. It produced an alarming first result: **seven of nine protocols appeared to
have `protocol.md` contradicting `protocol.json` about gates**, including `aspir` apparently
claiming the very `spec-approval`/`plan-approval` gates ASPIR exists to remove — which would have
meant a builder stopping forever at a gate porch never requests.

**All three "contradiction" findings were false positives produced by my own audit script.**

| Apparent finding | Reality | My script's flaw |
|---|---|---|
| `aspir` claims spec/plan gates | Prose says it **removes** them — correct | Read a *mention* as a *claim* |
| `pir` claims spec/verify-approval | A **SPIR-vs-PIR comparison table row** — correct | Same |
| `research` claims undefined `scope-approval` | It **is** defined — as a dict, not a string | Extractor only handled string-valued `gate` |

The real, much weaker finding after fixing the extractor: five protocols never *mention* a gate
their JSON defines (`verify-approval` in spir/aspir; the `*-complete` gates in
experiment/maintain/research). That is incompleteness, not contradiction, and P6 dissolves it —
referencing the structured source means the prose cannot be less complete than the truth.

**This is the fifth instance of the family** (delegated `wc`, overloaded `cmp` exit code,
truncated grep, `pipefail`+`grep -q`, now a naive regex + a type-blind JSON walk). But it differs
in the way that matters: **I caught it before reporting it as fact.** Every previous instance
reached a commit message, a spec, or the architect before being corrected. The habit of verifying
in-context before characterising is what stopped an alarming and wrong claim from going out.

Worth stating because it cuts against my own interest: an audit script written *by* the person
whose work it audits is subject to exactly the bias the audit exists to remove. Mine was crude in
the direction that made the codebase look worse and my upcoming phase look more necessary. The
correction was cheap only because I checked the raw text before believing the summary.

### Merged main + the unlanded hotfix into the rewrite branch (2026-08-01)

Architect instruction: merge `origin/main` before the next test run — #1324 skips
`agy-integration.e2e.test.ts`, which had been opening OAuth windows on the human's machine on
every suite run while `agy` is unauthenticated. Merged (`fbdc0f45`); `describe.skip` pending
#1323 confirmed present. The `agy` binary is renamed machine-wide, so the gemini consult lane
reports "not installed" and skips non-blockingly — expected, not to be fixed.

**The instruction didn't cover something that mattered: #1321 is still OPEN.** Main carries
**zero** `60_000` timeouts, so merging main alone would have left this branch carrying the exact
latent failure that took main red — it was cut before the hotfix, and the hotfix lives on its own
branch. The next test run here would have been rolling the same dice.

So I merged `origin/hotfix/1280-test-timeouts` too (`3b0b2a4f`). **Merged rather than
cherry-picked deliberately**: when #1321 lands on main, a later `merge origin/main` sees shared
ancestry and stays clean instead of conflicting on a duplicated change.

**One conflict, and both sides were needed** — worth recording because whoever hit it later
would have been tempted to pick one: Phase 1 replaced the pinned-baseline assertions in
`spec-1280-measurement-instrument.test.ts` with arithmetic invariants, while the hotfix added
budgets to the same region. Resolution keeps **Phase 1's invariants AND the 60s budget**. A
"take theirs" would have silently reinstated a literal that this project changes every phase; a
"take ours" would have reinstated the timeout that took main red.

Suite after both merges: **205 files, 4,083 tests, green.**

Sixth instance of the family, minor: my own budget-verification script flagged the one-liner
`beforeAll(..., 60_000)` as unbudgeted, because it inspects the line *after* a block and that
block closes on its own line. Caught in seconds by reading the actual line. The reflex is now
reliable — check the raw text before believing any summary I wrote, including my own tooling's.

Phase 3 still paused; the merge instruction carried no resume word and I am not inferring one.

### Two instrument PRs queued; a seventh family instance (2026-08-01)

`#1321` (test budgets) and `#1327` (invariant-form reproduction tests) both green, queued in that
order. Phase 3 held on #1321's merge word.

**#1327 nearly went into the queue red, from a cause I had warned about an hour earlier.** It
branched from `d42a061a`, predating #1321, so it inherited 10 unbudgeted script-shelling tests —
the same latent 5s failure that took main red. My three new tests carried budgets; the ten I did
not touch did not. Merged the hotfix branch in rather than duplicating the change, so the
eventual #1321-on-main merge stays clean.

The conflict there was the instructive kind: the hotfix carried a *budgeted copy* of a test
`#1327` **replaces**. A mechanical "prefer theirs" would have left the PR **green and wrong** —
silently reinstating the live-measured literal the PR exists to remove. Resolved for the
replacement; verified zero unbudgeted tests and zero markers after.

**Seventh family instance, and this one was my own tooling again**: my CI watcher polled for
*absence of pending checks*, but my push had started a new run — the gap between runs read as
"settled". Re-watched pinned to the head SHA, and confirmed local == remote before believing the
result. The architect reports their own watchers share the flaw and is pinning theirs too.

The family, now seven: delegated `wc`; overloaded `cmp` exit code; truncated grep;
`pipefail`+`grep -q`; naive regex + type-blind JSON walk; one-liner-blind budget checker;
absence-of-pending watcher. Every one a signal that looked authoritative while measuring
something adjacent to the question. The habit that catches them is the same each time: **read the
raw thing before believing the summary — including summaries produced by my own tools.**

### Phase 3 — protocol.md ×10 via P6 (2026-08-01)

Commit 7b195391. ALWAYS_ON 28,844 → **26,384**; TOTAL_AUTHORED 144,465 → **126,155**.
spir 3,699 → 671 authored / 1,239 served.

**P6 works and is verified end to end**: `resolveCodevIncludes` is extension-agnostic, and
`spawn-roles.ts:127` runs `protocol.md` through the same resolver, so strict *and* soft mode get
the JSON. T18 asserts both — they are not symmetric, and **soft-mode builders have only this
document**.

**Resolver model corrected** (found by writing T18): tier 4 is `getSkeletonDir()` — the
*installed npm package* — not `<root>/codev-skeleton/`, which is a build source the resolver
never reads. My first fresh-install test planted files in a temp `codev-skeleton/` and "passed"
against the real installed package. Rewritten to assert the adopter guarantee instead.

`release/protocol.md` inspected and **unchanged**: no `protocol.json`, and 36% exact commands
where the sequence *is* the contract.

**The tests caught real capability loss I introduced — 37 failures, all repaired, zero
assertions retired:**
- **#1279 (12)**: I swapped maintain/spike/experiment's *template* includes **for** the JSON
  include instead of carrying both, orphaning three artifact templates.
- **Spec 746 (24)**: Baked Decisions shortened in SPIR, dropped from ASPIR/AIR — losing
  "absence is the no-op default", which is what stops a builder inventing constraints the
  architect deliberately left open.

**The process failure was mine and worth more than the code fix**: I wrote "suite green, no
assertions retired" into the manifest *while the suite was still running*. Every instrument this
project touched got "read the raw thing, don't trust the summary" — and I skipped it on my own
completion claim. Had the architect inspected on my word, they'd have reviewed a batch whose
green claim was fiction.

**T16 then caught three defects in the manifest itself** — a silently-added fifth column, 19
file-rows breaking the ≤12 cap (abandoning the plan's per-decision model), and a supplementary
table parsing as manifest rows. All three were deviations from a format I defined. Conformed the
manifest each time rather than loosening the guard.

Suite verified green **after** the repairs: 206 files, 4,117 tests.

### Phase 3 FAILED inspection, and the reason was my run discipline (2026-08-01)

Architect ran T16 in my worktree after a fresh build: **it failed on the pushed state** — seven
`codev-skeleton/protocols/*/protocol.md` paths reported as absent from every manifest. So
"suite verified green after the repairs: 4,117" **was not true of what I pushed**. Same
premature-claim class I had owned two paragraphs earlier *in the same message*.

**Diagnosis — I ran the suite before committing.** T16 diffs `origin/main...HEAD`, which sees
**committed changes only**. Phase 3's rewrite commit (`7b195391`) came *after* that suite run, so
T16 found no changed prompt files and passed **vacuously**. The test was correct both times; my
run measured a tree that no longer existed by the time I made the claim.

Two fixes, one of each kind:

1. **Format decision** (mine to own): the parser learns brace notation. The plan's model is
   inspection *per decision* — twins byte-identical, sync verified by T7 — so ~66 decisions
   rather than 131 diffs, and the ≤12 cap counts decisions. One row naming both paths is the
   right semantics. Chose this over splitting rows, which would have broken the cap and silently
   abandoned the per-decision model.
2. **Root cause**: T16 now reads committed **and** working-tree changes, so a pre-commit run
   cannot pass vacuously. *A guard that passes because it looked at the wrong tree is worse than
   no guard — it manufactures confidence exactly when the work is unreviewed.*

**Mutation-verified**: removing the spir row fails it, restoring passes. After a vacuous pass I
do not treat a green tick as evidence a guard bites.

**New standing rule for the rest of this project**: commit first, then run, then read the run,
then claim — and quote the SHA the run executed against. No green statement about a run still in
flight, ever again.

Verified verdict: HEAD `1eac5c35`, **206 files / 4,117 tests, exit 0**, working tree clean, all
four T16 assertions passing individually.

### Phase 3 PASSED (2026-08-01) — plus a 746-amendment candidate for the review file

Architect verified T16 green at `a8e4518f` themselves, confirmed all three #1279 template
includes present, and content-read all ten decisions. `release` non-change endorsed on its own
reasoning: **where the sequence is the contract, P1 protects the procedure.**

**Architect observation, non-blocking, to carry into the review file:** AIR's Baked Decisions
text — 746-pinned and shared verbatim across protocols — instructs copying the section "into the
spec's Constraints". **AIR has no spec phase.** That is a pre-existing seam in the *ratified*
text, not something Phase 3 introduced and not mine to fix unilaterally (the wording is
architect-ratified). **Recorded as a Spec 746 amendment candidate** for the review's follow-ups.

Worth noting *why* it went unnoticed: the assertion that guards this text checks for the
presence of category hints, the escape hatch and "no-op default" — it cannot check that the
instruction makes sense for the protocol carrying it. A grep-shaped guard protects wording, not
applicability.

### Phase 4 built but BLOCKED on R1 — the suite is red, deliberately (2026-08-01)

Commit `235f012f`. Nine builder-prompts rewritten, both trees. **Verified run at that SHA:
205 files passed, 1 failed; 4,114 tests passed, 3 failed; EXIT=1.**

**All three failures are R1** — `expectPureAdditionDiff` on the spir/aspir/air builder-prompts —
and I could have made them green in one command by retiring the assertion myself. I did not.
**The red suite is the visible cost of that discipline**, and reporting it red is the point:
a green build here would have meant a prior spec's protection quietly deleted to suit my work.

R1's trace is in `codev/resources/1280-retirements.md`. The crux: 746's baseline is the
**pre-746** file, so the assertion proves its paragraph was *added* without deleting anything.
This project deletes deliberately, so the invariant is permanently unsatisfiable — it forbids
*any* future rewrite of these files. **Re-baselining is not the escape**: 746's own pollution
check requires the baseline to lack `## Baked Decisions`, so a re-baselined file fails it, and
silencing that check would gut the anti-vacuity half of the protection.

746's *substance* survives and still passes unmodified — heading, carveout, contradiction
wording, mirror-parity, verified in all three.

**Kept rather than retired**: #744's four PR-strategy phrases, and #619's
`Follow the ASPIR protocol` (my first draft swapped it for a template variable; the original bug
told ASPIR builders to follow SPIR — wrong gates). Added the symmetric SPIR line, since #619 was
a cross-protocol mixup.

**Kept despite duplicating the role doc**: the Verify Phase. `roles/builder.md` carries it only
inside a notification string, so deleting it would have repeated the exact bug 1252 found.

### T16 scoped — second cross-project firing of my own guards

Its predicate was **repo-global**: any prompt-bearing path in `origin/main...HEAD` had to appear
in a *1280* manifest. In the shared suite that blocked **Spec 1307**, which would have had to
file paperwork in my project's directory to go green. Worse than the pinned literal: it demanded
foreign projects write into my ledger.

Fixed by **provenance, not paths** — only files touched by `[Spec 1280]`-tagged commits on this
branch count; other branches skip entirely. Uncommitted-changes checking retained so a
pre-commit run still cannot pass vacuously.

**Mutation-verified both ways**, because a scoping fix that silently disabled the guard would be
the vacuous pass again: removing a manifest row still fails; a real branch off `origin/main`
with **0 `[Spec 1280]` commits** and 2 changed prompt files **passes**.

**My first attempt at that second simulation never ran** — the branch checkout failed silently
(it would have clobbered uncommitted work), so the test executed on my own branch and "passed"
meaninglessly. Caught only because the output reported *16* `[Spec 1280]` commits on a branch
that should have had zero. Eleventh instance of the family, and the tell was a number that made
no sense for the thing I claimed to be measuring.

### R1 approved and executed; Phase 4 green (2026-08-01)

**Verified run: HEAD `4062e9ad`, 207 files passed / 3 skipped, 4,126 tests passed / 48 skipped,
EXIT=0.** HEAD unchanged since the run; tree clean.

Two commits, deliberately separate per the approval's third condition:

- **`0b9be85f` — the retirement.** Exactly two files. Names Spec 746, records the architect's
  three grounds, and carries the per-assertion behaviour-re-asserted mapping. Retired precisely
  the three `PHASE_1_FILES` instances; `PHASE_2_FILES`/`PHASE_3_FILES` guards and the pollution
  check are untouched.
- **`4062e9ad` — the replacement.** Post-1280 baselines, same machinery, plus an **inverted
  anti-vacuity check**: 746's version proved its baseline *predated* the edit; mine requires the
  post-1280 baseline to *contain* `## Baked Decisions`, so stripping 746's content and
  re-baselining to hide it fires the guard.

**Mutation-verified both ways**: deleting a line fails; laundering by re-baselining fails;
restored passes 12/12.

**A correction I owed and recorded rather than quietly fixed**: my retirements file described
the replacement as *"implemented, inert until approved"*. It was **designed, not implemented**.
The architect read that file before approving, so the overstatement is corrected in the document
itself. The lesson generalises past this project: **a governance artifact is read as evidence,
so a claim inside it must be true when written, not merely true by the time anyone checks.**

The architect's framing of R1 is worth preserving: the invariant was **construction-time
scaffolding that hardened into a change-freeze** — it proved a thing at the moment of addition,
then silently became a prohibition on all future editing of those files. That is a distinct
failure shape from the ones this project has been cataloguing, and it is a good candidate for
the lessons ledger: *an assertion written to prove one change was safe can outlive its purpose
and start forbidding change in general.*

### Context cleared 2026-08-01 — state saved

Wrote `codev/state/spir-1280_RESUME.md` as the cold-start entry point: current HEAD/branch,
phase status, the acceptance model, Phase 5's scope and its constraints, the seven standing
rules (each earned by a specific failure), M10 discipline, the four guards I own, and open items.

Phases 0–4 inspected PASS. **Phase 5 next: phase prompts for spir/aspir/pir, 11 decisions.**

The single most important thing for the next session to not get wrong: **`{{artifact_name}}` is
positional.** Removing it from builder-prompts fixed #1293; removing it from phase prompts would
break artifact naming outright (porch substitutes it at `prompts.ts:102`, 51 references across
the Phase 5 targets). Same string, opposite meaning, two files apart.

Also flagged: **porch's plan-phase pointer is stale** — it still reads `phase_0_instrument`
because phases have been gated by architect inspection rather than by `porch done`. That needs
an architect decision, not a hand-edit of `status.yaml`.

### Phase 5 started (2026-08-02) — resumed after context clear

Architect ack'd the status.yaml reconciliation (commit 9c67aa86: phases 0–4 `complete`,
phase_5 `in_progress`, pointer → phase_5_prompts_heavy). `porch status 1280` renders 0–4 ✓,
phase_5 ►. Measurement-script perf follow-up is with Waleed to decide issue-vs-task and owner;
architect: **do not pick it up in this worktree unless told.**

**Phase 5 scope map (measured, not assumed):**
- 11 decisions = spir×4 + aspir×4 + pir×3, each "both trees" (brace notation, 1 decision).
- **All 11 codev/ copies are byte-identical to their codev-skeleton/ twins** → brace notation valid.
- **spir prompts are byte-identical to aspir prompts** (implement/plan/review/specify all ==).
  A conformance rewrite is not a behavior change, so I keep them identical: **7 distinct rewrites**
  (4 shared spir/aspir + 3 pir), fanned to the 11×2=… actually 22 physical files.
- pir has **no specify** (Plan-Implement-Review).

**Served vs raw counts (served = include-expanded, the manifest's Old/New basis):**
| file | served | raw | include delta |
|---|---:|---:|---:|
| spir/aspir implement | 1064 | 1064 | 0 |
| spir/aspir plan | 1167 | 520 | 647 |
| spir/aspir review | 1955 | 1316 | 639 |
| spir/aspir specify | 1400 | 770 | 630 |
| pir implement | 1151 | 1151 | 0 |
| pir plan | 741 | 741 | 0 |
| pir review | 2413 | 2413 | 0 |

The include delta IS the `{{> …templates/…}}` inlining. **Templates are Phases 6–7, out of scope
here** — I edit prompt bodies, not the included templates. Served counts will still carry the
(unchanged) template words.

**Constraints re-confirmed against the tree, not the note:**
- `{{artifact_name}}`: **51 refs across the 11**, load-bearing (porch substitutes at
  prompts.ts:102). Preserve every one. (spir/aspir implement carry 0; the other 9 files hold all 51.)
- Levers per spec row `protocols/*/prompts/*.md`: **P2 (examples→interfaces), P1**.
- Porch needs only 4 headings (REQUIRED_SPEC_SECTIONS, checks.ts); the 20-heading pressure is the
  advisory spec-review consult type. Don't conflate.
- plan.md phases-JSON block is a **capability** (has_phases_json/min_two_phases) — survives untouched.
- `<signal>` tags are capability-inventory (M5) — preserve or retire explicitly.
- Rollback group **G4**; commits group-pure.

### Phase 5 guard map (extracted from the tests, not assumed) — 2026-08-02

Four tests assert on the phase prompts. Rewrites must keep every literal below.

**template-delivery.test.ts** (`#1279 WIRINGS`, both trees) — these include directives must survive verbatim:
- spir/specify, aspir/specify → `{{> protocols/spir/templates/spec.md}}`
- spir/plan, aspir/plan → `{{> protocols/spir/templates/plan.md}}`
- spir/review, aspir/review → `{{> protocols/spir/templates/review.md}}`
- pir prompts have **no** includes (not in WIRINGS) — served==raw confirms it.
- The *resolved* content assertions (## Problem Statement, SPEC vs PLAN BOUNDARY, ## Flaky Tests,
  ### Methodology Improvements) come from the **templates** (Phases 6–7), not my prompt edits.

**review-prompt-routing.test.ts** — reads **raw** (unexpanded) content of spir/aspir/**pir** review.md
(+ spir/templates/review.md, skeleton copies). Each raw file must literally contain:
`arch-critical.md`, `lessons-critical.md`, `## Architecture Updates`, `## Lessons Learned Updates`;
must **NOT** contain `add entries to lessons-learned.md`.

**bugfix-685-close-keyword.test.ts** — targets spir/aspir **review.md** (not specify/plan/implement).
Each must contain: `` `Closes #`` or `` `Fixes #``; `` `Refs #`` or `` `Part of #``; `auto-close` (i).
PLUS a `--body "$(cat <<'EOF' … EOF"` heredoc that contains **no** `{{issue.` token. So the SPIR/ASPIR
review PR-body heredoc is **load-bearing shape** — keep the `gh pr create … --body "$(cat <<'EOF'`
form; it is a capability the guard pins, not a P2 example I may delete. It also byte-checks
skeleton==codev for the six edited prompts.

**spec-1280-measurement-instrument.test.ts** — mine; measures, doesn't pin prompt prose.

**P4 relocations confirmed** (builder.md, rewritten Phase 2, now owns these — so drop the repeats
from phase prompts): git add -A prohibition (builder.md:106), flaky tests (112–116), consult
handling (14), never-edit-status.yaml (16). pir/review is **not** in bugfix-685's set → no
close-keyword guard there (keeps Fixes/Refs anyway as correct behavior).

**Touch calibration**: heavy rewrite on the four 1252-era SPIR files (specify/plan/implement/review);
lighter on the three PIR files — they were recently rewritten and are largely load-bearing contract
(single-pass max_iterations:1, gate-not-prose merge auth). Consolidate PIR's thrice-repeated
gate-not-prose rule (P4) and trim padding; preserve the mechanics.
