# Phase 10, iteration 1: responses

Fixed in commit 43dd92a7c.

## codex (REQUEST_CHANGES)

### 1. node-pty runtime load failures are unwrapped (accepted, fixed)

Correct. The spec says "install or first run fails with a message naming the supported Node
versions", and only the better-sqlite3 open was wrapped. node-pty loads its ConPTY binding
lazily, inside `spawn`, so the import and the first spawn are both load points:

- `lib/native-deps.ts` adds `withNativeLoadExplanation(load)`, which rethrows a binding-load
  failure through `explainNativeLoadFailure`. The load-failure patterns now also match
  `conpty.node` and `pty.node`. node-pty 1.1's own loader message ("Failed to load native module:
  conpty.node, checked: ...") was already matched.
- `terminal/pty-session.ts` wraps the dynamic `import('node-pty')` and `nodePty.spawn(...)`.
- `terminal/shellper-main.ts` wraps the `require('node-pty')` and `nodePty.spawn(...)`.
- On POSIX, and for any error that is not a binding-load failure, the error is unchanged:
  `explainNativeLoadFailure` returns it as is.

Tests:
- `pty-session-native-load.test.ts` covers three cases. With the win32 seam, a ConPTY loader
  error from spawn surfaces with the supported-versions message and keeps the original as
  `cause`. With the darwin seam, the same error is unchanged. With the win32 seam, an unrelated
  spawn error is unchanged.
- `native-deps-guard.test.ts` covers the ConPTY error shapes and `withNativeLoadExplanation`.

### 2. Doctor reports the effective `core.longpaths`, not the per-user one (accepted, fixed)

Correct. The spec asks for "whether Git's per-user `core.longpaths` is set". A repository-local
value would not cover other clones or new worktrees. `windowsPathDeps().gitLongPaths` now runs
`git config --global --get core.longpaths`. The check, the warning and its
`git config --global core.longpaths true` hint are unchanged. `doctor-windows-paths.test.ts`
asserts the real-host seam asks git for the `--global` value.

## claude (APPROVE): notes

1. `SUPPORTED_WINDOWS_NODE` names Node 22/24 while the ABI table also admits Node 25/26. This is
   deliberate. The message names what Codev documents and tests (the LTS lines); the table admits
   what has prebuilds, so a Node 25/26 user passes without seeing the message. Deriving the text
   from the table would advertise non-LTS lines. Left as is; the parity test keeps the install
   and runtime copies identical.
2. `spec-1658-tmp: opaque` is self-declared. Agreed, and the green Windows run is the real
   evidence, as the note says. Each annotation was assigned by reading the file's `/tmp` uses,
   and every disk-reaching use was moved or skipped.
3. The `porch done` glob change is POSIX-visible. It is disclosed in the review as a same-cause
   fix that also corrects workspace paths with glob metacharacters.
4. The POSIX Claude project-dir encoding is unverified. It is listed as a carry-forward and
   filing candidate in the review.
5. #1800 is out of scope. The architect is keeping it open.

## gemini

Skipped: agy exited with code 3, so the lane produced no review.
