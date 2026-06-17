# PIR #1052 — vscode terminal corrupted + cursor-at-top after window reactivation

## Phase: plan

### Investigation (root cause)
Issue lists 4 candidate mechanisms. Investigated the VSCode terminal relay path:

- `packages/vscode/src/terminal-adapter.ts` — `CodevPseudoterminal`. PR #1050 (#1047)
  added a **post-connect repaint nudge** (`scheduleRepaintNudge`): ~500ms after a WS
  *connect*, if nothing rendered, it sends a `rows-1 → rows` size delta to force a
  SIGWINCH so a full-screen TUI repaints. It is **gated on `renderedSinceConnect`** and
  only fires on connect — there is **no equivalent on window reactivation** (the repro
  in this issue: lose+regain window focus with no reconnect).
- The manual workaround in the issue ("resize the VSCode window clears the corruption")
  is exactly a SIGWINCH → full TUI redraw. So the proven fix lever already exists; it
  just needs a new trigger: window refocus.
- Mechanism #3 from the issue (extend the nudge to fire on `onDidChangeWindowState`) is
  the cleanest, lowest-risk, and matches the dashboard's existing model:
  `packages/dashboard/src/components/Terminal.tsx:741` already re-fits + SIGWINCHs on
  `visibilitychange`. VSCode has no such handler — that's the gap.

### Root-cause localization (folded into plan Understanding after architect Q)
The WS lives in the **extension host** (Node `ws`), NOT the renderer. On window blur the
ext host keeps draining the socket; Electron throttles the **renderer** (pauses rAF →
xterm.js render loop stalls while its buffer fills), and the refocus catch-up is where the
cursor desync / stacked frames appear. So: not backend, not the WS relay/replay (rules out
issue mechanisms #2/#4), it's xterm.js render-state drift (mechanism #1) — renderer-side,
in code we don't own. SIGWINCH redraw is the only available lever and matches the proven
manual workaround.

### Decision
Primary fix = mechanism #3. Add a public `forceRepaint()` to the adapter (the size-delta
SIGWINCH, refactored out of the nudge timer, ungated by `renderedSinceConnect`), and wire
`vscode.window.onDidChangeWindowState` (rising edge: unfocused→focused) in the extension
to call it on managed Codev terminals. This is the load-bearing case for PIR's
`dev-approval` gate: visual, reproducible-only-in-real-VSCode.

### Status
- Plan approved (architect, plan-approval gate). Now in **implement**.

## Phase: implement
Three changes landed:
- `terminal-adapter.ts`: extracted `forceSigwinchRedraw()` from the nudge timer; added
  public `forceRepaint()` (ungated by renderedSinceConnect; no-ops disposed / not-OPEN /
  replaying).
- `terminal-manager.ts`: `repaintAllOnRefocus()` fans forceRepaint over all managed ptys.
- `extension.ts`: `onDidChangeWindowState` rising-edge (unfocused→focused) →
  repaintAllOnRefocus.
Tests: 4 adapter behavioral tests (forceRepaint fires post-render; no-ops ×3) +
2 source-level manager guards + vscode CHANGELOG entry (matched #1050: CHANGELOG only,
no live UNRELEASED.md on this branch).

### ROOT-CAUSE PIVOT (dev-approval gate, attempt #2)
F5 build with the SIGWINCH-nudge approach STILL corrupted on initial load. Architect: only
manual resize OR close+reopen fixes it. Key insight: both of those re-render VS Code's
*xterm.js*; a Pseudoterminal CANNOT (no xterm handle; `onDidOverrideDimensions` only
overrides when smaller-than-panel, not a refresh hook). 2-way consult: Gemini misfired
(empty sandbox), Codex nailed it → **defer connect until real size known**.
Real root cause: `open(initialDimensions===undefined)` on first open → we connected
immediately → replay rendered at the 80×24 default width → corruption. close+reopen works
because the 2nd open has real dims. **Fix:** defer connect until first `setDimensions()`
(2s fallback). Removed the dead post-replay nudge. Kept refocus `forceRepaint` for the
(separate, unverified) reactivation symptom. Tests: removed fresh-replay tests, added 5
defer tests; 427 unit pass, F5 compile/lint clean. Awaiting F5 re-test of initial load.

### ATTEMPT #3 — onDidOverrideDimensions (the user's API hint) + diag logging
Defer fix ALSO failed on initial load (same screenshot). 2 misses → stop guessing.
Decisive fact: ONLY resize/reopen fix it, both = xterm.js re-render. The sole pty→xterm
lever VS Code exposes is `onDidOverrideDimensions` (user flagged this earlier; Codex had
dismissed it — overruled). Wired it: `forceXtermReflow()` fires override(cols-1,rows-1)
then undefined 100ms later → forces xterm re-layout (mimics manual resize). Triggers:
after fresh full replay's `resume` (reflowAfterReplay, lastSeq<=0) + on refocus. Kept defer
(harmless). Added `[#1052-diag]` logging (open initialDimensions, setDimensions, reflow
fires) so if it STILL fails the user can paste the Codev output channel and I get real data
instead of a 3rd guess. 430 unit tests pass, F5 compile/lint clean. **Unconfirmed — awaiting
F5 test. If it works: strip diag logs + finalize CHANGELOG.**

