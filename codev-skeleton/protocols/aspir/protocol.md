# ASPIR Protocol

Autonomous SPIR: the same phases, artifacts, consultations and checks, with the **spec and plan
human gates absent**. The builder runs Specify → Plan → Implement without stopping, and a human
still reviews everything at the `pr` gate before merge.

Use ASPIR for trusted, low-risk work where reviewing the approach up front would cost more than
it saves, and deferring that review to the PR is acceptable. When getting the shape wrong would
be expensive to unwind, use SPIR and take the gates.

## The state machine

Phases, gates and checks — note that `specify` and `plan` carry **no gate at all**; they are not
auto-approved, they are ungated:

```json
{{> protocols/aspir/protocol.json}}
```

## Everything else is SPIR

Artifacts (`codev/specs/`, `codev/plans/`, `codev/reviews/`, same base filename), the
build-verify cycle per plan phase, mandatory 3-way consultation at each verify step, the
machine-readable `phases` block in the plan, commit and branch conventions, and Baked Decisions
handling are all identical to SPIR. ASPIR includes SPIR's templates rather than copying them, so
there is one set to keep correct.

See `protocols/spir/protocol.md` for that shared substance.

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

## The one thing to be careful about

Without the spec and plan gates, nothing external catches a misread of the issue until the PR.
If the spec you write surprises you — if it turns out larger, or more architectural, than the
issue implied — that is the signal ASPIR was the wrong choice. Say so early rather than
carrying the misfit through to review.
