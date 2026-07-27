# Spec 1252: Prompt Architecture — Single-Owner Rule for Instruction Content

## Metadata

- **Issue**: #1252
- **Protocol**: SPIR
- **Area**: `area/cross-cutting`
- **Status**: draft
- **Author**: builder spir-1252

---

## Clarifying Questions Asked

No spec existed and the issue carries no `Baked Decisions` section, so no
architect decisions are pinned. Rather than block on clarifying questions, I
resolved the open framing question — *how big is the problem and where does it
concentrate?* — by measuring the repository directly. The measurements below are
reproducible and are the evidentiary basis for every decision in this spec.

One question remains genuinely open and is escalated in **Open Questions**
(Critical): whether the `codev/protocols/` shadow tree may be deleted outright.

---

## Problem Statement

Codev's shipped instruction surface is large, and the same rules are restated
across many files. Three costs follow:

1. **Drift** — an edit lands in one copy while the others go stale. Only the
   CLAUDE.md ↔ AGENTS.md pair is actively policed.
2. **Token cost** — duplicated rules ride into every phase prompt, every spawn
   prompt, every session.
3. **Ambiguity** — a builder can meet two differently-worded variants of one
   rule and not know which is authoritative.

The issue estimated "~45,000 words" and "the same rules repeated across 4–6
surfaces." **Both estimates are low.** The measurement below found a larger
surface and a duplication axis the issue does not name at all — one that is
already causing a live, demonstrable failure.

### The headline finding: the `codev/` ↔ `codev-skeleton/` shadow tree

`codev/protocols/` and `codev-skeleton/protocols/` both exist. **63 markdown
files — 45,183 words — are present in both trees.** The same is true of
`codev/roles/` ↔ `codev-skeleton/roles/` and part of `codev/resources/`.

This is not a harmless copy. The four-tier resolver
(`packages/codev/src/lib/skeleton.ts:63`, `resolveCodevFile`) prefers
`.codev/` → `codev/` → cache → skeleton. **Tier 2 wins**, so this repository's
own agents run on the local copies, while adopters run on the skeleton. The two
have forked: **19 of the shadowed files have drifted.**

#### Proof: the drift already broke this builder

`codev/protocols/spir/builder-prompt.md` (636 words — the copy that is *served*
here) is missing two entire sections that
`codev-skeleton/protocols/spir/builder-prompt.md` (824 words — the copy that
*ships*) contains:

- `### Multi-PR Mechanics (when the architect requests sequential PRs)`
- `## Verify Phase`

The spawn prompt for this very project therefore contains **no verify-phase
instructions**. Adopters of Codev receive them; the Codev repository does not.
The notification string also drifted — local says
`"Ready for cleanup."` where the skeleton says
`"Entering verify phase."`.

`codev/protocols/spir/protocol.md` differs from its skeleton twin by **138 diff
lines**. Both files were last modified by the same merge commit (`d49f5f47`,
2026-06-13): they were forked once and left to rot.

This is the failure mode the issue predicts, observed in production, on the
project filed to fix it.

### Duplication is worse than estimated

Probing one representative rule — the `git add -A` prohibition:

- Present in **18 logical locations** (36 files, counting the shadow mirror) —
  not 4–6.
- Expressed in **9 distinct wordings**, ranging from a one-line hot-tier bullet
  (``Never `git add -A` / `.` / `--all` — stage files explicitly.``) to a
  multi-line `### 🚨 ABSOLUTE PROHIBITION 🚨` block in CLAUDE.md.

Nine wordings of one rule is precisely the ambiguity cost the issue describes.

---

## Current State

### Measured surface inventory

All counts are `wc -w` on the working tree at the time of writing and are
reproducible with the commands in **Test Scenarios**.

