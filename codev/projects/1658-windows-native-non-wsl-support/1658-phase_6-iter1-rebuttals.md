# Phase 6 iter 1: responses

Gemini: skipped (agy exit 3, non-blocking). Codex: REQUEST_CHANGES. Claude: APPROVE with five notes.

## Codex

- **doctor spawns Codex/OpenCode/agy bare.** Accepted, fixed. `runCommand` (every version probe), `verifyAiModel` and the agy probe now go through `spawnSyncOnHost` / `spawnOnHost` (new `spawnSyncOnHost` beside `spawnOnHost` in lib/shell-launch.ts): POSIX spawns exactly as before, Windows resolves `.cmd` shims and hides the console. Tests: `spawnSyncOnHost` on both platforms, and doctor's version probe (`windowsPrereqDeps().jqVersion`) under the win32 seam (windows-shell-spawns.test.ts). The only direct spawn left in doctor is `git remote -v` (`git.exe`).

## Claude

1. **Role file path native inside `$(cat ...)`; no test tells an empty substitution from a real one.** Kept the path native on purpose (the harness owns the fragment and codex receives the same path as an argument, where a native path is what it needs; MSYS accepts backslash paths in `cat`). Closed the verification gap: the agent stub records its argv, and launchers.windows.test.ts now asserts the argument after `--append-system-prompt` equals `.builder-role.md` (trailing newlines stripped, as `$(...)` does) and is non-trivial.
2. **init/adopt bake `powershell.exe` into the committed config.** Accepted. The scaffolds write `shell: 'bash'` exactly as before on POSIX; on Windows the `shell.shell` key is omitted, so the loader's per-host default applies on every teammate's machine. (No unit test: init.test.ts is excluded from the default run, and the change is a one-line branch.)
3. **Unreachable `tail` after the Windows follower.** Added an explicit `return`. Silent read errors in `followFile` are deliberate for a log follower (a missing or rotating log reads as empty and is picked up when it reappears); left as is.
4. **Forge override `/path/x.sh --flag` reaches `bash -c` with a backslash path.** A configured override is a user-written bash string, and bash semantics are the contract (same as POSIX). Not changed.
5. **`PATH_INPUTS` criterion undocumented.** Added the criterion to its doc comment.
