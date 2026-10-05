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
- **Liveness.** No child-process liveness reaches the overview. The shellper knows its child's PID and broadcasts an EXIT frame when the child exits; Tower's session layer tracks only the shellper PID. With auto-restart, an exited agent sits in a restart wait; when a session is permanently dropped, the builder simply loses `lastDataAt` (null), which the predicate treats as "not waiting". A dead builder therefore reads as quiet.
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
- Architects report and are served the same way as builders.

The state vocabulary and its row shape are a wire contract in `@cluesmith/codev-types`, so #1672's ball-owner chain and the future mailbox render gate consume the same signal instead of inventing a parallel one.

## Success Criteria

Functional (each verified against a real spawned Claude session, not only unit tests):

- [ ] **SC1 needs-input.** When a spawned Claude builder or architect stops at a permission prompt, the overview serves `needs-input` for that agent within 5 seconds, carrying the tool name and a bounded command/argument summary. The extension status bar and activity badge count it immediately (no 5-minute threshold).
- [ ] **SC2 question.** When the agent asks the user a question (AskUserQuestion / elicitation), the served state is `needs-input` with a question kind, within 5 seconds.
- [ ] **SC3 resume.** After the operator answers the prompt or question, the served state returns to `working` within 5 seconds of the agent's next tool activity.
- [ ] **SC4 idle.** When a turn ends normally, the served state is `idle` within 5 seconds and counts as waiting immediately.
- [ ] **SC5 no false alarm.** A turn that runs a single tool call silently for more than 5 minutes stays `working` for the whole duration; a turn that ends while the agent has its own background tasks running is served as `working`, not `idle`.
- [ ] **SC6 interrupt.** When the operator interrupts a turn (Esc), the agent is served as `idle` (or `needs-input`) within the harness's idle-notification window plus 5 seconds, never stuck at `working` indefinitely.
- [ ] **SC7 dead.** When the agent process exits while its session wrapper is alive (or the session is dropped while the builder is not complete), the overview serves `dead` within 15 seconds, for every harness (liveness is harness-neutral). A dead agent is rendered distinctly from idle and needs-input on the extension builder row and the dashboard card.
- [ ] **SC8 blocked unchanged.** Porch-blocked builders continue to be served and counted as `blocked`, with the same gate label and since-time as today.
- [ ] **SC9 fallback.** A Codex or OpenCode builder (no lifecycle hooks) produces exactly today's waiting behavior from PTY silence, plus SC7's dead detection. A Claude session spawned before this change (no reporter) also falls back.
- [ ] **SC10 one predicate.** Every attention consumer (extension status bar, badge, Builders view, group rollups, Tower view, contextual panel, dashboard card) derives waiting/needs-input/idle/dead through the one shared sdk predicate; no surface contains its own `lastDataAt` threshold logic for agents.
- [ ] **SC11 persistence.** Reported state is persisted in `global.db` and survives a Tower restart; after restart, liveness is re-evaluated before a persisted non-dead state is served.
- [ ] **SC12 guard intact.** The worktree write-guard still denies an out-of-worktree Write in a builder spawned with the reporter.

Non-functional:

- [ ] **SC13 fail-open.** With Tower stopped, unreachable, or hanging, a reporting session's turns, tool calls and prompts are not delayed by more than a negligible amount (the reporter never blocks the harness's turn), print nothing into the TUI, never make a permission decision, and never retry.
- [ ] **SC14 auth.** The ingestion endpoint rejects requests without a valid local key, and rejects payloads that do not validate against the contract (unknown event, oversize fields).
- [ ] **SC15 ordering.** Out-of-order or late reports (async hooks racing) never regress the served state: a report older than the stored one for the same session is ignored, and reports from a superseded session are ignored.
- [ ] **SC16 boundaries.** The enum and row shape live in `codev-types`; precedence and fusion policy live in core/Tower; the sdk predicate is environment-agnostic. Existing boundary tests pass.

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

