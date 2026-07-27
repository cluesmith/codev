# Spec 1252: Prompt Architecture — Single-Owner Rule for Instruction Content

## Metadata

- **Issue**: #1252
- **Protocol**: SPIR
- **Area**: `area/cross-cutting`
- **Status**: draft (iteration 2 — revised after 3-way consultation)
- **Author**: builder spir-1252

---

## Terminology

Defined once, used consistently throughout:

- **Skeleton** — `codev-skeleton/`, the framework template that ships in the
  `@cluesmith/codev` package and is served as tier 4 by the resolver.
- **Shadow copy** — a project-local file under `codev/` (tier 2) or `.codev/`
  (tier 1) that has a same-named counterpart in the skeleton. Because tiers 1–2
  win, the shadow copy is what actually gets served.
- **Shadow tree** — the set of shadow copies under `codev/protocols/` and
  `codev/roles/` in *this* repository. "Shadow tree" never refers to the
  skeleton itself.
- **Drifted** — a shadow copy whose content differs from its skeleton
  counterpart. Distinct from **local-only**, a file under `codev/` with *no*
  skeleton counterpart (legitimate; must be preserved).
- **Scar rule** — a prohibition written in response to a specific incident in
  which an agent destroyed work or bypassed a human decision.

---

## Clarifying Questions Asked

No spec existed and issue #1252 carries no `Baked Decisions` section, so no
architect decisions are pinned. Rather than block, I resolved the framing
question — *how big is the problem and where does it concentrate?* — by
measuring the repository directly. All figures below are reproducible via
**Test Scenarios**.

Two questions remain genuinely architect-owned and are escalated in
**Open Questions** (Critical). Per Codex's review, the spec's required end state
no longer depends on their answers.

---

## Problem Statement

Codev's shipped instruction surface is large, and the same rules are restated
across many files. Three costs follow: **drift** (an edit lands in one copy,
others go stale), **token cost** (duplicated rules ride into every prompt), and
**ambiguity** (an agent meets two wordings of one rule and cannot tell which is
authoritative).

The issue estimated "~45,000 words" and "4–6 surfaces" per rule. Measurement
shows a larger surface, a worse per-rule duplication factor, and one duplication
axis the issue does not name — which is already causing a live failure.

### The headline finding: the `codev/` shadow tree

`codev/protocols/` and `codev-skeleton/protocols/` both exist. **63 `.md` files
(73 including `.json`) are present in both trees**, totalling 45,183 words of
markdown; `codev/roles/` adds 3 more, for **76 shadow copies overall**.

The four-tier resolver (`packages/codev/src/lib/skeleton.ts:63`,
`resolveCodevFile`) prefers `.codev/` → `codev/` → cache → skeleton. **Tier 2
wins**, so this repository runs the shadow copies while adopters run the
skeleton. The two have forked: **17 shadow copies have drifted** — 16 under
`protocols/` (11 `.md`, 5 `.json`) and 1 under `roles/`.

Separately and legitimately, three **local-only** entries have no skeleton
counterpart and must survive any cleanup: `codev/protocols/release/`, and
`codev/protocols/maintain/templates/{audit-report.md,lessons-learned.md}`.

#### The 16 drifted protocol files

```
air/protocol.json          aspir/templates/spec.md   spike/protocol.md
air/protocol.md            bugfix/builder-prompt.md  spir/builder-prompt.md
aspir/builder-prompt.md    bugfix/protocol.json      spir/protocol.json
aspir/protocol.json        experiment/protocol.md    spir/protocol.md
aspir/templates/plan.md    protocol-schema.json      spir/templates/plan.md
                                                     spir/templates/spec.md
```

Plus `codev/roles/architect.md`.

#### Proof: the drift already broke this builder

`codev/protocols/spir/builder-prompt.md` (636 words — *served* here) is missing
two whole sections that `codev-skeleton/protocols/spir/builder-prompt.md`
(824 words — *shipped*) contains:

