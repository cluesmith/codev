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
