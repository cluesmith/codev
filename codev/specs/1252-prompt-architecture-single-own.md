# Spec 1252: Prompt Architecture — Single-Owner Rule for Instruction Content

## Metadata

- **Issue**: #1252
- **Protocol**: SPIR
- **Area**: `area/cross-cutting`
- **Status**: draft (iteration 2 — revised after 3-way consultation; amended
  with architect decisions D1–D4, 2026-07-27)
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
   compressed canonical wording. Deduplication never applies to them.
4. **The win is measured** by a reproducible before/after script — in **words**
   (M6) *and* in **agent behaviour** (M12). A word reduction that degrades
   compliance is a loss, and the spec must be able to detect that.

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

Restructured per Codex so the end state depends on no unanswered question. With
decisions **D1–D4** relayed (2026-07-27), every criterion below is now
unconditional: M8–M10 were promoted from conditional to required by **D2**, and
**M11** was added by the same decision. Nothing here awaits an architect answer.

### Required — MUST

- **M1 — Ownership map.** A machine-readable map at
  `codev/resources/prompt-ownership.yaml`, with a human-readable companion at
  `codev/resources/prompt-ownership.md` generated from or validated against it.
  Schema in **Appendix A**. It enumerates every prompt surface and, for each
  instruction class, the single owning surface.

  **Completeness rule** *(added iteration 2, per Codex)*. A map is not credible
  merely because its entries are correct — it must also be provably exhaustive,
  or under-listing satisfies M4 trivially. Therefore:

  - The map declares an explicit **inventory boundary**: the exact set of files
    scanned for instruction candidates. Anything outside it is out of scope *by
    declaration*, not by omission.
  - A **candidate extraction** pass over that boundary mechanically collects
    normative statements (imperative/prohibitive constructions — `MUST`,
    `NEVER`, `ALWAYS`, `DO NOT`, `don't`, `Never`, and the like), each keyed by a
    stable id.
  - **Every candidate carries exactly one disposition**: `mapped` (has an
    owner), `scar` (in M5's registry), or `out-of-scope` (**with written
    justification**).
  - **T12** fails on any candidate with no disposition. Consequence: new
    normative text added anywhere inside the boundary fails CI until someone
    dispositions it, so the map cannot silently rot as the prompt surface grows.
  - Per Claude's iteration-2 note, the map **must** record why
    `codev/resources/` is excluded from the drift regime (Q7) — this is required
    M1 coverage, not a trailing nice-to-know.
- **M2 — Drift cannot pass CI.** A test invoking the existing
  `auditProtocolDrift()` **fails the build** on any `differs` finding not listed
  in an explicit, comment-justified allowlist. *This is the one required
  outcome for the shadow tree* — iteration 1's "delete **or** enforce" ambiguity
  is resolved in favour of enforce.

  **Allowlist lifecycle** *(added iteration 2, per Gemini)*. The allowlist is
  the obvious way to re-hide drift, so its decay is enforced rather than merely
  expected: every entry carries a line-item justification comment, and the test
  asserts the allowlist is **empty once M3 completes** — the sole permitted
  residue being files with an open M11 escalation, each of which must reference
  its pending adjudication. An entry that outlives its escalation fails the
  build.
- **M3 — Repair the live drift.** All 17 drifted shadow copies are reconciled
  **per decision D1** (skeleton authoritative; file-by-file; anything resembling
  deliberate local content escalated rather than overwritten), so M2's allowlist
  starts empty. In particular the served SPIR builder prompt regains
  `Multi-PR Mechanics`, `Verify Phase`, and the `"Entering verify phase."`
  string. Files escalated under D1 step 4 may remain in the allowlist, with the
  pending adjudication cited, until the architect rules.
- **M4 — Single-owner enforcement.** For every instruction class whose map entry
  sets `enforcement: automated`, a test asserts the class's `pattern` matches on
  exactly the declared owner. The test **derives assertions from the map file**;
  it must not restate ownership in test code (which would itself violate the
  single-owner rule). Definitions in **Appendix A**.
- **M5 — Scar-rule registry.** A machine-readable registry of the **eight** scar
  rules ratified in **D3**, each with its **one compressed canonical wording**
  (one sentence, two at most) and every surface it must appear on. A test asserts
  verbatim presence on each. **Deleting or rewording a scar rule fails the
  build.** M5's test must pass before any deduplication work begins. Rewriting
  today's banner blocks down to the compressed form is part of this criterion,
  and every surface must then carry the compressed wording byte-identically.
- **M6 — Measurement script.** A committed script reporting always-on word
  counts per surface, runnable before and after to quantify the win.
- **M7 — Compatibility audit.** A repo-wide audit of literal `codev/protocols/`
  and `codev/roles/` references, classifying each as resolver-routed (safe),
  comment/error-string (safe), or direct-read (must fix). Promoted from Q5 to a
  first-class deliverable per Codex. *Preliminary findings in* **Appendix B**.

