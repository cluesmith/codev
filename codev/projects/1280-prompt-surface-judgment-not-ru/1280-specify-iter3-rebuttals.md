# Iteration 3 response — Spec 1280 (CMAP round 3, acceptance-model revision)

Codex REQUEST_CHANGES (HIGH, 5 findings) · Claude COMMENT (HIGH, 6 findings). **All accepted;
no disputes.** Both reviewers independently caught the same inventory error, and both landed on
M5's weakness from different angles.

---

## Both reviewers

**Inventory mislabel — ACCEPTED, verified, and mine.** I reported "3 `codev/protocols` copies
that differ." **Zero differ.** All three (`maintain/templates/audit-report.md`,
`maintain/templates/lessons-learned.md`, `release/protocol.md`) are **local-only with no
skeleton twin**. Cause: my `cmp -s` loop treated a nonzero exit as "differs", but `cmp` also
exits nonzero when a file is absent. I read an exit code without distinguishing its two causes.

Fixed: table relabelled with a separate "no skeleton twin" row, and **T7 now operates on the
intersection of files that have twins**, so the three local-only files can never be spurious
failures.

This is the **fifth** self-audit finding of this spec phase and the fourth sharing one root
cause — *trusting a convenient signal instead of checking the authoritative thing* (truncated
grep; skeleton-only enumeration; the script's stale comment; an overloaded exit code). It is
now well-evidenced enough to belong in `lessons-learned.md` as its own entry, which the review
phase will route.

**M5 is weaker than it reads — ACCEPTED from both angles, and they compose.**

- *Codex*: **M5 conflicts with P6.** P6 permits replacing narrated gate/check names with a
  reference to structured truth; M5 as written demanded those names remain in served prose. A
  *conformant* P6 rewrite would have failed M5.
- *Claude*: **M5 detects deletion, not inversion.** "A gate message is a notification to the
  human, not authorization" could collapse to a bare mention of the gate name and still pass.

Fixed together: **representation** is now defined as *either* the name appearing in served text
*or* an explicit resolvable reference to the structured source that still defines it — which
makes P6 and M5 compatible. And M5's **detection limit is stated outright**: it is a deletion
detector, not a meaning detector; the gap is assigned to M11 (architect reads the diff) and O4
(zero-tolerance compliance), plus a short hand-curated set of **semantic invariants** asserted
as behaviour rather than name presence.

---

## Codex

**Scope contradiction — ACCEPTED.** MP/M3 said "every prompt-bearing file" while the hot tier
was left unchanged and `.claude/skills/` was measured, received relocated content, and had an
unresolved conformance status. Fixed with an authoritative **per-surface disposition table**:
every category marked **rewritten**, **inspected-but-unchanged**, or **excluded with reason**.
Scope is now exactly that table. (This also delivers the issue-mandated cut plan — see Claude 1.)

**A/B arms cannot use both "the same base commit" and "pre-/post-rewrite commits" — ACCEPTED.**
Genuinely incompatible as written, and the naive reading also let later pairs inherit source
changes the pinned control commit lacked. Rebuilt as a **prompt-only overlay**: both arms branch
from the same source commit `S`; treatment uses `S`; control applies one overlay commit
reverting rollback groups G2–G6 and nothing else; each run records **both** the source hash and
a **prompt-surface hash** over every file in the disposition table. Source is identical within a
pair, `S` may advance between pairs, and "no code differs" becomes literally true.

**"Total authored surface" ambiguous — ACCEPTED.** M0(g) now defines it as **physical files on
disk**, each counted once, **no twin deduplication and no transclusion expansion** —
deliberately a different basis from the always-on buckets (which dedupe and expand), because its
job is to detect relocation. Both figures are reported side by side and labelled with their
basis, so T11 and T15 have deterministic expected values.

---

## Claude

**1. The per-surface cut plan is missing — ACCEPTED, and the sharpest process catch.** Issue
#1280's Protocol section requires the spec phase to produce it. Word *targets* are withdrawn by
the architect's redirect, but the **disposition mapping survives that redirect** and was absent.
Entering implement with only "apply P1–P7" — with the architect as the throughput bottleneck —
invites rewrite→reject churn. Added as the disposition table above, with dominant
non-conformance, governing principles, and relocation destination per bucket.

**2. Issue #1280's body now contradicts the spec — ACCEPTED, flagged to the architect.** Title
and Goal still say ">50% reduction… measured with 1252's committed measurement script" — a
script this spec disqualifies, and a goal the acceptance-model redirect replaced. The issue is
the charter CMAP reviewers load, so it will keep generating "doesn't meet the stated goal"
findings. **I have not edited the charter myself** — that is the architect's artifact. Raised
for them to update, citing the 2026-07-31 ruling.

**4. No release-hold between merge and the SHIP verdict — ACCEPTED.** M7 gates
`verify-approval`, so the rewritten skeleton reaches `main` and is shippable to adopters before
the A/B validates it; "pin the prior version" is reactive. Added **M12**: no `@cluesmith/codev`
release between the rewrite merge and the SHIP verdict; if one must cut, it ships from a commit
predating the merge.

**5. A/B isolation rests on an unstated resolver property — ACCEPTED, and verified.** Every
`codev-skeleton/protocols/**` and `roles/*.md` file has a `codev/` twin (**0 lack one** —
confirmed), so tier 2 shadows tier 4 for every surface under test and the control arm genuinely
serves the old surface. But **deleting a `codev/` file while keeping its skeleton twin would
silently drop the control arm through to the new skeleton** — a comparison that looks valid and
is not. Stated as a precondition; **T14 now asserts it pre-flight per pair and voids the pair on
failure**.

**6. Minor — ACCEPTED.** Twin mislabel fixed (above). `builder/spir-1252` confirmed present on
`origin` (`ee310a64`), so the "sole source" risk is downgraded Low/High → Low/Medium.

---

## Net

Eleven findings across two reviewers, all accepted, none disputed. The two structural ones —
scope contradiction and the A/B's impossible arm construction — would both have surfaced during
implementation as confusion rather than as a clean defect, which is the case for having run a
third round on a spec that had already passed two.
