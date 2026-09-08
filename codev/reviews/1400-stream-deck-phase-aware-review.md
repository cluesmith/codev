# PIR Review: Stream Deck phase-aware review dials

Fixes #1400

## Summary

The Stream Deck's two diff dials (Files / Changes) sat idle whenever the selected builder was
writing a spec or plan — exactly when the artifact **canvas** is the thing under review. This change
makes those two dials **phase-aware**: the selected builder's phase picks the dial *mode*, so the
same physical gestures review whichever artifact form applies. Diff-phase builders drive the diff
(unchanged); spec/plan-phase builders drive the artifact canvas (headings / blocks, composer, comment
walk) over #1401's `sendCanvasCommand`. No bridge, sdk, Tower, or vscode change — only the deck.

## Files Changed

- `apps/streamdeck/src/actions.ts` (+164 / -21) — `reviewMode()` resolver + `DiffNav` → phase-aware `ReviewNav`
- `apps/streamdeck/src/__tests__/actions.test.ts` (+118 / -8) — canvas-mode, legibility, `reviewMode`, per-code feedback tests
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/manifest.json` (+11 / -11) — dial Name/Tooltip/TriggerDescription reflect the dual role (UUIDs unchanged)
- `apps/streamdeck/README.md` (+13 / -6) — Actions list updated for the renamed, phase-aware dials

## Commits

- `9aa1a29d9` [PIR #1400] Phase-aware review dials: canvas mode reuses the diff dials
- `1abc02025` [PIR #1400] Rename review dials in manifest to reflect phase-aware behavior
- (plus `[PIR #1400]` thread + plan commits; README rename folded into the review commit)

## Test Results

- `npm run build`: ✓ pass (esbuild bundle)
- `npx tsc --noEmit`: ✓ pass
- `npm test`: ✓ pass (84 tests, 13 new — includes 2 pinning the `none`-mode no-op fix below)
- `npx streamdeck validate`: ✓ pass
- Manual verification (human, dev-approval gate): sideloaded from the worktree; confirmed the phase
  switch, the live touchstrip re-title, and that diff-phase behavior is unchanged.

## Architecture Updates

No hot-tier (`arch-critical.md`) change: this is a self-contained controller-side feature, not a new
invariant or module boundary. No cold-tier (`arch.md`) change needed either — the existing
`apps/streamdeck` entry already describes the deck as an "outside-in controller: … command-relay
verbs via the sdk's `controller`/`node` subpaths," and `sendCanvasCommand` lives on that same
`controller` subpath, so the description stays accurate.

## Lessons Learned Updates

No new hot-tier lesson. Two existing hot lessons already governed the key decisions and were followed
rather than added to: *"Single source of truth beats distributed state"* (the dial mode is derived
from the shared `phaseArtifactVerb` resolver, not a re-derived phase-string table) and *"After any
rename … grep the whole repo"* (the manifest rename drove the README + tooltip + trigger-description
sweep). The MRU-vs-file-qualified targeting call is spec-narrow and already captured in the plan (§5)
and issue thread, so it does not warrant a cold-tier entry.

## Things to Look At During PR Review

- **3-way consultation — `none`-mode fix (Codex REQUEST_CHANGES, Claude flagged same, HIGH confidence).**
  Both reviewers caught that the first implementation let `none` mode (no builder / unknown phase)
  fall through to the diff verbs, whereas plan §2 specifies a no-op. This was a genuine unstated
  deviation from the approved plan. **Fixed** in `onDialRotate` / `onDialDown` / `onTouchTap`: each now
  branches explicitly on `mode === 'diff'`, so `none` sends nothing on either channel. Pinned by two
  regression tests (unknown-phase builder, and no builder) asserting `sent` and `canvasSent` are both
  empty — they fail against the pre-fix fall-through. Gemini returned APPROVE with no issues.

- **`reviewMode()` reuse** (`actions.ts`): it is intentionally a thin derivation of `phaseArtifactVerb`
  (`open-spec`/`open-plan` → canvas, `view-diff` → diff, else `none`) so the wire source stays single
  (`blockedGate` beats `protocolPhase`; never guessed). If the phase→artifact mapping ever changes,
  both the Builder Action key (#1404) and these dials move together — that coupling is the point.
- **MRU targeting (no `file`)** (`runCanvas`): every canvas gesture targets `{ workspace }` only. This
  was the deliberate v1 decision (plan §5, co-signed by main as the types stakeholder) because
  `OverviewBuilder` carries no artifact path; #1404's press converges the MRU onto the selected
  builder's artifact. File-qualified targeting is the documented additive upgrade, not a gap.
- **Canvas `count = |ticks|`** (`onDialRotate`): one `sendCanvasCommand` per rotate event carrying the
  tick count, never a burst of single-tick sends. Diff-mode rotate is unchanged (one verb per event).
- **Transient error line** (`status` field + `canvasErrorLine`): a failed canvas command shows its
  per-code reason (`no-canvas` → "Open artifact", `unreachable` → "Tower offline") on the touchstrip
  until the next overview tick clears it — the `render()` onChange handler clears it, gesture handlers
  set it. Worth a look that the clear/set ordering can't strand a stale error.
- **Type choice**: canvas spec fields are typed `CanvasCommand` (re-exported from
  `@cluesmith/codev-sdk/controller`), not `TraversalCommand` — the latter isn't re-exported there and
  the import-boundary test forbids importing `@cluesmith/codev-types` directly. No sdk change; `count`
  isn't type-restricted to traversal by the sdk signature anyway.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-1400 → **Review Diff**
- **Run / sideload**: build (`pnpm --filter @cluesmith/codev-sdk build` then
  `pnpm --filter @cluesmith/codev-streamdeck build`), then
  `streamdeck link apps/streamdeck/com.cluesmith.codev.sdPlugin` +
  `streamdeck restart com.cluesmith.codev` (unlink any existing build first)
- **What to verify** (maps to the plan's Test Plan):
  - Select an implement/review builder → dials read `Files`/`Changes`; rotate/press/tap drive the diff
    exactly as before (no regression)
  - Select a specify/plan builder → dials re-title `Headings`/`Blocks`; press the builder key (#1404)
    to open its artifact; rotate steps headings/blocks, press opens the composer, coarse tap jumps to
    the top, fine tap walks forward through commented blocks
  - No artifact canvas open → a canvas rotate shows `Open artifact`; Tower stopped → `Tower offline`
  - Switch the selected builder between a diff-phase and a canvas-phase builder → both dials re-title
    within one overview tick
