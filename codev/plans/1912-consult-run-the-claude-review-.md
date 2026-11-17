# Plan: Run consult's claude lane through the installed `claude` CLI, on the user's subscription

**Specification**: [codev/specs/1912-consult-run-the-claude-review-.md](../specs/1912-consult-run-the-claude-review-.md)

## Executive Summary

This implements the spec's **Approach 1**. The claude lane spawns the user's installed `claude` in print mode with `--output-format stream-json`.

- **Before the review:** three local preflights run in order: binary resolution, the `--version` floor, then `auth status --json`.
- **The child process:**
  - its environment has the Claude Code session markers removed, and also the Anthropic API credentials unless `consult.claudeAuth` is `"api-key"`
  - only Read, Glob and Grep exist in the session
  - no settings, MCP servers, slash commands or session persistence load
  - the prompt goes in on stdin, and the role plus a claude-lane-only capability note goes in as a `0600` system-prompt file in consult's sandbox dir
- **Output and metrics:** assistant text streams to stdout and is collected for `--output`. The final `result` event decides success or failure and supplies the metrics.
- **Doctor** moves to the same CLI helpers. The Agent SDK dependency is then removed.

The work splits along the natural seams:

1. Pure, stub-testable CLI primitives in a new `lib/claude-cli.ts`, shared by consult and doctor.
2. The consult lane rewritten onto those primitives.
3. Doctor moved onto them, and the SDK dependency deleted.
4. Docs in every tree.

Each phase is one commit and leaves the build and the touched tests green. The SDK keeps working until Phase 3 removes it, so no phase leaves consult broken.

**The machine-load rule applies throughout.** While iterating, run only the test files a phase touches, e.g. `pnpm --filter @cluesmith/codev exec vitest run <files>`. Run the full suite only when porch runs its checks. Never run synthetic load or the local e2e suite.

