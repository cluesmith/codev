# PIR Protocol

> **Plan → Implement → Review** for GitHub-issue-driven work that needs human review of *either* the approach (before code is written) *or* the implementation (before a PR exists), or both. Lighter than SPIR/ASPIR (no `specify` phase — the GitHub issue is the implicit spec) with the human code-review moved earlier (pre-PR instead of post-PR). Stronger than BUGFIX/AIR (two human gates before the PR).

## When to Use PIR

Pick PIR when working from a GitHub Issue and ONE or BOTH of the following apply — based on the *nature* of the change, not its size:

### 1. The approach needs review before coding starts
- Root cause is ambiguous; multiple valid fixes exist
- Area is unfamiliar or high-blast-radius (shared utilities, auth, migrations, public APIs)
- Design-sensitive (affects conventions, patterns, architecture)
- Cheaper to redirect at plan time than at PR time

### 2. The implementation needs to be tested before a PR is created
The PR diff alone is insufficient; the reviewer must *run* the code:
- Mobile app changes (needs device testing on Android, iOS, possibly web)
- UI / UX changes (visual inspection, interaction flow, accessibility)
- Hardware-adjacent behavior (sensors, camera, permissions, notifications)
- Integration with external services that don't mock cleanly (OAuth, payments, analytics)
- User-journey changes that need a full-flow exercise
- Performance-sensitive changes that need profiling on the running app

### Use SPIR / ASPIR / BUGFIX / AIR instead when
- **SPIR / ASPIR**: the change is complex enough to warrant careful specification, multi-agent consultation at every phase, and the full spec → plan → implement → review ceremony with file artifacts. The driving issue is incidental — what matters is that the design work deserves a formal spec and the implementation deserves consult-driven review at each phase
- **BUGFIX**: small bug fix, no design review needed, diff-on-PR review is enough
- **AIR**: small feature from an issue, autonomous, diff-on-PR review is enough

## How PIR Differs from SPIR

PIR is structurally *SPIR minus the `specify` phase*, with the human code-review moved earlier (pre-PR instead of post-PR).

| Aspect | SPIR | PIR |
|---|---|---|
| Phases | specify → plan → implement → review → verify | plan → implement → review |
| Spec artifact | `codev/specs/<id>-<slug>.md` | GitHub Issue body (implicit spec) |
| Plan artifact | `codev/plans/<id>-<slug>.md` | Same — committed on builder branch |
| Review artifact | `codev/reviews/<id>-<slug>.md` (Summary + Architecture Updates + Lessons Learned, becomes PR body) | **Same shape** — `codev/reviews/<id>-<slug>.md` with the same sections, also becomes PR body |
| Human gates | spec-approval, plan-approval, pr, verify-approval | plan-approval, code-review, pr |
| Where code is reviewed by the human | On the PR (post-creation) — read the diff | Pre-PR (at the `code-review` gate) — read the diff **and run the worktree locally** |

The review file always includes Summary, Architecture Updates, and Lessons Learned sections so `codev/reviews/` stays semantically consistent across all protocols. PIR's lightness comes from skipping the `specify` phase (the issue body is the spec), not from cutting corners on the retrospective.

The `code-review` gate is what makes PIR genuinely different: the human gates the *running implementation* via the worktree before the PR exists, instead of gating the PR after creation.

## Phases

```
plan → implement → review
```

### Plan (gated by `plan-approval`)

The builder:
1. Reads the GitHub issue and investigates the codebase
2. Writes `codev/plans/<id>-<slug>.md` with: Understanding / Proposed change / Files to change / Risks & alternatives / Test plan
3. Commits the plan on the builder branch and pushes
4. Runs `porch done` and `porch next` — the `plan-approval` gate becomes pending
5. Sits at the interactive prompt waiting for review

**Reviewer paths** (all equivalent):
- Open `codev/plans/<id>-<slug>.md` in the worktree, read and / or edit directly, save
- Type feedback into the builder's PTY pane — the builder is alive in interactive mode
- `afx send <builder-id> "<feedback>"`
- Comment on the GitHub issue (sidecar discussion)

