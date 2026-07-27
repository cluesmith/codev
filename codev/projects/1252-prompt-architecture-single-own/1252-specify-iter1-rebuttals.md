# Spec 1252 — Rebuttal to iteration-1 review feedback

| Model | Verdict | Issues raised | Accepted | Disputed |
|---|---|---|---|---|
| Gemini | APPROVE | 0 (2 plan-phase suggestions) | 2 | 0 |
| Codex | REQUEST_CHANGES | 5 | 5 | 0 |
| Claude | COMMENT | 4 | 4 | 0 |

**I dispute nothing.** All nine issues were valid. Two corrected factual errors
of mine, and one (Claude's #1) materially reduced the scope of the work. Every
change below is committed in `c58aff65`.

Where I extended beyond what a reviewer asked, I say so explicitly, because
those additions are mine to defend rather than theirs.

---

## Codex (REQUEST_CHANGES) — all five accepted

### C-1 — "Critical scope-defining decisions unresolved (Q1, Q2)"

> *A spec should not make its primary end state depend on unanswered critical
> questions.*

**Accepted.** This was the right call and the most structurally important of
Codex's points. Iteration 1 recommended deletion as the headline path while
simultaneously admitting deletion required architect permission it did not
have — so the spec's end state was undefined until someone answered Q1.

**Changed**: Success Criteria split into two blocks.

- **Required (M1–M7)** — hold regardless of how Q1 and Q2 are answered.
- **Conditional (M8–M10)** — shadow-tree deletion, vestigial-scaffold cleanup,
  and post-deletion equivalence, active only on an affirmative Q1.

A "no" on Q1 now drops M8–M10 and still ships a complete, valuable result
(drift permanently gated + ownership map + deduplication). Q1 and Q2 remain
listed as Critical because they *are* architect decisions, but they no longer
gate the deliverable. Stated explicitly at the end of **Recommended
sequencing**.

### C-2 — "M2 is ambiguous/test-hostile — two incompatible outcomes"

**Accepted.** Iteration 1's M2 read "either the shadow trees are removed, or a
test fails on any divergence," which is untestable as written — a test cannot
assert a disjunction of two different world states.

**Changed**: M2 is now exactly one thing — *drift cannot pass CI*. Deletion
moved wholesale to M8. M2 is satisfied by a gate that fails on any `differs`
finding outside a justified allowlist, whether or not deletion ever happens.

### C-3 — "M4 is under-specified"

> *"instruction class" and "machine-checkable" are not defined tightly enough
> for a builder to implement a reliable test.*

**Accepted.** Fair — I used both terms without defining either.

**Changed**: added **Appendix A**, which defines an instruction class ("a single
normative rule an agent is expected to follow, identified by a stable `id` and
detectable by `pattern`"; descriptive prose explicitly excluded) and gives the
concrete YAML schema for `codev/resources/prompt-ownership.yaml` with a worked
example. `enforcement` is now an explicit per-class field with two values:
`automated` (M4/T7 assert it) and `manual` (recorded for humans, not asserted,
and each use must be justified in the plan). M4 also now requires the test to
**derive** assertions from the map rather than restate them — otherwise the
enforcement mechanism would itself violate the single-owner rule.

### C-4 — "Approach A feasibility is not yet bounded enough"

> *Direct repo reads show many literal `codev/protocols/` / `codev/roles/`
> references across docs, tests, scaffolding, and spawn code.*

**Accepted, and verified rather than assumed.** Codex's count is right: 26
non-test and 95 test references in `packages/*/src`.

**Changed**: Q5 promoted from a nice-to-know question to **M7**, a first-class
required deliverable (Codex's own option (b)), plus **Appendix B** recording the
preliminary audit.

**One qualification, offered as evidence rather than disagreement.** Codex
inferred feasibility risk from reference *count*. Classifying the references
changes the conclusion: every production consumer routes through the resolver
and so falls through to the skeleton —

- `consult/index.ts:175` → `readCodevFile(...)`
- `porch/protocol.ts` → `resolveCodevFile` / `getSkeletonDir`

— and the remainder are doc comments, an error-message string
(`porch/protocol.ts:28`), and the vestigial writers in `scaffold.ts`. No
direct-read consumer exists. So deletion is **lower**-risk than iteration 1
judged, not higher. I have still adopted Codex's remedy in full: M7 requires
the audit to be *completed* across tests and non-TypeScript consumers before
M8 executes. Appendix B is labelled preliminary for exactly that reason.

**This investigation also produced the largest correction in the revision** —
see *Builder-originated corrections* below.

### C-5 — "Model-capability tiering is too vague for implementation"

> *The spec does not define the minimum supported selector, fallback behavior,
> or whether tiering is documentation-only versus runtime behavior.*

**Accepted** — those are precisely the three unspecified axes.

**Changed**: added **Appendix C**, fixing all three.

- **Selector**: explicit `promptTier` key in `.codev/config.json`. Chosen over
  model-string detection, which breaks on every new model id.
- **Fallback**: absent or unrecognized → `weak` (fuller scaffolding). Failing
  toward *more* instruction is the safe direction: a strong model given extra
  scaffolding wastes tokens; a weak model denied scaffolding produces wrong
  work.
- **Scope**: documentation-only this iteration. The map records a `tier` per
  surface; the selector and fallback are specified and tested; no runtime
  prompt-assembly branching ships. Runtime tiering is a follow-up gated on Q4.
- Added: **scar rules are tier-invariant** — full text at every tier. Without
  this, tiering would become a back door around C3.

---

## Claude (COMMENT) — all four accepted

### CL-1 — "`protocol-drift-audit` (#1210) not mentioned" *(Medium)*

**Accepted. This is the most valuable finding of the review**, and it means
iteration 1 was about to have me build something that already exists.

Verified directly: `packages/codev/src/lib/protocol-drift-audit.ts` (10,798
bytes) exports `auditProtocolDrift()`, `hasFrameworkShadows()`, and
`FRAMEWORK_DRIFT_DIRS = ['protocols', 'consult-types', 'roles']`, classifying
each shadow copy `identical | differs`. `codev doctor` already calls it at
`doctor.ts:947`. A test suite exists at
`packages/codev/src/__tests__/protocol-drift-audit.test.ts`.

Claude is also right that my wording was misleading. Iteration 1 said "no test
asserts that `codev/protocols/` matches `codev-skeleton/protocols/`." Drift *is*
detected and *is* reported; what is missing is that nothing **fails the build**.

**Changed**: #1210 is now a named Dependency, listed first in the *Existing
enforcement machinery* table, and given its own subsection. The misleading claim
is corrected in place. M2 is rewritten from "write a parity test" to "wire the
existing audit into a CI gate with an adjudication allowlist" — a substantially
smaller and better-founded piece of work. T5 now also asserts the gate *bites*
(a seeded divergence must fail it), since a gate that reports without failing is
the exact condition that let this drift persist.

I also sharpened the framing in **Notes**: our 17 drifted files were visible to
`codev doctor` all along and were ignored. The gap was never detection.

### CL-2 — "'19 drifted files' appears to be 17" *(Low)*

**Accepted — my error.** Recounted:

```
diff -rq codev/protocols codev-skeleton/protocols | grep -c '^Files'   # 16
diff -rq codev/roles     codev-skeleton/roles     | grep -c '^Files'   # 1
```

**17**, not 19. My 19 came from counting all `diff -rq` output lines, which
folded in three `Only in codev/...` entries — those are **local-only files, not
drift**. Claude identified the cause exactly.

**Changed**: the figure is 17 throughout; **Terminology** now defines *drifted*
versus *local-only* as distinct categories, since Claude correctly notes the two
need different treatment under M8. The 16 drifted protocol files are enumerated
by name so the plan can work file-by-file, with the `.md` / `.json` split (11/5)
recorded.

### CL-3 — "Local-only files in `codev/protocols/maintain/templates/` not called out" *(Low)*

**Accepted.** A2 protected only `release/` and would have let
`audit-report.md` and `lessons-learned.md` be deleted.

**Changed**: both files named in A2, in M8's preservation clause, and in the
Problem Statement. Added **T8**, a new test asserting all three local-only
entries still exist and still resolve after removal — closing the "missing test
scenario" Claude flagged separately.

### CL-4 — "'63 markdown files' doesn't match 76 including `.json`" *(Low)*

**Accepted.** Both numbers were right about different things; my label was
imprecise. Exact counts:

| Scope | Count |
|---|---|
| `.md` in both `protocols/` trees | 63 |
| `.md` + `.json` in both `protocols/` trees | 73 |
| All shadow copies including `roles/` | **76** |

Claude's 76 matches mine once `roles/` is included.

**Changed**: all three stated explicitly; 45,183 words is now labelled as
markdown-only.

### CL-5 — "'shadow tree' used in two senses" *(minor clarity)*

**Accepted.** Added a **Terminology** section defining *skeleton*, *shadow
copy*, *shadow tree*, *drifted*, *local-only*, and *scar rule* once, with the
explicit note that "shadow tree" never refers to the skeleton.

---

## Gemini (APPROVE) — both suggestions adopted

- **G-1, machine-readable ownership map** — adopted. Q6 is resolved in favour of
  YAML (**Appendix A**). Gemini and Codex converge here from opposite
  directions: Gemini wants T7 to read the map directly; Codex wants the schema
  pinned down. Both are satisfied by the same artifact.
- **G-2, grep audit before deletion** — adopted as **M7** + **Appendix B**
  (same change as C-4).

Gemini raised no key issues. I have not treated the APPROVE as license to skip
anything the other two raised.

---

## Builder-originated corrections (not requested by any reviewer)

Investigating C-4 turned up two things that changed the spec beyond what was
asked. Flagging them explicitly since no reviewer is accountable for them.

### B-1 — Assumption A1 was speculative and is now evidence-backed

Iteration 1's A1 asserted the shadow trees were "unintentional forks" on thin
evidence (a shared last-touch commit).

Following the `scaffold.ts` references, I found `copyProtocols` (line 480) and
`copyRoles` (line 425), which copy the skeleton into `codev/`. My first reading
was alarming: if scaffolding creates the shadow tree, every adopter has this
problem. Then I grepped for callers — **neither function is called by `init`,
`adopt`, or `update`**; the only references are in `scaffold.test.ts`, and
`copyProtocols` has no references at all outside its definition.

They are dead code. Two consequences:

1. **Adopters have no shadow tree.** They resolve from the skeleton at tier 4,
   exactly as `arch-critical.md` claims. Our shadow tree is a historical artifact
   from when scaffolding did copy. This *strengthens* the deletion case: deleting
   makes Codev match its own adopters.
2. **The dead functions are a live hazard** — rewiring them would manufacture
   the problem for every project. Added **M9** to remove them alongside M8.

This is the `lessons-critical.md` rule "*'Who calls this in production?' grep
before changing a long-lived API — vestigial code survives*" paying out
directly.

### B-2 — A drift-audit allowlist is itself a risk

Making M2 an allowlist-based gate creates a way to re-hide drift by appending to
the allowlist. Added to the risk table with the mitigation: entries require a
justification comment, the allowlist must be **empty** when M3 completes, and
any growth is visible in review diffs.

---

## Summary of changes

| Change | Driver |
|---|---|
| Success criteria split: required M1–M7 vs conditional M8–M10 | C-1 |
| M2 narrowed to a single testable outcome | C-2 |
| Appendix A — instruction-class definition + YAML schema | C-3, G-1, Q6 |
| M7 + Appendix B — compatibility audit | C-4, G-2, Q5 |
| Appendix C — tiering selector, fallback, scope; tier-invariant scar rules | C-5 |
| #1210 as dependency; M2 extends it; T5 asserts the gate bites | CL-1 |
| 17 drifted (not 19); drifted vs local-only separated; 16 files enumerated | CL-2 |
| Local-only files protected in A2/M8 + new T8 | CL-3 |
| Counts disambiguated: 63 / 73 / 76 | CL-4 |
| Terminology section | CL-5 |
| A1 rewritten with evidence; M9 added | B-1 |
| Allowlist-accretion risk | B-2 |

Committed in `c58aff65`.

## Still open for the architect

Unchanged by this revision, and not the builder's to decide:

- **Q1** — may the shadow copies be deleted (M8–M10)? Evidence supports yes; I
  will not delete without explicit approval.
- **Q2** — for the 17 drifted files, which side wins? Default proposal: the
  skeleton, with any file whose local copy carries content worth keeping
  escalated rather than silently overwritten.
- **Q3** — is the scar-rule list complete? Ratification matters precisely
  because the point of the list is that nothing on it is ever quietly dropped.
- **Q4** — is a config-key tiering selector right, and is documentation-only
  tiering acceptable this iteration?
