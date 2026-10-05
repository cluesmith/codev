# Spec 1595, iteration 1: rebuttal and disposition

All three reviews were accepted in substance. No point is disputed. Several points were settled by a live hook spike, rather than by argument (Claude Code 2.1.289, interactive session in tmux, every hook async; results are in the spec's Assumptions section and the builder thread).

## Claude (REQUEST_CHANGES)

1. **Dead detection is infeasible as written. The builder PTY child is the bash launch loop.** Accepted, and verified in `spawn-worktree.ts`: on a clean exit the loop blocks at `read -r`, so no EXIT frame is sent. Changes:
   - Liveness is now Tower-side process-tree inspection. For builders it asks whether the launch loop has a live agent child. For architects it uses restart-wait. For any agent it checks whether a session exists.
   - A confirmation interval keeps the 2 s relaunch pause from showing as dead.
   - Current State and Assumptions were corrected.
   - SC7 and SC9 now hold for every harness.
2. **`SessionEnd → dead` false-positives on `/clear`.** Accepted. `SessionEnd` is no longer reported at all. Death comes only from liveness. A context reset appears as a new session id via `session-started`. Test 15 was added.
3. **The SC1 permission event is unverified.** Accepted and resolved empirically. `PermissionRequest` fires about 10 ms after `PreToolUse` while the prompt is on screen. `Notification(permission_prompt)` follows about 6 s later, so it is kept as a redundant second chance.
4. **Architect attention is outside the contract.** Accepted. `AttentionSummary` gains a separate `architects` list (`{architect, state: needs-input|dead, since}`), because the existing item types are builder-shaped. `isEmpty` and the ordering account for it. SC13 was added.
5. **Spoofing.** Accepted in part. Ingestion now accepts only agents Tower currently knows in that workspace (SC16). Cross-agent spoofing by a holder of the key is recorded as an accepted risk, with the reason: the key already grants strictly more power (terminal writes, send).
6. **Summary rendering.** Accepted:
   - The summary is plain-text only (SC19), with control characters stripped.
   - Explicit limits are set: 200-character single line, and the summary is held only for the needs-input episode.
7. **Cache invalidation is the wrong mechanism, and the latency bound is ambiguous.** Accepted. The spec now uses the existing `overview-changed` SSE event, with no cache invalidation. Success Criteria now define "served" (5 s) and "visible" (5 s via SSE, 20 s poll as the worst case).
8. **Matcher narrowing.** Accepted from the start. `PreToolUse` is matched to the question tool only. `PostToolUse` stays on all tools, because the spike shows it is the only resume signal after an approval.

## Codex (REQUEST_CHANGES)

1. **Resolve open questions that contradict the SCs.** Accepted. Architect rollups, immediate idle, and dead-counts-as-waiting are now spec **decisions**, in a "Decisions for the owner at the spec gate" section. The SCs are written to them, and the owner may overrule at the gate. Only the main-seat contract sign-off remains Critical.
2. **Completed-builder precedence.** Accepted:
   - `dead` is projected only for agents that are not `complete` or `verified`.
   - Complete and verified builders never count (SC14).
   - The projection rules now name the completion phase.
3. **Dead architect representation.** Accepted in part. An architect whose agent exited but whose session is in restart wait is still listed, and is served `dead`. An architect whose session is gone entirely disappears from `architects` as today. Changing `OverviewData.architects` to list dead sessions is out of scope, and the spec says so implicitly by scoping SC7 to observable cases.
4. **Session ordering.** Accepted. The rules are explicit:
   - Accept a report only if its hook time is not older than the stored one.
   - A different session supersedes the stored one only with a newer hook time, so a delayed old `session-started` cannot take over.
   - Reject hook times more than 60 s in the future.
   - Same machine, same clock, so skew is not a concern.
5. **Field limits and redaction.** Accepted, with concrete limits:
   - tool ≤ 64, summary ≤ 200 (single line), ids ≤ 128, body ≤ 8 KB.
   - No secret redaction is attempted, stated with its rationale. The summary is held only for the episode and cleared after.
6. **Background-work `working` never clears.** Resolved empirically: when the background task completes, the harness starts a new turn (`UserPromptSubmit`), and that turn ends with `Stop` carrying an empty `background_tasks`. A 30-minute staleness bound covers the case where it never resumes.

## Gemini (COMMENT)

- **Raw activity is missing from the row.** Accepted. The served row now carries `activity`, `activityAt`, `backgroundWork` and `alive`.
- **A lost `Stop` leaves the agent working forever.** Accepted. The spike showed the TUI repaints continuously during a turn, including silent tool calls, and is still at a prompt. So a reported `working` is trusted only while PTY output is fresher than the 5-minute threshold, which is never worse than today (SC6). The 60 s `idle_prompt` gives a lost turn end a second chance.
- **Transition out of background work.** Resolved empirically, as in Codex point 6.
- **Permission denial trajectory.** Verified and documented. A deny ends the turn with no event at all (no `Stop`, no `PermissionDenied`, no `idle_prompt`). The agent stays `needs-input`, which is accurate, until the operator's next prompt (SC3).
- **Timestamp inversion from async spawn.** Addressed. `at` is the time the hook ran. Reports within one turn are separated by tool or model latency, and two reports close enough to race carry the same state. The ordering rules are in the spec.
- **`--settings` inline JSON quoting.** Accepted. A codev-owned settings file is preferred over inline JSON, and the plan decides its location.
- **Architect typing.** Same change as Claude point 4.