When satisfied, approve via VSCode's "Approve Gate" command (Cmd+K G) or:

```bash
porch approve <id> plan-approval --a-human-explicitly-approved-this
```

### Implement (gated by `code-review`)

The builder:
1. Reads the approved plan file
2. Writes code and tests; runs build + tests via the `checks` block
3. *No AI consult on this phase* — the human at the `code-review` gate is the sole reviewer of the running code. Matches BUGFIX / AIR's pattern of "no consult on implementation, one consult at PR creation".
4. Pushes the branch
5. Runs `porch done` and `porch next` — the `code-review` gate becomes pending
6. Outputs a **prose** code-review summary in the PTY pane (Summary / Files / Test results / Things to look at / How to test locally). This is a transient message to orient the human reviewer — **not a committed file**. The retrospective file is written in the next phase, after the human approves the running code.
7. Sits at the interactive prompt

**The reviewer's killer move**: run the worktree locally.

- VSCode: right-click the builder in the Codev sidebar → **Run Dev Server** (spawns `afx dev <builder-id>` via Tower)
- CLI: `afx dev <builder-id>`

The dev server uses **the same ports and URLs as main** intentionally (OAuth callbacks, CORS, cookie scoping all depend on consistent origins). Only one dev env runs at a time; stop main's `pnpm dev` before starting the worktree's, or use VSCode's **Stop Dev Server** to swap.

Reviewer tests the change on real devices / browsers / simulators. When satisfied, approves via Cmd+K G or:

```bash
porch approve <id> code-review --a-human-explicitly-approved-this
```

### Review (gated by `pr`)

The builder:
1. Writes `codev/reviews/<id>-<slug>.md` with **Summary**, **Architecture Updates**, **Lessons Learned Updates**, plus the supporting sections (Files Changed, Commits, Test Results, Things to Look At, How to Test Locally).
2. Updates `codev/resources/arch.md` and/or `codev/resources/lessons-learned.md` if real changes need recording. If not, the review file's sections state "no changes needed" with a one-line explanation (the porch `checks` block enforces section presence, not content).
3. Commits the review file (and arch / lessons updates if any) and pushes
4. Opens a PR with `gh pr create`; PR body is the review file content + `Fixes #<N>`. Records the PR with `porch done <id> --pr <M> --branch <name>`.
5. Runs `porch done <id>` — porch's `verify` block runs CMAP-2 (Gemini + Codex, type=impl); CMAP outputs land in `codev/projects/<id>-*/`. Outcomes are not auto-appended to the PR body; reviewers with the worktree read them from the projects dir.
6. The `pr` gate fires (pending). Builder notifies the architect once: `afx send architect "PR #<M> ready for review (PIR #<N>), CMAP: gemini=<verdict>, codex=<verdict>. Awaiting human merge + pr gate approval."`
7. Builder waits at the `pr` gate. **Does not run `gh pr merge`** — capability is intentionally not in the protocol. The human merges via GitHub (or their own `gh pr merge`), then approves the `pr` gate (Cmd+K G or `porch approve <id> pr --a-human-explicitly-approved-this`).
8. After `pr` gate approval, porch wakes the builder; builder records the merge with `porch done <id> --merged <M>` and sends the final cleanup-ready notification. Protocol is complete (`next: null`).

## Gates

PIR uses porch's existing gate machinery. Gate names are opaque strings; no porch engine changes are needed.

- **`plan-approval`** — pre-PR. Human reads the plan file (committed on the builder branch) and approves before any code is written. Gates are keyed by `(project_id, gate_name)` so the name is safe to share with other protocols.
- **`code-review`** — pre-PR. The human reviews the *running* worktree (via `afx dev`) before any PR exists. This is PIR's distinctive gate.
- **`pr`** — post-PR. Gates the merge step. The human merges on GitHub (or via `gh pr merge` from their own shell) and approves this gate to signal "merge done". This gate exists to keep the merge step out of the builder's hands — the builder never runs `gh pr merge` itself.