- **M12 — Behavioral-impact measurement** *(added by architect directive D5,
  2026-07-27)*. M6 counts words; nothing else in this spec observes whether the
  trims **help or harm agent behaviour**. A word-count reduction is a proxy, and
  validating only the proxy is not acceptance. M12 closes that gap.

  **(a) Baseline — captured before ANY prompt-content change.** A committed
  measurement library, `packages/codev/src/lib/prompt-behavior-metrics.ts` (with
  CLI runner `packages/codev/scripts/measure-prompt-behavior.ts`), mines
  behavioural metrics from existing committed artifacts, with its output
  committed as `codev/resources/1252-behavior-baseline.md`. *It lives beside
  `protocol-drift-audit.ts` rather than in the root `scripts/` directory because
  it needs that package's `js-yaml` dependency, which a root-level script cannot
  resolve in this pnpm workspace.* Metric set and sample are
  specified in **Appendix D**, which is grounded in what the repository actually
  stores — several plausible-sounding metrics turned out not to be minable, and
  saying so is part of the deliverable.

  **(b) Verify phase.** This project's SPIR verify phase re-runs the same script
  over the next **N = 10** post-merge builder projects (**≥ 3 of them SPIR** —
  see Appendix D for why the protocol mix matters), compares against the
  baseline, and records an explicit **no-regression judgment**. A defined
  **rollback trigger** (Appendix D §4) states what metric movement reverts
  which commits.

  **(c) A/B eval — considered and deferred.** A controlled A/B (same task, old
  vs new prompts, held-out grader) would isolate cause far better than
  before/after observation, which cannot separate prompt effects from drift in
  task difficulty, model version, or reviewer behaviour. It is deferred: it
  needs a task corpus and grading harness that do not exist, and building them
  is a larger project than this one. A follow-up issue is filed in Phase 8.
  **This is a real weakness of M12, not a formality** — the observational design
  supports "no evidence of harm," not "proved beneficial."

  **Confound to state plainly**: this project both **adds** served content
  (M3 restores the missing `Verify Phase` and `Multi-PR Mechanics` sections) and
  **removes** it (D3 compression, S1 dedup). The baseline is the **pre-project
  state** and the verify comparison therefore evaluates the project's **total
  effect**, not the trims in isolation. A null result could be two real effects
  cancelling. Appendix D §4 mitigates this by attributing rollback to specific
  commits rather than to the project as a whole.

### Required — MUST (shadow-tree removal; activated by D2)

- **M8 — Shadow-tree removal.** `codev/protocols/` and `codev/roles/` shadow
  copies are deleted so the skeleton is the single owner, **preserving all
  local-only entries**: `codev/protocols/release/` and
  `codev/protocols/maintain/templates/{audit-report.md,lessons-learned.md}`.
  **Gated on M11**: no file is deleted until its local-unique audit is complete
  and any escalations are ruled on.
- **M9 — Vestigial scaffold cleanup.** `copyProtocols` and `copyRoles` are
  removed from `scaffold.ts` along with their tests, so the shadow tree cannot
  be reintroduced by rewiring dead code.
- **M10 — Post-deletion equivalence.** For every deleted shadow copy, the
  resolver returns the skeleton counterpart and the assembled spawn prompt is
  byte-identical to the skeleton-sourced expectation.
- **M11 — Local-unique content audit** *(added by D2)*. Before any file is
  reconciled or deleted, produce a committed audit — one row per file across all
  76 shadow copies — classifying every local-vs-skeleton divergence as **rot**
  (local lags; take skeleton) or **local-unique** (content absent from the
  skeleton that plausibly encodes codev-specific functionality).

  Requirements:
  - The audit covers **content inside drifted files**, not just whole files that
    have no skeleton counterpart. A local-unique paragraph inside an otherwise-rotted
    file is exactly the loss this criterion exists to prevent, and D1's
    reconciliation would destroy it first.
  - Every **local-unique** finding is escalated to the architect with the diff
    hunk and a short read on what functionality it appears to provide.
  - **Nothing classified local-unique is overwritten or deleted until the
    architect rules on it.** Escalation blocks that file only; the rest proceed.
  - Where classification is genuinely ambiguous, default to **local-unique** and
    escalate. A needless question is cheap; a silently deleted codev-specific
    behaviour is not.

  **Permitted terminal states** *(added iteration 2, per Codex)*. Every shadow
  copy must end in exactly one of these four states. **"Pending escalation" is
  explicitly NOT terminal** — the feature is not complete while any item sits
  there. *(Count correction, Phase 2: the true shadow-copy count is **77**, not
  76 — mechanical enumeration includes `consult-types/integration-review.md`,
  which the hand count missed. Every "76" in this spec reads as 77; the audit
  artifact is authoritative.)*

  | # | Terminal state | Applies to | Result |
  |---|---|---|---|
  | **TS1** | Reconciled to skeleton, then deleted | `rot` | Skeleton is sole owner |
  | **TS2** | Promoted — unique content moved *into* `codev-skeleton/`, local copy deleted | `local-unique` the architect wants kept **and** shared with adopters | Skeleton is sole owner; functionality preserved for everyone |
  | **TS3** | Retained as a deliberate, documented local override | `local-unique` the architect wants kept **codev-only** | Stays in `codev/`, recorded in the ownership map *and* the M2 allowlist with justification |
  | **TS4** | Dropped | `local-unique` the architect judges obsolete | Deleted, with the ruling recorded |

  **Completion rule**: the spec is complete when every shadow copy is in TS1–TS4
  and **zero escalations remain open**. TS2 is the preferred outcome for genuine
  codev-specific functionality, since TS3 knowingly re-creates a (single,
  documented, allowlisted) shadow copy and should be the exception.

  **Escape hatch — no indefinite block.** If an escalation cannot be resolved
  (architect unavailable, decision genuinely deferred), it converts to **TS3**
  and a follow-up issue is filed referencing the audit row. This keeps the
  conservative outcome — nothing is lost — while guaranteeing the project always
  reaches a defined end state rather than dangling on an unanswered question.

