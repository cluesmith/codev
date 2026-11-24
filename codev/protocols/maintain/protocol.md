# MAINTAIN Protocol

Audit → Clean → Sync, in a single pass, then a PR. Two phases, one consultation during the
maintain phase and one before the PR.

Use it for dead code and unused dependencies, quarterly hygiene, pre-release cleanup, and
keeping the governance docs honest — `arch.md`/`arch-critical.md`,
`lessons-learned.md`/`lessons-critical.md`, and the `CLAUDE.md`↔`AGENTS.md` twins.

It is a scheduled, whole-repository run that a human asks for, scoped from the last run's base
commit. It is **not** the protocol for one targeted cleanup: a specific dead file, a drifted
document, or a stale section is an ordinary issue under BUGFIX (or AIR). Reaching for "a
MAINTAIN pass" to fix one thing misuses the since-marker and the audit discipline below.

## The state machine

```json
{{> protocols/maintain/protocol.json}}
```

## Before starting

Find the last run in `codev/maintain/`, note its base commit, and scope the audit to
`git log --oneline <base>..HEAD`. Maintenance without a since-marker re-audits the whole
repository every time and quietly stops being run.

## The maintain phase

**Audit** — find unused exports, unused dependencies, and orphaned files. Treat every hit as a
*candidate*, not a verdict: a detector cannot tell "vestigial" from "used by a path you did not
search". Confirm each with a targeted grep before removing it.

**Clean** — remove what you confirmed, one removal per commit. A tracked file goes with
`git rm` — git history keeps it recoverable. An untracked file has no history, so move it to
`codev/maintain/.trash/<date>/` instead of deleting it, and never commit that directory.

**Sync documentation** — route facts by tier rather than appending: behaviour-changing and
cross-cutting go to the capped hot files (displace a weaker entry rather than growing them),
reference detail to the cold archives. The `update-arch-docs` skill encodes the routing matrix,
the caps, and what does *not* belong in each tier. Keep `CLAUDE.md` and `AGENTS.md`
byte-identical.

## The maintenance run file

Each run is recorded in `codev/maintain/` using this structure:

{{> protocols/maintain/templates/maintenance-run.md}}

## Scope discipline

Maintenance is where scope creep is most tempting, because everything you touch looks
improvable. Removing dead code and fixing small bugs you find on the way is in scope (fix in
place, named in the PR body). Refactoring live code because you are already in the file is not:
a large refactor, or work in a different subsystem, gets a follow-up issue.

Never `git add -A` / `--all` / `.` — stage each file explicitly by path.

## Review and the gate

The review phase opens the PR; porch then hands you the consultation commands (three reviewers by
default, or the project's `.codev/config.json` `porch.consultation` lanes) to run. Once they
approve, porch stops at the `maintain-complete` gate — a **human** decision. When the architect
relays the human's approval, you run
`porch approve <id> maintain-complete --a-human-explicitly-approved-this` and follow `porch next`
to merge.
