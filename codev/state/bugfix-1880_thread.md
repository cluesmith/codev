# bugfix-1880 thread — consult codex lane runs a stale bundled Codex

## Investigate (2026-11-09)

**Reproduced** on the global codev 3.3.7 install: `consult -m codex --model-id gpt-6-astra`
→ 400 "The 'gpt-6-astra' model requires a newer version of Codex". The machine's own
`codex exec -m gpt-6-astra` (codex-cli 0.167.0) answers `OK`.

**Root cause.** `packages/codev/package.json` declares `"@openai/codex-sdk": "^0.146.0"`. On a
0.x package a caret range pins the MINOR (`>=0.146.0 <0.147.0`), so no install, global or
otherwise, can float past 0.146.x. The SDK pins its `@openai/codex` binary to its own exact
version and resolves it from its own install location (`findCodexPath`), never from PATH, so
upgrading the user's CLI changes nothing. The lockfile resolves 0.146.0; npm's global install
resolved 0.146.1.

**Not visible today:** nothing in consult's output says which Codex binary ran, so the
"newer version of Codex" error reads like a CLI-upgrade problem the user already solved.

**SDK 0.146 → 0.167 diff** is additive: new optional `configOverrides`, `threadSource`,
`cyberAccessProgram`; `ModelReasoningEffort` widens to add `max | ultra | persistent`. The
exhaustiveness guard in `consult-lanes.ts` (Spec 1286) deliberately breaks the build on that
widening, so `REASONING_EFFORTS` (+ its test + both consult.md copies) must grow too.

**Fix scope (issue's three suggestions):**
1. Bump `@openai/codex-sdk` to `^0.167.0` (the real fix).
2. Name the Codex binary (bundled version or override path) on the `[CODEX]` startup lines and
   in the codex lane's error annotation.
3. `consult.codexPath` config, passed to the SDK as `codexPathOverride`, so a user can point
   the lane at their own newer CLI when the bundle lags again. Config only, no `CODEX_PATH` env:
   one surface, and the global `~/.codev/config.json` layer already covers "all my projects".

## Architect rulings mid-fix (2026-11-10 UTC)

- **Owner constraint: codex lane stays on the ChatGPT subscription, never API tokens.** Re-ran the
  architect's check on the NEW bundled binary with `.env` loaded exactly as consult's
  `loadDotenv` does (`OPENAI_API_KEY` set from .env, `CODEX_API_KEY` unset), against the binary
  the 0.167.0 SDK itself resolves: `codex-cli 0.167.0`, `login status` → `Logged in using
  ChatGPT`. Same on the old 0.146.1. SDK credential code is byte-identical between versions.
- **Keep `consult.codexPath`**, with: off by default; a set path that doesn't exist or isn't
  executable fails loud, no fallback; `[CODEX]` startup lines name binary + version; never pass
  apiKey. Implemented as: absolute-path syntax check at config load; `<path> --version` once per
  run (reports the real version AND is the fail-loud executability check); a test pins no-apiKey.

## Fix (2026-11-10 UTC)

- One existing test pinned the old behaviour "a default-model failure is left unannotated". It
  now gets the binary line (a too-old CLI rejects even the default model, e.g. via an old
  override); the model-provenance half stays absent. Updated, not deleted.
- Without the fix 7/8 new tests fail; the 8th (no apiKey) is a guard that was already true.
- E2E from this worktree's build: `--model-id gpt-6-astra` → `OK` on the bundled 0.167.0 and on
  `consult.codexPath=/opt/homebrew/bin/codex`; a missing path exits 1 naming ENOENT and the
  config file. (Used a temporary `.codev/config.local.json` edit, restored byte-for-byte.)
- Full codev suite: 7237 passed, 49 skipped.

## CMAP on PR #1889 (2026-11-10 UTC)

First dispatch failed in all three lanes: "Multiple projects found". From a builder worktree,
`consult --type pr` needs `--issue 1880`.

- **gemini: APPROVE** (HIGH), no issues.
- **codex: REQUEST_CHANGES → APPROVE.** Real bug: `resolveCodexBinary()` ran before the guarded
  `try`, so a bad `codexPath` skipped `discardStaleOutput` + failure metrics and a stale review
  file could be read as current. Moved the preflight inside the try; added a test that fails
  without the move. Re-review: APPROVE (HIGH), no issues.
- **claude: APPROVE** (HIGH). Its "REPOSITORY MOVED" tripwire was my own fix commit landing
  mid-review (reflog shows only my commits); it reviewed that head. Minors:
  1. "use `require.resolve` instead of the paths walk": refuted, it throws
     ERR_PACKAGE_PATH_NOT_EXPORTED (SDK exports only `import`). Added a comment saying so.
  2. `codexPath` missing from the fail-fast contract table: added a row (both consult.md).
  3. `codexPath` absent from `ConsultLaneConfig`: left as is; that type is the input to the
     model/effort resolvers, which don't read it.
  4. Real-CLI coverage is one manual e2e: noted. That run went through the branch's real SDK
     path (stream, usage, completion), on both the bundled CLI and the override.
