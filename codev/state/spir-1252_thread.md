# spir-1252 — Prompt architecture: single-owner rule

## Specify phase — measurement first

Before drafting, I measured the actual prompt surface rather than trusting the
issue's "~45k words / 4–6 duplicates" estimate. Two findings changed the shape
of the spec.

### Finding 1: the real duplication axis is the `codev/` ↔ `codev-skeleton/` shadow tree

The issue lists CLAUDE.md/AGENTS.md, hot-tier docs, protocols, phase prompts,
roles, skills. It never mentions the largest one: **63 markdown files
(45,183 words) exist in BOTH `codev/protocols/` and `codev-skeleton/protocols/`**,
plus `codev/roles/` ↔ `codev-skeleton/roles/`.

This is not benign. Tier 2 (`codev/`) *wins* over tier 4 (skeleton) in the
four-tier resolver, so our self-hosted instance runs on the local copies —
and **19 of them have drifted** from the skeleton.

### Finding 2: the drift is live and it bit this very builder

`codev/protocols/spir/builder-prompt.md` (636 words, served) is missing the
entire **"Multi-PR Mechanics"** and **"## Verify Phase"** sections that
`codev-skeleton/protocols/spir/builder-prompt.md` (824 words, shipped) has.

My own spawn prompt has no verify-phase instructions. Adopters get them; we
don't. That is the drift failure mode, demonstrated, not hypothesized.

`codev/protocols/spir/protocol.md` differs from the skeleton by 138 diff lines.
Last touched by the same merge commit (d49f5f47, 2026-06-13) — they were forked
and left to rot.

### Finding 3: duplication count is worse than the issue estimated

The `git add -A` prohibition appears in **18 logical locations** (36 files
counting the shadow mirror), in **9 distinct wordings** — from
"Never `git add -A` / `.` / `--all` — stage files explicitly" to a full
"🚨 ABSOLUTE PROHIBITION 🚨" block. Not 4–6; and the wording variance is the
ambiguity cost the issue predicts.

### Measured surface (words)

| Surface | Words | Files | Load |
|---|---|---|---|
| CLAUDE.md | 5,773 | 1 | every session, auto |
| AGENTS.md | 5,773 | 1 | byte-identical twin |
| arch-critical + lessons-critical (HOT) | 736 | 2 | in CLAUDE.md *and* every phase prompt |
| arch.md + lessons-learned.md (COLD) | 41,510 | 2 | on demand |
| codev-skeleton (all) | 77,956 | 113 | resolver-dependent |
| codev/protocols (shadow) | 47,511 | 66 | wins over skeleton |
| .claude/skills | 16,743 | 14 | on demand |
| my actual spawn prompt | 4,891 | — | once per builder |
| my actual porch phase task | 1,395 | — | per phase iteration |

### Consequence for the spec

The issue framed this as a compression problem ("token cost"). The measurement
says the *drift* problem is bigger and more urgent than the token problem, and
that the shadow tree is where both concentrate. I am specifying accordingly:
ownership map + shadow-tree elimination first, compression second. Deduplication
of scar rules stays off the table per the issue.

Existing enforcement machinery to build on (not reinvent): `governance-sweep`,
`hot-tier`, `skeleton`, `protocol-prompt-audit`, `framework-ref-audit`,
`skill-parity` test suites.

## Specify iter-1 — 3-way consultation

Gemini APPROVE / Codex REQUEST_CHANGES / Claude COMMENT. Codex and Claude each
found real problems. I accepted all nine issues; two of them corrected factual
errors of mine.

### The one that mattered most (Claude)