When a gate becomes pending, porch broadcasts `overview-changed` via SSE. The VSCode Builders tree picks up the blocked state and renders it with a bell icon; a toast surfaces the new gate-pending event. Architect notification is *not* automatic — gates surface via the toast/sidebar (for IDE users) or by checking the builder pane / `porch pending` (for CLI users). The builder's job at any gate is to write the artifact, commit, signal completion, and wait — never to invoke `porch approve` itself (Claude refuses the `--a-human-explicitly-approved-this` flag by design).

## Rejection / Feedback Model

There is no formal `porch reject` command. Rejection works via the feedback-iterate pattern:

1. Reviewer provides feedback (edit the plan file in VSCode, type in the builder pane, `afx send`, or issue comment)
2. Builder reads the feedback on its next turn, revises the artifact, recommits
3. The gate remains pending — porch doesn't advance until the human runs `porch approve`

The same pattern works at both gates.

## Builder Session Lifetime

The builder is a long-running interactive Claude Code session in a PTY pane managed by Tower. The session is launched as `claude "<prompt>"` (no `--print`) inside a `while true` restart loop. That form starts an interactive Claude REPL with the prompt as the first user message; after Claude finishes the prompted work it sits at the input prompt awaiting next user input. The outer `while true` loop only fires if Claude crashes — it is a crash-recovery safety net, not the gate-wait mechanism.

This means typed input in the builder pane reaches the live Claude session immediately, exactly like any other interactive Claude Code conversation. There is no "session ended at gate" state to worry about under normal operation.

## Configuration

PIR uses the same `.codev/config.json` configuration as other protocols. The `worktree` block (from Issue 689) enables the at-gate dev-server review flow:

```json
{
  "worktree": {
    "symlinks": [".env.local", "packages/*/.env"],
    "postSpawn": ["pnpm install --frozen-lockfile"],
    "devCommand": "pnpm dev"
  }
}
```

Without `worktree.devCommand`, `afx dev` won't work and the `code-review` gate degenerates to a diff-read — at which point you should probably use AIR or BUGFIX instead.

## Multi-Agent Consultation

- **plan**: human-only review. No AI consultation.
- **implement**: no AI consult — the human at the `code-review` gate is the sole reviewer of the running code.
- **review**: CMAP-2 (Gemini + Codex, type=impl) after the PR is opened; appended to PR body. Same pattern as BUGFIX / AIR's PR-creation consult.

Net: PIR runs **two model calls per protocol run**, matching its BUGFIX/AIR peers — its distinguishing features are the two human gates (`plan-approval`, `code-review`), not AI-consult density.

To disable consultation entirely, say "without multi-agent consultation" when starting work.

## Signals

PIR uses the standard porch signal vocabulary:

```
<signal>PHASE_COMPLETE</signal>          # Current phase build complete
<signal>BLOCKED:reason</signal>          # Cannot proceed
```

Signals are informational for log readability. The state machine is driven by `porch done` and `porch next` CLI calls inside the builder turn.

## Commit Messages

Commits during PIR phases use the issue-driven format:

```
[PIR #<N>] Plan draft
[PIR #<N>] Implement avatar masking
[PIR #<N>] Add Android-side regression test
```

The PR title follows the project's existing PR convention.

## Branch Naming

```
builder/pir-<issue-number>
```

Example: `builder/pir-842` for a PIR spawn against GitHub issue #842.

## File Locations

```
codev/plans/<id>-<slug>.md             # written in plan phase, on builder branch
codev/reviews/<id>-<slug>.md           # written in review phase (post-code-review-approval), on builder branch; becomes PR body
codev/projects/<id>-<slug>/status.yaml # porch state, managed automatically
```

The plan and review files ship to `main` with the merged PR — durable, searchable, git-versioned. The review file includes Summary + Architecture Updates + Lessons Learned + supporting sections, so `codev/reviews/` stays semantically consistent across protocols.
