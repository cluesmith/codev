# bugfix-1224 — Tower/shellper architect session-ID collisions + non-recovering crash loops

Protocol: BUGFIX (strict). Issue #1224.

## Investigate

### Symptom A root cause (the headline: session-ID collision crash loop)

`resolveArchitectLaunch` (`packages/codev/src/agent-farm/servers/tower-utils.ts`) decides
whether to resume a persisted architect conversation. Since #1145 it resumes a stored
session id whenever the jsonl **exists on disk** (`sessionIsOwned` → `verifySessionOwnership`).

It never checks whether a **live process is already holding** that session id. When one is
(the report's two cases: a stale pre-restart shellper's claude child, or an unrelated
foreground claude), it bakes `claude --resume <id>` anyway → claude dies instantly with
`Error: Session ID <uuid> is already in use` → shellper auto-restarts → dies again → crash loop.

The existence check answers "does the transcript exist?" but not "is someone using it right now?"
— and a *held* session's jsonl exists precisely because the holder is writing to it, so the
#1145 guard is guaranteed to pass in exactly the collision case.

### Fix (reporter's suggestion (a)): verify no live holder before resuming

Before resuming a stored id, positively confirm **no live process holds it** (scan the process
table for the id in argv — the same observable technique as the #1007 orphan-shellper cleanup).
If a live holder is found, mint a fresh session instead of colliding. This is universally safe
for both holder cases: we never touch the holder (critical — case 2's holder is the user's own
foreground claude, must not be killed), and the new architect gets a working fresh conversation.
The crash loop never starts.

### Scope decision

- Fix (a) is the isolated root-cause fix for Symptom A. Implementing it.
- Fix (b) "crash-loop breaker in shellper" already largely exists (#1149
  `maybeApplyCrashLoopFallback`, 3 failing exits in 30s → swap to fresh). Noting in PR.
- Fix (c) "atomic deregistration/process death" (Symptom B registry divergence) is a separate,
  more architectural concern — will recommend a follow-up issue rather than expand scope here.

## Fix

`packages/codev/src/agent-farm/servers/tower-utils.ts`:
- New `sessionHasLiveHolder(sessionId, {list?})` — scans `ps -A -o args=` for a live process
  launched with `--session-id <id>` / `--resume <id>` (both space- and `=`-joined). Match is
  **flag-anchored**, not a bare substring — a bare substring false-positived on the short synthetic
  ids in the existing tests (e.g. `'x'`) and is generally unsafe. On scan failure returns `false`
  (purely additive guard: diverts to fresh only on positive evidence, never worse than today).
- `resolveArchitectLaunch` resume gate now requires `sessionIsOwned(...) && !hasLiveHolder(...)`.
  Held id → mint fresh (with a WARN log) instead of baking a colliding `--resume`. Added
  `hasLiveHolder` + `log` seams; ownership is still checked first so the (cheap-ish) `ps` scan is
  skipped for stale ids.
- `resolveArchitectRestart` threads `log` through (restart-bake path inherits the guard for free).

`tower-instances.ts`: pass `log: _deps.log` at the `addArchitect` and `launchInstance` main-path
call sites so the divert-to-fresh decision is diagnosable in Tower logs.

Tests (`tower-utils.test.ts`): +7 cases (held→mint-fresh with WARN, no-holder→resume, ownership
short-circuits the scan, and 4 `sessionHasLiveHolder` unit cases incl. scan-failure→false).

### Validation
- `porch check`: build ✓, tests ✓ (full suite, 26.8s). tsc --noEmit clean.
- Note: the worktree spawned WITHOUT `node_modules` (postSpawn `pnpm install` had not run); ran
  `pnpm install` + built `@cluesmith/codev-core` to get a working test env. A raw `vitest run`
  before the full build shows 8 pre-existing env failures (missing `dist/` + copied skeleton
  artifacts — adopt/update/consult/tier-materialization/consolidate/session-manager integration);
  all clear once porch's build check emits those artifacts. None touch changed code.

## PR

PR #1225 opened (`Fixes #1224`), mergeable. CMAP:
- Codex: APPROVE (HIGH, no issues)
- Claude: APPROVE (HIGH, no issues) — confirmed TOCTOU windows are safe (mint-fresh or #1149 backstop)
- Gemini: skipped non-blocking (couldn't emit a `--type pr` VERDICT in this worktree; known lane limitation)

No REQUEST_CHANGES. Requested the `pr` gate via `porch done`; awaiting human approval before merge.

Note for follow-up: consult's project auto-detect fails from a builder worktree that carries the
full `codev/projects/` tree ("Multiple projects found"); had to pin `--issue 1224 --project-id
bugfix-1224`. Worth a separate issue if it recurs.
