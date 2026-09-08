# Bugfix #1436: CI streamdeck validate step flakes on transient network errors

## Summary

The `streamdeck validate` CI step intermittently failed *unrelated* PRs (#1432, #1434) with `UND_ERR_SOCKET` / `fetch failed` and no code defect, each costing a human-triggered rerun. Wrapped the validate invocation in a bounded loop (up to 3 attempts, exponential backoff) that makes another attempt **only** on transient-network signatures and fails fast on real validation errors. This takes the network off CI's pass/fail path without vendoring rules or going offline.

## Root Cause

Not the schema-update fetch the issue title guessed. Traced to the Elgato CLI's `manifestUrlsExist` validation rule (`@elgato/cli`, `src/validation/plugin/rules/manifest-urls-exist.ts`): on every run it does a **live** `fetch(URL, { method: 'HEAD' })` against the manifest's top-level `URL` (ours is `https://github.com/cluesmith/codev`). Its catch block converts only `ENOTFOUND` into a graceful "must be resolvable" validation error; **any other fetch failure (`UND_ERR_SOCKET`, `ECONNRESET`, `ETIMEDOUT`, `fetch failed`) is rethrown and crashes the whole `validate` command** — a transient socket blip fails the job.

The offline route was ruled out **empirically**: `streamdeck validate --help` exposes `--no-update-check` / `--force-update-check`, but those gate only the *schema* update fetch, **not** the manifest-URL reachability probe. Schemas are already bundled locally via `@elgato/schemas`. So retrying the transient failure is the correct and only clean fix.

## Fix

- New testable helper `apps/streamdeck/scripts/validate.mjs`: runs `streamdeck validate` up to 3 times with exponential backoff (1s, 2s), attempting again **only** when the combined output matches a transient-network signature. Real validation errors fail fast on attempt 1; an exhausted transient run still exits non-zero so CI fails loudly. `ENOTFOUND` is deliberately excluded (the CLI already reports it gracefully), while `EAI_AGAIN` (transient DNS) is included. A spawn failure surfaces its error message rather than an empty exit 1.
- `apps/streamdeck/scripts/validate.d.mts`: a declaration sidecar so the NodeNext import in the test resolves with real types (see Lesson 2).
- `apps/streamdeck/package.json`: `validate` calls the helper; the inline `streamdeck validate` in the local `package` script is swapped 1:1 for it. Both CI workflows (`test.yml:113`, `sdk-canary.yml:57`) run `pnpm validate`, so both flake sites are covered. No script restructuring.

## Files Changed

| File | Change |
|------|--------|
| `apps/streamdeck/scripts/validate.mjs` | New helper: bounded-attempt + backoff wrapper around `streamdeck validate`; exported core (`runWithBackoff`, `isTransientError`, `TRANSIENT_SIGNATURES`) |
| `apps/streamdeck/scripts/validate.d.mts` | New declaration sidecar so the test imports real types, not `any` |
| `apps/streamdeck/src/__tests__/validate.test.ts` | New regression suite (8 tests) |
| `apps/streamdeck/package.json` | `validate` + inline `package` call routed through the helper |

## Testing

- 8 deterministic regression tests: transient-then-success recovery (fails against a single-attempt impl, passes with the loop), fail-fast on real errors, exponential backoff spacing, transient/`ENOTFOUND` signature boundary, first-attempt success.
- Full streamdeck suite: 170 tests pass. `pnpm build` passes. `pnpm check-types` passes (see Lesson 2).
- End-to-end against the real CLI: URL probe passes → `Validation successful` (exit 0); a real error (missing `bin/plugin.js`) fails fast (exit 1).

## CMAP Review

- **Gemini**: APPROVE (HIGH)
- **Codex**: APPROVE (HIGH)
- **Claude**: COMMENT (HIGH, non-blocking) — nits addressed: dropped an over-broad `'network'` substring matcher in favor of specific `ENETUNREACH`/`ENETDOWN`, surfaced spawn-failure diagnostics, and corrected the test count.

Architect integration review: APPROVE, re-anchored to the final head after post-review renames.

## Lessons Learned

- **A green sub-check is not a green branch.** This branch was RED on seven consecutive heads (`e731e82d2` … `0455c7b43`) while `CLI Integration Tests` passed on every one of them. Watching one always-green check (or the local `pnpm test`) let three of us report or accept "CI green" on a branch that had *never* been fully green. Verify the *whole* required check set against a stationary head before claiming green or merging — a single passing job is evidence about that job, not the branch.
- **`pnpm test` (vitest) is not `pnpm check-types` (tsc) — run both before claiming done.** The actual merge-blocker was a type error `tsc` catches but vitest ignores: a *multi-line* `@ts-expect-error` import suppressed only the `import {` line while the real `TS7016` landed on the `from '…'` line rows below (and the unused directive itself tripped `TS2578`). I ran vitest locally but never `check-types`, so the defect was latent from the first commit and only surfaced when CI's type-check step completed. "Tests pass" must mean *all* the required commands, type-check included.
- **Fix the cause, not the suppression.** Rather than relocating the `@ts-expect-error`, the fix adds a `.d.mts` sidecar so the import resolves with real types and needs no suppression at all. The net result is *better* than the state everyone believed the lane was in: the test now genuinely type-checks the helper's public surface (`runWithBackoff`, `isTransientError`) instead of importing `any`. A declaration that drifts from its module would be worse than none, so the four exports and every `BackoffOptions` field were checked against `validate.mjs`.
- **Prefer a retry/attempt loop over vendoring when a dependency puts the network on the pass/fail path but you don't control it** — but verify the "offline" escape hatch empirically (`--help`) before assuming it exists; here `--no-update-check` looked like the offline answer and wasn't.
- **Post-review renames are invisible to the reviewer.** Two owner-directed renames after the integration review left the approval citing files that no longer existed; the reviewer had to re-anchor to the final SHA. When artifacts are renamed after review, flag it back to the reviewer.
