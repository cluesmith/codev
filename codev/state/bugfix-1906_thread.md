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
