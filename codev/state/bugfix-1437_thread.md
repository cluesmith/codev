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

## Scope update — Run Dev key polish (2026-08-13)

Architect folded in a second owner-directed, live-validated change (main's fold
ruling, issue #1437 comment 5274289164). Superseding patch carries BOTH changes as
one batch; PR #1438 stays the single PR. Applied the additional pieces verbatim:

- `apps/streamdeck/src/face.ts` — new `play` glyph (`M8 5v14l11-7z`) and a
  `labelFaceSvg(icon, label, color)` helper: icon zone + centered label, the
  composite frame for keys that aren't builder-state-coded.
- `apps/streamdeck/src/actions.ts` — `DevServerAction.onWillAppear` now renders the
  composite face (green play glyph + "Dev" label) via `labelFaceSvg`, so the Run
  Dev key matches the others instead of showing a bare icon. Static label (doesn't
  track running state). Doc comment reworded "dev server" → "dev".
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/manifest.json` — action Name
  "Dev Server" → "Run Dev"; Tooltip and plugin Description drop "dev server"
  vocabulary. UUID (`com.cluesmith.codev.dev-server`) and icon filenames unchanged.
  "Tower server" wording left intact (a different thing).
- Tests: `actions.test.ts` gains a DevServerAction composite-face assertion;
  `face.test.ts` gains a `labelFaceSvg` block.

Both changes were validated live on the held worktree (110/110 + build + validate).
Reproduced here: check-types clean, build clean, `streamdeck validate` successful,
tests 110/110.


