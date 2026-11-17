# Specification: Run consult's claude lane through the installed `claude` CLI, on the user's subscription

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
-->

## Problem Statement

`consult -m claude` runs on `@anthropic-ai/claude-agent-sdk` (since Spec 0103). That costs us in two ways, and both have come back more than once.

1. **Version drift breaks the lane.** The SDK ships its own copy of the Claude Code CLI and runs that copy, never the `claude` the user installed. When the bundled copy is older than the model, the lane fails even though the user's own `claude` works. Issue #1906: the lockfile resolved SDK 0.2.105, which bundles Claude Code 2.1.105. That CLI sends `thinking.type.enabled` to `claude-opus-5`, and the API answers 400, so builders could not run the claude lane from a worktree build. PR #1907 tried to fix it by raising the SDK floor. The owner closed it unmerged in favour of this issue, so that fix does not exist.
2. **Billing surprises.** The SDK's subprocess uses `ANTHROPIC_API_KEY` ahead of the stored subscription login. Bugfix #985 strips the key only when `CLAUDE_CODE_OAUTH_TOKEN` is also set. In the common case (a workspace `.env` holding `ANTHROPIC_API_KEY` for app code, with the reviewer signed in to `claude` through the keychain) the lane still bills metered API tokens. Nothing visible says so beyond an auth line most people don't read.

The owner ruled on 2026-11-17: stop using the Agent SDK, call the `claude` command-line tool, and have it use the subscription for most people.

Who is affected: everyone who runs CMAP or porch consultations. That includes every builder, since porch runs `consult -m claude` at every review phase. Adopters with `.env` API keys are affected too, as are builders dogfooding a branch's own consult.

## Current State

- `runClaudeConsultation` in `packages/codev/src/commands/consult/index.ts` calls the SDK's `query()` with:
  - `systemPrompt: role`
  - `allowedTools: ['Read','Glob','Grep']`
  - `permissionMode: 'bypassPermissions'`
  - `maxTurns: 200`, `maxBudgetUsd: 25`
  - `model: <resolved id>`, `cwd: workspaceRoot`
  - an `env` copied from `process.env`

  Assistant text blocks are streamed to stdout and collected. On a successful `result` the collected text is written to `--output`. The `result` also supplies tokens and cost for the `consultation_metrics` row.
- **Auth today** (`buildClaudeConsultEnv`): `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are stripped *only if* `CLAUDE_CODE_OAUTH_TOKEN` is present. `consult` loads `<workspace>/.env` into `process.env` for any key the shell has not set, credentials included. `describeClaudeAuth` logs `[CLAUDE] auth: <credential> (from .env|shell)` (#1754). A probe of the installed CLI confirms the problem: `ANTHROPIC_API_KEY=… claude auth status` reports `"authMethod": "api_key"` even when a Max subscription login is stored. An API key in the environment silently takes over billing.
- **Nested-session guard:** the lane deletes `CLAUDECODE` from the *global* `process.env` around the SDK call and restores it afterwards. No other Claude Code session marker is removed, even though `lib/agent-env.ts` (#1219) already maintains the canonical marker list.
- **Read-only today relies on instructions, not restrictions.** With `bypassPermissions`, `allowedTools` only pre-approves tools and does not restrict them. The lane *can* call `Edit`/`Write`/`Bash`. #1649 answered that with an instruction in `consultant.md` and a working-tree tripwire around every lane. The opt-in e2e test measured six write-tool calls from the old role on a tempting prompt.
- **Isolation today:** with `settingSources` omitted, the SDK runs in its documented "isolation mode". No user, project or local settings load, so the reviewer gets none of the user's hooks, plugins, MCP servers, settings `env` blocks or CLAUDE.md.
- **Other SDK importers:** `codev doctor` (`verifyClaudeViaSDK`) makes a live "Reply OK" model call through the SDK. It also hard-codes the "Claude" dependency row as `ok: Agent SDK`, because the SDK is "always available as a dependency". No other production code imports the SDK; `persona` and `dev:local` do not, contrary to an old comment in `buildClaudeConsultEnv`. Five test files mock the SDK. One opt-in e2e test (`consult-readonly-review.e2e.test.ts`, gated by `CODEV_ALLOW_REAL_CLAUDE_SDK`) drives the real SDK.
- **Shell instructions in the reviewer's text.** The PR prompt ("use the Read tool or `cat`"), the impl and integration prompts ("use `git diff <base>...HEAD`") and the shared `consultant.md` ("read-only commands are fine — `git log`, `git diff`, …") assume a shell. Today's claude lane has one in practice (see above), and so do the codex and gemini lanes.
- **"Prompt is too long" (#1641):** large implementation reviews have failed mid-run. The reviewer reads every changed file, and a request crosses the window the bundled CLI budgets for `claude-opus-5` (200k). The fix that defaults the lane to `claude-opus-5[1m]` is open as PR #1657, which also teaches the model-id validator the `[1m]` suffix.
- **Docs that describe the SDK:**
  - `CLAUDE.md` / `AGENTS.md` ("Claude Opus 5 via the Agent SDK")
  - the `consult` skill in four trees (`.claude/`, `.codex/`, `codev-skeleton/.claude/`, `codev-skeleton/.codex/`)
  - the `codev` skill's doctor description in the same four trees
  - `codev/resources/commands/consult.md` and its skeleton twin (lane table, prerequisites, the "subscription vs. metered API" section)

## Desired State

- `consult -m claude` runs **the user's installed `claude` CLI** in non-interactive print mode. Upgrading `claude` upgrades the lane, and there is no bundled CLI to drift.
- **Subscription by default.** The child process never sees `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, whether the key came from the shell or from `.env`, unless Codev config explicitly opts into API-key billing. The opt-in is honoured from any config layer, like every other `consult.*` key, and the auth line names the file that set it. With the opt-in, those keys pass through and are required.
- Every run logs one line naming the auth in use, so nobody has to guess what they are paying with. If a key was present and withheld, the line says so and names the opt-in.
- **Fail fast, no fallbacks.** The lane fails loudly and says what to do when:
  - `claude` is missing
  - it is older than the supported floor
  - it reports no login
  - API-key mode is configured but no key is set
  - the run ends in an error result

  It never retries through the SDK or an API key. As with every lane today, a failure leaves no `--output` file, removes a stale one, and records a metrics row with exit code 1.
