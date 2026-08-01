# Specification: afx send — Mailbox-First Delivery (Never Force-Inject)

## Metadata

- **ID**: 1313
- **Status**: draft
- **Created**: 2026-07-31
- **Issue**: [cluesmith/codev#1313](https://github.com/cluesmith/codev/issues/1313)
- **Area**: Cross-cutting (`area/cross-cutting`) — the substance is the Tower send pipeline, but scope also includes the dashboard and VSCode sidebar indicators (decision 8), so per label policy the issue carries `area/cross-cutting` alone
- **Predecessors**: Issue #1265 (problem analysis); spike 1265 (`codev/spikes/1265-afx-send-line-occupancy.md`, branch `spike-1265`) — the empirical evidence base this spec draws on; Spec 403 (typing awareness), #450/#492 (composing flag added/removed), #584 (paced writes)

## Clarifying Questions Asked

All answers below are human (architect) decisions made 2026-07-31, during issue triage and spec review.

- **Q: Should a message ever be force-delivered onto a busy line (today's 60s max-age path)?**
  A: **No.** A busy line means a human is present at that terminal — escalate visibility through UI instead. There is no force path.
- **Q: Should the hooks-based delivery channel (Claude Code `Stop`/`UserPromptSubmit` hooks) be part of this project?**
  A: No — removed from the issue. Injection onto a rendered-verified empty prompt is the only delivery mechanism in scope.
- **Q: How much held-message UI is in scope?**
  A: Held-count indicator in the dashboard and VSCode sidebar, plus an `afx inbox`-style CLI to list/dismiss held messages. A rich message-center UI stays out of scope.
- **Q: What happens to messages addressed to a session with no live PTY?**
  A: They persist as held rows and deliver when the agent respawns — the drop-with-WARN path is removed.
- **Q: Are agy (Antigravity) terminals supported delivery targets?**
  A: **Yes — an agy gate profile is in scope and implementation blocks on it** (baked decision 12), alongside claude and codex. This requires new empirical measurement (the spike probed agy but did not derive a classifier profile for it).
- **Q: Does `afx send` gain a blocking `--wait` flag?**
  A: No — the immediate `held` + row-id response is sufficient; senders should not block on human availability.
- **Q: How does the builder access the spike evidence (findings + POC harness), which lives only on branch `spike-1265`?**
  A: **The builder fetches branch `spike-1265`.** The spike artifacts do not land on main as part of this project.

## Problem Statement

`afx send` models inter-agent messages as synthetic typing into the recipient's terminal. Today the deliver-vs-defer decision is a 3-second idle timer — a bad proxy for "is the input line empty?" A user who types a few words and pauses to think looks identical to a user at an empty prompt, so the message text plus an Enter keystroke land on top of their half-typed draft and submit the fused blob as one command. Reproduced in practice (issue #1265) and in the spike's harness against the real TUIs.

Beyond the headline corruption, the current pipeline **loses messages silently**: held messages live only in memory and die with a Tower crash; graceful shutdown force-flushes them onto whatever is on the line; messages to sessions showing a menu, a trust dialog, or the builder launch-loop's relaunch/boot screens are eaten or stranded while the sender is told "delivered"; and two concurrent sends to the same session interleave into a single garbled submit.

## Current State

The pipeline is `afx send` → `POST /api/send` → `handleSend` (`tower-routes.ts`) → `SendBuffer` (`send-buffer.ts`) → `writeMessageToSession` (`message-write.ts`). Known failure classes, all empirically confirmed by the spike:

1. **Timer-only deferral.** `shouldDefer` keys on `isUserIdle` (3s since last keystroke). A paused draft delivers immediately; the trailing `\r` submits draft+message fused.
2. **In-memory buffer.** Held messages die with a Tower crash; `SendBuffer.stop()` force-flushes on graceful shutdown; dead-session messages are discarded with a WARN; messages whose session is *unwritable* (shellper connection down) when the 60s max-age fires are dropped with an ERROR.
3. **Force delivery at max-age.** After 60s the buffer injects into any *writable* session regardless of line state (the unwritable case is the item-2 drop) — the destructive path this spec eliminates.
4. **No cross-writer serialization.** Two concurrent sends blob (`msg1msg2\r\r`, spike `w1a`); a send can land inside another write's text→Enter window.
5. **Mode blindness.** Delivery onto an open menu, model picker, trust dialog, or shell-mode composer misfires: Enter selects a menu item, confirms a filesystem-trust decision, or runs a shell command. The builder launch-loop wrapper's "Press Enter to relaunch" prompt consumes the message and relaunches the agent as a side effect; its crash-restart window strands the message as unsubmitted composer text.
6. **Bypass writers.** Cron messages write straight to the PTY with no idle check and no buffering, and log "delivered" unconditionally.

Input-side signals cannot fix this alone: `afx attach` clients write to the shellper socket directly, invisible to Tower's input tracking, and sessions recovered after a Tower restart may carry drafts or menus Tower never saw. The only signal that sees all of this is the **rendered screen** — Tower already holds the output ring buffer that reproduces it.

## Desired State

A message given to `afx send` is **never silently lost and never corrupts anything** — every accepted message ends in an explicit, auditable outcome (delivered, superseded, or dismissed), never a silent drop:

- At enqueue it is **persisted** before the sender gets a response. Tower crash, restart, or shutdown cannot lose it; shutdown never force-flushes it onto the line.
- It is **delivered only onto a prompt that is rendered-verifiably empty** — never onto a draft, a menu, a dialog, or a wrapper screen. (The rendered-screen gate is the sole authorization; apparent input-idleness never is.) Delivery happens at natural moments (at enqueue itself, after the user submits, on output quiescence, on a poll backstop), which for an idle agent at a clean prompt means near-immediate. No message text or Enter is ever written while the composer holds user input or a menu/dialog/wrapper screen is showing.
- If it cannot be delivered promptly, it stays **held and visible**: the sender knows (`held` response with a why-held reason), and the human can see held messages through UI and act. It is never force-injected, on any timeout — max-age becomes a visibility escalation.
- Messages to a respawned agent survive the respawn: rows address **agents, not PTYs**, so a new terminal for the same agent drains its predecessor's mail.
- Concurrent sends to one session serialize; no interleaving.
- Cron message delivery goes through the same mailbox + gate (it is a message writer, and today the most unguarded one); its run log records real outcomes.
- `afx send --interrupt` remains the explicit, deliberate bypass that skips holding — a sender action with unchanged semantics, outside the delivery guarantees above.
- The common case keeps today's feel: sending to an idle agent at an empty prompt delivers with no perceptible added delay.

Corruption is eliminated **by construction** on every gated path, not by detect-and-repair: message bodies are only ever written to an empty verified prompt, so they cannot fuse with a draft, and nothing ever clears or restores user input. (`--interrupt` sits outside this guarantee by definition — its sender deliberately accepts that risk; residual gate risks are catalogued in Risks and Mitigation.)

## Stakeholders

- **Humans at terminals** (architect terminal especially): their in-progress drafts and menu interactions must never be corrupted, submitted, or cleared by an incoming message.
- **Agents** (builders, architects, cron tasks) as senders: need an honest response (`delivered` vs `held` + reason) instead of today's unconditional success; as recipients: need messages to arrive intact and actionable, including across respawns.
- **Workspace operators**: need held messages to be discoverable (indicator + `afx inbox`) and dismissible without reading Tower logs.
- **Technical team**: Codev maintainers own the Tower send pipeline and the per-app classifier profiles (a maintenance commitment across TUI version bumps).

## Success Criteria

- [ ] **The #1265 repro is dead**: type a draft in the architect terminal, pause >3s, have a builder `afx send` — the draft is untouched, the message is held, and it delivers cleanly after the draft is submitted. Same result when a menu or model picker is open instead of a draft.
- [ ] **Idle delivery is unchanged in feel**: send to an idle empty-prompt agent delivers immediately (gate adds ≤ ~50ms) and renders exactly as today.
- [ ] **No loss across Tower lifecycle**: messages held at Tower crash or shutdown are present and deliverable after restart; shutdown performs no force-flush.
- [ ] **Wrapper screens don't eat messages**: a send to a builder sitting at "Press Enter to relaunch" (or mid-crash-restart) is held, not consumed; it delivers after the agent is back at a clean prompt.
- [ ] **Concurrent sends serialize**: N parallel `afx send` calls to one target produce N cleanly separated submissions, in enqueue order, no interleaving.
- [ ] **Cron parity**: a cron message onto a busy/menu screen is held (and superseded by the next run of the same task, per decision 6), never blind-written; cron logs reflect real outcomes.
- [ ] **Escalation is visible**: `afx inbox` lists every held message from the moment it is held; a message held past the escalation age additionally emits the escalation broadcast and puts the dashboard/VSCode indicator into an attention state — all discoverable without reading Tower logs.
- [ ] **Held reasons are distinguishable**: the send response, `afx inbox`, and logs distinguish at minimum `busy` (draft/menu/mode), `no-profile` (unknown app), and `no-live-pty` holds.
- [ ] **No new corruption vector**: `--interrupt` and `noEnter` behave as documented; unknown-app targets receive nothing and hold visibly.
- [ ] **agy is a working target** (blocking): a send to a fresh agy terminal showing its trust dialog is held (never Enter-confirmed); after the human accepts trust and the prompt is idle, the message delivers cleanly. The agy profile measurement is a required implementation task — the project is not complete without this criterion.
- [ ] Unit tests cover the mailbox lifecycle (enqueue/hold/deliver/supersede/dismiss/restart-recovery) and gate classification against captured screen fixtures for claude, codex, and agy (idle, draft, menu, picker, trust dialog, wrapper, boot); e2e covers the repro scenario end-to-end.
- [ ] Documentation updated: `afx` command reference (send response vocabulary, `afx inbox`), inter-agent messaging section of CLAUDE.md/AGENTS.md, and the skeleton mirrors.

## Constraints

- **The rendered screen is the authority.** The gate classifies from the output ring buffer replayed through a headless terminal — the same data path the dashboard reconnect uses. Input-side heuristics (idle timer, submit detection) may *schedule* gate checks but never authorize a write by themselves. A wrong trigger costs a failed gate check (message stays held) — the safe direction.
- **Sessions are born dirty.** Fresh spawns show trust dialogs/onboarding; recovered sessions may carry unseen drafts or menus. A session becomes deliverable only after a gate check passes; there is no grandfathering.
- **Per-app classifier profiles are required data.** Claude Code, Codex, and agy get verified profiles (marker + composer region + text-intensity rule, per empirical measurement). Claude/codex behavior is already measured by the spike; **the agy profile requires new measurement** — the spike observed that agy's `> ` marker and normal-intensity hint text do not fit the claude/codex dim-placeholder rule, so agy needs its own classifier rule, derived with the spike's harness. agy's per-folder trust dialog is the canonical born-dirty case: it must classify not-clean (a blind Enter there would confirm a filesystem-trust decision). A session whose app has no profile, or whose screen never classifies clean, simply never receives injected messages — held + visible, with a diagnostic so a broken profile is discoverable rather than silent (liveness telemetry: repeated not-clean verdicts with recent output raise a loud log/broadcast).
- **Persistence lives in Tower's existing state store** (the user-global `global.db`); no new storage subsystem.
- **Backward compatibility**: the `/api/send` response stays additive — existing fields (`ok`, `terminalId`, …) keep their shape so older `afx` binaries continue to work; `held`/row-id/reason are new fields. A held outcome reports `ok: true` (the message was accepted and persisted) — an old binary thus sees exactly what it sees today for a deferred send, while new binaries read the real outcome from the new fields. The mailbox table is additive with migration-on-boot; no existing rows to migrate (the old buffer was in-memory — its contents were already lost at every restart, which is one of the bugs).
- **Existing send semantics carried over**: `noEnter` sends keep their staging behavior (text without submit); the one change is that, like every automated write, they now pass the clean gate first (staged text then occupies the composer, correctly holding followers). A gate-passed `noEnter` staging reports `delivered` — the write completed; submission was never part of a `noEnter` send. Message pacing (#584) is retained as-is for the write itself. Addressing/routing rules and the builder spoofing check are unchanged.

## Assumptions

- The output ring buffer (per #1047 sizing) is sufficient to reconstruct the current screen for classification — this is the same reconstruction the dashboard performs on reconnect, so any insufficiency is a pre-existing display bug, not a new risk class.
- The spike's measured per-app facts (markers, dim-placeholder rendering, wrapper screens, menu signatures for claude 2.1.x / codex 0.14x) remain representative; the spike harness re-verifies them on version bumps.
- The spike's POC harness and findings are accessible to the builder by fetching branch `spike-1265` (see Dependencies).
- `--interrupt` senders accept the documented risk (it interrupts the agent and bypasses holding) — that is its purpose.

## Solution Approaches

### Chosen: mailbox persistence + rendered-empty gate + write serialization

Persist every message at enqueue; deliver only when a headless-terminal replay of the session's output ring classifies the screen as "clean prompt, empty composer"; serialize all automated writes per session. Never inject otherwise; escalate visibility instead.

**Pros**: eliminates corruption by construction (nothing is ever written onto a non-empty screen); one gate covers drafts, menus, dialogs, wrapper states, attach-typed input, and post-restart unknowns; kills silent loss via persistence; small surface (~400–700 LOC).
**Cons**: delivery to a busy terminal waits for the human (by design, per the baked decision); per-app classifier profiles are a maintenance commitment.
**Complexity**: Medium. **Risk**: Low-Medium (classifier conservatism is fail-safe).

### Rejected: input-side occupancy authority + busy-line delivery maneuvers (spike options A + B/C/H/I/J)

Model the draft from keystrokes and let that model authorize delivery; when delivery must happen onto a busy line, clear/restore the draft (kill-yank, stash, byte-replay) with atomic write forms, a pre-Enter equality gate, and differential post-delivery verification.

**Why rejected**: exists to serve force-delivery, which the human decision removed. ~2,400–2,800 LOC; per-app and version-fragile delivery forms; cannot restore multi-line drafts via kill-ring; input tracking is provably blind to `afx attach` and post-restart state. Archived as spike evidence. Note: spike option E's *flush-on-submit moment* is not rejected — it survives as one of the scheduling triggers in baked decision 5; what is rejected is treating any input-side signal as delivery **authority** (the gate always decides).

### Rejected: agent-hooks side channel (deliver via Claude Code `Stop`/`UserPromptSubmit` hooks)

**Why rejected**: explicitly cut by the human from issue scope. Claude-only (no codex/agy inbound equivalent), and cannot wake an idle agent — injection would still be needed for the idle case.

### Rejected: notification-only mailbox (spike option L — never inject at all)

**Why rejected**: defeats the purpose of `afx send` — the recipient agent must act on the message without a human relaying it. Gated injection onto a verified-empty prompt retains that while removing the corruption.

## Non-Goals

- **Any busy-line delivery maneuver.** No kill/yank, no `^S` stash, no byte-capture/replay, no draft clearing or restoring of any kind. (Spike options B, C, H, I — archived as evidence for a path not taken.)
- **Input-side draft modeling.** No DraftTracker, no cursor-aware line model, no per-keystroke occupancy state machine. Input events may serve as cheap *triggers* to run the gate; they are never the authority.
- **Delivery-form matrices.** No per-app atomic write forms or bracketed-paste framing work beyond what the existing write path already does; per-app knowledge is limited to gate *classifier profiles*.
- **Post-delivery verification epistemics.** No canonical-stream differential verify, no pre-Enter equality gate. With no force path and a gate before every write, the elaborate believed-sent analysis is unnecessary; residual wrapper-transition races are accepted and bounded by holding — the row stays held whenever the gate check fails or the PTY write itself errors (outcome semantics in Risks and Mitigation).
- **Hooks-based delivery channel** (per-app agent hooks reading a mailbox). Explicitly cut from the issue.
- **`afx attach` rerouting or shellper protocol changes** (observation frames, presence census). Attach-typed drafts are visible to the rendered gate, which is sufficient under a never-inject-on-non-empty policy.
- **The raw terminal write route** (`POST /api/terminals/:id/write`) and dashboard/VSCode interactive typing — these are terminal I/O primitives, not message delivery, and keep their current semantics.
- **Rich inbox UI.** The visibility surface in scope is the indicator + `afx inbox` CLI (baked decision 8); a full message-center UI is not.
- **Changing message formatting, addressing/routing rules, or the spoofing check.**

## Baked Decisions

1. **There is no force path.** No timeout, valve, or fallback ever writes a message onto a non-clean screen. Max-age is a *visibility* transition on a persisted row, not a delivery action. (The explicit `--interrupt` command is a sender action, not a timeout/valve/fallback — see decision 3.)
2. **Mailbox-first.** Persist at enqueue, before the send response. The in-memory `SendBuffer` queue collapses into the mailbox. Response vocabulary the sender can trust: `delivered` (gate passed, write completed) or `held` + row id + **why-held reason** — canonical reason tokens, used throughout this spec: `busy` (draft/menu/mode), `no-profile` (unknown app), `no-live-pty`. No more unconditional "delivered". (Exact response field names are settled in the plan; the spec-level constraints are the additive shape and `ok` semantics in Constraints.)
3. **Gate before every automated message write** — direct sends, drained holds, and cron alike. One code path. The sole exception is `afx send --interrupt`, the explicit, deliberate bypass: it interrupts the agent and writes without a gate check (unchanged semantics; the sender who invokes it accepts the risk). It is a command the sender chooses per message — not a timeout, valve, or fallback — so it does not weaken decision 1.
4. **Rows address agents** (workspace + agent identity), with terminal id as a hint, so respawned terminals drain predecessor mail.
5. **Delivery moments**: initial enqueue, user-submit trigger, output-quiescence trigger, and a poll backstop — each runs the gate; the gate decides. The enqueue-time check is the immediate path for an idle target at a clean prompt. Trigger heuristics stay simple deliberately (a missed trigger delays delivery to the next backstop poll; it can't corrupt anything). Automated writes serialize **per live PTY** (a message's text and its Enter are one unit); held rows drain in **enqueue order per agent** — the ordering senders observe.
6. **Cron messages** are enqueued like any send, with a per-task supersede key: a newer run's message replaces the older *held* row rather than queueing a backlog; the cron run log records the real outcome (`delivered`/`held`/`superseded`) instead of unconditional "delivered". **Supersede keys are cron-only in this project**: a non-cron send never supersedes another — each accepted send is an independent held row that resolves on its own (delivered or dismissed). Cron is the sole supplier of a supersede key (its per-task key).
7. **Held-message retention**: a *held* row is never TTL-dropped — it stays until delivered, superseded (senders with a supersede key — cron, per decision 6), or explicitly dismissed. **Dismissal is a human act via `afx inbox`** (CLI-only in this project, never automatic), is logged with row metadata (never the body), and is a soft state transition — the row is marked dismissed, not immediately deleted, so the outcome is auditable and queryable by row id. **Terminal rows** (delivered / superseded / dismissed) are pruned after a bounded retention window (default 30 days, configurable), so bodies do not accumulate indefinitely.
8. **Visibility surface** (resolved in spec review): a held-count indicator in the dashboard and the VSCode sidebar showing the count of **all** currently-held rows, plus an `afx inbox` CLI that lists **all** held messages (regardless of age) and can dismiss them. The dashboard/VSCode surfaces are read-only indicators — dismissal is CLI-only (decision 7). Backed by the `held` response, the Tower log, and **two distinct broadcast events**: a held-state-change broadcast (fires on hold/deliver/supersede/dismiss; keeps the indicator count live) and the escalation broadcast below (exact event names are plan-level). **Escalation age**: a held row crossing the escalation threshold (default 60s, matching today's max-age; configurable via `.codev/config.json`) emits the escalation broadcast and puts the indicator into an attention state — it never triggers delivery. **`afx inbox` scope and dismiss authorization**: `afx inbox` is workspace-scoped — it lists every currently-held row in the workspace, across all recipient agents, each with its row id and why-held reason (`busy`/`no-profile`/`no-live-pty`), and dismisses by row id. Dismissal carries the same workspace-human trust level as `afx send` itself (see Security Considerations): any workspace operator may dismiss any held row — there is no per-recipient ownership check. The **visual form** of the indicator's attention state (badge, color, count styling) is a plan-level UI decision; the spec-level requirement is only that a distinct, log-free attention state exists and clears when the row resolves.
9. **Dead-session messages persist** (resolved in spec review): no live PTY → held row (reason: no-live-pty), delivered when the agent respawns. The drop-with-WARN path is removed. Cron backlog stays bounded via supersede keys.
10. **Supported delivery targets are claude, codex, and agy** (resolved in spec review) — each with its own measured classifier profile. Everything else is unknown → defer-only, held + visible.
11. **No `--wait`** (resolved in spec review): the send response is immediate (`delivered` or `held`+id); no blocking mode in this project.
12. **Implementation blocks on the agy profile** (resolved in spec review): the measurement (derive agy's classifier rule with the spike harness) is a required implementation task, and the project is not complete until the agy success criterion passes. At runtime, an agy session still behaves fail-safe (held + visible) whenever its screen doesn't classify clean — blocking is a completion requirement, not a change to the gate's conservatism.

## Open Questions

### Critical (blocks progress)

- None. All scope questions were resolved in spec review (see Clarifying Questions and Baked Decisions 8–12).

### Important (affects design)

- None.

### Nice-to-Know (optimization)

- [ ] Whether the VSCode indicator should also surface held messages in the existing Needs Attention view (plan-level UI placement decision).

## Performance Requirements

- **Gate cost**: the gate classifies the **seed-capped replay** — the same capped reconstruction the dashboard reconnect uses — so its input is bounded by the ring seed cap regardless of raw ring size. Bound: single classification ≤ ~50ms at inputs up to the cap (spike measured 2ms @ 13KB, 22ms @ 1MB = the cap; the 67ms @ 4MB measurement was an uncapped-ring lab case that the seed cap excludes by construction); run per delivery attempt, not per keystroke.
- **Idle-path latency**: no perceptible regression for send-to-idle-agent — ≤ ~50ms added end-to-end vs. today, **inclusive of** gate + enqueue persistence. This nests inside the gate's own ≤ ~50ms bound because that bound is the at-the-cap worst case: at realistic screen sizes the measured gate cost is single-digit milliseconds, leaving the end-to-end budget's headroom for persistence and serialization.
- **Enqueue latency**: mailbox persistence adds no perceptible latency to the `afx send` response (single local SQLite write).
- **Steady-state cost**: no per-keystroke work beyond what exists today; backstop polling only while messages are held for a session; zero background cost when the mailbox is empty.

## Security Considerations

- **Message bodies at rest**: mailbox rows persist user-authored message content in the user-global `global.db`. This inherits the store's existing access boundary (local, per-OS-user); no new network exposure. Retention follows baked decision 7: held rows persist until resolved (never TTL-dropped); terminal rows (delivered/superseded/dismissed) are pruned after the bounded retention window, so bodies do not accumulate indefinitely.
- **Redaction**: message bodies never appear in Tower logs, diagnostics, or telemetry — logging uses row ids and metadata only. UI surfaces that legitimately display bodies do so over the same local Tower connection that carries them today: `afx inbox` for held rows, and the terminal stream itself (as mirrored by the dashboard/VSCode terminals) once a message is delivered. The dashboard/VSCode *indicator* remains count-only (decision 8).
- **Authorization unchanged**: the sender spoofing check (`tower-messages.ts`) and addressing rules are untouched; the mailbox introduces no new remote write path. `afx inbox` dismiss is a local-workspace human action, same trust level as `afx send` itself.
- **Injection safety**: the gate reduces the attack/accident surface — today a message can be blind-typed into a trust dialog or shell-mode prompt (where Enter *runs a command* or *confirms a filesystem-trust decision*); under this spec nothing is written to such screens. `--interrupt` remains a deliberate, explicitly-invoked bypass with unchanged semantics.

## Test Scenarios

### Functional

1. Draft-in-progress send (the #1265 repro) — held, draft intact, delivered after submit.
2. Idle empty prompt — immediate delivery, correct rendering, `delivered` response.
3. Menu/picker/trust-dialog open — held; delivers after the screen returns to a clean prompt.
4. Builder wrapper states (relaunch prompt, crash-restart window) — held; delivers post-boot once clean.
5. Tower restart with held rows — rows survive; recovered session starts dirty; delivery only after a clean gate pass.
6. Respawned agent (new terminal id) — predecessor's held mail drains to the new terminal.
7. Concurrent sends (same target) — serialized, ordered, no blobbing.
8. Cron: busy target → held; next run supersedes; log shows outcomes.
9. `--interrupt` — bypasses holding, interrupts, delivers (unchanged).
10. `noEnter` — gate-checked, stages text, does not submit; a follow-up send holds behind the staged text.
11. Unknown app / no profile — never delivers, held + visible with reason `no-profile`, diagnostic raised.
12. Attach-typed draft (typed via `afx attach`, invisible to input tracking) — gate still holds delivery.
13. agy fresh spawn (trust dialog showing) — held; after trust is accepted and the prompt is idle, delivers; `afx inbox` shows the row while held.
14. Visibility surface — a held message appears in `afx inbox` (with its why-held reason) and in the indicator count immediately; crossing the escalation age emits the escalation broadcast and puts the indicator into an attention state; dismissing via `afx inbox` marks the row dismissed (not immediately deleted), removes it from the indicator count, and never delivers it.
15. Held-reason accuracy — busy vs. no-profile vs. no-live-pty holds are distinguishable in the send response, `afx inbox`, and logs.
16. Escalation-age threshold — a message held past the escalation age (default 60s) emits the escalation broadcast and moves the dashboard/VSCode indicator into its attention state, while **no delivery is triggered** by the threshold crossing itself; the row still delivers only on a later clean gate pass (and clears the attention state when it resolves).

### Non-Functional

1. Gate cost within the Performance Requirements bounds at realistic ring sizes; idle-case send latency within the idle-path budget (no perceptible regression).
2. Mailbox operations add no perceptible latency to the `afx send` response.
3. Message bodies never appear in Tower logs or diagnostics (assert on captured log output in tests).

## Dependencies

- **Internal systems**: the PTY output ring buffer (`pty-session.ts`, sizing per #1047) as the gate's data source; the `global.db` state store and its migration-on-boot pattern; the existing broadcast/WS event channel; the dashboard and VSCode sidebar for the indicator; the cron runner (`tower-cron.ts`) for the rerouted delivery path; the `afx` CLI for `inbox` and the extended send response.
- **Libraries**: a headless terminal emulator for screen reconstruction (`@xterm/headless` — already used by the spike harness; confirm/add as a production dependency of the Tower package).
- **Evidence base**: spike 1265's findings and POC harness live on branch `spike-1265`, **not on main** — the builder **fetches that branch** (human decision; the spike artifacts do not land on main as part of this project). The harness also serves as the fixture source for classifier tests and the version-bump smoke test.
- **External services**: none.

## References

- Issue #1313 (this project), issue #1265 (problem analysis)
- Spike findings: `codev/spikes/1265-afx-send-line-occupancy.md` + POC harness `codev/spikes/1265-poc/` (branch `spike-1265`)
- Prior art: Spec 403 (typing awareness), #450, #492, #584, #1264 (double-`^C` kill), #1047 (ring size)

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Classifier profile drift (TUI update changes markers/regions) → all sends to that app hold forever | Medium | Medium | Fail-safe by design (hold, never misdeliver); liveness telemetry makes it loud; spike harness doubles as version-bump smoke test |
| Gate false-clean on an unmodeled screen state → misdelivery | Low | High | Conservative classifier (marker required AND region empty); claude/codex states measured in the spike; unknown states default to held |
| agy profile is net-new measurement (no spike-verified rule; its hint text breaks the dim-placeholder assumption) | Medium | Medium | Derive it with the spike harness early in implementation — it is a blocking task, so front-load it to surface schedule risk; at runtime agy stays fail-safe (held + visible) whenever its screen doesn't classify clean |
| Process swap in the gate→write gap (wrapper transition race) | Low | Medium | Accepted residual. Outcome semantics: a failed gate check or an errored PTY write leaves the row held; a write that completes marks the row `delivered` — so a swap landing inside the narrow gate→write window can misdeliver. Transitions print output, so the gate catches them outside that window; no post-delivery verification or believed-sent claim is made (non-goal) |
| Held-forever messages annoy users where force-inject used to "work" | Medium | Low | Visibility surface + `--interrupt` escape hatch; delivery-on-next-submit means a present human unblocks it naturally |
| Mailbox schema in `global.db` complicates upgrades | Low | Medium | Additive table, migration-on-boot pattern already used by Tower state; response fields additive for older `afx` binaries |

## Expert Consultation

**Date**: 2026-07-31
**Models Consulted**: Gemini (via agy), GPT-5 Codex, and Claude Opus — SPIR spec-phase 3-way review, iteration 1.
**Verdicts**: Gemini APPROVE, Codex REQUEST_CHANGES, Claude COMMENT — all HIGH confidence. All three judged the spec technically sound, feasible, and empirically well-grounded; the only unanimous defect was this missing template heading.

**Sections Updated**:
- **Expert Consultation** (this section): added — the one canonical-template heading the draft omitted (flagged by all three reviewers).
- **Baked Decisions → Decision 8**: made `afx inbox` scope explicit (workspace-scoped; lists every held row across all recipient agents with its row id and why-held reason; dismiss by row id), pinned dismiss authorization (workspace-human trust level, no per-recipient ownership check — resolves Codex's scope question and Claude's multi-architect "which human?" question), and noted the indicator's *attention-state* visual form is a plan-level UI decision (Claude).
- **Baked Decisions → Decision 6**: stated explicitly that supersede keys are cron-only — a non-cron send never supersedes another (Claude).
- **Test Scenarios → Functional #16**: added a dedicated escalation-age-threshold scenario (broadcast fires, indicator enters attention state, no delivery triggered) — previously only partially covered by #14 (Claude).

No baked decision was changed; all feedback was clarification/completion, not reversal. Feasibility points the reviewers independently verified against the repo (the `@xterm/headless` production-dependency gap, the ring-buffer screen-reconstruction path, the additive `global.db` migration-on-boot) matched the spec's own statements.

Note: All consultation feedback has been incorporated directly into the relevant sections above.

## Approval

- [ ] Technical Lead Review
- [ ] Human (architect) sign-off — required before spawn

## Notes

- House-style extensions retained deliberately: `Goals` content was folded into Desired State; `Non-Goals` and `Baked Decisions` are kept as sections (consistent with recent accepted specs, e.g. 1216) in addition to — not instead of — the canonical headings.
- The estimate remains ~400–700 LOC vs. the spike's ~2,400–2,800 for the full-maneuver design; the delta is the removed force path and its safety apparatus.
