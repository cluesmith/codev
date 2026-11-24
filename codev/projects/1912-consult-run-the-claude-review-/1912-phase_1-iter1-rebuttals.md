# Phase 1, iteration 1: responses to review

Codex: REQUEST_CHANGES. Claude: APPROVE, with four non-blocking notes.

## Codex: the auth line can name the wrong credential when both API variables are set

**Accepted in substance; the suggested mechanism is not used, because the real CLI contradicts it.**

Codex suggested taking the credential name from the CLI-reported `apiKeySource`. A local `claude auth status --json` probe on 2.1.326 (no model call) shows why that would mislead:

| Child env | `authMethod` | `apiKeySource` |
|---|---|---|
| `ANTHROPIC_API_KEY` + `ANTHROPIC_AUTH_TOKEN` | `oauth_token` | `ANTHROPIC_API_KEY` |
| `ANTHROPIC_API_KEY` + `CLAUDE_CODE_OAUTH_TOKEN` | `api_key` | `ANTHROPIC_API_KEY` |
| `ANTHROPIC_AUTH_TOKEN` + `CLAUDE_CODE_OAUTH_TOKEN` | `oauth_token` | (absent) |

With both API variables set, `apiKeySource` names the key while `authMethod` says the bearer token won. Naming `apiKeySource` as the credential in use would contradict `authMethod`. The existing precedence (`ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `CLAUDE_CODE_OAUTH_TOKEN`) agrees with `authMethod` in every row.

The real defect codex found stands: the line hid a credential the CLI was reporting. The fix is that the line now names the winner by precedence and every other credential variable present in the child env, so nothing is hidden and nothing is guessed:

`oauth_token (ANTHROPIC_API_KEY) — ANTHROPIC_AUTH_TOKEN (from shell), with ANTHROPIC_API_KEY (from .env) also set, consult.claudeAuth="api-key" in /repo/.codev/config.json`

A test with that exact status shape is added. The probe is recorded in the function's doc comment.

## Claude's notes

1. **Relative `CODEV_CLAUDE_BIN`.** Accepted. `resolveClaudeBin` now returns `path.resolve(pinned)`, so Phase 2's spawn with `cwd` = the workspace runs the same file that was checked. A test is added.
2. **`binaryLine` reads `process.env`, the rest reads `opts.processEnv`.** Kept, with a comment. The pin is consult's own setting and is read where `resolveClaudeBin` reads it; `opts.processEnv` is only the source of the child's env.
3. **Timeout reported as "killed by SIGTERM".** Accepted. An `ETIMEDOUT` now reads `no answer within 30s`.
4. **Provider-switch truthiness (`1/true/yes/on`).** Unchanged. It is the existing #1754 rule, moved here, and display-only. Checked again on the Phase 2 live run.