### SHOULD

- **S1** — Non-scar duplicated instruction classes reduced to their single owner
  plus references.

### Non-functional

- **N1** — Reduction in always-on words per builder. **Target ≥ 20%** against
  the measured baseline, without deleting any scar rule. A target for the plan to
  interrogate, **not a gate**; the achieved figure is reported either way.
  *Baseline note (Phase 1)*: the reproducible figure is **21,856** — derived
  from resolved artifacts (CLAUDE.md + spawn-prompt proxy + 10× phase-task
  proxy). The earlier ≈24,600 estimate additionally counted per-project
  variable content (issue body, task-JSON boilerplate), which no trim can
  affect; N1 is evaluated against the reproducible 21,856.
  *Note*: M8 removes ~47k words from the repo but little from *always-on*
  context, so N1 must come from **S1 deduplication plus D3's scar-wording
  compression** — the latter now contributes directly, since collapsing banner
  blocks to one-sentence rules shortens always-on text on every surface the
  rules appear on, without reducing their reach.
- **N2** — No behavioural regression; full existing suite passes.
- **N3** — CLAUDE.md and AGENTS.md remain byte-identical.
- **N4** — Spec 987 HOT-tier caps respected.

### Non-goals

- Not rewriting protocol semantics — only relocating and deduplicating text.
- Not touching COLD `arch.md` / `lessons-learned.md` content.
- Not changing the resolver algorithm.
- Not making `protocol-drift-audit` auto-remediate; adjudication stays human.
- **Not running a controlled A/B eval** of old vs new prompts (M12c). Considered
  and deferred — it needs a task corpus and grading harness that do not exist.
  Follow-up issue filed in Phase 8. The consequence is that M12 can support
  *"no evidence of harm,"* not *"proved beneficial."*
