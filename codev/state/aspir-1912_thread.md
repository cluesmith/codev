# aspir-1912 thread — consult claude lane → installed `claude` CLI

## 2026-11-16 — Specify

No spec existed; wrote `codev/specs/1912-consult-run-the-claude-review-.md` from scratch.

Research findings worth keeping:
- Only two production SDK importers: `commands/consult/index.ts` and `commands/doctor.ts`. `persona` / `dev:local` do NOT import it (stale comment in `buildClaudeConsultEnv`).
- `ANTHROPIC_API_KEY=… claude auth status` → `authMethod: api_key` even with a Max login stored: confirms the billing hijack the issue describes.
- `claude auth status --json` is local (~0.18s), exits 1 when logged out, but reports `loggedIn: true` for a FAKE `CLAUDE_CODE_OAUTH_TOKEN` (no server-side validation).
- `--bare` forces API-key auth (never reads OAuth/keychain), so it is unusable for a subscription-default lane.
- Today's SDK lane: `allowedTools` + `bypassPermissions` does not restrict tools (#1649). The CLI's `--tools` restriction makes read-only a hard property.
- SDK 0.2.105 bundles CLI 2.1.105, which already has every flag the new lane needs (`--tools`, `--max-budget-usd`, `--setting-sources`, `--no-session-persistence`, `--strict-mcp-config`, `--max-turns`, `--system-prompt-file`, `auth status`). Floor set at 2.1.141 for claude-opus-5 compatibility (PR #1907's matrix).
- PR diffs are written to consult's temp sandbox dir, so the reviewer must be able to read outside the workspace without a permission prompt.

Decisions flagged as Important open questions: `CLAUDE_CODE_OAUTH_TOKEN` and provider switches pass through in default `login` mode; key-only CI breaks until it opts in with `consult.claudeAuth: "api-key"`.

### Spec review iter 1 (codex + claude: both REQUEST_CHANGES, all points folded in)
- claude found the real gap: `--tools Read,Glob,Grep` removes Bash, but the PR, impl and integration prompts and the shared `consultant.md` tell the reviewer to `cat` and `git diff`. Resolution: a claude-lane-only capability note appended to the role; the shared role stays untouched (the codex and gemini lanes keep a shell).
- codex: the `consult.claudeAuth` opt-in is honoured from any config layer and the auth line names the file; runs that fail before auth is known print no auth line; SIGINT/SIGTERM terminates the child and removes stale output, with no metrics row required; temp role file is 0600, kept in the sandbox dir, and always removed.
- Wording fixes: `--max-turns` and `--system-prompt-file` are hidden flags; the 2.1.141 floor needs nuance (2.1.105 got a 400 on the API-key path only); JSON-only stdout must be confirmed on the live run; `apiKeySource` added; concurrency noted.

## Plan (2026-11-16)
4 phases: (1) `lib/claude-cli.ts` primitives, `consult.claudeAuth` (validator in `consult-lanes.ts`), `lib/dotenv.ts` parser, test guard + harness fake claude, stub helper, real fixture capture; (2) consult lane on `claude -p` with init-event tools guard, kill+await on abort, signals, migrated tests; (3) doctor on the CLI + SDK removal; (4) docs in every tree + skill hashes.
Plan review iter 1: codex COMMENT and claude COMMENT, all folded in. Key catch: `SDK_MODELS` is the model-validation list, so it is renamed to `RUNNER_LANES` and keeps `claude`. Declined `--permission-prompts none`: absent at 2.1.105 and unverified at the 2.1.141 floor.
Worktree setup done: `pnpm install` ok, baseline `pnpm build` ok.

## Implement phase_1 (2026-11-17)
Fixture capture: one tiny live call (`Reply with the word OK`, `--max-turns 1`, `--max-budget-usd 1`, `--model claude-opus-5`) from `/tmp`, with the full Phase 2 argv (`-p --output-format stream-json --verbose --tools Read,Glob,Grep --setting-sources "" --strict-mcp-config --disable-slash-commands --no-session-persistence --system-prompt-file … --add-dir … --permission-mode dontAsk --allowedTools Read,Glob,Grep`), session markers and API keys scrubbed. CLI 2.1.326. Cost $0.03.
- Every flag was accepted (exit 0). stdout was **JSON-only** (4 lines: `system/init`, `assistant`, `rate_limit_event`, `result`). stderr was empty. No blocker.
- The init event's `tools` is exactly `["Glob","Grep","Read"]`. `mcp_servers: []`, `slash_commands: []`, `skills: []`, `permissionMode: "dontAsk"`, `apiKeySource: "none"`.
- Isolation: `plugins` lists only the CLI's own `cc-plugin-*@builtin` entries, so user plugins (e.g. easel) did not load. `agents` lists the built-in agents, but no Agent/Task tool exists to call them. `memory_paths.auto` is still reported (the spec's auto-memory nice-to-know); harmless with no write tools.
- `result.modelUsage["claude-opus-5"].contextWindow` is **1,000,000** on the installed CLI. The stale bundled CLI budgeted 200k, so #1641 should be much rarer on the CLI lane.
- `auth status --json` shapes (keys only, values never printed): claude.ai login → `loggedIn:true, authMethod:"claude.ai", subscriptionType:"max"`, no `apiKeySource`; a key → `authMethod:"api_key", apiKeySource:"ANTHROPIC_API_KEY"`; a token → `authMethod:"oauth_token"`; logged out → exit 1, `loggedIn:false, authMethod:"none"`.
- Fixtures: `claude-stream-success.jsonl` is the trimmed real stream. The error variants (`error-result`, `error-max-turns`, `prompt-too-long`) keep the real init event and reshape only the result, per the SDK 0.2.105 `SDKResultError` type; no second live call was made.

Design note: `preflightClaude` throws a `ClaudePreflightError` carrying `binaryLine`/`authLine` as far as they were known. A logged-out CLI still parsed, so it gets an auth line (it names any withheld key, which is the CI fix). Earlier failures get none.
