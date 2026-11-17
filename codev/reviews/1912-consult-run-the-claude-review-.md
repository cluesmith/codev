# Review: Run consult's claude lane through the installed `claude` CLI, on the user's subscription

## Summary

`consult -m claude` now runs the user's installed `claude` CLI in read-only print mode (`claude -p --output-format stream-json`), not the bundled Claude Agent SDK. By default it uses the CLI's own login, which is the subscription for most people. `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are withheld unless `consult.claudeAuth: "api-key"` opts in. `codev doctor` checks the installed CLI without a model call. The `@anthropic-ai/claude-agent-sdk` dependency is gone from `packages/codev` and the lockfile. The work was four plan phases, each one commit plus review fixes. One live subscription review ran from this worktree's build, and every consultation round ended APPROVE.

## Spec Compliance

- [x] The lane spawns the resolved `claude` in print mode with streaming JSON. No file in `packages/codev/src` imports the SDK, and it is gone from `package.json` and `pnpm-lock.yaml` (Phases 2–3). `git grep claude-agent-sdk -- packages pnpm-lock.yaml` returns nothing.
- [x] By default the child env has neither `ANTHROPIC_API_KEY` nor `ANTHROPIC_AUTH_TOKEN`, from the shell, from `.env` or from both, with or without `CLAUDE_CODE_OAUTH_TOKEN`. A stub that records its env verifies this (Phases 1–2).
- [x] In `api-key` mode both keys pass through. With neither set, the lane fails before the spawn, naming both variables and the config key (Phases 1–2).
- [x] Exactly one `[CLAUDE] auth:` line prints once the auth preflight parses. It names the `authMethod`/`apiKeySource`, the credential and its origin, any withheld key with its opt-in, and, in `api-key` mode, the file that set `consult.claudeAuth`. A run that fails earlier prints no auth line. Tests assert both halves (Phases 1–2). After codex's iteration-1 finding, the line also names every *other* credential variable present (see Consultation Feedback).
- [x] Every failure is actionable, exits non-zero, writes no `--output`, removes a stale one and records an exit-1 metrics row: binary not found, below the floor, unparseable version, logged out, unparseable auth status. Nothing falls back (Phases 1–2).
- [x] The session's tools are exactly Read/Glob/Grep. No MCP servers, settings sources, slash commands or session persistence. Turn cap 200, budget cap $25. Verified from the stub's argv (Phase 2). The lane also checks the `system/init` event's tool list at runtime and kills the child if it holds anything else.
- [x] The system prompt is the consultant role plus a claude-lane-only capability note (no shell; use Read/Glob/Grep). `consultant.md` is unchanged (Phase 2).
- [x] No permission prompt can block. `--permission-mode dontAsk` plus `--add-dir <sandbox>` lets the reviewer read consult's sandbox dir. A live probe proved the sandbox read (Phase 2): `tool_result is_error=false`, `permission_denials: []`.
- [x] The prompt goes on stdin and the role in a `0600` system-prompt file in the sandbox dir. The file is removed on success, failure and signal. Prompts over 100 KB work (Phase 2).
- [x] On SIGINT/SIGTERM the child is terminated and awaited, `--output` is not written, a stale one is removed, and consult exits 130/143 with no metrics row (Phase 2). The test runs consult from source in a child process.
- [x] No Claude Code session marker reaches the child (the `lib/agent-env.ts` list), and `process.env` is identical before and after (Phases 1–2).
- [x] The model id follows the precedence shipped default → `consult.models.claude` → `--model-id`. It reaches argv and is recorded in metrics, and a rejected id keeps its provenance annotation (Phase 2).
- [x] On success, `--output` is byte-for-byte the streamed text, VERDICT block included (Phase 2; also on the live run).
- [x] Metrics take tokens and cost from the final `result` event, with nulls when it carried no `usage` (Phase 2).
- [x] Distinct failures for an error result (naming the credential), an error subtype, a non-zero exit with no result (exit code plus a bounded stderr tail), exit 0 with no result, and a non-JSON stdout line (Phase 2).
- [x] "Prompt is too long" fails with a context-exhaustion message naming the model id and #1641, with no retry (Phase 2).
- [x] Under a test runner an unpinned `claude` is refused. The harness pins a fake, the unit suite never runs the real CLI, and it makes no model call (Phase 1).
- [x] `codev doctor` shows the version, login state and auth method. It warns on missing, below-floor and logged-out, makes no model call and does not import the SDK (Phase 3).
- [x] The docs say "installed `claude` CLI" and document `consult.claudeAuth`. No shipped doc says the claude lane uses the Agent SDK. `cmp CLAUDE.md AGENTS.md` passes, the four copies of each skill are identical, and the `consult.md` twins `diff` empty (Phase 4).
- [x] One live `consult -m claude` review ran from this worktree's build on the subscription (Phase 2):
  - `[CLAUDE] binary: /Users/mwk/.local/bin/claude, 2.1.326 (from PATH)`
  - `[CLAUDE] auth: claude.ai (max) — stored claude login; ignoring ANTHROPIC_API_KEY (from .env) — set consult.claudeAuth to "api-key" to bill the API instead`
  - exit 0, VERDICT COMMENT, `--output` identical to stdout
  - metrics row: claude-opus-5, 148.9 s, 18 input / 186,510 cached / 11,019 output tokens, $0.7473
  - stdout JSON-only, and no hook or plugin output

  One success-criterion scenario was not run: spec scenario 33, the opt-in real-CLI e2e (`consult-readonly-review.e2e.test.ts`, now gated by `CODEV_ALLOW_REAL_CLAUDE`). It was migrated to the CLI argv but not executed, because the owner's standing order bars the local e2e suite and it spends tokens. The live probe and the runtime init guard cover the same read-only property.

## Deviations from Plan

- **Phase 1.** `resolveClaudeBin` resolves a relative `CODEV_CLAUDE_BIN` to an absolute path, so the binary that is checked is the one spawned with `cwd` = the workspace (claude's review note). The auth line names the winning credential by precedence *and* every other credential present. Codex flagged a hidden credential, and a probe showed `apiKeySource` cannot pick the winner.
- **Phase 2.**
  - The plan's live-check command lacked `--protocol`. The live run used `consult -m claude --protocol bugfix --type pr --issue 1821`; the first attempt, without the flag, failed before any model call.
  - Added beyond the plan: `describeClaudePermissionDenials` prints `[CLAUDE] warning: claude denied N tool calls …` from the result's `permission_denials`. Under `dontAsk` a denied read is otherwise silent, which is the spec's "PR reviews run blind" risk. Claude's review asked to keep it.
  - `annotateModelError` appends `The claude lane ran <bin>, <version> (from PATH).` to every claude failure after the preflight, not only to model rejections. The Phase 4 docs show this shape.
  - `assertClaudeVersion` now rejects a non-`MAJOR.MINOR.PATCH` string instead of comparing NaN (a Phase 1 review nit).
- **Phase 3.**
  - `describeWithheldKeys` was factored out of `describeClaudeAuth`, so doctor and the auth line share the wording.
  - The lockfile marks 54 packages `optional: true` with no version changes. They are the `@modelcontextprotocol/sdk` subtree (express, hono, …), now reachable only through `@google/genai`'s optional peer. Nothing in codev imports them.
  - A `CODEV_CLAUDE_BIN` set only in `<workspace>/.env` steered consult, which loads `.env` before resolving the binary, but not doctor, which resolved from the real `process.env`. Phase 3 documented the gap. It was closed after the architect's PR review: `resolveClaudeBin(env)` now takes the env to read, and doctor passes its `.env` merge.
- **Phase 4.** `codev.md`'s doctor section, in both trees, was also corrected. It was not in the plan's file list, but it listed Claude as `@anthropic-ai/claude-code` and showed `✓ Claude working`.
- **Review phase.**
  - `arch.md`'s Consult Architecture section had a pre-SDK claude spawn line, a table row naming `ANTHROPIC_API_KEY` and a stale "Claude nesting limitation" paragraph. The plan's grep missed them because they never mentioned the SDK. They now describe the CLI lane.
  - Both `DEPENDENCIES.md` twins gained a "Consult lane" row with the 2.1.141 floor and `claude auth login`, a small in-place fix prompted by claude's Phase 4 note.
  - After the PR review:
    - The init guard now requires *exactly* Read, Glob and Grep, not a subset. The plan had specified a subset; the spec says "exactly".
    - A successful result with no assistant text now fails instead of writing an empty `--output`.
    - Both `consult.md` twins say so.
  - After the architect's PR review (three fold-ins):
    - Every init-guard failure now says what it found rather than "write or shell tools", and names the recovery lever: pin a known-good `claude` with `CODEV_CLAUDE_BIN`.
    - Every update hint covers both install routes, through a single `CLAUDE_UPDATE_HINT`: `claude update` for the native install, `npm install -g @anthropic-ai/claude-code@latest` for an npm install.
    - Doctor resolves the binary from its `.env` merge.

## Consultation Feedback

Reviewers were codex and claude: the project's `porch.consultation.models` lists only these two, so gemini did not run. There were no `CONSULT_ERROR`s.

### Specify Phase (Round 1)

#### Codex — REQUEST_CHANGES
- **Concern**: The scope of `consult.claudeAuth` across config layers was ambiguous → **Addressed**: honoured from every layer like every other `consult.*` key, and the auth line names the file that set it. Scenario 9a was added.
- **Concern**: "Exactly one auth line" cannot hold when a run fails before auth is known → **Addressed**: the criterion covers runs whose preflight parses, and earlier failures print none (scenarios 9, 16, 16a).
- **Concern**: SIGINT/SIGTERM conflicted with "every failure records metrics" → **Addressed**: a separate signal criterion with no metrics row, matching the other lanes (scenario 23a).
- **Concern**: The temp system-prompt file's handling was unspecified → **Addressed**: mode 0600, in the sandbox dir, removed on every path (scenario 3b).

#### Claude — REQUEST_CHANGES
- **Concern**: `--tools Read,Glob,Grep` removes Bash, but the prompts and `consultant.md` tell the reviewer to `cat`/`git diff` → **Addressed**: a claude-lane-only capability note is appended to the role. The shared role is unchanged because the other lanes keep a shell.
- **Concern**: `--max-turns` and `--system-prompt-file` are hidden flags, so "only documented flags" was untrue → **Addressed**: the constraint now reads "in `--help`, or verified at both the floor and the current version".
- **Concern**: The 2.1.141 floor overstated PR #1907's evidence → **Addressed**: the rationale is corrected (2.1.105 got a 400 on the API-key path only).
- **Concern**: Hard-failing on non-JSON stdout is a sharp edge → **Addressed**: the hard fail is kept, with JSON-only stdout confirmed empirically (Phase 1 capture and the live run).
- **Concern**: `apiKeySource` and concurrency were missing → **Addressed**: both added.

### Plan Phase (Round 1)

#### Codex — COMMENT
- **Concern**: Kill and await the child on malformed stream JSON → **Addressed**, and generalised to every mid-stream failure.
- **Concern**: How doctor shares `.env` handling was unclear → **Addressed**: `lib/dotenv.ts` `readDotenvFile`, merged under a copy of `process.env`.
- **Concern**: The validator's location → **Addressed**: `validateClaudeAuth` lives in `lib/consult-lanes.ts`.
- **Concern**: Release notes → **Addressed**: a ready-to-paste paragraph in the PR body. `CHANGELOG.md` is not maintained per PR.

#### Claude — COMMENT
- **Concern**: `SDK_MODELS` is the model-validation list → **Addressed**: renamed `RUNNER_LANES`, keeping `claude`.
- **Concerns**: the Phase 2 grep scope, the validator location, stderr for the binary and auth lines, floor discipline for added flags, asserting the init tool list, stale comments, a codex-only doctor machine → **Addressed**, all folded into the plan.
- **Concern**: Use `--permission-prompts none` → **Rebutted**: it is absent at 2.1.105 and unverified at the 2.1.141 floor. `dontAsk` is present at the floor, and the live probe showed it does not block.

### Phase 1 (Round 1)

#### Codex — REQUEST_CHANGES
- **Concern**: The auth line can name the wrong credential when several are set; take the name from `apiKeySource` → **Addressed in substance, mechanism rebutted**: a local probe showed `apiKeySource` reports `ANTHROPIC_API_KEY` even when `authMethod` says the bearer token won. The line now names the winner by precedence plus every other credential present. A test pins that exact shape.

#### Claude — APPROVE (non-blocking notes)
- **Concern**: A relative `CODEV_CLAUDE_BIN` → **Addressed**: resolved to an absolute path.
- **Concern**: `binaryLine` reads `process.env` while the child env comes from `opts.processEnv` → **Rebutted**: the pin is consult's own setting, read where `resolveClaudeBin` reads it. A comment says so.
- **Concern**: A timeout was reported as "killed by SIGTERM" → **Addressed**: it now reads "no answer within 30s".
- **Concern**: Provider-switch truthiness → **N/A**: the existing #1754 rule, moved unchanged and display-only.

### Phase 1 (Round 2)

#### Codex — APPROVE
- No concerns raised.

#### Claude — APPROVE (non-blocking notes)
- **Concern**: A possible double parenthetical when both `apiKeySource` and `subscriptionType` are reported → **N/A**: cosmetic. No observed `auth status` shape carries both: a key reports no `subscriptionType`, and a claude.ai login reports no `apiKeySource`. Re-probed on 2.1.326 in the review phase, with a key and a stored Max login, key names only.
- **Concern**: `assertClaudeVersion` passes a malformed version string → **Addressed** in Phase 2.
- **Concern**: The Phase 2 classifier must check `is_error` before trusting `subtype: success` → **Addressed** in Phase 2's classification order.

### Phase 2 (Round 1)

#### Codex — APPROVE
- No concerns raised.

#### Claude — APPROVE
- No blocking concerns. Notes: keep `describeClaudePermissionDenials`, which was kept, and show in the docs the binary line now appended to every post-preflight failure, which **Addressed** in Phase 4's `consult.md`.

### Phase 3 (Round 1)

#### Codex — APPROVE
- No concerns raised.

#### Claude — APPROVE (non-blocking notes)
- **Concern**: `checkClaude` catches the test-isolation guard, where `checkAgy` lets it propagate → **Addressed**: a comment explains why. Nothing ran, and the message lands in the doctor row.
- **Concern**: A `.env`-only `CODEV_CLAUDE_BIN` steers consult but not doctor → **Addressed by documentation**: noted in `consult.md`'s test-isolation table. Resolution is unchanged.

### Phase 4 (Round 1)

#### Codex — APPROVE
- No concerns raised.

#### Claude — APPROVE (nits)
- **Concern**: The denial example omitted the quotes `excerpt()` adds → **Addressed** in both `consult.md` twins.
- **Concern**: The `claudeAuth` bullet said the auth line names "the file that set the key" → **Addressed**: it now says the file that set `consult.claudeAuth`.
- **Concern**: The release note was not drafted anywhere → **Addressed**: drafted in the thread and pasted into the PR body.
- **Concern (optional)**: `DEPENDENCIES.md`, `INSTALL.md` and `README.md` install Claude Code without the 2.1.141 floor → **Addressed** for `DEPENDENCIES.md`, both twins, in the review phase. **N/A** for `INSTALL.md` and `README.md`: those lines install the latest Claude Code for the harness and `codev import`, which is already above the floor.

### Review Phase, PR review (Round 1)

Both lanes printed the #1649 "working tree changed" warning. The two changed paths were `.review-{codex,claude}.stderr`, which I had redirected consult's stderr into, inside the project dir. Neither reviewer wrote them. They were moved out of the worktree, and the lesson is routed below. This round's claude review again ran the global pre-1912 `consult` and reported `[CLAUDE] auth: ANTHROPIC_API_KEY (from .env)` (see Methodology Improvements).

#### Codex — REQUEST_CHANGES
- **Concern**: The runtime init guard accepts any subset of Read/Glob/Grep, including `[]` or `["Read"]`, though the spec requires exactly those three → **Addressed**: the guard now also fails on a missing tool or a repeated one, naming what is missing. Four new cases cover a missing tool, an empty list, a repeat in place of a tool, and a repeat on top of all three. The plan's "subset" wording was the gap.

#### Claude — APPROVE (non-blocking notes)
- **Concern**: A `success` result with no assistant text writes an empty `--output` and exits 0 → **Addressed** for the claude lane: it fails with "wrote no review text, so there is no VERDICT", with a new test. The codex lane has the same shape and is left unchanged; it is a different lane and was not in this spec.
- **Concern**: Untracked artifacts in the worktree (`1912-phase_1-iter2-context.md` and the two `.stderr` files) → **Addressed** for the `.stderr` files, which were moved out. **N/A** for `1912-phase_1-iter2-context.md`: it is porch's iteration-context scratch, and the architect's standing order says not to stage it.
- **Concern**: Parsing of the empty `--setting-sources ""` value was verified only at 2.1.326, while the floor comment claims flag presence at 2.1.105 → **Addressed**: the comment in `buildClaudeReviewArgs` now says that presence is all that was checked at 2.1.105, and that the exact argv ran live only on 2.1.326.
- **Concern**: Spec scenario 33 (the opt-in real-CLI e2e) was migrated but not run → **N/A**: already disclosed under Spec Compliance. The owner's standing order bars the local e2e suite.

### Review Phase, architect's PR review

The architect's independent integration reviews (codex APPROVE, claude APPROVE) and CI (8/8) were green. Three fold-ins were asked for, and all are **Addressed**:

- **The extra-tool message** said "write or shell tools" when the tool may be neither, and gave no way out. It now names what it found (e.g. `"TodoWrite"`) and ends with "If a claude release changed the session's tools, pin a known-good claude with CODEV_CLAUDE_BIN=/path/to/claude." The same lever is on the missing-tool, no-tool-list and assistant-before-init failures, since any of them stops every review. A new test covers a non-write extra tool, and every guard case asserts the lever.
- **`claude update` does not apply to an npm install.** A single `CLAUDE_UPDATE_HINT` now covers both routes and is used by every update hint: version floor, malformed or unparseable version, unparseable auth status, and a non-JSON stream line. `consult.md`'s fail-fast table, in both trees, says the same.
- **Doctor and a `.env`-only `CODEV_CLAUDE_BIN`.** Doctor builds the merged env once and uses it for the binary and the login check. Two new doctor tests cover it: a `.env`-only pin is honoured without touching `process.env`, and a shell pin outranks the one in `.env`. The `consult.md` row that documented the gap is corrected.

## Lessons Learned

### What Went Well

- **Probing the real CLI before writing the parser.** One tiny capture call with the lane's full argv, at $0.03, settled the questions that would otherwise have been guesses: JSON-only stdout, the init event's `tools`, isolation (no user plugins), and the 1M context window on the installed CLI. The stub fixtures are trimmed copies of that real stream.
- **Probes beat reviewer mechanisms.** Codex's finding (a hidden credential) was right, but its fix (`apiKeySource`) would have mislabelled the winner. A local `auth status` probe with no model call showed this in seconds.
- **Read-only became a property, not a request.** `--tools` plus the runtime init-event guard replaces an instruction the old lane could ignore. #1649 measured six write calls from the old setup.
- **Each phase left consult working.** The SDK stayed until Phase 3 removed it, so every porch review in between ran on a working lane.

### Challenges Encountered

- **Porch's tests check failed with no visible cause** (Phase 1, then Phase 4). Porch shows only the first lines of a failed check's stderr (#1801), and vitest reports to stdout. In Phase 1 the failures tracked machine load; the architect ruled on running `porch done` only below load 12. In Phase 4, vitest's results cache (`packages/codev/node_modules/.vite/vitest/*/results.json`) named the three failing files with no re-run. All three were untouched by this branch and passed alone.
- **Whether `dontAsk` permits the sandbox read.** The live review could not prove it, since consult cannot see tool calls, so the architect approved one $0.018 probe with a nonce file. The read succeeded, and the lane kept `dontAsk` rather than falling back to `bypassPermissions`.
- **A mock leak.** `consult.test.ts`'s file-wide `node:child_process` mock kept a `mockImplementation(actual.spawn)` into later agy tests, which then spawned for real (EACCES). Fixed with `mockReset()`.

### What Would Be Done Differently

- Run the plan's live-check command once with `--help` before spending a model call on it. The missing `--protocol` cost one failed (free) attempt.
- Grep the governance docs for the *behaviour* (`ANTHROPIC_API_KEY`, `--dangerously-skip-permissions`, `CLAUDECODE`), not only for the dependency name. The plan's "agent sdk" grep missed `arch.md`'s pre-SDK section, which had never mentioned the SDK.

### Methodology Improvements

- Porch should surface a failed `tests` check's stdout tail, or the failing file names from vitest's results cache. This is tracked in #1801, so no new issue.
- Porch's own consultations run the globally installed `consult`. Until this ships and the global install is updated, porch's claude reviews still bill `ANTHROPIC_API_KEY (from .env)`: the Phase 4 review did. A builder changing consult cannot dogfood its own lane through porch.

## Architecture Updates

- Routed: cold — `codev/resources/arch.md`, Key Design Decisions → Consult Architecture. The claude spawn line now shows the real `claude -p --output-format stream-json …` argv. The table row names the installed CLI, the `CODEV_CLAUDE_BIN` pin, the 2.1.141 floor, the role via `--system-prompt-file` and login-by-default auth. The stale "Claude nesting limitation" paragraph, which proposed `@anthropic-ai/sdk`, is replaced by a "Claude lane (Spec 1912)" paragraph: local preflights, the shared `lib/claude-cli.ts`, session-marker scrubbing on the child env only, the `--tools` restriction plus the init-event guard, no fallbacks, and stderr for the binary and auth lines.
- No hot-tier change. The claude lane's transport and auth are subsystem detail, not a cross-cutting fact every builder needs up front, and `arch-critical.md` is at its cap.

## Lessons Learned Updates

- Routed: cold — Security — pre-approving tools (`allowedTools` + `bypassPermissions`) does not restrict them, and an API key in the environment outranks a stored subscription login. Withhold credentials the child should not use, make the alternative an explicit opt-in, and print which auth won.
- Routed: cold — Testing — when porch hides a failed check's output (#1801), vitest's results cache names the failing files with no re-run.
- Routed: cold — Testing — a file-wide `vi.mock('node:child_process')` with `mockImplementation(actual.spawn)` leaks into later tests in the file; use `mockReset()` in `afterEach`.
- Routed: cold — Architecture — the [From 0120] "mirror the SDK runner" line gained a note that the claude lane left the SDK (Phase 4).
- Routed: cold — 3-Way Reviews — redirect a consultation's stdout/stderr outside the worktree. A file you write there during the run sets off the #1649 working-tree tripwire on every concurrent lane, which then reports your own file as a possible reviewer write.
- No hot-tier change. The probe-the-mechanism lesson is already covered by the hot "Verify reviewer/plan claims against the actual file" line, and `lessons-critical.md` is at its cap.

## Flaky Tests

These are pre-existing tests, none of them touched by this branch. They failed in Phase 4's first `porch done` tests run (76.3 s, starting load 6.49), took 25–45 s each (consistent with load-sensitive timeouts), and passed when run alone at load 4.5 (48/48). They were left running, not skipped, and the architect was told.

- `packages/codev/src/commands/consult/__tests__/agy-auth-cache.test.ts`: failed after 28.6 s.
- `packages/codev/src/agent-farm/__tests__/pir-1233-session-launch-loop.test.ts`: failed after 44.6 s.
- `packages/codev/src/agent-farm/__tests__/bugfix-1267-launch-loop.test.ts`: failed after 24.8 s.

The failing files were identified from vitest's results cache, because porch showed only npm warnings (#1801). Phase 1's two intermittent `tests` failures under load 20–50 had no identifiable test. The same command passed three times when run directly.

## Follow-up Items

- **Key-only environments must opt in.** A CI job with only `ANTHROPIC_API_KEY` and no `claude` login now fails loudly until it sets `"consult": { "claudeAuth": "api-key" }`. The release note in the PR body says so; the release author should carry it.
- **PR #1657 (#1641, the `[1m]` default)** is still open and touches `runClaudeConsultation`. Whichever lands second rebases; the scopes are disjoint.
- **Update the global `consult` install** after release, so porch's claude reviews stop billing `.env` API keys.
- **Leftover temp dirs** from the Phase 2 probe and mutation run, for the human to remove: `$TMPDIR/probe-workspace-jaAgLf`, `$TMPDIR/codev-consult-CIHiYX`, `$TMPDIR/codev-consult-dOwkBx`.
