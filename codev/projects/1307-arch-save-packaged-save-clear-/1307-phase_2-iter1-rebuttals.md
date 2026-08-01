# Phase 2 (`/arch-save` skill) — Rebuttals, iteration 1

Codex `REQUEST_CHANGES`, Claude `COMMENT`. **All findings accepted and fixed**; nothing
disputed. Iteration 2 returned `APPROVE` from both.

Fix commits: `b4c5d08c`, `45f946e1`.

---

## 1. No instance↔skeleton drift guard (both reviewers)

**Accepted, and it was the same mistake in a new material.**

Phase 2's acceptance criterion was "all four copies identical". I verified it by hand with
`md5` and guarded it with nothing. `skill-parity.test.ts` compares Claude against Codex
*within* a tree — it never compares our instance against the shipped skeleton, so the
classic "edited `codev/` and forgot `codev-skeleton/`" drift passes it silently while
shipping a stale skill to every adopter.

A one-time check is not a guard. This is the fifth instance in this project of an artifact
that exists without doing anything, and the reviewers were right to treat it as the
blocking one.

**Fixed**: `spec-1307-arch-save-skill.test.ts`, mirroring `spec-1134-arch-init-skill.test.ts`
— four-way byte identity, an explicit instance-vs-skeleton assertion, and content
assertions pinning the statements the plan required the document to make. A skill is a
*document*, so "identical everywhere" is only half of correct; identical copies of a doc
missing its load-bearing warning are still wrong.

**Mutation-verified twice**: appending one line to the skeleton copy fails both drift
guards; restoring the old overclaim fails the content guard.

## 2. The Tower timing claim was false (Codex)

**Accepted — a real accuracy defect, not a wording preference.**

The skill said Tower "delivers it after the clear has landed". Tower waits out 15 seconds;
it never observes the clear. That promises an observation the system does not make, and it
contradicted this project's own spec, which is explicit that clear completion is not
guaranteed.

**Fixed**: the skill now states plainly that Tower does not know whether the clear landed,
that 15s is a value that works in practice rather than a guarantee, and that a mistimed
re-init costs one manual message. A content assertion prevents the old phrasing returning.

Worth naming: this is the same failure as the spec claiming a request-order FIFO guarantee
the code did not make — **prose asserting something adjacent to what the system does**.
Code review catches code drift; nothing automatically catches prose drift, which is why the
content assertions matter more than they look.

## 3. `arch-init`'s loop diagram still showed only the manual path (Claude)

**Accepted.** The diagram contradicted the prose two paragraphs below it, and the diagram is
what a reader skims. Now shows both routes, with `/arch-save` as the packaged path and the
manual one as the Tower-unavailable fallback. Pinned by a test.

## 4. `init.test.ts` assertions are inert (Claude, informational)

**Confirmed and already documented in place.** `init.test.ts` is excluded at
`vitest.config.ts` ("Flaky: codev doctor timeout in worktree context"), so the assertion I
added there guards nothing. I found this by noticing only four of the five files I named
actually executed, kept the assertion (correct if the exclusion lifts), labelled it
in-place as not counting as coverage, and confirmed the real guard lives in
`scaffold`/`update`/`adopt`, which do run.

## 5. Step-5 failure after a successful step-4 clear (Claude, iteration 2)

**Accepted; fixed in `45f946e1`.** Raised as minor but it is a real gap. Step 4 queues the
`/clear`, which only takes effect when the turn *ends* — so a step-5 failure still leaves
the architect holding its full context, and the failure is recoverable. Unless it ends the
turn anyway, converting a recoverable failure into a cleared session with no re-init
scheduled and nobody told. The skill now says so explicitly, pinned by an assertion.

---

## Nothing disputed

Every finding across both iterations was accepted. There are no false positives to rebut.

## Post-approval changes (recorded for completeness)

After both `APPROVE`s, two further changes touched phase-2 files under architect
authorization:

- **`--delay` documentation relocated out of the always-on surface** (`5bcf52be`). Spec
  1280's Phase 1 restructured `CLAUDE.md` so CLI detail lives in skills and reference docs;
  a per-flag pointer there is a regression to the pattern 1280 just deleted. `CLAUDE.md`
  and `AGENTS.md` now gain nothing, and the detail lives in
  `codev/resources/commands/agent-farm.md` **and its skeleton mirror**. The spec criterion
  was amended in place with a dated note rather than silently changed.
- **The `afx` skill is deliberately NOT updated** with `--delay`. Its drift is #1318's to
  reconcile, per the same ruling 1280 received. Flagged for the review.
