# Codev Mobile — Interaction Model

**Status**: Design, pre-implementation. Ground-truthed against the repo on 2026-07-07.
**Last updated**: 2026-07-07 (revised from a 2026-07-05 local draft, with repo verification and corrections)
**Prior context**: `codev/research/mobile/feasibility-2026-07.md` — the strategic frame (refreshed from the May-2026 snapshot).
**Open questions**: the seven §9 questions now have decision notes in `codev/research/mobile/decisions/`.

---

## 1. Positioning

The mobile app is scoped as **"Codev on the go"** — 30-second attention windows, glance + tap + short chat, then close. It is a **complement** to the desktop web dashboard and VS Code extension, not a portable replacement for either.

Explicitly:

- **Not a full IDE.** No editor surface, no file browser deep enough for authoring.
- **Not a portable dashboard.** Multi-panel management workflows stay on desktop.
- **Not a general terminal.** Free-form shell interaction is not a mobile use case.

What the mobile app *is*: the surface a user reaches for to answer a Claude question at a coffee shop, approve a gate from a train, glance at builder status between meetings, or send a short message to the architect while away from the laptop.

---

## 2. Interaction primitives

Four primitives carry the entire user-facing interaction surface. All built with native RN components; none require xterm.js or DOM-only libraries.

Each primitive is annotated below with its **plumbing status** as of 2026-07-07 (see §8 and Appendix A for detail): what Tower already provides vs. what must be built.

### 2.1 Chat interface

- Text input at the bottom of the screen; message bubbles above.
- User's typed message is routed under the hood as `afx send architect "..."` (or to a specific builder id) — concretely, `POST /api/send` with the same affinity-checked resolver the CLI uses.
- Architect / builder responses appear as bubbles.
- Full markdown rendering: bold, code blocks, links, lists, inline formatting.
- Long messages collapse to a preview with an expand affordance; short ones render inline.
- Same mental model as ChatGPT / Claude mobile apps.

