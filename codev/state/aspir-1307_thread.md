# aspir-1307 — `/arch-save`: packaged save→clear→re-init for architects

## 2026-07-31 — Specify phase, iteration 1

Spawned strict-mode ASPIR on issue #1307. No spec existed on disk, so `porch next`
put me straight into Specify with a blank sheet.

### What I read before writing

- **Issue #1307 + both comments.** The second comment is a *correction* that changes
  the design and is easy to miss: monitors are **session-bound, not context-bound** —
  a watcher armed pre-clear SURVIVES `/clear` and fires stale alerts into the fresh
  context. So the state block's monitor list is a **kill-list AND a re-arm list**, in
  that order. The original "monitors die at the clear" framing in the issue body is
  superseded.
- **`.claude/skills/arch-init/SKILL.md`** — the save discipline (§"Saving your state")
  is the prose this issue asks to package. Its human-keystroke rule is the invariant
  that must survive packaging.
- **`packages/codev/src/agent-farm/commands/reset/`** (Spec 1273, PR #1305) — the
  machinery to reuse: `receipt.ts` (nonce-in-file freshness gate, R2), `index.ts`
  (ordering state machine + step log, R1/R3/R4), `reset.ts` (port bindings).
- **`servers/message-write.ts`** — confirmed `escape: true` discards the body, so
  `/clear` must go over `raw: true`. Already handled in reset's port split.
- **`commands/whoami.ts`** — architect identity comes from `CODEV_ARCHITECT_NAME`,
  builders from worktree cwd. This is how self-invocation is detected.
- **`servers/tower-cron.ts`** — precedent that Tower already runs deferred work.

### The crux I had to design around

`afx reset` works because the invoker is a *different* terminal from the target. For
`/arch-save` the architect is often the invoker AND the target, and that breaks two
things at once:

1. The quiescence gate (R4) can never pass — the CLI's own output is the noise it is
   waiting to stop.
2. The CLI process dies with the clear, so it cannot deliver the re-orientation.

The issue's own design note calls the answer: Tower survives the clear, so **Tower
owns the post-arm sequence**. The CLI arms an in-memory Tower job and exits so the
architect's turn can end. External (owner-run) invocation arms the same job and just
tails it. One state machine, two front doors.

### Decisions baked into the spec

- Dedicated `afx arch-save`, not `afx reset <architect> --state` — reset resolves
  targets via `findBuilderById`, architects are not builders, and arch-critical says
  add a dedicated concept rather than bolting a flag onto a shared one. Machinery is
  factored out and shared, not duplicated.
- Re-orientation payload is **exactly `/arch-init <name>`**, delivered raw. Every
  resume instruction lives in the state file, because that is what `/arch-init` reads.
  Appending a checklist to the injected line would corrupt the slash-command argument.
- Nonce round-trip kept from #1273 (arm → nonce → architect writes → Tower verifies),
  so both invocation modes share one freshness proof.
- `--boundary` is required and is where the relocated human decision is recorded.
- New: a required `## Monitors` section in the state file, so "none armed" has to be
  written consciously rather than omitted silently.
- New: the CLI snapshots the *previous* state file at arm time. These files are
  gitignored (`.gitignore:15`), so a bad save is otherwise unrecoverable.

### Known dependency, flagged not blocking

The #1273 live e2e ("does `/clear` actually take effect over the raw channel") has not
run. Spec records it as a Critical open question with an explicit mitigation: every
gate aborts *without* clearing, and a no-op `/clear` degrades to "architect keeps its
context and also gets `/arch-init` re-injected" — which loses nothing. Proceeding
rather than blocking; called out for the architect at the PR gate.

Next: write `codev/specs/1307-arch-save-packaged-save-clear-.md`, then `porch done`.

## 2026-07-31 — Specify iter 1 review: REQUEST_CHANGES, and it changed the design

Claude returned `REQUEST_CHANGES` (HIGH confidence) after verifying my factual claims
against the code — all held. Codex could not run (see below). Seven issues raised; I
agreed with all seven and one of them moved the recommended architecture.

**The one that mattered — write-then-verify.** The review asked why I hadn't considered
having the architect write the state file *before* invoking the CLI, so the CLI could
validate synchronously and arm only `quiesce → clear → reorient`. I hadn't, and it wins:

- Removes receipt polling from Tower entirely — the new server-side surface drops to one
  small job.
- Makes "no clear without a verified save" **true by construction** in the self path,
  rather than a gate that could be misordered.
- Collapses the clear-after-new-work window from up to 300s to a single quiet window.

Kept the original nonce/Tower-armed shape as Approach 1b with explicit rejection reasons
rather than deleting it. The external (owner-run) path still uses the nonce receipt gate,
because there a *remote* party is being asked to comply — and that gate already exists
and works in the CLI process. Two proof-of-save paths, one shared destructive job.

**A consequence I had to chase down myself**: write-then-verify breaks the state-file
snapshot. The CLI used to run before the overwrite; now it runs after. So in the self
path the snapshot has to be the *skill's first step*, and the test has to compare
snapshot content (not just existence) or a snapshot-taken-too-late passes silently.
These files are gitignored — there is no second chance to notice. Logged as its own risk
row.

**Other six, all incorporated in place:**
1. Post-clear "stop stale monitors" was unimplementable as I wrote it — no enumeration
   mechanism, and comment 2 says `pgrep` can't see harness tasks. Restated: pre-clear
   stop is the enforceable half (that context holds the handles); post-clear is
   best-effort reconciliation + disregard-what-you-can't-account-for.
2. My `## Monitors` heading gate contradicted the v67 template I claimed to adopt
   (its monitor list lives in a `#`-comment intent stamp). Worse, I mandated a gate
   while leaving its placement an open question. Now a `MONITORS:` token the template
   carries verbatim; open question closed.
3. Clear-after-new-work hazard — absent from risks, questions and tests. Added to all
   three; mitigated structurally by write-then-verify + first-quiescence-only firing +
   bounded armed lifetime.
4. `--boundary` overclaimed as "a recorded human decision" — in the self path the agent
   types it. Now records invocation mode and states the limit plainly.
5. Quiescence-against-a-live-TUI is a *second* unrun-e2e unknown, not just `/clear`.
   Safe but total failure (feature never fires). Live run scoped to both.
6. `sendRaw` vs `sendMessage` divergence: reset wraps its reorientation in a
   `[MESSAGE FROM …]` envelope, which would stop `/arch-init` being a slash command at
   all. Recorded as a constraint the shared extraction must not collapse, plus a test
   asserting the exact channel and payload.

Also flagged: raw-typing a slash command *with an argument* may hit autocomplete and
have Enter accept a completion instead of submitting. This is the one step with no safe
degradation — a swallowed reorientation leaves a *cleared* architect with no identity —
so it's a risk row demanding live confirmation, not an assumption.

### Codex lane down — escalated, ruled on

`consult -m codex` failed: server rejects `gpt-5.6-sol` as needing a newer Codex. I
checked the global CLI (0.146.0), judged a global upgrade out of a builder's scope, and
escalated rather than working around it. Architect's ruling: correct call, but wrong
culprit — consult's codex lane runs `@openai/codex-sdk` with its own **vendored** binary
(0.142.5), a different client from the global CLI entirely. PR #1309 bumps it; needs the
owner's merge word plus a global reinstall.

Directed path: neither "proceed claude-only" nor "wait idle" — keep revising now, and
re-run codex against the **revised** spec once the reinstall lands. Strictly better than
having codex review a draft Claude already marked up. Not re-running consult until the
architect pings.

## 2026-07-31 — Architect design input: the autocomplete hazard, designed out

Architect offered a design input (explicitly "not a directive") on the one risk I'd
flagged as having no safe degradation: raw-typing `/arch-init <name>` into a TUI, where
autocomplete may eat the Enter and leave a *cleared* architect with no identity. Their
point: the payload doesn't have to be a typed slash command at all.

Evaluated and **adopted**, with one addition of my own.

**What it costs**: deterministic harness-level skill loading, traded for model-side
invocation. That would be a bad trade if the payload *depended* on the skill firing.

**So I required it not to.** The message must be self-sufficient — identity and
state-file path stated inline — so a session that never invokes the skill still knows
who it is and where its state lives, and recovers by reading the file directly. Skill
invocation becomes an upgrade (whoami validation, architect guardrails) rather than the
load-bearing step. A step with no safe degradation now has two.

Bonus simplification: with a plain-text payload this command's delivery matches reset's,
so the `sendRaw`-vs-`sendMessage` divergence I'd recorded as a constraint mostly
dissolves. The raw/escape split still has to survive extraction — `/clear` itself is
still raw-typed, and Tower's escape route discards the body — so that constraint stays,
narrowed to where it actually bites.

Also added, per the same input: an explicit worst-case statement under Notes. State file,
terminal, and Tower's record all survive every failure mode, so the worst realistic
outcome is a live terminal with no identity *yet* and its full state one message away —
recoverable manual re-entry, not data loss. Worth writing down because it reframes how
the whole risk table should be weighed: the only expensive failure is clearing without a
good save, and that one is now true by construction.

Swept the spec for stale references afterwards — nine places still described the payload
as a raw-typed `/arch-init <name>` (Desired State, success criteria, Approach 1, the
Critical open question's mitigation, Security, test 1, Dependencies). All updated.

Still holding on codex; #1309 queued for the owner's merge word.

## 2026-07-31 — Owner directives, then codex round. SPECIFY COMPLETE.

Two owner directives arrived (via architect), then the codex lane unblocked (#1309
merged, reinstall done) and codex reviewed the revised spec.

**Owner directive 1 — pruning is a REQUIREMENT.** The save must remove cruft, not just
append. Resolved loops deleted, older entries collapsed to pointers at durable artifacts,
one-screen order of magnitude. A save that only appends FAILS acceptance.

**Owner directive 2 — the reorientation delivery mechanism is explicitly UNDECIDED.**
Owner: "I'm not sure the best way to send the /arch-init again." This *reversed* what I'd
settled one message earlier. Correctly so: I had settled that question twice, in opposite
directions, both times on reasoning alone. Now a named open decision with three
candidates (raw-typed slash command / plain-text instruction / 1273's file+inline shape),
to be resolved empirically against a real terminal with the reason recorded. Noted
honestly that candidate (c) is proven in tests and design only — 1273's live e2e never
ran — so it doesn't get credit it hasn't earned.

Lesson worth keeping: "settled by argument" kept *looking* like progress. Two reviewers
and an owner all had to push back before it became an explicit open decision.

### Codex round — 7 findings, all accepted, two of my premises were false

I verified codex's two factual claims against source before acting (standing lesson:
reviewer claims are evidence, not ground truth). Both correct, both fatal to something
I'd asserted:

- **`tower-cron.ts:70` ticks every 60 SECONDS**, over filesystem-backed definitions. My
  "the job rides an existing Tower tick" claim was wrong, and 60s cannot observe a 1.5s
  quiet window. Clear-job now runs its own bounded loop; retracted the claim in-text so
  the next reader doesn't re-derive it.
- **`lastDataAt` is a last-output timestamp** (`terminal/shellper-client.ts`); Tower has
  no turn id or input-generation counter. So "original turn ended" and "follow-up turn
  ended" are *observationally identical* — my criterion "the clear can never destroy work
  created after the verified save" was UNIMPLEMENTABLE. Worse: that criterion was my own
  fix for Claude's C3. I closed a hazard with a mechanism that can't observe what it
  needs to. Downgraded to a bounded window + an output-total heuristic labelled as a
  heuristic, with the residual gap named and a Tower observable raised as an open
  question rather than pulled into scope.

Two findings produced genuine design improvements, not just wording:

- **`--begin`/`--boundary` handshake.** Codex caught that the self-path snapshot was
  convention-owned — the skill took it, nothing verified it. Fix: `--begin` snapshots
  under machine control and issues a token `--boundary` requires. Closes the snapshot
  hole AND restores a machine-proven freshness token to the self path, which I'd traded
  away arguing self-attestation was equivalent. It wasn't — precisely because it left
  snapshot ordering unproven.
- **In-memory execution vs durable intent record.** I'd required a dropped job be
  "reported rather than silent" while specifying purely in-memory jobs — those can't both
  hold. Split: execution in memory (fail-safe, a restart can never clear), intent record
  durable and inert (makes status/cancel/dropped-job reporting implementable).

Also: exact compaction predicate (reject if snapshot survives as an unmodified leading
section) replacing a vague size comparison — admits the compact-and-grow case a size
ratio would wrongly reject; no-predecessor case defined; preflight vs post-verification
failure guarantees split, since "every gate leaves a saved state file" was false for
preflight; and Test 2 fixed, which still described the superseded nonce-before-write
sequence because I revised prose without re-reading tests against it.

Rebuttal written (all 14 findings accepted, no disagreements defended). `porch done`
passed checks. **SPECIFY COMPLETE — advanced to PLAN.** No spec gate in ASPIR.

Commits: 4150edb7, 1f11f794, de043dfd, 93bd2a9d.

### LESSONS — carry these verbatim into codev/reviews/1307-*.md

Architect asked that the first one be recorded verbatim. Both are review-file material,
staged here so they survive the phase boundary.

1. **"I closed a hazard with a mechanism that cannot observe what it needs to."**
   A fix's *implementability against real observables* is part of the fix, not a
   downstream implementation detail. I answered Claude's clear-after-new-work finding
   with "fire on the first quiescence transition" — which reads as a real mitigation and
   is not one, because `lastDataAt` cannot distinguish which turn just ended. The fix
   survived a full review cycle before Codex caught it. When proposing a mitigation,
   name the observable it reads and confirm that observable exists.

2. **Verifying reviewer factual claims against source paid off twice in one round.**
   Codex made two claims about the codebase (`tower-cron`'s tick interval, `lastDataAt`'s
   semantics). I checked both before acting. Both were correct — and each invalidated a
   premise I had written into the spec. The habit is usually framed as protection against
   *wrong* reviewer claims; its larger value here was confirming *right* ones fast enough
   to act on them with confidence instead of hedging.

3. **"Settled by argument" kept looking like progress.** The reorientation delivery
   mechanism was settled twice, in opposite directions, before the owner made it an
   explicit open decision. Neither settlement had an empirical check behind it. A
   decision with a plausible rationale and no evidence should be *labelled* undecided,
   not recorded as decided-with-reasons.

Follow-up filed by the architect out of this round: **issue #1310** (monotonic
per-session input-generation counter). It is the observable that upgrades this spec's
bounded window to a guarantee, and it fixes the same blind spot in `afx reset`'s R4.
This spec ships without it and references it where the gap is named.

## 2026-07-31 — OWNER DESCOPE. Spec and plan rewritten; 1164 → 438 lines.

I had just finished a seven-phase plan when the owner's descope landed: *"this is
overcomplicated way more than it needs to be."* He's right, and the whole architecture is
gone.

**New target shape — the entire feature:**
1. `afx send --delay <seconds>` — Tower-side deferred delivery, one parameter on the
   existing send path. Not a client that sleeps, not a job orchestrator.
2. `/arch-save` as a SKILL: stop monitors → write the pruned state file → `--raw '/clear'`
   → `--delay 15 --raw '/arch-init <name>'`.

**Dropped:** Tower-armed quiesce/clear/reorient job, `--begin`/`--boundary` handshake,
durable intent records, bounded-window machinery, the validation module, the shared
extraction from `commands/reset/`.

**Kept:** pruning-as-requirement; the empirical check (narrowed to "does raw-typed
`/arch-init <name>` land," with the production workspace's successful manual runs as
existing evidence); and the failure-containment posture stated plainly as the *reason*
heuristics suffice — state file survives, terminal alive, manual re-send recovers
everything. Tail hazards get one honest RISKS section marking them accepted-as-recoverable,
with #1310 referenced as the future primitive if evidence ever shows they bite.

### The lesson, and it is the biggest one of this project

**Two CMAP rounds and several owner exchanges all worked on making the design *sound*
without anyone asking whether it was *proportionate*.** Every round added rigour to
machinery that should not have existed. The reviewers weren't wrong — their findings were
sound answers to a question we shouldn't have been asking at that cost. But reviews
optimise the design *in front of them*; none of them is structurally positioned to ask
"why is this here at all?"

I was the worst offender: I had the failure-containment analysis in hand — I wrote "the
worst case is manual re-entry, not data loss" into the spec myself — and did not draw the
obvious conclusion, which is that machinery to prevent a one-message loss is not worth its
weight. I treated that analysis as *reassurance about* the design instead of *evidence
against* it. The descope came from outside the review loop because it could only have come
from outside.

Concretely worth carrying to the review file: **when you find yourself proving a design is
safe, check whether the thing it protects is expensive.** A cheap failure plus elaborate
prevention is the signature of over-design, and it is visible in the spec's own text well
before anyone says so.

Also: the descope vindicates the earlier "settled by argument kept looking like progress"
lesson at a larger scale. Same failure mode, one level up — local rigour masking a global
question nobody asked.

### One thing I did carry forward deliberately

The failure-containment analysis itself. Knowing *precisely* how cheap the failures are is
what makes the small design defensible rather than merely smaller. That analysis was
produced by the hardening rounds, so those rounds weren't wasted — they just produced a
different deliverable than the one they thought they were producing.

### Plan rewritten: 3 phases

phase_1 `afx send --delay` (Tower-side) → phase_2 skill in four trees + template →
phase_3 live e2e + docs.

**The one security-relevant call in phase 1**, flagged there with its own acceptance
criterion and test: `--delay` defers *delivery*, never *authorisation*. Target resolution
and the builder-spoofing check must run at request time, or a delayed send becomes a way
to defer a check past the conditions that would fail it. Easy to get wrong by treating
`--delay` as "the same send, later."

## 2026-08-01 — Phases 1 and 2 complete; coordination with aspir-1273

**Phase 1 (`afx send --delay`) took EIGHT review rounds**, six finding real defects. Two
patterns, each repeated three times:

*Artifacts asserting something adjacent to the real thing* — a test against a copied
predicate, against a replica helper, against a synthetic callback, and a SPEC claiming a
request-order FIFO guarantee the code deliberately did not make. Each passed self-review
because the artifact existed.

*Fixes correct about the mechanism, incomplete about its lifetime* — serialising the
callback but not its writes; guarding `hasPending` but not `flush()`'s own drain; clearing
the registry but not the already-attached `.then()` continuations. Each worked for the case
I was picturing and left the adjacent one open.

One cheap check catches both classes: **mutate the guard, confirm the test fails.** By the
end I ran it before claiming a fix rather than after being told — which is how the
mid-flush test's vacuous first version (4-line message, writes completing in ~110ms, so the
delayed send never entered the window it was named for) got caught by me instead of a
reviewer. Same again in phase 2: I noticed only 4 of 5 test files executed and found
`init.test.ts` is excluded in `vitest.config.ts`, so an assertion I had just added guarded
nothing.