- **Read-only by restriction, not just instruction.** The reviewer session *has* only Read, Glob and Grep. Write, edit, shell, web and MCP tools do not exist in it, which is stronger than today. Turn cap (200) and budget cap ($25) carry over; the CLI supports both in print mode.
- **Isolated like today.** The reviewer loads none of the user's or project's settings files, hooks, plugins, MCP servers or CLAUDE.md, matching the SDK's isolation mode. Its sessions are not persisted, so hundreds of review runs do not flood `claude --resume`.
- **Works from inside a Claude Code session** (the normal case). Claude Code session markers are removed from the *child's* environment. `consult`'s own `process.env` is never modified.
- **Callers see no other change:**
  - model selection (shipped default `claude-opus-5`, then `consult.models.claude`, then `--model-id`)
  - `--output`
  - the VERDICT block, which is still whatever the reviewer writes, saved verbatim
  - stdout streaming of the review text
  - `consultation_metrics` rows (duration, input/cached/output tokens, cost, exit code, model id), taken from the CLI's structured result
- `@anthropic-ai/claude-agent-sdk` is gone from `packages/codev`'s dependencies and from the lockfile. No code imports it.
- `codev doctor` checks the installed `claude`:
  - it is present
  - its version is at or above the floor
  - it is logged in, and which auth method it reports

  It makes no model call, matching how doctor checks codex (`codex login status`).
- The docs say "installed `claude` CLI" and document the auth opt-in, in every tree they ship in.

## Success Criteria

- [ ] `consult -m claude` spawns the resolved `claude` binary in print mode with streaming JSON output. No file in `packages/codev/src` imports `@anthropic-ai/claude-agent-sdk`. The dependency is removed from `packages/codev/package.json` and `pnpm-lock.yaml`.
- [ ] By default, the child env contains neither `ANTHROPIC_API_KEY` nor `ANTHROPIC_AUTH_TOKEN`. This holds when they are set in the shell, in `.env`, or both, and whether or not `CLAUDE_CODE_OAUTH_TOKEN` is set. Verified with a stub `claude` that records its env.
- [ ] With the opt-in set to API-key billing, both keys reach the child unchanged. If neither is set, the lane fails before spawning the review and names both variables and the config key.
- [ ] Every run whose `claude auth status` preflight parses prints exactly one `[CLAUDE] auth: …` line. It names:
  - the auth method the CLI reports (`authMethod`, plus `apiKeySource` when present)
  - the credential variable and its origin (shell or `.env`), when one is in use
  - any key that was withheld, with the opt-in that would use it
  - in `api-key` mode, the config file that set `consult.claudeAuth`

  It never prints email addresses, org names or credential values. A run that fails *before* auth can be determined (binary missing, version too old or unparseable, `api-key` mode with no key, auth status unparseable) prints no auth line; its failure message is the explanation. Tests assert both halves.
