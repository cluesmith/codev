# Iteration 1 response — Spec 1280

**No disputes filed.** Every REQUEST_CHANGES point from both reviewers was verified against
source and accepted. This document records what changed and where, so round 2 can check the
fixes rather than re-derive the findings.

Two of the findings were factual errors in my own Current State. Both are the exact class
this spec's principle 7 ("the instrument is part of the deliverable") exists to catch, and
both are recorded in the spec rather than quietly patched.

---

## Codex findings

### 1. Scar-rule accounting contradicts M1/M2 — ACCEPTED

Iteration 1 declared per-surface targets as served-word ceilings *and* said "targets above
are net of this [scar carriage]." Incompatible, and Claude independently computed the
consequence: gross landing 50.2–51.4%, so **M1 would have failed while every per-surface row
passed**.

**Changed**: all ceilings restated **gross**, with a per-row "scar carriage inside" column.
Arithmetic rebuilt (`Desired State`). Carriage is now *exempt from rewriting but counted in
ceilings* — with the corollary stated explicitly: a ceiling a surface cannot meet while
carrying its scar rules is a wrong ceiling, raised deliberately, never met by trimming scar
text. Margin disclosed (3.2 points) and M2 made binding with M1 derived; a 50–52% landing is
a HOLD with named further-cut candidates.

### 2. M0 does not match the runtime resolver — ACCEPTED

Correct: `loadPromptFile` resolves each file independently through the four-tier chain, while
the script does two-tier, directory-level selection. Fixing the directory alone would
reproduce the same defect class one layer down.

**Changed**: M0 now requires per-file four-tier resolution matching `resolveCodevFile`, and
**T1b** is a new test using a fixture with a `.codex`/`.codev/` override of *one* prompt while
others resolve from the skeleton. M0 also now names the hot-tier transclusion and the
segment reporting the architect's directive requires.

### 3. "Gate friction" unchecked under Critical while the A/B assumes it — ACCEPTED

**Changed**: resolved and moved out of Critical. O1 is scored prospectively by the architect
on a 3-item rubric with an explicit 0/1/2 scale, recorded in a committed results artifact at
scoring time, and **demoted to advisory-with-a-tripwire** rather than a SHIP gate. If scoring
is incomplete for any pair, O1 reports incomplete and SHIP rests on O2/O3/O4. (Claude raised
the same single-point-of-failure concern independently and suggested exactly this demotion.)

### 4. A/B contamination controls — ACCEPTED

**Changed**: new **Contamination controls** subsection — model ids/efforts and consult
backend versions pinned and recorded; arm isolation (second arm must not see the first arm's
branch, PR, or thread; sequential-with-unpushed-branch or isolated concurrent, recorded per
pair); alternating arm order; and a committed results artifact
(`codev/resources/1280-ab-results.md`) with one row per run including base commit, isolation
mode, every outcome, and any exclusion with its reason.

### 5. Per-surface rollback independence overstated — ACCEPTED

Correct — prompts, included templates, registry mappings and integrity tests are coupled.

**Changed**: rollback restated as **seven groups** (instrument / shared / builder-spawn /
phase / consultant / architect / scar-registry), each internally consistent, with an explicit
dependency rule: reverting G7 requires reverting every group carrying scar text. T10 rehearses
by group.

### 6. M5's inventory diff not deterministic — ACCEPTED

**Changed**: M5 now specifies a committed pre-rewrite `capability-inventory.json` with
explicit recognition rules per element type (artifact paths, gate names from `protocol.json`,
`<signal>` tags, check ids, `afx send architect` call sites) and normalization (lowercase,
strip backticks/punctuation, dedupe). Post-rewrite must be a superset; removals fail and must
be justified as deliberate retirements.

### 7. Future-dated provenance — ACCEPTED

The architect's instructions carried UTC timestamps (`2026-08-01T02:50Z`, `02:59Z`); local
time was 19:50/19:59 on 2026-07-31.

**Changed**: all dates normalized to **2026-07-31**, with the UTC/local explanation recorded
in the consultation log so the provenance is auditable rather than merely corrected.

---

## Claude findings

### 1. "All existing tests pass" is unsatisfiable — ACCEPTED (highest-value finding)