**Phase 2 (skill in four trees)** approved in two rounds. Both reviewers caught that my
"all four copies identical" was verified by hand with md5 and not guarded — `skill-parity`
only compares providers *within* a tree, never instance vs skeleton. Codex separately caught
a real overclaim: the skill said Tower "delivers it after the clear has landed" when Tower
only waits out 15s and never observes the result.

### Coordination with aspir-1273 (submission lock, PR #1320)

Their production e2e found `afx reset`'s `/clear` arriving as literal text welded to the
next message — never executed, context intact, every layer reporting success. Root cause:
`writeMessageToSession` schedules its Enter 50–80ms later and `/api/send` responds once the
write is *scheduled*, so an awaited send resolves before its own submission.

**Ordering is not atomicity.** My FIFO work decides which message goes first; it does not
make a delivery atomic. Architect ruled 1273 owns the primitive and I adopt it unchanged.

Two things I contributed by checking rather than accepting:
- Their datum that "reset's own writes bump `_lastInputAt`, so the flow trips its own
  buffering" is **false** — `recordUserInput()` is called only at `pty-manager.ts:310/:317`,
  both in the websocket handler. They verified independently and retracted it.
- Measured the merge surface with `git merge-tree` rather than guessing: merge-base
  `57c51a6e`, exactly one conflicting file (`tower-routes.ts`), test file auto-merges.

