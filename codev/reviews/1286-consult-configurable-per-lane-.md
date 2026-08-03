# Review: Spec 1286 — consult: configurable per-lane models and per-review-type lane selection

**Protocol**: ASPIR · **Phases**: 6, all approved unanimously (codex + claude) · **Commits**: 93

## Summary

Workspaces can now choose *which model* each consult lane runs (`consult.models`) and *which lanes*
run at all, per protocol and per review type (`porch.consultation.modelsByType` / `.byProtocol`),
from `.codev/config.json`. This removes the incentive that motivated the issue: the requesting
workspace had been shadow-forking `spir`/`aspir`/`pir` `protocol.json` copies to change lane
composition, recreating exactly the stale-shadow-copy rot class that PR #1281 had just cleaned up
(17 drifted files).

Absent config, behavior is unchanged — ids included.

Two things worth the reader's attention before the details: **two real concurrency bugs were found
and fixed in `metrics.ts`** (below), and **one deliberate user-visible behavior change** —
`porch done` no longer swallows malformed config.

---

## The two metrics.ts concurrency bugs

Both caused the *same* invisible symptom — a **silently missing metrics row** — because
`recordMetrics` swallows errors by design (a metrics failure must never take down a consultation).
Both are triggered by the normal path, not a corner case: a CMAP opens one `MetricsDB` connection
per lane, in parallel.

### 1. The migration was check-then-act (found by codex, phase_4 iter1)

`PRAGMA table_info` followed by `ALTER TABLE ADD COLUMN`, unserialized. On the **first** consultation
after upgrading, all three lanes can observe the column as absent; one adds it, the others fail with
`duplicate column name` — and lose their row without an error anyone would see. The window exists
exactly once per database, on the first parallel 3-way review after upgrade, which in this repo is
the common case rather than a rare one.

**Fix**: fast path when the column already exists (every run after the first, no write lock), then
`BEGIN IMMEDIATE` with a re-check *inside* the lock, plus duplicate-tolerance as belt and braces.

### 2. `journal_mode = WAL` threw SQLITE_BUSY (found by the fixed test, phase_4 iter2)

This one surfaced only because the reviewers forced the concurrency test to stop running against a
stale `dist/`. Two compounding defects, neither introduced by this spec:

- `busy_timeout` was set **after** the WAL pragma, so nothing before it was protected; and
- `busy_timeout` does not rescue a journal-mode switch **at all** — that needs an exclusive lock no
  busy-handler waits for.

So the unconditional `pragma('journal_mode = WAL')` threw straight out of the `MetricsDB`
constructor whenever several processes opened a non-WAL database at once. `stats.ts` and
`analytics.ts` construct `MetricsDB` unguarded, where that throw propagates rather than being
swallowed.

**Fix** (`enableWal()`): set `busy_timeout` first; read the mode and skip the switch when it is
already `wal`; treat `SQLITE_BUSY` as success-by-someone-else and re-read. WAL is a performance
choice, not a correctness one — `busy_timeout` is what actually makes concurrent writes safe — so a
genuine failure warns and continues rather than taking down the consultation.

---

## Behavior change (deliberate, one)

**`porch done` no longer swallows config errors.** It previously wrapped config loading in a bare
`catch` that turned any error into a silent fall-back to protocol defaults. A workspace whose
`porch.consultation` config is malformed today limps along; after this change it fails loudly:

```
Invalid consultation model "codexx" in porch.consultation.byProtocol.pir.models.
Valid models: "gemini", "codex", "claude", "hermes". Special modes: "none", "parent".
```

`porch next` already failed this way, so the previous state was worse than either alternative: a
typo made `next` refuse to run while `done` quietly demanded a *different* lane set, with neither
command printing the set it derived. This is the spec's fail-fast rule applied to an existing latent
bug, and matches house policy (fail fast, no fallbacks).

---

## What shipped, by phase

| Phase | Delivered |
|---|---|
| 1 | `CodevConfig` extensions; validators + resolvers in `lib/consult-lanes.ts`; `listProtocolNames` / `canonicalProtocolName` / `findConfigSource` in `lib/skeleton.ts` |
| 2 | claude + codex lane model wiring; `--model-id` flag |
| 3 | agy `--model` passthrough; the skip-vs-hard-failure split |
| 4 | `model_id` metrics column + guarded migration; honest codex costs (`null` rather than wrong) |
| 5 | One lane-selection resolver shared by `porch next` and `porch done` |
| 6 | Config reference, precedence ladder, fail-fast contract; skeleton parity |

**Key design decisions**

- **No allowlist of model ids anywhere** — a hard constraint from the spec. Codev validates *syntax*
  only; existence is the provider's call. A new model works the day the provider ships it.
- **The `model` metrics column still holds the lane name.** `consult stats` groups on it; the
  resolved id went into a new `model_id` column rather than repurposing an existing one.
- **`consult.models` rejects `hermes`** (no model selector → configuring one would be inert) while
  `porch.consultation` lane lists still accept it. The two key spaces differ on purpose.
- **Unknown `byProtocol` / `modelsByType` keys are errors, not warnings** — a typo that merely warned
  would silently leave the user on the defaults they were trying to override.

## Testing

