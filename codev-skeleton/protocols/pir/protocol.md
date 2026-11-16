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
| `pr` | post-PR | Reviews the PR on GitHub, then approves; the builder records the approval and merges |

Every gate is approved the same way: the human decides, the architect relays that decision, and
the builder records it with `porch approve <id> <gate> --a-human-explicitly-approved-this` —
never on its own initiative. At the `pr` gate the builder then merges with `gh pr merge --merge`
(the forge's `pr-merge` command, which porch hands over once the gate is approved).

**Gates do not notify the architect automatically.** Porch broadcasts `overview-changed` over
SSE; the VSCode Builders tree renders the blocked state with a bell and raises a toast. CLI
users see it via the builder pane or `porch pending`. So the builder's job at any gate is: write
the artifact, commit, signal, tell the architect with `afx send architect`, wait.

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

**One advisory consultation pass at the PR** (`max_iterations: 1`) — no iterate-until-APPROVE
loop. Three reviewers by default (Gemini, Codex, Claude), using `consult-types/pr-review.md`.
Porch emits the `consult` commands as a task and the builder runs them. A `REQUEST_CHANGES` gets a
written rebuttal (fix or disagreement) and escalates to the human at the `pr` gate rather than
triggering an automatic re-review.

Porch resolves reviewers as *config > protocol*. To run fewer for PIR, set
`porch.consultation.byProtocol.pir.models` in `.codev/config.json` (a project-wide
`porch.consultation.models` applies to PIR too).

## Baked Decisions

An issue may carry a `## Baked Decisions` section pinning architectural choices the architect
does not want re-litigated — typically **language**, **framework**, deployment shape, key
**dependencies**, or decisions deferred to a later spec.

Every item in it is fixed. Plan within it and do not re-open it in the plan, the implementation,
or the review; consultation reviewers will not propose alternatives unless the code fails to
honour one. If two items contradict each other, do not choose — surface the contradiction and wait.

**Absence is the no-op default**: an issue with no such section is an invitation to explore
freely, not an omission to be filled in.

The architect can **amend or rescind** a baked decision at any time by updating the issue, or by
sending the builder a direct instruction via `afx send`.

## Builder session

A long-running interactive session in a Tower-managed PTY, launched as `claude "<prompt>"`
inside a restart loop and pinned to a session id minted at spawn. Typed input reaches the live
session immediately; the loop is crash recovery, not the gate-wait mechanism. There is no
"session ended at gate" state. On a crash the loop **resumes the pinned conversation** (context
intact, plus a re-orientation nudge) rather than replaying the spawn prompt; only an unresumable
session degrades to a fresh prompt-replay relaunch. A deliberate quit relaunches fresh.

## Configuration

The `worktree` block in `.codev/config.json` is what makes the `dev-approval` gate work — see
the `runnable-worktrees` skill for `symlinks`, `postSpawn` and `devCommand`.
