# AIR Protocol

**A**utonomous **I**mplement → **R**eview. The lightest protocol that still produces a reviewed
PR: no spec, no plan, no artifact files. The GitHub issue *is* the specification, and the review
lives in the PR body.

Use AIR when a small feature (roughly 300 LOC — a guideline, not a limit) is fully described by its issue and needs no
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

One optional CMAP pass at the PR, at the builder's discretion — unlike SPIR's mandatory review
at every phase. Reach for it when the change touches shared code or you are unsure the approach
is right; skip it when the issue is unambiguous and the diff is small.

When it runs, it uses three reviewers by default — gemini, codex and claude. A project narrows
the set in `.codev/config.json` under `porch.consultation`; porch writes the resulting `consult`
commands into the PR-phase prompt, so the configured lanes are what runs.

## Gate

The `pr` gate is human. There are no pre-implementation gates — which is precisely why AIR is
only appropriate when the issue has already settled the questions a spec would ask. When the
architect relays the human's approval, the builder runs
`porch approve <id> pr --a-human-explicitly-approved-this`, then follows `porch next` to merge.

## Baked Decisions

An issue may carry a `## Baked Decisions` section pinning architectural choices the architect
does not want re-litigated — typically **language**, **framework**, deployment shape, key
**dependencies**, or decisions deferred to a later spec.

Every item in it is fixed. Do not re-open it in the implementation or the PR body; CMAP
reviewers will not propose alternatives unless the implementation fails to honour one. If two
items contradict each other, do not choose — surface the contradiction and wait.

**Absence is the no-op default**: an issue with no such section leaves those choices to you,
within what the issue describes.

The architect can **amend or rescind** a baked decision at any time by updating the issue and
respawning, or by sending the builder a direct instruction via `afx send`.

## Escalation

If implementation reveals that the change is not small, or that it needs a decision the issue
does not make, **stop and say so** — `afx send architect` with a recommendation to escalate to
SPIR or ASPIR — rather than growing an AIR project into an unplanned spec. Escalating early is
cheap; discovering it at PR review is not.

**Fix in place.** A small adjacent bug you find during the work is fixed in the same PR and named
in its body. A follow-up issue is only for work that needs something unavailable now (a device,
an owner decision), touches a different subsystem, or is a large refactor.

## Branch naming

`builder/air-<issue>` — created by `afx spawn`.