- Claude Code exposes the lifecycle hook events this design relies on (`UserPromptSubmit`, `Stop`, `Notification` with `permission_prompt` / `idle_prompt` / `elicitation_dialog` types, `PermissionRequest`, `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`) with `session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input` in the payload. Confirmed against the docs and, for Stop/UserPromptSubmit, empirically on 2.1.289. The Stop payload carries `background_tasks`.
- **Verified 2026-10-05 on Claude Code 2.1.289:** hooks supplied with the `--settings <json>` launch flag and hooks in the worktree's `.claude/settings.local.json` both fire for the same event (they concatenate); `"async": true` command hooks run without blocking the turn.
- Claude Code's `Stop` does **not** fire on a user interrupt; the `idle_prompt` notification fires after the session has been waiting for input for a while (about 60 seconds). SC6 relies on this and must be confirmed empirically during implementation.
- There is no explicit "permission approved" event; the next `PreToolUse`/`PostToolUse` for that session is the resume signal.
- The shellper already knows when its child exits (EXIT frame) and Tower already knows when a session enters a restart wait or is dropped. Dead detection needs that knowledge surfaced, not new process probing.
- Sessions spawned before this change keep running without the reporter until resumed/respawned; they fall back cleanly.
- `~/.agent-farm/local-key` is readable by the user's own processes, including hook processes the harness spawns.

## Solution Approaches

The design has three independent choices: how events leave the harness (transport), how the hook set is installed (injection channel), and how state is computed and served. Approaches are given per choice; the recommended combination follows.

### Approach 1 (recommended transport): generated reporter script as an async command hook, posting a harness-neutral event to a Tower ingestion endpoint

The Claude provider generates a small dependency-free Node script (same shape as the write-guard script). Each configured hook invokes it with `async: true` and a short `timeout`. The script reads the hook payload from stdin, translates it to a neutral event (`turn-started`, `turn-ended`, `needs-input`, `tool-activity`, `session-started`, `session-ended`), reads the local key, POSTs once to Tower with a sub-second deadline, and exits 0 with no stdout regardless of outcome. Agent identity (workspace path and agent id) is baked into the hook command at spawn, as the guard bakes `CODEV_WORKTREE_ROOT`; the harness session id comes from the payload.

