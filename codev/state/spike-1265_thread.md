# Thread: spike-1265 — afx send corrupts in-progress user input

## 2026-07-30 — Spike start

Spawned in soft mode, SPIKE protocol. Question from issue #1265: idle-time (3s timer) is a bad
proxy for line-occupancy — `afx send` can land mid-draft and submit the user's half-typed input
as one blob.

The issue body is already a deep analysis with options A–L and a recommendation:
- **A**: fix + re-enable `composing` line-occupancy deferral (torn out in bugfix #492)
- **E**: event-driven flush the moment the user submits (line provably empty)
- **H**: tower-side draft byte capture + verbatim replay for the 60s max-age forced delivery
- J (bracketed paste) as a complement; B/C kill-yank demoted to single-line only.

Spike goal: validate A+E+H are implementable on the existing plumbing (composing flag,
SendBuffer, noEnter, websocket input path), POC the risky parts, surface gotchas, estimate
effort.

Plan:
1. Research — verify issue claims against tower-routes.ts / pty-session.ts / send-buffer.ts /
   message-write.ts / tower-websocket.ts; read #492/#403/#584 history.
2. Iterate — POC corrected composing signal + flush-on-submit + draft capture/replay; simulate
   keystroke streams at unit level.
3. Findings — codev/spikes/1265-afx-send-line-occupancy.md

## 2026-07-30 — Spike complete. Verdict: FEASIBLE (with revisions to the issue's assumptions)

Architect narrowed scope mid-flight: test the empirical unknowns against the REAL TUIs (Claude
Code 2.1.212, Codex 0.145.0), not bash/readline. Built a node-pty + @xterm/headless harness
(codev/spikes/1265-poc/) that drives the actual binaries and asserts on the rendered composer.
Claude submission tests used a dead ANTHROPIC_BASE_URL (zero API calls); codex ignores base-URL
override under ChatGPT OAuth, so codex used local /status only (3 tiny accidental prompts early).

Headlines (full detail in codev/spikes/1265-afx-send-line-occupancy.md):
- Baseline corruption reproduced verbatim (draft+message fused into one submission).
- **H (byte replay) validated on BOTH TUIs** — 3-line draft incl. a backspace edit reconstructed
  byte-identical after clear→inject→replay. App-agnostic per-line clear (^E ^U BS ×N) works on both.
- **E validated** — delivery 0ms after user Enter lands as its own queued entry, no concat.
- **A viable but the issue's clear-set was wrong**: ESC never clears codex (and needs ×2 on
  claude, with overlay hazards); **Ctrl+G opens $EDITOR(vim) on BOTH** — modal, never a clear key.
  Draft-buffer-non-empty (H's capture) subsumes the composing boolean entirely.
- **I is per-app**: claude needs UNbracketed atomic (bracketed atomic SUBMITTED THE DRAFT — the
  exact corruption); codex needs BRACKETED atomic (unbracketed \r became a newline). Both verified
  working in their correct form; atomicity genuinely closes the race.
- **#584 Enter-swallow does NOT reproduce** on current claude/codex — pacing is obsolete for them.
- Submit-detector hazards catalogued: \x1b\r, ctrl+J, backslash-continuation are newline gestures
  (today's includes('\r') heuristic would false-flush mid-draft).

Committed findings + POC on spike branch. Effort estimate: Medium. Recommended combination:
DraftTracker (A+E unified), H for max-age, per-app delivery matrix, K valve for unknown apps.

## 2026-07-31 — Review follow-up: kill-ring duplication bug CONFIRMED, recommendation fixed

A reviewer flagged that the documented max-age sequence chained H's per-line clear into the
atomic inject forms that END in Ctrl+Y — predicting the yank would resurrect a killed draft
line before the byte-replay, duplicating it. My original POC never ran that combined sequence
(h/h2 injected with plain writes; atomic forms were only tested on single-line drafts).

Built exp-i5-maxage-fullseq.cjs — full end-to-end sequence on a 3-line draft, both TUIs:
- Ring probe: after per-line clear, the ring holds exactly "first line" on BOTH TUIs
  (bottom-up kills, overwrite-not-accumulate semantics).
- Buggy (as-documented): "first linefirst line\n second line\n third" — duplication CONFIRMED
  on both, exactly as the reviewer predicted.
- Fixed (drop trailing Ctrl+Y from the multi-line path): byte-identical reconstruction on both.
- Bonus: empty-composer Ctrl+U does NOT scrub the ring on either TUI, so fix (b)
  "neutralize the ring" has no verified primitive — fix (a) is structural and sufficient.

Findings doc updated: delivery matrix split into non-overlapping single-line (kill/yank, ends
^Y) and multi-line (byte-replay, NO ^Y) paths; kill-ring interaction documented as a measured
constraint. Good catch by the reviewer — exactly the class of cross-primitive interaction this
spike existed to surface.

## 2026-07-31 — Review round 3: five integration concerns, all confirmed valid

Reviewer raised five integration-semantics concerns. Verified each against code and, where
testable, the live TUIs (new exp-i6-gating.cjs):

1. Restart amnesia — CONFIRMED (code): shellper keeps the TUI (and its draft) alive across a
   Tower restart, but reconcile builds fresh PtySession objects; _lastInputAt=0 means TODAY a
   post-restart send is instantly "idle" and can fire into a surviving draft. Recovered
   sessions must start dirty → defer + K.
2. Input gating — CONFIRMED (i6a): ungated user byte during the H maneuver got applied TWICE
   (live write + replay-append): "Zfirst line\n second lineZ". Gated variant (divert during
   maneuver, append after replay) reconstructed draft+Z exactly. My earlier "race closed at the
   protocol level" claim required this gate; doc now says so explicitly.
3. Flush ordering — CONFIRMED (i6b): flush written before the user's \r reaches the PTY submits
   the blob ("abc[architect] wrongorder" as one history entry). Flush must fire strictly after
   session.write(data); FIFO fd writes make that sufficient (clean two-entry result verified).
4. Enter ≠ empty composer — CONFIRMED (i6c, both TUIs): claude "/" menu + Enter submitted the
   menu SELECTION (/afx) while capture held "/"; codex "/" menu + Enter opened a full-screen
   model-picker modal. Bonus finds: claude restores queued messages into the composer on ESC
   (occupancy with no input frame — observed live when it contaminated an i6a draft), and
   codex's own tip confirms ESC-on-empty enters edit-last-message mode. Dirty-state machine +
   K for ambiguity is now a hard requirement; H/I forbidden while dirty (stale capture would
   replay already-submitted content).
5. Programmatic writers — CONFIRMED (code): cron deliverMessage (tower-cron.ts:303-323) writes
   with NO idle check and NO SendBuffer (bypasses even today's protection); noEnter leaves
   untracked composer text. Fix: hoist the tracker tap to PtySession.write() so every writer
   feeds it; route cron through the send pipeline.

Doc updated: new "Integration constraints (round 3)" section, K upgraded to required component,
DraftTracker respecified as a PtySession.write() tap, effort bumped to upper-Medium with
explicit phasing. All five concerns were correct calls — none invalidated feasibility, but
together they materially harden the design.

## 2026-07-31 — Review round 4: cursor semantics, K substrate, POC rigor

Three more reviewer concerns; all three were right.

1. Cursor-aware editing (exp-a3, asserted, both TUIs): Ctrl+U is KILL-TO-START, not
   kill-whole-line — uvwxyz+Left×3+^U leaves "xyz"; Backspace deletes at cursor. Round-1's
   "kills whole line" was an end-cursor artifact. A naive clear-buffer-on-^U tracker would
   declare an occupied line empty → corruption. Design revised: DraftTracker = raw replay log
   (ground truth for H — replay is immune to modeling errors) + cursor-aware modeled line
   state (powers occupancy); unmodelable bytes → dirty → K. The per-line clear maneuver is
   immune by construction (its ^E prefix; asserted from mid-line cursor).
2. K substrate (code audit): broadcastMessage is live-only fire-and-forget; the ONLY
   /ws/messages consumers in the repo are e2e tests; no messages table in global.db; and
   SendBuffer.stop() force-flushes on graceful shutdown (force-injects buffered messages
   regardless of typing — a today-gap). K rescoped as a real mailbox: persisted before send
   response, visible surface (dashboard/VSCode/afx inbox), held-vs-delivered send semantics,
   persist-on-shutdown. Effort now Medium-to-Large phased (~1050–1550 LOC across 3 shippable
   Mediums).
3. POC methodology: reviewer's rerun flake (i6a-gated-clean=false) root-caused — cross-demo
   contamination (i6b's retry queue + claude's ESC-restores-queued-messages) polluting a
   shared baseline, not a wrong gated result. Fixed structurally: a3/i5/i6 are now
   regression-grade — self-asserting (exit 1 on failure), fresh session per demo, per-demo
   baselines, content-based empty checks (never placeholder chrome; also de-flaked 'def' ⊂
   "default"). Full suite rerun: 6/6 runs exit 0, zero FAILs; stdout committed under
   1265-poc/results/ as retained evidence. exp0–i4 explicitly tiered as exploratory.

## 2026-07-31 — Architect-requested findings review (post-reset): APPROVE, high confidence

Architect set a goal: review the findings against the original spike task. Fresh-context
review performed (context was reset after round 4, so this was effectively fresh eyes):
re-read issue #1265 in full and confirmed the doc answers its A–L taxonomy without
re-deriving it; confirmed all task deliverables present (per-option go/no-go on the
recommended combination, effort estimate, POC on branch only); checked all six committed
asserted .out files end in ALL ASSERTIONS PASSED; re-verified seven load-bearing code
claims against the tree (timer-only shouldDefer + #492 comment ~tower-routes.ts:1570,
_lastInputAt=0 pty-session.ts:98, SendBuffer.stop() force-flush, cron deliverMessage
unguarded direct write, includes('\r') heuristic + track-before-write ordering in
tower-websocket.ts, broadcastMessage live-only, /ws/messages consumers = e2e tests only,
no messages table in db/schema.ts). All held.

Non-blocking nits recorded in the verdict: (1) header label "Feasible" could read
"Feasible with Caveats" given the material revisions (per-app I forms, corrected
clear-set, K rescoped to built mailbox, effort upgraded); (2) D/L lack explicit rows in
the per-option table (outside the recommended combination; rescoped K converges toward L
anyway). Verdict delivered in-terminal: APPROVE / HIGH.

## 2026-07-31 — Review round 5: i6 flake, writer serialization, noEnter/K drain

Three reviewer concerns, all valid; all three produced doc + POC changes.

1. i6 reproducibility (the round-4 6/6 claim challenged). Reviewer's two fresh claude
   reruns failed. Local repro: 5 whole-suite + 8 isolated-i6b runs of the ORIGINAL, 13/13
   exit 0 — but every run showed the right-order case executing inside queue-contaminated
   state ("Press up to edit queued messages" AS the composer extraction), passing only
   because 'def' doesn't collide with the hint. Pass-by-assertion-weakness, machine-basin
   dependent. Root causes are all previously-measured behaviors: shared dead-API session
   across the two i6b cases; inter-case ESC ESC = the constraint-4c restore gesture;
   Up-recall reads per-project history shared with ANY concurrent claude session in this
   repo (reviewer's own session, or mine). Fix: i6b split into two fresh sessions,
   Up-recall + ESC removed, transcript-entry assertions (i6c's pattern), collision-proof
   tokens. Post-fix 5/5 consecutive claude runs (11 asserts each) + codex pass; committed
   .out = run 5. Doc no longer claims unconditional 6/6; methodology says why.

2. Writer serialization (concern 2): exp-w1-writer-race.mjs drives the REAL
   message-write.ts at unit level: concurrent direct sends blob "msg1msg2\r\r" (w1a),
   paced sends interleave A1,B1,A2,B2 (w1b), send-during-escape lands inside ESC..Enter
   (w1c), delayOffset chaining serializes when used (w1d) — but only SendBuffer.flush
   uses it. Today-bug with no draft involved (two builders sending at once can blob).
   New integration constraint 7: per-session write transaction FIFO with completion
   chaining for ALL multi-step writers; user-frame divert generalizes i6a's gate; E's
   ordering becomes structural. Effort ~1130–1630, queue ~140 replaces gate ~60.

3. noEnter/K drain (concern 3): new findings section. Today: max-age writes noEnter text
   with no occupancy check; dead-session discard (WARN); unwritable drop (ERROR);
   shutdown force-inject — four corrupt-or-lose paths. Policy: noEnter never injects
   onto occupied/dirty (K-hold at max-age; staged text counts as occupancy on drain).
   K drain: agent-keyed rows surviving respawn, clean-event + poll + recovery triggers,
   oldest-first ahead of SendBuffer, occupancy re-checked at drain, held-until-
   delivered-or-dismissed; eventual delivery or persistent visible escalation, never
   silent loss.

Commits: da7e3cbf (concerns 2+3), 65daa69b (i6 fix + evidence).

## 2026-07-31 — Review round 6: H crash window, hold-first phasing

Two more reviewer concerns; both correct, both doc-level (no new POC needed — the
supporting measurements already exist in committed evidence).

1. H crash window CONFIRMED by construction: the per-line clear erases the TUI's draft
   while the only replay copy is Tower RAM; shellper persistence keeps the TUI (empty
   composer) alive across a Tower crash but not the buffer. The validated maneuver is
   ~50+ writes over ~2s (i5: 50ms clear steps, 14ms/char replay, settle waits) — no
   verified single-write form, and i3's fully-atomic claude attempt SUBMITTED the draft.
   New constraint 8: journal the capture to disk before the first destructive byte
   (transient row, deleted on successful replay, never logged — same privacy posture as
   mailbox content); crash/timeout → recovered session dirty + journal surfaced as a
   held draft-recovery entry, never auto-replayed. H reclassified GO-best-effort:
   worst case "composer copy lost, bytes surfaced", never silent loss; doubt → K.

2. Phasing safety CONFIRMED: original phases 1-2 kept today's force-inject at max-age
   and shutdown until phase-3 K existed, and dirty/recovered/noEnter/unwritable/dead
   cases have NO safe injection form — their only outlet is a hold. Rework: minimal K
   hold core pulled into phase 1 (persisted held store, held/delivered responses,
   drain-on-clean/poll, persist-on-shutdown, hold-at-max-age) — a reallocation of the
   K estimate, not new scope; inbox surface + cron rerouting stay phase 3. Interim
   visibility = held response + log + broadcast, acceptable because rows persist and
   drain automatically. New invariant stated in the doc: NO phase may ever force-inject.
   Verdict line updated (best-effort H, hold-first phasing); effort ~1200–1700 with the
   journal (~70) added.

## 2026-07-31 — Review round 7: cron-forward, convergence definition, axis reconcile

Two concerns, both correct — both were internal inconsistencies my earlier rounds
introduced or under-specified.

1. Cron contradiction CONFIRMED: round-6 phase 1 claimed "kills every force-inject
   path" while phase 3 deferred cron rerouting — and constraint 5 documents cron
   direct-writing the PTY today. Chose move-forward over narrow-claim: the minimal
   reroute (deliverMessage → shared deliver-or-defer pipeline, ~40 LOC once the
   pipeline exists) is a phase-1 item; cron-specific inbox attribution stays phase 3.
   Claim also tightened: "every MESSAGE force-inject path" (the human --interrupt /
   afx interrupt escape is the documented deliberate exception).

2. Convergence hole CONFIRMED against my own i6c evidence: a menu can predate
   recovery (TUI survives restart with the menu open), printables FILTER an open
   slash-menu rather than dispel it, and bare \r then submits the SELECTION — so
   "bare \r with no suspect frames since recovery" cannot prove clean. New
   constraint 9: dirty→clean requires user submit + a G-lite rendered composer-empty
   confirmation from the output ring buffer (fail-toward-dirty asymmetry makes the
   round-4 chrome-parsing flakiness safe here: unrecognized placeholder → stay dirty
   → K, degraded not corrupt); explicit human act also converges; tracked-clean
   sessions need NO G-lite (on-sight dirty-marking keeps their input-side submit
   classification sound). G row promoted: "G-lite slice required; full G not needed".
   ESC/Tab reconcile: the table conflated two axes — occupancy (Tab/ESC neutral, the
   #492 lesson) vs mode confidence (both suspects). Table rows now carry both axes +
   an explainer paragraph; "occupancy-neutral ≠ safe to inject".

Effort ~1270–1770 (G-lite ~70; cron reroute ~40 moved into phase 1).

## 2026-07-31 — Review round 8: agy, K's async contract, production-path G-lite,
## builder-convergence deadlock, preemption, cron coalescing, POC isolation

Eight concerns; all valid to some degree, five directly overturned earlier claims.
All investigated against code + POC; new experiment exp-g2 (production-path G-lite)
+ exp0c (agy probe); a3 restructured, i5 reclassified+hardened; full rerun green.

1. agy: config harness auto-detect (config.ts:256-278, #929) makes agy a send target
   TODAY. exp0c (agy 1.1.8, authenticated, observational): fresh spawn renders a
   WORKSPACE TRUST DIALOG — "enter Confirm" on "Yes, I trust this folder"; typed text
   doesn't render. Blind text+\r delivery = trust grant as a delivery side effect.
   Unknown-app defer-only+K is now a security posture; doc names agy explicitly.
2. K sync contract: verified today's response is {deferred:boolean}, outcome never
   reported. Redefined: rows persist AT ENQUEUE (SendBuffer collapses into mailbox),
   response speaks enqueue-time truth (delivered|held+id), max-age escalation is a
   visibility transition on the persisted row, outcomes async by id.
3. G-lite prod path POC'd: exp-g2 drives the REAL RingBuffer (transform-types import)
   + the exact client replay join (tower-websocket.ts:66-67) into transient
   @xterm/headless. recon==live everywhere. KEY MEASUREMENTS: placeholder text is
   SGR-DIM on both TUIs → classifier = "marker + zero non-dim cells", NO allowlist
   (kills round-4 rotation-flake worry); claude stream is NEWLINE-FREE (all bytes in
   the ring's unbounded partial, #1047 basin — capRingSeed byte cut is its real
   truncation, validated mid-sequence); resize nudge occupancy-neutral, fresh frame
   alone reconstructs.
4. Convergence deadlock CONFIRMED — worst round-8 catch: round-7's "user submit"
   gate starves every builder terminal (no human typist; interrupt/reset/restart all
   mark dirty). Constraint 9 inverted: the rendered proof IS the convergence; triggers
   are user-submit OR quiescence poll (no keystroke — validated: every g2 verdict ran
   on quiescent screens with zero input frames). Residual stated: codex ESC-on-empty
   fresh = measured no-op (g2h); with-history arming unverified → Next Step.
5. G-lite siting: @xterm/xterm is devDep-only, headless nowhere → new runtime dep;
   transient per-check emulator (never per-session); ~70 → ~150-200. Also corrected
   the effort headline arithmetic: round-7's ~1270-1770 sat below its own component
   sum; now ~1520-1670 code + ~400-500 tests ⇒ ~1900-2150 by component sum.
6. Preemption: verified the Spec-1273 comment (tower-routes.ts:1501-1506). Constraint
   7 queue gains an interrupt preemption lane — abort preemptible transactions at
   chunk boundary; H aborts into its journal, paced delivery re-holds unwritten tail
   visibly. Strict FIFO would regress escape's handled-before-buffer contract.
7. Cron×K: verified deliverMessage fire-and-forget (WARN-drops, run recorded off
   command result only). Added supersede-key coalescing for machine senders (one held
   row per cron task, replacement recorded, no-TTL for humans unchanged) + delivery
   outcome (delivered|held|superseded) in the cron run record.
8. POC isolation: reviewer right about the overclaim. a3 = 3 independent probes in
   one session with ^E^U (a3c's own subject!) as cleaner → restructured to fresh
   session per case, rerun green both TUIs. i5 = sequence test BY DESIGN (kill-ring
   carry IS the subject) — distinguished from round-4/5 contamination by failure
   direction (exact-equality oracles fail loudly vs fail-open !includes) + added
   asserts on the previously unasserted p3/p4 cleanups, rerun green. Tier claim now
   scoped per suite.

Version event: codex bumped 0.145→0.146 mid-spike. Entire asserted codex suite
(a3, i5, i6, g2) re-run green on 0.146 — the doc's own version-bump smoke-test
recommendation exercised for real; no divergence. Claude 2.1.212 unchanged.

Runs: 8/8 exit 0 (g2-claude, g2-codex, agy, a3×2, i5×2, i6-codex). Evidence
committed under 1265-poc/results/ incl. new exp-g2-*.out and exp0c-agy-sanity.out.

## 2026-07-31 — Review round 9: agy re-test, G-lite gaps closed, identity substrate,
## divert-window bounds, wrapper silent-loss, initial state, inventory sweep

Ten concerns; all valid, several overturning round 7–8 claims. New experiments exp-i7
(bulk replay) + exp-i8 (wrapper loss); g2 codex arm completed (7→25 asserts); a3
anchored; g2h made two-sided; exp0c re-run post-trust. Full suite re-captured green
(claude 2.1.212 / codex 0.146.0 / agy 1.1.8, @xterm/headless pinned 6.0.0 and stamped
into every .out).

1. agy re-tested post-trust: normal `>` composer, typed text renders (normal-intensity
   — NOT dim like claude/codex placeholders), ^E^U clears. `>` matches neither G-lite
   marker profile → never clean → auto-held. Trust is per-folder → fresh worktrees
   re-trap; born-dirty rule covers spawn-time.
2. G-lite gaps: g2h claim softened to "no rendered change" (cannot disprove invisible
   arming), assertion now two-sided (version tripwire). Nudge evidence extended to
   empty-composer convergence + codex (g2e2/g2k/g2l). Codex churn/byte-cut added (g2m).
3. Identity substrate CONFIRMED broken for delivery: detectHarnessFromCommand misses
   agy, resolveHarness falls back CLAUDE_HARNESS, config.ts:256-278 is JSDoc. Delivery
   matrix requires its own strict allowlist (unknown first-class → defer+K); resolver
   fallback would aim claude's atomic form at agy.
4. Divert window: i7 measured bulk clear/replay ~100ms with OPPOSITE per-app failure
   modes at size (claude: 41-round bulk clear stalls, paced fallback; codex: 1.8KB bulk
   replay paste-collapses, line-chunked fallback). Window now f(app, lines), ~1–3s
   typical — fail-open timeout specifiable. Doc's "few hundred ms"/"~2s" both corrected.
   Bonus finding: tall drafts scroll — the composer render is a window. Also
   root-caused+fixed an i7 harness settle-staleness race mid-round (condition waits).
5. Coverage overclaims fixed: doc/method now state i6 codex = 2/11 asserts; g2 case
   matrix completed on both TUIs; picker mechanism corrected (user-text via `›` rows,
   not no-marker). Cost measured: 2ms/13KB, 22ms/1MB, 67ms/4MB.
6. a3c anchored (pre-clear extraction must see draft — old !includes passed on
   placeholder); g2h unfailable branch fixed. Both re-run green.
7. Wrapper silent-loss CONFIRMED + measured (i8, production LAUNCH_LOOP_TAIL extracted
   at runtime): read -r consumes text into $REPLY and the \r RELAUNCHES the agent;
   successor stdin drain finds nothing; crash-window bytes land in booting claude's
   composer unsubmitted. → tracked-clean G-lite exemption withdrawn: rendered-empty
   check is now the UNIVERSAL pre-delivery gate (affordable per cost numbers).
   New constraint 10; ^C-on-empty-model now dirty-marking (deliberate-quit gesture).
8. Liveness: classifier profiles = per-app data keyed by the identity table; drift →
   permanently-dirty → held-forever is fail-safe but a liveness regression → phase-1
   classifier-health telemetry required. Nudge = on-demand with min-interval, never
   periodic.
9. Initial state: EVERY session born dirty (fresh spawns render Enter-traps: agy trust,
   codex onboarding); converges via first post-boot quiescence poll for known apps.
10. Inventory: /api/terminals/:id/write (:902) + afx reset added to constraint 5;
    preemption lane serialized + coalescing (#1264 double-^C); H population narrowed
    (linear multi-line, tracked-clean only) → phase-2 build/skip gate fed by why-held
    metadata; DraftTracker line model flagged as the only unprototyped component;
    @xterm/headless pinned.

Effort now ~1625–1785 code + ~430–530 tests ⇒ ~2050–2320 by component sum (identity
table +35, G-lite profiles/telemetry +50–60, lane serialization +20; H ~150 phase-2
gated). Phasing: phase 1 gains universal gate + identity table + born-dirty + telemetry.
