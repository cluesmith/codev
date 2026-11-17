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
