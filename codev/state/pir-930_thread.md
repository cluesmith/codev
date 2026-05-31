# PIR #930 — mark recently-created backlog rows (< 24h)

## Plan phase

Investigated `packages/vscode/src/views/backlog.ts`. The codebase already
separates pure logic (`backlog-filter.ts`, vitest-tested in `__tests__/`) from
vscode-dependent row construction (`backlog.ts`, vscode-test in `src/test/`).
Following that pattern: new pure `backlog-recency.ts` for the age helpers,
edit `makeRow` for icon + tooltip.

`OverviewBacklogItem.createdAt` is required on the type (`api.ts:227`) and
already plumbed to the extension — confirmed via the issue + type read. No
data-flow change.

One real design call surfaced and flagged in the plan: icon precedence for a
row that is BOTH assigned-to-you AND new. Proposed assignment-wins (keep
`account` icon), newness via tooltip. Reviewer can flip it at the gate.

### Plan revised (v2) — follow #810 pattern

Architect pushed back: the icon-swap approach hides newness on assigned rows,
defeating the main purpose (engineer spotting NEW issues assigned to them).
Considered a "Recent" top group (rejected — out-of-scope structural re-sort per
the issue body). Settled on following #810's design language: a monochrome
`[new]` **text prefix after the issue number** (`#911 [new] <title>`),
analogous to #810's `[phase]` prefix. Coexists with the account/issues icon —
icons untouched. Survives truncation (leading position). Pure helper
`recencyPrefix(createdAt, now)` + `relativeAge` for tooltip, vitest-tested,
mirroring #810's extracted-testable-helper-with-fallback pattern.

Plan rewritten, awaiting `plan-approval`.

### Implement phase

Implemented per the v2 plan:
- New `packages/vscode/src/views/backlog-recency.ts` — pure helpers
  `isRecentlyCreated`, `recencyPrefix` (`'[new] '`/`''`), `relativeAge` (tooltip),
  all with injected `now`. Hardcoded 24h `RECENT_THRESHOLD_MS`.
- `backlog.ts makeRow` — `[new]` prefix after `#id`, before title; tooltip
  gains `Created <age>` when parseable. Icons untouched.
- New vitest `__tests__/backlog-recency.test.ts` — 9 tests (boundaries,
  malformed/missing, future-clamp, prefix output, age tiers).

Build/test: `check-types` ✓, `lint` ✓, esbuild ✓, vitest 122/122 (9 new) ✓.

Note: had to build `@cluesmith/codev-core` and `@cluesmith/codev-types` first —
the worktree's tsc/esbuild couldn't resolve their subpath exports until built.
Pre-existing env/build-ordering issue (confirmed via git-stash that the
status.ts/workspace.ts/terminal-adapter.ts errors exist without my diff), not
caused by this change.

Awaiting `dev-approval` gate.

### Review phase

dev-approval approved (reviewer asked to move `[new]` before the `#id` — done in
5ff73ac4). Wrote retrospective `codev/reviews/930-vscode-mark-recently-created-b.md`.
No arch/lessons file changes (additive, follows existing conventions). Opening PR
next; porch verify runs the single 3-way advisory consult.

### Consultation (single pass)

Verdicts: gemini=REQUEST_CHANGES, codex=REQUEST_CHANGES, claude=APPROVE.
Both RC's = the `[new]` placement-before-id "deviates from plan". Not a defect —
it was the reviewer's explicit dev-approval-gate request (5ff73ac4); Claude
recognized it as gate-approved. Real kernel = plan↔code drift. Disposition: no
code change; reconciled the plan to the shipped `[new] #id` order, and tightened
the review's "How to Test Locally" with concrete EDH steps (codex's 2nd point).
Escalating to human at pr gate.

### Merged

pr gate approved by architect (override accepted — both CMAP RCs were comparing
against pre-reconciliation plan; dev-approval override 5ff73ac4 + plan
reconciliation 16cb365c both legitimate PIR mechanisms). Merged PR #949 with
--merge --admin (branch protection BLOCKED), recorded via `porch done --merged`.
Protocol complete (phase: verified). Architect handling vscode CHANGELOG +
UNRELEASED.md post-merge.
