# bugfix-1906 thread — claude lane 400 on claude-opus-5 from the repo lockfile

## Investigate (2026-11-16)

**Reproduced** from this worktree's build (`pnpm install --frozen-lockfile` + `pnpm build`):
`node packages/codev/bin/consult.js -m claude --prompt …` →
`API Error: 400 "thinking.type.enabled" is not supported for this model`, auth `ANTHROPIC_API_KEY (from .env)`.

Minimal repro (SDK `query()` direct, `claude-opus-5`, trivial prompt):

| SDK (bundled Claude Code) | API key | stored login |
|---|---|---|
| 0.2.105 / 2.1.105 (lockfile) | **400** | OK |
| 0.2.141 / 2.1.141 (installed consult 3.3.7) | OK | OK |

So the failure is the API-key path on the old bundled CLI. The login path passing on 0.2.105 is
unexplained (some server- or account-side difference); not chased, since the floor raise fixes both.

**Root cause.** `packages/codev/package.json` declares `^0.2.41`; `pnpm-lock.yaml` resolves 0.2.105.
Its bundled CLI decides "supports adaptive thinking" by model-name allowlist: `opus-4-6` /
`sonnet-4-6` → adaptive, and **any other name containing opus/sonnet/haiku → false**, so
`claude-opus-5` gets `{type:"enabled", budget_tokens}`, which the model rejects. The only override
is an env-var capability hook (`ANTHROPIC_DEFAULT_*_MODEL` + `…_SUPPORTED_CAPABILITIES`) — a hack,
not used.

**Consult sets no thinking option** (claude lane passes model/tools/turns/budget/env only;
`codev doctor`'s probe passes no model). Setting `thinking: {type:'adaptive'}` from consult would
not help: CLI 2.1.105 rewrites it to `enabled` when the allowlist says no. So no consult change —
the SDK is the thing that knows model capabilities.

**Release question.** Not a blocker for fresh installs: `pnpm publish` ships the range, not the
lockfile, and `local-install` is `npm install -g <tarball>`, so both resolve fresh — and a caret on
0.x pins the minor, so they get 0.2.141 (last 0.2.x; 0.3.x is never picked). The exposure is any
install whose own lockfile already resolved an old 0.2.x — the floor raise closes that.

**Fix scope.** Floor → `^0.2.141` (the version every fresh install already runs), refresh the
lockfile, regression test pinning both the declared floor and the installed version (same shape as
#1880's codex-CLI floor test). Well under BUGFIX's ceiling. 0.3.x is out of scope.

## Fix + PR #1907 (2026-11-16)

- Floor `^0.2.41` → `^0.2.141`; lockfile refreshed (diff confined to the SDK subtree: SDK + per-platform
  native-binary packages, `@anthropic-ai/sdk` 0.81→0.93, `@img/sharp-*` optionals dropped).
- Regression test `consult/__tests__/bugfix-1906-claude-sdk-floor.test.ts` (installed version ≥ 0.2.141,
  declared floor ≥ 0.2.141, default model pinned). Proven to fail on main's manifest+lockfile (2 failed)
  and pass with the fix.
- E2E: worktree `consult -m claude` on claude-opus-5 over the API key — 400 before, review after.
- Per architect instruction, ran only the touched test while iterating; the full suite ran once, via
  porch's fix-phase `tests` check (pass).
- CMAP (repo lanes codex + claude; agy skipped, broken for `--type` reviews): codex=APPROVE (HIGH),
  claude=APPROVE (HIGH). The claude review itself ran on the worktree build — the path that used to 400.
  Non-blocking notes, not taken (BUGFIX minimal scope), surfaced to the architect: log the SDK
  version on the claude lane like #1880 does for codex; open a 0.3.x migration follow-up (0.2.141 is
  the last 0.2.x, so the caret is now effectively a pin).

## Fold-in (architect, 2026-11-16)

Architect asked (owner's fix-in-place rule) to take CMAP note (1): the claude lane now logs
`[CLAUDE] agent sdk: @anthropic-ai/claude-agent-sdk <version> bundled with codev` beside the auth line,
via an exported `bundledClaudeAgentSdkVersion()` (same lookup-path walk as `bundledCodexVersion`). The
floor test now uses that helper and pins the line. Verified live: worktree build prints
`… 0.2.141 bundled with codev` and returns a review. 0.3.x migration stays a follow-up.
