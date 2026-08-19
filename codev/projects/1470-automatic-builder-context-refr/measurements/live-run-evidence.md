# Spec 1470 — live-run evidence (raw, as captured)

Architect-driven, 2026-08-19. Option B (CLI by hand, no Tower restart). Subject:
disposable `builder-task-x47-`. Feature build:
`node .builders/spir-1470/packages/codev/bin/afx.js`, cwd = subject worktree.

Preserved verbatim as the primary record; the review artifact summarises it.

## Preflight — PASS

`--begin` from the subject worktree: challenge issued naming the **subject's** path, exit 0.
Cross-worktree shape confirmed (spir-1470 build, task-x47- identity).
Control: same binary from `/tmp` refused — "must be run from inside a builder worktree", exit 1.

## Bonus: stale-challenge fail-safe, live (unplanned)

Challenge aged 18320s against a 3600s limit → **ABORTED** (`no-challenge`), steps: *(none)*,
"No clear was attempted. Your context is intact." Exit 1. Recovery per its own message worked.

## RUN 1 — spec test 37: PASS

Subject had real context (two large documents read, `tmp/testing-split-summary.md` written).
Save: genuine, **4506 bytes**, nonce `ff67f159bb6d` on line 1.
Execute 06:21:49–51Z, exit 0. Step log EXACTLY:

```
challenge-read → worktree-checked → receipt-accepted → assemble → reorient-written →
reentry-scheduled → challenge-marked → clear-attempted → clear → challenge-consumed
```

`tower.log`:

```
06:21:51.875  Message scheduled (+15s): builder-task-x47- → builder-task-x47- (mailbox 8854dbed)
06:21:51.984  [mailbox] delivered a0918e20  (the /clear self-send, onto empty prompt)
06:22:07.860  [mailbox] delivered 8854dbed  (THE RE-ENTRY — 15.9s AFTER the clear, NOT consumed)
```

Resumption **PROVEN**. Post-clear probe answered in writing: the subject identified itself, its
task and its completion state, sourced

> "from `.builder-state.md` … then confirmed against the worktree (`git status`, `git log -1`, and
> the deliverable on disk) — not from memory of doing the work, which is gone."

(Verbatim; `tmp/probe-answer.txt` in the subject worktree.)

## RUN 2 — spec test 38: PASS (variant 2c, the echo bypass)

`cp <begin-output> .builder-state.md` → 2557 bytes, over the floor, nonce present but **not on
line 1**.

Execute → **ABORTED** (`receipt-rejected`), reason names the echo case verbatim, steps stopped at
`challenge-read → worktree-checked`, "No clear was attempted", exit 1.
No re-entry scheduled — `tower.log` shows Run 1's `8854dbed` as the only scheduled message.
Subject continued working normally afterwards (wrote the probe file post-Run-2).

## Measurements

- **Real boundary save: 4506 bytes** — 4.5× the 1000-byte floor, zero padding. Third real data point.
- **Clear→re-entry: 15.9s wall.** Scheduled +15s; the drainer delivered ~0.9s after due.
  `DEFAULT_REENTRY_DELAY_SECONDS = 15` validated by measurement; drainer granularity documented.

## Operational quirk (separate issue, deliberately not fixed here)

The subject's `afx` replies to the architect never arrived — `STATE WRITTEN`, `STATE UPDATED` and
the first probe answer were all lost — while its **file** actions all executed. Task-lane reply
addressing is worth a look.

## Housekeeping

Challenge file removed post-runs. Subject worktree preserved pending the owner's disposal word.

---

# Third live pass — test 37's two remaining clauses (2026-08-19)

Subject: `builder-aspir-1527`, a **real ASPIR porch project** (sandbox issue #1527). Feature porch
and afx driven by path; both rehearsal traps pre-defused (codex+claude configured, checks skipped).

## Clause "at a real boundary" — CLOSED

15:06:40Z, subject's progress log:

> `porch next -> CONTEXT REFRESH task at boundary plan-phase:phase_2_index`

Emitted by the feature porch on a real plan-phase advance, after genuine phase-1 work that was
consulted and approved (codex + claude APPROVE). Pre-approval skips fired **nothing** (SUPPRESS
verified live, 2nd time). `plan_phases` extracted on the ungated path (#1503 fix live, 2nd time).

## Bonus fail-safe #4, live: the dirty-worktree gate

First execute **REFUSED** (`dirty-worktree`, step `challenge-read`). The sole dirty tracked file was
the architect's harness edit enabling the boundary in `protocol.json`. No clear attempted, context
intact. The subject **refused both escape hatches without authorization and escalated**; the
architect authorized `--allow-dirty` with the rationale recorded.

Recorded decision: out of the box, enabling the feature via an uncommitted `protocol.json` edit
trips the guard. In real adoption that edit ships committed, so this is friction on the *enabling*
path rather than the using path — judged intended.

## Clause "resumes from porch next" — CLOSED

Second execute: full step chain, no aborts —
`challenge-read → … → reentry-scheduled → clear-attempted → clear → challenge-consumed`.
Save: **5751 bytes**.

`tower.log`:

```
15:12:01.490  clear self-delivery
15:12:17.339  RE-ENTRY delivered — 15.8s after, NOT consumed
```

15:12:42Z progress log, written by the **fresh context**:

> "RE-ENTRY after refresh: read `.builder-state.md` + `.builder-reorient.md`, ran `porch next`.
> Porch detected claude consultation missing (died with the clear) and asked to re-run it."

Resumption from `porch next` at a real boundary, including porch-driven recovery of in-flight
consultation state the refresh disturbed.

## Sharp edge — save staleness (subject-reported)

The save is written at `--begin`; the boundary can execute much later; nothing revalidates CONTENT
freshness (nonce/stability/age only). Here the refusal-retry gap made the original save stale
("phase_2 not started" → by execute time phase_2 was DONE) and the subject rewrote it manually
before clearing. A cold reader following the stale save would have re-implemented phase 2.
Challenge max-age bounds this to 1h, but within-window drift is real.

→ Review artifact: *A hole in the central guarantee: save staleness*. Instruction shipped;
mechanism deliberately deferred to a follow-up.

## Measurements (cumulative)

- Real saves: **2952B, 4506B, 5751B** — floor comfortably cleared every time, no padding. Keep 1000.
- Clear→re-entry: **15.9s, 15.8s** — `DEFAULT_REENTRY_DELAY_SECONDS = 15` validated twice,
  independently, on different subjects.
