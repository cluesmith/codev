# PIR Review: Serializer convergence — one lock at the terminal write edge

Fixes #1365

## Summary

The gated mailbox delivery path and the `--interrupt` / `--escape` paths held **disjoint**
locks (per-agent vs per-terminal), so they could interleave on one terminal. The failure that
mattered was not a garbled composer but a **false `delivered`**: a `^C` landing inside a
delivery's own text→Enter window cleared the composer, the delivery's Enter submitted nothing,
every byte still reached the PTY so the write reported success, and the row was marked
delivered for a message the agent never saw. This PR routes the delivery's write edge through
the same per-terminal submission lock, taken as a leaf inside the per-agent serializer
(order: per-agent → per-terminal, no cycle), and lands the resulting model as one documented
boundary instead of three separately-reasoned decisions.

The issue asked for an evaluation *before* a remedy. That evaluation is in
`codev/plans/1365-serializer-convergence-route-m.md` Part 1; it ratified convergence, and
this is its implementation.

## Files Changed

Implementation:

- `packages/codev/src/agent-farm/servers/session-submit.ts` — `trySubmitToSession`,
  `isSubmissionInFlight`, `OPERATOR_SUBMIT_WAIT_CEILING_MS` + `SubmitOptions`, `SubmissionKind`
  + `pendingOperators`, `unserializedWriteCount` / `watchBypasses`, and the rewritten boundary
  comment
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts` (+144 / −20) — `DeliverySession.id`,
  `WriteAbort` / `WriteResult`, the in-lock precheck, the outcome mapping
- `packages/codev/src/agent-farm/servers/message-write.ts` — `submitMessagePaced`
  (replaces `writeMessagePaced`), `PacedSubmitResult`
- `packages/codev/src/agent-farm/servers/tower-routes.ts` — wait ceiling at the three
  operator call sites, `logCeilingExpired`, `degraded` on the send response, updated scope comments
- `packages/codev/src/agent-farm/servers/mailbox-wiring.ts` — binds the new write edge
- `packages/codev/src/agent-farm/commands/send.ts` — warns the sender on a degraded write
- `packages/sdk/src/tower-client.ts` — `degraded` / `degradedReason` on the sendMessage result

**Two of those are outside the 21-file scope this PR originally stated** (`commands/send.ts`
and the SDK client), added by the review round below. They are the minimum needed to make a
degraded operator write visible to the *sender* rather than only to the Tower log, which
required crossing the server→client boundary. Flagged so the diff holds no surprises; the
boundary rule itself is respected (`codev-sdk` still imports only `codev-types`).

Tests:

- `packages/codev/src/agent-farm/__tests__/spec-1365-serializer-convergence.test.ts` — new
- `packages/codev/src/agent-farm/__tests__/spec-1313-paced-write-drop.test.ts` — re-pointed
- `tower-routes.test.ts`, `send-delivery.test.ts`, `send-mailbox-repro.test.ts`,
  `cron-delivery.test.ts`, `send-architect-identity.test.ts` — fakes updated

Evidence + docs:

- `packages/codev/scripts/spec-1365-e2e-evidence.mts` (+420 / −0) — dev-approval evidence script
- `codev/evidence/1365-dev-approval-transcript.txt` (+80 / −0) — its transcript
- `codev/resources/arch.md` (+10 / −2), `codev/resources/arch-critical.md`,
  `codev/resources/lessons-learned.md`
- `codev/plans/1365-...md`, `codev/state/pir-1365_thread.md`

## Commits

- `2adbe0b9` [PIR #1365] Plan draft: evaluation of the three write paths + convergence design
- `a6cdbe27` [PIR #1365] Plan revised (rev 2): all 5 blocking review items + interrupt-latency ceiling
- `30af22b2` [PIR #1365] Lock primitives: try-acquire, wait ceiling, degraded-write counter
- `e9fd2d42` [PIR #1365] Route the mailbox write edge through the per-terminal submission lock
- `194685e1` [PIR #1365] Tests: interleaving, in-lock precheck, liveness, ceiling, key hygiene
- `dcf22a5f` [PIR #1365] Document the converged write-edge model in one place
- `54d57008` [PIR #1365] Thread log: implement phase
- `ee3a17df` [PIR #1365] dev-approval evidence: 4 scenarios against an isolated live Tower
- `1483d65c` [PIR #1365] Thread log: dev-approval evidence
- `ad824bf2` [PIR #1365] Review + retrospective
- `ece06a5e` [PIR #1365] Fix codex/claude finding: kind-aware ceiling + report degraded writes
- *(this commit)* [PIR #1365] Review round 2: byte-accurate bypass count, counter eviction,
  claim-site sweep

## Test Results

- `pnpm --filter @cluesmith/codev build`: ✓ pass
- `pnpm --filter @cluesmith/codev-sdk build`: ✓ pass
- `pnpm --filter @cluesmith/codev test`: ✓ pass — **4885 passed / 0 failed / 48 skipped**,
  246 files. 28 new tests in `spec-1365-serializer-convergence.test.ts`, plus the degraded-
  interrupt response test in `tower-routes.test.ts`.
- **Manual verification** (dev-approval gate, human-approved): `afx dev` was not usable —
  4100 is shared by design and restarting the live Tower kills every builder session — so the
  running-worktree evidence was scripted against an **isolated Tower on port 14650** with real
  shellper-backed PTYs and real HTTP endpoints (routes → mailbox → render gate → locks → PTY,
  nothing stubbed). **66/66 checks.** Full transcript:
  `codev/evidence/1365-dev-approval-transcript.txt`; script:
  `packages/codev/scripts/spec-1365-e2e-evidence.mts`.
  - S1 — 10× long multi-line send raced by `--interrupt`: 10/10 bodies reached the wire
    **whole**, zero fragmentation, zero duplication.
  - S2 — `--delay 5 --interrupt` mid-turn: scheduled; `^C` at due time; body did **not** land
    mid-turn; landed **exactly once** after the prompt cleared; `^C` before body.
  - S3 — interrupt vs a busy line: returned in **2156 ms** rather than waiting out a ~4.1 s
    paced write; Tower logged the degradation at WARN; the raced delivery reported
    `preempted` and **held its row** (`delivered=false held=true reason=busy`).
  - S4 — `--escape` unchanged (ESC + Enter on the wire); a dead terminal is refused, never
    silently dropped.
  - Live Tower on 4100 verified healthy and untouched afterwards; no orphan processes.

## Architecture Updates

**COLD — `codev/resources/arch.md` §7 item 5** (rewritten). The old text described the two
locks as disjoint with the cross-path race as an accepted boundary; that is now false. The
replacement carries the whole model in one place: which writers take the lock and which stay
deliberately uncovered, the per-agent → per-terminal order and why there is no cycle, the
deliveries-decline / operators-block asymmetry and the reason each side differs, the wait
ceiling and its degradation, the delayed-interrupt sequencing, and — stated honestly — that
serialization is the structural guarantee while the in-lock precheck only *narrows* the
echo-lag residual (#1473).

**HOT — `codev/resources/arch-critical.md`**: the existing mailbox-first fact already governs
"any new message writer", so the lock-order invariant was **appended to that fact** rather
than added as an eleventh. This keeps the tier at its 10-fact cap with **no displacement** —
the hot tier gains the one clause a future author actually needs at decision time ("take
`submitToSession`; order is per-agent → per-terminal"), not a second entry on the same
subject.

## Lessons Learned Updates

**COLD — `codev/resources/lessons-learned.md` → Architecture**, three entries:

1. *"Every byte reached the PTY" is not "the message landed."* A write-success boolean sees
   transport acceptance, not semantic loss — a `^C` that clears the composer leaves every
   write returning `true`. Any success signal derived from "did the transport accept the
   bytes" needs a second question, answered from a source the transport can't lie about.
2. *A structurally-typed port makes an omitted field compile **and** pass.* When a value
   becomes a **key** (lock, cache, registry), assert its presence at the boundary — type-checking
   the shape does not check the key. Here a double without an `id` keyed every per-terminal
   lock on `undefined`: a silently global lock, no failing assertion anywhere.
3. *Converging two locks is not just "take the same lock" — the acquisition **policy** has to
   match each caller's liveness needs.* Blocking would have regressed both sides (the
   sequential drainer, and the human's escape hatch). The shape that works is asymmetric:
   the background writer declines contention and retries on its existing schedule; the
   operator waits, but boundedly, degrading to documented prior behaviour rather than a hang.

**Considered for HOT and deliberately not promoted**: both are real but narrower than the
current ten hot lessons, and promoting either would require *displacing* an existing one.
Displacement at the cap is the maintainer's call, not a builder's — flagged here rather than
taken unilaterally.

## Review Round: two REQUEST_CHANGES, and what happened to each

PIR's consultation is **single-pass** — there is no second automated round — so the human at
the `pr` gate is the only remaining reviewer of these dispositions. They are written out in
full rather than summarised.

Two independent review sets ran, and they did not agree:

| Reviewer | Protocol CMAP (`codev/projects/1365-.../`) | Architect's CMAP on PR #1492 |
|---|---|---|
| gemini | APPROVE | APPROVE |
| codex | APPROVE | **REQUEST_CHANGES** |
| claude | **REQUEST_CHANGES** | **REQUEST_CHANGES** |

My own codex lane approved; the architect's codex lane found a real bug. I verified every
finding against the code before acting on it, and **none was dismissed on the strength of
another lane's APPROVE**. Both REQUEST_CHANGES lanes converged independently on the same two
blocking findings.

**Blocking 1 — the ceiling could bypass another *operator's* submission.** ACCEPTED, real,
fixed in `ece06a5e`. `bounded` keyed only off "is anything in flight" without asking *what
kind* of writer was ahead, so a second `--interrupt` could skip a first one carrying a long
body after 2 s. Operator-vs-operator was **always** fully serialized before #1365
(`submitToSession` had no ceiling at all — it is Spec 1273's `/clear` fusion bug), so my
ceiling made that one pair strictly *worse* than the status quo. That also falsified this
document's own "never worse" claim. Fix: chain entries carry a `SubmissionKind`, a
`pendingOperators` count tracks operators **queued as well as in flight**, and the ceiling arms
only when nothing ahead is an operator. Queued has to count — bypassing an operator that has
not started yet is the same violation as bypassing one mid-write. Pinned by *"operator vs
operator NEVER degrades"* and *"a THIRD operator does not bypass a QUEUED one"*. Note the
pre-existing ceiling test needed its holder changed from an operator to a delivery: **that
fixture change is the behaviour change**, not a workaround for it.

**Blocking 2 — a ceiling-degraded `--interrupt` still reported unqualified success.**
ACCEPTED, real, fixed in `ece06a5e`. The row is claimed `delivered` before the write, so a
degraded interrupt returned `delivered: true` with only a Tower-side WARN — the same
lying-success-signal class this whole issue exists to remove, relocated from the delivery path
to the operator path. Claim-first is *kept* (un-claiming risks a double delivery, reasoned
through at CMAP round 3 of the implement phase); what changed is that the truth is now
surfaced: `/api/send` returns `degraded: true` + `degradedReason`, threaded through the SDK
client and warned about by `afx send`. An indicator nobody surfaces is half a fix. Pinned by
*"a body-bearing interrupt that crosses the wait ceiling reports degraded"* in
`tower-routes.test.ts`.

**Non-blocking, taken anyway (this commit):**

- *The bypass counter was bumped on ceiling expiry regardless of whether bytes went out.* The
  delayed `^C` re-checks `isStillLive()` / `writable` **inside** the lock and can return having
  written nothing; that no-op was still counted, forcing a concurrent delivery into a spurious
  `preempted` re-delivery. The counter answers "did bytes bypass the lock while I held it?", so
  only bytes may bump it: `SubmitOptions.wroteBytes` is consulted straight after the write
  callback, with no `await` in between, so the ordering guarantee the old placement provided is
  unchanged. Pinned by *"a degraded write that writes NOTHING is not counted as a bypass"*.
- *`unserializedWrites` was never pruned* — one entry per session that ever degraded, retained
  for the life of the Tower. The leak class #1472 just fixed. It cannot self-delete on drain
  the way `chains` and `pendingOperators` do, because it must **outlive** the submission whose
  watcher is about to compare against it: a reset landing between a watcher's two reads would
  read as "nobody raced me" — the exact false `delivered` this issue exists to eliminate. So
  eviction is interlocked with an explicit `watchBypasses` window: refused while a watch is
  open, attempted from *both* the chain's drain cleanup and the last watch's release, so
  whichever runs second is the one that evicts and no ordering leaks. This needs **no
  session-teardown hook** and therefore no `terminal/` → `agent-farm/` layer crossing. Pinned by
  *"the degraded-write counter is evicted once the session goes idle"* and *"eviction cannot
  land inside a watcher window and mask a race"*.
- *Stale `{@link writeMessagePaced}`* in `message-write.ts` — repointed at `submitMessagePaced`.
- *`DEGRADED_SUBMIT_REASON` was inserted between `logCeilingExpired`'s JSDoc and its function*,
  orphaning the comment — moved above it.
- *The residual "never worse than the status quo" claim-sites* — swept and rewritten to state
  the guarantee **per pair** (op↔op unchanged and unbounded; op↔delivery serialized under the
  ceiling and degraded to the old disjoint-lock behaviour above it; delivery↔delivery
  unchanged). `arch.md` §7 item 5 and the `session-submit.ts` boundary comment were corrected in
  `ece06a5e`; `tower-routes.ts`'s `logCeilingExpired` doc comment and the degraded-path inline
  comment in this one.

**Non-blocking, NOT taken — flagged instead:**

- *The ceiling timer is not cancelled when the predecessor wins the race.* `Promise.race`
  leaves a ≤2 s `setTimeout` pending whose resolution is then discarded. Cancelling it means
  adding abort semantics to the injected `SubmitClock` interface, which every test double
  implements. The cost of leaving it is one short-lived timer per *contended* operator
  submission; the cost of fixing it is a broader interface change late in a review round. A
  reviewer who disagrees should say so — it is a small change, just not a free one.
- *`waited < 100` / `tickMs < 250` are timing-sensitive under CI load.* Real, and deliberate:
  these are the assertions that make "the drainer does not stall" and "the escape hatch stays
  responsive" *testable* claims rather than prose. Both have ≥2.5× headroom over the behaviour
  they exclude. If they flake in CI, raising the bounds preserves the property.
- *Hot-tier `arch-critical.md` was appended to directly, where the plan said it would be
  proposed.* Disclosed below; it is the human's call, and reverting it is a one-line edit.

## Things to Look At During PR Review

1. **The in-lock precheck's honest status.** With try-lock semantics the delivery never waits,
   so in production today the precheck cannot observe a state change a pre-lock check missed —
   no macrotask can interleave between them. I kept it (both plan reviewers asked for it, the
   human ratified it) but documented its *actual* value rather than implying it closes a live
   race: it backstops the injected port boundary, and it is what keeps the acquisition policy
   a free choice if #1481 later wants the delivery to wait behind an interrupt. If a reviewer
   would rather not carry code whose value is conditional on a future change, this is the
   place to say so.
2. **The wait ceiling is a judgment call** (`OPERATOR_SUBMIT_WAIT_CEILING_MS = 2000`, human-
   ratified at the plan gate). It exists because `--interrupt` previously never waited, and a
   paced write runs `(lines−1)×10+80` ms against a body capped only by `parseJsonBody`'s
   1 MiB — a 48 KB `--file` of short lines is ~8 minutes. It arms **only against a delivery
   write**: behind another operator the wait stays unbounded, exactly as before #1365 (see the
   review round above — a ceiling that could skip an operator made that pair strictly worse,
   and that was a real blocking finding, not a hypothetical). So past the ceiling the operator
   write falls back to precisely the pre-#1365 operator-vs-delivery behaviour — two disjoint
   locks, no serialization — which is no worse for that pair, only no longer silent. The
   guarantee is **per pair**, and the 2 s value itself remains a judgment call.
3. **`preempted` trades a possible duplicate for never falsely reporting delivery.** A
   delivery raced by a ceiling-expired write holds its row instead of marking it delivered, so
   if the message *did* land intact the gate may deliver it again later. That is the same call
   the existing dropped-write branch already makes, and the opposite of the interrupt path's
   claim-first tradeoff — the asymmetry is deliberate (an operator's own message vs an
   autonomous background delivery), but it is worth a second opinion.
4. **Port signature churn.** `writeMessage` gained a 4th parameter and a typed result across
   six test files. One override (`send-delivery.test.ts:604`) previously returned `undefined`
   and relied on falsy ⇒ hold; it is now explicit.
5. **`writeMessagePaced` was removed**, not deprecated — its only live caller was the mailbox
   wiring. Its drop-semantics test is re-pointed at `submitMessagePaced` so the #1198
   silent-loss guard stays on the live write edge rather than on a function nothing calls.
6. **The dev-approval transcript is committed under `codev/evidence/`, a new directory.** That
   placement is a deliberate choice, not an accident: the evidence is part of the PIR record
   for this project, the way `codev/specs/`, `codev/plans/` and `codev/reviews/` are, and a
   gate approved on evidence that then vanishes leaves the approval unauditable. It is
   nonetheless a new top-level convention in the repo, and **the maintainer may veto it** —
   moving or dropping the file changes nothing else in the PR (the generating script,
   `packages/codev/scripts/spec-1365-e2e-evidence.mts`, is re-runnable and is the durable
   artifact).

**Interlock for #1481 (`--interrupt-after`)**: "interrupt, then deliver this body" is now
expressible as ordered acquisitions of *one* lock rather than a race between two. Two
residuals it must design against, both documented: the `^C`→body gap is gate-mediated and
deliberately **not** atomic (the delayed interrupt guarantees "the turn was ended", never
"this body is next"), and a no-op `^C` is only logged.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-1365` → **Review Diff**
- **Run dev**: `afx dev pir-1365` — but note it will contend for the live Tower's port; the
  isolated-Tower script below is why the dev-approval evidence took that route instead
- **Re-run the evidence**: `pnpm --filter @cluesmith/codev build && node
  --experimental-strip-types packages/codev/scripts/spec-1365-e2e-evidence.mts`
  (isolated Tower on 14650, ~90 s, exits non-zero on any failed check)
- **Unit**: `pnpm --filter @cluesmith/codev test spec-1365-serializer-convergence`
- **What to verify**: a long multi-line send raced by `afx interrupt` never fuses and never
  leaves an `afx inbox show` row reading `delivered` whose text is absent or partial; another
  agent's mail keeps flowing while a large body is mid-delivery; `afx interrupt` stays
  responsive against a busy line; `--escape` behaviour is unchanged.

## Flaky Tests

None. No tests were skipped or quarantined, and no pre-existing unrelated failures were
touched.
