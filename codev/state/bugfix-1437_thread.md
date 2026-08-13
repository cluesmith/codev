# bugfix-1437 — Stream Deck: silence green success checkmark

## Investigate (2026-08-13)

**Bug**: Stream Deck key presses flash a green success checkmark (`showOk`) on
success. Owner directive (validated on live hardware): success should be silent;
the red failure alert (`showAlert`) stays.

**Root cause**: `apps/streamdeck/src/actions.ts:37-39`, the shared `ack(action, ok)`
helper:
```ts
async function ack(action: KeyAction, ok: boolean): Promise<void> {
  await (ok ? action.showOk() : action.showAlert());
}
```
`ack` is the single acknowledgement path for all three verb keypads
(`VerbKey.onKeyDown` at :56, and the two overrides at :134 and :211). So the
green checkmark is shared across every key, and silencing it here silences it for
all — exactly what the issue asks.

**Fix** (architect-supplied, hardware-validated patch — apply verbatim): guard the
success branch so success is silent, failure still alerts.

**Test**: `apps/streamdeck/src/__tests__/actions.test.ts` currently asserts
`showOk` was called on success; flip to assert `showOk` NOT called and `showAlert`
NOT called on success.

**Scope**: ~5 LOC of production change + test edit. Comfortably BUGFIX. Selection-
border idea from the issue is explicitly out of scope (architect confirmed).

Validation history (per issue #1437): the change was already run on the live deck
in the held `.builders/pir-1428` worktree — check-types clean, 108/108 tests. This
lane exists to land it on a real branch before the main-checkout re-link sweeps
that worktree.

## Fix (2026-08-13)

Applied the architect's hardware-validated patch verbatim:
- `apps/streamdeck/src/actions.ts` — `ack()` now guards with `if (!ok) await
  action.showAlert()`; success path is silent.
- `apps/streamdeck/src/__tests__/actions.test.ts` — the CodevAction success test
  now asserts neither `showOk` nor `showAlert` was called. This is the regression:
  it fails against the old `ok ? showOk() : showAlert()` (showOk would fire) and
  passes with the guard. Failure-alert coverage (lines 130, 210) is untouched.

Fresh worktree needed `@cluesmith/codev-types` + `@cluesmith/codev-sdk` built
(no `dist/`) before streamdeck check-types/build could resolve the SDK subpath
imports — a pre-existing environment step, not part of the fix.

Results in this worktree: check-types clean, build clean, tests 108/108.
`porch check` green (build + tests).

