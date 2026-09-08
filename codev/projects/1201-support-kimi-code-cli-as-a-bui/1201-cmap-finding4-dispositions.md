# CMAP dispositions — finding 4, kimi sticky-fresh crash-resume (2026-08-09)

Round: the architect's finding 4 on PR #1203 — after a clean exit, a crash in the pre-mint boot
window makes `kimi -c` resume the conversation the human just ended (#1267's own motivating
defect class). Earlier rounds: `1201-cmap-postpivot-dispositions.md`,
`1201-cmap-architect-review-dispositions.md`.

Verdicts on the delta: **gemini APPROVE · codex REQUEST_CHANGES · claude REQUEST_CHANGES**.
Both REQUEST_CHANGES were right, and they converged on the same blocking defect. Every finding
was accepted; none rejected.

Scope fences respected: no PR comment, and the three parked maintainer decisions (trust
pre-write, 0.33.0 floor, write-guard parity) untouched.

---

## Measurement first — the premise holds

The fix (and the pre-existing resume design) assumes `kimi -c` continues the NEWEST session when
a cwd holds several. The existing continue-probe only covered the ZERO-session case, so this was
measured net-new on real kimi 0.34.0
(`codev/spikes/pir-1201-kimi-continue-newest-probe.mjs`), with two independent oracles because
the model's own answer is not proof:

- **content oracle** — sessions seeded with distinct codewords ALPHA (older) / BRAVO (newer);
  `kimi -c` answered **BRAVO**.
- **identity oracle** — snapshot `updatedAt` for every session before and after; the `-c` turn
  touched **only** `session_f06c…` (the newest), and **created no new session**. Exit 0, no
  prompt.

So identity comparison is well-defined, and the fallback ("document the residual instead") did
not apply.

---

## The fix

The inlined store probe now PRINTS the newest resumable session id instead of exiting 0/1; the
clean-exit branch records that id as superseded; the crash branch takes `-c` only once the
newest id differs. One probe, one mirror — the boolean uses derive from the same output.

---

## codex #2 / claude F1 — BLOCKING: the guard read stdout and discarded exit status — **ACCEPTED**

The delta moved the decision from `$?` onto stdout, so anything else writing to stdout is read
as "a session exists". claude **measured** it: with an empty store and
`NODE_OPTIONS=--require <module that prints>`, the probe printed a banner and exited 1, and the
script read RESUME. That lands on `kimi -c` with nothing to continue — which does not fail, it
starts a session that never saw `--agent-file`: a silently **roleless** builder, the #929 class
the entire guard exists to prevent. **A failure mode the delta introduced** — the pre-delta code
could not produce it. Vectors: `NODE_OPTIONS`, a `node` shim on PATH, corporate instrumentation
preloads.

Fixed by consuming both signals, with the declaration split from the assignment so `local` does
not mask the substitution's status:

```bash
local codev_newest
codev_newest=$(codev_newest_session) || return 1
[ -n "$codev_newest" ] && [ "$codev_newest" != "$codev_superseded_id" ]
```

Pinned by a new test that reproduces the exact vector.

## codex #1 / claude F2 — a transient probe failure at clean exit re-opens the gap — **ACCEPTED**

The architect's sketch said "empty on any error — fail-closed", and my comment repeated it. Both
reviewers showed it is not: if the probe fails transiently (EMFILE, ENOMEM, fork failure, a
throwing preload) the branch records `''`, and the next crash sees the just-ended session as
"different from empty" → resumes it. The very bug the finding is about.

claude's suggested mitigation (keep the previous value) only helps on *iterated* exits; the
first clean exit still records nothing. So the branch now distinguishes **failure** from **empty
store** by status and sets `codev_resume_blocked`, which refuses resume until the next clean
exit re-establishes a baseline. Accepted cost, documented in-code: a later crash restarts fresh
instead of continuing, losing conversation continuity — never the role (fresh always carries it)
and never the task (the mailbox still holds it). It self-heals at the next clean exit.

## claude F3a / codex #4 — `j.cwd ?? j.workDir` is not the mirror — **ACCEPTED**

Discovery's `readStateJson` tests `typeof === 'string'` **per field**; the probe's `??`
short-circuits on any non-null `cwd`, so `{cwd: 12345, workDir: <match>}` was found by discovery
and missed by the probe. Fail-closed in direction, but it disproves the field-for-field claim
the docstring makes — and identity, not just existence, now rides on that claim. Probe changed
to per-field `typeof`; docstring corrected to stop naming `cwd ?? workDir` as the mirror; a
fixture added.

## claude F3b — trailing-slash normalization diverged, in the UNSAFE direction — **ACCEPTED**

The probe's `n()` stripped a trailing slash *before* `realpathSync`; `sameDir` does not. For a
path that does not exist, `/ghost/` canonicalized to `/ghost` in the probe and stayed `/ghost/`
in discovery — so the probe could name a session discovery rejects. claude called it unreachable
(the probe's argument is `$PWD`, which exists) and said record it. Removed instead: the strip
bought nothing, because `realpathSync` already normalizes a trailing slash away for any
directory that exists — which is exactly what the existing trailing-slash fixture covers, and it
still passes. Exact mirror beats documented exception. Fixture added for the ghost case.

## claude F4 — the composition was never executed, only the pieces — **ACCEPTED**

`decideBranch` injects `codev_superseded_id` from the test, so the only evidence the generated
clean-exit branch assigns it was a string match. A refactor wrapping that assignment in a
subshell — an ordinary bash footgun — would pass every test while the contract was dead. Added a
test that drives the **real `while` loop** with stubbed launches and a fed `read -r`, asserting
the branch sequence is `resume, fresh, fresh` (entry resumes; clean exit goes fresh and retires
the id; the pre-mint crash stays fresh).

## claude F5 — "unreadable store" tested an ABSENT store — **ACCEPTED**

The test never wrote a session, so `rmSync` removed nothing and it duplicated the
store-does-not-exist case. Rewritten: write a session that WOULD authorize `-c`, then replace
`sessions/` with a regular file for a deterministic ENOTDIR (root-proof, unlike `chmod 000`).

## claude nits — **ACCEPTED**

Restored the stronger `not.toContain('codev_launch_resume')`; the `afterClean` slice now bounds
on the branch's own two-space-indented `fi` (the earlier `\n\s*fi\n` stopped at the new nested
conditional — the same class of bug as the `"fine"` match it replaced).

## codex edge notes — traced, documented, not engineered against

- **Store GC drops the newest session** while an older abandoned one survives → `-c` reaches the
  older one. Requires a retention policy that evicts newest-first. Recorded in-code.
- **`afx spawn --resume` / terminal re-create** resets the in-memory superseded id. Documented
  as the intended boundary — and claude noted this is **contract parity**, not a kimi shortfall:
  claude's minted id is equally per-process.
- **Two builders in one cwd** — not a real topology (one worktree per builder).

---

## Verification

- `pnpm build` clean; `tsc --noEmit` clean; generated script passes `bash -n`.
- Full suite **4915 passed / 48 skipped / 0 failed** (+9 on the round's starting 4906).
- Targeted suites (harness, harness-integration, spawn-worktree, kimi-session-discovery,
  mailbox-pacing, render-gate) green.
- Non-vacuity is demonstrated rather than asserted: `decideBranchLegacy()` runs the pre-fix
  existence-only predicate against the same store and the same generated probe, and the
  regression test asserts it returns RESUME where the shipped guard returns FRESH.
