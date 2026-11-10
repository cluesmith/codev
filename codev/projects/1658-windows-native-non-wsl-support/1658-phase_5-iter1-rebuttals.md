# Phase 5 iter1 rebuttals

Verdicts: codex REQUEST_CHANGES, claude APPROVE, gemini skipped (agy exit 3, non-blocking).

## Codex

1. **jq reported `ok` when `jq --version` fails.** Fixed. A found jq whose version probe fails is now `fail` / `not working`, with the install hint. Test added.
2. **CRLF scan missed quoted script paths (`bash "scripts/my setup.sh"`).** Fixed. New `splitShellWords` is quote-aware (single and double quotes, backslash escapes, `;` `&` `|` as separators); `findCrlfHookScripts` uses it. Tests for the tokenizer and a quoted path with spaces added.

## Claude (non-blocking comments)

1. **Install probe too narrow.** Taken. `ProgramW6432` is probed before `ProgramFiles` (a 32-bit Node sees the x86 directory), and after the `bash` PATH candidates the resolver derives the install root from each `git.exe` on PATH (`<root>\cmd`, `<root>\bin`, `<root>\mingw64\bin`), since Git's default PATH entry is `<root>\cmd`, which holds no bash. Still the spec's order: override, install locations, then PATH. Tests added.
2. **No memoization.** Deferred to Phase 6, where the launch sites start calling the resolver; the cache key (config value + env override) belongs with those call sites. Doctor calls it once.
3. **Header comments named nonexistent Windows test files.** Fixed; they now point at `windows-launch-resolvers.windows.test.ts`.
4. **Hardcoded `platform: 'win32'` for the jq lookup.** Fixed; uses `hostPlatform()`.
5. **Structural cast for `worktree`.** Fixed; the CRLF scan reads `getWorktreeConfig(root)` (typed, defaulted), guarded so a broken config skips the scan rather than failing doctor.
6. **Double escaping only for npm shims.** No change. This matches cross-spawn, whose `needsDoubleEscapeMetaChars` is exactly the `node_modules\.bin\*.cmd` test; this module additionally treats any shim with npm's `%dp0%` entry form as npm. A third-party `.cmd` that re-expands `%*` is noted for Phase 6, where forge arguments start flowing through the resolver.