**Plumbing status: mostly exists.** The architect ↔ user relationship is already message-passing, and Tower already has a **typed message bus**: `broadcastMessage` mirrors every routed message to `/ws/messages` subscribers as a `MessageFrame` (`{type:'message', timestamp, from:{project,agent}, to:{project,agent}, content, metadata}` — `tower-messages.ts`). Mobile chat = `POST /api/send` outbound + `/ws/messages` subscription inbound. The gap: agent→user *responses* are not on the bus (they're raw PTY output); surfacing them as chat bubbles needs the structured-event work in §8.

#### Voice input (STT) — decision note (2026-07-07)

"Voice" is three different-sized things, and only the largest is genuinely deferred. Conflating them (as the May feasibility doc's Tier-2 "voice spec drafting" framing did) undersells what chat gets for free:

1. **OS dictation into the chat input — free, present in v0 by construction.** The composer is a standard text field; the iOS / Android keyboard mic provides speech-to-text into it with zero engineering. This tier requires no code and must never be "built" — it exists the moment chat ships. Recorded here so nobody specs it later.
2. **First-class mic affordance — cheap, deliberately NOT in v0; first candidate for v1.** A dedicated mic button on the composer using platform STT (SFSpeechRecognizer / Android SpeechRecognizer via an Expo module), making "talk to your architect" one tap. Days of work, no cloud dependency, and it strengthens the core 30-second story — dictating "looks good, merge it and start on the next issue" beats typing it while walking. Kept out of v0 purely for scope discipline; named here as the first v1 scope question for main.
3. **Voice-first authoring ("commute spec") — expensive, Phase 3, unchanged.** Earbuds-only operation, AI spec drafting from a spoken description, audio readback, hands-free issue filing. Needs summarization/readback infrastructure that doesn't exist; a differentiation feature, not a PoC feature. This is the only tier the scope-lock's "voice: deferred" line actually costs.

### 2.2 Activity feed

- Slack-style scrollable timeline of every architect / builder event: messages, phase changes, gate hits, spawns, PR merges, cleanup events.
- Real-time updates via WebSocket.
- Each row taps into its underlying content: message row → full text, gate row → approve/reject card, PR row → PR card.
- Filterable by architect, by builder, by event type (v2 concern).

**Plumbing status: does not exist as an event stream.** Verified 2026-07-07: Tower's SSE channel (`GET /api/events`) emits only coarse refetch triggers (`overview-changed`, `notification`, `builder-spawned`, `architects-updated`, `connected`, plus ad-hoc `POST /api/notify` types). There is **no** typed, replayable activity log — the dashboard polls `GET /api/overview` (a rich snapshot: builders with phase/gates/blocked/prReady, pendingPRs, backlog, architects) and refetches on any SSE tick. Two consequences: (a) v0 mobile should render the feed **from overview snapshots + the message bus**, not wait for an event log; (b) a true Tower-side activity event stream is new plumbing that benefits web equally — coordinate with main (§8).

### 2.3 Structured action tiles

Tap-first flows for common actions that would be tedious to type:

- **Approve gate** — one tap on the notification / gate card
- **Reject gate with comment** — tap → short text input → send
- **Quick preset messages** — "ship it" / "need to think" / "blocked, will look tonight"
- **Spawn builder** — pick issue → pick protocol → confirm
- **Cleanup builder** — swipe on builder row → confirm

**Plumbing status: partial.** Send, spawn (`POST /api/launch`), stop, issue search (`GET /api/issue-search`) exist as Tower routes. Gate approve/reject is **not** a Tower HTTP endpoint today — `porch approve` is a CLI operating on worktree state; exposing an approval route (with the human-approval semantics preserved) is new, coordinated work.

### 2.4 Push notifications

- Gate ready for approval
- Builder blocked / hit `dev-approval`
- Architect asked a question via `AskUserQuestion`
- Sibling architect pinged you (`afx send architect:main "..."` from another architect)
- PR merged / release published

Tap the notification → app opens directly to the relevant card. This is where mobile *wins* over desktop: proactive attention when the user isn't watching the terminal. Coffee-shop approval flows.

**Plumbing status: cloud-dependent, v1+.** Requires Tower Cloud push infrastructure (APNs/FCM). The tunnel itself is real, working code today (`tunnel-client.ts` — HTTP/2 role-reversal over WSS to codevos.ai), but there is no push wiring and no per-device identity (see `decisions/q2-auth-model.md`). Out of v0 scope by decision.

---

## 3. Response review — spectrum by content type

Users need to review a range of response types, from one-line events to multi-page CMAP verdicts. Different lengths call for different UIs:

| Response type | Length / density | Mobile pattern |
|---|---|---|
| Direct message from architect / builder | short-medium | **Chat bubble** — markdown-rendered, tap for full timestamp / author details |
| Phase / status change | one-line event | **Feed row** — glance-scanable |
| Gate hit requiring attention | short + action | **Push notification + action card** with Approve / Reject / View |
| CMAP verdict (3-lane review) | medium (200-1000 words) | **Expandable card** — preview in feed, tap for full-screen markdown reader |
| Architect explanation | medium (100-500 words) | **Chat bubble** — same rendering as short messages, just taller |
| Builder review summary | medium | **Card** — title, verdict, tap for full body |
| PR body + files changed | structured | **PR card** — title, status, files count, tap to native diff viewer |
| Individual file diff | structured code | **Native diff viewer** — syntax-highlighted, unified / split toggle |
| Review comments on spec / plan | annotated | **Inline speech bubbles** near annotated line (Google Docs mobile pattern) |
| Raw terminal output (edge case) | long text | **Read-only monospace snapshot** — last N lines, non-interactive |
| Full CMAP consultation output | very long, dense | **Summary + "Continue on desktop"** deep-link |
| Multi-file review, spec authoring | very long | **Summary + "Continue on desktop"** deep-link |

**Rendering note (new since the draft)**: `@cluesmith/codev-artifact-canvas` (spec 945) settled the markdown/review-comment rendering question for DOM hosts, and issue #1029 records the decision to **defer a core/web/native split until native rendering is a committed requirement**. Mobile is the thing that makes it committed. The chat/card-rendering spike must therefore evaluate: (a) RN-native markdown (react-native-markdown-display et al.) vs. (b) hosting artifact-canvas in a WebView (works unchanged today per #1029) — and its outcome should feed back into #1029's deferred decision.

### 3.1 Three UI primitives carry most of the load

- **Chat with expandable messages** — short exchanges inline, long ones full-screen on tap
- **Feed with tap-through cards** — glance, then drill in as needed
- **Native diff viewer** — GitHub's mobile diff viewer is a reference implementation

### 3.2 Honest desktop-deferral

Some content types are worse on mobile no matter what UI ships:

- CMAP verdicts with three lanes of dense analysis (often 2000+ words total)
- 20+ file PR reviews
- Spec authoring / plan editing (long-form writing on phone is painful)
- Debugging with raw scrollback (needs pattern-matching over lots of text)

For these, mobile's job is: **surface that it happened, show a summary, hand off to desktop**. The card in the feed says *"CMAP complete: 2 APPROVE / 1 REQUEST_CHANGES"* with a **Continue on Desktop** button (handoff mechanics: `decisions/q1-pairing-model.md` — a cloud/dashboard URL, not a device-pairing subsystem).

This is not a mobile failure — it's mobile playing to its strengths. The 30-second attention model means "give me signal, defer the deep dive." Trying to make mobile serve a 20-minute review session would make the app worse at the 30-second use cases without meaningfully winning the 20-minute ones.

---

## 4. `AskUserQuestion` → native picker (mobile's sweet spot)

Structured multiple-choice questions from Claude (via the `AskUserQuestion` tool) map to native mobile picker UI cleanly — this is one of mobile's clearest wins over desktop.

### 4.1 Why it maps well

`AskUserQuestion` has a well-defined schema: question string + 2-4 options (each with label + optional description) + optional multi-select + optional preview content per option. Tower can detect these tool calls in the architect / builder streams and route the STRUCTURED payload (not free-form text) to whichever surface is watching.

Mobile receives `{question, options[]}` as a structured event, not prose. It renders native picker UI, not text parsing.

**Plumbing status: does not exist.** Verified 2026-07-07: zero `AskUserQuestion` detection anywhere in the codebase; Tower does no content inspection of PTY streams (the only content-derived signal is `lastDataAt`, a last-output timestamp used to flag possibly-waiting builders). §8.1 is therefore a from-scratch design, and because it benefits the web dashboard and VS Code equally, its design belongs with main, not mobile-shaped.

### 4.2 The mobile question card

```
┌─────────────────────────────────────┐
│ From: pir-1140                      │
│                                     │
│ Preserve the caller env for         │
│ legacy-row recoveries?              │
│                                     │
│ ● Yes, use shell architect          │
│     if DB row has no spawnedBy      │
│ ○ No, always fall back to 'main'    │
│ ○ Other...                          │
│                                     │
│            [ Submit ]               │
└─────────────────────────────────────┘
```

- **Radio buttons for single-select, checkboxes for multi-select** — standard native primitives
- **Descriptions collapsible** — tap the label to see the full option description
- **"Other" option** always available → routes to free-form text input, same as desktop
- **Preview content** (code snippets, mockups) renders inline as a small code block, or tap-to-expand to full-screen

Answer submits, Tower feeds back into the AI's `tool_result`, conversation continues.

### 4.3 Why mobile is *better* than desktop for this pattern

- **Proactive attention**: push notification means Claude can ask a question while the user is in a meeting or on the train. Answer in 8 seconds, move on. Desktop requires the user to be looking at the terminal.
- **Discrete taps beat typing** option labels or number keys.
- **Native pickers are more accessible** — VoiceOver, larger touch targets, keyboard-optional.
- **Fits the 30-second window perfectly** — this is exactly the "Codev on the go" use case landing well.

### 4.4 The free-form-list edge case

Sometimes Claude writes *"Would you like A, B, or C?"* as prose in a regular message rather than calling `AskUserQuestion`. Tower can't detect that as structured — it looks like normal chat text. Same problem exists on desktop today.

**Mitigation**: encourage / train architects to use `AskUserQuestion` for genuine option-choice questions, and keep prose for open-ended asks. When structured, mobile UX is excellent. When prose, it degrades gracefully to a chat bubble with a typed response.

Not a mobile-side fix; it's a prompt / architect-behavior concern.

---

## 5. What mobile should NOT try to do

Explicit non-goals — trying to do these would degrade the primary use cases without winning the deep ones:

- **Full terminal emulator.** Even with a native RN bridge to SwiftTerm / Android Terminal Emulator, mobile terminal UX is bad regardless of implementation (tiny text, no keyboard shortcuts, poor selection, no chord support). More importantly, the mobile use case doesn't need it — architect / builder communication is message-passing at heart, not raw shell.
- **Multi-file PR review with deep diff analysis.** Fine up to ~5 files; beyond that, hand off to desktop.
- **CMAP-verdict multi-lane review sessions.** Read the summary; defer the full lanes.
- **Spec authoring / plan editing.** Long-form writing on phone is painful; not worth serving.
- **Debugging with raw scrollback.** Needs pattern-matching over lots of text; desktop territory.

The pattern: **mobile serves the 30-second use cases exceptionally well and hands off honestly for the 20-minute ones.**

---

## 6. Desktop handoff pattern

**Decided** — see `decisions/q1-pairing-model.md`. Summary:

1. Mobile shows summary + "Continue on Desktop" button.
2. The button carries a **URL, not a device address**: the cloud tunnel-proxy path (`https://<cloud>/t/<towerId>/<view-path>`) when cloud-connected, or the LAN dashboard URL in v0.
3. `codev://` deep-linking (registered by the Codev IDE, now in the external `amrmelsayed/codev-ide` repo) is a desktop-side progressive enhancement that claims those links when installed; the browser is the universal fallback. Mobile never needs a pairing registry.

---

## 7. Architectural implications

### 7.1 Do NOT merge `apps/web` and `apps/mobile`

Considered in this exploration: could React Native + React Native Web give us one codebase for iOS + Android + web from a single Expo project?

Rejected. Reasons:

- **RN Web fits feed-based touch-first apps** (Bluesky, X, Discord). The web dashboard is the opposite profile: desktop management console, multi-panel, keyboard-heavy, xterm.js terminal attach, complex hover / right-click / drag-drop affordances.
- **Trying to unify** produces either lowest-common-denominator UX (bad on both platforms) or per-platform branches everywhere (which defeats the merger's premise).
- **Rewriting the dashboard** as RN Web is a rewrite, not a refactor. Weeks of work with regression surface, blocking mobile from shipping while the migration lands.
- **Build tooling complexity** — Metro + Expo Router + web adapter vs. clean per-platform toolchains (Vite for web, Expo for mobile).

### 7.2 DO share the client layer — via `codev-sdk` (#1189), not the original tower-sdk

**Superseded (2026-07-16).** This section originally proposed `packages/tower-sdk`: a React-hooks state layer extracted from the dashboard, consumed by web, mobile, and VS Code. That design was retired after review with Amr, for three reasons:

- The VS Code extension host is not React — hooks fit at most two of the three claimed consumers.
- The dashboard would need migrating onto the extracted layer to get any sharing benefit: a refactor of a working surface for the benefit of an app that doesn't exist yet.
- It contradicted the repo's own extract-on-committed-need precedent (#1029).

**The replacement is issue #1189: `packages/codev-sdk`** — a dependency-isolation split of `codev-core` rather than a dashboard extraction. Taxonomy: `codev-types` is the only package both sides share (wire contracts); `codev-core` becomes server-side implementation only; `codev-sdk` is the single client implementation of "how anything talks to Tower" (evolved `tower-client` with injected auth/transport, WS/message-bus client, and the client-side pure helpers). Its consumers exist today: the web dashboard, the VS Code extension, and the CLI's Tower-facing commands — mobile joins as the fourth. The sdk is framework-free in v1 (no React hooks; the extension host and CLI can't use them); an optional `/react` subpath may come later if web and mobile demonstrably duplicate hook logic.

The knots identified in the 2026-07-07 dashboard audit remain the sdk's design requirements (validated from the consuming side by the Expo spike, `spikes/expo-lan-reachability-2026-07.md`):

- **Explicit scoping.** The dashboard's API base is `'./'`; workspace identity rides the browser URL. RN has no URL context — the sdk takes explicit `baseUrl` + `workspacePath`.
- **Injected transport.** The dashboard's `useSSE` is a module-global `EventSource` with `document.visibilitychange` lifecycle. RN has no `EventSource` — transport arrives as an adapter, with `AppState` replacing visibility on RN.
- **Injected auth/storage.** Browser reads `localStorage['codev-web-key']`; the Node client reads `~/.agent-farm/local-key` via `node:fs`; neither is RN-usable. The sdk takes `getToken()` + storage interfaces.

### 7.3 Resulting monorepo layout

`apps/*` landed via #855 (merged 2026-07-16, PR #1188); `codev-sdk` is proposed in #1189:

```
apps/
  web/         Vite + React DOM. xterm.js, multi-panel, keyboard shortcuts. (was packages/dashboard)
  mobile/      Expo + React Native. Chat, feed, actions, push notifications. (future)
  vscode/      Extension. (was packages/vscode)

packages/
  codev/       CLI + orchestration (Tower-facing commands consume codev-sdk)
  core/        Server-side implementation (post-#1189)
  codev-sdk/   PROPOSED (#1189). Tower API client + WS/message-bus client + client pure helpers. Framework-free.
  types/       Wire contracts — the only package shared by server and client
  config/      Workspace config
```

---

## 8. Tower-side plumbing required

Not mobile-specific — benefits web dashboard equally. **All of §8.1–8.3 is new work** (verified absent, 2026-07-07); design coordination with main required so it isn't mobile-shaped.

### 8.1 `AskUserQuestion` detection

**Decided (2026-07-19, main's rulings on #1206 — see `decisions/askuserquestion-detection.md`)**: detection is **harness-side hooks**, not PTY parsing. A generated `PreToolUse` hook emits `question_pending` with the structured payload from `tool_input`; `PostToolUse` emits `question_resolved`. v1 covers builders only (the spawn path already writes per-builder hook config — the #1018 write-guard precedent); the architect bridge comes later and blocks nothing. The Tower contract stays harness-neutral: the hook is just the first emitter. Transport per ruling Q3: the pending *notification* rides #1194's `BusEventMeta` bus frame; the resolution *lifecycle* gets a dedicated endpoint with REST backfill; #1194 lands first. When a question is detected:

1. Extract `{question, options[], multiSelect, preview?}` from the tool call
2. Emit a `question_pending` WebSocket event with the structured payload + a message id + the source (which architect / builder asked)
3. Persist a `pending_question` row in `global.db` so late-joining subscribers see it — with the lifecycle fields required by `decisions/q3-offline-behavior.md`: `created_at`, terminal state (`answered | expired | superseded`), resolving surface, compare-and-set resolution.

### 8.2 `question_pending` WebSocket event

Consumed by:

- Mobile app → renders question card
- Web dashboard → renders inline picker in the relevant terminal / chat view
- VS Code extension → surface as a notification or sidebar prompt

All three consume through `codev-sdk`'s pending-question client (#1189; framework-free — each surface wraps it in its own state idiom).

### 8.3 Response routing — corrected (2026-07-19)

An earlier revision of this section claimed Tower "injects into the AI's context as a `tool_result`". **That was wrong.** Hooks (and any external observer) can only *detect* a question; the question itself is held by the harness's interactive TUI, and no Tower-side channel exists to hand it a tool result. Answering from another surface therefore means **synthesizing PTY input** (driving the TUI's own menu), which is materially harder than it sounds — "Other" free-text entry, multi-select, and the race against someone answering at the desk all complicate it. Per main's ruling (Q2, #1206):

- **v0 ships detect-and-notify**: every surface shows the pending question; answering happens at the desk. The mobile card renders read-only with an "answer at your desk" state until injection exists.
- **Remote answering is its own gated spike**, sequenced after detection ships. When it lands: response sent to Tower with `{message_id, selected_option_index, other_text?}`, resolution is compare-and-set on the dedicated lifecycle endpoint (§8.1), and other subscribers get `question_resolved` to dismiss their cards — that consumer contract is unchanged from the original design; only the injection mechanism was mischaracterized.

### 8.4 Push notification delivery

- Requires Tower Cloud SaaS (out of scope for local-only Tower)
- APNs (iOS) + FCM (Android) integration
- User controls per-notification-type opt-in — see `decisions/q4-push-controls.md`
- Deferred to a separate mobile-cloud spec; overlaps issue #655 (cloud messaging), which should be the coordination point

### 8.5 Gate approval endpoint (new since draft)

§2.3's approve/reject tiles need a Tower route that does what `porch approve` does today, preserving the human-only gate semantics (the `--a-human-explicitly-approved-this` contract must survive the trip through a mobile tap — i.e., the endpoint is authenticated as a human principal, never callable by an agent). Design with main; the web dashboard wants the same affordance.

---

## 9. Open questions → decisions

The seven open questions from the 2026-07-05 draft now have decision notes (status: proposed, pending main's ratification):

1. **Pairing model for desktop handoff** → `decisions/q1-pairing-model.md` — no pairing subsystem; the cloud account is the anchor and handoff is a URL.
2. **Auth model** → `decisions/q2-auth-model.md` — per-device mobile tokens under the cloud account; never `ctk_` on a phone; v0 LAN carve-out.
3. **Offline behavior** → `decisions/q3-offline-behavior.md` — snapshot cache, single-slot confirmed outbound draft, questions are server-held pending state with expiry/supersession; approvals never queue.
4. **Per-architect / per-builder push controls** → `decisions/q4-push-controls.md`
5. **Multi-workspace UX** → `decisions/q5-multi-workspace.md`
6. **Session presence** → `decisions/q6-session-presence.md`
7. **Notification permission on first launch** → `decisions/q7-notification-permission.md`

---

## 10. Prior art references

- `codev/research/mobile/feasibility-2026-07.md` — strategic frame (refresh of the May-2026 snapshot)
- Commercialization strategy (2026-05-21; local research note, unpublished) — Tower Cloud as the revenue line that mobile connects to
- Tower Cloud security review (2026-05-26; local research note, unpublished) — tunnel mechanics + the in-tower auth gap; the load-bearing findings are restated with code citations in `feasibility-2026-07.md` §5 (verified still open 2026-07-07: `server-utils.ts` `isRequestAllowed` returns true)
- Issue #855 — `apps/*` monorepo split; determines where mobile ends up living
- Issue #655 — cloud messaging (send/receive afx-style messages via Codev Cloud); the closest existing issue to mobile's backend needs
- Issue #1029 — artifact-canvas core/web/native split deferred until native rendering is committed; mobile's rendering spike feeds this
- Codev IDE fork (external: `amrmelsayed/codev-ide`) — desktop-side of the handoff story
- `packages/types` — wire contracts mobile consumes (already comprehensive; verified)
- `AskUserQuestion` tool schema — reference implementation in the Codev main harness

---

## Appendix A — Ground-truth verification log (2026-07-07)

Claims in the 2026-07-05 draft, checked against the repo:

| Draft claim | Verdict | Evidence |
|---|---|---|
| Chat maps onto existing message-passing | **Confirmed, better than claimed** | `/ws/messages` typed bus with `MessageFrame` exists (`tower-messages.ts`); `POST /api/send` with affinity/spoofing checks (`tower-messages.ts`, spoofing at the resolver) |
| "Same event stream the web dashboard consumes" for the feed | **Corrected** | SSE (`/api/events`) is coarse refetch triggers only (`packages/types/src/sse.ts`); dashboard polls `GET /api/overview` snapshots. No typed activity log exists |
| Tower "already parsed for phase / status changes" (§8.1 premise) | **Corrected** | Tower does zero PTY content inspection; only `lastDataAt` timestamps. `builders.status/phase` DB columns exist but the state path hardcodes `running`/`''` |
| `AskUserQuestion` detection feasible Tower-side | **Confirmed as design, absent as code** | Zero matches repo-wide; §8.1 is from-scratch |
| `pending_question` row in `global.db` | **Viable** | #1118 confirmed done: single `~/.agent-farm/global.db`, composite-keyed `architect`/`builders` tables with `spawned_by_architect`; adding a table follows the established migration path |
| Every action tile maps to an existing Tower API | **Partially corrected** | send/launch/stop/issue-search exist; gate approve/reject has no HTTP route (porch CLI only) — new §8.5 |
| Cloud relay for push/handoff | **Confirmed real code** | `tunnel-client.ts` HTTP/2-over-WSS, `afx tower connect`, `ctk_` keys, `cloud-config.json`; push wiring itself absent |
| Terminal WS could feed a read-only monospace snapshot | **Confirmed** | `/ws/terminal/:id` byte bridge with control frames (`pause/resume/seq`); read-only rendering is a client choice |
