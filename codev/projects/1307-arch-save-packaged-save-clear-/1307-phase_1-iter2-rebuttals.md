# Phase 1 (`afx send --delay`) — Rebuttals, iteration 2

Both reviewers `REQUEST_CHANGES` again. **All findings accepted**, with one framing I
narrowed rather than adopted wholesale — explained below, because the narrowing is the
substantive part.

Fix commit: `bf4040b5`. core 48 tests, codev 4065 tests, both builds clean.

---

## 1. Codex: independent timers let same-terminal deliveries interleave

**Accepted — a real bug I had not considered, and the most valuable finding of the round.**

Each scheduled message owned its own `setTimeout`. Two due for the same terminal at the
same instant both begin delivering concurrently, and delivery is *not atomic*:
`writeMessageToSession` paces multi-line output across several timeouts. So two concurrent
deliveries to one PTY interleave **lines** — producing two mangled messages rather than
two messages.

**Fixed**: a per-terminal promise chain in `delayed-send.ts`. Each due delivery waits for
the previous one to that terminal. Chains are dropped once drained, so the map tracks
active chains only, and a throwing delivery cannot strand later messages (tested).

### The framing I narrowed

Codex described this as violating "the explicit per-session FIFO requirement," implying
delayed messages should be delivered in *request* order. **I did not adopt that**, and the
disagreement is worth stating precisely rather than quietly implementing the smaller fix.

Two sends with different delays are meant to arrive at different times. `--delay 30`
followed by `--delay 5` should deliver the 5-second one first — that is what the caller
asked for, and enforcing request-order would make `--delay` not mean what it says.

The guarantee this feature actually makes is narrower: **a delayed message never overtakes
one already QUEUED for that session.** That is the `/arch-save` hazard (a delayed
`/arch-init` jumping ahead of a buffered `/clear`), and it is what `hasPending` closes.
Serialising concurrent deliveries is a *separate* correctness property — no interleaving —
and Codex was right that it was missing.

Both are now implemented, tested, and documented as distinct. A test pins the
deliver-by-due-time behaviour explicitly, so a future reader does not "fix" it into
request-order.

My earlier commit messages claimed "per-session order is preserved" broadly, which was
sloppier than the code. Corrected.

## 2. Both: no coverage of the CLI → client → wire chain

**Accepted, and blocking was the right severity.**

`deliverAfter` travels CLI → `SendOptions` → `TowerClient` → HTTP body → Tower. Every hop
except the client was covered, and that one **cannot** be covered from `packages/codev` —
the agent-farm `tower-client.ts` is a re-export shim resolving to core's built `dist`, so a
codev-side test exercises compiled output rather than this source.

The consequence Claude spelled out: deleting `deliverAfter` from the request body left all
4059 tests green while `--delay` silently degraded to an immediate send. For a feature
whose whole failure mode is "arrives at the wrong time," that is the coverage that matters
most, and the plan had listed it as a deliverable ("Core-side test coverage for the
`sendMessage` parameter") which I did not do.

**Fixed**: `packages/core/src/__tests__/tower-client-send.test.ts` — 7 tests covering the
field on the wire, its absence when unset, `scheduled`/`deferred` surfaced, and
back-compat when an older Tower omits them. Plus `--delay` cases in `send.test.ts` for the
CLI→client hop, including `--all`.

**Mutation-verified**: removing `deliverAfter` from the request body now fails two core
tests. Same check I ran on the ordering guards last round — a coverage test that has never
been observed failing is a guess about its own value.

## 3. Both: `--all` classified buffered messages as "sent"

**Accepted.** `sendToAll` ignored `result.deferred`, so a message Tower had merely buffered
was reported as sent. I had fixed exactly this for `scheduled` in the previous round and
left `deferred` — the same half-a-deliverable pattern review caught last time.

**Fixed**: `sent` / `scheduled` / `deferred` / `failed` tracked and reported distinctly.

## 4. Codex: the `--all` reporting tests asserted against a replica

**Accepted, and it is the same class of mistake as last round's ordering tests.** I tested a
local `summarise()` helper rather than the shipped `send()`, so a regression in the real
reporting path would not have failed anything. I introduced that replica in the *fix* for a
finding about replicas.

**Fixed**: replaced with real `send()` tests through the existing mocked-`TowerClient`
harness, asserting the actual log output.

## 5. Claude: stale `queueAhead` across the 100ms interrupt `await`

**Accepted** (flagged non-blocking; fixed anyway — it is two lines). `queueAhead` was
computed, then `await`ed across for 100ms, then used. A concurrent enqueue in that window
would be overtaken. Now re-checked after the await: a decision taken before an await is a
decision about a world that may have moved on.

## 6. Claude: comment claimed identity it did not have

**Accepted.** The local predicate in `spec-1307-send-delay.test.ts` omits the shipped
`!interrupt` term while the comment claimed the rule was "stated identically in both
places." Rewritten to say plainly that it is a *simplification for readability*, that it is
**not** the regression guard, and to point at the route-level tests that are.

## 7. Claude: `delay` vs `deliverAfter` naming drift

**Accepted as a documentation gap rather than renamed.** The two names are deliberate:
`delay` matches the user-facing `--delay` flag ("how long the caller asked to wait");
`deliverAfter` is the wire/client name ("when to deliver"). Documented as intentional in
`types.ts` so the next reader does not have to guess.

## 8. Claude: undelayed-but-buffered CLI message changed wording

**Noted, keeping the change.** "Message sent" → "Message queued for X (target is being
typed in)" is a user-visible change on the undelayed path, which brushes against the
spec's "undelayed sends unchanged." But the spec's constraint is about *delivery
behaviour*, and reporting a buffered message as sent is the misreport this phase exists to
stop. Flagging rather than hiding it.

## 9. Claude: `deliverAfter: null` treated as absent

**Accepted as correct as-is** — consistent with `undefined`, and the reviewer agreed.

---

## Note on the review environment (carried from round 1)

Codex again could not execute tests. Its findings were again all correct, and this round it
found the interleaving bug from source inspection alone — a defect no existing test would
have surfaced. Worth recording as a counterweight to my round-1 note: a reviewer that
cannot run tests reads the code more carefully, and that has now paid off twice.

## Summary

| # | Finding | Source | Disposition |
|---|---|---|---|
| 1 | Independent timers interleave same-terminal deliveries | Codex | **Fixed** (per-terminal chain); FIFO framing narrowed |
| 2 | No CLI→client→wire coverage | Both | **Fixed** (7 core tests + send tests), mutation-verified |
| 3 | `--all` reported buffered as sent | Both | **Fixed** (4 distinct buckets) |
| 4 | `--all` tests asserted against a replica | Codex | **Fixed** (real `send()` coverage) |
| 5 | Stale `queueAhead` across await | Claude | **Fixed** |
| 6 | Comment claimed false identity | Claude | **Fixed** |
| 7 | `delay` vs `deliverAfter` naming | Claude | Documented as deliberate |
| 8 | Buffered-send wording change | Claude | Kept, flagged |
| 9 | `deliverAfter: null` | Claude | No change (correct) |

**What I take from this round.** Findings 3 and 4 are both *repeats of last round's lesson
inside last round's fix*: I fixed `scheduled` and left `deferred`; I removed one predicate
replica and introduced another. Fixing a finding is not the same as internalising it, and
the tell is that both regressions live in code I wrote *while addressing the original*. The
check that would have caught both is the one I already know to run — "would this fail if
the thing it protects broke?" — applied to the fix, not just the original.
