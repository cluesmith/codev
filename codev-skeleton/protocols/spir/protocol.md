# SPIR Protocol

**S**pecify → **P**lan → **I**mplement → **R**eview. Each phase is a build-verify cycle with
3-way consultation, and two human gates stand before implementation begins.

Use SPIR for new features, new protocols, architecture changes, and complex refactors — work
where getting the shape wrong is expensive to discover late. For an isolated bug fix or a small
feature fully described in an issue, a lighter protocol costs less and loses nothing.

## The state machine

Phases, gates, checks and their order are defined here. This is the authoritative source; the
prose below is only what the JSON cannot express.

```json
{{> protocols/spir/protocol.json}}
```

## Artifacts

Three documents per feature, **same base filename** in three directories:

| Document | Answers | Written during |
|---|---|---|
| `codev/specs/<id>-<name>.md` | what and why | Specify |
| `codev/plans/<id>-<name>.md` | how, and in what order | Plan |
| `codev/reviews/<id>-<name>.md` | what was learned | Review |

Sequential numbering, no leading zeros: `42-user-authentication.md`.

Specs and plans stay separate. A spec that has acquired file paths and step ordering has become
a plan — and the gate meant to catch a wrong approach is now reviewing an implementation.

The plan carries a machine-readable `phases` JSON block. Porch parses it to track progress, so
it is a contract, not an illustration.

## Phases

**Specify** — explore the problem before committing to an approach. Ask clarifying questions
first; they are cheapest before anything is written. Capture the problem, current and desired
state, several solution approaches with their trade-offs, open questions ranked by whether they
block, and measurable success criteria.

**Plan** — decompose into phases that are each independently testable, independently valuable,
and committable as a unit. Note dependencies inline. **No time estimates.** Delivery speed
depends on iteration cycles, not calendar time, and an estimate in an AI-driven project is noise
that later gets quoted back as a commitment.

**Implement** — one build-verify cycle per plan phase: build, verify by 3-way consultation,
address what reviewers find, commit. The commit is what makes the next phase safe to begin; a
phase that is "done but uncommitted" can vanish. If verification exposes a flaw in the *plan*
rather than the code, mark the phase blocked and revise the plan — implementing around a
known-wrong plan is how a project ships the wrong thing carefully.

Tests belong to the phase that creates the behaviour, not to a cleanup pass at the end.
Retroactive tests document what was built; tests written alongside constrain what gets built.
Mock external dependencies only — mocking the system under test proves the mock works.

**Review** — compare the implementation against the specification, record lessons, and route new
facts by tier: behaviour-changing and cross-cutting to `arch-critical.md` /
`lessons-critical.md` (capped — displace a weaker entry rather than growing them), reference
detail to `arch.md` / `lessons-learned.md`. The `update-arch-docs` skill encodes that routing.

## Consultation

3-way consultation (Gemini, Codex, Claude) is **on by default** and runs at each phase's verify
step. Disable it only when the human explicitly asks.

It is not a formality: it reliably catches security, design and protocol problems that solo
review misses, and the cost of skipping it is paid later by someone with less context.

## Gates

`spec-approval`, `plan-approval` and `pr` are **human** decisions. Stop and wait. A gate message
is a notification to a human, not authorization to proceed.

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

## Git

```
[Spec 42] Initial specification draft
[Spec 42][Phase: user-auth] feat: Add password hashing service
```

Branches: `spir/42-feature-name/phase-name`.

Each implement phase ends in one atomic commit before the next begins.

## Phase status

Tracked per phase inside the plan document, not per document: `pending`, `in-progress`,
`completed`, `blocked`.