- **Pros:** fail-open by construction (async; Tower down is an immediate refused connection; no stdout means no permission decision); the key is never written into settings or exported into the agent environment; translation lives inside the provider, so Tower stays harness-neutral; proven seam (#1018).
- **Cons:** one short-lived Node process per reported event, including every tool call (mitigated: async, matchers limit which tools trigger, and Tower dedups unchanged states).
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

The Claude provider adds the reporter hook set as launch arguments (`--settings <json>`) on every launch form it builds: builder script, architect spawn, and resume. The reporter script is written to a codev-owned location the hook command references.

- **Pros:** one channel for builders **and** architects (architects have no worktree to write into, and writing `.claude/settings.local.json` in the main checkout would also hook the human's own sessions there); never touches `settings.local.json`, so the write-guard block cannot be clobbered (constraint 5 satisfied structurally, with hook concatenation verified empirically); naturally re-applied on resume; harnesses without the capability simply contribute nothing.
- **Cons:** depends on `--settings` hook concatenation holding in future Claude Code versions (mitigated by a test that asserts both the guard and the reporter fire); the reporter script location must survive package upgrades or fail open silently when missing.
- **Risk/complexity:** Low.

### Approach B (injection channel): extend the worktree `settings.local.json` with a deep merge of `hooks`

Fix the shallow-merge writer to deep-merge `hooks` arrays, then add the reporter block alongside the guard.

- **Pros:** reuses the exact #1018 path; constraint 5 addressed by the merge fix.
- **Cons:** builders only. Architects would need either no coverage or a settings file in the main checkout that hooks the human's own sessions. Re-spawn/merge idempotence (no duplicate reporter entries across resumes) becomes a new correctness concern.
- **Risk/complexity:** Medium. Rejected in favor of A; acceptable fallback if `--settings` concatenation proves unreliable.

### State computation and serving (single recommended design; alternatives noted)

- **Tower persists the latest reported activity per agent** in a new `global.db` table keyed by workspace path and agent id, recording session id, reported state, since-time, last event time, and the bounded needs-input detail. Out-of-order and superseded-session reports are discarded (SC15).
- **Liveness is Tower-sourced and harness-neutral**: Tower surfaces whether the agent's child process is alive (child exit observed, restart wait, or session dropped while the builder is not complete).
- **The served state is a precedence projection** computed in core at serve time: `blocked` (porch) first, then `dead`, then the reported activity (`needs-input`, `working`, `idle`), else unknown. The served row also carries the raw inputs (liveness and reported activity) so #1672 can build its own chain from the same facts without re-deriving them.
- **Precedence rationale:** a pending gate is the human's move whatever the process state, and existing gate counts must not regress (SC8); dead beats reported activity because a dead process's last report is stale by definition.
- **State changes push.** Tower invalidates its overview cache and emits its existing refresh notification on every served-state change, so surfaces update within seconds (SC1 to SC4) without polling harder. Tower also exposes the change as an in-process event so a future mailbox render gate can subscribe (constraint 8); no consumer is wired in this project.
- **Fallback lives in the sdk predicate.** Tower serves `null` agent state when it knows nothing beyond the PTY. The shared sdk predicate uses the served state when present and otherwise applies today's 5-minute PTY-silence rule against the client's clock, exactly as now.
- *Alternative considered:* Tower computes the PTY fallback too and always serves a state. Rejected: the fallback is time-relative to the viewer's clock and already lives in the sdk; moving it would change every consumer's timing semantics for no gain.

### Recommended combination

Approach 1 (async command-hook reporter, neutral events, Tower ingestion endpoint) + Approach A (`--settings` through `HarnessProvider`, builders and architects) + the state computation above. Codex and OpenCode providers do not implement the reporter capability; they get dead detection (Tower-side) and PTY fallback for everything else.

## Contract Surface (for main architect review before the plan gate)

Declared in `@cluesmith/codev-types` (shapes are normative in meaning; exact identifier spelling is settled with main):

- **`AgentState`** = `'working' | 'needs-input' | 'idle' | 'blocked' | 'dead'`.
- **Needs-input detail:** `{ kind: 'permission' | 'question' | 'other'; tool?: string; summary?: string }`. `summary` is length-bounded and single-line; it is the same trust domain as terminal output already streamed by Tower.
- **Served row** (on `OverviewBuilder` and on `ArchitectState`): `agentState: { state: AgentState; since: string /* ISO */; source: 'harness' | 'tower'; alive: boolean | null; needsInput?: NeedsInputDetail } | null`. `source: 'harness'` means the activity came from a lifecycle report; `'tower'` means it came from porch or liveness alone. `null` means unknown: consumers use the PTY fallback. Existing fields (`blocked`, `blockedGate`, `blockedSince`, `lastDataAt`) are unchanged.
- **Ingestion event** (reporter to Tower): `{ workspacePath; agentId; sessionId; event: 'session-started' | 'turn-started' | 'tool-activity' | 'needs-input' | 'turn-ended' | 'session-ended'; at: number /* epoch ms at the hook */; needsInput?: NeedsInputDetail; backgroundWork?: boolean }`. Harness-neutral: no Claude hook names cross the wire.
- **Tower API:** one authenticated POST ingestion route accepting the event above (local-key auth, strict validation, 2xx with an empty body; the reporter ignores the response). No new read route: the state is served on the existing overview responses.
- **HarnessProvider:** one new optional capability through which a provider contributes lifecycle-reporter launch injection for builder, architect and resume launches. Providers that omit it get the fallback.
- **`AttentionSummary`:** `WaitingItem` gains an optional state so surfaces can render needs-input, idle and dead distinctly; no new top-level summary field.

Claude hook to neutral event mapping (internal to the Claude provider, listed for review):

| Claude hook (matcher) | Neutral event | Resulting activity |
|---|---|---|
| `SessionStart` | `session-started` | idle |
| `UserPromptSubmit` | `turn-started` | working |
| `PreToolUse` / `PostToolUse` | `tool-activity` | working (also clears needs-input after an approval) |
| `PreToolUse` (AskUserQuestion) | `needs-input` (question) | needs-input |
| `PermissionRequest`, `Notification` (`permission_prompt`) | `needs-input` (permission, tool, summary) | needs-input |
| `Notification` (`elicitation_dialog`) | `needs-input` (question) | needs-input |
| `Notification` (`idle_prompt`) | `turn-ended` | idle (covers interrupts, SC6) |
| `Stop` | `turn-ended` with `backgroundWork` | idle, or working when background tasks remain |
| `SessionEnd` | `session-ended` | dead until a new session starts |

## Open Questions

**Critical (blocks progress)**

- **Contract sign-off by the main architect seat.** The Contract Surface section must be reviewed by main before the plan gate (owner ruling). Identifier names may change; the meaning should not.

**Important (shapes design)**

1. **Do architects enter the rollup counts?** Recommendation: yes for `needs-input` and `dead` (the 2026-09-03 incident included architects), not for `idle` (an idle architect is the normal resting state and would make the count permanently non-zero). Owner to confirm at the spec gate.
2. **Does `idle` count as waiting immediately?** Recommendation: yes for builders (a definitive turn end is the operator's move, and removing the 5-minute lag is the point). Risk: more frequent count flicker during short autonomous pauses between porch steps. Owner to confirm.
3. **Does `dead` count as waiting?** Recommendation: yes, folded into the existing waiting count and rendered distinctly, so no new `AttentionSummary` field is needed. Owner to confirm.
4. **Reporter script location and upgrade behavior** (plan-level, flagged here): it must be codev-owned, stable across package upgrades, or absent-safe (a missing script fails open silently).

**Nice-to-know**

- Per-tool-call reporting cost on very tool-heavy turns; if measurable, restrict `PreToolUse` to the AskUserQuestion matcher and rely on `PostToolUse` for resume.
- Whether Codex's turn-complete notification can become a second reporter later (out of scope; the seam allows it).

## Test Scenarios

Unit (core / sdk):

1. Precedence projection: every combination of blocked × alive × reported activity yields the documented served state.
2. Ingestion: valid event persists; unauthenticated, malformed, unknown-event and oversize payloads are rejected; older-than-stored and superseded-session events are ignored.
3. sdk predicate: served `needs-input`/`idle`/`dead` count as waiting immediately; served `working` never does regardless of `lastDataAt` age; `null` served state reproduces today's 5-minute behavior exactly (regression fixtures from current tests).
4. Reporter translation: each Claude hook payload fixture (including Stop with and without `background_tasks`, Notification types) maps to the expected neutral event; the script exits 0 with empty stdout when Tower is down, slow, or returns an error.
5. Migration: fresh and existing `global.db` both end with the new table; existing tables untouched.
6. HarnessProvider: Claude builder, architect and resume launch forms all include the reporter injection; Codex/OpenCode/custom providers include none.

Integration / real-path (derived from the operator's actions, run against real spawned sessions):

7. Spawn a Claude builder, have it run a command needing permission: overview serves `needs-input` with tool and summary within 5 s; status bar count increments; approve: returns to `working`.
8. Agent asks a question: `needs-input` (question); answer: `working`.
9. Turn ends: `idle` within 5 s.
10. `sleep 400` style tool call: stays `working` past 5 minutes.
11. Turn ends with a background task running: `working` until it completes and the agent finishes.
12. Interrupt with Esc mid-turn: becomes `idle`/`needs-input` within the idle-notification window plus 5 s.
13. Kill the agent process inside a live session: `dead` within 15 s; dashboard card and extension row render dead.
14. Stop Tower, keep working in the session: no visible delay or TUI noise; restart Tower: next event restores served state; persisted state survives restart with liveness re-evaluated.
15. Codex builder: waiting behavior identical to today; killing its process yields `dead`.
16. Builder with reporter: write-guard still denies an out-of-worktree Write (both hook sets fire).
17. Architect at a permission prompt: served `needs-input` on `ArchitectState`.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| A future Claude Code release stops concatenating `--settings` hooks with local settings | Low | High (guard or reporter silently lost) | Test 16 asserts both fire; Approach B is a documented fallback channel |
| Reporter slows or blocks turns (Tower hung) | Low | High | `async: true`, short hook timeout, sub-second request deadline, no retries, exit 0 always (SC13, test 14) |
| Stuck `working` when no ending event fires (interrupt, crash) | Medium | Medium | `idle_prompt` notification, `SessionEnd`, and Tower liveness each independently clear it; SC6 verified empirically |
| Stale state served after Tower restart or session respawn | Medium | Medium | Per-session ordering; new session id supersedes; liveness re-evaluated before serving persisted state (SC11, SC15) |
| Command summaries leak sensitive text to surfaces | Low | Medium | Bounded single-line summary; same local-key trust domain as streamed terminal output |
| Count flicker from immediate `idle` on short autonomous pauses | Medium | Low | Owner decision (Open Question 2); rendering can distinguish idle from needs-input |
| Per-event process spawn overhead on tool-heavy turns | Low | Low | Async; Tower dedups unchanged states; matcher narrowing if measured as a problem |
| Divergence with #1672's chain | Low | Medium | #1672 consumes this enum and the raw inputs (`alive`, reported activity) carried on the served row |

## References

- Issue #1595 (this work) and its 2026-10-05 owner ruling comment; 2026-09-28 re-scope proposal (superseded on ordering)
- #1672 Lane Card (future consumer of the enum), #1761 Claude Code mods (future second reporter)
- #1590, #1583 (render-gate family: future consumer of the same events), Spec 1313 (mailbox-first delivery; its rejection of hooks as a *delivery* channel is a different concern from state reporting)
- #1446 (stale porch status), #1566 (`compareAttention` / Tower sidebar), #1189 (server/client isolation)
- #1018 / #1536 (worktree write-guard: the settings-injection precedent)
- `codev/research/mobile/decisions/askuserquestion-detection.md` (hook emission with a harness-neutral Tower contract)
- Claude Code hooks reference (events, Notification types, async and http hook handlers)