- **Not implementing multi-model fleet tiering** (the issue's proposed direction
  #2). Cut by decision **D4** and deferred to its own issue, to be filed once
  the ownership map exists — the map is the prerequisite that makes tiering
  specifiable.

---

## Constraints

Issue #1252 contains no `Baked Decisions` section. Constraints derive from the
issue body and repository invariants.

### From the issue

- **C1** — Single-owner rule: exactly one owning surface per instruction.
- **C2** — Inventory and ownership map precede any restructuring.
- **C3** — **Scar rules are exempt.** They stay verbatim and always-on wherever
  they apply. Deduplication never applies to them.
- ~~**C4** — Multi-model fleet tiering by consuming model capability.~~
  **Cut from this spec by architect decision D4** (2026-07-27) and deferred to
  its own issue. This is the issue's proposed direction #2, deliberately
  descoped — not dropped by oversight. See **Non-goals**.

### From repository invariants

- **C5** — CLAUDE.md and AGENTS.md MUST stay byte-identical.
- **C6** — Framework changes mirrored in both `codev/` and `codev-skeleton/`.
  *If M8 proceeds, this invariant is retired for `protocols/` and `roles/` and
  `arch-critical.md` must be updated to say so.*
- **C7** — Framework files are delivered via spawn prompt and porch JSON, never
  fetched by literal `codev/...` path (`framework-ref-audit`).
- **C8** — HOT-tier files capped (≤10 facts, ≤12 map topics, ≤35 lines).
- **C9** — Never `git add -A` / `.` / `--all`.

### Scar rules — ratified list (D3; eight rules)

Ratified by the architect 2026-07-27. Canonical wordings must be **compressed**
to one sentence (two at most) per **D3**; the drafts below are indicative, and
the plan registers the final compressed text in M5's registry.

1. Never `git add -A` / `.` / `--all` — stage files explicitly.
2. Never destroy builder worktrees (`git worktree remove`, `git branch -D`,
   `afx cleanup` + respawn); use `--resume`, and ask when in doubt.
3. Never `git reset --hard` / `git checkout -- .` / `git clean -fd` /
   `git stash` without explicit permission.
4. Never auto-approve porch gates; only humans approve.
5. Never hand-edit `status.yaml`.
6. Run `afx` only from the main workspace root.
7. **Never kill shellper processes without the verified-orphan procedure.**
8. **Never restart Tower without explicit human permission.**

Rules 7–8 were added by D3; 1–6 carried over from the builder's proposed list.

The 9 differing wordings of the `git add -A` rule are a **consistency** problem,
not a duplication problem. The fix is to converge on one compressed canonical
wording repeated verbatim — **not** to reduce the number of copies.

---

## Architect Decisions

Decisions relayed by the architect. These are **fixed** and are not to be
relitigated in the spec, plan, or review — treated with the same standing as a
`Baked Decisions` section. Remaining open items stay in **Open Questions**.

### D1 — Drift reconciliation direction *(answers Q2; 2026-07-27)*

**The skeleton is authoritative for all 17 drifted files.** Reconciliation is
file-by-file, not a bulk overwrite:

1. Enumerate all 17 (the 16 protocol files named in the Problem Statement, plus
   `codev/roles/architect.md`).
2. For each, diff local against skeleton and classify the divergence as
   *missing content* (local lags the skeleton) or *possible deliberate local
   content* (local adds or alters something the skeleton lacks).
3. *Missing content* → take the skeleton version.
4. *Possible deliberate local content* → **escalate to the architect; do not
   silently overwrite.** Reconciliation of those files waits for a ruling.

This governs **M3**. It does not decide Q1: reconciling the files and deleting
the tree are separate acts, and D1 applies whether or not deletion follows.

### D2 — Shadow-tree deletion approved, with a local-unique safeguard *(answers Q1; 2026-07-27)*

**Yes — delete the shadow copies.** M8, M9, and M10 are hereby **active and
required**, no longer conditional.

One strengthening condition, in the architect's words:

> *"mostly delete, but if there are any unique things can we discuss them to
> make sure we're not losing functionality specific to codev."*

This adds **M11** (below). The safeguard is broader than the local-only file
list already in A2: it covers **local-unique content anywhere** in
`codev/protocols/` or `codev/roles/` — including content that lives *inside an
otherwise-drifted file*, which D1's reconciliation would otherwise overwrite
before deletion ever runs.

The operative distinction is **local-unique functionality vs. rot**:

| Classification | Meaning | Action |
|---|---|---|
| **Rot** | Local lags the skeleton; the difference is stale or missing content | Take the skeleton (D1) |
| **Local-unique** | Content present locally, absent from the skeleton, that plausibly encodes codev-specific functionality | **Escalate for human discussion before it is lost** |

Escalation is **blocking for that file only** — reconciliation and deletion of
the remaining files proceed. Nothing classified local-unique is overwritten or
deleted until the architect rules on it.

### D3 — Scar-rule registry ratified: eight rules, compressed *(answers Q3; 2026-07-27)*

**All eight ratified** — the spec's original six plus two additions:

7. Never kill shellper processes without the verified-orphan procedure.
8. Never restart Tower without explicit human permission.

**Amendment: canonical wordings must be materially compressed** — one compact
sentence, two at most, per rule. Not today's multi-line banner blocks (e.g.
CLAUDE.md's `### 🚨 ABSOLUTE PROHIBITION: NEVER USE git add -A 🚨` block).

Verbatim-replication (C3) and delete/reword CI protection (M5, T6) apply to the
**compressed canonical form**. Once a compressed wording is registered, it is
the wording — replicated byte-identically everywhere the rule appears, and
protected against silent deletion or rewording.

Note the direction of travel: compression **reduces** always-on words while the
rules stay everywhere they were. Scar rules remain exempt from the single-owner
rule — this shortens them, it does not deduplicate them.

### D5 — Behavioral-impact measurement required *(2026-07-27)*

The issue's architect-guidance made impact measurement mandatory — *"a trim
proposal without a way to evaluate it is not accepted."* The spec as approved
satisfied this only with **M6 word counts and structural tests**, which measure
the proxy rather than the effect. That is a real gap and the spec did not close
it.

Directive: add a required criterion covering **(a)** a baseline captured before
any prompt-content change, **(b)** a defined verify phase re-running the same
measurement post-merge with a no-regression judgment and rollback trigger, and
**(c)** a documented decision that a controlled A/B eval was considered and
deferred, with a follow-up pointer.

Implemented as **M12** with **Appendix D**. Note that M3's drift repair itself
changes served prompts: the baseline is the **pre-project state**, and the verify
comparison evaluates the project's **total effect**.

### D4 — Model-capability tiering cut *(answers Q4; 2026-07-27)*

**Cut entirely from this spec.** Removed: S2, constraint C4, Appendix C, and the
`tier` field from the Appendix A schema. Tiering becomes its own future issue,
to be filed once the ownership map exists. Recorded in **Non-goals**.

This descopes the issue's proposed direction #2. It is a deliberate architect
decision, not an oversight, and is flagged as such wherever C4 appeared.

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

### Approach A — Delete the shadow tree *(required; approved by D2)*

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
  needed in place) — mitigated by M5, T6, and T13.

