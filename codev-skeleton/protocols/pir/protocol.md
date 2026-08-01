# PIR Protocol

Plan → Implement → Review, driven by a GitHub issue, with **two human gates before any PR
exists**. The issue is the implicit spec; there is no specify phase.

Choose PIR when either is true:

- **The approach needs review before coding.** Ambiguous root cause, unfamiliar or
  high-blast-radius area, or a design-sensitive change — cheaper to redirect at plan time than
  at PR time.
- **The implementation must be exercised running, before a PR exists.** Mobile, UI/UX,
  hardware-adjacent behaviour, OAuth or payment integrations, full user journeys, anything
  performance-sensitive. A diff cannot show you these; a running worktree can.

Lighter than SPIR (no spec phase, one consult at the PR). Stronger than BUGFIX/AIR (two human
gates *before* a PR, where the human reviews the running code rather than the diff).

## The state machine

```json
{{> protocols/pir/protocol.json}}
```

## Gates

Gate names are opaque strings keyed by `(project_id, gate_name)`, so sharing a name with another
protocol is safe and needs no porch change.

| Gate | When | What the human does |
|---|---|---|
| `plan-approval` | pre-PR | Reads the plan committed on the builder branch, before any code exists |
| `dev-approval` | pre-PR | **PIR's distinctive gate** — reviews the *running* worktree via `afx dev` |
| `pr` | post-PR | Reviews on GitHub, then approves; porch wakes the builder to merge |

The `pr` gate makes the merge trigger **structured porch state** rather than free text in the
builder's pane — closing the self-merge class where a builder infers authorization from
ambiguous prose.

**Gates do not notify the architect automatically.** Porch broadcasts `overview-changed` over
SSE; the VSCode Builders tree renders the blocked state with a bell and raises a toast. CLI
users see it via the builder pane or `porch pending`. The builder's job at any gate is: write
the artifact, commit, signal, wait — never to invoke `porch approve` itself.

## Rejection is iteration, not a command

There is no `porch reject`. Feedback arrives however is convenient — editing the plan file,
typing in the builder pane, `afx send`, an issue comment — the builder revises and recommits,
and **the gate stays pending until a human approves it**. The same pattern works at both
pre-PR gates.

## Artifacts

Plan and review live in `codev/plans/` and `codev/reviews/` on the builder branch and ship to
the default branch with the merge. The review is shaped like SPIR's (Summary, Architecture
Updates, Lessons Learned) so `codev/reviews/` stays semantically consistent across protocols.

## Consultation

**One advisory CMAP pass at the PR** (`max_iterations: 1`) — no iterate-until-APPROVE loop. A
`REQUEST_CHANGES` escalates to the human at the `pr` gate rather than triggering an automatic
re-review.

That footprint is a **design invariant, and it is fragile**: porch resolves models as
*config > protocol*, so a project-wide `porch.consultation.models` (say a SPIR-tuned 3-model
list) silently inflates PIR's cost. Leave it unset, or scope it per-protocol.

## Builder session

A long-running interactive session in a Tower-managed PTY, launched as `claude "<prompt>"`
inside a `while true` restart loop. Typed input reaches the live session immediately; the loop
is crash recovery, not the gate-wait mechanism. There is no "session ended at gate" state.

## Configuration

The `worktree` block in `.codev/config.json` is what makes the `dev-approval` gate work — see
the `runnable-worktrees` skill for `symlinks`, `postSpawn` and `devCommand`.
