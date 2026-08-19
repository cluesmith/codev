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