### Sequencing: B → A → C *(all three now in scope per D2)*

Order matters:

1. **B first** — cheap, stops the bleeding, and is the safety net that makes
   deletion auditable. Deleting is far safer once a gate can prove the trees
   agree.
2. **M11 local-unique audit** — before any reconciliation touches a file. This
   must precede **M3**, not follow it: D1 reconciliation overwrites local content
   with the skeleton, so an unaudited local-unique paragraph would be destroyed
   before deletion was ever reached. **M11 → M3 → M8** is the only safe order.
3. **M3 repair** — reconcile per D1, skipping anything M11 escalated. Required
   for B's allowlist to start empty (escalated files excepted, with the pending
   adjudication cited).
4. **A (M8–M10)** — the largest structural win, de-risked by B, Appendix B, and
   M11.
5. **C last** — the durable fix, applied to a surface that is no longer doubled,
   so the map describes one tree.

M5's scar registry (with D3's compressed wordings) must be in place and passing
before **C** begins, since C is the step that could otherwise strip a scar rule.

---

## Open Questions

**All four critical/important questions were answered by the architect on
2026-07-27.** No open question now blocks or shapes the criteria.

### Answered — see *Architect Decisions*

- **Q1** — ***ANSWERED → D2.*** Delete the shadow copies; M8–M10 promoted to
  required, plus new **M11** local-unique safeguard.
- **Q2** — ***ANSWERED → D1.*** Skeleton authoritative; file-by-file; escalate
  anything resembling deliberate local content.
- **Q3** — ***ANSWERED → D3.*** Eight scar rules ratified; canonical wordings
  compressed to one or two sentences.
- **Q4** — ***ANSWERED → D4.*** Tiering cut from this spec and deferred to its
  own issue.

### Nice-to-know

- **Q5** — *Resolved and promoted to M7.* Preliminary audit in Appendix B.
- **Q6** — *Resolved.* The ownership map is machine-readable (Appendix A), per
  Gemini's recommendation and to avoid M4's test restating ownership.
- **Q7** — *Resolved into M1, per Claude's iteration-2 note.* `codev/resources/`
  shared files (`arch-critical.md`, `lessons-critical.md`,
  `workflow-reference.md`, `spikes.md` — all currently differing from their
  skeleton twins) stay **out** of the drift regime: they are user-evolved files
  where divergence is legitimate. `FRAMEWORK_DRIFT_DIRS` already excludes
  `resources`, so the default is correct. Recording *why* is now **required M1
  coverage** rather than a nice-to-know, and M2's allowlist must not
  accidentally cover them.

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

### T6 — Scar-rule presence (M5, D3)

All **eight** registry rules appear verbatim — in their **compressed canonical
form** — on every required surface. Mutation checks: deleting a scar rule fails;
rewording it fails. Rules 7 (shellper) and 8 (Tower restart) are covered
identically to the original six.

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

### T11 — Local-unique audit completeness (M11)

*Automated.* The committed audit has **one row per shadow copy** (all 76), each
classified `rot` or `local-unique` and each resolved to a terminal state
TS1–TS4. Cross-checks: every file deleted under M8 appears in the audit with a
resolved classification; no file classified `local-unique` was deleted or
overwritten without a recorded architect ruling; **no row remains in "pending
escalation."** This test guards the *process*, not just the outcome — an
unaudited deletion must fail.

### T12 — Ownership-map completeness (M1)

*Automated.* Every candidate produced by the extraction pass over the declared
inventory boundary carries exactly one disposition (`mapped`, `scar`, or
`out-of-scope` with justification). Any undispositioned candidate fails. A
seeded normative line added inside the boundary must fail the test until
dispositioned — asserting the guard actually bites rather than passing
vacuously on an empty candidate set.

### T14 — Behavioural baseline script (M12a)

*Automated.* `scripts/measure-prompt-behavior.ts` runs clean and is
**deterministic over the committed-artifact metrics B1–B4** — the same commit
must yield the same B1–B4 numbers, or before/after comparison is meaningless.

**B5 is explicitly excluded from the determinism assertion.** It derives from
`consult stats`, a rolling 30-day machine-local DB, so it is not reproducible
from a commit and never will be. Asserting determinism over B1–**B5** (as the
first draft of T14 did) was internally contradictory — caught by Codex at delta
review. B5 is reported as advisory context and drives no trigger.

Also asserts: the SPIR sample resolves to the expected project count; B3 emits
matched excerpts alongside counts; and the script does **not** attempt
gate-rejection counts (Appendix D §2 — the data does not exist, and a
plausible-looking zero would be worse than an absent metric).