**Worktree setup before Phase 1:** run `pnpm install` in the worktree, which currently has no `node_modules`, and confirm `pnpm --filter @cluesmith/codev build` passes on the untouched branch, so a later failure is attributable.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Claude CLI primitives and config"},
    {"id": "phase_2", "title": "Consult claude lane on the installed CLI"},
    {"id": "phase_3", "title": "Doctor on the CLI and Agent SDK removal"},
    {"id": "phase_4", "title": "Docs in every tree"}
  ]
}
```

## Phase Breakdown

### Phase 1: Claude CLI primitives and config

**Dependencies**: None

#### Objective

Build, in isolation, every decision the spec makes *before* a review is spawned:

- which binary runs, and that it meets the version floor
- which auth mode applies, and what the child's environment is
- the auth line
- whether the CLI reports a login

These are pure or stub-driven functions with no consult wiring yet, so they can be tested exhaustively without a model, and both consult and doctor can import them.

#### Files to Create / Modify

- **Create** `packages/codev/src/lib/claude-cli.ts`:
  - `CLAUDE_MIN_VERSION = '2.1.141'`, a single named constant with a comment carrying the spec's rationale: PR #1907's matrix; 2.1.105 got a 400 on the API-key path only.
  - `resolveClaudeBin(): string`.
    - `CODEV_CLAUDE_BIN` wins when set. A pinned path that is missing or not executable throws, naming the path and the variable, and never retries via `PATH`.
    - Otherwise `claude` is looked up on `PATH` with a plain directory walk, without executing anything.
    - Before the `PATH` lookup, call `assertClaudeLaneAllowedUnderTest()`, mirroring `resolveAgyBin`, which guards at resolution, not at spawn.
    - Not found: throw with the install hint (`curl -fsSL https://claude.ai/install.sh | bash`), and mention `CODEV_CLAUDE_BIN`.
  - `readClaudeVersion(bin): string` runs `bin --version` via `execFileSync` with a timeout.
    - It parses the leading `\d+\.\d+\.\d+`; for example, `2.1.326 (Claude Code)` gives `2.1.326`.
    - Unparseable output throws, quoting a bounded excerpt.
    - `assertClaudeVersion(version)` throws below the floor with "run `claude update`".
  - `type ClaudeAuthMode = 'login' | 'api-key'` and `resolveClaudeAuthMode(workspaceRoot): { mode, source }`.
    - The default is `login`.
    - `source` comes from `findConfigSource(workspaceRoot, ['consult','claudeAuth'])`, so the auth line can name the file.
  - `buildClaudeChildEnv(processEnv, mode): { env, withheld: string[] }`. It copies the env, dropping `undefined` values.
    - It drops every key `isClaudeSessionMarker` matches (imported from `lib/agent-env.ts`, not re-listed).
    - In `login` mode it also drops `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`, recording which were present in `withheld`.
    - It never mutates its input.
    - `CLAUDE_CODE_OAUTH_TOKEN`, the provider switches and `ANTHROPIC_BASE_URL`/proxy variables pass through.
  - `assertApiKeyPresent(env, mode)`: in `api-key` mode, throw unless `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set. The message names both variables and `consult.claudeAuth`.
  - `readClaudeAuthStatus(bin, env): ClaudeAuthStatus` runs `bin auth status --json` with the *child* env.
    - It parses JSON and validates `loggedIn` (boolean) and `authMethod` (string). `apiProvider`, `subscriptionType` and `apiKeySource` are optional strings.
    - Exit 1 with parseable JSON reporting `loggedIn: false` is the normal logged-out answer. Treat it as data, not as a crash.
    - Non-JSON output, or a missing or mistyped required field, throws as unparseable, quoting a bounded excerpt.
    - The function never returns or logs `email` / `orgName`.
  - `assertLoggedIn(status)` throws with "run `claude auth login`".
  - `describeClaudeAuth({ status, env, mode, modeSource, withheld, fromDotenv }): string` builds the spec's auth line content:
    - `authMethod`, with `apiKeySource` and `subscriptionType` when present
    - the credential variable in use and its origin, via the existing `credentialOrigin` logic, which moves here and is exported for consult's codex line
    - in `api-key` mode, the config file
    - for each withheld key, `ignoring KEY (from .env|shell) — set consult.claudeAuth to "api-key" to bill the API instead`
  - `preflightClaude({ workspaceRoot, processEnv, fromDotenv })` runs the steps above in the spec's order and returns `{ bin, version, env, status, authLine, binaryLine }`, or throws at the first failure. Order:
    1. resolve
    2. version
    3. auth mode, plus building the env
    4. the api-key check
    5. auth status
    6. the login check

    The auth line is produced only once auth status has parsed, which is the spec's "no auth line on early failures" rule.
- **Modify** `packages/codev/src/lib/test-env.ts`:
  - Add `realClaudeOptIn()` (`CODEV_ALLOW_REAL_CLAUDE`) and `assertClaudeLaneAllowedUnderTest()`, mirroring the agy pair.
  - Rename `realClaudeSdkOptIn` → `realClaudeOptIn` and update its single caller, the e2e test. That test is rewritten in Phase 2; in this phase only the import name changes.
- **Modify** `packages/codev/vitest-setup.ts`: unless `realClaudeOptIn()`, write a fake `claude` into the sandbox and pin `CODEV_CLAUDE_BIN` unconditionally, like `CODEV_AGY_BIN`.
  - It answers `--version` with `2.1.326 (Claude Code)` and `auth status --json` with a logged-in JSON.
  - It answers a print-mode invocation with a minimal successful stream-json transcript: one assistant text block with a `VERDICT: COMMENT` and a result event.
  - This is so existing suites that reach the claude lane in-process, like `consult.test.ts`, run against a stub, not the real CLI.
- **Modify** `packages/codev/src/lib/config.ts`: add `consult.claudeAuth?: 'login' | 'api-key'` to the type, with a doc comment, and add `validateClaudeAuth` beside `validateCodexPath`. An unknown value is an error naming the valid values.
- **Create** `packages/codev/src/__tests__/helpers/stub-claude.ts` (a new helpers dir; it is not a `*.test.ts` file, so vitest does not collect it) as a test helper. It writes a configurable stub `claude` script into a temp dir:
  - The script records argv, env, stdin and cwd to a JSON log.
  - It replays per-mode canned stdout, stderr and an exit code, with separate scripts for `--version`, `auth status` and print mode.
  - It can sleep, for the signal test.
  - All later phases reuse it.
- **Create** `packages/codev/src/__tests__/fixtures/claude-stream-success.jsonl`, plus a few error-shaped variants. These are **captured from a real CLI run** (below) and trimmed, so the stub's shapes are the real shapes.
- **Create** `packages/codev/src/__tests__/claude-cli.test.ts`, where the existing `lib` module tests live.

#### Deliverables

- [ ] `lib/claude-cli.ts` with the functions above
- [ ] `consult.claudeAuth` typed and validated
- [ ] Test-isolation guard, opt-in and harness pin for `claude`
- [ ] Reusable stub-`claude` helper and real-shape fixtures
- [ ] Tests for this phase

#### Fixture capture (one-off, manual, not in the suite)

Run the lane's intended argv once against the real CLI from `/tmp`. Use a trivial prompt ("Reply with the word OK"), `--max-turns 1`, `--max-budget-usd 1` and `--model claude-opus-5`, with stdout and stderr captured to separate files in the scratchpad. This is a single tiny model call on the subscription. From it:

- Copy the `system`, `assistant` and `result` event lines into the fixture.
- **Check that stdout is JSON-only under `--verbose`** with this exact argv. If it is not, stop and raise it with the architect; the spec makes this a blocker, not a parser workaround.
- Record which flags were accepted. An unknown flag makes the CLI error out at parse time, before any model call.

The final argv is constructed in Phase 2. The capture uses that same argv, written out by hand here.

#### Acceptance Criteria

- [ ] `resolveClaudeBin`:
  - a pin wins
  - a bad pin throws without a `PATH` retry
  - an unpinned lookup under VITEST throws the isolation error
  - with the opt-in set and a temp `PATH` dir holding a stub, it resolves that stub
  - no binary anywhere throws the install hint
- [ ] Version: `2.1.326 (Claude Code)` passes, `2.1.141` passes, `2.1.140` fails naming 2.1.141 and `claude update`, garbage fails as unparseable.
- [ ] Env, covering spec scenarios 4–8 and 11–12:
  - in `login` mode the keys are gone whether they came from the shell, `.env` or both, and `withheld` names them
  - the OAuth token, `CLAUDE_CODE_USE_VERTEX` and `ANTHROPIC_BASE_URL` survive
  - the session markers `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_PID` and `CLAUDE_CODE_ENTRYPOINT` are gone
  - the input object is unchanged
  - in `api-key` mode both keys survive
- [ ] `api-key` mode with no key throws, naming both variables and the config key (scenario 9).
- [ ] Auth status (scenario 16): a logged-in JSON parses; `loggedIn: false` throws "run `claude auth login`"; non-JSON and a missing `loggedIn` both throw as unparseable.
- [ ] Auth line:
  - contains `authMethod`, `apiKeySource` when present, and the withheld-key note
  - never contains the stub's `email` / `orgName` values
  - names the config file when `claudeAuth` comes from `.codev/config.local.json` or the global config (scenario 9a; global via a temp `HOME`)
- [ ] `preflightClaude` produces no auth line when it fails before auth status (scenarios 9, 16, 16a).
- [ ] `consult.claudeAuth: "bogus"` → config-load error listing `login`, `api-key` (scenario 10).
- [ ] `pnpm --filter @cluesmith/codev build` passes. The new test file and the existing `claude-auth-env.test.ts` / `bugfix-1754-dotenv-auth.test.ts` pass; they still exercise the old functions, which Phase 2 deletes along with those tests' SDK parts.

#### Test Plan

Unit tests in `claude-cli.test.ts` drive every function with the stub helper and temp dirs for `.env`, config layers and `HOME`. No real `claude` runs. The VITEST guard test unsets the pin within the test and restores it after.

### Phase 2: Consult claude lane on the installed CLI

**Dependencies**: Phase 1

#### Objective

Replace the SDK call in `runClaudeConsultation` with a `claude -p` subprocess built on Phase 1's preflight. Keep every caller-visible behaviour (output, VERDICT text, metrics, model provenance, the tripwire), and add the spec's read-only restriction, isolation, capability note, failure classification and signal handling.

#### Files to Create / Modify

- **Modify** `packages/codev/src/commands/consult/index.ts`:
  - Remove the `@anthropic-ai/claude-agent-sdk` import, `buildClaudeConsultEnv`, the old `describeClaudeAuth` and the global-`process.env` `CLAUDECODE` delete/restore.
  - Move `claude` out of `SDK_MODELS` with a comment update. The model-validation list still accepts it.
  - Add `CLAUDE_CAPABILITY_NOTE`, the spec's capability note, and `buildClaudeReviewArgs({ model, systemPromptFile, sandboxDir })`, exported for tests. It returns:
    - `-p --output-format stream-json --verbose`
    - `--tools Read,Glob,Grep`: availability. `--tools` names the tools that *exist*, unlike `--allowedTools`, which only pre-approves.
    - `--setting-sources ""` and `--strict-mcp-config`, with no `--mcp-config`
    - `--disable-slash-commands` and `--no-session-persistence`
    - `--max-turns 200` and `--max-budget-usd 25`
    - `--model <id>` and `--system-prompt-file <file>`
    - `--add-dir <sandboxDir>`, so the PR diff and large-prompt files are readable
    - the permission flags chosen below
  - **Permission mode.** The spec requires nothing to block on a prompt, reads of the workspace and the sandbox dir to work, and a preference against `bypassPermissions`.
    - **Default plan:** `--permission-mode dontAsk` plus `--allowedTools Read Glob Grep`, with `--tools` as the hard availability limit.
    - **Verification:** with a stub this cannot be proved, so on the live run (below) confirm that a PR-diff file in the sandbox dir is read.
    - **If `dontAsk` denies the sandbox read even with `--add-dir`:** switch to `bypassPermissions` plus `--allow-dangerously-skip-permissions`. This is today's mode and is safe because `--tools` removes every non-read tool. Record the finding in the review.
    - This is the only open implementation choice, and the spec explicitly delegates it to the plan.
  - Rewrite `runClaudeConsultation(queryText, role, workspaceRoot, outputPath?, metricsCtx?, modelChoice?)`. The signature is unchanged, so `dispatchConsultation`, `lane-models` and the other callers are unaffected.
    1. Run `preflightClaude(...)` inside the guarded lifecycle. A preflight failure still goes through `discardStaleOutput` and records a metrics row (exit 1, `errorMessage`) — the codex lane's pattern.
    2. Print `[CLAUDE] binary: <bin>, <version>` and then `[CLAUDE] auth: <line>`.
    3. Write `role + '\n\n' + CLAUDE_CAPABILITY_NOTE` to `consultSandboxDir()/claude-system-prompt-<pid>-<ts>.md` with mode `0o600` and flag `wx`.
    4. `spawn(bin, args, { cwd: workspaceRoot, env, stdio: ['pipe','pipe','pipe'] })`. Write `queryText` to stdin and close it.
    5. Parse stdout line by line, buffering partial lines.
       - Each non-empty line is `JSON.parse`d. A failure is a loud error quoting a bounded excerpt (scenario 19).
       - `assistant` events with text blocks are written to stdout and pushed to `chunks`.
       - The `result` event is stored.
       - Other event types are ignored (scenario 26).
    6. Keep a bounded stderr tail of about 2 KB, like `AGY_FAILURE_TAIL_MAX_CHARS`.
    7. On close, classify:
       - spawn `error` (`ENOENT` / `EACCES`): a loud failure naming the binary
       - a result with `is_error: true`: `Claude returned an error instead of a review: <result>`, plus `Credential in use: <auth line>` (scenario 20). If the text matches "Prompt is too long", use the context-exhaustion message instead, naming the model id and #1641 (scenario 22).
       - `subtype` other than `success`: `Claude CLI error (<subtype>)…` (scenario 21)
       - no result and exit ≠ 0: exit code plus stderr tail (scenario 17)
       - no result and exit 0: "ended without a result" (scenario 18)
    8. On success, write `chunks.join('')` to `--output`.
    9. The `finally` block:
       - unlinks the system-prompt file
       - records metrics from `result.usage` / `total_cost_usd`, null when absent, via the existing `extractUsage`. `SDKResultLike` is renamed to `ClaudeResultLike`, and the comment says the event comes from the CLI's stream-json.
       - keeps `annotateModelError(err, 'claude', choice, binaryLine)` on failure, so a rejected id still gets provenance and the binary in use. This is the codex lane's #1880 pattern.
  - **Signals.**
    - While the child runs, register `SIGINT`/`SIGTERM` handlers: kill the child, unlink the system-prompt file, `discardStaleOutput(outputPath)`, then re-raise or exit with 130/143. No metrics row is recorded, per the spec.
    - Remove the handlers in `finally`, so a normal run leaves no listeners behind.
    - `tree-kill` is already a dependency, but a direct `child.kill('SIGTERM')` is enough, since the child is the CLI process itself.
- **Modify** `packages/codev/src/commands/consult/usage-extractor.ts`: rename the type, and change the comments from "Agent SDK result" to "CLI stream-json result". The logic is unchanged.
- **Delete** `packages/codev/src/commands/consult/__tests__/claude-auth-env.test.ts`. It tests the deleted `buildClaudeConsultEnv`; its #985 cases move into Phase 1's env tests, which already cover them.
- **Modify** the tests that mock the SDK. Remove `vi.mock('@anthropic-ai/claude-agent-sdk')` and drive the stub `claude` instead, via the helper or the harness pin:
  - `src/__tests__/consult.test.ts`: the "Claude Agent SDK integration" describe is rewritten as "Claude CLI integration", keeping the same intent (text streamed, output written, error results fail).
  - `commands/consult/__tests__/bugfix-1754-dotenv-auth.test.ts`: the claude half now asserts the new auth line from `.env`-sourced credentials, with the keys *withheld* in `login` mode. The codex half is unchanged.
  - `commands/consult/__tests__/lane-models.test.ts`: "configured lane models reach the SDK" becomes "…reach the CLI", asserting `--model <id>` in the recorded argv. The provider-rejection test becomes a stub returning an error result.
  - `commands/consult/__tests__/tripwire-wiring.test.ts`: the "lane that writes" cases need a lane that mutates the tree mid-run. The stub script does the mutation itself (for example `git checkout` in its cwd) before emitting its result, which proves the tripwire still wraps the claude lane.
- **Create** `packages/codev/src/commands/consult/__tests__/claude-cli-lane.test.ts`: spec scenarios 1–3, 3a, 3b, 13–26 and 23a against the stub.
- **Rewrite** `packages/codev/src/__tests__/cli/consult-readonly-review.e2e.test.ts`:
  - It drives the real CLI through `runClaudeConsultation` or `buildClaudeReviewArgs`, gated on `realClaudeOptIn()`, against the same tempting fixture.
  - It asserts zero write-tool calls (now structural: the tools don't exist) and an unchanged tree.
  - It is not run in this PR's checks; it is opt-in and e2e.

#### Deliverables

- [ ] The claude lane runs `claude -p`, with no SDK import left in `consult/`
- [ ] Capability note, `0600` system-prompt file, sandbox `--add-dir`
- [ ] Failure classification and context-exhaustion message
- [ ] Signal handling
- [ ] Migrated and new tests

#### Live check for this phase (manual, once)

Build the worktree (`pnpm --filter @cluesmith/codev build`) and run the built consult on the subscription for a PR-type review of a small existing merged PR, so the sandbox diff-file read is exercised: `node packages/codev/dist/cli.js consult -m claude --type pr --issue <small merged PR> --output <scratchpad file>`.

Confirm:

- the `[CLAUDE] binary:` / `[CLAUDE] auth:` lines show the stored login
- the review cites the diff file, which shows the sandbox read worked under the chosen permission mode
- a VERDICT block is present
- a metrics row exists, checked with `consult stats` or sqlite against the real DB, since this is not under VITEST
- no user hook or plugin output appears in stderr

Save the stdout/stderr transcript in the scratchpad for the review document.

#### Acceptance Criteria

- [ ] Recorded argv (scenario 1):
  - exactly the flags above
  - `--tools` is `Read,Glob,Grep`
  - no prompt or role text on argv
  - stdin is the prompt
  - cwd is the workspace
- [ ] Scenario 3: a 150 KB prompt arrives intact on stdin.
- [ ] Scenario 3a: the system-prompt file content is the role followed by the capability note.
- [ ] Scenario 3b: the file is `0600`, inside the sandbox dir, and removed after success and after failure.
- [ ] Scenarios 17–22: each failure yields its distinct message, no `--output`, removal of a stale `--output` (scenario 23) and a metrics row with exit 1. Usage is recorded when the result event carried it (scenario 20).
- [ ] Scenario 24: stdout equals the `--output` content equals the concatenated assistant text; metrics carry tokens, cost, exit 0, model id and duration > 0. Scenario 25: no usage → null token columns, success.
- [ ] Scenario 23a: SIGTERM mid-review against a sleeping stub → the child is dead, there is no output, a stale output is removed, the temp file is gone, the exit is non-zero, and no listeners leak. This test runs consult in a child process so the signal does not hit the vitest worker.
- [ ] `process.env` is deep-equal before and after a run.
- [ ] Model provenance (scenario 2): `consult.models.claude` and then `--model-id` reach `--model` and metrics; a rejection is annotated.
- [ ] The tripwire test still detects a mutating claude lane.
- [ ] `git grep "claude-agent-sdk" -- packages/codev/src/commands` is empty.
- [ ] Build passes; the touched and new test files pass; the live check above succeeded.

#### Test Plan

`claude-cli-lane.test.ts` holds the new stub-driven scenarios. The four migrated suites are re-run as individual files. The single live run above is manual, and its transcript is recorded.

### Phase 3: Doctor on the CLI and Agent SDK removal

**Dependencies**: Phase 1 (helpers); Phase 2 (the last consult import is gone)

#### Objective

Point `codev doctor`'s Claude checks at the installed CLI, with no model call. Then remove the Agent SDK from the package and lockfile, now that nothing imports it.

#### Files to Create / Modify

- **Modify** `packages/codev/src/commands/doctor.ts`:
  - Remove the SDK import and `verifyClaudeViaSDK`.
  - **"AI CLI Dependencies" row:** replace the hard-coded `ok: Agent SDK` with a real check: `resolveClaudeBin` + `readClaudeVersion` + `assertClaudeVersion`.
    - ok: `2.1.326`
    - missing: a warning with the install hint
    - below the floor: a warning with `claude update`
    - Only an ok row counts toward `installedAiClis`.
  - **"AI Model Verification" row:** `verifyClaudeViaCli()`. It builds the child env exactly as the lane does (`resolveClaudeAuthMode` + `buildClaudeChildEnv`, loading `.env` the same way), so a withheld key is reported truthfully. It then runs `readClaudeAuthStatus`.
    - ok: `logged in (<authMethod>)`, plus the withheld-key note when present
    - logged out: a warning, "run `claude auth login`"
    - unparseable: a warning quoting the excerpt
  - Remove the stale "Set ANTHROPIC_API_KEY or run: claude /login" hints and the "Claude is verified via Agent SDK" comments.
- **Modify** `packages/codev/src/__tests__/doctor.test.ts`:
  - Remove the SDK mock.
  - Rewrite the "AI model verification" Claude cases and the "Claude SDK auth probe (#1649 audit)" describe as stub-driven, covering spec scenarios 27–31. Scenario 31 asserts the stub recorded no `-p` invocation.
  - The `#1649` audit describe is retitled: its concern, an unrestricted-tool probe, no longer exists, because doctor makes no session.
