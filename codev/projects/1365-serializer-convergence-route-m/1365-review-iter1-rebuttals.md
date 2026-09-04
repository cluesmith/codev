# Review iteration 1 — dispositions

| Lane | Verdict | Action |
|---|---|---|
| gemini | APPROVE, no key issues | none required |
| codex | APPROVE, no key issues | none required |
| claude | **REQUEST_CHANGES** | all six points addressed below |

A second, independent CMAP was run by the architect against PR #1492. Its **codex** lane
returned REQUEST_CHANGES and converged on the *same* first finding as this lane's claude —
which is why an APPROVE here was not treated as settling the matter. Every finding was
verified against the code before being accepted or refused; none was dismissed because some
other lane approved.

---

## 1. Operator-vs-operator ceiling regression (blocking) — ACCEPTED, fixed

**Finding.** `bounded` keyed only off "is anything in flight" and never asked what *kind* of
writer was ahead, so `afx send --interrupt <48 KB --file>` followed by a second `--interrupt`
let the second bypass the first after 2 s. Operator-vs-operator was **always** fully serialized
before #1365 — `submitToSession` had no ceiling at all; that pair is Spec 1273's `/clear`
fusion bug. My ceiling therefore made one pair strictly *worse* than the status quo, and
falsified the review doc's "never worse" claim.

**Verified.** Real. Reproduced by reading the `bounded` expression at HEAD: nothing in it
distinguished a delivery holder from an operator holder.

**Fix** (`ece06a5e`). Chain entries carry a `SubmissionKind`; a `pendingOperators` per-session
count tracks operators **queued as well as in flight**; `bounded` gains `&& !behindOperator`.
Self-counted *after* the check (so a submission does not read its own presence as a reason to
block) and *before* any await (so a later operator sees it while merely queued). Queued has to
count: bypassing an operator that has not started is the same violation as bypassing one
mid-write.

**Pinned by** `operator vs operator NEVER degrades — the wait stays unbounded, as before #1365`
and `a THIRD operator does not bypass a QUEUED one`. The pre-existing ceiling test needed its
holder changed from an operator to a delivery — that fixture change **is** the behaviour
change, not a workaround.

## 2. A ceiling-degraded `--interrupt` reported `delivered: true` (blocking) — ACCEPTED, fixed

**Finding.** The row is claimed `delivered` before the write, so a degraded operator write
returned unqualified success with only a Tower-side WARN — the same false-success class this
issue exists to remove, relocated from the delivery path to the operator path.

**Verified.** Real, and squarely against this PR's own thesis: a success signal must not lie.

**Fix** (`ece06a5e`). Claim-first is **kept** — un-claiming reopens the double-delivery hole
reasoned through at implement-phase CMAP round 3 — and the truth is surfaced instead:
`/api/send` returns `degraded: true` + `degradedReason: 'submit-wait-ceiling-expired'`,
threaded through `packages/sdk/src/tower-client.ts` and warned about by `afx send`. An
indicator nobody surfaces is half a fix.

**Pinned by** `a body-bearing interrupt that crosses the wait ceiling reports degraded`
(`tower-routes.test.ts`), whose holder is a delivery — the only thing the ceiling may bypass.

## 3. Review doc stale relative to the worktree — ACCEPTED, fixed

Files Changed, the commit list and the test figure are refreshed (**4885 passed / 0 failed /
48 skipped**, 246 files), and the "never worse than the old status quo" wording in *Things to
Look At* item 2 is rewritten to state the guarantee **per pair**. A full `never worse` /
`status quo` / `never waited` grep across `packages/codev/src/agent-farm/` and
`codev/resources/` confirmed no residual claim-site still overstates it.

## 4. Two files outside the stated 21-file scope — ACCEPTED, disclosed

`packages/codev/src/agent-farm/commands/send.ts` and `packages/sdk/src/tower-client.ts`. They
are the minimum needed to make a degraded write visible to the *sender* rather than only to
the Tower log, which requires crossing the server→client boundary. Now called out explicitly
in the review doc's Files Changed section so the human meets no surprise at the diff. The
architectural boundary itself is respected: `codev-sdk` still imports only `codev-types`.

## 5. Nits

| Nit | Disposition |
|---|---|
| Stale `{@link writeMessagePaced}` in `message-write.ts` | **Fixed** — repointed at `submitMessagePaced` |
| `unserializedWrites` entries never pruned | **Fixed** — see below |
| `DEGRADED_SUBMIT_REASON` orphaning `logCeilingExpired`'s JSDoc | **Fixed** — moved above it |
| Ceiling timer not cancelled when the predecessor wins | **Not taken — flagged** |
| `waited < 100` / `tickMs < 250` timing-sensitive | **Not taken — flagged** |

**The counter-eviction fix, and why it is not a two-line delete.** `unserializedWrites` cannot
self-delete on drain the way `chains` and `pendingOperators` do: it must **outlive** the
submission whose watcher is about to compare against it, and a reset landing between a
watcher's two reads would read as "nobody raced me" — the exact false `delivered` this issue
exists to eliminate. So eviction is interlocked with an explicit `watchBypasses(sessionId)`
window (held by `submitMessagePaced` across its write, released in a `finally`): refused while
any watch is open, and attempted from **both** the chain's drain cleanup and the last watch's
release, so whichever runs second evicts and no ordering leaks. This needs no session-teardown
hook, and therefore no `terminal/` → `agent-farm/` layer crossing. Pinned by `the
degraded-write counter is evicted once the session goes idle` and `eviction cannot land inside
a watcher window and mask a race`.

**Also fixed, from the architect's relay of the same lane:** the bypass counter was bumped on
ceiling expiry *regardless of whether bytes went out*. The delayed `^C` re-checks liveness
inside the lock and can write nothing; that no-op forced a concurrent delivery into a spurious
`preempted` re-delivery. `SubmitOptions.wroteBytes` is now consulted straight after the write
callback — no `await` in between, so the ordering guarantee the old placement provided is
unchanged. Pinned by `a degraded write that writes NOTHING is not counted as a bypass`.

**Why the two refusals.** Cancelling the ceiling timer means adding abort semantics to the
injected `SubmitClock` interface that every test double implements — a broader change than the
cost of one short-lived timer per *contended* operator submission, late in a review round; a
reviewer who disagrees should say so, it is small, just not free. The timing assertions are
deliberate: they are what make "the drainer does not stall" and "the escape hatch stays
responsive" testable claims rather than prose, and both carry ≥2.5× headroom over the
behaviour they exclude.

## 6. Process note: hot-tier `arch-critical.md` — DISCLOSED, human's call

The plan said the hot-tier change would be *proposed*; I appended the clause directly. The
reviewer's own read is that it is defensible (it extends the existing mailbox-first fact rather
than adding an eleventh, so the 10-fact cap holds with no displacement) but that ratifying it
is the human's call. Agreed on both counts — it is disclosed in the review doc, and reverting
it is a one-line edit.

---

**Result:** both blocking findings accepted and fixed, three of five nits taken, two refused
with reasons, one process note escalated to the human. `pnpm --filter @cluesmith/codev build`
and `pnpm --filter @cluesmith/codev-sdk build` clean; full suite **4885 passed / 0 failed /
48 skipped**.