642 tests across the consult, porch, and lane suites; full unit suite and build green; `tsc` clean.

Both `metrics.ts` concurrency fixes are **mutation-verified**: reverting the migration fix fails the
parallel-open test (5/6 runs), and reverting the WAL fix fails the lock-holder test (5/5,
deterministic). The multi-process test uses a readiness barrier so contention lands on the database
rather than on process startup.

## Flaky Tests

None skipped. `spec-1280-measurement-instrument.test.ts` failed early on with 5s timeouts, but this
was **not** flakiness — the fix already existed on `main` (`216b7932`, explicit 60s budgets) and the
branch was 36 commits behind. Merging `main` resolved it. Recorded because the protocol's
flaky-test escape hatch (`it.skip` + document) was the wrong tool and would have suppressed a real
signal permanently.

---

## Architecture Updates

Proposed for `codev/resources/arch.md` (COLD tier — none of these belong in the capped hot tier):

- **Lane selection has exactly one resolver.** `resolveLaneComposition` in `lib/consult-lanes.ts`,
  reached by both `porch next` and `porch done` through `commands/porch/config.ts`. Precedence,
  highest first: `byProtocol[P].modelsByType[T]` → `byProtocol[P].models` → `modelsByType[T]` →
  `models` → the protocol's `verify.models`. First level present wins; levels do not merge. If a
  future change needs the effective lane set, call that resolver — do not re-derive it. `next`
  emitting one set while `done` demands another is a deadlock the user cannot debug, because neither
  command prints what it derived.
- **Model ids are provider-authoritative; there is no allowlist.** Codev validates id *syntax* only
  (`MODEL_ID_RE`). Any feature that would introduce a static list of valid model ids contradicts a
  hard spec constraint. Reasoning effort is the deliberate opposite — a closed enum bound to the
  Codex SDK's type via `satisfies`, so SDK drift breaks the build rather than the behavior.
- **`consultation_metrics.model` stores the LANE name, `model_id` the provider id.** `consult stats`
  groups on `model`. The table is created with `CREATE TABLE IF NOT EXISTS` and has no migration
  framework, so schema changes need a `PRAGMA table_info`-guarded `ALTER` that is safe under
  parallel opens.
- **`MetricsDB`'s constructor runs under real parallelism.** A CMAP opens one connection per lane
  simultaneously. `busy_timeout` must be set before anything that can contend, and a journal-mode
  switch is not protected by it at all. Combined with `recordMetrics`'s deliberate error-swallowing,
  any throw from this constructor manifests as silently missing data rather than a failure.

## Lessons Learned Updates

Proposed for `codev/resources/lessons-learned.md` (COLD tier):

- **A test that runs against build output can pass against code it isn't running.** The concurrency
  test pointed its child processes at `dist/`. Beyond breaking CI (the unit job never builds
  `packages/codev`), a *stale* `dist/` meant the test exercised the previous build while the source
  was broken — and I had mutation-verified it against a fresh build, the one condition that hides
  the flaw. Run children against source via `tsx`.
- **Mutation-verify every test, not just the hard ones.** Three assertions in this project could not
  fail and sat inside green suites: a `.rejects.toThrow()` against a function that calls
  `process.exit`, a tautology comparing one shared function to itself, and a file-existence check
  standing in for "the row landed". A test counts only once you have seen it fail.
- **If a test needs prose explaining why it counts, it probably doesn't.** The tautology came with a
  comment arguing that agreement was "structural rather than coincidental". That rationalization was
  the tell.
- **Race-test sensitivity is not monotonic in the number of racers.** Ten racers detected a
  regression *less* often than six (2/6 vs 4/5): more concurrent starts means more startup skew, and
  a late arrival finds the work done and never contends. Synchronize on a readiness barrier so
  contention lands on the resource under test. Pair a probabilistic reproduction with a
  deterministic assertion (here: hold the write lock outright) — neither alone is sufficient.
- **A fix can weaken an existing test.** The WAL fix serialized openers at the journal switch, so
  they stopped reaching the migration together and migration-race detection dropped to 2/5. Seeding
  the fixture in the state production is actually in (WAL) restored it. Re-measure detection after
  changing the code a race test targets.
- **In docs, verify what you write, not just what you quote.** Every constant read from source was
  right; every line written from memory was wrong — an invented config-layer list, an unrunnable
  shell example, `//` comments in a strict-JSON example, and invented pricing rates ~4× off. **A
  wrong example is worse than a missing one**: the reader has no reason to doubt it and concludes
  the tool is broken. Fix the class, not the instance — extracting all six JSON blocks and running
  `json.loads` also caught a pre-existing broken example no reviewer had reported.
- **Verify reviewer claims against the file before acting.** A reviewer correctly described
  better-sqlite3's missing-named-parameter error but drew a wrong conclusion about this code:
  `record()` re-materializes every parameter, so an omitted field binds NULL and no row is lost. The
  contradiction only surfaced because the "fix" was mutation-tested and still passed.
- **When a test fails in a file your branch never touched, compare file *contents* with `main`
  before assuming flakiness.** `git log HEAD..origin/main -- <file>` showed nothing; the two
  checkouts had different test counts, which exposed that the fix already existed upstream.
