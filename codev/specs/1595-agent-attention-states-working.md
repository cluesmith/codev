# Specification: Agent attention states from harness lifecycle signals

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
-->

## Problem Statement

Codev's attention surfaces (VS Code status bar and activity badge, the Builders and Tower sidebar views, the contextual panel, the web dashboard's builder cards) answer one question for a human running a fleet: **which agents need me right now?** Today the answer is assembled from two signals of very different quality:

- **blocked** comes from porch `status.yaml` (a gate that is pending and requested). This is ground truth, with known limits (the `GATE_LABELS` allowlist, the #1446 stale-post-merge class).
- **waiting** is pure inference: the agent's PTY has produced no output for more than 5 minutes, and it is not blocked or complete.

The inference is wrong in exactly the cases that matter:

1. **A session halted at a permission prompt is waiting for input now, but shows active.** It shows active for at least 5 minutes, and often indefinitely, because prompt repaints keep the output timestamp fresh. On 2026-09-03 multiple sessions across workspaces sat on permission confirmations with no attention signal anywhere. This is the most attention-worthy state and the one the heuristic misses.
2. **A working agent in a long silent stretch shows waiting.** A long test run, a background task, or a slow tool call trips the 5-minute threshold: a false alarm.
3. **A dead session is indistinguishable from a paused one.** When the agent process is gone but the session wrapper survives (or the session is dropped), the builder shows either "waiting" or nothing at all.
4. **Different "your move" situations look identical.** A question prompt, a turn that ended normally, and a half-typed operator draft are indistinguishable.

The harness knows each of these facts about itself authoritatively. Screen-scraping terminal timing to guess at them is the same disease as #1590: a delivery or UI layer inferring what the harness can simply report.

**Who is affected:** the human operator running architects and builders across workspaces (missed permission prompts stall lanes for hours; false "waiting" alarms train the operator to ignore the count), and downstream consumers that need a trustworthy per-agent state: #1672 (Lane Card ball-owner chain) and later the mailbox render gate (#1590 / #1583 family).

## Current State

- **Waiting predicate.** `isIdleWaiting` in `packages/sdk/src/builder-helpers.ts`: false if blocked, complete/verified, or no `lastDataAt`; otherwise true when `now - lastDataAt > 5 min`. `deriveAttention` builds the `AttentionSummary` (pending gates, waiting, held mail, queued feedback); `compareAttention` orders workspaces by urgency bucket.
- **Consumers.** The VS Code extension (status bar, activity badge, Builders view sort and row icons, group rollups, Tower view, contextual panel) and the web dashboard (`BuilderCard` "Waiting on input") all consume `blocked` plus `isIdleWaiting` / `deriveAttention`. The predicate is already shared in the sdk; the input it reads is the problem.
- **Signal source.** `lastDataAt` is stamped by the shellper on every PTY output byte, relayed through the Tower client into `PtySession`, and copied into `OverviewBuilder.lastDataAt` by the overview route. It measures output, not intent: spinners, cursor repaints and prompt redraws all count as activity.
- **Liveness.** No agent liveness reaches the overview. A builder's PTY runs codev's bash launch loop. When the agent exits cleanly, the loop waits at a "Press Enter to relaunch" prompt, so the PTY stays alive and Tower observes nothing; when it crashes, the loop relaunches it. An architect's PTY runs the agent directly, so its exit drives Tower's restart wait. When a session is permanently dropped, the builder simply loses `lastDataAt` (null), which the predicate treats as "not waiting". A dead builder therefore reads as quiet or, at the relaunch prompt, as "waiting" after 5 minutes, indistinguishable from a paused one.
- **Architects.** `ArchitectState` carries no attention fields at all. An architect halted on a permission prompt is invisible to every rollup.
- **Hook channel precedent.** Builders already receive a generated Claude Code `PreToolUse` hook (the worktree write-guard, #1018) through `HarnessProvider.getWorktreeFiles`, written to `.claude/settings.local.json`. The JSON writer shallow-merges, so a second `hooks` block written the same way would clobber the guard (a known deferral from #1018's review). Architects receive no spawn-written settings. Codex and OpenCode harnesses install no hooks.
- **No ingestion path.** No Tower endpoint accepts agent lifecycle events today. Tower authenticates non-public routes with the local key (`codev-tower-key` header, key at `~/.agent-farm/local-key`).

## Desired State

Each spawned agent session whose harness supports lifecycle signals **reports its own state** to Tower at the moment it changes. Tower persists the latest state per agent, fuses it with porch's `blocked` and its own process-liveness knowledge, and serves one authoritative state per agent on the overview. All attention surfaces read it through the single shared sdk predicate. Sessions that cannot report fall back to today's PTY-silence heuristic, unchanged.

What the operator sees:

- An agent at a permission prompt shows as **needs input** within seconds, with what it is asking about (for example "at a permission prompt: Bash(pnpm test ...)"), not after 5 minutes or never.
- An agent whose turn ended shows as **idle** (your move) within seconds: the 5-minute lag is gone.
- An agent running a long silent tool call or waiting on its own background task stays **working**: no false alarm.
- An agent whose process has exited shows as **dead**, distinct from idle and from needs-input.
- Gate-blocked agents keep showing **blocked** exactly as today.
- Architects report and are served the same way as builders, and an architect stuck at a prompt or dead appears in the rollups.

The state vocabulary and its row shape are a wire contract in `@cluesmith/codev-types`, so #1672's ball-owner chain and the future mailbox render gate consume the same signal instead of inventing a parallel one.

## Success Criteria

"Served" means present on the overview response. "Visible" means rendered on the extension and dashboard surfaces; Tower pushes its existing `overview-changed` SSE event on every served-state change, so visible normally follows served within 5 seconds, with the extension's 20-second overview poll as the worst case if an SSE event is missed.

Functional (each verified against a real spawned Claude session, not only unit tests):

- [ ] **SC1 needs-input.** When a spawned Claude builder or architect stops at a permission prompt, the overview serves `needs-input` for that agent within 5 seconds, carrying the tool name and a bounded summary (see the Contract Surface limits). The extension status bar and activity badge count it with no 5-minute threshold.
- [ ] **SC2 question.** When the agent asks the user a question (AskUserQuestion, or an MCP elicitation dialog), the served state is `needs-input` with kind `question` within 5 seconds.
- [ ] **SC3 resume.** After the operator approves a prompt or answers a question, the served state returns to `working` within 5 seconds of the approved tool completing (or the answer being submitted). After the operator **denies** a prompt, the turn ends with no further hook event (verified); the agent stays `needs-input` until the operator's next prompt, which is accurate: the agent is waiting on the operator.
- [ ] **SC4 idle.** When a turn ends normally with no background work, the served state is `idle` within 5 seconds and counts as waiting immediately.
- [ ] **SC5 no false alarm.** A turn that runs a single tool call silently for more than 5 minutes stays `working` for the whole duration. A turn that ends while the agent still has its own background tasks running is served as `working` until the background work resumes the agent and its next turn ends (verified: task completion starts a new turn), bounded by the background-work staleness limit.
- [ ] **SC6 no stuck working.** If the turn-ending signal is never received (operator interrupt, which fires no hook; or a report lost while Tower was unreachable), a served `working` stops suppressing the waiting predicate once the agent's terminal has been silent past today's 5-minute threshold. The behavior in this case is never worse than today's.
- [ ] **SC7 dead.** For every harness, when the agent process is gone but the agent is not complete, the overview serves `dead` within 15 seconds. "Gone" covers: the agent exited and the builder's launch loop is waiting at its relaunch prompt; an architect's agent exited and its session is in restart wait; the session was dropped. A routine context reset (`/clear`, compaction, resume) never produces `dead`. A dead agent is rendered distinctly from idle and needs-input on the extension builder row and the dashboard card.
- [ ] **SC8 blocked unchanged.** Porch-blocked builders continue to be served and counted as `blocked`, with the same gate label and since-time as today.
- [ ] **SC9 fallback.** A Codex or OpenCode builder (no lifecycle reporter) produces exactly today's waiting behavior from PTY silence, plus SC7's dead detection. A Claude session spawned before this change (no reporter) behaves the same way.
- [ ] **SC10 one predicate.** Every attention consumer (extension status bar, badge, Builders view, group rollups, Tower view, contextual panel, dashboard card) derives waiting / needs-input / idle / dead through the one shared sdk predicate; no surface contains its own `lastDataAt` threshold logic for agents.
- [ ] **SC11 persistence.** Reported state is persisted in `global.db` and survives a Tower restart; after restart, liveness is re-evaluated before a persisted state is served.
- [ ] **SC12 guard intact.** The worktree write-guard still denies an out-of-worktree Write in a builder spawned with the reporter (both hook sets fire).
- [ ] **SC13 architects.** An architect at a permission prompt, or whose agent is dead, appears in the attention rollups (status bar count, Tower view) under its architect name. An idle architect does not.
- [ ] **SC14 completion.** A builder whose porch phase is `complete` or `verified` is never counted as waiting or dead, whatever its reported or liveness state.

Non-functional:

- [ ] **SC15 fail-open.** With Tower stopped, unreachable, or hanging, a reporting session's turns, tool calls and prompts are not delayed (the reporter runs asynchronously from the harness's turn), nothing is printed into the TUI, no permission decision is ever made, and no report is retried. A missing reporter script also fails silently.
- [ ] **SC16 validation and auth.** The ingestion endpoint rejects requests without a valid local key; payloads that fail the contract (unknown event, field over its limit, body over its limit); and reports naming an agent Tower does not currently know in that workspace.
- [ ] **SC17 ordering.** Late or reordered reports never regress the served state: a report whose hook time is older than the stored one is ignored; a report from an older session never supersedes the current one; a report timestamped implausibly far in the future is rejected.
- [ ] **SC18 boundaries.** The enum and row shapes live in `codev-types`; fusion and precedence policy live in core/Tower; the sdk predicate is environment-agnostic. Existing boundary tests pass.
- [ ] **SC19 rendering safety.** The needs-input summary is rendered as plain text on every surface (never as Markdown that can carry command links), with control characters removed.

## Constraints

From the issue (fixed, restated):

1. **Harness neutrality.** Hook installation and event vocabulary route through `HarnessProvider`. A harness without lifecycle hooks falls back to the current PTY heuristic. No Claude-specific behavior hardcoded outside the provider. Tower and the wire contract speak a harness-neutral event vocabulary; translation from Claude hook names happens inside the Claude provider's reporter.
2. **State vocabulary is a wire contract.** The agent-state enum (working / needs-input / idle / blocked / dead) and its row shape are declared in `codev-types`; policy stays in core. The contract sections of this spec route through the main architect seat before the plan gate.
3. **Fail-open reporter.** A hook that cannot reach Tower must not block or slow the session: async, short timeout, no retries in the hot path.
4. **One shared predicate.** `isIdleWaiting` consumers migrate to the served state without per-surface drift: one shared predicate in sdk `builder-helpers`.
5. **Merge, never clobber.** Spawn-injected settings must merge with, not clobber, the existing write-guard hook block.

From the owner ruling on the issue (2026-10-05):

6. **#1595 ships before #1672** and owns the enum and row shape. #1672's ball-owner module later maps onto this enum; this project does not pre-build #1672's module.
7. **Mechanism is harness settings hooks** injected at spawn through `HarnessProvider`. The in-process "mods" reporter (#1761) is out of scope; if adopted later it is a second reporter implementation behind the same seam and the same contract.
8. **The mailbox render gate is a future consumer**, not part of this build. The plumbing must allow it to consume the same events later without a parallel channel.

From the system:

9. Server/client isolation (#1189): core and sdk never import each other; both import only `codev-types`; the sdk stays environment-agnostic.
10. State lives in `~/.agent-farm/global.db` via the versioned migration runner; never written by hand.
11. Tower's `afx send` mailbox and render gate are untouched by this project.

## Assumptions

**Verified empirically on Claude Code 2.1.289 (2026-10-05, live interactive session in tmux, every hook `async: true`):**

- Hooks supplied with the `--settings` launch flag and hooks in the worktree's `.claude/settings.local.json` both fire for the same event (they concatenate). Async command hooks do not hold up the turn.
- **Permission prompt:** `PreToolUse` fires, then `PermissionRequest` about 10 ms later, while the prompt is on screen. `Notification(permission_prompt)` follows about 6 seconds later. `PermissionRequest` is therefore the instant signal; the notification is a redundant second chance.
- **Approve:** the approved tool's `PostToolUse` fires on completion, then normal turn events.
- **Deny:** the turn ends ("Interrupted · What should Claude do instead?") with **no** `Stop`, **no** `PermissionDenied`, and **no** `idle_prompt` even 70 minutes later.
- **Normal turn end:** `Stop` fires immediately; `Notification(idle_prompt)` fires exactly 60 seconds after it.
- **Background work:** a `Stop` while a background task runs carries a non-empty `background_tasks` list; when the task completes, the harness starts a new turn (`UserPromptSubmit`) that ends with a `Stop` carrying an empty list.
- A message queued while the agent is mid-turn fires `UserPromptSubmit`.
- **TUI output while working:** during a running foreground tool call the TUI repaints its elapsed-time counter every second, so PTY output stays fresh while a turn is genuinely in progress. The screen is static while the agent sits at a permission prompt or an empty composer.

**From the documentation, to be confirmed during implementation:**

- `Stop` does not fire on a user interrupt (Esc). The deny case above is consistent with this. The interrupt and `/clear` keystrokes could not be exercised reliably in the spike (the test session's vim-mode composer consumed them), so they are verification items, not design dependencies: the design does not rely on any event for either.
- `SessionStart` fires with a `source` of `startup`, `resume`, `clear` or `compact`, giving a new session id on context reset. `SessionEnd` also fires on `/clear`, which is why `SessionEnd` is not used as a death signal.
- Hook payloads carry `session_id`, `cwd`, `hook_event_name`, and for tool events `tool_name` and `tool_input`; Notification carries `notification_type`.

**System facts (verified in the tree):**

- A builder's PTY child is codev's generated bash launch loop, not the agent. When the agent exits cleanly, the loop waits at a "Press Enter to relaunch" prompt, so the PTY does not exit and Tower sees no EXIT frame. Liveness of the **agent** therefore requires looking at the process tree under the session, which has in-repo precedent (descendant collection in `afx tower`). An architect's PTY child is the agent itself, so its exit is observed by the existing exit and restart-wait path.
- Tower already broadcasts an `overview-changed` SSE event that the extension and dashboard consume; the overview's forge cache is unrelated to agent state and need not be invalidated.
- Sessions spawned before this change keep running without the reporter until resumed or respawned; they fall back cleanly.
- `~/.agent-farm/local-key` is readable by the user's own processes, including hook processes the harness spawns.

## Solution Approaches

The design has three independent choices: how events leave the harness (transport), how the hook set is installed (injection channel), and how state is computed and served. Approaches are given per choice; the recommended combination follows.

### Approach 1 (recommended transport): generated reporter script as an async command hook, posting a harness-neutral event to a Tower ingestion endpoint

The Claude provider generates a small dependency-free Node script (same shape as the write-guard script). Each configured hook invokes it with `async: true` and a short `timeout`. The script reads the hook payload from stdin, translates it to a neutral event (`session-started`, `turn-started`, `tool-activity`, `needs-input`, `turn-ended`), stamps it with the time the hook ran, reads the local key, POSTs once to Tower with a sub-second deadline, and exits 0 with no stdout regardless of outcome. Agent identity (workspace path and agent id) is baked into the hook command at spawn, as the guard bakes `CODEV_WORKTREE_ROOT`; the harness session id comes from the payload.

- **Pros:** fail-open by construction (async; Tower down is an immediate refused connection; no stdout means no permission decision); the key is never written into settings or exported into the agent environment; translation lives inside the provider, so Tower stays harness-neutral; proven seam (#1018).
- **Cons:** one short-lived Node process per reported event. `PostToolUse` must fire for every tool (it is the only resume signal after an approval), so tool-heavy turns spawn one async process per tool call. Mitigated from the start: `PreToolUse` is matched to the question tool only, and Tower ignores reports that do not change the served state.
- **Risk/complexity:** Low-Medium.

### Approach 2 (transport): Claude's native `http` hook type posting directly to Tower

Claude Code supports `"type": "http"` hooks that POST the raw payload to a URL.

- **Pros:** no process spawn per event.
- **Cons:** Tower would receive Claude's raw hook vocabulary (harness-specific parsing moves into Tower, violating constraint 1); the auth header must come from an environment variable, so the local key would have to be exported into the agent's environment or written into settings; the response body is interpreted by the harness as a hook decision, so a Tower bug could influence permission flow; async behavior for http hooks is not documented, so a hanging Tower could stall a turn up to the timeout.
- **Risk/complexity:** Medium. Rejected on constraints 1 and 3.

### Approach 3 (transport): Tower tails the harness's session transcript files

- **Pros:** no injection at all; covers architects and pre-existing sessions.
- **Cons:** couples Tower to an undocumented internal file format of one harness; polling latency; does not see permission prompts (they are not transcript entries until resolved). Already rejected for the same reasons in the mobile AskUserQuestion research.
- **Risk/complexity:** Medium-High. Rejected; may serve later as a stopgap emitter behind the same contract.

### Approach 4 (transport): sharpen the PTY heuristic

Parse prompt rendering or tune thresholds.

- **Cons:** this is the disease, not the cure (#1590). Rejected; the existing heuristic stays only as the fallback.

### Approach A (recommended injection channel): the `--settings` launch flag through `HarnessProvider`

The Claude provider adds the reporter hook set as a `--settings` launch argument on every launch form it builds: builder script, architect spawn, and resume. The flag accepts a file path or inline JSON; a codev-owned settings file is preferred over inline JSON to avoid shell-quoting a multi-hook document in generated scripts (the plan decides the location). The reporter script likewise lives in a codev-owned location the hook command references.

- **Pros:** one channel for builders **and** architects (architects have no worktree to write into, and writing `.claude/settings.local.json` in the main checkout would also hook the human's own sessions there); never touches `settings.local.json`, so the write-guard block cannot be clobbered (constraint 5 satisfied structurally, with hook concatenation verified empirically); naturally re-applied on resume; harnesses without the capability simply contribute nothing.
- **Cons:** depends on `--settings` hook concatenation holding in future Claude Code versions (mitigated by a test that asserts both the guard and the reporter fire); the reporter script location must survive package upgrades or fail open silently when missing.
- **Risk/complexity:** Low.

### Approach B (injection channel): extend the worktree `settings.local.json` with a deep merge of `hooks`

Fix the shallow-merge writer to deep-merge `hooks` arrays, then add the reporter block alongside the guard.

- **Pros:** reuses the exact #1018 path; constraint 5 addressed by the merge fix.
- **Cons:** builders only. Architects would need either no coverage or a settings file in the main checkout that hooks the human's own sessions. Re-spawn/merge idempotence (no duplicate reporter entries across resumes) becomes a new correctness concern.
- **Risk/complexity:** Medium. Rejected in favor of A; acceptable fallback if `--settings` concatenation proves unreliable.

### State computation and serving (single recommended design; alternatives noted)

**Reported activity (from the reporter).** Tower persists, per agent (keyed by workspace path and agent id) in a new `global.db` table: the current harness session id, the reported activity (`working`, `needs-input` or `idle`), when that activity began, the hook time of the latest accepted report, whether background work is pending, and the needs-input detail while (and only while) the activity is `needs-input`. Ordering rules (SC17): a report is accepted only if its hook time is not older than the stored one; a report carrying a different session id supersedes the stored session only when its hook time is newer, so a delayed report from an old session can never take over; a hook time more than 60 seconds ahead of Tower's clock is rejected. Reporter and Tower run on the same machine and clock; reports from one turn are separated by tool or model latency (tens of milliseconds at the very least, per the spike), and two reports close enough to race carry the same state.

**Liveness (from Tower, harness-neutral).** Tower determines whether the agent process is alive, for any harness: for a builder, whether its launch loop currently has an agent process running beneath it (process-tree inspection, since the loop itself stays alive at its relaunch prompt); for an architect, whether its session is running rather than in restart wait; and for any agent, whether it has a session at all. A transient gap (the launch loop's 2-second relaunch pause) must not flash `dead`: dead is declared only after the agent has been gone for a short confirmation interval within the 15-second budget (SC7). Lifecycle reports never declare death. `SessionEnd` is not reported, because it also fires on `/clear`, which codev itself sends during context refreshes. A routine reset shows up as a new session id via `session-started`.

**Served state (projection, policy in core).** Computed at serve time, first match wins:

1. `blocked`: porch reports a requested, pending gate (unchanged logic).
2. `dead`: the agent is not alive and the builder is not `complete` or `verified`. A complete or verified builder whose agent has exited is the normal end of a lane, not an alert (SC14).
3. The reported activity: `needs-input`, `working` or `idle`.
4. Otherwise `null` (unknown).

A pending gate is the human's move whatever the process state, and existing gate counts must not regress (SC8). Dead outranks reported activity because a dead process's last report is stale by definition. The served row also carries the raw inputs (liveness, reported activity, its report time, background-work flag), so #1672 can build its own chain from the same facts without re-deriving them.

**Staleness of `working` (sdk predicate, client clock).** The spike showed the TUI repaints continuously while a turn is in progress and goes still at a prompt. So a reported `working` is trusted only while the agent's PTY output is fresher than today's 5-minute waiting threshold. Past that, the predicate treats the agent as waiting, exactly as today. This covers interrupts (no hook fires) and reports lost while Tower was down (SC6), and the long silent tool call is unaffected because its counter keeps repainting (SC5). A `working` that comes from background work pending after a `Stop` sits at a still prompt by design, so it gets a longer bound of 30 minutes since the report before the predicate falls back to waiting. `needs-input` and `idle` need no staleness rule: both are already "your move", and the next prompt or turn moves them.

**Waiting predicate (one shared sdk predicate, SC10).** For a builder that is not complete or verified, it counts as waiting when the served state is `needs-input`, `idle` or `dead`, or when the state is a stale `working`. When the served state is `null`, it falls back to today's PTY-silence rule unchanged. `blocked` keeps its own gate path. Consumers keep calling the one predicate and the summary derivation built on it; none reads `lastDataAt` thresholds directly.

**Push and future consumers.** On every served-state change Tower emits its existing `overview-changed` SSE event, so surfaces refetch within seconds. No cache invalidation is needed, because agent rows are projected per request and the overview cache holds forge lists only. Tower also raises the change as an in-process event so a future mailbox render gate can subscribe (constraint 8); nothing subscribes in this project.

**Identity binding.** The ingestion endpoint accepts a report only for an agent Tower currently knows in that workspace (a registered builder or a live architect). Any process holding the local key can still report for any known agent. That risk is accepted: the same key already grants strictly more power (writing to terminals, sending messages), so state spoofing adds no capability.

*Alternative considered:* Tower computes the PTY fallback and staleness too, and always serves a state. Rejected: the fallback is relative to the viewer's clock and already lives in the sdk; moving it would change every consumer's timing semantics for no gain.

### Recommended combination

Approach 1 (async command-hook reporter, neutral events, Tower ingestion endpoint), with Approach A (`--settings` through `HarnessProvider`, builders and architects) and the state computation above. Codex and OpenCode providers do not implement the reporter capability. They get Tower-side dead detection and the PTY fallback for everything else.

## Contract Surface (for main architect review before the plan gate)

Declared in `@cluesmith/codev-types`. Shapes are normative in meaning; exact identifier spelling is settled with main.

- **`AgentState`** = `'working' | 'needs-input' | 'idle' | 'blocked' | 'dead'`.
- **`AgentActivity`** (the reported subset) = `'working' | 'needs-input' | 'idle'`.
- **`NeedsInputDetail`** = `{ kind: 'permission' | 'question' | 'other'; tool?: string; summary?: string }`. Limits: `tool` at most 64 characters; `summary` at most 200 characters, single line, control characters removed, built by the reporter from the tool's primary argument (for example a command's text or a file path). No secret redaction is attempted; the summary is in the same local-key trust domain as the terminal output Tower already streams. It is held only for the current needs-input episode and cleared when the activity changes. Surfaces render it as plain text (SC19).
- **Served row**, on `OverviewBuilder` and on `ArchitectState`:
  `agentState: { state: AgentState; since: string /* ISO */; source: 'harness' | 'tower'; alive: boolean | null; activity: AgentActivity | null; activityAt: string | null /* hook time of the latest accepted report */; backgroundWork: boolean; needsInput?: NeedsInputDetail } | null`.
  `source: 'harness'` means `state` came from a lifecycle report. `'tower'` means it came from porch or liveness. `null` means unknown, and consumers use the PTY fallback. `alive: null` means liveness could not be determined. Existing fields (`blocked`, `blockedGate`, `blockedSince`, `lastDataAt`) are unchanged. `ArchitectState` additionally needs `lastDataAt` for the staleness rule.
- **Ingestion event** (reporter to Tower): `{ workspacePath: string; agentId: string; sessionId: string; event: 'session-started' | 'turn-started' | 'tool-activity' | 'needs-input' | 'turn-ended'; at: number /* epoch ms when the hook ran */; needsInput?: NeedsInputDetail; backgroundWork?: boolean }`. Limits: `agentId` and `sessionId` at most 128 characters, `workspacePath` at most 4096, request body at most 8 KB. Harness-neutral: no Claude hook names cross the wire.
- **Tower API:** one authenticated POST ingestion route accepting the event above (local-key auth, strict validation, known-agent binding, 2xx with an empty body; the reporter ignores the response). No new read route; the state is served on the existing overview responses, and changes are announced with the existing `overview-changed` SSE event.
- **`HarnessProvider`:** one new optional capability through which a provider contributes lifecycle-reporter launch injection to builder, architect and resume launches. Providers that omit it get the fallback.
- **`AttentionSummary`:** `WaitingItem` gains an optional `state` so surfaces render needs-input, idle and dead distinctly. A new `architects` list carries architect attention items, `{ architect: string; state: 'needs-input' | 'dead'; since: string | null }`. A separate list is used because the existing item types are builder-shaped (builder id, issue id and title). `isEmpty` and the urgency ordering account for it, with architect items in the same bucket as waiting builders.

Claude hook to neutral event mapping (internal to the Claude provider, listed for review):

| Claude hook (matcher) | Neutral event | Resulting activity |
|---|---|---|
| `SessionStart` (any source) | `session-started` | idle (new session id) |
| `UserPromptSubmit` | `turn-started` | working |
| `PostToolUse` (all tools) | `tool-activity` | working (clears needs-input after an approval or answer) |
| `PreToolUse` (question tool only) | `needs-input` (question) | needs-input |
| `PermissionRequest` | `needs-input` (permission, tool, summary) | needs-input |
| `Notification` (`permission_prompt`) | `needs-input` (permission) | needs-input (redundant second chance) |
| `Notification` (`elicitation_dialog`) | `needs-input` (question) | needs-input |
| `Notification` (`idle_prompt`) | `turn-ended` | idle (redundant second chance, 60 s after `Stop`) |
| `Stop` | `turn-ended` with `backgroundWork` | idle, or working while background tasks remain |
| `SessionEnd` | not reported | (fires on `/clear`; death comes from liveness) |

## Decisions for the owner at the spec gate

The spec adopts these defaults. SC4, SC13 and the predicate are written to them, and the owner may overrule any of them at the gate.

1. **Architects in rollups:** architect `needs-input` and `dead` are counted; architect `idle` is not (an idle architect is the normal resting state and would pin the count above zero).
2. **Immediate idle:** a builder's definitive turn end counts as waiting immediately; removing the 5-minute lag is the point of the issue. Accepted cost: the count can flicker during short autonomous pauses between porch steps. Surfaces render idle distinctly from needs-input, so the operator can tell "turn over" from "stuck at a prompt".
3. **Dead counts as waiting**, rendered distinctly, with no new top-level summary field for builders.

## Open Questions

**Critical (blocks progress)**

- **Contract sign-off by the main architect seat.** The Contract Surface section goes to main before the plan gate (owner ruling). Identifier names may change; the meaning should not.

**Important (shapes design)**

- None remaining. The spike resolved the event semantics. Reporter script location and upgrade behavior are plan-level choices bounded by SC15 (it must be codev-owned, and a missing script must fail silently).

**Nice-to-know**

- Whether per-tool `PostToolUse` reporting is measurable on very tool-heavy turns. If it is, the reporter can skip a POST when its session's previous report was already `working`, using a small marker file.
- Whether the Codex turn-complete notification can become a second reporter later. That is out of scope, and the seam allows it.

## Test Scenarios

Unit (core / sdk):

1. Projection: every combination of gate pending × alive × reported activity × completion phase yields the documented served state; complete and verified builders never project `dead`.
2. Ingestion: a valid event persists. Unauthenticated, malformed, unknown-event, over-limit field, over-limit body, and unknown-agent reports are rejected. Older-hook-time, older-session and far-future reports are ignored or rejected per SC17.
3. sdk predicate: served `needs-input`, `idle` and `dead` count as waiting immediately; `working` with fresh PTY output never does; `working` with PTY silence past the threshold does; background-work `working` holds for its longer bound, then does; a `null` served state reproduces today's 5-minute behavior exactly (regression fixtures from the current tests); complete and verified builders never count.
4. Attention summary: architect needs-input and dead items appear in the architect list and sort in the waiting bucket; architect idle does not appear.
5. Reporter translation: each Claude hook payload fixture (Stop with and without background tasks, every Notification type in the table, PermissionRequest with Bash and Write inputs, PreToolUse for the question tool, SessionStart sources) maps to the expected neutral event with limits applied. The script exits 0 with empty stdout when Tower is down, slow, or returns an error, and when its input is malformed.
6. Migration: fresh and existing `global.db` both end with the new table; existing tables untouched.
7. HarnessProvider: Claude builder, architect and resume launch forms all include the reporter injection; Codex, OpenCode and custom providers include none.
8. Liveness: a launch loop with no agent child, an architect in restart wait, and a dropped session each yield not-alive; the relaunch pause shorter than the confirmation interval does not.

Integration and real-path, derived from the operator's actions and run against real spawned sessions:

9. Spawn a Claude builder and have it run a command that needs permission: `needs-input` with tool and summary is served within 5 s and the status bar count increments. Approve: back to `working`. Deny: stays `needs-input`; the next prompt moves it to `working`.
10. The agent asks a question: `needs-input` (question). Answer: `working`.
11. A turn ends: `idle` within 5 s.
12. A foreground tool call silent for more than 5 minutes stays `working`.
13. A turn ends with a background task running: `working` until the task completes and the follow-up turn ends, then `idle`.
14. Interrupt with Esc mid-turn: served `working` stops suppressing the waiting count once the terminal has been silent 5 minutes (confirm, as a side observation, that no hook fires).
15. `/clear` or a codev context refresh in a live session: never served `dead`; the new session id takes over.
16. Exit the agent in a builder (the launch loop waits at its relaunch prompt): `dead` within 15 s, rendered distinctly on the extension row and dashboard card. Press Enter to relaunch: no longer dead.
17. Stop Tower and keep working in the session: no visible delay or TUI noise. Restart Tower: the next report restores the served state, and persisted state survives the restart with liveness re-evaluated.
18. Codex builder: waiting behavior identical to today; exiting its agent yields `dead`.
19. Builder with the reporter: the write-guard still denies an out-of-worktree Write.
20. Architect at a permission prompt: `needs-input` served on `ArchitectState` and counted in the rollup under its name.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| A future Claude Code release stops concatenating `--settings` hooks with local settings | Low | High (guard or reporter silently lost) | Test 19 asserts both fire; Approach B is a documented fallback channel |
| Reporter slows or blocks turns (Tower hung) | Low | High | `async: true`, short hook timeout, sub-second request deadline, no retries, exit 0 always (SC15, test 17) |
| Stuck `working` when no turn-ending event arrives (interrupt, lost report) | Medium | Medium | PTY-staleness rule, never worse than today (SC6); the 60 s `idle_prompt` gives lost turn ends a second chance |
| Hook semantics change across Claude Code versions | Medium | Medium | Translation is isolated in the Claude provider's reporter with payload fixtures; the PTY fallback still applies to anything unreported |
| False `dead` during the relaunch pause or a context refresh | Medium | Medium | Confirmation interval before declaring dead; `SessionEnd` deliberately unused (test 8, test 15) |
| Process-tree inspection cost across a large fleet | Low | Low | Bounded cadence within the 15 s budget; plan sizes it |
| Stale state served after Tower restart or session respawn | Medium | Medium | Hook-time ordering, session supersession, liveness re-evaluated before serving persisted state (SC11, SC17) |
| Command summaries leak sensitive text to surfaces | Low | Medium | 200-character single-line bound, held only for the episode, same local-key trust domain as streamed terminal output, plain-text rendering |
| State spoofing by a local process holding the key | Low | Low | Known-agent binding; accepted residual, since the key already grants more power |
| Count flicker from immediate `idle` on short autonomous pauses | Medium | Low | Owner decision 2; idle rendered distinctly from needs-input |
| Divergence with #1672's chain | Low | Medium | #1672 consumes this enum and the raw inputs carried on the served row |

## References

- Issue #1595 (this work) and its 2026-10-05 owner ruling comment; 2026-09-28 re-scope proposal (superseded on ordering)
- #1672 Lane Card (future consumer of the enum), #1761 Claude Code mods (future second reporter)
- #1590, #1583 (render-gate family: future consumer of the same events), Spec 1313 (mailbox-first delivery; its rejection of hooks as a *delivery* channel is a different concern from state reporting)
- #1446 (stale porch status), #1566 (`compareAttention` / Tower sidebar), #1189 (server/client isolation)
- #1018 / #1536 (worktree write-guard: the settings-injection precedent)
- `codev/research/mobile/decisions/askuserquestion-detection.md` (hook emission with a harness-neutral Tower contract)
- Claude Code hooks reference (events, Notification types, async and http hook handlers)
