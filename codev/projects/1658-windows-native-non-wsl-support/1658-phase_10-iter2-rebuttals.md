# Phase 10, iteration 2: responses

## codex (REQUEST_CHANGES)

### Direct `new Database(...)` paths bypass the explanation (accepted, fixed)

Correct. Only `db/index.ts` explained a better-sqlite3 load failure. The fix centralizes
construction:

- New `lib/sqlite.ts` `openDatabase(filename, options)` is the one way runtime code opens a
  better-sqlite3 database. It wraps construction in `withNativeLoadExplanation`.
- Every runtime construction site now uses it:
  - `MetricsDB` (`consult/metrics.ts`)
  - `whoami`, `send` (identity lookup)
  - `afx db` and `afx tower` (migration planning)
  - `db/consolidate.ts` (both)
  - `servers/overview.ts` (both)
  - `db/index.ts`, replacing its own try/catch
  No runtime `new Database(` remains outside the helper.
- Callers that degrade when the open fails (`whoami` returns no database; `send` wraps the error
  in a `BuilderIdResolutionError`) now call `rethrowIfNativeLoadFailure(err)` first. On Windows a
  binding load failure is rethrown with the supported-versions message, not taken as a missing
  database. On POSIX these callers behave as before.
- The overview paths keep their catch-and-continue. Tower cannot start at all with a broken
  binding (`getGlobalDb` in `db/index.ts` fails first, now with the message), so those catches
  are not reached in that state.

Test: `spec-1658-native-load-commands.test.ts` mocks better-sqlite3 to throw the real "Could not
locate the bindings file" error. It covers three cases:
- `openDatabase` explains the error on Windows and keeps the original as `cause`.
- At command level, `afx whoami`'s architect path fails with the supported-versions message on
  Windows, where before it degraded quietly to "no database".
- On POSIX the same path keeps its degrade behaviour.

## claude (APPROVE): comments

- `encodeClaudeProjectDir` on a real Windows Claude install: a carry-forward in the review. The
  failure mode is benign (resume launches fresh).
- `file_tabs` prefix delete: the iteration-1 triage traced the writer. Tower stores tab paths
  through realpath/resolve, so they are in native form, and cleanup passes the native worktree
  path. The `path.sep` boundary matches that.
- Phase 11 docs must say Windows needs Node 22/24: agreed. That is Phase 11's job, and the
  review records it.

## gemini

Skipped: agy exited with code 3.