### DATA-DRIVEN PRUNE (diag log captured)
Architect ran F5 + pasted `[#1052-diag]` log. Decisive facts:
- `open() initialDimensions=114x40` (NOT undefined) → **defer-until-sized (attempt #2)
  FALSIFIED** — it never engages. Removed entirely: `awaitingInitialSize`,
  `initialConnectTimer`, `INITIAL_SIZE_FALLBACK_MS`, open/unsized branch, setDimensions
  deferred-connect branch, close cleanup, 5 defer tests. open() reverts to always-connect.
- replay is tiny/instant (pause→resume same ms) → "oversized replay renders corrupted" not
  the mechanism here.
- post-replay `forceXtermReflow` override(113x39)→release DID fire (mechanically works).
- **Smoking gun:** pane resized 114x40 → **116x41 at +148ms** (setDimensions AFTER our
  reflow already released). Geometry still settling; every redraw lever fires during the
  settling window against a stale size. → next fix direction (if reflow ineffective):
  debounce reflow until size stabilizes.
Still KEPT (not decided by this log): refocus path (attempt #1, different trigger, not
exercised) + post-replay reflow (attempt #3, live candidate). 425 unit tests pass.
Awaiting architect's visual result (fixed or not) before next step.

### REGRESSION + REVERT (override reflow caused scroll distortion)
Attempt #3's onDidOverrideDimensions reflow REGRESSED: scrolling distorted (doubled/
overlapping chars = xterm scrollback wrap corruption). Mechanism: override shrinks xterm
1 cell then releases — a down-then-up reflow round-trip churns scrollback line-wrap flags.
Reverted entirely (override emitter, forceXtermReflow, reflowAfterReplay, tests). 422 pass.

### REFINED ROOT CAUSE (4 client-side levers now falsified)
Falsified: defer-until-unsized (#2), post-replay SIGWINCH (#3a), override reflow (#3b).
Through-line: **manual resize OR reopen fixes it** — both force a full xterm re-wrap /
fresh state. Best hypothesis: **replay-width-mismatch.** Tower replays the ring-buffer
(composed at capture-time PTY width) into xterm at the client's CURRENT width; panel then
settles 114→116 (~120ms post-open, per diag log), so the chat-history scrollback is wrapped
at the wrong width → distortion on scroll + corrupt initial frame. SIGWINCH doesn't fix
(redraws alt-screen, not scrollback wrap). Corrupted content in screenshots = main-screen
chat transcript (wrap-subject), not the alt-screen TUI box — supports this.
Candidate fix: **settle-debounce the CONNECT/replay** — wait until setDimensions stops
changing, THEN connect once at the final width (differs from reverted #2: keyed on "size
stable", not "size present"). NOT YET IMPLEMENTED — escalating to architect first given the
4-miss streak; consider a consult to de-risk.

### THE ACTUAL FIX (attempt #5): buffer-and-flush, ported from the web client
Tower investigation (tower-websocket.ts): replay is byte-identical for web + VSCode (no
per-client logic). Web client does NOT have the bug → Tower is correct, fix is client-side.
Read web's flushInitialBuffer (Terminal.tsx:463): it BUFFERS the replay, waits 500ms, fits,
then paints ONCE at the settled width. VSCode adapter painted the replay IMMEDIATELY at the
unsettled width → ghost status bar (drawn at 114, restranded when size→116). Diag screenshot
confirmed: two INSERT bars, top one wider ("· ← for agents") = drawn at a different width.
**Fix:** port buffer-and-flush into terminal-adapter.ts. Hold ALL output from `pause` until
a debounced settle flush (REPLAY_SETTLE_MS=150, reset on each setDimensions), then paint once
after sizing the PTY to the settled dims. Preserves #1047 (replay off backpressure budget,
pause/resume) and #625 (resize deferred during hold). resetStreamState/close clear the hold.
Tests: 4 new buffer-flush tests + updated #1047 oversized-replay test (advance past settle).
426 unit pass, F5 compile/lint clean. Most-grounded attempt — ports the proven-working
client, not a new theory. Awaiting F5 visual re-test of initial render (ghost bar gone?).
Recommendation if confirmed: strip [#1052-diag] logs, finalize CHANGELOG, write review.

## Phase: review
- dev-approval APPROVED → review phase.
- Wrote codev/reviews/1052-*.md (Summary + Files + Commits + Test Results + Architecture
  Updates + Lessons + Things-to-Look-At + How-to-Test). Routed COLD: arch.md replay-contract
  section extended (#1052 render-at-settled-size); 2 lessons-learned.md entries (Debugging:
  SIGWINCH redraws app-frame not scrollback + buffer-and-flush; Architecture: shared-shape-
  not-substance + verify-against-file). No HOT change (meta-lessons already hot).
- PR #1061 opened (body = review, Fixes #1052), recorded with porch.
- porch done → single-pass 3-way consult run.
- VERDICTS: Claude=APPROVE (clean, no code changes), Codex=REQUEST_CHANGES (stale PLAN only,
  "code looks coherent"), Gemini=misfire (agy got no prompt — non-verdict).
- No code defect found. Codex's only point = stale plan → addressed (5afa0163: SUPERSEDED
  banner on plan pointing to review). Frontmatter deliberately NOT fabricated (PIR plans
  human-only reviewed). Rebuttal: f93f3ecb.
- Minor doc items escalated to architect at pr gate: UNRELEASED.md (CHANGELOG-only per #1050
  precedent + only template on main); plan frontmatter.
- porch done → **pr gate PENDING**. Architect notified (led with REQUEST_CHANGES disposition).
  Waiting for human to merge on GitHub + approve pr gate. Will verify gate_status=approved
  before `gh pr merge --merge` + `porch done --merged 1061`.

### REFOCUS PATH — A/B RESULT (architect-tested): opt-in, default OFF
Architect ran the A/B (codev.terminal.repaintOnRefocus ON vs OFF): **no observable
difference, clean both ways.** Conclusion: buffer-and-flush fixes the confirmed (initial-
load) corruption; the refocus SIGWINCH path has no demonstrated effect. Decision: KEEP it as
an opt-in escape hatch but **default false** — enable only if a setup still sees stale
content after refocus. Updated: package.json default false + description, extension.ts
fallback false + comment, terminal-manager.ts doc (noted "all" is coarse; narrow to active
if ever defaulted on), CHANGELOG (main bullet = initial-render fix; refocus = opt-in setting).
For the review: the confirmed fix is the replay buffer-and-flush; refocus is an off-by-
default escape hatch retained because the issue title names window-reactivation but no repro
of it survived the buffer-and-flush build.

### NOTE TO INCLUDE IN THE REVIEW FILE (architect-requested)
When writing codev/reviews/1052-*.md, add an "Architecture / reuse" note:
- Terminal-client primitives are ALREADY centralized in core and reused by both the VSCode
  adapter and the web dashboard: `reconnect-policy` (BackoffController/classifyUpgradeError)
  and `escape-buffer` (the dashboard's packages/dashboard/src/lib/escapeBuffer.ts is a 5-line
  RE-EXPORT shim of @cluesmith/codev-core/escape-buffer, not a copy — verified by reading it).
- The replay buffer-and-flush added here was DELIBERATELY left per-client, NOT extracted.
  Rationale: shared *shape* (hold replay → flush once) but divergent *substance* — web uses a
  fixed 500ms-from-first-byte trigger entangled with FitAddon/ScrollController; VSCode uses a
  150ms resize-debounce + PTY-resize + paced writeChunked. The common kernel is ~10 trivial
  lines; the valuable parts (trigger policy, flush body) differ. Extracting would be a leaky/
  wrong abstraction coupling two independently-evolving strategies. Recorded so a future
  "tidy-up" doesn't centralize it by mistake.
- Correction logged: I twice claimed EscapeBuffer was duplicated based on the import path
  alone; reading the file showed it's a re-export. No dedup issue filed (nothing to dedupe).

### dev-approval gate feedback (architect)
- Naming: renamed `forceSigwinchRedraw` → `sendRepaintNudge` (SIGWINCH was the only
  identifier in the repo baking in the signal name; all others keep it in comments).
- **Scope broadened.** Architect tested F5 dev build → corruption ALSO on *initial load*
  (until manual resize), not just refocus. Root cause = #1050's connect-time nudge is gated
  on `!renderedSinceConnect`, so a *corrupted-but-rendered* full replay skips the nudge
  (#1050 only fixed *blank* on open). Fix extended: arm `nudgeAfterReplay = (lastSeq<=0)` at
  connect; on the replay's `resume`, force one clean `sendRepaintNudge()`. Reconnect deltas
  (lastSeq>0) stay gated (no reflow, preserves #1050 intent). +2 adapter tests (fires on
  fresh replay; does NOT fire on reconnect delta). 424 unit tests green. Now covers BOTH
  triggers with one lever. Awaiting re-test of on-open at the gate.