### T13 — End-to-end, the real user path

**Part (a), automated**: assemble the builder spawn prompt in-process and assert
it contains the verify-phase instructions and all eight scar rules in their
compressed canonical form. This is the regression guard and must be part of CI.

**Part (b), manual, once — RESCHEDULED TO THE VERIFY PHASE** *(architect
ruling, 2026-07-28, on a discovered constraint)*: `afx spawn` has no branch
selector — every spawn branches from main HEAD, so a pre-merge probe would be
assembled from the PRE-change tree and would verify nothing about this branch;
the only pre-merge alternative (local-installing the branch build globally +
Tower restart) is disproportionate. **End-to-end verification of
resolver-tier changes is inherently post-deploy.** The pre-merge proxy is the
committed prompt-snapshot assertions (nine protocols, real
`buildPromptFromTemplate`, byte-compared). At verify — post-merge and
post-local-install — the architect runs a disposable `afx spawn --task` probe
from the main root and records the assembled prompt in the review. This is a
discovered constraint documented as such, not a skipped test.

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
| A scar rule silently dropped during deduplication | **Critical** — reintroduces a known data-loss incident | M5 registry + T6 mutation tests passing *before* any deduplication; eight rules ratified in D3 |
| **Codev-specific functionality lost when the shadow tree is deleted** | **Critical** — silent capability regression, and the loss is only visible later | **M11** audit precedes reconciliation *and* deletion; covers content *inside* drifted files; ambiguous cases default to escalate; T11 |
| Compressing a scar wording weakens the rule's force | High | D3 compression is reviewed at the gate; T6 protects the compressed form thereafter; meaning-preservation is a plan-phase review item |
| Deleting the shadow tree breaks a path-based reader | High | M7 audit precedes deletion; B's gate proves equivalence; T9 checks every deleted file |
| Over-stripping leaves an agent without a needed rule | High | Deduplicate only non-scar classes; T13 inspects the assembled prompt |
| Ownership map under-lists, making M4 pass vacuously | High | M1 completeness rule — declared inventory boundary + mandatory disposition; T12 fails on any undispositioned candidate |
| An M11 escalation stalls and the project dangles | Medium | "Pending" is not a terminal state; unresolved escalations convert to TS3 with a filed follow-up issue |
| **Trims degrade agent behaviour while every structural test stays green** | **Critical** — the failure M6 cannot see | M12 baseline + verify; B3 scar-violation mining; hard rollback trigger on a single incident |
| Baseline captured after content already changed, so there is no clean "before" | High | M12(a) completes in Phase 1, before any phase that alters served prompt content |
| Verify window closes with too little data and "no regression" is declared vacuously | Medium | Appendix D §4: < N=10 or < 3 SPIR ⇒ **inconclusive**, not success |
| Add-and-remove effects cancel, hiding a real regression | Medium | Rollback attributed to specific commits (Phases 5/7), not to the project as a whole |
| M3 reconciliation destroys local-unique content before deletion is reached | High | Sequencing is fixed **M11 → M3 → M8**; M3 skips anything M11 escalated |
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

## Appendix D — Behavioral metrics, sample, and rollback trigger (M12)

Every claim here was verified against the repository before being proposed. The
directive listed candidate metrics; two of them are **not minable**, and
substituting something measurable is more useful than specifying something
aspirational.

### 1. What the repository actually stores

| Source | Volume | Usable for baseline? |
|---|---:|---|
| `codev/projects/*/status.yaml` — `history[].reviews[].verdict` | 17 projects | **Yes** — the only structured CMAP record |
| `codev/reviews/*.md` | 211 | **Yes** — prose; keyword-mined |
| `codev/state/*_thread.md` | 139 | **Yes** — prose; keyword-mined |
| Gate rejection counts | — | **No** — see §2 |
| `consult` token/cost stats | 30-day local DB | **Prospective only** — see §2 |

`codev/projects/*/*.txt` (the raw consult logs) are **gitignored**
(`.gitignore:59`), so no historical consult output survives in the repo. This is
the single biggest constraint on the baseline.

### 2. Candidate metrics that had to be dropped or re-scoped

- **Gate rejection / re-request counts — NOT MINABLE.** Across all 201 projects,
  gate `status` only ever takes the values `approved`, `complete`, `in_progress`,
  `pending`. There is no `rejected` state, and `requested_at` is a single scalar
  that a re-request overwrites rather than appends to. A rejected-then-approved
  gate is indistinguishable from a first-time approval. *Recording this so the
  metric is not silently dropped: it was requested, and it cannot be delivered
  from committed history.* (A porch change to append gate events would make this
  minable in future — noted as a possible follow-up, out of scope here.)
- **Tokens per phase — PROSPECTIVE ONLY.** `consult stats` reports invocations,
  duration, and cost, but over a rolling 30-day window from a machine-local DB.
  There is no Feb–Jun history to form a retrospective baseline. It is therefore
  captured as a **forward baseline snapshot** at Phase 1 and compared in verify —
  a weaker design than the others, and labelled as such.