- [ ] Each failure exits non-zero with an actionable message: `claude` not found, version below the floor, unparseable `--version`, `claude auth status` reporting `loggedIn: false`, and unparseable auth status. Each also writes no `--output`, removes a stale `--output`, and records a metrics row with exit code 1. No path falls back to the SDK or to an API key.
- [ ] The child session's tools are exactly Read, Glob and Grep. No MCP servers, no settings sources, no slash commands or skills, no session persistence. The turn cap is 200 and the budget cap is $25. Verified from the stub's recorded argv.
- [ ] The claude lane's system prompt is the consultant role plus a claude-lane-only **capability note**. The note says the session's only tools are Read, Glob and Grep, that there is no shell, and that wherever the role or prompt mentions a shell command (`cat`, `git diff`, `git log`, `git show`, `git status`, `ls`, `grep`) the reviewer uses Read/Glob/Grep or the files consult provides instead. The shared `consultant.md` is unchanged, because the codex and gemini lanes do have a shell. Verified from the stub's recorded system prompt.
- [ ] Nothing in the run blocks on a permission prompt. The reviewer can read the workspace and consult's own temp artifacts, for example the PR diff file for `--type pr`/`integration`.
- [ ] The prompt and role never travel on argv. Prompts above today's 100 KB inline threshold work, verified with a large prompt against the stub. Any temp file the lane writes (for example the role, when it goes to the CLI as a file):
  - is mode `0600`
  - lives in consult's private per-process sandbox directory, the one the reviewer is already granted
  - is removed on success, on failure and on SIGINT/SIGTERM
- [ ] If `consult` receives SIGINT or SIGTERM while the review child runs:
  - the child is terminated, not orphaned
  - no `--output` is written and a stale one is removed
  - consult exits non-zero

  A metrics row is *not* required for a signal-killed run (parity with the other lanes, which record none). Every other failure still records one.
- [ ] No Claude Code session marker (the `lib/agent-env.ts` list, `CLAUDECODE` included) reaches the child. `process.env` is identical before and after the lane runs.
- [ ] The resolved model id reaches the child as its model argument and is recorded as the metrics `model_id`. The precedence is: shipped default, then `consult.models.claude`, then `--model-id`. A rejected id still gets the existing provenance annotation.
- [ ] A successful run writes the concatenated assistant text to `--output`, byte-for-byte what was streamed to stdout. The text contains the reviewer's VERDICT block unchanged.
- [ ] The metrics row's tokens and cost come from the final `result` event: `usage.input_tokens`, `usage.cache_read_input_tokens`, `usage.output_tokens`, `total_cost_usd`. A failed run records whatever usage its result event carried, or nulls if there was none.
- [ ] Each failed review run maps to a distinct, clear failure:
  - an error result (`is_error: true`, e.g. a usage limit or an invalid credential), whose message names the credential in use
  - an error subtype (`error_max_turns`, `error_max_budget_usd`, `error_during_execution`)
  - a non-zero exit with no result event, reported with its exit code and a bounded stderr tail
  - exit 0 with no result event
  - a non-JSON stdout line
