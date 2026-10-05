# bugfix-1754 thread — consult: workspace .env silently overrides Claude lane credentials

## Investigate (2026-09-29)

**Reproduced (credential half).** Scratch git workspace, shell with no credential vars, `.env` holding
`CLAUDE_CODE_OAUTH_TOKEN=<bogus>` + `ANTHROPIC_API_KEY=<bogus>`. Running
`consult -m claude --prompt … --output out.md` against the unfixed build gives
`[CLAUDE] model: claude-opus-5`, then `401 OAuth access token is invalid`. The `.env` token beat the
keychain login, and nothing on stderr says a credential came from `.env`.

**Root cause.**
- `loadDotenv` (`packages/codev/src/commands/consult/index.ts:220`) copies every `.env` key the
  shell lacks into `process.env` and keeps no record of which ones it set.
- `buildClaudeConsultEnv` (#985) sees the injected OAuth token and strips the API key. The SDK
  subprocess then authenticates as that token's org. No log line names the credential.

**The "run succeeds with the limit text" half, as the issue states it, did NOT reproduce on current SDKs.**
- In the bundled CLI (2.1.105), an API-error final assistant message (usage limit, billing, auth)
  produces `result {subtype:'success', is_error:true, result:<text>}`, and the process exits 1.
- SDK 0.2.105 (our lockfile) and 0.2.141 (what `^0.2.41` resolves for adopters today) both yield
  that result *first*, and consult's loop records it as a success. The SDK then throws
  "Claude Code returned an error result: …" only because the subprocess exited non-zero.
- So consult already exits 1 with no output file, which matches the adopter's "failed 4/4, only
  output was the limit text". The latent bug is that consult ignores `is_error`, so failing
  depends on the SDK's exit-code rethrow. Fix: check `is_error` in consult itself, and name
  the auth source in the error.

**Codex lane.** Verified with `codex doctor` (read-only) on codex 0.146.0:
- `CODEX_API_KEY` switches codex to api-key auth.
- `OPENAI_API_KEY` does not. It stays on the ChatGPT login, and with no stored login the auth
  mode is `none`.

So the codex auth line names only `CODEX_API_KEY`.

**Decision on item 3 (should `.env` inject credentials at all):** keep injecting. Changing
precedence is a behaviour change for adopters who rely on `.env` keys, so it's the architect's
call. Instead: make it visible (log line + auth source in the error) and document it in the consult
skill (4 byte-identical copies: `.claude`, `.codex`, and both skeleton copies).

Scope: well under 300 LOC. BUGFIX fits.

## Fix (2026-09-29)

Commit `aed747578`, ~55 source lines plus tests and docs.
- `loadDotenv` records the keys it injected (`dotenvKeys`).
- `describeClaudeAuth`, applied to the env `buildClaudeConsultEnv` produced, and
  `describeCodexAuth` feed `[CLAUDE] auth:` / `[CODEX] auth:` on stderr.
- A result with `is_error` fails the claude lane itself. The error names the credential.
- Docs: the four consult skill copies plus both `resources/commands/consult.md` copies. The
  reference used to say codex auth is `OPENAI_API_KEY`, which is wrong; corrected to `CODEX_API_KEY`.

Regression test `consult/__tests__/bugfix-1754-dotenv-auth.test.ts`: 6/7 fail on unfixed code.
The seventh guards that a real success still writes its review. Full suite: 309 files / 6203 tests
pass.

E2E on the same scratch workspace (bogus OAuth token in `.env`), unfixed main dist vs fixed build:
- Unfixed: 178s, no auth line, exit 1 via the SDK's rethrow.
- Fixed: 189s, `[CLAUDE] auth: CLAUDE_CODE_OAUTH_TOKEN (from .env)`, exit 1, stale output removed,
  error names the credential.

**Surprise:** the ~3-minute duration is the bundled CLI retrying a 401 by itself, not consult.
My first fixed rerun looked like a hang only because I had capped it at 180s.

## PR (2026-09-29)

PR #1755. CMAP iteration 1:
- gemini APPROVE.
- codex COMMENT, non-blocking: the bundled CLI also recognises `CLAUDE_CODE_USE_ANTHROPIC_AWS` and
  `CLAUDE_CODE_USE_MANTLE`. I verified this against the CLI's provider resolver `iq()`, whose order
  is BEDROCK > FOUNDRY > ANTHROPIC_AWS > MANTLE > VERTEX. Fixed in `1fda5d9b0`.
- claude APPROVE. Its tripwire "repository moved" warning was my own codex follow-up commit landing
  mid-review.

Process snag: the first CMAP launch failed in all three lanes with "Multiple projects found". The
worktree carries many `codev/projects/*` dirs, so the builder needs `--project-id bugfix-1754`.

Left out of scope (flagged to the architect): `codev/resources/arch.md` (~line 2001) and
`cloud-instances.md` still list `OPENAI_API_KEY` for codex. The arch.md table is stale overall
(pre-SDK CLI wiring), which is MAINTAIN territory.

## Integration review (2026-09-29)

Architect verdict COMMENT. Both requested changes are in `c8441cf83`:
- `sdkResult` is now assigned before the `is_error` throw, so metrics keep the tokens and cost.
  New test; it fails without that line.
- The auth sentence is now context, not cause: `Credential in use: <VAR> (from …)`.

Declined the optional change (return the key set from `loadDotenv` instead of a module-global):
threading it through the dispatcher and both exported runners would be churn only for tests.
Full suite: 309 files / 6204 tests pass.