- `### Multi-PR Mechanics (when the architect requests sequential PRs)`
- `## Verify Phase`

The spawn prompt for this very project therefore contains **no verify-phase
instructions**. Adopters get them; the Codev repository does not. The
notification string drifted too: local says `"Ready for cleanup."`, skeleton
says `"Entering verify phase."`.

`codev/protocols/spir/protocol.md` differs by **138 diff lines**. Both files
were last modified by the same merge commit (`d49f5f47`, 2026-06-13) — forked
once, then left to rot.

The project filed to fix prompt drift was spawned with a drifted prompt.

### Why the shadow tree exists — and why adopters are safe

`packages/codev/src/lib/scaffold.ts` exports `copyProtocols` (line 480) and
`copyRoles` (line 425), which copy the skeleton into `codev/protocols/` and
`codev/roles/`. **Neither is called by `init`, `adopt`, or `update`** — a
repo-wide search finds callers only in `scaffold.test.ts` (and none at all for
`copyProtocols`). They are **vestigial code**.

Two consequences:

1. **Fresh adopters do not get a shadow tree.** They resolve protocols from the
   skeleton at tier 4, exactly as `arch-critical.md` states. This repository's
   shadow tree is a **historical artifact** from when scaffolding did copy.
2. **Deleting our shadow tree would make Codev match its own adopters** — the
   dogfooding argument — and the two dead functions should go with it, before
   someone rewires them and manufactures the problem for everyone.

This corrects Assumption A1 of iteration 1, which speculated that the trees were
unintentional forks without establishing why.

### Existing infrastructure this spec builds on (#1210)