And one correction I received, which changed the work: adopting #1320 is a **replacement,
not a deletion**. It wires only the escape and immediate paths, so I must ADD two
`submitToSession` call sites (delayed delivery, `flush()`'s drain) before removing
`writeCompletesInMs`, `busyUntil`, and `delayed-send.ts`'s chain. Recorded as a six-step
sequence in the plan.

The line 1273 drew and I am keeping: their test proves the *primitive* supports the
pattern; it cannot prove *my wiring* of it is correct. Different claims.

### 2026-08-01 — merged origin/main (architect-directed)

PR #1324 landed, skipping `agy-integration.e2e.test.ts` which was opening OAuth browser
windows on the human's machine during suite runs. Previewed with `git merge-tree` first:
clean, no conflicts. #1320 had **not** landed, so no adoption work triggered.

Post-merge: install/build clean, 4149 tests passing (up from 4090 — incoming Spec 1280
tests). Re-ran my own suites explicitly rather than trusting the aggregate: 186 Spec 1307
codev tests + 48 core, all green, all four `ORDERING:` guards intact.

Note for later: the agy binary was briefly disabled machine-wide (gemini lane skipping);
that was reverted the same day and agy is back on PATH.

## 2026-08-01 — Phase 3 docs; a cross-project collision with Spec 1280

Documented `--delay` in `codev/resources/commands/agent-farm.md` (full reference) and
`CLAUDE.md`/`AGENTS.md` (pointer, byte-identical).

**The collision.** Spec 1280 landed on main mid-flight. Its measurement instrument asserts
*exact* word counts of the always-on prompt surface, and CLAUDE.md/AGENTS.md are part of
that surface — which is exactly where my deliverable lives. My first draft (+125 words)
broke two of its assertions.

**Checked the cause instead of assuming it**: backed the two files up, restored them from
HEAD, re-ran the instrument, got exactly 34231 — their asserted value. So their instrument
was unchanged and correct; its *input* had grown. Then restored my edits. Worth the two
minutes: the alternative reading ("their new test is broken") would have sent me editing
the wrong thing.

**Two responses.** Shrank the always-on addition 125 → 62 words, because Spec 1280 exists
to *measure and reduce* that surface and spending 125 words of it on a CLI flag with an
on-demand full reference is disproportionate — that judgement stands independent of the
test failure. Then updated their baselines (34231 → 34293, 8599 → 8661) with their
derivation comment preserved and my causal note appended.

**Flagged rather than decided**: an absolute pinned count breaks on *every* future edit to
*any* always-on doc, by any project. I hit it on day one of 1280 being merged, and the
natural reaction for the next person is to bump the number without checking whether the
instrument itself regressed — the exact failure the test exists to prevent. Routed to 1280
as their call. Architect approved the handling in full and confirmed the routing.

### Live run: HELD, deliberately

`#1320` (1273's submission lock) is not on main. My live run's first question — *does the
`/clear` actually EXECUTE* — is precisely what that PR fixes, so running now would test the
pre-fix world. Architect confirmed the hold: my e2e batches with 1273's probe retest in one
window after #1320 merges and installs.

Wrote the **live-run runbook** into plan phase 3 while waiting, so the window is mechanical
rather than improvised. The load-bearing step is the canary: plant a secret word before the
cycle, and check it is gone afterwards. "The send returned 200" is not evidence of a clear —
it returned 200 in 1273's failing run too.

Everything else in phase 3 is done. Phases 1 and 2 approved by both reviewers.

## 2026-08-02 — phase 2 closed; `--delay` relocated; main found red

**A drift I caused myself, worth recording.** Asked "what are you waiting for?", I checked
instead of restating — and found I was only *partly* blocked. #1327 had merged (my queued
baseline-bump drop was actionable), and porch had been sitting on phase_2 waiting for *my*
verification consults while I had wandered into phase-3 work during a run of interleaved
instructions. Phase 2 is now properly closed and porch is on phase 3.

Lesson: when several instructions arrive mid-turn, the orchestrator's own state is the
thread most likely to be dropped, because nothing prompts for it. `porch status` is cheap.

**`--delay` documentation relocated** (ruling, ratified). Zero words in
`CLAUDE.md`/`AGENTS.md`; full reference in `codev/resources/commands/agent-farm.md` **and
its skeleton mirror**. I had only edited the `codev/` copy — checked whether the skeleton
was a mirror rather than blind-copying, found it legitimately differs on main, and wrote
the equivalent content in its own shape. Spec criterion amended in place with a dated
supersession note: it was authored against the pre-1280-rewrite world, where CLI detail
still lived in `CLAUDE.md`.

One self-inflicted detour: after reverting the two files the guard still failed, because
`origin/main...HEAD` compares **committed** state and my revert was uncommitted. Reads as
"the fix didn't work" when it is "the fix isn't in the commit yet."

**Merged #1143 proactively** — it touches both copies of `agent-farm.md`, which I had just
edited. Previewed with `merge-tree` (clean), merged, verified both my `--delay` section and
their cron content survived. So the conflict 1273 hit between #1320 and #1143 does not
repeat here.

### main was red, and it was not mine

That merge turned the suite red on three parity tests. Checked `origin/main` **directly**
rather than assuming my merge caused it:

    git show origin/main:.claude/skills/afx/SKILL.md | md5 -q  -> 667efc64…
    git show origin/main:.codex/skills/afx/SKILL.md  | md5 -q  -> 32c9692c…

#1143 updated the two `.claude` copies of the afx skill and neither `.codex` copy. Main was
already broken; my branch inherited it, as would every builder merging next.

**Did not fix it.** The file is the one I had been told not to touch (`#1318`'s), and I
would have been guessing whether #1318 had a fix in flight that mine would conflict with.
Escalated with the md5 evidence and three options instead. Architect took it, fixed it
themselves (#1332), and confirmed the hold was right on both layers.

**Their root cause, recorded because it generalises:** #1143's green CI was from July 6,
predating the parity guards the repo has grown since. The gate check confirmed no drift in
the files #1143 *touched*, but not against invariants added *after* its run. New standing
rule: a stale CI green gets re-validated against current main's guards before merge.

That is the same shape as this project's recurring lesson, one level up — **an artifact
(a CI result) asserting something adjacent to the truth**. It was true when produced and
false when used.

Currently blocked on #1332 landing. #1320 also still open, its own conflict with #1143
being resolved by 1273, so the live-run window has moved but is still coming.

## 2026-07-31 — Plan CMAP iter 1: both reviewers found the SAME two defects

Both REQUEST_CHANGES, both HIGH. All ~14 findings accepted, none defended. The signal
worth noting: **codex and claude independently converged on the same two items**, and both
are outside this design's recoverability posture — the failures a manual re-send does NOT
repair.

**P1 — `SendBuffer` can invert `/clear` and `/arch-init`.** Verified: `/api/send` already
buffers when the user is typing (`tower-routes.ts:1570`, `!session.isUserIdle(3000)`, up to
60s; `isUserIdle` reads `_lastInputAt`, i.e. *input*). The `/arch-save` flow is exactly the
trip case — the owner just typed a direction, so `/clear` gets buffered:

```
T+0   /clear → BUFFERED (user typing, up to 60s)
T+15  /arch-init due → direct write → LANDS FIRST
T+40  buffer flushes → /clear → wipes the recovered context
```

My plan literally said it "schedules only the terminal write" — that bypass IS the bug.
Fix: due messages re-enter the normal delivery path, buffering included, so per-session
FIFO does the work. Not accepted risk: re-sending `/arch-init` just re-runs the race.

**P2 — `afx send <self>` was a placeholder I never resolved.** Bare `architect` resolves to
`main`/first-registered for non-builder senders (`tower-messages.ts:371-372`), so a SIBLING
architect's `/arch-save` would clear MAIN's terminal. Worst possible outcome — destroys a
session whose owner never invoked anything — and one word from correct. Fix:
`architect:<name>` explicitly, everywhere, with the reason stated.

Other findings, all real: phase 1 pointed at `agent-farm/lib/tower-client.ts`, a re-export
shim — the implementation is `packages/core/src/tower-client.ts:655` (cross-package,
core-first build); delivery must re-fetch by terminal id rather than close over a
`PtySession`; shutdown needs a registry and must DROP delayed sends, not flush them like
`SendBuffer` does; `--escape` composition was unsatisfiable (`afx send` has no such flag)
so it is recorded N/A; `--interrupt` writes Ctrl+C at request time and must be deferred
WITH the message; `adopt.test.ts` coverage was missing; the spoofing check is at
`tower-messages.ts:225-234` and only fires on the `architect:<name>` path, so the
authorisation test must use that form or it proves nothing; `tower-cron` is unsuitable
because `CronDeps.resolveTarget` takes no `sender` (better reason than the tick interval I
gave); and the delay budget is measured from send, while the clear only runs after the
turn ends — so phase 3 must calibrate send→session-ready, not send→clear-sent.

**One I would have shipped**: the four `arch-init` SKILL.md copies still document the
manual save→suggest-`/clear`→human-clears loop. Adding `/arch-save` without touching them
ships two contradictory procedures for the same task. Now a phase-2 deliverable.

### Lesson for the review file

**Making a design smaller does not make it easier to get right — it concentrates the
remaining risk.** After the descope I had ~40 lines of real behaviour change, and both
genuine defects were in the same seam: where the NEW delivery path meets the EXISTING one
(`SendBuffer`, address resolution). I wrote the small plan as though small meant safe, and
under-specified precisely the interaction surface. When scope drops sharply, the remaining
risk does not spread out — it pools at the integration points with what was already there,
and that is where the next review should be pointed.

## 2026-08-02 — At the `pr` gate. Waiting.

All plan phases complete, review file written, PR #1335 open against `main`. All six CI
checks green (unit, CLI ubuntu + macos, CLI integration, Tower integration, package
install). `porch status` reports `pr` gate pending since 05:46Z.

Nothing further for me to do autonomously: the gate is a human decision and I do not call
`porch approve`. Architect notified. Stopping until approval arrives, then I merge and
enter verify.