- **Modify** `packages/codev/package.json`: remove `@anthropic-ai/claude-agent-sdk`.
- **Modify** `pnpm-lock.yaml` with `pnpm install`. The diff should stay inside the SDK's own subtree: the SDK, its per-platform native packages, and any transitive packages only it used. Review the lockfile diff for collateral changes before committing.
- **Modify** the comment in `packages/codev/src/lib/test-env.ts` that still mentions the SDK.

#### Deliverables

- [ ] Doctor's Claude rows on the CLI, with no model call
- [ ] SDK removed from `package.json` and the lockfile
- [ ] Doctor tests migrated

#### Acceptance Criteria

- [ ] Scenarios 27–31 pass against the stub.
- [ ] `git grep -n "claude-agent-sdk" -- packages pnpm-lock.yaml` is empty.
- [ ] `pnpm --filter @cluesmith/codev build` passes from a fresh `pnpm install`.
- [ ] `doctor.test.ts` passes.
- [ ] Running the built `codev doctor` by hand in the worktree shows the real `claude` version and `logged in (claude.ai)`. If a key is present in the shell or `.env`, it also shows the withheld-key note.

#### Test Plan

`doctor.test.ts` gets the stub-driven scenarios. One manual `codev doctor` run against the real install is a local, model-free command.