I claimed "no test asserts that codev/protocols/ matches
codev-skeleton/protocols/." **That was wrong.**
`packages/codev/src/lib/protocol-drift-audit.ts` (#1210) already exists —
`auditProtocolDrift()`, `FRAMEWORK_DRIFT_DIRS = ['protocols','consult-types',
'roles']`, classifying `identical | differs` — and `codev doctor` already calls
it at `doctor.ts:947`.

So drift has been *detected and reported all along*. Our 17 drifted files were
visible to `codev doctor` and ignored. The gap is not detection; it is that
nothing **fails the build**. That narrows M2 enormously: wire the existing
audit into a CI gate, don't write a detector.

### Count corrections (Claude)

My "19 drifted" conflated drifted files with local-only ones. Actual: **17**
(16 protocols + 1 roles). Separately there are **3 local-only** entries —
`release/` and two `maintain/templates/` files — which must survive deletion.
Added test T8 for that. Clarified 63 `.md` / 73 `md+json` / 76 including roles.

### Structural fixes (Codex)

Codex was right that the spec's end state depended on unanswered critical
questions, and that M2 permitted two incompatible outcomes. Restructured:
M1–M7 are required and Q1-independent; M8–M10 (deletion) are conditional on
architect approval. Added Appendix A (ownership-map schema + what an
"instruction class" is), Appendix B (compatibility audit), Appendix C (tiering
selector/fallback/scope).

### What I found while verifying Codex's feasibility concern

Codex claimed many literal `codev/protocols/` references exist. True — 26
non-test, 95 in tests. But checking them changed the picture twice:

1. **`scaffold.ts` exports `copyProtocols`/`copyRoles`** which copy the skeleton
   into `codev/`. I briefly thought this meant every adopter has a shadow tree.
   Then I grepped for callers: **neither is called by init, adopt, or update.**
   They are dead code. So adopters have NO shadow tree — ours is a historical
   artifact from when scaffolding did copy. That *strengthens* the deletion
   case (deleting makes us match adopters) and adds M9: remove the dead
   functions before someone rewires them.
2. **Production consumers route through the resolver** (`consult/index.ts:175`
   → `readCodevFile`; `porch/protocol.ts` → `resolveCodevFile`). The rest are
   comments and error strings. No direct-read consumer found — deletion is
   lower-risk than iter-1 judged.

A1 rewritten accordingly: iter-1 asserted "unintentional fork" without
establishing why; now it is evidence-backed.

### Still architect-owned

Q1 (may the shadow trees be deleted) and Q3 (is the scar list complete) are not
mine to answer. The spec no longer *depends* on Q1 — a "no" simply drops
M8–M10 and still ships B + C.

## Held at spec-approval gate — awaiting full architect decision set

Architect directed an iter-2 review, then countermanded ~40s later: amend the
spec with the *complete* decision set first, then run a **single** iter-2
review against the fully-amended spec. Sensible — reviewing a spec that shifts
underneath the reviewers wastes a round.

State when the countermand landed: I had made the Q2 amendment but had **not**
launched any consult. Nothing to abort.

**D1 recorded (answers Q2)**: skeleton is authoritative for all 17 drifted
files, reconciled file-by-file — classify each divergence as *missing content*
(take skeleton) or *possible deliberate local content* (**escalate, never
silently overwrite**). Governs M3. Explicitly does NOT decide Q1: reconciling
the files and deleting the tree are separate acts, and D1 holds either way.

**Frozen pending answers**: Q1 (shadow-tree deletion → M8–M10) and Q3 (scar
registry contents → M5) and Q4 (tiering selector). Added a "Pending — do not
act" clause under Architect Decisions so the constraint is legible to anyone
reading the spec, not just to me.

Making no further spec edits until the full decision set arrives.

## Specify iter-2 — decisions D1–D4 absorbed, second 3-way review

Architect relayed the full decision set: D1 skeleton-authoritative, D2 delete
approved (+ local-unique safeguard), D3 eight scar rules compressed, D4 tiering
cut. Amended spec (442cc08a), then ran iter-2.

**Verdicts: Gemini APPROVE / Codex REQUEST_CHANGES / Claude APPROVE.**
6 points, all accepted. Iter-1 drew 9 issues; iter-2 drew 6, only 2 blocking —
and both were "your enforcement has a hole," not "your analysis is wrong."
Codex and Claude each independently re-verified the empirical basis; it held.

### The hole worth remembering (Codex CX-1)

M4/T7 iterate over the ownership map's entries and check each has one owner.
**A map listing 3 of 40 instruction classes passes cleanly.** Tests green,
artifact looks rigorous, single-owner rule covers a fraction of the surface,
nothing signals the gap.

I built the exact disease this spec attacks — enforcement that measures only
what you already told it about — into the fix for it. Fixed with a declared
inventory boundary + mechanical candidate extraction + mandatory
mapped/scar/out-of-scope disposition + T12 failing on anything undispositioned.

Added unprompted: T12 must be validated against a *seeded* normative line. A
completeness test over an empty candidate set passes vacuously and looks
identical to a healthy one. Having just been caught by one vacuous-pass hole,
leaving another in would be careless.

### CX-2 — escalation is a transition, not a destination

M11 said "escalate to the architect" and stopped. No terminal state, so the
criterion couldn't be judged complete or incomplete. Added TS1–TS4, made
"pending escalation" explicitly non-terminal, completion = all 76 in TS1–TS4
with zero open escalations.

Judgement call flagged to the architect: unresolved escalation converts to TS3
(keep local, documented, allowlisted) + follow-up issue, rather than
hard-blocking. Trades a little residual shadow tree for a guarantee the project
can't stall on an unanswered question. Also marked TS2 (promote into skeleton)
as *preferred* over TS3 — TS3 knowingly re-creates a shadow copy, and if it
became the default the spec would quietly rebuild what it removed.

### Smaller but real (Claude CL-2)

Split T13 into automated CI assembly-check (a) + one manual real spawn (b).
Keeping (b) matters: (a) can pass while the live spawn path reads different
files — which is *exactly* how this project's own prompt lost its Verify Phase
section. An ambiguous "inspect the prompt" would have collapsed into (a) alone.

Gemini independently endorsed the M11 → M3 → M8 sequencing and the M5-before-C
scar chain — both builder-originated, so worth recording that they survived
outside review.

No open questions remain. Back to the spec-approval gate.

## Plan phase — 8 phases drafted

Spec approved (human approval relayed via architect; I ran `porch approve` per
the workspace convention that the builder executes it, architect never does).

**One ordering decision beyond what the spec fixed.** The spec pins
`M11 → M3 → M8` and "M5 green before Approach C," but says nothing about where
scar compression sits relative to deletion. Compressing eight rules across ~36
files when half get deleted two phases later is wasted work — and worse, risks
reconciling a compression edit against a skeleton that never got it. So
**Phase 5 (scar compression) runs AFTER Phase 4 (deletion)**, still well before
Phase 7 (dedup). Satisfies the real constraint; avoids the trap.

Phases: 1 drift gate + baseline · 2 local-unique audit · 3 reconcile ·
4 compat audit + removal · 5 scar registry · 6 ownership map · 7 dedup +
measure · 8 governance sync + E2E.

Four of eight phases land before a single duplicated word is removed. That's
deliberate — the spec's finding is that drift, not token count, is urgent, and
D2 requires nothing codev-specific be lost.

Notes to self for implementation:
- Phase 1's allowlist starts POPULATED with the 17 drifts (justified "pending
  Phase 3"). A gate that fails on commit is a gate someone disables.
- Phase 5's real risk is meaning loss, not brevity. Each compressed wording must
  retain prohibition + scope + any escape hatch (rule 2's "use --resume, and ask
  when in doubt"). Dropping the escape hatch turns guidance into a dead end.
- Phase 7: report the N1 figure honestly even if under 20%. Likely shortfall is
  structural — most always-on words are CLAUDE.md prose that's already
  single-owned, not duplicated rules. Do NOT strip content to hit a number.
- Phase 8 must file the D4 tiering follow-up issue.

## Plan iter-1 — 3-way review

**Gemini APPROVE / Codex REQUEST_CHANGES / Claude APPROVE.** 6 points, all
accepted. None changed phase structure, ordering, or scope — all six were
"specify this existing phase more precisely."

### Codex CX-1: I implemented half of my own criterion

M10 says resolver equivalence AND byte-identical assembled prompt. Phase 4
planned only the former — and the gap was *disguised*, because Phase 8's T13
looks like it covers assembled prompts. A reader would reasonably conclude M10
was satisfied across two phases when neither asserted byte-identity.

Why it matters: per-file resolution can be correct while assembly still differs
(template ordering, {{project_id}} interpolation, a fragment from a different
tier). Phase 4's entire claim is "deletion is a no-op for what agents receive" —
only byte-identity shows that. Fixed: snapshot each protocol's prompt
pre-deletion, assert byte-identical after.

Also wrote down that 4d(ii) and T13 have *opposite* expectations — 4d(ii) says
nothing changed; T13 says the right content is present after compression/dedup
deliberately changed things. Easy for a later reader to collapse them.

### Codex CX-3: the drift disease, in miniature, in my own plan

I wrote "remove copyProtocols/copyRoles plus their scaffold.test.ts cases."
But only copyRoles has tests — and **I had established that myself** during the
spec phase and written it in the iter-1 spec rebuttal. Verified once,
paraphrased from memory later, drifted in the restatement.

That's exactly what this project is about. Worth remembering: my errors don't
cluster in analysis, they cluster in *restating things I already verified*.

### Claude CL-1: better than "minor"

T11 parses the Phase 2 audit doc, but I described the doc loosely. A builder
writing free-form prose would make T11 unimplementable — and the natural fix
under pressure is to weaken T11, which would quietly remove the guarantee that
nothing was deleted unaudited. That's the most important safeguard in the plan.
Now specified as a fixed 5-column table with enumerated values.

### CX-2: phase boundary contradiction

Phase 5 said "replace on every surface"; Phase 8 said "apply Phase 5's wordings
to CLAUDE.md/AGENTS.md." Two readings, one dangerous: Phase 5 skips the two
most-read surfaces and still claims M5 green — leaving a hole exactly where the
most-read scar rules live, right before Phase 7 starts stripping text. Phase 5
now owns all scar edits; Phase 8 only parity-checks N3.

Gemini again endorsed the Phase 5-after-Phase 4 placement (my discretionary
call) and the M11 → M3 → M8 ordering.

## Amendment D5 — behavioural-impact measurement (M12)

Architect surfaced a real gap I'd missed: the issue's guidance made impact
measurement mandatory ("a trim proposal without a way to evaluate it is not
accepted"), and my M6 word-counts + structural tests measure the PROXY, not the
effect. My safeguards were asymmetric — M5/T6 protect against a scar rule being
deleted or reworded; nothing detected "rule still present, compliance dropped."

### Research first — two requested metrics turned out unminable

Before proposing anything I checked what the repo actually stores. Worth
recording because the answer shaped the whole design:

- `codev/projects/*/*.txt` (raw consult logs) are **GITIGNORED** (.gitignore:59).
  No historical consult output survives. Biggest constraint.
- **Gate rejection counts: NOT MINABLE.** Across all 201 projects gate `status`
  only ever takes approved|complete|in_progress|pending — there is no `rejected`
  state, and `requested_at` is a scalar that a re-request overwrites. A
  rejected-then-approved gate is indistinguishable from a clean one. Said so in
  Appendix D §2 rather than quietly dropping it.
- **Tokens/phase: PROSPECTIVE ONLY.** `consult stats` is a rolling 30-day local
  DB (3239 invocations, $1426). No Feb–Jun history → forward snapshot only.
- What IS minable: `history[].reviews[].verdict` — but only **17 SPIR projects**
  have non-empty history (populated for SPIR's per-plan-phase loops, empty for
  pir/bugfix/air). Plus 211 reviews + 139 threads for keyword mining.

So: B1 REQUEST_CHANGES rate, B2 rounds-to-approve, B3 scar-violation mining,
B4 phase iterations, B5 forward cost snapshot. Sample n=17. N=10 verify window
with ≥3 SPIR (the SPIR minimum is the binding constraint, not the total).

### Things I made sure to state rather than paper over

- **The add/remove confound**: this project both restores content (M3) and
  removes it (D3 compression, S1 dedup). A null result could be two real effects
  cancelling. Mitigated by attributing rollback to specific commits, not the
  project as a whole.
- **Rollback targets trims, never repairs.** Phases 1–4 restore correct content;
  reverting them reintroduces the drift bug. Only Phases 5 and 7 are candidates.
- **Inconclusive is a real outcome.** <10 projects or <3 SPIR ⇒ do NOT declare
  success. Absence of data is not a no-regression result.
- **B3 is the metric that matters most** and is the fuzziest — it's the one that
  would catch a compressed scar rule losing force. Script must emit excerpts,
  not just counts, so a human adjudicates.
- Honest ceiling: n=17 vs N=10 detects a LARGE regression. The strongest claim
  available is "no evidence of harm at this sample size," not "proved
  beneficial." That's why M12c defers a real A/B — and I flagged the deferral as
  a genuine weakness, not a formality.

Baseline must land in Phase 1 (step 1b) — Phases 3/5/7 all alter served content,
so any later capture has no clean "before."

## D5 delta review — Gemini APPROVE / Codex REQUEST_CHANGES / Claude APPROVE

Codex found two real defects. Gemini and Claude both approved. **The majority
was not the signal.**

The split is instructive: Gemini and Claude verified the *data-availability*
claims (correct — all three confirmed gate-rejections unminable, consult
prospective-only, 17 SPIR sample). Codex went further and checked whether the
*metric definitions actually resolve against that data*. That's where both
defects were.

### CX-1: B2 was unmeasurable and would have failed silently

"Rounds to unanimous approve" — but **0 of 48 terminal plan phases end with
3× APPROVE**. I re-derived it rather than trusting the claim:

    20  (APPROVE, APPROVE, REQUEST_CHANGES)
    12  (APPROVE, REQUEST_CHANGES, REQUEST_CHANGES)
     7  (REQUEST_CHANGES × 3)

**Porch advances a phase on builder rebuttal, not consensus.** So B2 would never
resolve — and would have looked fine: script runs, emits a number, number is
meaningless.

The lesson worth keeping: "the data exists" ≠ "the metric resolves." I verified
the former meticulously (all 3 reviewers confirmed Appendix D §1–2) and never
checked the latter for my own definition.

Redefined B2 = max(iteration) per plan_phase. Then computed real baselines:
**B1 = 51.9% REQUEST_CHANGES** (n=160), B2 mean 1.12 (n=49), B4 mean 3.06.

That surfaced something else: **B2's range is 1–2, mean 1.12 — nearly no
variance**, so it can't detect a subtle regression. Demoted B2/B4 to advisory,
named B1 load-bearing, made the soft threshold concrete (>25% on 51.9% = above
~64.9%).

### CX-2: T14 contradicted itself

T14 demanded "same commit ⇒ same B1–B5" while B5 comes from a rolling 30-day
machine-local DB. Both halves written by me in the same amendment. Scoped
determinism to B1–B4; B5 now explicitly advisory/non-deterministic, drives no
trigger. Kept rather than dropped — cost/duration is useful context for
interpreting a B1 move; the failure was pretending it was reproducible.

### Also worth recording

Gemini endorsed the n=1 hard trigger on B3, reasoning scar rules exist BECAUSE
the catastrophe already happened once — so one verified recurrence justifies
reverting compression. Good framing; a single-incident trigger looks aggressive
without it.

Process note: my first 3 delta consults failed — `--prompt` and `--type` are
mutually exclusive. Should have checked the consult skill first. Re-ran in
general mode with a scoped brief file. No artifacts affected.

## Phase 1 COMPLETE — drift gate + both baselines

Plan approved (human, relayed). Phase 1 delivers M2, M6, M12a.

**Drift gate** (`shadow-drift-gate.test.ts`): calls the existing
`auditProtocolDrift()` — did NOT reimplement detection. 4 tests + 1 skipped
(Phase-3 lifecycle guard, flips on in Phase 3).

Allowlist seeded with exactly the 17 drifted files, each justified
`PENDING_RECONCILE → Phase 3 (D1)`. Two guards make it self-limiting: every
entry needs a non-empty note, and a *stale-entry* test fails if an allowlisted
file stops drifting. So the allowlist can't outlive its purpose.

The BITES test matters most: seeds a real divergence in a temp workspace and
requires detection. A gate that has only seen a clean tree is indistinguishable
from a no-op — which is precisely how #1210 sat unread for months.

**Word baseline**: ALWAYS_ON = **24,614** (CLAUDE.md 5,773 + spawn 4,891 +
1,395×10 phase tasks). Matches the spec's ~24,600 estimate. Deliberately
excludes AGENTS.md (byte-identical twin — one loads per session, not both) and
the hot-tier files (already inlined in CLAUDE.md's count). Double-counting
either would inflate the baseline and flatter the Phase 7 result.

**Behavioural baseline** (M12a): B1 **51.88%** REQUEST_CHANGES (n=160 verdicts),
B2 mean 1.12 (n=49 phases), B4 mean 3.06 (n=18 projects). Reproduces the figures
published in spec Appendix D.

B3: 45 candidate hits across 350 files — and inspection confirms they're mostly
false positives (discussions *about* auto-approve, not violations). Exactly why
the script emits excerpts, not counts. A bare "45 violations" would have been
actively misleading.

### Deviation from plan: script location

Plan said `scripts/measure-prompt-behavior.ts` at repo root. It needs `js-yaml`,
which a root script **cannot resolve** in this pnpm workspace (root node_modules
lacks it). Moved logic to `packages/codev/src/lib/prompt-behavior-metrics.ts`
beside `protocol-drift-audit.ts`/`framework-ref-audit.ts` — same module shape,
unit-testable, deps resolve — with a thin CLI at
`packages/codev/scripts/measure-prompt-behavior.ts`. Spec + plan updated to the
real paths. The bash surface script stays at root (no deps).

### Test-suite investigation worth recording

First full run: 49 files / 62 tests failing. Easy to write off as pre-existing —
but I verified instead. All were `@cluesmith/codev-core` import errors: the
workspace wasn't built. Building core fixed 48 files. The last 8 were
"integration with real shellper" tests needing `dist/terminal/shellper-main.js`;
`npx tsc` produced it and all 90 passed.

**Full suite now 193 files / 3772 tests green, 0 failures.** No flaky tests to
skip. Lesson reinforced: "pre-existing failure" is a claim requiring evidence,
not a default assumption — a fresh worktree just isn't built.

## Phase 1 iter-1 review — Gemini/Claude APPROVE, Codex REQUEST_CHANGES ×2, both fixed

Codex again the one checking whether the numbers actually mean anything:

1. **Hardcoded spawn/phase word counts** (4891/1395) would have silently
   corrupted the Phase 7 N1 delta — reruns would report pre-trim numbers for
   the two largest components. Now derived from resolved artifacts;
   sensitivity-verified (shrink protocol.md → ALWAYS_ON drops 21,856→18,048).
   Reproducible baseline is **21,856** (old 24,614 counted per-project variable
   content that no trim can touch). Spec N1 note updated.
2. **B5 never actually captured** — plan said B1–B5, I wrote "capture
   separately" and didn't. Snapshot now in the baseline artifact, capture-dated,
   marked non-deterministic, drives no trigger.

Word baseline output now committed too (1252-word-baseline.md).

## Phase 2 prep findings (read-only, ahead of the audit)

Diffed all 17 drifted files against the installed skeleton. Early
classifications for the audit:

- **spir/protocol.md's 85 "local additions" are ROT**, not local-unique: the
  old "Porch Orchestration" section uses obsolete underscore gate IDs
  (`spec_approval`; porch uses `spec-approval`) and skeleton restructured to
  the build-verify model. Local kept what skeleton deleted.
- **roles/architect.md area-label section is ROT with a twist**: skeleton
  GENERALIZED it (`<prefix>/` placeholders for adopters); the codev-specific
  `area/` version's content is already owned by CLAUDE.md. Skeleton wins,
  nothing lost.
- **Genuine escalation candidates**:
  - TICK "Amendments" sections in spir+aspir spec/plan templates — local-only;
    no tick protocol dir exists anywhere, but porch's phase prompts still
    reference TICK amendments. Ambiguous → escalate.
  - `max_iterations: 8` (local) vs `3` (skeleton) in spir+aspir protocol.json —
    a real behavioral difference in CMAP loop bounds. Ambiguous → escalate.

## Iter-2 hiccup worth remembering: the baseline measured itself

Porch's checks failed on iter-2: the reproduction test expected 160 verdicts,
got 163. Cause: **this project's own iter-1 review verdicts landed in its
status.yaml — the corpus is live and the measuring project was in it.** Same
for B3: my own thread file (which discusses scar rules constantly) was in the
prose scan and had already contributed a hit to the committed baseline.

Fix: self-exclusion by default (SELF_PROJECT_DIR, SELF_FILE_PREFIXES).
Baseline = pre-project state, so the measuring project's artifacts are out of
scope by definition. Baseline artifact regenerated clean: 160 verdicts, 349
files, 44 hits. New test pins the exclusion.

Observer effect in the smallest possible lab. The verify phase needs to
remember this too: when comparing, 1252's own artifacts stay excluded.

## Phase 1 iter-2: unanimous APPROVE. Phase 2 (M11 audit) executed.

Audit committed: codev/resources/1252-shadow-tree-audit.md — **77 rows** (spec
said 76; mechanical enumeration caught consult-types/integration-review.md,
which my hand count missed). 60 identical→TS1, 13 drifted-rot→TS1, 4
local-unique→pending, escalated to architect:

1. **max_iterations 8 vs 3** (spir+aspir json) — CMAP loop bound, no config
   override exists for it. TS1/TS2/TS3 options laid out.
2. **cwd: packages/codev** (air+bugfix json) — real monorepo functionality;
   recommended migrating to .codev/config.json porch.checks (Spec #550
   sanctioned mechanism) then TS1. Noted spir/aspir only pass today because
   the repo root happens to have build/test scripts.

Key evidence trail in the audit: TICK retired (all local TICK refs = rot,
though skeleton's own porch prompts still emit TICK-amendment language —
flagged for Phase 8); obsolete underscore gate IDs prove spir/protocol.md's
"additions" are pre-restructure leftovers; architect.md's area/ recipes are
owned by CLAUDE.md so the skeleton's generalized version loses nothing.

T11 parses the audit table (6-column contract, enumerated values): 5 tests
green, completion guard (zero pending) phase-gated like the drift gate's.
Also armed: a guard that fails if any file vanishes while pending/TS3.