Verified: `agent-farm/__tests__/baked-decisions.test.ts:143-148` enforces a pure-addition
diff against committed baselines for `protocols/{spir,aspir,air}/builder-prompt.md`, which
the cut plan takes 824 → ≤420. Also verified the shape across
`bugfix-744-spir-pr-strategy.test.ts`, `spec-1273-wait-discipline-docs.test.ts`,
`bugfix-619-aspir-prompt.test.ts`, `template-delivery.test.ts`, `framework-ref-audit.test.ts`,
`governance-sweep.test.ts`, `review-prompt-routing.test.ts`.

The framing is the important part and I have adopted it verbatim in intent: **each assertion
is a prior spec's protection encoded as a grep, so retiring one is a governance act, not a
test fix.**

**Changed**: new criterion **M10** — every modified or retired assertion listed in the review
with (i) the originating spec, (ii) whether the protected behaviour survives in the rewritten
prose, (iii) the replacement assertion or an explicit architect-visible retirement.
Pure-addition re-baselining only with the originating spec named and the new baseline
committed in the same commit. Silent deletion to go green is declared a project failure. Also
added as a Risks row (High/High) and a Dependencies entry.

### 2. M1 and M2 stated on different bases — ACCEPTED

Same as Codex 1; see above. Claude's gross computation (50.2–51.4%) is what made the severity
concrete, and the thin-margin warning is now in the spec as a HOLD rule.

### 3. Two factual errors in Current State — ACCEPTED, both verified

**(a) Hot tier is `@import`ed, not inlined.** Verified `CLAUDE.md:14-15` and
`managed-block.ts:59-67`: #1119 replaced Spec 987's verbatim inlining with `@import` lines
that Claude Code transcludes at session launch. So `wc -w CLAUDE.md` = 5,815 **excludes** the
736 hot-tier words the session actually loads. Baseline corrected **33,519 → 34,255**.

Worth stating plainly: I inherited this from the measurement script's own stale comment
(lines 44–47) while writing a spec whose headline principle is that instruments get audited
against their claims. M0(d) now requires fixing that comment, and the incident is written
into the Problem Statement as principle 7 applied to this spec itself.

**(b) "No code reads `porch/prompts`" is false.** Verified
`review-prompt-routing.test.ts:29` pushes `codev-skeleton/porch/prompts/review.md` onto its
assertion list (Spec 987 hot/cold routing). My cause: I ran `grep -rn … | head -20` and drew
a conclusion from truncated output — the full result is 48 lines. The tree remains dead as
*prompt surface* (no runtime consumer), but M6's stated verification method was wrong.

**Changed**: Current State carries the retraction and its cause; M6 now requires an
untruncated search reconciled against the full hit list, and routes the test consumer through
M10 naming Spec 987. Recorded in the thread as a sweep-scope failure — the class 1252
identified as its dominant review-iteration cost.

### 4. O1 single point of failure — ACCEPTED

See Codex 3. Adopted Claude's suggested demotion.

### 5. A/B arms not as clean as "two checkouts" — ACCEPTED

Sharp catch: for issues touching Codev's own prompt surface, the treatment arm's CLAUDE.md is
simultaneously instrument and subject.

**Changed**: eligibility rule added — an issue is ineligible for the A/B if it modifies any
surface under test.

### 6. Template pressure conflated — ACCEPTED

Verified `checks.ts:149-154`: `REQUIRED_SPEC_SECTIONS` is four headings (Problem Statement,
Current State, Desired State, Success Criteria), not the template's 20; the 20-heading
pressure is the `spec-review` consult type, advisorily.

**Changed**: named as two separate constraints in Current State, so the plan does not
over-preserve template surface for a check that does not require it.

### 7. T3-vs-CI contradiction — ACCEPTED

**Changed**: the Nice-to-Know open question withdrawn; T3 stands and is stated as the
anti-re-growth guard that runs in CI.

---

## Also incorporated this iteration (not from review)

**Architect scope directive** (2026-07-31): scope is the entire prompt surface — architect
role prompts, builder roles and spawn wrappers, consultant/CMAP prompts, phase prompts and
their template includes, `protocol.md` texts — and the instrument must **segment by audience**
so a cut concentrated in one segment while another grows is visible rather than averaged away.

**Changed**: Current State now carries a full inventory of every prompt-bearing surface with
its resolver path and served word count, grouped SHARED / ARCHITECT / BUILDER / PHASE /
CONSULTANT / DEAD. Per-segment ceilings and post-rewrite figures added (builder −53.2%,
architect −61.2%, consultant −33.8%, no segment growing), M0(f) requires per-segment
subtotals, and **T11** proves with a fixture that one segment growing while another shrinks
is not netted to zero.
