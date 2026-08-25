# bugfix-1436 — streamdeck validate CI flake on transient network errors

Issue #1436. BUGFIX protocol, strict mode.

## Investigate (iter 1)

### Root cause (traced from source, not assumed)

The flake is NOT a schema-update fetch as the issue title guessed. The exact failure
path is the Elgato CLI validation rule `manifestUrlsExist`
(`@elgato/cli` dist, rule from `src/validation/plugin/rules/manifest-urls-exist.ts`):

```js
const { status } = await fetch(url.value, { method: "HEAD" });   // url = manifest top-level "URL"
...
} catch (err) {
  if (err.cause?.code === "ENOTFOUND") {
    this.addError(..., "must be resolvable", url);   // graceful validation error
  } else {
    throw err;   // <-- ANY other fetch error (UND_ERR_SOCKET, ECONNRESET, ETIMEDOUT,
                  //     "fetch failed") is RETHROWN → crashes `streamdeck validate` → CI job fails
  }
}
```

Our manifest declares `"URL": "https://github.com/cluesmith/codev"`
(`com.cluesmith.codev.sdPlugin/manifest.json:10`). `streamdeck validate` does a live
HEAD request to that URL every run. A transient socket error (not ENOTFOUND) is
rethrown unhandled and fails the whole validate step — exactly the observed
`UND_ERR_SOCKET` / `fetch failed` on PRs #1432, #1434, with no code defect.

### Offline fallback verified NOT viable
CLI `--help` empirically checked: `streamdeck validate` has `--no-update-check`
("Disables updating schemas") and `--force-update-check`. But those only gate the
SCHEMA update; they do NOT disable the manifest-URL reachability probe. So offline /
`--no-update-check` would NOT remove this flake. Retry is the correct and only clean fix.
Schemas themselves are bundled locally via `@elgato/schemas`.

### Fix (architect preference: bounded retry with backoff)
Wrap the `streamdeck validate` invocation in a bounded retry (3 attempts, exp backoff),
retrying ONLY on transient/network error signatures; fail fast on real validation errors.
Place a small testable helper `apps/streamdeck/scripts/validate.mjs` (mirrors
the existing `scripts/render-action-icons.mjs` + matching vitest test pattern) and point
the `validate` npm script at it. Both CI workflows call `pnpm validate`
(test.yml:113, sdk-canary.yml:57), so this fixes the flake at both sites. Local `package`
script inlines `streamdeck validate` — swap that one call for the helper too (no script
restructuring).

Regression test: simulate a transient failure then success against the retry helper;
fails without retry (single-shot throws), passes with it. Real validation errors must
NOT be retried.

Scope: << 300 LOC. Fits BUGFIX.

## Fix + PR (iter 1)

Implemented `apps/streamdeck/scripts/validate.mjs` (retry core exported +
unit-tested), wired `package.json` `validate` + inline `package` call to it. 170
streamdeck tests pass (11 new). Verified end-to-end: happy path exit 0, real error
fails fast (exit 1), transient retries in unit tests, regression test fails without fix.
Committed 84fd5e785. Porch checks (build, tests) passed. PR #1451 opened (Fixes #1436).

CMAP: first run failed to auto-detect project from worktree ("Multiple projects found");
re-ran with `--issue 1436 --project-id bugfix-1436` — both resolve PR #1451 correctly.
Awaiting all three verdicts before notifying architect + `porch done` (pr gate).

## CMAP verdicts + review fixes

- gemini=APPROVE (HIGH), codex=APPROVE (HIGH), claude=COMMENT (HIGH, non-blocking nits).
- Addressed claude's substantive points:
  - Dropped the over-broad `'network'` substring from TRANSIENT_SIGNATURES (could false-retry
    a plugin description mentioning "network"); added specific `ENETUNREACH`/`ENETDOWN`.
  - Spawn failure now surfaces `error.message` in output instead of exit-1-with-empty-output.
  - Sharpened the comment on the deliberate EAI_AGAIN (retry) vs ENOTFOUND (fail-fast) asymmetry.
  - Corrected PR body test count: 8 new tests (170 suite total), not 11.
- Left as-is (correct by design): ENOTFOUND exclusion — the CLI already reports it as a graceful
  "must be resolvable" error, so we must not retry a genuinely bad URL.
- 170 tests still pass after the fixes.

## Merge saga + outcome

- pr gate approved by Amr; architect integration review APPROVE.
- CI on head 50953ae0c came back 6/7 green with **Unit Tests RED** — a real defect, not a
  flake. The failure was the `check-types` (tsc) step, which I never ran locally (I only ran
  `pnpm test`/vitest, which ignores type errors). Root cause: a multi-line `@ts-expect-error`
  import suppressed the `import {` line while the real `TS7016` landed on the `from '…'` line
  below it (unsuppressed), and the unused directive tripped `TS2578`.
- Fixed the CAUSE not the symptom: added `scripts/validate.d.mts` so the NodeNext import
  resolves with real types, and removed the suppression entirely. The test now type-checks
  `runWithBackoff`/`isTransientError` for real instead of importing `any`. Pushed head 6e3c9ecff.
- **Key process lesson (architect-flagged): the branch was RED on seven consecutive heads
  (e731e82d2 … 0455c7b43) while `CLI Integration Tests` was green on every one** — which is how
  three people reported/accepted "CI green" on a branch that had never been fully green. A green
  sub-check ≠ a green branch. Verify the whole required set against a stationary head.
- Honored two architect "go quiet" windows (no branch writes; reported status via `afx` only) to
  avoid a commit→CI-restart loop.
- All 7/7 green on stationary head 6e3c9ecff. **PR #1451 merged 2026-08-15T03:02:02Z**, merge
  commit 9fe014a95. Verified origin/main contains 6e3c9ecff and all three files. `porch done
  --merged 1451` → protocol COMPLETE.
- Renames were owner-directed (Amr): verbose → `retry-validate.mjs` → drop "retry" entirely →
  `validate.mjs` (+ export `runWithRetry` → `runWithBackoff`). These landed after the integration
  review, so the reviewer re-anchored to the final SHA.
- Review artifact written: `codev/reviews/bugfix-1436-ci-streamdeck-validate-step-fl.md`.
  Delivering review + this thread finalization via a small follow-up PR (fix PR already merged).
