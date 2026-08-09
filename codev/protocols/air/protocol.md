# AIR Protocol

**A**utonomous **I**mplement → **R**eview. The lightest protocol that still produces a reviewed
PR: no spec, no plan, no artifact files. The GitHub issue *is* the specification, and the review
lives in the PR body.

Use AIR when a small feature (roughly <300 LOC) is fully described by its issue and needs no
architectural decision, no new abstraction, and no significant refactor. If the issue leaves the
approach genuinely open, the cost of a spec is lower than the cost of building the wrong thing —
use SPIR or ASPIR. For a defect rather than a feature, use BUGFIX.

## The state machine

```json
{{> protocols/air/protocol.json}}
```

## Artifacts

**None on disk.** The issue carries the requirements; the review goes in the PR body. That is
the whole economy of AIR — a `codev/reviews/` file for a 200-line change costs more to maintain
than it ever repays.

## Consultation

At the builder's discretion, unlike SPIR's mandatory 3-way at every phase. Reach for it when the
change touches shared code or you are unsure the approach is right; skip it when the issue is
unambiguous and the diff is small.

## Gate

The `pr` gate is human. There are no pre-implementation gates — which is precisely why AIR is
only appropriate when the issue has already settled the questions a spec would ask.

## Baked Decisions

An issue may carry a `## Baked Decisions` section pinning architectural choices the architect
does not want re-litigated — typically **language**, **framework**, deployment shape, key
**dependencies**, or decisions deferred to a later spec.

Every item in it is fixed. Copy the section verbatim into the spec's Constraints and do not
re-open it in the spec, plan, or review; CMAP reviewers will not propose alternatives unless the
spec fails to honour one. If two items contradict each other, do not choose — surface the
contradiction and wait.

**Absence is the no-op default**: an issue with no such section is an invitation to explore
freely, not an omission to be filled in.

The architect can **amend or rescind** a baked decision at any time by updating the issue and
respawning, or by sending the builder a direct instruction via `afx send`.

## Escalation

If implementation reveals that the change is not small, or that it needs a decision the issue
does not make, **stop and say so** rather than growing an AIR project into an unplanned SPIR.
Escalating early is cheap; discovering it at PR review is not.

## Branch naming

`builder/air-<issue>-<short-description>`
