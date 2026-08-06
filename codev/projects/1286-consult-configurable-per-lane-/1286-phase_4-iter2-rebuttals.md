# Phase 4 — Iteration 2 Rebuttals

codex `REQUEST_CHANGES` · claude `REQUEST_CHANGES`. Both named the **same** defect independently,
which is the strongest signal a CMAP produces. Accepted; nothing rebutted on the blocker.

## Blocking — the concurrency test depended on a prior build

The test spawned its children against `dist/commands/consult/metrics.js`. Verified against
`.github/workflows/test.yml`: the unit job runs `pnpm copy-skeleton` then vitest and **never builds
`packages/codev`**, so on a clean checkout there is no `dist/` and every child exits 1 with
ERR_MODULE_NOT_FOUND. This would have gone red on the PR. Claude also found the repo precedent —
`vitest.config.ts:28` excludes the one other dist-dependent test for exactly this reason.

Claude's second point is the one that actually matters, and it is worse than the CI break: when
`dist/` **does** exist but is stale, the children exercise the previous build while the source is
broken, and the test goes green. A regression test that can pass against code it is not running is
worse than no test, because it is trusted.

Fixed by running the children through `tsx` (already a devDependency) against `metrics.ts` directly.

## What the fix uncovered: a second, real concurrency bug

With the children finally running current source, the test failed — but on a **different** error:
`SqliteError: database is locked` (SQLITE_BUSY) from `pragma('journal_mode = WAL')` in the
constructor. Two genuine defects, neither introduced by this phase:

1. `busy_timeout` was set **after** the WAL pragma, so nothing below it was protected.
2. More fundamentally, `busy_timeout` does not rescue a journal-mode switch at all — that needs an
   exclusive lock no busy-handler waits for. The unconditional `journal_mode = WAL` therefore threw
   straight out of the constructor whenever several processes opened a non-WAL database at once,
   which is precisely what a CMAP does. And because `recordMetrics` swallows constructor failures,
   the symptom was a **silently missing metrics row** — the same invisible failure mode codex
   blocked on at iteration 1, reached by a different route.

Fixed in `enableWal()`: set `busy_timeout` first; read the mode and skip the switch when it is
already `wal` (every open after the first); treat SQLITE_BUSY as success-by-someone-else and
re-read. WAL is a performance choice, not a correctness one, so a genuine failure warns rather than
taking down the consultation.

## Making the race test honest

Mutation testing showed the test was a weaker instrument than its green tick implied. Recorded
because the numbers are the argument:

| variant | regression caught |
|---|---|
| spawn-and-hope | 2 / 5 |
| shared wall-clock deadline | 4 / 5 |
| ten racers instead of six | 2 / 6 — **worse** |
| readiness barrier + WAL-seeded fixture | 5 / 6 |

Two counter-intuitive results. **More racers made detection worse**: more concurrent `tsx` starts
means more startup skew, and a child that arrives late finds the work already done and never
contends. And **my own WAL fix weakened the migration test** — serializing openers at the journal
switch stopped them reaching the migration together. Seeding the fixture already in WAL (as a real
`~/.codev/metrics.db` is) sends every opener down the fast path so contention lands on the
migration, which is what that test exists to stress.

The multi-process test is still probabilistic, so the WAL fix also gets a **deterministic** guard
that removes timing entirely: hold the write lock outright and assert the constructor survives it.
That fails 5 runs out of 5 against the old code.

## Disputed: claude's non-blocking finding about `test-isolation.test.ts`

> `src/__tests__/test-isolation.test.ts:135` omits the now-required `modelId`; better-sqlite3 throws
> `RangeError: Missing named parameter` on an *omitted* property, so `record()` swallows it and the
> row is silently dropped while the test still passes.

**The premise about better-sqlite3 is correct; the conclusion about this code is not.** I made the
change claude asked for, then mutation-tested it — removing `modelId` again left the test passing,
which contradicted the stated mechanism, so I checked the source rather than the summary.

`record()` does not forward the caller's object. It builds a fresh parameter object naming every
column, including `modelId: entry.modelId`. The property is therefore always **present**; an omitted
field arrives as `undefined`, and an explicitly-undefined named parameter binds NULL. Verified
directly:

```
omitted   -> THROWS: RangeError Missing named parameter "b"
undefined -> OK
```

So no row was being dropped. The real defect is milder and purely type-level: `tsconfig.json`
excludes `**/__tests__/**`, so a `MetricsRecord` literal missing a required field is never
typechecked. Same blind spot as accepted finding (c) — correctly identified, wrong consequence.

Fixed anyway (the field belongs there), and the test now asserts the row **landed** rather than only
that a file appeared — since `record()` swallows write errors by design, file-existence alone stays
green even if every insert is dropped. The in-code comment states the verified mechanism, not the
reported one.

## Verification

`tsc --noEmit` 0 · full build ✓ · full unit suite green · the phase's own file 6 runs / 6 green ·
both regressions mutation-verified (migration race 5/6, WAL ordering 5/5 deterministic).
