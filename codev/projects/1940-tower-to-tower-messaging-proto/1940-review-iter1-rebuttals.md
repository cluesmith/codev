# Review phase, iteration 1 — responses

Reviews: codex REQUEST_CHANGES, claude APPROVE. Codex found no implementation defect; its three
points are procedural. Each claim was checked before acting. Nothing was written to the tree
while either lane ran.

## codex

**1. PR #1957 is still marked draft.** Changed. It was a draft because it was opened part-way
through implementation so that GitHub would run the full suite (owner's ruling main-32). The
description was rewritten for review in this phase, and the PR is now marked ready for review.

**2. The spec and the plan lack `approved` / `validated` frontmatter.** Not changed.

- The rule in `AGENTS.md` reads: "Approved specs and plans need frontmatter and must be committed
  to `main` before spawning. Porch runs the full protocol from `specify`, but treats an artifact
  carrying this as done." It is for an artifact approved *before* a builder is spawned, so that
  porch does not redo the phase.
- This spec and plan were written by the builder in this worktree and approved by the human at
  porch's own gates. `status.yaml` records both (`spec-approval`, decision main-26;
  `plan-approval`, decision main-31).
- Practice agrees: of the 183 files in `codev/specs/`, 49 carry `approved:`. The most recent
  builder-written spec on `main` (1912, running consult's Claude lane through the CLI) has none.
- `validated: [codex, claude]` would also overstate this spec: the approved text is one commit
  (`90ebb0245`) ahead of what the two reviewers read, as the review document says.

**3. Commit `d4cb7e648` carries a `Co-Authored-By` trailer.** True, disclosed in the PR body and
the review, and not changed by me. Removing it means rewriting the history of an open pull
request (100 commits, one of them a merge of `main`) and force-pushing, which I may not do
without the owner's explicit word. It is put to the owner at the `pr` gate, through the
architect: rewrite, or let it stand.

## claude (APPROVE, non-blocking)

1. **The `afx` skill says a builder is refused `<workspace>:architect:<name>`.** Fixed. The row
   is about another workspace, where it is true, but a builder reading it could conclude the
   form never works for it; a builder that writes its own workspace's name in front of its own
   spawning architect is accepted, and a test pins it. One clause added in the skill (four
   copies, identical, hashes regenerated) and in `agent-farm.md` (both trees).
2. **Latency: before and after were measured at different loads.** The review's Latency section
   now says the comparison is one-sided and what supports the conclusion anyway (0.08 ms measured
   against a 1 ms allowance; the cross-workspace figure no higher than the same-workspace one).
   A retake of the baseline at the same load is a follow-up item; it needs the owner's leave to
   load the machine.
3. **Is issue #1605 really superseded?** The owner's ruling at plan approval (main-31) cut the
   front-door-only setting and said the issue still closes as superseded. Passed to the
   architect, who closes it at merge.
4. **`afx workspace list` cost.** Deliberate and recorded under Known boundaries.
5. **`status.yaml` shows no review for phases 4 to 6.** Porch's bookkeeping; added to the
   review's Methodology Improvements.
6. **Branch currency.** GitHub reports the PR mergeable; its runs test the merge with `main`.

Also in this commit, on the architect's instruction: the review cites the two follow-up issues,
#1967 (stage 2) and #1968 (stage 3).
