# pir-1365 — Serializer convergence (issue #1365)

## Plan phase (2026-08-17)

Read the three write paths end to end before proposing anything, per the architect's
instruction that the issue's "Evaluate first" section governs.

**What I found that changes the framing.** The issue (and the accepted-boundary comment in
`session-submit.ts`) reason about the *fusion* case: a gated delivery landing inside an
interrupt's `^C`→settle→text window. There is a second ordering nobody wrote down: the `^C`
landing inside the **delivery's own** text→Enter window (50–130 ms+). The `^C` clears the
composer, the delivery's Enter fires into nothing, `writeMessagePaced` returns `true`
(the PTY accepted every byte — it only detects #1198 socket drops, not semantic loss), and
`markDelivered` transitions the row. That is silent message loss with a false `delivered`
audit record — the one outcome Spec 1313's architecture exists to exclude.

That, plus the fact that the delayed-interrupt path fires **unattended** (so the "an
operator is standing at this terminal" premise that makes the boundary acceptable does not
hold for it, and #1481 makes that co-occurrence routine), is why the evaluation lands on
**converge** rather than wontfix.

**Design constraint I want the reviewer to weigh.** Taking the per-terminal lock *alone*
would make things worse, not better: a delivery that classified clean and then waits ~150 ms
behind an interrupt would write onto a screen the interrupt just changed. So the gate
verdict must be re-validated **inside** the lock (the same `writable` + `ringToken` pair the
code already checks pre-write, re-run at the write instant). The in-lock precheck is the
fix, not a refinement of it. Correspondingly the lock stays a leaf around the *write* only —
widening it to cover the async classify would queue `--interrupt`, the human's escape hatch,
behind a gate classification.

Verified for deadlock-freedom: lock order is always per-agent → per-terminal (paths A/C
never enter the per-agent serializer), and `PtySession.write()` emits no `'submit'` signal
(only `handleUserInput` does; `'quiescence'` comes off an output timer), so nothing can
re-enter the other lock from inside a lock callback.

Answers to the other two failure questions: the delayed-interrupt reshape leaves **no**
window for the body to land mid-turn (the body can only leave the mailbox through the gate);
escalation/held bookkeeping stays internally consistent but silently diverges from reality
in the Ordering-2 case, with no detector.

Plan written to `codev/plans/1365-serializer-convergence-route-m.md`, committed, awaiting
`plan-approval`. Flagged for #1481: the `^C`→body gap is gate-mediated, not atomic, and a
no-op `^C` is only logged — both are things `--interrupt-after` must design against.

**Standing constraint**: we are not cluesmith/codev maintainers. Never merge the PR; park it
after review and report protocol-complete.

## Plan revision 2 (2026-08-17) — after the architect's 3-way review

Verdicts gemini APPROVE / codex + claude REQUEST_CHANGES, with both REQUEST_CHANGES reviews
ratifying Part 1. Every blocking item was in Part 2's design, and every one of the five was
right. Verified each against the code before revising rather than taking the summaries as
ground truth:

- **Item 5 confirmed on sight**: `tower-routes.test.ts:221` `gateSession()` is an
  un-annotated literal with no `id`, and it reaches the *real* `mailbox-wiring` binding. That
  would have keyed every lock on `undefined` — per-terminal serialization silently collapsing
  into one global lock, with no failing assertion anywhere. Runtime guard in
  `submitMessagePaced`, plus a different-terminals test.
- **Item 2 adopted as proposed** (asymmetric try-lock). The drainer awaits agents
  sequentially, so a blocking acquisition would let one agent's terminal stall every other
  agent's delivery *plus* that tick's escalation and prune. Deliveries now fail fast to
  `busy` — which costs nothing, since a contended terminal means the precheck would have
  aborted anyway — and the result is a *stronger* liveness property than today.
- **Item 1**: my revision-1 precheck re-validated writability + ringToken but not the row's
  own status, which would have *widened* the dismiss→bytes-on-wire window from ~zero to the
  whole lock wait. `getById` goes in the precheck; `WriteAbort` gains a `row-resolved` case
  so "no hold, terminal state" stays expressible.
- **Item 3** was a fair hit. I wrote "the in-lock precheck is not a refinement — it is the
  fix," which overclaims: `ringToken` tracks *output*, so un-echoed input from a writer that
  doesn't take the lock still defeats it. Restated: serialization is the structural
  guarantee, the precheck narrows the echo-lag residual, and that residual is #1473's.
- **Item 4**: escape is the *more* likely trigger for multi-line bodies, not a milder cousin —
  the delivery's exposed window is longest exactly when the body is long, and the failure
  mode is a truncated message marked `delivered` (worse than absent: it can be acted on).

**New finding of my own (D3), flagged for the gate.** Nobody raised interrupt latency. Today
`--interrupt` never waits; after convergence it waits for any in-flight delivery write, and
body size is capped only by `parseJsonBody`'s 1 MiB default
(`agent-farm/utils/server-utils.ts:47`). A 48 KB `--file` of short lines is ~48k lines ≈ 8
minutes of paced write. An unbounded block on the escape hatch would be a worse regression
than the bug. Proposed a bounded wait (2000 ms) that degrades to exactly today's unserialized
behaviour with a loud WARN — never worse than the status quo at any point, and no longer
silent. The ceiling value is a judgment call; flagged rather than assumed.

Also noted: the suggested `arch-critical.md` hot-tier fact for the lock-order invariant needs
a *displacement* (the tier is at its 10-fact cap), so it is proposed in the review phase for
the maintainer rather than applied unilaterally.

## Implement phase (2026-08-17)

Human approved the gate including the D3 ceiling at 2000 ms. Four commits: lock primitives →
convergence → tests → docs. Full suite green (4879 passed, 0 failed), build clean.

**Took the architect's optional degraded-path flag.** It earns its complexity for a specific
reason: my own D3 ceiling is what opens that hole. Without it I'd have traded one route to a
false `delivered` (the ^C mid-write) for a rarer one (an operator that gave up waiting and
wrote into a delivery already on the wire) — which is not a fix, it's a relocation.
Implemented as a per-session monotone counter of unserialized writes, sampled around the
delivery's own submission; a bump yields `preempted` → hold for redelivery. No screen
re-classification: the question is only "did anyone bypass the lock while I held it?", and a
counter answers exactly that. It does trade a possible **duplicate** for never falsely
reporting delivery — the same call the existing dropped-write branch already makes, and
documented as such.

**The review's item-5 hazard was real and it bit immediately.** Adding the runtime id guard
turned 13 `tower-routes.test.ts` tests red — `gateSession` had no `id`, reached the live
wiring, and would have keyed every lock on `undefined`. Silent global lock, no failing
assertion, exactly as claude predicted. Worth recording as the general lesson: a
structurally-typed port makes an omitted field compile *and* pass, so a new lock key needs a
runtime guard, not just a type.

**Honest note on the in-lock precheck.** With try-lock semantics the delivery never waits, so
the precheck cannot fire from a lock wait in production today — no macrotask can interleave
between the pre-lock checks and the in-lock ones. I kept it (the review asked for it, the
human ratified it) but documented its *actual* value rather than implying it closes a live
race: it backstops the injected port boundary, and it is what keeps the acquisition policy a
free choice if #1481 later wants the delivery to wait behind an interrupt. The tests exercise
it at its own level rather than pretending a production path reaches it.

Also re-pointed `spec-1313-paced-write-drop` from the retired `writeMessagePaced` onto
`submitMessagePaced`, so the silent-loss guard stays on the live write edge instead of on a
function nothing calls.

## dev-approval evidence (2026-08-18)

`afx dev` was off the table (4100 is shared; restarting the live Tower kills every builder),
so I built the evidence the way `send-integration.e2e.test.ts` does: this worktree's Tower on
port 14650, real shellper-backed PTYs, real HTTP endpoints, nothing stubbed. Script +
transcript committed (`packages/codev/scripts/spec-1365-e2e-evidence.mts`,
`codev/evidence/1365-dev-approval-transcript.txt`). 66/66. Live Tower on 4100 verified
untouched afterwards; no orphan processes.

**The oracle is the interesting part.** The echo terminal (`stty raw -echo; exec cat`) re-emits
every byte written to it in order, so `GET /api/terminals/:id/output` is a faithful ordered
record of what each writer actually put on the terminal. That turns "did these two writers
interleave?" into a string question instead of an inference.

**Two wrong turns worth recording, both mine, both fixed rather than papered over:**

1. First run: every send held `no-profile`, so nothing ever delivered and the whole scenario
   asserted nothing. Cause: a shellper-backed session reports `command: ''`. Fix was to write
   a real `.builder-start.sh` so the profile resolves through the *wrapped-launch fallback* —
   which is how a genuine builder's profile resolves, so this is fidelity, not a workaround.
2. A run reported `held` at request time and then had bytes on the wire 400 ms later, which my
   assertion called a lie. It wasn't: the fast trigger/backstop had legitimately delivered the
   row after the response. My assertion was wrong. Rather than loosen it I made it *sharper* —
   count whole bodies vs. count first-lines, so any fragment without a whole body behind it
   fails. That is a better interleaving detector than "is the body present", because
   fragmentation is precisely what interleaving looks like on the wire.

**Scenario 3 is the strongest single piece of evidence** and it exercises the degraded path I
added: the interrupt returned in 2156 ms instead of waiting out a ~4.1 s paced write; Tower
logged the degradation at WARN; and the raced delivery reported `preempted` and *held its row*
— `delivered=false held=true reason=busy`. The ceiling and its compensating flag both firing
end to end, on the real wire.

**Two limits stated rather than approximated:** the 503 `TERMINAL_NOT_WRITABLE` branch needs a
shellper socket that died while the session still reports `running`, which can't be produced
from the public API without staging it (covered by `tower-routes.test.ts:1560`, untouched by
this change); and this fixture's agent is only ever a live terminal, never a registry-known
builder, so a send after its death correctly 404s instead of exercising the
hold-instead-of-404 seam.

---

## Review phase — two CMAP rounds, and the one that mattered was not mine

**2026-08-18.** The protocol's own consultation lane came back gemini APPROVE / codex APPROVE /
claude REQUEST_CHANGES. The architect independently ran a *second* CMAP against PR #1492 and got
gemini APPROVE / **codex REQUEST_CHANGES** / claude REQUEST_CHANGES. Same model, opposite
verdicts, on the same branch.

The lesson I want a future builder to take from this: **my codex lane approved and it was
wrong.** Two of the three lanes on the other CMAP converged, independently, on a real bug I had
introduced — and the temptation, when one lane says APPROVE, is to treat the outlier as noise. I
verified every finding against the code myself before acting on it. Both blocking ones were
real. An APPROVE is not evidence that a finding is false; it is evidence that one reviewer did
not find it.

**The bug was my own D3 ceiling, and it was the classic shape: a fix that relocates its defect.**
`OPERATOR_SUBMIT_WAIT_CEILING_MS` existed so `--interrupt` could not be stalled for minutes
behind a long delivery. But `bounded` only asked "is anything in flight", never "*what kind* of
writer is ahead" — so a second `--interrupt` could bypass a first one carrying a 48 KB body.
Operator-vs-operator had been *fully* serialized since Spec 1273 (it is the `/clear` fusion bug),
so my ceiling made exactly one pair strictly worse than the status quo, in a PR whose review doc
claimed "never worse". Fixed in `ece06a5e` by tagging chain entries with a `SubmissionKind` and
counting operators that are **queued** as well as in-flight — bypassing an operator that has not
started yet is the same violation as bypassing one mid-write. The guarantee is now stated **per
pair**, which is the only way it is true.

The second blocking finding was the same class one layer out: a degraded interrupt still
returned `delivered: true`. In a PR whose entire thesis is *a success signal must not lie*. That
one stung. Fixed by surfacing `degraded` through `/api/send` → SDK → `afx send` rather than by
un-claiming the row (un-claiming reopens double-delivery, which round 3 of the implement-phase
CMAP had already settled).

**Round 2 (this commit)** took the two non-blocking correctness notes and swept the doc claims.
The counter-eviction one was the only part with real design content: `unserializedWrites` cannot
self-delete on drain the way `chains` does, because it has to *outlive* the submission whose
watcher is about to compare against it — a reset landing between a watcher's two reads reads as
"nobody raced me", which is the precise false `delivered` this whole issue exists to kill. So
eviction is interlocked with an explicit `watchBypasses` window and attempted from both ends
(drain cleanup and last release), whichever runs second winning. That also avoids needing a
session-teardown hook, which would have meant `terminal/` importing `agent-farm/` — a layer
crossing not worth a memory nit.

I refused two nits and said why in the rebuttal rather than quietly skipping them: cancelling the
ceiling timer needs abort semantics on the injected `SubmitClock` that every test double
implements, and the timing assertions are load-bearing (they are what makes "the escape hatch
stays responsive" a testable claim instead of prose).

Dispositions in `codev/projects/1365-serializer-convergence-route-m/1365-review-iter1-rebuttals.md`;
the human-facing version, including the two files that fell outside the stated PR scope and the
`codev/evidence/` placement the maintainer may veto, is in the review doc.

Build clean (codev + sdk); full suite **4885 passed / 0 failed / 48 skipped**, 246 files.

---

## Post-gate: merging main back in

**2026-08-18.** The human approved the `pr` gate and porch reported the protocol complete
(`phase: verified`). Porch's final task says "merge the PR" — not taken; PR #1492 and issue
#1365 are parked for the maintainer, per standing order.

Then GitHub flagged the PR `mergeable=CONFLICTING`: `main` had moved 25 commits during the
review round. I reported it rather than fixing it unasked, because merging would have changed
the tree the architect had just verified with a 129/129 re-run — and got the go-ahead.

**The conflict was a nothing, and that is worth recording precisely because it looked
alarming.** Exactly one file: `codev/resources/lessons-learned.md`, § Architecture. Both sides
had *appended* — three #1365 lessons here, one secfix-1 lesson on main, at the same insertion
point. Not a competing edit; git simply cannot know that two appends at one anchor are
independent. Keep-both, all four entries intact.

Every code file auto-merged. What the merge *did* change in this PR's files came entirely from
main: AIR #1489's `afx reset` → `afx refresh` rename landed in two of my comments
(`session-submit.ts`, `mailbox-wiring.ts`), and secfix-1's auth hardening rewrote parts of
`tower-routes.ts`, `tower-client.ts` (`codev-web-key` → `codev-tower-key`) and
`tower-routes.test.ts`. I verified this rather than assuming it: blob-hashed the nine files
before the merge and diffed each afterwards, then grepped every #1365 marker
(`wroteBytes`, `watchBypasses`, `pendingOperators`, `SubmissionKind`, `logCeilingExpired`,
`DEGRADED_SUBMIT_REASON`, the degraded-interrupt test) to confirm each survived. Four files
were byte-identical: `message-write.ts`, `mailbox-delivery.ts`, `commands/send.ts`,
`spec-1365-serializer-convergence.test.ts`.

`pnpm install --frozen-lockfile` was necessary before rebuilding — main moved `pnpm-lock.yaml`,
and secfix-1's own lesson in that very file is about a dep that only fails in a *packaged*
install. Build clean (codev + sdk). Full suite **4934 passed / 0 failed / 48 skipped, 248
files** — up from 4885/246, the delta being main's own new tests, not behaviour change here.

Merge commit `ebbc495dc`. Merge, not rebase: rebasing would have rewritten 83 pushed commits
and destroyed the history the human just approved.
