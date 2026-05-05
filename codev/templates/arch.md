# Architecture

The architecture document for this project. Skim it to orient yourself; reach for the meta-specs under `codev/architecture/` (if any) or the relevant subsystem section for depth.

> **How to use this template**: Each section below is a stub with a one-line "skip if N/A" hint. Delete sections that don't apply to your project — small projects often only need TL;DR, Repository Layout & Stack, and Updating This Document. Bigger systems will fill in more. The goal is orientation, not completeness.

## TL;DR

A 2–4 sentence summary of what this project is, the language/stack, the deployment shape, and the single most important mental model a new contributor needs.

*Example*: "A monorepo of TypeScript packages and a CLI. The CLI talks to a long-running orchestrator process (Tower) over WebSockets. The orchestrator manages git worktrees, one per builder. The mental model is: 'CLI = thin client; Tower = state owner.'"

## Repository Layout & Stack

The shape of the repo and the languages/frameworks in use. Not a per-file enumeration — a `tree -L 2` view plus 2–3 lines on each top-level directory's role is plenty.

> *Skip if N/A: a single-package project that's well-served by `package.json` alone.*

```
project-root/
├── packages/        # Workspace packages
├── codev/           # Specs, plans, reviews, protocol files
├── docs/            # User-facing documentation
└── ...
```

**Stack**: language version(s), framework(s), package manager. Avoid pinning exact patch versions; the lockfile is authoritative for those.

## Per-Subsystem Mechanism

For each subsystem with **unique mechanism** — something a reader cannot derive from reading the code in 5 minutes — give it a section here. Mechanism means: how the pieces fit together, what invariants hold, what surprised the team.

> *Skip if N/A: subsystems whose mechanism is well-conveyed by the code itself or by a meta-spec under `codev/architecture/<domain>.md`. In that case, replace this section with a 1-paragraph summary + pointer.*

### [Subsystem name]

**Purpose**: One sentence on what this subsystem owns.

**Mechanism**: How it works. Invariants. Failure modes worth knowing.

**Pointer**: `codev/architecture/<domain>.md` (if a meta-spec exists).

## Apps Roster

For projects that ship multiple deployable apps — a CLI, a web service, a worker, etc. List them with a one-liner each.

> *Skip if N/A: single-app projects.*

| App | Purpose | Entry point |
|---|---|---|
| `cli` | Command-line interface | `packages/cli/src/index.ts` |
| `worker` | Background job runner | `apps/worker/src/main.ts` |

## Packages Roster

For monorepos. List the workspace packages with a one-liner each. Do not duplicate `pnpm-workspace.yaml` or `package.json` — link to them.

> *Skip if N/A: non-monorepo projects.*

| Package | Purpose |
|---|---|
| `@org/core` | Domain logic, no I/O |
| `@org/cli` | CLI entry point, depends on core |

## Verified-Wrong Assumptions

System-shape surprises that have been verified wrong in production. Each entry is one or two sentences: *"It looks like X but is actually Y. We learned this when ..."*. This section earns its keep by saving future readers from the same mistake.

> *Skip if N/A: nothing has surprised you yet. Add entries as they're discovered.*

- *Example*: "It looks like the CLI talks to Tower over HTTP, but the WebSocket bidirectional channel is the actual transport — the HTTP routes are only used for `/health` and one-off lookups. We learned this when adding a new command broke because we wrote it as a fetch call."

## Updating This Document

This is a single-page orientation doc, not a wiki. Keep it sized to its purpose.

### When to update

- After a MAINTAIN run that changed system shape.
- When a subsystem's mechanism changes meaningfully (not when one file gets renamed).
- When a verified-wrong assumption is discovered.
- *Not* every spec; specs already produce reviews and git history. Don't duplicate that here.

### How to update

Use the `update-arch-docs` skill. It runs in two modes:

- **diff-mode**: apply a specific change to the smallest section that needs updating.
- **audit-mode**: read the doc end-to-end against the discipline below and propose cuts with reasons.

The skill edits this file directly via normal file-edit tooling. It does not invoke destructive shell commands; everything goes through Edit. The MAINTAIN PR diff is the human-confirmation step.

### What NOT to put in

The main pressure on this document is unchecked growth. Reject all of the following:

- **Per-file enumerations** that go stale. Document directory shape and key files; let `git ls-files` be authoritative for the rest.
- **Per-spec changelog sections** ("Spec 0042 added X"). The git log + the spec/review docs own this framing. Architecture is current state, not history.
- **Specs/plans tables** that mirror `codev/specs/` and `codev/plans/`. Link to the directory; do not paginate it here.
- **Aspirational state** ("we plan to…"). That's a meta-spec or a roadmap doc, not architecture.
- **Date-stamped narrative** ("As of 2026-Q2…"). Looks fresh; ages worse than a calendar.
- **Duplication of meta-spec content**. If a subsystem has a meta-spec, this doc carries a 1-paragraph summary plus a pointer.
- **Retired-component graveyards**. When a component is removed, delete its section. `git log` keeps the history.

### Sanity-check checklist

Before committing an arch.md change, run through these:

1. Does the section describe **current state**, not aspiration?
2. Does it duplicate a meta-spec? If yes, replace with a summary + pointer.
3. Is the section orienting (worth a reader's 30 seconds), or is it exhaustive?
4. Could a future reader skip this section without losing anything load-bearing?
5. If audit-mode produced cuts, does each cut have a one-line reason in the MAINTAIN run file?
6. Does the doc still feel like it can be skimmed end-to-end in under 5 minutes?

### Note on propagation

`codev update` does **not** copy templates. The template you're reading lives at `codev/templates/arch.md` and propagates to new projects via `codev init`/`adopt` only. Existing projects that want this richer template need to copy it manually from `codev-skeleton/templates/arch.md`.
