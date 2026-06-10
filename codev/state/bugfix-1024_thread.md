# bugfix-1024 — CLI preflight 400ms timeout false "CLI missing"

## Investigate

Issue #1024: `VERSION_TIMEOUT_MS = 400` in `packages/vscode/src/preflight/preflight.ts:42`
is too tight. On slow envs (remote SSH, WSL, nvm shims, AV scanning) the `codev --version`
probe exceeds 400ms → `decidePreflight` returns `missing` → walkthrough opens, Status row
sticks at `missing`, guarded commands no-op. Root cause confirmed by reading the source: the
budget value, not the resolver chain.

### Fix shape (mechanical, per issue)
1. Bump default 400 → 5000ms.
2. New setting `codev.cliVersionTimeoutMs` (number, default 5000, min 100, max 60000) in
   `package.json`, read by the preflight via `getConfiguration('codev')`.
3. Log a `[Preflight]` line to the OutputChannel when the cap fires (timeout), naming the
   value + recovery action.
4. Unit test `runCodevVersion` honours explicit `timeoutMs`; default falls back when unset.

### Key design decision
`runCodevVersion` is **vscode-free** (only `spawn` + timer). Importing `preflight.ts` for a
unit test would drag in `EventEmitter` (constructed at module load), `TowerClient`,
`tower-starter` — fragile. So I relocate `runCodevVersion` + a pure `resolveVersionTimeout`
helper + the timeout constants into `preflight-core.ts` (loads only `node:path`). The probe
is unchanged (not rewritten — out-of-scope respected), just moved to the file the project
already unit-tests under vitest. Added a `timedOut` flag to the return so the glue can log
the timeout case distinctly from spawn-error / non-zero-exit.

## Fix → PR

Implemented. `porch check` green (build 4.4s, tests 20.1s). Note: the porch
`tests` check is `pnpm --filter @cluesmith/codev test` (the codev-package vitest),
NOT the vscode-package vitest — so it doesn't touch my files, but it passes.
The vscode-package vitest has 7 pre-existing FAILING files (unbuilt
@cluesmith/codev-core / codev-types workspace-dep resolution, e.g.
terminal-adapter/terminal-resolve/reconnect-link) — unrelated to this change.
My new `preflight-version-timeout.test.ts` (12 tests) + the existing
`preflight-core.test.ts` (31) both pass.

PR #1026 created (`Fixes #1024`). Running CMAP (gemini/codex/claude, --type pr).

Gotcha: consult auto-detect failed with "Multiple projects found" because this
worktree is `.builders/bugfix-1024` (no `-<slug>` suffix), which the consult
project-resolver regex `\.builders/[^/]*?-?(\d+)-([^/]+)` can't match. Fix:
pass `--project-id bugfix-1024` explicitly.

## CMAP + PR gate

CMAP verdicts on PR #1026:
- gemini: SKIPPED (agy/Antigravity unauthenticated — non-blocking per design)
- codex:  APPROVE (MEDIUM)
- claude: APPROVE (HIGH)

Both codex and claude independently flagged stale `400ms` comments (extension.ts
activation comment + the #983 Tower-divergence comment in preflight.ts). Both
non-blocking, but addressed in f855d227 (comment-only, version-agnostic now).

Notified architect. Ran `porch done` → `porch gate` → now WAITING at the `pr`
gate for `porch approve bugfix-1024 pr`. STOP here per strict-mode protocol.

## Simplification (architect review at pr gate)

Architect pushed back on the `resolveVersionTimeout` helper + MIN/MAX constants
as over-built for a constant-bump bugfix. Walked through it: the helper's stated
purpose (unset-fallback) is dead at runtime — VSCode returns the package.json
`default` for an unset setting, so the undefined branch only ran in tests; its
only live value was the clamp + a non-number guard, both marginal for a
`"type": "number"` setting VSCode already validates in its UI.

Collapsed to the codebase idiom (matches `overviewRefreshSeconds`):
`getConfiguration('codev').get<number>(KEY, DEFAULT_VERSION_TIMEOUT_MS)`.
Deleted `resolveVersionTimeout`, `MIN_VERSION_TIMEOUT_MS`, `MAX_VERSION_TIMEOUT_MS`.
Bounds (100/60000) now live only in package.json (UI-enforced). `5000` lives in
package.json + `DEFAULT_VERSION_TIMEOUT_MS` (param default + test anchor) — the
irreducible minimum. Trade-off accepted: no runtime clamp of a hand-edited
out-of-range `settings.json` value.

Tests: dropped the resolveVersionTimeout cases; runCodevVersion suite now covers
explicit-timeout (positive), default-when-omitted (negative), ok/spawn-error,
and the 5000 regression anchor. check-types + lint + vitest green (41 tests).
