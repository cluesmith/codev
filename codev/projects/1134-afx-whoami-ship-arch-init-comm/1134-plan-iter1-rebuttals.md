# Plan 1134 — Iteration 1 rebuttal

Verdicts: Gemini APPROVE, Codex REQUEST_CHANGES, Claude APPROVE.
All three Codex points accepted; plan updated. Gemini's and Claude's minor
notes folded in.

## Codex (REQUEST_CHANGES)

### 1. Read-only requirement violated by `getDb()` path — ACCEPTED

Codex is right: the spec's non-functional requirement says `whoami` opens
global.db read-only, and the draft plan explicitly accepted the read-write
`getDb()` singleton (with migrations) for `lookupBuilderSpawningArchitect()`.
That was a spec violation dressed up as a risk item. Fixed in Phase 1:

- whoami opens ONE `new Database(path, { readonly: true })` connection for
  all its queries (`spawned_by_architect`, `known_workspaces`, `architect`
  cross-check), closed before exit.
- `lookupBuilderSpawningArchitect(builderId, workspacePath?)` gains an
  optional third parameter `db?: Database.Database` defaulting to `getDb()` —
  existing callers byte-for-byte unaffected, single source of truth for the
  SQL preserved (the spec's "reuse, don't duplicate" constraint), and
  `spec-755-lookup-builder.test.ts` gains a case passing an explicit
  read-only handle.
- The old "acceptable, afx send does it too" risk item was replaced with the
  API-signature risk + mitigation.
- Integration Points updated: `getDb()` is never invoked by whoami.

### 2. Scenario 9 coverage overstated — ACCEPTED

Verified: `packages/codev/src/__tests__/scaffold.test.ts` exists but has no
`copySkills()` tests, so "existing dynamic behavior" proved nothing. Added a
Phase 2 deliverable + test-plan entry: `copySkills()` regression tests in
`scaffold.test.ts` — copying from the real skeleton into a tmpdir target
installs `arch-init/SKILL.md` (the init/adopt/update install path), and
`skipExisting: true` preserves a pre-existing customized copy. Success
Metrics and Notes updated to match.

### 3. `resolveIdentity` purity vs `process.cwd()` helpers — ACCEPTED

Clarified in Phase 1: the send.ts helpers are NOT parameterized (not worth
the churn for two consumers); the core is `resolveIdentity(env)` which reads
cwd implicitly through `detectCurrentBuilderId()` / `detectWorkspaceRoot()`,
and tests control cwd via `process.chdir()` into tmpdir fixtures — the
established pattern at `send.test.ts:108–122`. No mid-implementation
impedance surprise. (Claude's review raised the same point independently;
same resolution.)

## Gemini (APPROVE, one suggestion)

- **Update legacy test assertions pinned to "state.db" wording in the same
  Phase 3 commit** — already in the plan (Phase 3 risk + acceptance
  criterion "update any message-text assertions"); kept as-is.

## Claude (APPROVE, minor observations)

- **Purity note** — same as Codex point 3; resolved above.
- **Drive-by scope (5 "state.db" occurrences, only 2 are stale wording)** —
  confirmed and reflected in the Expert Review section: only the user-facing
  message (`send.ts:84`) and the doc comment (`send.ts:52`) change;
  historical "state.db is retired" migration-context comments stay.