### 3. The metric set and sample

**Sample for retrospective metrics (B1–B2): the 17 SPIR projects with non-empty
`history`**, spanning 2026-02 → 2026-06. Small, and stated as such. `history` is
populated for SPIR (per-plan-phase review loops) and empty for `pir`/`bugfix`/
`air`, which is why the sample is protocol-skewed rather than 201-wide.

| ID | Metric | Definition | Source | Sample | Baseline (measured 2026-07-27) |
|---|---|---|---|---|---|
| **B1** | CMAP `REQUEST_CHANGES` rate | share of all verdicts that are `REQUEST_CHANGES` | `history[].reviews[].verdict` | 17 SPIR | **51.9%** (n=160 verdicts; APPROVE 41.2%, COMMENT 6.9%) |
| **B2** | Review rounds per plan phase | `max(iteration)` per `plan_phase` | `history[].iteration` | 17 SPIR | mean **1.12**, median 1, max 2 (n=49 phases) |
| **B3** | Scar-violation incidents | keyword-mined mentions of the eight D3 rules being violated | 211 reviews + 139 threads | all | to be captured in Phase 1 |
| **B4** | Review rounds per project | sum of B2 across a project's phases | `status.yaml` | 18 with history | mean **3.06**, median 3 |
| **B5** | Consult cost/duration | forward snapshot only (§2) | `consult stats` | prospective | **non-deterministic — advisory only** |

**B2 was redefined after the delta review.** It originally read "rounds to
unanimous approve," which is **not derivable**: across the 17-project baseline,
**0 of 48 terminal plan phases end with 3× `APPROVE`**. The commonest terminal
state is 2 × APPROVE + 1 × REQUEST_CHANGES (20/48), and 7/48 advance with three
REQUEST_CHANGES. Porch advances a phase after the builder rebuts, not on
consensus, so a "rounds to unanimity" counter would never resolve. Caught by
Codex and confirmed independently before the redefinition.

**Consequences for how much weight each metric carries:**

- **B1 is the load-bearing metric.** It has a real baseline (51.9%) and genuine
  variance, so a relative rise is meaningful. The soft rollback trigger keys off
  it.
- **B2 and B4 are advisory, not triggers.** B2's observed range is 1–2 with mean
  1.12 — almost no variance, so it cannot detect a subtle regression. Recording
  this rather than implying more sensitivity than the data supports.
- **B3 is the metric that matters most** and is the fuzziest — it is the only one
  that would catch a compressed scar rule losing its force, which is the specific
  harm compression risks. Fuzzy by construction: prose keyword mining, with false
  positives from documentation *about* a rule rather than a violation of it. The
  script must report **matched excerpts, not just counts**, and a human
  adjudicates before the hard trigger fires.
- **B5 is advisory and non-deterministic** — see §2. It is excluded from T14's
  determinism assertion and from every rollback trigger.

### 4. No-regression judgment and rollback trigger

Rollback targets **the trims, never the repairs**. Phases 1–4 (drift gate, audit,
reconcile, shadow removal) *restore* correct content; reverting them would
reintroduce the drift bug this project exists to fix. Only Phases 5 and 7 removed
text, so only they are rollback candidates.

| Trigger | Threshold | Action |
|---|---|---|
| **Hard — scar violation** | **Any single** B3 incident in the verify window attributable to a missing or weakened rule | Revert the **Phase 5** compression commit (and Phase 7 if the rule was a dedup target). n=1 suffices; scar rules exist because the incident already happened once. |
| **Soft — review friction** | B1 `REQUEST_CHANGES` rate rises **> 25% relative** to the measured 51.9% baseline — i.e. **above ~64.9%** — sustained across the N sample | Revert **Phase 7** dedup commits; keep Phases 1–6. Re-measure before any further trimming. |
| **Advisory** | B2/B4/B5 movement without B1/B3 movement | No revert. Record and investigate — B2's observed range (1–2) is too narrow to carry a trigger, and B5 is non-deterministic. |
| **Inconclusive** | Fewer than N=10 projects, or < 3 SPIR, complete in the window | **Do not declare success.** Extend the window or record the verify as inconclusive. Absence of data is not a no-regression result. |

The last row matters: with n=17 baseline and N=10 verify, this design detects a
large regression, not a subtle one. The honest claim available at the end is
**"no evidence of behavioural harm at this sample size"** — not "the trims were
beneficial." Anything stronger requires the deferred A/B.

---

## Appendix C — *(removed)*

Model-capability tiering was cut from this spec by decision **D4** and deferred
to its own issue. Codex's iteration-1 point C-5 (tiering was underspecified) is
resolved by descoping rather than by specification.

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
   M1–M7 required and Q1-independent; M8–M10 conditional on Q1. *(Superseded by
   D2: Q1 answered yes, so M8–M10 are now required. Codex's structural point
   still stands — the spec was made answer-independent first, which is why the
   decisions could be absorbed cleanly.)*
