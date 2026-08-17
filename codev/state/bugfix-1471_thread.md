# bugfix-1471 — Render gate: replace the perf wall-clock assertion with a deterministic op-count check

Issue #1471. BUGFIX protocol, strict mode.

## Architect constraints (received 2026-08-17)

- We are **not** cluesmith/codev maintainers: open the PR, get reviewer approval, **never merge**.
  Park the PR after review and report protocol-complete.
- Pin the **round-2** cost property: classify is O(viewport) via the persistent bounded
  `SessionScreen` mirror — not the retired whole-ring path.
- Other gate issues (#1361/#1473/#1474) will touch `render-gate.test.ts` later — keep the change
  tightly scoped so it lands first and cleanly.

## Investigate (done)

**Environment note.** The worktree had no `node_modules`; `pnpm install --frozen-lockfile` at the
worktree root was needed before vitest would start.

**Reproduced the flake.** `render-gate.test.ts` "renders a realistic large (~4MB) ring WHOLE within
a CI-aware budget" measures best-of-5 `classifyScreen` wall-clock over a 4 MB replay and asserts it
under `process.env.CI ? 800 : 250` ms (line 204).

- Idle, 24 cores: passes comfortably.
- Same code, pinned to one contended core (`taskset -c 0` + 4 busy loops on core 0):
  `[render-gate] whole-render @4096KB best-of-5 = 391.7ms` →
  `AssertionError: expected 391.73237999999947 to be less than 250`.

Nothing about the code changed between those two runs — only machine contention. That is the bug:
the assertion's outcome is a function of the runner, not of the algorithm.

**Root cause.** `packages/codev/src/agent-farm/__tests__/render-gate.test.ts:189-205`:

1. The assertion is *timing-based*. `performance.now()` deltas measure machine speed + scheduling;
   best-of-5-min reduces but cannot remove that (a fully contended core has no lucky run). So the
   bound either flakes under load or gets loosened until it no longer catches the regression it
   exists for — which is exactly the history here (75ms → 250/500 → CI-aware 800).
2. It measures the **wrong path**. It times `classifyScreen` — the transient whole-ring entry that
   parses the entire replay into a throwaway `Terminal` on every call, so its cost genuinely IS
   O(ring size). Production (round 2) classifies the persistent bounded `SessionScreen` mirror via
   `classifyBuffer`, which only *reads* an already-parsed viewport: O(rows × cols), independent of
   ring size (`session-screen.ts:1-38`, `render-gate.ts:11-55`).

**Fix shape (test-only, no production change).** `classifyBuffer(term, cols, rows, profile)` takes
the terminal as a parameter, so the test can hand it a counting facade over the real mirror buffer
and count the work the classifier actually does — `getLine` calls and `line.getCell` calls. Then
assert:

- the op counts for a ~4 MB stream are **exactly equal** to those for a few-KB stream at the same
  geometry (zero dependence on ring size), and
- they are bounded by geometry (cell reads ≤ rows × cols, line reads ≤ 2 × rows), so a reintroduced
  whole-history/scrollback scan fails the test.

Both are integer comparisons — they cannot flake on a loaded runner.

The existing 4 MB test keeps its *correctness* half (a 4 MB ring renders whole and classifies busy —
no slice, no size cap); only the timing loop and the CI-aware budget go away.

Scope: well under the 300-LOC BUGFIX ceiling, confined to one test file. Proceeding.

## Fix (done)

Test-only change, `render-gate.test.ts` (+181/−22). No production file touched.

1. The 4 MB whole-ring test keeps its correctness half (a 4 MB ring renders whole and classifies
   its busy tail); the warm-up + best-of-5 timing loop and the CI-aware budget are gone.
2. New suite: *"deterministic op count: one classify is O(viewport), not O(ring size) (#1471)"*.
   A `Proxy` facade over the mirror's live terminal counts `getLine` / `getCell` / bytes written,
   and `classifyBuffer` is handed that facade — the real classifier runs, nothing is stubbed.
   Four tests: byte-identical op counts for a 4 MB history vs a ~200 B history ending in the same
   repainted screen; a geometric bound (`lineReads ≤ 2·rows`, `cellReads ≤ cols·rows`,
   `bytesParsed === 0`); flat cost across repeated classifies; and a negative control showing the
   retired whole-ring path re-parses ~4 MB per classify (so the counter demonstrably tells the two
   cost models apart).

**Regression evidence** (both simulations reverted afterward):

| Simulated regression in `render-gate.ts` | Result |
|---|---|
| `screenLines` scans from history start instead of `viewportY` | 3 op-count tests fail |
| pure cost regression — walk all history, verdict unchanged | 2 fail: `lineReads` 1131 vs the ≤130 viewport bound, and 1131 vs 66 across the two history sizes |

The second is the important one: the verdict stays correct, so *only* the op count catches it —
which is what the wall-clock bound was proxying for.

**Determinism check.** The full 46-test file passes pinned to one contended core (`taskset -c 0` +
4 busy loops) — the exact condition under which the old assertion measured 391.7ms against its
250ms bound. Full package suite: 4860 passed / 48 skipped / 0 failed. `pnpm --filter
@cluesmith/codev build` passes; the test file also typechecks clean under a temporary tsconfig that
un-excludes `__tests__` (the package build excludes tests, so nothing type-checks them in CI).