- [ ] A "Prompt is too long" result fails with a message that names context exhaustion, the model id, and #1641. It does not retry.
- [ ] Under a test runner, the lane refuses to resolve an unpinned `claude`, mirroring the agy guard (#1323). The unit suite never executes the real `claude` and makes no model call.
- [ ] `codev doctor` shows the installed `claude` version, its login state and auth method. It warns when `claude` is missing, below the floor, or not logged in. It makes no model call and does not import the SDK.
- [ ] Every doc listed under Current State says "installed `claude` CLI" and documents the auth opt-in. No shipped doc still says the claude lane uses the Agent SDK. Twins stay twins: `CLAUDE.md` = `AGENTS.md`, and `codev/` and `codev-skeleton/` copies match.
- [ ] One live `consult -m claude` review completes from this worktree's build on the subscription, and the PR shows its `[CLAUDE] auth:` line.

## Constraints

### Baked Decisions (architect, on the owner's ruling), verbatim from issue #1912

1. The claude lane invokes the user's installed `claude` CLI in non-interactive print mode. The Agent SDK dependency is removed from `packages/codev` once nothing else imports it (check `persona`, `dev:local` and any other caller first; if another caller needs it, say so before removing).
2. **Subscription by default.** The lane uses the CLI's own login. `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from the environment or `.env` must not reach the child process by default, so a stray key cannot silently switch billing to API tokens. API-key billing is available only as an explicit opt-in in `.codev/config.json` (for CI and key-only environments). The lane logs which auth it is using, as today.
3. Fail fast, no fallbacks: if `claude` is missing, too old, or not logged in, the lane fails loudly with what to do. It never falls back to the SDK or to an API key.
4. Reviewer stays read-only: the same tool allowance as today (Read, Glob, Grep), no edits, no shell. Keep the turn cap and a cost or budget cap if the CLI supports one; if it does not, say so in the spec.
5. Keep what callers rely on: model selection and the per-lane model override, `--output`, the VERDICT format, and `consultation_metrics` rows (duration, tokens, cost, exit code, model id) taken from the CLI's structured output.
6. Handle the nested-session guard (`CLAUDECODE` and related env) so the lane works when consult is run from inside a Claude Code session, which is the normal case.
7. `codev doctor`, the consult skill and CLAUDE.md/AGENTS.md wording are updated in every tree they ship in.

On Baked Decision 1, the caller check is done. `persona` and `dev:local` do not import the SDK. The only production importers are `commands/consult/index.ts` and `commands/doctor.ts`, and both move to the CLI in this spec. On Baked Decision 4, the CLI supports both caps: `--max-turns` and `--max-budget-usd`, the latter in print mode only. Both are present in 2.1.105, the oldest CLI examined.

### Other constraints

- **The user's machine-load rule:** while iterating, run only the test files you touch. Run the full suite once per porch check. No synthetic load and no local e2e suite.
- **Unit tests make no live model calls.** The live check is the one review run named in Success Criteria.
- **Server/client isolation (#1189)** is unaffected. All of this lives in `packages/codev`.
- **The working-tree tripwire (#1649)** stays wrapped around every lane, unchanged.
- **Two trees.** Every framework doc change is mirrored in `codev/` and `codev-skeleton/`, and `CLAUDE.md` stays byte-identical to `AGENTS.md`.
- **The CLI is an external contract we don't control.** We depend only on:
  - flags that are in `claude --help`, or verified present in both the floor version and the current version. Two used flags are hidden from 2.1.326's `--help`, `--max-turns` and `--system-prompt-file`; both are present in 2.1.105 and 2.1.326.
  - the `auth status --json` fields `loggedIn` / `authMethod` / `apiProvider` / `subscriptionType` / `apiKeySource`
  - the stream-json `assistant` / `result` event shapes

  An unexpected shape fails loudly instead of being guessed at.

## Assumptions

- The CLI's `--output-format stream-json` events are the same protocol the SDK parses today: `assistant` messages with text content blocks, and a final `result` with `subtype`, `is_error`, `result`, `usage`, `total_cost_usd`. The SDK is a thin wrapper over exactly this stream.
- In print mode, stream-json output requires `--verbose`. stdout carries only JSON lines and diagnostics go to stderr. The lane hard-fails on a non-JSON stdout line, so the plan must confirm this empirically on the live run, with `--verbose` and the lane's exact argv, before the hard fail is locked in. If the live run shows non-JSON lines on stdout, that is a blocker to raise, not a reason to start skipping lines quietly.
- `claude auth status --json` makes no network or model call (measured at about 0.18 s). It exits 1 when logged out. It does **not** validate a token server-side: a fake `CLAUDE_CODE_OAUTH_TOKEN` reports `loggedIn: true`. An expired or invalid credential therefore surfaces only as an error result during the run, which the lane already treats as a loud failure.
- With no settings sources loaded, the stored login (keychain or credentials file) still works. Auth is not a settings-file concern. Only `apiKeyHelper` / settings-`env` setups lose their effect, and they already lack it under today's SDK isolation.
- Concurrent review children are independent. A CMAP round runs three lanes at once, and several builders consult in parallel. Each claude child has no session persistence and loads no settings files, so it writes no shared state. What children share is a read of the credential store, and running many concurrent `claude` processes on one login is routine for Claude Code users. Today's SDK lane already runs the same CLI concurrently.
- `claude` is on `PATH` wherever consult runs, since builders and architects run `claude` themselves. The rare exception sets an explicit binary pin.
- No other open work changes `runClaudeConsultation`, apart from PR #1657 (#1641, the `[1m]` default). Whichever lands second rebases. This spec neither depends on PR #1657 nor absorbs it.

## Solution Approaches

### Approach 1: Spawn the installed `claude -p` with streaming JSON (recommended)

consult resolves the user's `claude` and runs three cheap local preflights before the review: `--version` checked against the floor, then `auth status --json`. It then spawns one print-mode session:

- the prompt goes on stdin and the role in place of the default system prompt
- streaming JSON output, parsed line by line
- tools restricted to Read/Glob/Grep, with no settings sources, no MCP servers and no session persistence
- the turn and budget caps, the resolved model, and `cwd` = the workspace
- a child env with session markers removed and, by default, the Anthropic API credentials removed

Assistant text is streamed to stdout and collected. The final `result` drives success or failure and supplies the metrics.

- **Pros:**
  - Fixes drift for good, because the lane runs whatever `claude` the user keeps current.
  - Every behaviour is visible in an argv and env that a stub can record, so it is testable without a model.
  - Read-only becomes a property of the session, not of the prompt.
  - Removes a large dependency (the SDK bundles a whole CLI plus native binaries).
- **Cons:**
  - We now own a subprocess lifecycle: spawn errors, signals, exit codes, partial output.
  - We depend on the CLI's flag and stream-format stability across versions, mitigated by the floor and by failing loudly on unexpected output.
- **Risk / complexity:** medium. The protocol is the one the SDK already speaks, and the agy and hermes lanes already show the subprocess pattern in this file.

### Approach 2: Keep the SDK but point it at the installed CLI (`pathToClaudeCodeExecutable`)

The SDK can run an external CLI instead of its bundled one, which would fix the version drift with a smaller diff.

- **Pros:** smallest change; it keeps the SDK's message typing.
- **Cons:**
  - It contradicts Baked Decision 1, which removes the dependency.
  - The SDK's own env handling, entrypoint tagging and option-to-flag mapping stay opaque, and drift between the SDK's flag assumptions and the user's newer CLI becomes a new failure mode.
  - Auth would still need the same scrubbing.
- **Rejected** by Baked Decision 1.

### Approach 3: `claude -p --output-format json` (one result object at exit)

Same as Approach 1, but the output is read as a single JSON object at the end.

- **Pros:** simpler parsing.
- **Cons:**
  - Nothing reaches stdout during a review of one to several minutes, which is a regression from today's live streaming that people watch.
  - A run killed mid-way leaves no partial evidence.
  - Some versions' single-result output carries less per-message detail.
- **Rejected** to keep streaming parity.

### Approach 4: `claude --bare -p`

`--bare` turns off hooks, plugins, CLAUDE.md discovery, auto-memory and keychain reads in one flag.

- **Cons:** `--bare` makes Anthropic auth *strictly* `ANTHROPIC_API_KEY` or `apiKeyHelper`, and never reads OAuth or the keychain. That is the opposite of Baked Decision 2.
- **Rejected.** Isolation comes from the narrower controls in Approach 1 instead.

### Approach 5: Plain-text output (`--output-format text`)

- **Cons:** no usage or cost, which breaks Baked Decision 5's metrics.
- **Rejected.**

**Recommendation: Approach 1.**

### Design decisions within Approach 1

These are settled here so the plan doesn't re-decide them.

- **Binary resolution.**
  - `CODEV_CLAUDE_BIN`, if set, names the binary, mirroring `CODEV_AGY_BIN`. It serves the test harness and anyone whose `claude` isn't on `PATH`.
  - Otherwise `claude` is resolved on `PATH`. Nothing else is searched.
  - A pinned path that does not run is an error, not a reason to try `PATH`.
  - Under a test runner, an unpinned lookup throws unless the real-claude opt-in is set, mirroring `assertAgyLaneAllowedUnderTest` (#1323). The existing `CODEV_ALLOW_REAL_CLAUDE_SDK` opt-in is renamed to `CODEV_ALLOW_REAL_CLAUDE`, since nothing drives the SDK any more.
  - No `consult.claudePath` config key. The codex lane needed `codexPath` because its SDK bundles codex. Here the default already *is* the user's binary, and one override mechanism is enough.
- **Minimum version: 2.1.141**, checked by parsing `claude --version` (`2.1.326 (Claude Code)` → `2.1.326`) on every run, which takes about 40 ms.
  - Why 2.1.141: it is the oldest CLI verified to run the shipped default `claude-opus-5` on both auth paths (PR #1907's matrix). 2.1.105 returned 400 on the API-key path only; stored login worked. 2.1.105 would therefore serve most `login`-mode users, but `api-key` mode needs 2.1.141, and one floor for both modes is simpler than a per-mode floor.
  - Every flag and subcommand the lane uses is present in 2.1.105 already, so model compatibility is what sets the floor.
  - Below the floor or unparseable: fail with "run `claude update`".
  - The floor is a single named constant, so raising it later is a one-line change.
- **Auth modes.** A new config key, `consult.claudeAuth`, is an enum rather than a boolean, so a third mode can be added later. Its values are `"login"` (default) and `"api-key"`.
  - **`login`:** the CLI's own login, which is the subscription for most people.
    - `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed from the child env.
    - `CLAUDE_CODE_OAUTH_TOKEN` (a `claude setup-token` subscription token) passes through, because it is a CLI login mechanism, not API billing.
    - Cloud-provider switches (`CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` / …) and routing variables (`ANTHROPIC_BASE_URL`, proxies) also pass through. They are explicit enterprise configuration, and silently dropping configuration is the #985/#1219 scar.
    - The value is named `login` rather than `subscription` because a stored Console login, or a provider switch, is still "the CLI's own login" but not a claude.ai subscription. The docs say "your subscription, for most people".
  - **`api-key`:** `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` pass through. At least one must be set, from the shell or `.env`, or the lane fails before spawning.
  - The key is validated at config load: an unknown value is an error naming the valid values.
  - **Which config layers count.** Every layer counts, like every other `consult.*` key: global `~/.codev/config.json`, project `.codev/config.json`, local `.codev/config.local.json`, and the remote base config. That is deliberate.
    - CI usually opts in through committed project config.
    - A key-only personal machine opts in once, globally.
    - Restricting the source would make this the only key with source-aware semantics.

    The guard against a surprise opt-in is visibility: in `api-key` mode the auth line names the file that set `consult.claudeAuth`, on every run.
- **Login preflight.**
  - `claude auth status --json` runs with the *child's* env, so it reports exactly what the review will use.
  - `loggedIn: false` fails with "run `claude auth login`".
  - Unparseable output fails loudly.
  - Its `authMethod`, `apiProvider` and `subscriptionType` feed the auth line. Its `email` and `orgName` are never logged.
- **The auth line,** for example:
  - `[CLAUDE] auth: claude.ai login (max) — stored claude login`
  - `[CLAUDE] auth: oauth_token — CLAUDE_CODE_OAUTH_TOKEN (from .env)`
  - `[CLAUDE] auth: api_key (ANTHROPIC_API_KEY) — ANTHROPIC_API_KEY (from shell), consult.claudeAuth="api-key" in /repo/.codev/config.json`

  When a key was withheld, it adds: `; ignoring ANTHROPIC_API_KEY (from .env) — set consult.claudeAuth to "api-key" to bill the API instead`. The exact format is the plan's call, but the content above is required.
- **Binary line,** mirroring codex: `[CLAUDE] binary: /path/to/claude, 2.1.326`.
- **Session markers.** Every name `isClaudeSessionMarker` matches from `lib/agent-env.ts` is removed from the child env. Reusing that list means a marker added upstream is fixed in one place for Tower and consult alike. The lane stops mutating global `process.env`.
- **Read-only and non-blocking.**
  - The CLI's tool-availability restriction leaves only Read/Glob/Grep in the session. Pre-approval alone, today's `allowedTools`, does not restrict.
  - No permission prompt may block: print mode has no human.
  - Reads must reach the workspace and consult's temp sandbox directory, where the PR diff and large-prompt files live.
  - The plan picks the permission mode and directory grants that meet this. It prefers to avoid `bypassPermissions` when a narrower mode meets the read requirement, and it must verify the PR-diff read on the live run.
- **Capability note for the claude lane.** The hard tool restriction removes Bash, which today's lane has in practice. Five places tell the reviewer to use a shell:
  - the PR prompt: "use the Read tool or `cat`"
  - the impl and integration prompts: "if you compute a diff yourself, use `git diff <base>...HEAD`"
  - `consultant.md`: "optionally use `git diff`", and "read-only commands are fine — `git log`, `git diff`, …"

  `consultant.md` is shared with the codex and gemini lanes, which keep a shell, so it is not edited. Only the claude lane's system prompt gets a short appended note. The note says the session has only Read, Glob and Grep, has no shell, and should treat any shell command in the instructions as unavailable, reading files directly instead (the role already calls diffs a secondary source, and PR diffs arrive as files). This loses `git diff`/`git log` for the claude reviewer. That loss is what Baked Decision 4's "no shell" means, and it is small: impl reviews give the changed-file list and PR reviews give the diff file. Baked Decision 4 rules out restoring a git-only shell allowance.
- **Isolation.** No settings sources (user/project/local), no MCP servers beyond an empty explicit set, slash commands and skills disabled, no session persistence. This matches the SDK's isolation mode today, so hooks, plugins, CLAUDE.md and the settings `env`/`apiKeyHelper` do not load.
- **Prompt transport.** The prompt goes over stdin and the role through the CLI's system-prompt mechanism, without the role on argv (a file in consult's private sandbox dir is fine). This avoids `E2BIG` and keeps review content out of `ps`.
- **"Prompt is too long" (#1641).** The installed CLI knows current models' context windows and auto-compacts in print mode, so this should be rarer than under the stale bundled CLI. When it still happens, the lane fails loudly and does not retry, because retrying would be a hidden fallback. The message says the reviewer's context filled while reading files, names the model id, and points to #1641 for the larger-context default. Absorbing #1641's `[1m]` default and validator change is out of scope; it stays with PR #1657.
- **Process lifecycle.**
  - A spawn error such as `ENOENT` or `EACCES` is a loud failure naming the binary.
  - stderr is captured with a bounded tail, about 2 KB as for agy, and that tail appears in the failure message for a non-zero exit.
  - If `consult` receives SIGINT or SIGTERM, the child is terminated, not orphaned. Stale output is removed and lane temp files are deleted; see Success Criteria.
  - There is no new wall-clock timeout, which is parity with today: the turn and budget caps bound the run.
- **Doctor.**
  - The "Claude" dependency row becomes a real presence and version check against the floor, with the install hint `curl -fsSL https://claude.ai/install.sh | bash`.
  - The verification row becomes `claude auth status`: logged in, plus auth method. It runs with the same env the lane would build, so doctor tells the truth about withheld keys.
  - There is no model call. Doctor's existing "Set ANTHROPIC_API_KEY or run: claude /login" hints change to "run `claude auth login`". Under `login` mode an API key would not be used, so suggesting one would be wrong.

## Open Questions

### Critical (blocks progress)

- None. All of the issue's open questions are answered above:
  - minimum version and how it is checked: 2.1.141, via `--version` on every run
  - "Prompt is too long": a loud, classified failure with no retry; the `[1m]` default stays with PR #1657
  - PR #1907: superseded, closed unmerged, and not depended on

### Important (shapes design)

1. **`CLAUDE_CODE_OAUTH_TOKEN` passes through in `login` mode.** It is a subscription credential, so this follows Baked Decision 2. It also means a `.env` token for a *different* org still outranks the keychain login (#1754). The auth line names it, as it does today. If the architect wants `login` mode to mean "keychain only", this flips to stripping it.
2. **Cloud-provider switches pass through in `login` mode.** An adopter with `CLAUDE_CODE_USE_VERTEX=1` keeps getting Vertex billing instead of a forced subscription. This reads "the CLI's own login" as "the CLI's own configured auth".
3. **This is a breaking change for key-only environments** (CI with only `ANTHROPIC_API_KEY`). They fail loudly until they set `consult.claudeAuth: "api-key"`. That is what Baked Decision 2 asks for. The release notes and the error message must make the fix one line.

### Nice-to-know (optimization)

- Whether disabling settings sources also suppresses auto-memory in every CLI version at or above the floor. The plan verifies it on the live run; it does not affect correctness of reviews.
- Whether a few dozen milliseconds of preflight per run is worth caching across a CMAP burst. Not worth it now: the agy cache exists because agy opens browser tabs, and `claude auth status` does not.

## Test Scenarios

All unit scenarios run against a **stub `claude` executable**: a small script pinned via `CODEV_CLAUDE_BIN`. It records argv, env and stdin to a file and replays canned stdout, stderr and an exit code per scenario. The canned stream-json is captured from a real CLI run so it matches the real shapes.

**Argument construction**

1. Default run: the argv shows
   - print mode, streaming JSON, the tool restriction to exactly Read/Glob/Grep
   - no settings sources, the MCP lockout, no session persistence
   - `--max-turns 200`, `--max-budget-usd 25`
   - `--model claude-opus-5`
   - the role delivered as a system prompt, not on argv
   - `cwd` = the workspace
   - the prompt arriving on stdin
2. `consult.models.claude` set, then `--model-id` set: argv carries the right id, and metrics record it.
3. A prompt over 100 KB arrives intact on stdin, and argv stays small.
3a. The recorded system prompt is the consultant role followed by the capability note. The role text itself is unmodified.
3b. Any role temp file is `0600`, inside consult's sandbox dir, and gone after success and after failure.

**Env scrubbing**

4. `ANTHROPIC_API_KEY` in the shell only → absent from the child; the auth line notes it was ignored, from the shell.
5. `ANTHROPIC_API_KEY` in `.env` only → absent; the line says "from .env".
6. `ANTHROPIC_AUTH_TOKEN` in both → absent.
7. A key plus `CLAUDE_CODE_OAUTH_TOKEN` → the key is absent and the OAuth token present.
8. `consult.claudeAuth: "api-key"` with a key → the key is present and the line says api-key mode.
9. `consult.claudeAuth: "api-key"` with no key → fails before the review spawn, the message names both variables and the config key, a metrics row records exit 1, and **no** auth line is printed.
9a. `consult.claudeAuth: "api-key"` set only in `.codev/config.local.json` or the global config → honoured, and the auth line names that file.
10. `consult.claudeAuth: "bogus"` → a config-load error listing the valid values.
11. `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_PID` and `CLAUDE_CODE_ENTRYPOINT` set → none reach the child, and `process.env` is unchanged after the run.
12. `CLAUDE_CODE_USE_VERTEX=1` and `ANTHROPIC_BASE_URL` → both pass through.

**Missing or failing CLI**

13. `CODEV_CLAUDE_BIN` pointing at a non-existent or non-executable path → a loud failure naming it, with no `PATH` retry.
14. Unpinned under VITEST → throws the test-isolation error.
15. `--version` prints `2.1.100 (Claude Code)` → fails naming 2.1.141 and `claude update`. Garbage output → fails as unparseable.
16. `auth status` returns `loggedIn: false` → fails with "run `claude auth login`". Non-JSON → fails as unparseable, with no auth line.
16a. Binary missing, or version too old → no auth line is printed.
17. The review exits 1 with stderr and no result → the failure message carries the exit code and stderr tail.
18. The review exits 0 with no result event → fails.
19. A non-JSON stdout line → fails, quoting a bounded excerpt.
20. A result with `is_error: true` ("usage limit reached") → fails naming the credential in use; usage is still recorded.
21. `subtype: error_max_turns` / `error_max_budget_usd` → fails naming the subtype.
22. A result of "Prompt is too long" → the classified context-exhaustion message, naming the model and #1641.
23. Any failure with a stale `--output` file present → the file is removed.
23a. SIGTERM delivered to consult mid-review against a stub that sleeps → the stub child is terminated, there is no `--output`, a stale `--output` is removed, temp files are deleted, and consult exits non-zero.

**Metrics and output**

24. A successful stream with two assistant text blocks and a result carrying usage and cost:
    - stdout equals the concatenated text, and so does the `--output` file
    - the metrics row has the input, cached-input and output tokens, the cost, exit 0, the model id and a duration greater than 0
25. A result without `usage` → token columns are null; the review still succeeds.
26. Unknown event types (`system`, `rate_limit_event`, …) are ignored without error.

**Doctor**

27. A stub `claude` at 2.1.326, logged in → ok, with the version and auth method shown.
28. Missing → a warning with the install hint.
29. Below the floor → a warning with `claude update`.
30. Logged out → a warning with `claude auth login`.
31. No model call is made: the stub records no review-mode invocation.

**Live (manual, once, not in the suite)**

32. From this worktree's build, run `consult -m claude --protocol aspir --type impl` (or a PR review that exercises the diff-file read) on the subscription. It completes, writes a VERDICT, records a metrics row, and its `[CLAUDE] auth:` line is pasted into the PR. The same run confirms two things:
    - stdout carried only JSON lines under the lane's exact argv
    - no user hook or plugin fired in the reviewer
33. The opt-in e2e, renamed to the `CODEV_ALLOW_REAL_CLAUDE` gate, drives the real CLI with the lane's real argv against the tempting fixture. It asserts zero write-tool calls and an unchanged tree. With the tools removed this is now deterministic, but it stays opt-in because it spends tokens.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| A CLI release changes flags or the stream-json shape | Low | High (lane breaks) | Version floor; only documented flags; fail loudly on unexpected output and never guess; stub fixtures captured from a real run; the live run in the PR |
| Key-only CI or adopters break on upgrade | Medium | Medium | The error names the one-line opt-in; release notes call it out; doctor shows it |
| Isolation flags miss something (a user hook or plugin still loads in the reviewer) | Low | Low–Medium | The tool restriction is the hard read-only guarantee whatever loads; the live run checks; the #1649 tripwire still wraps the lane |
| The reviewer follows a shell instruction it can no longer execute and quietly reviews less | Medium | Medium | The claude-lane capability note (Success Criteria); the shared role is left alone for the lanes that have a shell |
| A future CLI prints a non-JSON line to stdout under `--verbose`, failing every review | Low | High | Confirmed JSON-only on the live run; the failure quotes the line, so the cause is obvious and the fix (a version floor bump or a parser change) is a deliberate decision |
| Reads outside the workspace (the PR diff) are denied in non-interactive mode, so PR reviews run blind | Medium | High | An explicit success criterion; the plan must grant consult's sandbox dir; the live run exercises a PR or diff read |
| `auth status` says logged in but the token is expired or invalid | Medium | Low | The run fails loudly through the error-result path, naming the credential (existing behaviour, kept) |
| `claude` is not on `PATH` in some launch context (cron, a minimal Tower env) | Low | Medium | The error names `CODEV_CLAUDE_BIN`; doctor shows what was resolved |
| Subscription usage limits hit during CMAP bursts | Medium | Low | Already a loud error result today; out of scope |
| "Prompt is too long" persists on huge PRs | Low–Medium | Medium | A classified, loud failure pointing at #1641; PR #1657 owns the larger-window default |
| Conflict with PR #1657 in `runClaudeConsultation` | Medium | Low | Second to land rebases; the scopes are disjoint (default id and validator vs. transport) |
| An orphaned `claude` child when consult is killed | Low | Low | Child termination on SIGINT/SIGTERM is a requirement |

## References

- Issue #1912 (this work), with the Baked Decisions above
- Issue #1906 and PR #1907 (closed unmerged; superseded): the bundled-CLI version drift
- Issue #1641 and PR #1657 (open): "Prompt is too long" and the `[1m]` default
- Bugfix #985: stripping the API key when an OAuth token is present
- #1754: the `.env` credential origin in the auth line
- #1219: `lib/agent-env.ts`, the canonical Claude Code session-marker list
- #1323: test-runner isolation guard (`lib/test-env.ts`)
- #1649: the read-only consultant role and the working-tree tripwire
- #1880: the codex lane's binary line and `codexPath`, the precedent for reporting which binary ran
- Spec 0103 (consult on the Claude Agent SDK), the design being reversed
- Spec 1286: per-lane model configuration and `--model-id`
- `claude --help` and `claude auth status --help` for CLI 2.1.326; flag presence checked in 2.1.105