2. *M2 allowed two incompatible outcomes.* → M2 is now solely "drift cannot pass
   CI." Deletion moved to M8.
3. *M4 under-specified.* → Appendix A defines instruction class, schema, and
   `automated`/`manual` enforcement.
4. *Approach A feasibility unbounded.* → Q5 promoted to M7 with Appendix B's
   preliminary audit; deletion is conditional and gated behind the parity gate.
5. *Tiering too vague.* → Appendix C fixed selector, fallback, and scope.
   *(Superseded by D4: tiering cut from the spec entirely and deferred to its own
   issue. Codex's objection is resolved by descoping rather than specification —
   the cleaner outcome, since it was the least-grounded part of the spec.)*

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

Porch advanced directly to the `spec-approval` gate after the iteration-1
rebuttal. The architect directed (2026-07-27) that a second 3-way review be run
against the revised spec before the gate decision, so that the restructured
success criteria (M1–M7 required / M8–M10 conditional) and the three new
appendices get reviewer re-validation rather than shipping reviewer-informed
but unvalidated.

Held until the architect's complete decision set landed (2026-07-27), so that a
**single** review runs against the fully-amended spec rather than one that
changes underneath the reviewers.

Amendment state at review time: **D1–D4 all recorded.** The revised spec differs
from iteration 1 in five material ways, and reviewers were asked to focus there:

1. Success criteria restructured — M1–M7 required and question-independent.
2. M8–M10 promoted from conditional to required (**D2**), plus new **M11**
   local-unique content audit with fixed **M11 → M3 → M8** sequencing.
3. Scar registry ratified at **eight** rules with **compressed** canonical
   wordings (**D3**).
4. Tiering **cut** — S2, C4, Appendix C, and the schema's `tier` field removed
   (**D4**).
5. New Appendices A and B; Appendix C removed.

**Verdicts:**

| Model | Verdict | Confidence | Issues |
|---|---|---|---|
| Gemini | **APPROVE** | HIGH | None (1 non-blocking suggestion) |
| Codex | **REQUEST_CHANGES** | HIGH | 2 |
| Claude | **APPROVE** | HIGH | None blocking (3 minor) |

All six points accepted; none disputed. Changes made:

1. **Codex — ownership-map completeness not testably defined.** The sharpest
   catch of the round: M4 only validated entries *already in* the map, so a map
   listing 3 of 40 rules would have passed every test. → M1 gains a
   **completeness rule** (declared inventory boundary + mechanical candidate
   extraction + mandatory `mapped`/`scar`/`out-of-scope` disposition) and
   **T12**, which fails on any undispositioned candidate and is itself checked
   against a seeded line so it cannot pass vacuously.
2. **Codex — terminal state for escalated `local-unique` files unspecified.**
   → M11 gains four explicit terminal states (**TS1–TS4**), declares "pending
   escalation" **non-terminal**, sets the completion rule (all 76 in TS1–TS4,
   zero open escalations), and adds an escape hatch so an unresolved
   architect question converts to TS3 + follow-up issue rather than blocking
   indefinitely.
3. **Gemini — allowlist lifecycle.** → M2 now *enforces* decay: line-item
   justifications, empty after M3, sole residue being open M11 escalations that
   must cite their adjudication.
4. **Claude — T11/T12 ordering non-sequential.** → Tests renumbered; all
   cross-references in the risk table and Approach C corrected.
5. **Claude — T11 automated-vs-manual unclear.** → Now **T13**, split into an
   automated CI part (a) and a one-time manual spawn (b), with the reasoning
   stated: part (a) can pass while the real spawn path diverges, which is
   exactly the failure that produced this project.
6. **Claude — Q7 should be required M1 coverage.** → Q7 resolved into M1;
   recording why `codev/resources/` is excluded is now mandatory.

Two risk rows added (vacuous-map, stalled-escalation).

Rebuttal: `codev/projects/1252-prompt-architecture-single-own/1252-specify-iter1-rebuttals.md`

---

## Approval

- [ ] Architect approval (gate: `spec-approval`)
- [x] 3-way consultation, iteration 1 (Gemini APPROVE / Codex REQUEST_CHANGES / Claude COMMENT — all 9 issues accepted)
- [x] Architect decisions D1–D4 relayed and absorbed (2026-07-27)
- [x] 3-way consultation, iteration 2 (Gemini APPROVE / Codex REQUEST_CHANGES / Claude APPROVE — all 6 points accepted)

---

## Notes

The strongest argument for this work is not the token count. It is that the
project filed to fix prompt drift was itself spawned with a drifted prompt,
missing its own verify-phase instructions — and that a detector for exactly this
condition (#1210) had been shipping the finding to `codev doctor` the whole time,
unread. The gap is not detection. It is that nothing was allowed to fail.
