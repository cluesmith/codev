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