### Phase 4: Docs in every tree

**Dependencies**: Phases 2–3 (the docs describe the finished behaviour)

#### Objective

Make every shipped description of the claude lane say "installed `claude` CLI", and document `consult.claudeAuth`, `CODEV_CLAUDE_BIN` and `CODEV_ALLOW_REAL_CLAUDE`. Do this in every tree they ship in, keeping the twins byte-identical.

#### Files to Create / Modify

- `CLAUDE.md` **and** `AGENTS.md`, edited identically and verified with `cmp`. "Claude Opus 5 via the Agent SDK" becomes "via the installed `claude` CLI (your subscription login by default)".
- The `consult` skill, four identical copies: `.claude/skills/consult/SKILL.md`, `.codex/skills/consult/SKILL.md`, `codev-skeleton/.claude/skills/consult/SKILL.md`, `codev-skeleton/.codex/skills/consult/SKILL.md`. Changes: the lane table row, and a one-line auth note.
- The `codev` skill, four identical copies, at the same four paths under `skills/codev/`. Change the doctor description: "Claude (via the bundled Agent SDK…)" becomes "Claude (the installed `claude` CLI: version and login)".
- `codev/resources/commands/consult.md` **and** `codev-skeleton/resources/commands/consult.md`, edited identically:
  - the lane table
  - the performance table
  - prerequisites: install with `curl -fsSL https://claude.ai/install.sh | bash`, then `claude auth login`
  - the "Configure auth" bullet
  - the config section: a new `consult.claudeAuth` subsection beside `consult.codexPath`, plus its row in the validation table
  - the test-isolation variable table: add `CODEV_CLAUDE_BIN` and `CODEV_ALLOW_REAL_CLAUDE`
  - "Claude auth: subscription vs. metered API" is rewritten for login-by-default, the withheld-key line, the `api-key` opt-in (the breaking change for key-only CI), and the `.env` origin. Remove the Agent-SDK credit caveat.
