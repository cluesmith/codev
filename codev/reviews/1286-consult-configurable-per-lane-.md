# Review: Spec 1286 — consult: configurable per-lane models and per-review-type lane selection

**Protocol**: ASPIR · **Phases**: 6 · **PR**: #1341

**Review status, stated precisely** (the first version of this line overclaimed, and codex caught it
at PR review — see Lessons):

- **Phases 1–5**: ended with a unanimous codex + claude `APPROVE`.
- **Phase 6 (docs)**: **force-advanced at the iteration cap**, not unanimously approved. Iteration 3
  ended codex `REQUEST_CHANGES` / claude `APPROVE`; the fixes for those findings were made and
  committed but never re-reviewed, because `max_iterations: 3` was reached. The unreviewed fixes are
  the iter3 ones: JSON examples made parseable, real pricing rates, and PIR example consistency —
  all verified by me (all six JSON blocks run through `json.loads`, skeleton `diff` empty), none
  verified by a reviewer. A `force_advanced` record is in `status.yaml`.
- **Confirming pass (architect-required)**: because force-advance is not approval and a builder's
  self-verification does not close out a standing `REQUEST_CHANGES`, a scoped codex pass was run
  over exactly the un-re-reviewed surface — phase 6's iter3 docs fixes (`2cb1e2f7`) plus the three
  PR-gate CMAP fixes (`251c867f`, including the reverse exhaustiveness assertion).

  **Verdict: codex `APPROVE` (HIGH)** — *"Both commits correctly resolve the outstanding findings
  without introducing defects."* KEY_ISSUES: None. Codex confirmed independently that the strict-JSON
  examples parse, the two doc trees are byte-identical, documented values match the implementation,
  the SDK exhaustiveness guard is bidirectional, and the replacement tests are non-circular.

  Verdict reproduced verbatim, with scope and invocation notes, in
  `codev/projects/1286-consult-configurable-per-lane-/1286-confirming-codex-scoped.md`. It was run
  with an explicit `--output` outside the porch project directory so it could not auto-persist and
  be miscounted as a phase review. (Raw consult `.txt` outputs are gitignored repo-wide —
  `.gitignore:59` — so no phase review on this project is committed as a raw file either; the `.md`
  keeps the evidence in-repo without departing from that convention.)

**Net**: every change on this branch has now been reviewer-approved, either in its phase or by the
confirming pass. The spec itself was also force-advanced (codex requested changes on all three
passes, with an architect-required 4th pass before planning) — that history is on file in the
`*-rebuttals.md` artifacts.

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

## Known limitations and follow-up candidates

Raised by claude at PR review as non-blocking. Each is in-scope-adjacent but *not* in this spec's
scope, so they are recorded rather than fixed — changing them here would mean overriding an explicit
spec requirement without an architect decision.

1. **`byProtocol` protocol-name validation is workspace-scoped, but config can be global.** Names
   are checked against the protocols visible in the *current* workspace. A `byProtocol.<name>` entry
   set in `~/.codev/config.json` for a protocol that exists in only one workspace will hard-fail
   `loadConfig` in every other workspace on that machine. This follows directly from the spec's
   requirement that unknown keys be errors and never warnings — the alternative (scoping strictness
   by config layer) is a design change, and the fail-fast rule is deliberate. Worth an architect
   decision if anyone hits it in practice; the workaround today is to set `byProtocol` per project
   rather than globally.
2. **`model_id` is write-only.** The column is populated by every lane but is not surfaced by
   `consult stats` or `analytics.ts`. Spec scenario 13 required only that it be recorded and that
   `model` keep grouping reports by lane, so exposing it is a natural follow-up rather than an
   omission — the data is there from the day this merges.
3. **Cosmetic**: `loadConfig` is called ~3× per codex consultation and `listReviewTypes` is
   recomputed inside the `byProtocol` validation loop. Both are cheap and off the hot path;
   noted so a future reader knows it was seen, not missed.

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
- **`satisfies` binds a local list to an SDK union in one direction only.** It proves every local
  value is legal upstream, so removals and renames break the build — but a value the SDK *adds*
  leaves the list a valid subset, compiles clean, and gets hard-rejected at runtime as invalid.
  Pair it with an `Exclude<Union, (typeof LIST)[number]> extends never` assertion for the other
  direction. The comment above this code claimed all three cases were covered while the code caught
  two; the claim was the only thing holding the third.
- **A test that iterates the list it is validating is circular** and passes regardless of contents.
  Enumerating a compile-time union at runtime is impossible — pin the values as literals and let a
  type-level assertion carry the drift check.
- **Report your own results as precisely as you'd report someone else's.** The first draft of this
  review said "6 phases, all approved unanimously, 93 commits". Phase 6 was force-advanced at the
  iteration cap with codex still at `REQUEST_CHANGES`, and the branch had 96 commits. Nobody had
  lied to me — I summarized my own work from memory rather than reading `status.yaml`, the exact
  habit that produced every docs defect in phase 6. A reviewer had to catch it. **Force-advance is
  not approval, and a review that blurs the two removes the signal the pr-gate reader most needs.**