| Surface | Words | Files | When it loads |
|---|---:|---:|---|
| `CLAUDE.md` | 5,773 | 1 | Every Claude Code session, automatically |
| `AGENTS.md` | 5,773 | 1 | Every session in other tools; byte-identical twin |
| `codev/resources/arch-critical.md` (HOT) | 416 | 1 | Inlined in CLAUDE.md **and** in every porch phase prompt |
| `codev/resources/lessons-critical.md` (HOT) | 320 | 1 | Same |
| `codev/resources/arch.md` (COLD) | 20,240 | 1 | On demand |
| `codev/resources/lessons-learned.md` (COLD) | 21,270 | 1 | On demand |
| `codev-skeleton/**` (total) | 77,956 | 113 | Resolver-dependent |
| — `codev-skeleton/protocols/` | 44,784 | 63 | |
| — `codev-skeleton/resources/` | 7,191 | 9 | |
| — `codev-skeleton/templates/` | 6,123 | 11 | |
| — `codev-skeleton/porch/prompts/` | 4,009 | 10 | |
| — `codev-skeleton/roles/` | 3,813 | 3 | |
| `codev/protocols/` (**shadow tree**) | 47,511 | 66 | **Wins over skeleton** |
| `codev/roles/` (**shadow tree**) | 3,687 | 3 | **Wins over skeleton** |
| `.claude/skills/**` | 16,743 | 14 | On demand |
| Actual builder spawn prompt (this project) | 4,891 | — | Once per builder |
| Actual porch phase task (`porch next`) | 1,395 | — | Per phase iteration |

The issue's "~45,000 words" corresponds closely to the shadowed protocol
content alone (45,183). The **total authored instruction surface is roughly
150,000 words**; the *always-on* portion — what enters context whether or not
it is needed — is far smaller and is the number worth optimizing:

**Always-on load per builder** ≈ 5,773 (CLAUDE.md, hot tier already inlined)
+ 4,891 (spawn prompt) + 1,395 × *N* phase iterations.

For a typical SPIR run of ~10 phase iterations that is **≈ 24,600 words**
before a single line of project code is read.

### Existing enforcement machinery

The repository already polices parts of this surface. Any solution must extend
these rather than duplicate them:

