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
