# Review: Agent attention states from harness lifecycle hooks

## Summary

Builders and architects are now served one attention state (`working`, `needs-input`, `idle`, `blocked`, `dead`) on the overview, fused from three sources: Claude lifecycle hooks reported to a new Tower ingestion endpoint (held in Tower memory only), a harness-neutral process-liveness sweep, and porch gates. Every attention surface classifies through one sdk predicate, which falls back to today's 5-minute PTY-silence rule wherever nothing is reported. Eight plan phases, all committed on this branch; a permission prompt now counts as waiting in the same second it is drawn instead of after 5 minutes or never.

## Spec Compliance

- [x] **SC1 needs-input** (Phases 3, 5, 6, 7): served within the same second the prompt was drawn, with tool and summary (S9, S20). Residual, stated plainly: the extension's status bar and activity badge were not run inside a VS Code host, because `vscode-test` cannot launch Electron in this environment. The extension's own status-bar and badge code (`updateStatusBarCounts` / `updateActivityBadge` over sdk `deriveAttention` + `isIdleWaiting`, `composeStatusBarText`, `composeStatusBarTooltip`, `composeActivityBadge`) was exercised headless against the live overview of a real session, and the count moved in the same second the prompt was drawn. Phase 7 unit tests cover the same code.
- [x] **SC2 question** (Phase 6): AskUserQuestion served `needs-input {question, AskUserQuestion, "Which color do you prefer?"}` in the second it was drawn (S10). The MCP elicitation path (`Notification(elicitation_dialog)` mapped to kind `question`) is unit-tested; no live MCP elicitation was exercised.
- [x] **SC3 resume** (Phases 3, 6): answer and approval return to `working` within 1 s of the tool completing; deny stays `needs-input` with no hook firing until the next prompt (S9). See #1851 for the approved long-running tool.
- [x] **SC4 idle** (Phases 3, 6): every turn end served `idle` within about 1 s.
- [x] **SC5 no false alarm** (Phases 2, 8): a 5 min 34 s silent foreground tool stayed `working` throughout (S12); a background task held `working` through Claude's `idle_prompt` after the Phase 8 store fix (S13).
- [x] **SC6 no stuck working** (Phase 2): Esc mid-tool fires no hook; the builder entered the waiting list at the first sample past 5 min of silence, not before (S14).
- [x] **SC7 dead** (Phases 4, 5, 7): `/exit` served `dead` in 9 s (S16), Codex Ctrl+C in 8 s (S18); `/clear` and architect relaunch never flashed dead (S15, architect `/exit`); the dashboard card renders "Agent exited" in red with its own border, the extension row its own glyph. Residual: a fully dropped architect session is #1856 (see Known Limitations).
- [x] **SC8 blocked unchanged** (Phase 5): blocked reuses the overview's own `detectBlocked` result, ranked first.
- [x] **SC9 fallback** (Phases 2, 6): Codex builder carries no reporter, served `null`, entered waiting by PTY silence (S18, SC9 run); the `null` path is regression-tested bit for bit against today's rule.
- [x] **SC10 one predicate** (Phases 2, 7): every surface classifies through sdk `agentAttentionState` / `isIdleWaiting` / `deriveAttention`; `describeNeedsInput` gives one phrase everywhere.
- [x] **SC11 in-memory state** (Phases 3, 4, 5): S17 restart: every agent was served `null` after the restart (no reported state survived, per the owner's in-memory ruling) until its next report restored it (`task-Tnj-` idle again at its next report); an exited agent was served `dead` from liveness alone with no reported state.
- [x] **SC12 guard intact** (Phase 6): out-of-worktree Write denied by the guard with the reporter installed; both hook sets fired (S19).
- [x] **SC13 architects** (Phases 5, 7): architect at a permission prompt listed under "architect main" in the rollups and tooltips (S20); idle architects never listed. Residual: #1856.
- [x] **SC14 completion** (Phases 1, 2): `complete`/`verified` never dead or waiting, unit-tested in core and sdk.
- [x] **SC15 fail-open** (Phases 6, 8): SIGSTOP and SIGTERM on Tower did not delay turns, printed nothing into the TUI, left no reporter process behind; missing script is silent (shell wrapper).
- [x] **SC16 validation and auth** (Phase 3): route tests for missing key, unknown event, over-limit fields and body, unknown agent.
- [x] **SC17 ordering** (Phases 3, 8): older hook time ignored, older session never supersedes, far future rejected; Phase 8 split the ordering watermark (`latestHookAt`) from the served time (`reportedAt`) so an ignored report still advances ordering.
- [x] **SC18 boundaries** (Phase 1): shapes in `codev-types`, projection in core, predicate in the sdk; boundary tests pass.
- [x] **SC19 rendering safety** (Phases 6, 7): reporter strips control characters (including U+2028/2029); surfaces render the summary as plain text; the Playwright check used a hostile Markdown/HTML summary and saw it literally.

## Deviations from Plan

- **Phase 6, settings-path quoting**: the plan said to single-quote the settings path in `args` too. Architect `args` go to `pty.spawn` as argv with no shell, so quotes would reach Claude literally and break the launch. `args` carry the forward-slash path unquoted; `scriptFragment` (the only bash-parsed form) is forward-slash and single-quoted. Main's #1658 intent holds.
- **Phase 8, store fix**: a real-session finding not in the plan. Claude fires `Notification(idle_prompt)` 60 s after `Stop` regardless of background tasks, which flipped a background-working agent to idle early. The store now ignores a same-session `turn-ended` with no background claim while a background-work turn end is held. Tests: hold kept; released by an explicit Stop, a new turn, or a new session; a lost Stop still recovers; the ordering watermark still advances. No wire change (architect ruling).
- **Phase 8, two report times** (CMAP Phase 8 Round 2, Codex): with one stored time, an ignored claim-less turn end did not advance ordering, so a delayed older report could regress the background-work hold (SC17). The store now keeps an ordering watermark (`latestHookAt`, advanced by every accepted report) apart from the served time (`reportedAt`, served as `activityAt`). In the review phase main confirmed the meaning (Option A, store as built) and the `ServedAgentState.activityAt` comment and spec lines now read: "ISO hook time of the latest report applied to the served fields, or `null`. A claim-less turn end repeated while `backgroundWork` is held advances ordering only and does not move it."
- **Phase 8, nested `afx architect`**: the no-Tower path now spawns with `sanitizeAgentEnv(process.env)` so a launch from inside another agent never inherits its identity (CMAP phase 6 carry).
- **Phase 8, single question-tool constant**: `CLAUDE_QUESTION_TOOL` feeds both the hook matcher and the script (CMAP phase 6 carry).
- **Review phase, harness-named reporter files** (owner request at the pr gate): the installed files are now `claude-lifecycle-reporter.cjs` and `claude-lifecycle-reporter-settings.json`. Their contents are Claude-specific, so a harness-neutral name would have let a second reporter (#1796) overwrite them, or be handed Claude's settings file. No install existed yet, so the rename orphans nothing.
- **Review phase, troubleshooting line**: the plan's conditional operator-facing note for a deleted hooks directory was added to `workflow-reference.md` (both trees) as well as `arch.md`.
- The spec itself changed twice after its first draft by owner ruling (state in memory, not `global.db`; identity from existing launch env); the plan was written against the approved spec, so these are not plan deviations.

## Served Time Semantics (pinned for #1672)

Confirmed by main in the review phase:

- `since`: when the served `state` began, whatever its source (harness, liveness, porch).
- `activityAt`: the last report that touched the served fields, so while `working` it also reads as "last seen active".
- The 30-minute background-work bound anchors on `activityAt`, which a repeated claim-less turn end cannot extend.
- The ordering watermark stays internal to the store; it is not on the wire.

## Ordering Note: equal hook times

A same-session report whose hook time equals the stored watermark is accepted and applied in arrival order (last writer wins); a different-session report needs a strictly newer time. This is safe because, per spec line 201 and the installed hook set, two same-session reports close enough to share a millisecond come from adjacent hooks of one turn step (`PreToolUse` and `PermissionRequest` about 10 ms apart, `PermissionRequest` and its `permission_prompt` notification), which map to the same state. State-changing steps of one turn (a tool's `PostToolUse`, then `Stop`) are separated by tool or model latency. Store test: "same-session reports with an equal hook time apply in arrival order (last writer wins)".

## Real-Session Run Log (Phase 8)

Setup: isolated Tower built from this branch (`CODEV_AGENT_FARM_DIR=<scratch>/af node dist/agent-farm/servers/tower-server.js 14595`), a scratch repo adopted with `codev adopt -y`, the real `afx` CLI from this branch routed to port 14595. Launch commands `claude` with no `--dangerously-skip-permissions`; the scratch `.claude/settings.json` sets `permissions.defaultMode: "default"` because the operator's `auto` mode never raises a prompt. Driven through Tower `POST /api/terminals/:id/write`, observed through `/api/overview` polled every second and the sdk `deriveAttention`.

- Architect first launch: hooks installed; served idle at session start.
- **S20 architect permission**: prompt drawn 07:54:01, served `needs-input {permission, Bash, "touch arch-p8c.txt"}` 07:54:01; `deriveAttention.architects = [main]`. Approve: working +1 s, idle +2.5 s, architects empty.
- **Architect `/exit`**: relaunched in about 3 s, never served dead.
- **SC4 idle**: every turn end served idle within about 1 s.
- **S9 builder permission**: served `needs-input {permission, Bash, afx send architect "ready"}` at 07:54:57, the second the prompt was drawn. Deny: stays needs-input, no hook fires. Next prompt: working at once. New prompt approved: working +1 s, idle +4 s.
- **S10 question**: AskUserQuestion served `needs-input {question}` in the second drawn; answer: working at once, idle +3 s.
- **S12 silent foreground tool**: `node -e "setTimeout(...,330000)"` served working continuously for 5 min 34 s, then idle.
- **Observation, approved long tool**: approved at 07:57:22, served needs-input until the tool completed at 08:02:55. Claude fires no hook on approval. Filed as #1851.
- **S13 background task**: before the fix, flipped to idle at 08:00:23 while the task still ran (captured `idle_prompt` payload carries no `background_tasks`). After the fix: working with background work from 08:13:05 to 08:14:42 straight through the `idle_prompt`, then working, then idle.
- **SC15 hanging Tower** (SIGSTOP about 45 s): the agent's turn ran and ended during the hang; no reporter left behind; buffered reports applied on resume with their real hook times.
- **SC15 TUI noise**: no "running ... hooks" line in a reporter-only builder's whole scrollback.
- **SC15 stopped Tower** (SIGTERM): a background follow-up turn ran and finished with Tower down. Tower does not re-adopt workspaces under a temp directory (`isTempDirectory`), so the scratch workspace moved to `~/.cache` for later runs.
- **Startup dialogs**: an agent at folder trust or external-import dialogs reports nothing (SessionStart fires after the dialog); served null.
- **S19 write-guard**: out-of-worktree Write denied, file not created; same turn served working then idle.
- **S15 `/clear`**: new session took over, idle, never dead over 20 s.
- **S16 exit**: `/exit` 08:17:26, dead 08:17:35 (9 s); dashboard card "Agent exited" in red. Enter at the loop prompt: working, then idle.
- **S18 Codex** (codex-cli 0.162.1): no reporter, served null; Ctrl+C twice, dead in 8 s. Detached `codex app-server` daemons (parent pid 1) correctly ignored by liveness.
- **S14 Esc interrupt**: no hook fired; terminal silent from 08:15:35; listed as waiting at the first sample past 5 min (08:20:55), not at 08:20:25.
- **SC9 Codex PTY fallback**: idle from 08:20:06, served null, entered waiting at 08:25:13.
- **S17 restart**: SIGTERM 08:25:21, restart 08:25:27, all four sessions re-adopted, every agent served null; `task-Tnj-` back to idle at its next report (08:25:55). After a second restart, an exited agent was served dead from liveness at 08:26:27 with no reported state.
- **Overview rebuild rate**: a busy turn (start, five tool calls, end) produced 7 `overview-changed` events over about 30 s, never more than one per state change.
- **Unknown-agent lookup cost**: on a read-only copy of the real `global.db` (26 builder rows, 8 workspaces), a miss costs 0.26 ms, a hit 0.02 ms.
- **SC1 extension code**: headless run of the extension's status-bar and badge functions on the live overview: working builder "Codev: 1 builders", no badge; permission prompt at 08:47:57 gave "1 waiting", badge 1, in the same second; architect prompt at 08:48:05 gave "2 waiting", badge 2, tooltip "Architect main waiting on input".
- **Cleanup**: scratch builders cleaned, workspace and isolated Tower stopped; the live Tower on 4100 stayed healthy throughout.

## Known Limitations

- **#1851**: an approved long-running tool stays `needs-input` until it completes, because Claude fires no hook on approval: a false "needs input" while the agent is working.
- **#1852** (pre-existing): the dashboard's Needs Attention list is replaced by the error when the PR fetch fails, hiding agent rows too.
- **Startup dialogs**: an agent at a pre-session dialog (folder trust, external imports) reports nothing, so it is served `null` and today's rule applies.
- **Deleted hooks directory**: if `~/.agent-farm/hooks` is deleted by hand, Claude fails with "Settings file not found" (exit 1), and baked builder loops relaunch every 2 s until the next `afx spawn --resume` or `afx workspace recover` reinstalls the files. Recovery is any Tower launch or `afx spawn --resume`.
- **#1856** (SC7/SC13 residual): an architect whose session is dropped entirely (not in restart wait) vanishes from the overview instead of being served `dead`, because `liveArchitects` lists live sessions only. Scoped out at the spec (Codex iter 1) and deferred again at plan CMAP iter 1 (Gemini and Codex, rebutted as out of scope); restart-wait architects and every builder case are served `dead`.
- **#1857**: the Stream Deck face is the deck's twin of the VS Code builder row but renders `blocked` and `active` only; the served needs-input, idle and dead states are #1857 (noted in `apps/streamdeck/src/face.ts`).
- **Codex and OpenCode** report no lifecycle events; they get liveness (`dead`) and today's PTY rule. Codex reporter is #1796.

## Consultation Feedback

Gemini (`agy`) was skipped as a non-blocking CONSULT_ERROR (agy exit 3) from Phase 4 onward; the Codex and Claude lanes ran every round.

### Specify Phase (Round 1)

#### Gemini
COMMENT
- **Concern**: Wire contract carries no raw reported activity, though the prose says the row carries raw inputs for #1672 → **Addressed**: served row carries `activity`, `activityAt`, `backgroundWork` and `alive`.
- **Concern**: A lost `Stop` (fail-open, no retries) leaves the agent `working` forever → **Addressed**: a reported `working` is trusted only while PTY output is fresher than 5 min (SC6); the 60 s `idle_prompt` is a second chance.
- **Concern**: No event says when background-work `working` ends → **Addressed**: spike showed task completion starts a new turn ending in `Stop` with empty `background_tasks`; 30-min bound backstops it.
- **Concern**: Permission-denial path undocumented → **Addressed**: verified; the agent stays `needs-input` until the next prompt (SC3).
- **Concern**: Async hook spawn jitter can invert timestamps → **Addressed**: `at` is hook run time, ordering rules specified, racing reports carry the same state.
- **Concern**: Inline `--settings <json>` risks shell quoting → **Addressed**: codev-owned settings file.
- **Concern**: `WaitingItem`/`AttentionBuilderRef` cannot model architects → **Addressed**: separate `AttentionSummary.architects` list.

#### Codex
REQUEST_CHANGES
- **Concern**: Open questions contradict SCs that already assume answers → **Addressed**: turned into owner decisions at the gate.
- **Concern**: Completed-builder precedence undefined (normal completion could raise `dead`) → **Addressed**: `dead` only for builders not `complete`/`verified` (SC14).
- **Concern**: Dead architects disappear (overview lists live sessions only) → **Rebutted** in part: restart-wait architects are served `dead`; fully removed architects out of scope.
- **Concern**: Session ordering, equal/future timestamps unspecified → **Addressed**: explicit SC17 rules.
- **Concern**: Field bounds and redaction untestable → **Addressed**: concrete limits (tool 64, summary 200, ids 128, body 8 KB); no redaction, with rationale.
- **Concern**: Background-work `working` may never clear → **Addressed**: spike result plus 30-min bound.

#### Claude
REQUEST_CHANGES
- **Concern**: Dead detection infeasible (PTY child is the bash launch loop, no EXIT frame) → **Addressed**: Tower-side process-tree liveness with a confirmation interval.
- **Concern**: `SessionEnd → dead` false-fires on `/clear` → **Addressed**: `SessionEnd` not reported; death only from liveness (test 15).
- **Concern**: Permission event only docs-confirmed → **Addressed**: spike confirmed `PermissionRequest` about 10 ms after `PreToolUse`; `Notification(permission_prompt)` kept as second chance.
- **Concern**: Architect attention outside the contract → **Addressed**: `AttentionSummary.architects` (SC13).
- **Concern**: A key holder can post state for another agent → **Addressed** in part: only agents Tower knows are accepted (SC16); cross-agent spoofing by a key holder is an accepted risk.
- **Concern**: Summary rendering risk (Markdown `command:` links) → **Addressed**: plain text only, control chars stripped (SC19).
- **Concern**: Cache invalidation is the wrong mechanism; latency bound ambiguous → **Addressed**: `overview-changed` SSE; "served" and "visible" bounds defined.
- **Concern**: Narrow the `PreToolUse` matcher → **Addressed**: question tool only; `PostToolUse` on all tools.

### Plan Phase (Round 1)

#### Gemini
REQUEST_CHANGES
- **Concern**: Shellper process-tree depth breaks liveness → **Addressed**: Phase 4 walks shellper → loop → agent / shellper → agent.
- **Concern**: Resumed architects bypass `buildArchitectArgs` → **Addressed**: resume path injected (test 7 enumerates every form).
- **Concern**: Dropped sessions filtered before projection → **Addressed** for builders (project over `data.builders`); **Rebutted** for removed architects (out of scope).
- **Concern** (minor): `WaitingItem.since`, architect-aware ordering, fragment on `baseCmd`, badge from `agentState.since` → **Addressed**.

#### Codex
REQUEST_CHANGES
- **Concern**: `liveArchitects()` drops registered architects without sessions → **Rebutted**: scoped out by the spec, stated in the plan.
- **Concern**: Store emits only on activity changes → **Addressed**: emits on any material field change.
- **Concern**: Reporter's port source unspecified → **Addressed**: `CODEV_TOWER_PORT` on every session.

#### Claude
REQUEST_CHANGES
- **Concern**: Architect resume bypasses the injection funnel → **Addressed** (as Gemini).
- **Concern**: Phases 3 and 5 key on different builder id spaces → **Addressed**: one key (refined in Round 2).
- **Concern**: Projection inside the `entry.builders` loop misses dropped sessions → **Addressed**.
- **Concern**: Port source unspecified → **Addressed**: `CODEV_TOWER_PORT`.
- **Concern**: `agentAttentionState` omits `blocked` → **Addressed**.
- **Concern**: `!atGate` suppresses needs-input for gated builders → **Rebutted**: spec precedence; reopened and fixed for `prReady` in Round 2.
- **Concern**: `WaitingItem.since` reads `lastDataAt` → **Addressed**.
- **Concern**: `phase` vs `protocolPhase` for completion → **Addressed**: `b.phase`.
- **Concern**: Normalize both sides of the worktree comparison → **Addressed**.
- **Concern**: Single combined provider method departs from convention → **Rebutted**: follows `buildResume`'s single-method form.
- **Concern**: `NeedsAttentionList.tsx` not covered → **Addressed**.
- **Concern**: Launch-script byte-identity tests change → **Addressed**: Claude tests updated deliberately; others byte-identical.
- **Concern**: Shared `~/.agent-farm/hooks/` across installs → **Addressed**: stateless, fail-open script.

### Plan Phase (Round 2)

#### Gemini
APPROVE. No concerns raised.

#### Codex
COMMENT
- **Concern**: Phase 7 omits `WorkView.tsx` and the panel webview → **Addressed**.
- **Concern**: Scope the `lastDataAt` grep gate to agent attention → **Addressed**.

#### Claude
REQUEST_CHANGES
- **Concern**: Builder key defined wrong against `storedRoleId`; resolver must not throw → **Addressed**: one shared derivation, null-returning resolver; `send.ts` keeps its throwing wrapper.
- **Concern**: `prReady` suppresses needs-input/dead → **Addressed**: listed; idle and PTY silence stay suppressed.
- **Concern**: Reuse `listProcessCensus`, `[]` is unknown → **Addressed**.
- **Concern**: Architect injection applied twice → **Addressed**: `buildArchitectArgs` plus the single resume return.
- **Concern**: Per-report SQLite cost; two `liveArchitects` callers → **Addressed**: memoized; both callers updated.

### Plan Phase (Round 3)

#### Gemini
APPROVE. No concerns raised.

#### Codex
REQUEST_CHANGES
- **Concern**: A missing script makes `node <path>` print and exit non-zero (SC15) → **Addressed**: fail-silent wrapper `[ -f '<script>' ] && node '<script>' >/dev/null 2>&1; exit 0`, tested.

#### Claude
APPROVE
- **Concern** (non-blocking): Null `roleId` builders could collide → **Addressed**: skipped.
- **Concern** (non-blocking): Set `CODEV_TOWER_PORT` on the final env → **Addressed**.
- **Concern** (non-blocking): Phase 8 must not run with permissions skipped → **Addressed**: ran in `default` mode.
- **Concern** (non-blocking): "Registered agent with no session" observable only for builders → **Addressed**: scoped.

### Phase 1 (Round 1)

#### Gemini
APPROVE. No concerns raised.

#### Codex
REQUEST_CHANGES
- **Concern**: `needsInput` detail dropped when blocked/dead wins → **Addressed**: detail follows raw activity on every row.

#### Claude
APPROVE
- **Concern** (non-blocking): `codev-types` only a devDependency of core → **Addressed**: moved to dependencies.
- **Concern** (non-blocking): `needsInput` doc comment disagrees with code → **Addressed** (Codex fix).
- **Concern** (nit): non-null assertion; bare detail not asserted → **N/A**: non-blocking, noted.

### Phase 1 (Round 2)

#### Gemini
APPROVE. No concerns raised.

#### Codex
APPROVE. No concerns raised.

#### Claude
APPROVE
- **Concern** (non-blocking): `FINISHED_PHASES` duplicates the sdk check → **N/A**: non-blocking, noted.
- **Concern** (non-blocking): `phase: ''` for architects is stringly typed → **N/A**: non-blocking, noted.

### Phase 2 (Round 1)

#### Gemini
APPROVE. No concerns raised.

#### Codex
APPROVE. No concerns raised.

#### Claude
APPROVE
- **Concern** (non-blocking): `isIdleWaiting` lost its `blocked` guard → **Addressed**: restored, tested.
- **Concern** (non-blocking): no architect sample in ordering property tests → **Addressed**.

### Phase 3 (Round 1)

#### Gemini
APPROVE. No concerns raised.

#### Codex
REQUEST_CHANGES
- **Concern**: Stored `workspace_path` not normalized → **Addressed**: both sides normalized, canonical spelling first.
- **Concern**: Memo invalidator has no production callers → **Addressed**: memo keyed on `PRAGMA data_version` + `total_changes()`.
- **Concern**: Tests could not run in the reviewer sandbox → **N/A**: environmental; pass locally.

#### Claude
COMMENT
- **Concern**: `overview-changed` per report → **Addressed**: coalesced per workspace, 500 ms.
- **Concern**: Memo invalidator unwired → **Addressed** (as Codex).
- **Concern**: Store/overview key join could diverge → **Addressed**: Phase 5 join test.
- **Concern**: Tool-less needs-input keeps stored detail → **Rebutted**: matches spec; only the redundant notification is tool-less.
- **Concern**: Route strictness couples to the reporter → **Addressed**: carried to Phase 6.
- **Concern**: One `realpathSync` per candidate → **Rebutted**: memo and canonical-first pass keep it rare.

### Phase 3 (Round 2)

#### Gemini
APPROVE. No concerns raised.

#### Codex
APPROVE. No concerns raised.

#### Claude
APPROVE
- **Concern** (non-blocking): Key-join corner for mismatched worktree spelling → **Addressed**: Phase 5.
- **Concern** (non-blocking): Unknown-agent full scan → **Addressed**: measured in Phase 8 (miss 0.26 ms).
- **Concern** (non-blocking): `total_changes()` lowers memo hit rate → **N/A**: cost only, noted.
- **Concern** (non-blocking): 500 ms window allows 2 rebuilds/s → **Addressed**: measured (7 events per busy turn).
- **Concern** (non-blocking): Reporter must enforce limits → **Addressed**: Phase 6.
- **Concern** (non-blocking): Stale architect rows seed store entries → **Addressed**: Phase 4 sweep drops them.

### Phase 4 (Rounds 1 and 2)

#### Gemini
CONSULT_ERROR, skipped (agy exit 3), both rounds.

#### Codex
Round 1 REQUEST_CHANGES
- **Concern**: A failed census still advances session-fact agents toward `dead` → **Addressed**: census failure checked first; all read `alive: null`; test added.
Round 2 APPROVE.

#### Claude
Round 1 APPROVE
- **Concern** (non-blocking): Liveness and store key spaces can diverge → **Addressed**: Phase 5 join test.
- **Concern** (non-blocking): Counter not reset on an unknown sweep → **Addressed**: intentional, documented.
- **Concern** (non-blocking): `since` on a dead flip is the confirmation time → **Addressed**: documented.
- **Concern** (non-blocking): Non-`exec` shell-wrapped architect reads alive → **Rebutted**: unrecognized shapes accepted by spec.
- **Concern** (non-blocking): Dedupe untested → **Addressed**: test added.
Round 2 APPROVE
- **Concern** (non-blocking): Legacy-row key mismatch drops state in the sweep → **Addressed**: Phase 5 showed no served effect.
- **Concern** (non-blocking): `awaitingRestart` shadowed by `exited`; zombies alive; `stop()` vs in-flight sweep → **N/A**: non-blocking, noted.

### Phase 5 (Round 1)

#### Gemini
CONSULT_ERROR, skipped (agy exit 3).

#### Codex
APPROVE. No concerns raised.

#### Claude
APPROVE
- **Concern** (non-blocking): Redundant per-request `realpathSync` → **N/A**: noted.
- **Concern** (non-blocking): No direct `serve.ts` unit test → **N/A**: covered by the integration test.
- **Concern** (non-blocking): `lastDataAt === 0` → **N/A**: unreachable.
- **Concern** (non-blocking): `dead` not yet rendered distinctly → **Addressed**: Phase 7.

### Phase 6 (Rounds 1 to 3)

#### Gemini
CONSULT_ERROR, skipped (agy exit 3), all rounds.

#### Codex
Round 1 REQUEST_CHANGES
- **Concern**: U+2028/U+2029 survive `plainText` (SC19) → **Addressed**: treated as line breaks; test.
Round 2 REQUEST_CHANGES
- **Concern**: Script hardcodes 4100 → **Addressed**: interpolated `DEFAULT_TOWER_PORT`; test pins it.
Round 3 APPROVE.

#### Claude
Round 1 COMMENT
- **Concern**: Deleted settings file stops Claude from starting → **Rebutted**: accepted residual (every launch reinstalls first); documented operationally.
- **Concern**: Unverified `Notification` matcher → **Addressed**: dropped; re-verified on 2.1.306.
- **Concern** (minor): Duplicate quoting helper, inverted dependency → **Addressed**.
- **Concern** (minor): `primaryArgument` includes `description`/`prompt` → **Rebutted**: bounded, sanitized fallbacks.
Round 2 APPROVE
- **Concern** (non-blocking): Missing settings file crash-loops the baked loop every 2 s → **Rebutted**: architect ruled to keep the file install (inline JSON rejected for #1658 quoting); documented in arch.md and workflow-reference.
Round 3 APPROVE
- **Concern** (minor): `AskUserQuestion` as two literals → **Addressed**: `CLAUDE_QUESTION_TOOL` (Phase 8).
- **Concern** (minor): No-Tower `afx architect` forwards unsanitized env → **Addressed**: `sanitizeAgentEnv` (Phase 8); test.

### Phase 7 (Rounds 1 and 2)

#### Gemini
CONSULT_ERROR, skipped (agy exit 3), both rounds.

#### Codex
Round 1 REQUEST_CHANGES
- **Concern**: Panel reads PTY-silence fallback as "idle" (SC9) → **Addressed**: shared `waitWord`; unit-tested.
- **Concern**: Browser verification not recorded → **Addressed**: spec-1595 Playwright 3/3 recorded.
Round 2 APPROVE.

#### Claude
Round 1 APPROVE
- **Concern** (non-blocking): Thin browser evidence → **Addressed** (as Codex).
- **Concern** (non-blocking): Needs-input label cap widens the state column → **Rebutted**: deliberate; full text in `title`.
- **Concern** (non-blocking): Panel badge omits tool/summary → **Rebutted**: `WaitingItem` carries no detail; row and card show it.
- **Concern** (non-blocking): Status-bar count vs panel list for `prReady` + PTY silence → **N/A**: pre-existing.
Round 2 APPROVE
- **Concern** (minor): Label width → **Rebutted** (as Round 1).
- **Concern** (minor): `needsInputLabel` early return duplicates `describeNeedsInput` → **N/A**: noted.
- **Concern** (minor): "N waiting" mixes builders and architects → **N/A**: tooltip disambiguates.
- **Concern** (minor, pre-existing): `timeAgo` reads `Date.now()` → **N/A**: noted.

### Phase 8 (Rounds 1 to 3)

#### Gemini
CONSULT_ERROR, skipped (agy exit 3), all rounds.

#### Codex
Round 1 REQUEST_CHANGES
- **Concern**: SC1 status bar/badge not observed on a real session → **Addressed**: extension code ran headless on a real session's overview; VS Code host painting stated as a residual.
- **Concern**: arch.md says all structured state is in SQLite → **Addressed**: qualified.
- **Concern**: Run log not in the review artifact → **Addressed**: carried into this review.
Round 2 REQUEST_CHANGES
- **Concern**: An ignored claim-less `turn-ended` does not advance the ordering watermark, so a delayed older report is accepted (SC17) → **Addressed**: `latestHookAt` (watermark) split from `reportedAt` (served time); reordered-event test.
Round 3 APPROVE.

#### Claude
Round 1 REQUEST_CHANGES
- **Concern** (blocker): 3 `tower-api.e2e` failures on the final head → **Rebutted**: pre-existing, machine-local (fresh `origin/main` worktree fails identically; Linux CI green); withdrawn in Round 2.
- **Concern**: Name #1851/#1852 and the run log in the review → **Addressed**.
- **Concern**: Nested `afx architect` inherits identity → **Addressed**.
- **Concern**: Unknown-agent scan unmeasured → **Addressed**: measured.
Round 2 APPROVE
- **Concern** (non-blocking): Linux CI must settle the e2e failures → **Addressed**: PR required checks.
- **Concern** (non-blocking): SC1 headless only → **Addressed**: stated as a residual.
- **Concern** (non-blocking): arch-critical global.db fact may mislead → **Addressed**: one-clause exception, cap unchanged.
- **Concern** (non-blocking): Frame #1851 as a false "needs input" → **Addressed**.
Round 3 APPROVE
- **Concern** (minor): `activityAt` doc comment still says "latest accepted report" → **Addressed** in the review phase through main's contract seat (wording confirmed by main, folded into the type comment and spec).
- **Concern** (minor): No operator-facing note for a deleted hooks directory → **Addressed**: `workflow-reference.md` Troubleshooting entry (both trees).

### PR Review (Round 1)

#### Gemini
CONSULT_ERROR, skipped (agy exit 3).

#### Codex
REQUEST_CHANGES
- **Concern**: Context and rebuttal files under `codev/projects/1595-*/` untracked → **Addressed**: committed.
- **Concern**: Spec and plan lack `approved`/`validated` frontmatter → **Rebutted**: that frontmatter marks artifacts approved before spawn; these were approved through porch's own spec and plan gates.

#### Claude
APPROVE
- **Concern** (non-blocking): `/api/agent-lifecycle` not on the tunnel block list → **Addressed**: blocked in `tunnel-client.ts` (bare, workspace-scoped, percent-encoded), test added.
- **Concern** (non-blocking): hooks-deletion crash loop → **N/A**: documented; bounded-relaunch guard filed as #1855.
- **Concern** (non-blocking): a served `idle` now counts as waiting at once on the status bar and badge → **N/A**: SC4 as approved; an intended behavior change, noisier than the 5-minute rule.
- **Concern** (nit): some rebuttals untracked → **Addressed** (as Codex).

### PR Review (Round 2)

#### Gemini
CONSULT_ERROR, skipped (agy exit 3).

#### Codex
APPROVE. No concerns raised.

#### Claude
APPROVE
- **Concern** (minor): the frontmatter rebuttal's supporting claim that no porch-gated spec carries `approved:` is inaccurate → **Addressed**: rebuttal corrected; the conclusion rests on porch's gate records.
- **Concern** (minor): #1851 and the SC1 headless residual → **N/A**: already disclosed above.
- **Concern** (follow-up): file the bounded-relaunch guard so it is not lost in the PR description → **N/A**: raised with the architect, whose call it is.

## Lessons Learned

### What Went Well

- Two hook spikes (Claude 2.1.289, then 2.1.306) before the plan settled the event semantics up front: deny fires nothing, `/clear` is SessionEnd plus a new SessionStart, AskUserQuestion arrives as a permission request. The design never had to change shape for an event it misread.
- The fusion is layered so each source has one owner: liveness is the only source of `dead`, porch the only source of `blocked`, the store the only source of reported activity, and the sdk the only classifier. Every surface change in Phase 7 was a call-site swap.
- The `null` fallback is today's rule bit for bit, so a non-reporting harness, an old session, or a restarted Tower is never worse than before.
- The scripted real-session run in Phase 8 found the one behavioural bug unit tests could not (`idle_prompt` during background work) and the one limitation (#1851).

### Challenges Encountered

- **Identity and persistence changed after the contract ruling.** Two owner rulings (memory-only state; identity from existing launch env) arrived after main's first contract approval. Each was folded into the spec and re-confirmed with main before the plan, which cost time but kept the contract seat's word authoritative.
- **Builder liveness.** The PTY child is the bash relaunch loop, which stays alive at its prompt when the agent exits, so death needs a process-tree census (shellper, loop, agent) with a two-sweep confirmation.
- **Getting a real permission prompt.** The operator's `auto` mode approves safe commands silently; verification needed a scratch settings file forcing `default` mode, and Claude blocks a foreground `sleep`, so the silent-tool test used a `node` timer.
- **Isolated Tower.** Workspaces under a temp directory are not re-adopted on restart and paths inside `.builders` are refused, so the restart scenarios had to move to `~/.cache`.

### What Would Be Done Differently

- Run the background-task scenario against `idle_prompt` timing in the spec spike, not only in Phase 8: the 60-second `idle_prompt` was known from the first spike, its interaction with background work was not tested until verification.
- Set the verification permission mode explicitly from the first run instead of discovering `auto` mode's silent approvals.

### Methodology Improvements

- Porch truncates check output, so an intermittent `npm test` failure (three times, phases 7 and 8) could not be attributed to a test. Persisting full check output and naming the failing test would make this diagnosable; the architect is filing the porch issue.
- The Gemini lane skipped every round from Phase 4 on (`agy` exit 3); a reviewer lane that silently drops for half a project is worth a visible warning at the gate.

## Architecture Updates

- Routed: cold: `arch.md` Agent Farm Internals > **Agent State (Spec 1595)**: the contract, reporter, ingestion, store, liveness, projection and predicate pipeline, plus known limitations (#1851, startup dialogs, deleted hooks directory).
- Routed: cold: `arch.md` System-Wide Patterns > State Persistence: memory-only agent state is the deliberate exception to "state lives in global.db".
- Routed: hot: `arch-critical.md`: one clause added to the existing global.db fact ("Exception: harness-reported agent state (Spec 1595) is Tower-memory only, never global.db."). No new fact, fact count unchanged at the cap, no demotion needed.
- Operator-facing: `workflow-reference.md` Troubleshooting (both `codev/` and `codev-skeleton/`) gained the "Settings file not found" recovery entry.

## Lessons Learned Updates

- Routed: cold: Testing: harness hook semantics must be measured in a real session with the permission mode under test set explicitly; `idle_prompt` during background work and the silent approval (#1851) surfaced only there.
- Hot tier unchanged: the lesson is specific to harness-hook work and the existing "verify the real user path end-to-end" hot lesson already covers the cross-cutting part.

## Flaky Tests

- **porch `npm test` check** (whole `packages/codev` suite, porch-run only): failed three times (phase 7 once, phase 8 twice) and passed on the immediate retry each time. Never reproduced in direct runs, porch-shaped replays (detached, stdin ignored, `PROJECT_*` env) or build-then-test replays (7039 pass). Each failing run started within seconds of a git commit. Porch truncates check output, so the failing test was never named. No test was skipped.
- **`packages/codev/src/agent-farm/__tests__/e2e/tower-api.e2e.test.ts`**, 3 tests in "POST /api/terminals with workspace registration": 500 "nodePty.spawn is not a function". Pre-existing and machine-local: a fresh detached worktree of `origin/main` (51fbbcb17), built on this machine, fails the same 3 tests the same way, while GitHub CI (Linux) passes the suite on main. Manual probes of the same requests outside vitest return 201. Not skipped; PR CI settles it for this head.
- **apps/vscode `vscode-test`**: cannot launch Electron in this environment; the vitest unit suites (1265) are green.

## Follow-up Items

- #1851: a signal for an approved permission (or a PreToolUse-to-PostToolUse bound) so an approved long tool reads `working`.
- #1852: dashboard Needs Attention should keep agent rows when the PR fetch fails.
- #1796: Codex lifecycle reporter.
- Mailbox render gate (#1590, the #1583 family) can consume the same turn-ended events from the store instead of screen inference.
- #1855: bounded-relaunch guard in the baked builder loop, so a deleted hooks directory cannot crash-loop every 2 s.
- #1856: serve a dropped architect session as `dead` instead of dropping it from the overview.
- #1857: Stream Deck face renders the served needs-input, idle and dead states.
