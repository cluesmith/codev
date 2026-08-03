# Phase 4 — Iteration 1 Rebuttals

**Verdicts**: codex `REQUEST_CHANGES` (HIGH) · claude `APPROVE` (HIGH)

Every point raised — the one blocker and all five of claude's non-blocking observations — was
**accepted and fixed**. Nothing is rebutted as wrong. Fixes landed in `b835748e`.

---

## codex (blocking) — migration is unsafe under parallel consultations

> `metrics.ts:216-219`: The `PRAGMA table_info` check and `ALTER TABLE` are not atomic. On the first
> three-way consultation, multiple processes can observe the column as absent; one adds it while
> another then fails with "duplicate column name." Because metrics errors are swallowed, affected
> lane records are silently lost.

**Accepted in full. This was a real defect and codex was right to block on it.**

I verified *both halves* of the failure before fixing, rather than trusting the description:

1. The check-then-act window at `migrateAddModelId` — confirmed by reading the sequence.
2. The swallow at `recordMetrics` — confirmed; errors become a warning, so the row is lost with no
   failure anyone would notice.

What makes this more than theoretical is the second half. A duplicate-column throw on its own would
be loud. Combined with the swallow it is **silent**: the symptom is a missing row in
`consult stats`, discoverable months later, with no error to trace it to. And the trigger is not an
edge case — a CMAP opens three `MetricsDB` connections in parallel, so the first consultation after
upgrading is precisely when all three can race. That is the common path in this repo, not a corner.

**Fix** (`metrics.ts:232-254`), three layers:

- **Fast path**: if the column is already present, return without taking a write lock. This is every
  run after the first, so the migration costs a `PRAGMA` and nothing more.
- **`BEGIN IMMEDIATE` + re-check inside the lock**: `this.db.transaction(...).immediate()` takes the
  write lock up front, so a concurrent opener blocks on `busy_timeout` (already set to 5000ms) and
  then re-checks *inside* the lock instead of racing. This is the actual correctness fix.
- **Duplicate tolerance as belt and braces**: if the `ALTER` throws but the column exists afterward,
  someone else added it — that is success, not failure. Explicit because the alternative outcome is
  a silently dropped row.

**Test** (`metrics-model-id.test.ts`): spawns **three real child processes**. This detail is
load-bearing — `better-sqlite3` is synchronous, so nothing in-process can interleave two
connections; an in-process "concurrency" test would pass against the broken code and prove nothing.

**Mutation-verified**: reverting to the naive check-then-`ALTER` fails the new test 3 runs out of 3.
A concurrency test that has never been seen to fail is not evidence, so I made it fail on purpose.

---

## claude (non-blocking, all five accepted)

**(a) Migration race** — same finding as codex, same fix. Claude additionally noted that
`stats.ts:138` and `analytics.ts:195,405` construct `MetricsDB` *unguarded*, where the throw would
propagate rather than be swallowed. The fix is in the constructor's migration path, so it covers
those call sites too.

**(b) No test asserts the agy lane's `modelId`.** Accepted, and this was the sharpest of the five:
phase_4's dependency on phase_3 was justified *precisely* by "the gemini lane would otherwise
silently write NULL" — so the one behavior the phase ordering exists to protect was the one with no
regression guard. Now tested across all three paths: configured, skipped-but-configured, and
unconfigured (`agy-lane-model.test.ts`).

**(c) `metrics.test.ts`'s `sampleRecord()` omits the now-required `modelId`.** Accepted. My commit
message had leaned on "making the field required means the compiler enumerates every call site" —
that guarantee holds for `src/` only. `tsconfig.json` excludes `**/__tests__/**`, so the test file
was never typechecked, and `better-sqlite3` binds `undefined` as NULL, so it passed silently. Fixed;
worth recording that the guarantee has a blind spot exactly where tests live.

**(d) Plan's logging requirement landed in no phase.** Accepted. The plan's *Monitoring → Logging
Requirements* asks the resolved id be recorded in the transcript, and claude correctly observed that
phases 5 (porch) and 6 (docs) would not pick it up — it would simply have been dropped.

Implemented from the dispatch branch that **owns** the resolved choice, rather than re-deriving the
id for display. That choice is deliberate: a second, display-only resolution path is exactly how
`--model-id` came to be documented, parsed, and inert in the first place.

**(e) `recordAgyMetrics`'s defaulted `modelId` parameter.** Accepted; default removed. It reopened,
for that one helper, the silent-NULL hole that making the field required closed everywhere else.
All current callers already pass it explicitly, so this costs nothing today and closes the path a
future caller would otherwise fall into.

---

## One change beyond the reviewed diff

Added `CODEV_METRICS_DB` so a lane-level test can isolate itself instead of writing to the
developer's real `~/.codev/metrics.db` (#1323). Slightly beyond phase_4's stated scope, but the
phase's own agy-metrics deliverable (finding **b**) is untestable without it.

**Superseded during the subsequent merge with `main`.** Main had independently added the same
env var for #1323, and its version is strictly better: `resolveDbPath()` *throws* under a test
runner with no redirect instead of falling back to the real database, and an explicit constructor
argument outranks the env var rather than the reverse. I took main's implementation wholesale and
dropped mine.

---

## Note on the reconciliation claude flagged (`index.ts` codex pricing)

Claude asked for one line in the PR description about `CODEX_PRICING` becoming a per-model-id table
post-merge rather than a single default's rates. Recorded here so it is not lost: the table form is
a clean **superset** of the spec's "non-default model with no override → null" rule. Today the table
holds only `gpt-5.6-sol`, so observable behavior is identical to what the spec describes; the
difference only appears when a second id is priced. This will go in the PR description.

---

## Verification after the fixes

`tsc --noEmit` 0 errors · consult suites 254 passed / 0 failed · full unit suite green · build ✓.

---

# Iteration 2 — both reviewers converged on one blocker

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
