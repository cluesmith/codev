# Rebuttal — Spec 1470, Phase 2 (porch trigger) iteration 3

**Verdicts**: Codex REQUEST_CHANGES (1 issue) · Claude APPROVE (0 blocking, 4 minor).

The two reviewers reached opposite conclusions on the same change. I did **not** resolve that
myself — I escalated it, held the contested code untouched, and Waleed ruled. This rebuttal records
the resolution and the reasoning, not an argument.

---

## Codex — suppressing the pre-approval refresh dropped a required deliverable

**Codex's position**: `next.ts` explicitly suppresses refreshes on the pre-approval path, but the
approved Phase 2 plan requires that path to emit and record `enter:plan` and `enter:implement`. The
spec's back-to-back exclusion, on its reading, concerns `enter:implement` versus the first plan
phase — not two distinct phase-entry boundaries. Restore the behavior, or formally amend and
re-approve the artifacts.

**Accepted as a process objection, and it was correct.** I checked the artifacts rather than
arguing from memory, and found the plan contains *both* of these as Phase 2 acceptance criteria:

- line 206: "The pre-approval path **fires** `enter:plan` and `enter:implement`"
- line 209: "two refresh tasks never fire back to back, **at any site**"

In the doubly-pre-approved case — this repo's documented default, since `CLAUDE.md` directs that
approved specs and plans carry frontmatter and be committed to `main` before spawning — porch skips
`specify` and `plan` on consecutive `porch next` calls. **The two criteria are mutually
unsatisfiable there.** That is a contradiction inside the approved plan, not a reviewer error and
not an implementation error.

So Codex was right about the thing that actually mattered: whichever behavior is correct on the
merits, I had narrowed an approved artifact on my own judgement, acting on one reviewer's
recommendation. That is not a builder's call.

**What I did**: stopped, held the contested code at `1a513bf9c` without further edits, and put the
contradiction to the architect with both options and their consequences. I kept working only on
items that did not touch the contested behavior.

**Resolution — Waleed's explicit ruling: "definitely suppress."** Both artifacts are now amended:

- **Spec**: Desired State gains the skip-is-not-work rule; the "never emitted twice in a row"
  criterion now names both mechanisms that guarantee it; and a new **Amendments** section records
  what changed, why, and the reviewer split behind it.
- **Plan**: the executive summary and both affected acceptance criteria now state that the
  pre-approval site is *wired* — it performs the gate auto-approval and `plan_phases` extraction
  that were genuinely missing — but fires **no** entry refresh.

Every amendment is dated and attributed to the ruling rather than to my reading, so a later reader
can see it was a human decision and not a builder quietly reinterpreting its own spec.

**On the merits, for the record** (this did not decide it — the ruling did): the pre-approval
branch runs only at iteration 1 with `build_complete` false, i.e. before the builder has done
anything in the phase being skipped. There is no context to shed. Firing anyway would save a
near-empty state file that either pads to clear the ≥1000-byte gate or aborts on it, then clear a
context containing nothing. The valuable boundary survives: whenever the builder *actually* writes
the plan, `enter:implement` fires from the gate-approved transition, and plan-phase advances refresh
normally.

**Codex's objection is recorded as RESOLVED in the review artifact**, and specifically as resolved
*by human amendment* rather than by counter-argument. A reviewer overruled on the merits and a
reviewer right about process are different things, and this was the second.

---

## Claude — APPROVE, four minor items

1. **Force-advance can prepend its ceiling notice to a refresh task** the builder is about to clear
   on. *Accepted.* Recoverable — `force_advanced` is in `status.yaml` and the rebuttal file is on
   disk — and refreshing after a long REQUEST_CHANGES spiral is arguably the *most* valuable moment
   to refresh. Recorded in the review-artifact list at the architect's explicit request, so it is a
   documented interaction rather than something rediscovered expensively later.

2. **Two timing negatives lacked explicit tests** — "not between build and verify" and "not during a
   consultation". Both unreachable by control flow, since `handleBuildVerify` returns consultation
   tasks before any transition site. *Accepted and added.* Claude's reasoning is the right one for
   this project specifically: after five tests that passed without exercising what they named,
   closing a criterion by assertion beats closing it by reading. Each new test also asserts it is
   genuinely in the state it claims to test — the build/verify case checks the returned task really
   is a consultation task — so neither can go vacuous the way its predecessors did.

3. **Record both plan-vs-implementation divergences** in the review artifact. *Accepted*; both are
   on the running list, and (b) now points at the amendment above rather than at a pending decision.

4. **`moveToReview` coupling and the `$schema` path** — already documented inline and scheduled for
   Phase 7 respectively. No action, as Claude noted.

---

## Net

1 process objection upheld and resolved by human amendment; 2 artifacts amended; 2 tests added;
3 items recorded for the review artifact. No code changed this iteration — the implementation
already matched what the amended artifacts now say.

The thing worth carrying forward is procedural rather than technical. When two reviewers disagree
and the disagreement turns on what an approved artifact requires, the builder's job is to find the
contradiction, state it precisely, and stop — not to pick the reading it prefers. The contradiction
here was real and had been sitting in the plan since approval; it took a doubly-pre-approved
project to make it observable.