**Iteration 1 wrongly claimed "no test asserts that `codev/protocols/` matches
`codev-skeleton/protocols/`."** Claude's review caught this.
`packages/codev/src/lib/protocol-drift-audit.ts` (#1210) already implements
shadow-drift detection, with a test suite at
`packages/codev/src/__tests__/protocol-drift-audit.test.ts`:

```ts
FRAMEWORK_DRIFT_DIRS = ['protocols', 'consult-types', 'roles']
auditProtocolDrift(workspaceRoot?): DriftFinding[]   // 'identical' | 'differs'
hasFrameworkShadows(workspaceRoot?): boolean
```

`codev doctor` already calls `auditProtocolDrift` (`doctor.ts:947`) and reports
findings. The module is deliberately **report-only** — it never writes, because
a local copy *may* be a legitimate customization.

**The real gap is therefore narrow and precise**: drift is already *detected and
reported*, but nothing **fails the build** on it. Our 17 drifted files have been
visible to `codev doctor` all along and were ignored. This spec's parity work is
"wire the existing audit into a CI gate," not "write a drift detector."

### Duplication is worse than estimated

Probing the `git add -A` prohibition: present in **18 logical locations**
(36 files counting the shadow mirror) — not 4–6 — in **9 distinct wordings**,
from a one-line hot-tier bullet to a multi-line `### 🚨 ABSOLUTE PROHIBITION 🚨`
block. Nine wordings of one rule is exactly the ambiguity cost the issue names.

---

## Current State

### Measured surface inventory

`wc -w` on the working tree; reproducible via **T1**.

| Surface | Words | Files | When it loads |
|---|---:|---:|---|
| `CLAUDE.md` | 5,773 | 1 | Every Claude Code session, automatically |
| `AGENTS.md` | 5,773 | 1 | Every session in other tools; byte-identical twin |
| `arch-critical.md` (HOT) | 416 | 1 | Inlined in CLAUDE.md **and** every porch phase prompt |
| `lessons-critical.md` (HOT) | 320 | 1 | Same |
| `arch.md` (COLD) | 20,240 | 1 | On demand |
| `lessons-learned.md` (COLD) | 21,270 | 1 | On demand |
| `codev-skeleton/**` | 77,956 | 113 | Resolver tier 4 |
| — `protocols/` | 44,784 | 63 | |
| — `resources/` | 7,191 | 9 | |
| — `templates/` | 6,123 | 11 | |
| — `porch/prompts/` | 4,009 | 10 | |
| — `roles/` | 3,813 | 3 | |
| `codev/protocols/` (**shadow**) | 47,511 | 66 | **Wins over skeleton** |
| `codev/roles/` (**shadow**) | 3,687 | 3 | **Wins over skeleton** |
| `.claude/skills/**` | 16,743 | 14 | On demand |
| Actual spawn prompt (this project) | 4,891 | — | Once per builder |
| Actual porch phase task (`porch next`) | 1,395 | — | Per phase iteration |

Total authored instruction surface ≈ **150,000 words**. The number worth
optimizing is the *always-on* portion:

**Always-on per builder** ≈ 5,773 (CLAUDE.md, hot tier inlined) + 4,891 (spawn)
+ 1,395 × *N* phase iterations ≈ **24,600 words** at *N* = 10, before any
project code is read.

### Existing enforcement machinery

Any solution extends these rather than duplicating them:

| Suite | Tests | Guards |
|---|---:|---|
| `protocol-drift-audit` (#1210) | 18+ | **Shadow-copy drift detection; report-only via `codev doctor`** |
| `framework-ref-audit` (#1011) | 17 | Resolver-bypassing shell reads by literal path |
| `skeleton` | 18 | Four-tier resolution behaviour |
| `hot-tier` (Spec 987) | 9 | HOT-tier caps and cold-doc map accuracy |
| `protocol-prompt-audit` | 7 | Protocol prompt well-formedness |
| `skill-parity` | 5 | `.claude/skills` ↔ `.codex/skills` parity |
| `governance-sweep` | 3 | Governance doc invariants |

### What is working (and is out of scope)

Codev's progressive disclosure is genuinely good: HOT/COLD governance tiers
(Spec 987) are capped and policed, skills load on demand, `framework-ref-audit`
encodes "deliver content, don't fetch by path," and `protocol-drift-audit`
already sees the drift. The weakness is that detection is advisory and
duplication is unowned — not disclosure.

---

## Desired State

1. **Every instruction has exactly one owning surface**, recorded in a
   machine-readable ownership map. Non-owning surfaces reference or summarize;
   they never restate.
2. **Shadow drift cannot pass CI.** The existing `auditProtocolDrift` becomes a
   build-failing gate, with an explicit adjudication allowlist.
3. **Scar rules stay verbatim and always-on** wherever they apply, in one
   canonical wording. Deduplication never applies to them.
4. **Content is tiered by consuming model capability**, with a defined selector
   and fallback.
5. **The win is measured** by a reproducible before/after script.

---

## Stakeholders

| Stakeholder | Need |
|---|---|
| Builders (AI agents) | One unambiguous statement of each rule; no stale instructions |
| Architect (human) | Confidence that editing a rule takes effect everywhere |
| Codev adopters | Skeleton content matching what the Codev repo itself runs |
| Consultation models | Prompts small enough to leave budget for real review |

---

## Success Criteria

Restructured per Codex: the **required** end state depends on no unanswered
question. Shadow-tree *deletion* is isolated into conditional criteria that
activate only on an affirmative architect answer to Q1.

### Required — MUST (independent of Q1/Q2)

- **M1 — Ownership map.** A machine-readable map at
  `codev/resources/prompt-ownership.yaml`, with a human-readable companion at
  `codev/resources/prompt-ownership.md` generated from or validated against it.
  Schema in **Appendix A**. It enumerates every prompt surface and, for each
  instruction class, the single owning surface.
- **M2 — Drift cannot pass CI.** A test invoking the existing
  `auditProtocolDrift()` **fails the build** on any `differs` finding not listed
  in an explicit, comment-justified allowlist. *This is the one required
  outcome for the shadow tree* — iteration 1's "delete **or** enforce" ambiguity
  is resolved in favour of enforce.
- **M3 — Repair the live drift.** All 17 drifted shadow copies are reconciled,
  so M2's allowlist starts empty. In particular the served SPIR builder prompt
  regains `Multi-PR Mechanics`, `Verify Phase`, and the
  `"Entering verify phase."` string.
- **M4 — Single-owner enforcement.** For every instruction class whose map entry
  sets `enforcement: automated`, a test asserts the class's `pattern` matches on
  exactly the declared owner. The test **derives assertions from the map file**;
  it must not restate ownership in test code (which would itself violate the
  single-owner rule). Definitions in **Appendix A**.
- **M5 — Scar-rule registry.** A machine-readable registry naming each scar rule,
  its **one canonical wording**, and every surface it must appear on. A test
  asserts verbatim presence on each. **Deleting or rewording a scar rule fails
  the build.** M5's test must pass before any deduplication work begins.
- **M6 — Measurement script.** A committed script reporting always-on word
  counts per surface, runnable before and after to quantify the win.
- **M7 — Compatibility audit.** A repo-wide audit of literal `codev/protocols/`
  and `codev/roles/` references, classifying each as resolver-routed (safe),
  comment/error-string (safe), or direct-read (must fix). Promoted from Q5 to a
  first-class deliverable per Codex. *Preliminary findings in* **Appendix B**.

### Conditional — MUST, only if the architect answers Q1 "yes"

- **M8 — Shadow-tree removal.** `codev/protocols/` and `codev/roles/` shadow
  copies are deleted so the skeleton is the single owner, **preserving all
  local-only entries**: `codev/protocols/release/` and
  `codev/protocols/maintain/templates/{audit-report.md,lessons-learned.md}`.
- **M9 — Vestigial scaffold cleanup.** `copyProtocols` and `copyRoles` are
  removed from `scaffold.ts` along with their tests, so the shadow tree cannot
  be reintroduced by rewiring dead code.
- **M10 — Post-deletion equivalence.** For every deleted shadow copy, the
  resolver returns the skeleton counterpart and the assembled spawn prompt is
  byte-identical to the skeleton-sourced expectation.

### SHOULD

- **S1** — Non-scar duplicated instruction classes reduced to their single owner
  plus references.
- **S2** — Model-capability tiering **defined** per **Appendix C**: selector,
  fallback, and documentation-vs-runtime scope. Shipping more than one populated
  tier may be deferred; the mechanism and its fallback must be specified and
  tested.

### Non-functional

- **N1** — Reduction in always-on words per builder. **Target ≥ 20%** against
  the ≈ 24,600 baseline, without deleting any scar rule. A target for the plan to
  interrogate, **not a gate**; the achieved figure is reported either way.
  *Note*: M8 removes ~47k words from the repo but little from *always-on*
  context, so most of N1 must come from S1.
- **N2** — No behavioural regression; full existing suite passes.
- **N3** — CLAUDE.md and AGENTS.md remain byte-identical.
- **N4** — Spec 987 HOT-tier caps respected.

### Non-goals

- Not rewriting protocol semantics — only relocating and deduplicating text.
- Not touching COLD `arch.md` / `lessons-learned.md` content.
- Not changing the resolver algorithm.
- Not making `protocol-drift-audit` auto-remediate; adjudication stays human.

---

## Constraints

Issue #1252 contains no `Baked Decisions` section. Constraints derive from the
issue body and repository invariants.

### From the issue

- **C1** — Single-owner rule: exactly one owning surface per instruction.
- **C2** — Inventory and ownership map precede any restructuring.
- **C3** — **Scar rules are exempt.** They stay verbatim and always-on wherever
  they apply. Deduplication never applies to them.
- **C4** — Multi-model fleet tiering by consuming model capability.

### From repository invariants

- **C5** — CLAUDE.md and AGENTS.md MUST stay byte-identical.
- **C6** — Framework changes mirrored in both `codev/` and `codev-skeleton/`.
  *If M8 proceeds, this invariant is retired for `protocols/` and `roles/` and
  `arch-critical.md` must be updated to say so.*
- **C7** — Framework files are delivered via spawn prompt and porch JSON, never
  fetched by literal `codev/...` path (`framework-ref-audit`).
- **C8** — HOT-tier files capped (≤10 facts, ≤12 map topics, ≤35 lines).
- **C9** — Never `git add -A` / `.` / `--all`.

### Scar rules — exemption list (architect ratification requested, Q3)

- Never `git add -A` / `.` / `--all`
- Never destroy builder worktrees (`git worktree remove`, `git branch -D`,
  `afx cleanup` + respawn); use `--resume`, and when in doubt ask
- Never `git reset --hard` / `git checkout -- .` / `git clean -fd` / `git stash`
- Never auto-approve porch gates; only humans approve
- Never hand-edit `status.yaml`
- Run `afx` only from the main workspace root

The 9 differing wordings of the `git add -A` rule are a **consistency** problem,
not a duplication problem. The fix is to converge on one canonical wording
repeated verbatim — **not** to reduce the number of copies.

---

## Assumptions

- **A1** *(corrected in iteration 2)* — The shadow tree is a **historical
  artifact** of scaffolding that no longer runs, not a deliberate self-host
  customization. *Evidence*: `copyProtocols`/`copyRoles` are uncalled; both trees
  share a last-touch commit; 16 of 17 divergences are content *missing* relative
  to the skeleton rather than local additions. Q1 still asks the architect to
  confirm, but the required criteria no longer depend on the answer.
- **A2** — `codev/protocols/release/` and
  `codev/protocols/maintain/templates/{audit-report.md,lessons-learned.md}` are
  genuine local-only files and must survive.
- **A3** — Always-on words (≈ 24,600) is the figure worth reducing; on-demand
  content is already correctly tiered.

---

## Solution Approaches

### Approach B — Promote the existing drift audit to a CI gate *(required)*

Wire `auditProtocolDrift()` into a build-failing test with an adjudication
allowlist, and reconcile the 17 drifted files so the allowlist starts empty.

- **Pros**: small — the detector already exists and is already wired into
  `codev doctor`; closes the drift class immediately; independent of Q1.
- **Cons**: leaves 45,183 duplicated words and the double-edit burden; fixes
  drift but not token cost or ambiguity.
- **Complexity**: low. **Risk**: low.

### Approach A — Delete the shadow tree *(conditional on Q1)*

Remove the shadow copies, preserving local-only entries, and delete the vestigial
scaffold functions.

- **Pros**: eliminates 45,183 duplicate words and the whole drift class
  structurally; makes Codev dogfood exactly what it ships; retires the
  mirror-both-trees invariant that itself causes drift.
- **Cons**: highest blast radius; irreversible without git history; forfeits
  self-host customization of protocols.
- **Complexity**: high. **Risk**: moderate — **lower than iteration 1 judged**.
  Appendix B finds production consumers route through the resolver, and B's
  parity gate proves equivalence before deletion.

### Approach C — Ownership map + reference-based deduplication *(required)*

Author the map, then reduce non-owning restatements to references, leaving scar
rules verbatim.

- **Pros**: directly implements the issue's stated direction; addresses all
  three costs; the map is durable documentation and drives M4's test.
- **Cons**: on its own does nothing about the shadow tree — deduplicating
  *within* a doubled tree is wasted effort.
- **Complexity**: medium. **Risk**: medium (over-stripping a rule an agent
  needed in place) — mitigated by M5 and T9.

### Recommended sequencing: B → (A) → C

Order matters:

1. **B first** — cheap, stops the bleeding, and is the safety net that makes
   deletion auditable. Deleting is far safer once a gate can prove the trees
   agree.
2. **M3 repair** — required for B's allowlist to start empty.
3. **A, only if the architect approves Q1** — the largest structural win, now
   de-risked by B and Appendix B.
4. **C last** — the durable fix, applied to a surface that is no longer doubled,
   so the map describes one tree.

If Q1 is answered "no," the work is still complete and valuable: B + C ship, M8–M10
are dropped, and the shadow tree remains under permanent CI enforcement.

---

## Open Questions

### Critical — architect decisions (do **not** block the required criteria)

- **Q1** — **May the `codev/protocols/` and `codev/roles/` shadow copies be
  deleted (M8–M10)?** Evidence (Appendix B, A1) supports "yes: historical
  artifact." *The builder will not delete either tree without explicit architect
  approval.* A "no" drops M8–M10 and keeps M1–M7 intact.
- **Q2** — For the 17 drifted files, which side is authoritative? **Default
  proposal: the skeleton wins** — it is what ships, and 16 of 17 divergences are
  missing content rather than local additions. The plan will enumerate
  file-by-file; any file where the local copy carries content worth keeping is
  flagged for architect adjudication rather than silently overwritten.

### Important

- **Q3** — Is the scar-rule list complete and correct? Needs architect
  ratification, since the point is that these are never quietly dropped.
- **Q4** — For **Appendix C** tiering, is a config-key selector the right
  mechanism, and is documentation-only tiering acceptable for this iteration?

### Nice-to-know

- **Q5** — *Resolved and promoted to M7.* Preliminary audit in Appendix B.
- **Q6** — *Resolved.* The ownership map is machine-readable (Appendix A), per
  Gemini's recommendation and to avoid M4's test restating ownership.
- **Q7** — Should `codev/resources/` shared files (`arch-critical.md`,
  `lessons-critical.md`, `workflow-reference.md`, `spikes.md` — all currently
  differing from skeleton twins) join this regime? These are user-evolved files
  where divergence is legitimate, so probably not — but the map should say so
  explicitly, and M2's allowlist must not accidentally cover them.
  (`FRAMEWORK_DRIFT_DIRS` excludes `resources`, so the default is already
  correct; the map should record *why*.)

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

### T2 — Reproduce the drift counts

```bash
diff -rq codev/protocols codev-skeleton/protocols | grep -c '^Files'   # 16
diff -rq codev/roles     codev-skeleton/roles     | grep -c '^Files'   # 1
diff -rq codev/protocols codev-skeleton/protocols | grep '^Only in codev'  # 3 local-only
```

### T3 — Reproduce the live builder-prompt drift

```bash
diff codev/protocols/spir/builder-prompt.md \
     codev-skeleton/protocols/spir/builder-prompt.md
# skeleton has "Multi-PR Mechanics" and "## Verify Phase"; local does not
```

### T4 — Reproduce the duplication probe

```bash
grep -rl "git add -A" CLAUDE.md AGENTS.md codev/resources codev/roles \
     codev/protocols codev-skeleton .claude/skills | wc -l   # 36
grep -rh "git add -A" codev/protocols codev-skeleton/protocols CLAUDE.md \
  | sed 's/^ *//' | sort -u | wc -l                          # 9 wordings
```

### T5 — Drift gate (M2)

`auditProtocolDrift()` returns zero `differs` findings outside the allowlist;
a seeded divergence **fails** the test. Asserts the gate actually bites.

### T6 — Scar-rule presence (M5)

Each registry rule appears verbatim on every required surface. Mutation checks:
deleting a scar rule fails; rewording it fails.

### T7 — Single-owner (M4)

For each `enforcement: automated` class, the pattern matches on exactly the
declared owner. Assertions derive from the map file, not from test literals.

### T8 — Local-only preservation (M8; new, per Claude)

After shadow-tree removal, `codev/protocols/release/` and
`codev/protocols/maintain/templates/{audit-report.md,lessons-learned.md}` still
exist and still resolve.

### T9 — Post-deletion resolver equivalence (M10)

For every deleted shadow copy, `resolveCodevFile` returns the skeleton
counterpart and content matches.

### T10 — Regression (N2)

Full suite green: `protocol-drift-audit`, `skeleton`, `hot-tier`,
`governance-sweep`, `protocol-prompt-audit`, `framework-ref-audit`,
`skill-parity`, `scaffold`.

### T11 — End-to-end, the real user path

Spawn a builder after the change and **inspect the assembled spawn prompt**:
it must contain the verify-phase instructions and every scar rule. *"Tests pass"
is not "it works"* — the assembled prompt is the artifact that matters, not the
source files.

---

## Dependencies

- **#1210 / `protocol-drift-audit`** — the foundation for M2; extended, not
  reimplemented.
- **Spec 987** (hot/cold tiers) — caps must not be violated.
- **#1011 / `framework-ref-audit`** — the deliver-don't-fetch discipline.
- `packages/codev/src/lib/skeleton.ts` — resolver; read, not modified.
- `packages/codev/src/lib/scaffold.ts` — modified only under M9.

---

## Risks and Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| A scar rule silently dropped during deduplication | **Critical** — reintroduces a known data-loss incident | M5 registry + T6 mutation tests passing *before* any deduplication; architect ratification (Q3) |
| Deleting the shadow tree breaks a path-based reader | High | M7 audit precedes deletion; B's gate proves equivalence; T9 checks every deleted file |
| Over-stripping leaves an agent without a needed rule | High | Deduplicate only non-scar classes; T11 inspects the assembled prompt |
| A drifted file holds a deliberate local customization | Medium | Q2 file-by-file enumeration; anything non-trivial escalated, never silently overwritten |
| M2's allowlist accretes and re-hides drift | Medium | Allowlist entries require a justification comment; empty at M3 completion; growth is reviewable in diffs |
| Ownership restated in test code, re-creating duplication | Medium | M4 derives assertions from the map (Q6 resolved) |
| Local-only files lost during deletion | Medium | T8 explicitly guards all three |
| N1's 20% target missed | Low | N1 is a target, not a gate; report the achieved figure honestly |

---

## Appendix A — Ownership map schema (M1, M4)

An **instruction class** is a single normative rule an agent is expected to
follow, identified by a stable `id` and detectable by `pattern`. Prose that
merely *describes* the system is not an instruction class.

```yaml
surfaces:
  - id: claude-md
    path: CLAUDE.md
    load: always-on
    tier: [strong, weak]        # see Appendix C

instructions:
  - id: git-add-explicit
    summary: Stage files explicitly; never `git add -A`.
    owner: claude-md            # exactly one surface id
    scar: true                  # scar rules are exempt from single-owner
    canonical_wording: |
      Never `git add -A` / `.` / `--all` — stage files explicitly.
    must_appear_on: [claude-md, agents-md, arch-critical, spir-prompts]
    pattern: 'git add -A'
    enforcement: automated      # automated | manual

  - id: no-time-estimates
    summary: Plans contain no time estimates.
    owner: spir-protocol
    scar: false
    references: [spir-plan-prompt, aspir-plan-prompt]
    pattern: 'time estimate'
    enforcement: automated
```

- `enforcement: automated` — M4/T7 assert `pattern` matches on `owner` alone
  (for `scar: false`) or on all `must_appear_on` (for `scar: true`).
- `enforcement: manual` — recorded in the map for humans; not machine-asserted.
  Used where a rule is paraphrased legitimately and no reliable pattern exists.
- The plan must classify every instruction class it touches, and justify any
  `manual` designation.

## Appendix B — Preliminary compatibility audit (M7)

Repo-wide search for literal `codev/protocols/` and `codev/roles/` references
in `packages/*/src`: **26 non-test, 95 in tests**. Classification of the
non-test hits:

| Kind | Example | Deletion-safe? |
|---|---|---|
| Resolver-routed read | `consult/index.ts:175` → `readCodevFile(...)` | **Yes** — falls through to skeleton |
| Resolver-routed read | `porch/protocol.ts` → `resolveCodevFile` / `getSkeletonDir` | **Yes** |
| Error-message text | `porch/protocol.ts:28` "Searched in: …" | **Yes** — string only |
| Doc comment | `framework-ref-audit.ts:21`, `roles.ts:7` | **Yes** |
| Vestigial writer | `scaffold.ts:425,480` (`copyRoles`, `copyProtocols`) | **Yes** — uncalled; removed by M9 |

No direct-read consumer was found. This is preliminary: the plan must complete
the audit across tests and any non-TypeScript consumers before M8 executes.

## Appendix C — Model-capability tiering (S2, C4)

Specified to the level Codex requires — mechanism, selector, fallback, scope:

- **Tiers**: `strong` (compressed form) and `weak` (fuller scaffolding). Two
  tiers only; more can be added later without schema change.
- **Selector**: an explicit config key, `promptTier`, in `.codev/config.json`.
  Explicit configuration beats model-string sniffing, which breaks on every new
  model id.
- **Fallback**: when `promptTier` is absent or unrecognized, **default to
  `weak`** (fuller scaffolding). Failing toward more instruction is the safe
  direction: a strong model given extra scaffolding wastes tokens, whereas a
  weak model denied scaffolding produces wrong work.
- **Scope for this iteration**: **documentation-only**. The map records a
  `tier` per surface and the selector plus fallback are specified and tested;
  no runtime prompt-assembly branching ships under this spec. Runtime tiering
  is a follow-up, gated on Q4.
- **Scar rules are tier-invariant** — they appear in full at every tier.

---

## Expert Consultation

### Iteration 1 — 3-way review

| Model | Verdict |
|---|---|
| Gemini | **APPROVE** — "comprehensive, empirical, well-structured"; no key issues |
| Codex | **REQUEST_CHANGES** — 5 issues, all accepted |
| Claude | **COMMENT** — 4 issues, all accepted |

**Codex — accepted in full:**

1. *Critical questions gate the end state.* → Success Criteria restructured:
   M1–M7 required and Q1-independent; M8–M10 conditional on Q1.
2. *M2 allowed two incompatible outcomes.* → M2 is now solely "drift cannot pass
   CI." Deletion moved to M8.
3. *M4 under-specified.* → Appendix A defines instruction class, schema, and
   `automated`/`manual` enforcement.
4. *Approach A feasibility unbounded.* → Q5 promoted to M7 with Appendix B's
   preliminary audit; deletion is conditional and gated behind the parity gate.
5. *Tiering too vague.* → Appendix C fixes selector, fallback, and scope.

**Claude — accepted in full:**

6. *`protocol-drift-audit` (#1210) unmentioned.* → **The most valuable finding.**
   Iteration 1's "no test asserts…" was misleading and is corrected; the module
   is now a named dependency and M2 extends it rather than reinventing it.
   Verified: `auditProtocolDrift`, `FRAMEWORK_DRIFT_DIRS`, `doctor.ts:947`.
7. *"19 drifted" is wrong.* → Confirmed **17** (16 protocols + 1 roles). The 19
   conflated drifted files with local-only entries; the spec now separates them.
8. *Local-only `maintain/templates/` files unhandled.* → Named in A2, M8, and
   guarded by new test T8.
9. *"63 markdown files" ambiguous.* → Now stated as 63 `.md` / 73 `md+json` for
   `protocols/`, 76 shadow copies including `roles/`. Also: "shadow tree" is
   now defined once in **Terminology**.

**Gemini — accepted:** machine-readable ownership map (Appendix A, Q6 resolved);
grep audit before deletion (M7, Appendix B).

**Builder-originated corrections** found while verifying Codex's issue 4:
`copyProtocols`/`copyRoles` are vestigial, so adopters have no shadow tree and
ours is a historical artifact (A1 corrected; M9 added).

### Iteration 2

Pending — porch will run the second 3-way review.

---

## Approval

- [ ] Architect approval (gate: `spec-approval`)
- [x] 3-way consultation, iteration 1
- [ ] 3-way consultation, iteration 2

---

## Notes

The strongest argument for this work is not the token count. It is that the
project filed to fix prompt drift was itself spawned with a drifted prompt,
missing its own verify-phase instructions — and that a detector for exactly this
condition (#1210) had been shipping the finding to `codev doctor` the whole time,
unread. The gap is not detection. It is that nothing was allowed to fail.
