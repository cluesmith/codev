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

- `packages/codev/src/agent-farm/servers/session-submit.ts` (+288 / −33) — `trySubmitToSession`,
  `isSubmissionInFlight`, `OPERATOR_SUBMIT_WAIT_CEILING_MS` + `SubmitOptions`,
  `unserializedWriteCount`, and the rewritten boundary comment
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts` (+144 / −20) — `DeliverySession.id`,
  `WriteAbort` / `WriteResult`, the in-lock precheck, the outcome mapping
- `packages/codev/src/agent-farm/servers/message-write.ts` (+110 / −24) — `submitMessagePaced`
  (replaces `writeMessagePaced`), `PacedSubmitResult`
- `packages/codev/src/agent-farm/servers/tower-routes.ts` (+105 / −38) — wait ceiling at the three
  operator call sites, `logCeilingExpired`, updated scope comments
- `packages/codev/src/agent-farm/servers/mailbox-wiring.ts` (+8 / −2) — binds the new write edge

Tests:

- `packages/codev/src/agent-farm/__tests__/spec-1365-serializer-convergence.test.ts` (+516 / −0) — new
- `packages/codev/src/agent-farm/__tests__/spec-1313-paced-write-drop.test.ts` (+63 / −18) — re-pointed
- `tower-routes.test.ts` (+8 / −2), `send-delivery.test.ts` (+19 / −8),
  `send-mailbox-repro.test.ts` (+7 / −2), `cron-delivery.test.ts` (+8 / −3),
  `send-architect-identity.test.ts` (+6 / −2) — fakes updated

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

## Test Results

- `pnpm --filter @cluesmith/codev build`: ✓ pass
- `pnpm --filter @cluesmith/codev test`: ✓ pass — **4879 passed / 0 failed / 48 skipped**,
  246 files. 23 new tests in `spec-1365-serializer-convergence.test.ts`.
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
   1 MiB — a 48 KB `--file` of short lines is ~8 minutes. Past the ceiling the operator write
   proceeds unserialized, which is exactly the pre-#1365 behaviour, so it is never worse than
   the old status quo — only no longer silent.
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
