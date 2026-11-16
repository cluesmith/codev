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

ASPIR includes SPIR's templates rather than copying them, so there is one set to keep correct.
The rules it shares with SPIR:

- **Artifacts** — three documents, same base filename: `codev/specs/<id>-<name>.md` (what and
  why), `codev/plans/<id>-<name>.md` (how, in what order), `codev/reviews/<id>-<name>.md` (what
  was learned). Sequential numbering, no leading zeros. Specs and plans stay separate.
- **The plan's `phases` JSON block** is a contract porch parses, not an illustration.
- **Build-verify per phase** — build, commit, run `porch done`, then run the `consult` commands
  `porch next` hands you (three reviewers by default; `.codev/config.json` `porch.consultation`
  can narrow them). Porch never commits your work — you do. Tests belong to the phase that
  creates the behaviour; mock external dependencies only.
- **No time estimates** in the plan.
- **Review** — compare the implementation against the spec, record lessons, and route new facts
  by tier: behaviour-changing and cross-cutting to `arch-critical.md` / `lessons-critical.md`
  (capped — displace a weaker entry), reference detail to `arch.md` / `lessons-learned.md`.
- **Git** — `[Spec 42] Initial specification draft`,
  `[Spec 42][Phase: user-auth] feat: Add password hashing service`. One branch,
  `builder/aspir-42` (created by `afx spawn`); every plan phase is a commit in one PR.

## Gates

`pr` and `verify-approval` are **human** decisions. Stop and wait; a gate message is a
notification to a human, not authorization. When the architect relays the human's decision, you
run `porch approve <id> <gate> --a-human-explicitly-approved-this` yourself.

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
