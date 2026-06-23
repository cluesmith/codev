# bugfix-1094 — afx send detectCurrentBuilderId silent misroute

Issue #1094. Protocol: BUGFIX (strict). Branch: `builder/bugfix-1094`.

## Investigate

**Bug**: `detectCurrentBuilderId()` (`packages/codev/src/agent-farm/commands/send.ts`)
silently returns the bare worktree dir name (e.g. `bugfix-2461`) on three
unverifiable paths inside a *confirmed* `.builders/<id>/` context:

1. `!existsSync(dbPath)` → `return worktreeDirName` (line 73)
2. `catch { return worktreeDirName }` — DB open failure (line 78-80) ← the real incident (Node ABI mismatch)
3. no matching builder row → `return worktreeDirName` (line 97)

The bare name is non-canonical (`builder-bugfix-2461` is the real id), so
Tower's `lookupBuilderSpawningArchitect(sender)` returns `undefined`, and
`resolveAgentInWorkspace` drops to the "non-builder sender → main first"
branch (`tower-messages.ts:344-347`). Net: builder's `afx send architect`
silently lands on **main** instead of its spawning architect.

Violates global principle #1 "fail fast, NEVER implement fallbacks": a fatal
environmental fault (DB unreadable) is laundered into a plausible-looking
misroute that is very hard to diagnose. Related memory:
reference_hermes_node_shadow_misroute.

**Call graph**: `detectCurrentBuilderId()` is used in exactly one place —
`send()` line 222: `const from = detectCurrentBuilderId() ?? 'architect'`.
Plus the two test files. Blast radius is just `afx send`'s `from` identity.

## Fix plan

1. `detectCurrentBuilderId`: in a confirmed builder context, **throw** a typed,
   actionable `BuilderIdResolutionError` on all three unverifiable paths instead
   of returning a bare name. DB-open failure gets a message that names the
   likely ABI-mismatch cause. Contract becomes: returns canonical id | null
   (not a builder); throws when it's a builder but id can't be verified.
2. `send()`: wrap the `from` computation; on throw, `fatal(message)` so afx send
   aborts loudly rather than misrouting.
3. Tower guard (defense-in-depth): in `resolveAgentInWorkspace`, when sender
   looks like a builder id (`parseAgentName` / `…-<n>` shape) but
   `lookupBuilderSpawningArchitect` returns `undefined`, log a warning before
   the main-first fallback.
4. Tests: update bugfix-774 tests that encoded the bare-name fallback; add a
   DB-open-failure regression test asserting it does NOT return a bare name.

Note: worktree had no node_modules — running `pnpm install` to build/test.

## Fix (done)

Implemented:
- `send.ts`: new `BuilderIdResolutionError` + `describeStateDbOpenFailure` (ABI-mismatch
  hint). `detectCurrentBuilderId` now **throws** on all 3 unverifiable paths in a
  confirmed builder context (missing db / open failure / no row) instead of returning
  a bare name. Call site in `send()` wraps it → `fatal()` on throw.
- `tower-messages.ts`: `looksLikeBuilderId` + guard in `resolveAgentInWorkspace` — warns
  before the main-first fallback when a builder-shaped sender has no row (and isn't a
  registered architect). Defense-in-depth.

Reproduced bug (unopenable db → old code returned bare `bugfix-2461`). Verified fix
against REAL main state.db: worktree resolves to canonical `builder-bugfix-1094`
(happy path unchanged).

Tests:
- bugfix-774 test: the 2 fallback tests now assert throws; added DB-open-failure
  regression + `describeStateDbOpenFailure` message tests.
- new bugfix-1094-tower-guard test: `looksLikeBuilderId` + warn-then-main-fallback.
- send.test.ts: was built on the old silent fallback (ran from worktree CWD, mocked
  existsSync→false). Now chdir to tmpdir in beforeEach so `from` resolves to
  'architect' deterministically; simplified `getExpectedFrom()`.

Full suite green: 167 files / 3347 tests pass, 0 fail. Net ~217 LOC tracked +
~110 new test file. Within BUGFIX scope.

## PR (gate: pr)

PR #1095 opened. CMAP (`--protocol bugfix --type pr`):
- codex  = APPROVE (HIGH, no key issues)
- claude = APPROVE (HIGH, no key issues)
- gemini = NO VERDICT (broken agy review lane — burned session hunting for source
  under sandbox restrictions; matches reference_agy_consult_review_broken #1032/1033)

No REQUEST_CHANGES, no defects surfaced. One non-blocking note (looksLikeBuilderId
could match a hypothetical architect name like `custom-42`) — already mitigated by the
`!entry.architects.has(sender)` guard + warning-only nature. No changes made.

Two pre-existing consult tooling gotchas hit (NOT my bug, candidates for follow-up issues):
1. `consult --type pr` needs explicit `--protocol bugfix` or it looks at top-level
   `codev/consult-types/pr-review.md` (only `integration-review.md` lives there;
   pr-review.md is per-protocol under `protocols/<p>/consult-types/`).
2. consult project auto-detect regex `/\.builders\/[^/]*?-?(\d+)-([^/]+)/` requires a
   trailing slug after the issue number; worktree `bugfix-1094` (no slug) fails →
   "Multiple projects found". Workaround: `--project-id 1094`.

Requesting pr gate via `porch done`. Waiting for human approval.