| Suite | Tests | Guards |
|---|---:|---|
| `framework-ref-audit` | 17 | Resolver-bypassing shell reads of framework files by literal path (#1011) |
| `skeleton` | 18 | Four-tier resolution behaviour |
| `hot-tier` | 9 | HOT-tier caps and cold-doc map accuracy (Spec 987) |
| `protocol-prompt-audit` | 7 | Protocol prompt well-formedness |
| `skill-parity` | 5 | `.claude/skills` ↔ `.codex/skills` parity |
| `governance-sweep` | 3 | Governance doc invariants |

Notably **no test asserts that `codev/protocols/` matches
`codev-skeleton/protocols/`** — which is exactly why 19 files drifted unnoticed.

### What is working

Codev's progressive disclosure is genuinely good and is not in scope for
change: the HOT/COLD governance tiers (Spec 987) are capped and policed,
skills load on demand, and `framework-ref-audit` already encodes the
"deliver content, don't fetch by path" discipline. The weakness is
cross-layer duplication, not disclosure.

---

## Desired State

1. **Every instruction has exactly one owning surface.** An ownership map
   records the owner for each instruction class. Non-owning surfaces reference
   or summarize; they never restate.
2. **The shadow tree is gone or mechanically enforced.** Either
   `codev/protocols/` and `codev/roles/` are deleted so the skeleton is the
   single owner, or a test fails the build the moment they diverge. Silent
   drift becomes impossible.
3. **Scar rules stay verbatim and always-on** wherever they apply.
   Deduplication never applies to them.
4. **Content is tiered by consuming model capability**, so weaker models get
   fuller scaffolding and stronger models get the compressed form.
5. **The win is measured**, before and after, with a reproducible script.

---

## Stakeholders

| Stakeholder | Need |
|---|---|
| Builders (AI agents) | One unambiguous statement of each rule; no stale instructions |
| Architect (human) | Confidence that an edit to a rule takes effect everywhere |
| Codev adopters | Skeleton content that matches what the Codev repo itself runs |
| Consultation models | Prompts small enough to leave budget for actual review |

---

## Success Criteria

### Functional (MUST)

- **M1** — A committed ownership map at `codev/resources/prompt-ownership.md`
  lists every prompt surface, its owner, and for each duplicated instruction
  class the single owning surface.
- **M2** — Zero silent divergence between `codev/protocols/` + `codev/roles/`
  and their `codev-skeleton/` counterparts: either the shadow trees are removed,
  or a test fails on any divergence.
- **M3** — The live drift found here is repaired: the served SPIR builder prompt
  regains the `Multi-PR Mechanics` and `Verify Phase` sections, and the
  `"Entering verify phase."` notification string.
- **M4** — Every instruction class in the ownership map has exactly one owner.
  A test enforces this for the classes the map declares machine-checkable.
- **M5** — A scar-rule registry names the rules exempt from deduplication.
  A test asserts each scar rule is present, verbatim, on every surface the
  registry says it must appear on. **Deleting a scar rule fails the build.**
- **M6** — A measurement script reports always-on word counts per surface and
  is runnable before/after to quantify the win.

### Functional (SHOULD)

- **S1** — Non-scar duplicated instruction classes are reduced to their single
  owner plus references.
- **S2** — Model-capability tiering is defined in the ownership map, with the
  mechanism for selecting a tier specified even if only one tier ships
  initially.

### Non-functional

- **N1** — Measured reduction in always-on words per builder. **Target: ≥ 20%**
  against the ≈ 24,600-word baseline, achieved without deleting any scar rule.
  This is a target for the plan to interrogate, not a hard gate; the plan must
  report the achieved figure either way.
- **N2** — No behavioural regression: the full existing test suite passes.
- **N3** — CLAUDE.md and AGENTS.md remain byte-identical (existing invariant).
- **N4** — HOT-tier caps from Spec 987 are respected.

### Explicit non-goals

- Not rewriting protocol semantics — only relocating and deduplicating text.
- Not touching `arch.md` / `lessons-learned.md` COLD content, which is already
  correctly on-demand.
- Not changing the four-tier resolver's algorithm.

---

## Constraints

No `Baked Decisions` section is present in issue #1252. The constraints below
derive from the issue body and from repository invariants.

### From the issue

- **C1** — Single-owner rule: exactly one owning surface per instruction;
  others reference or summarize, never restate.
- **C2** — Inventory and ownership map are produced **before** any
  restructuring.
- **C3** — **Scar rules are exempt.** Hard-won prohibition rules (data-loss
  scars, gate rules) stay verbatim and always-on wherever they apply.
  Deduplication never applies to them.
- **C4** — Multi-model fleet tiering: tier content by consuming model
  capability.

### From repository invariants

- **C5** — CLAUDE.md and AGENTS.md MUST stay byte-identical.
- **C6** — Framework changes must be mirrored in both `codev/` and
  `codev-skeleton/` — *this spec proposes changing that invariant by removing
  the need for it; until then it holds.*
- **C7** — Framework files must not be fetched by literal `codev/...` path;
  content is delivered via spawn prompt and porch JSON
  (`framework-ref-audit`).
- **C8** — HOT-tier files are capped (≤10 facts, ≤12 map topics, ≤35 lines).
- **C9** — Never `git add -A` / `.` / `--all`.

### Scar rules — the exemption list (to be ratified in the plan)

Working definition: a **scar rule** is a prohibition written in response to a
specific incident where an agent destroyed work or bypassed a human decision.
Candidates identified during inventory:

- Never `git add -A` / `.` / `--all`
- Never destroy builder worktrees (`git worktree remove`, `git branch -D`,
  `afx cleanup` + respawn)
- Never `git reset --hard` / `git checkout -- .` / `git clean -fd` / `git stash`
- Never auto-approve porch gates; only humans approve
- Never hand-edit `status.yaml`
- Run `afx` only from the main workspace root

These stay verbatim on every surface where they currently apply. The 9 differing
wordings of the `git add -A` rule are a **consistency** problem, not a
duplication problem: the fix is to converge on one wording repeated verbatim,
not to reduce the number of copies.

---

## Assumptions

- **A1** — The `codev/protocols/` and `codev/roles/` shadow trees are
  unintentional forks, not deliberate self-host customizations. *Evidence*: both
  trees share a last-touch commit; the divergences are missing sections rather
  than added ones. **Contradicting A1 would materially change the plan** — see
  Open Questions Q1.
- **A2** — `codev/protocols/release/` is a genuine local-only protocol (it has
  no skeleton counterpart) and must survive any shadow-tree removal.
- **A3** — The always-on figure (≈ 24,600 words) is the number worth reducing;
  on-demand content is already correctly tiered.

---

## Solution Approaches

### Approach A — Delete the shadow trees; skeleton is the single owner

Remove `codev/protocols/` and `codev/roles/` (preserving `release/`), letting
tier-4 skeleton resolution serve this repo exactly as it serves adopters. Add a
test asserting no shadowed framework file reappears.

- **Pros**: eliminates 45,183 words of duplicate content and the entire drift
  class at a stroke; makes Codev dogfood exactly what it ships; retires the
  "mirror every change in BOTH trees" invariant (C6) that itself causes drift.
- **Cons**: highest blast radius; some tooling may read `codev/protocols/*`
  by path and must be audited first; loses the ability to self-host a
  customization without also shipping it.
- **Complexity**: high. **Risk**: high, well-mitigated by the existing
  `skeleton` and `protocol-prompt-audit` suites.

### Approach B — Keep both trees; enforce equality with a test

Add a parity test: for every file in both trees, assert byte-equality, with an
explicit allowlist for intentional divergences.

- **Pros**: low blast radius; drift becomes impossible immediately; mirrors the
  proven CLAUDE.md ↔ AGENTS.md pattern and the existing `skill-parity` suite.
- **Cons**: keeps 45,183 duplicated words and the double-edit burden; solves
  drift but not token cost or ambiguity; the allowlist will accrete.
- **Complexity**: low. **Risk**: low.

### Approach C — Ownership map + reference-based deduplication

Author the ownership map, then mechanically strip non-owning restatements down
to references, leaving scar rules verbatim.

- **Pros**: directly implements the issue's stated direction; addresses all
  three costs; the map is durable documentation.
- **Cons**: does nothing about the shadow tree on its own — deduplicating
  *within* a tree that is itself duplicated is rearranging deck chairs.
- **Complexity**: medium. **Risk**: medium (over-stripping a rule an agent
  actually needed in place).

### Recommended: B → A → C, sequenced

The approaches are complementary, and their **order matters**:

1. **Parity test first (B)** — stops the bleeding immediately and cheaply, and
   is the safety net that makes A auditable. Deleting a tree is far safer once a
   test can prove the two trees agree.
2. **Repair the known drift (M3)** before or with the parity test, since the
   test cannot pass while 19 files diverge.
3. **Delete the shadow trees (A)** — the single largest win, now de-risked.
4. **Ownership map + deduplication (C)** — the durable structural fix, applied
   to a surface that is no longer doubled, so the map describes one tree.

Doing C first would author an ownership map over a duplicated tree and have to
be redone after A. Doing A first, without B's parity test, would delete a tree
without proof of what was being lost.

The plan should treat each as a phase and may recommend stopping after any of
them if consultation surfaces a blocker for a later one.

---

## Open Questions

### Critical (blocks progress)

- **Q1** — **May `codev/protocols/` and `codev/roles/` be deleted?** This is an
  architect decision, not a builder one. If any divergence is a deliberate
  self-host customization, Approach A is off the table and the work stops at B.
  *The builder will not delete either tree without explicit architect approval.*
- **Q2** — For the 19 drifted files, which side is authoritative? Default
  proposal: **the skeleton wins** (it is what ships and what adopters run, and
  the local copies are missing content rather than adding it). Exceptions to be
  enumerated file-by-file in the plan.

### Important (affects design)

- **Q3** — Is the scar-rule list in **Constraints** complete and correct?
  Requires architect ratification, since the whole point is that these rules are
  never quietly dropped.
- **Q4** — What is the tier-selection mechanism for C4 (model-capability
  tiering)? Config key, per-protocol setting, or model-string detection? The
  spec requires the mechanism be *defined*; shipping more than one tier may be
  deferred.
- **Q5** — Does any code read `codev/protocols/*` by literal path in a way that
  would break under Approach A? Must be answered by grep during the plan phase,
  before any deletion.

### Nice-to-know

- **Q6** — Should the ownership map be machine-readable (YAML/JSON) so the
  single-owner test derives from it, rather than restating ownership in test
  code? *Restating it in test code would itself violate the single-owner rule* —
  a machine-readable map is likely correct.
- **Q7** — Should `codev/resources/` shared files (`arch-critical.md`,
  `lessons-critical.md`, `workflow-reference.md`, `spikes.md` — all currently
  differing from their skeleton twins) be brought into the same regime? These
  are user-evolved files where divergence is legitimate, so probably not — but
  the map should say so explicitly.

---

## Test Scenarios

### T1 — Reproduce the surface inventory

```bash
for f in CLAUDE.md AGENTS.md codev/resources/arch-critical.md \
         codev/resources/lessons-critical.md; do
  printf "%-45s %6s\n" "$f" "$(wc -w < $f)"
done
find codev-skeleton -name "*.md" -exec wc -w {} + | tail -1
find codev/protocols -name "*.md" -exec cat {} + | wc -w
```

### T2 — Reproduce the shadow-tree drift

```bash
diff -rq codev/protocols codev-skeleton/protocols   # expect 19 differing files
diff -rq codev/roles     codev-skeleton/roles       # expect architect.md differs
```

### T3 — Reproduce the live builder-prompt drift

```bash
diff codev/protocols/spir/builder-prompt.md \
     codev-skeleton/protocols/spir/builder-prompt.md
# expect: skeleton has "Multi-PR Mechanics" and "## Verify Phase"; local does not
```

### T4 — Reproduce the duplication probe

```bash
grep -rl "git add -A" CLAUDE.md AGENTS.md codev/resources codev/roles \
     codev/protocols codev-skeleton .claude/skills | wc -l   # expect 36
grep -rh "git add -A" codev/protocols codev-skeleton/protocols CLAUDE.md \
  | sed 's/^ *//' | sort -u | wc -l                          # expect 9 wordings
```

### T5 — Parity test (new, Approach B)

Every file present in both `codev/protocols|roles` and
`codev-skeleton/protocols|roles` is byte-identical, modulo an explicit
allowlist. Fails on any divergence.

### T6 — Scar-rule presence test (new, M5)

For each rule in the scar registry, assert it appears verbatim on every surface
the registry requires. Deleting or rewording a scar rule fails the build.

### T7 — Single-owner test (new, M4)

For each machine-checkable instruction class in the ownership map, assert it
appears on exactly one owning surface (scar rules exempted by construction).

### T8 — Regression

Full suite green: `skeleton`, `hot-tier`, `governance-sweep`,
`protocol-prompt-audit`, `framework-ref-audit`, `skill-parity`.

### T9 — End-to-end (the real user path)

Spawn a builder after the change and confirm its spawn prompt contains the
verify-phase instructions and every scar rule. *"Tests pass" is not "it works" —
the assembled prompt must be inspected, not just the source files.*

---

## Dependencies

- Spec 987 (hot/cold governance tiers) — this spec extends, and must not
  violate, its caps.
- Issue #1011 / `framework-ref-audit` — the "deliver, don't fetch" discipline.
- `packages/codev/src/lib/skeleton.ts` — the four-tier resolver; read, not
  modified.

---

## Risks and Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| A scar rule is silently dropped during deduplication | **Critical** — reintroduces a known data-loss incident | T6 scar-presence test written and passing *before* any deletion; scar registry ratified by architect (Q3) |
| Deleting the shadow tree breaks a path-based reader | High | Q5 grep audit precedes deletion; parity test (B) proves equivalence first |
| Over-stripping leaves an agent without a rule it needed in context | High | Deduplicate only non-scar classes; T9 inspects the assembled prompt, not just sources |
| The 19 drifted files contain deliberate local customizations | Medium | Q1/Q2 answered by architect before deletion; file-by-file enumeration in plan |
| Ownership map restated in test code, re-creating duplication | Medium | Q6 — derive the test from a machine-readable map |
| Measured reduction falls short of the 20% target (N1) | Low | N1 is a target, not a gate; report the achieved figure honestly either way |

---

## Expert Consultation

Pending — porch runs the 3-way review (Gemini, Codex, Claude) at the end of the
specify phase. Reviewers are asked to weigh in particularly on:

- Whether the recommended **B → A → C** sequencing is right, or whether the
  shadow-tree deletion should be deferred entirely.
- Whether the scar-rule list in **Constraints** is complete.
- Whether the 20% always-on reduction target (N1) is well-calibrated.

---

## Approval

- [ ] Architect approval (gate: `spec-approval`)
- [ ] 3-way consultation complete

---

## Notes

The strongest argument for this work is not the token count. It is that the
project filed to fix prompt drift was itself spawned with a drifted prompt,
missing its own verify-phase instructions. The mechanism failed silently, in
the exact way the issue predicted, and nothing caught it.