- `packages/codev/src/lib/shipped-skill-hashes.ts`, regenerated with `pnpm --filter @cluesmith/codev generate-skill-hashes` after the skeleton skill edits. The script reads git history plus the working tree. Run `skill-refresh.test.ts`.
- `codev/resources/lessons-learned.md`: the [From 0120] line that says the codex runner mirrors `runClaudeConsultation` gets a trailing note that the claude lane left the SDK in Spec 1912. This is a cold-tier edit only; the hot tier has no SDK fact to change.

#### Deliverables

- [ ] All listed docs updated; twins identical
- [ ] Skill hashes regenerated

#### Acceptance Criteria

- [ ] `git grep -n -i "agent sdk\|agent-sdk"` over the shipped docs (`CLAUDE.md`, `AGENTS.md`, `.claude/`, `.codex/`, `codev-skeleton/`, `codev/resources/commands/`) returns no claude-lane mention. Historical specs, plans, reviews and release notes are left alone.
- [ ] `cmp CLAUDE.md AGENTS.md` passes. The four copies of each skill are identical. `diff codev/resources/commands/consult.md codev-skeleton/resources/commands/consult.md` is empty.
- [ ] `skill-refresh.test.ts` passes after regeneration; the build passes.

#### Test Plan

Grep and `cmp`/`diff` checks as above, plus `skill-refresh.test.ts`. The full suite runs once at porch's check.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| `dontAsk` + `--add-dir` denies the sandbox diff read | Medium | High | Phase 2's live check exercises exactly this; the documented switch is to `bypassPermissions`, which `--tools` keeps read-only |
| `--setting-sources ""` is not accepted, or still loads something | Low | Medium | The Phase 1 capture proves the flag parses; the Phase 2 live check looks for hook or plugin output; `--tools` remains the hard guarantee |
| stdout is not JSON-only under `--verbose` | Low | High | Checked in the Phase 1 capture before the parser is written; if it fails, raise it with the architect instead of working around it |
| Migrated tests lose coverage the SDK mocks gave | Medium | Medium | Each migrated describe keeps its original intent, and the new lane test file covers the spec's scenarios one by one |
| The signal test kills the vitest worker | Medium | Medium | Run consult in a spawned child for that scenario only |
| The lockfile refresh drags in unrelated upgrades | Low | Medium | Review the lockfile diff for collateral changes; it should stay inside the SDK subtree (the PR #1907 precedent) |
| PR #1657 (#1641) conflicts in `runClaudeConsultation` / `validateModelId` | Medium | Low | Disjoint scopes; whoever lands second rebases. Neither depends on the other |
| The harness fake `claude` hides a test that should have used the scenario stub | Low | Low | Scenario tests pin their own stub via the helper; the harness fake exists only so incidental claude-lane calls never reach the real CLI |

## Documentation Updates

Everything listed in Phase 4:

- `CLAUDE.md` / `AGENTS.md`
- the `consult` and `codev` skills (four copies each)
- `consult.md` in `codev/` and `codev-skeleton/`
- the regenerated skill hashes
- one cold-tier lessons note

The review document records the live-run transcript excerpt and the permission-mode finding. The PR body pastes the `[CLAUDE] auth:` line from the live run and calls out the breaking change for key-only environments (`consult.claudeAuth: "api-key"`).
