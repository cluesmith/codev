# PIR Review: Stream Deck SD+ two-zone builder workflow (selectors + action palette, dial-driven feedback queue)

Fixes #1410

## Summary

Turns the SD+ into a two-zone remote bound by one shared selection: **Row 1** is a 4-wide *window* of fleet-selector keys (scrolled by the Select dial, so a fleet larger than four is reachable), and **Row 2** is a fixed, uniformly per-builder action palette — **Approve · Dev · Send Fb (N) · Open Terminal** — always acting on the selected builder. The diff dials move from immediate `forward-*` to a mode-neutral `feedback-*` verb that VSCode routes forward-now or into the per-builder review queue per the `codev.diffCodelensMode` setting, with a new `send-queue` flush and a per-builder queued-count badge; the overview wire gains a `queuedFeedback` map + a `feedbackMode` scalar, and focusing a builder's spec/plan/review canvas now back-syncs the deck selection the same way focusing its diff already did.

## Files Changed

- `packages/types/src/api.ts` (+20 / -0) — `OverviewData.queuedFeedback` map + `feedbackMode`
- `packages/codev/src/agent-farm/servers/overview.ts` (+70 / -4) — populate both (read queue files + `.vscode/settings.json`)
- `packages/codev/src/agent-farm/servers/tower-routes.ts` (+1 / -1) — no-workspace fallback defaults
- `packages/codev/src/agent-farm/__tests__/overview.test.ts` (+62 / -0) — `countQueuedFeedback` / `readFeedbackMode`
- `apps/vscode/src/command-relay.ts` (+8 / -0) — allowlist `feedback-*` + `send-queue`
- `apps/vscode/src/review-queue/feedback.ts` (+127 / -0, new) — mode-router (forward now vs enqueue via `ReviewQueueStore`)
- `apps/vscode/src/extension.ts` (+15 / -1) — register the 3 feedback commands; `submitReview` accepts a builder id
- `apps/vscode/src/markdown-preview/preview-provider.ts` (+33 / -0) — canvas focus back-sync
- `apps/vscode/src/markdown-preview/canvas-owner.ts` (+27 / -0, new) — pure canvas→builder resolver
- `apps/vscode/src/__tests__/feedback.test.ts` (+118, new), `command-relay.test.ts` (+16), `canvas-back-sync.test.ts` (+35, new)
- `apps/streamdeck/src/store.ts` (+40 / -4) — `feedbackMode` / `queuedFeedback` / `windowedBuilder` readers
- `apps/streamdeck/src/face.ts` (+45 / -12) — selected accent, `approveFaceSvg` / `sendFbFaceSvg`, `comment`/`terminal` glyphs
- `apps/streamdeck/src/actions.ts` (+110 / -30) — Row 1 windowing, dial `feedback-*`, touchstrip mode label, Row 2 palette
- `apps/streamdeck/src/plugin.ts` (+4) — register `SendQueueAction`, `OpenTerminalAction`
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/manifest.json` (+22 / -10) — `send-queue` + `open-terminal` actions
- `apps/streamdeck/src/__tests__/actions.test.ts` (+140), `face.test.ts` (+30) — deck coverage
- `apps/streamdeck/README.md` (+80 / -35) — two-zone layout, feedback verbs, coherence model, activity-hook prerequisite

(Diff-stat anchored at the merge-base; excludes the `origin/main` merge that brought in bugfix-1437's Dev Server face + silent-success `ack`, which this branch builds on.)

## Commits

- `729f359a6` Open Terminal: plain label face (no builder id), VerbKey like Dev Server
- `417f6bb8f` Row 2 key 4: replace Next/Attention with per-builder Open Terminal; drop fleet jump/count
- `bc2dffde9` Tests: feedback router, relay verbs, canvas owner, overview wire
- `0a1d403d2` Docs: two-zone layout, mode-neutral feedback, coherence model + activity-hook prerequisite
- `53c144473` Deck: Row 1 window, Row 2 palette, dial feedback verbs, mode label
- `e27db8252` VSCode: mode-neutral feedback verbs, send-queue flush, canvas back-sync
- `a1f8910f3` Overview wire: per-builder queuedFeedback map + feedbackMode
- `2901a0828` E2=(b): symmetric canvas focus back-sync
- (plus plan/thread commits and a `main` merge; full list via `git log main..HEAD`)

## Test Results

- `pnpm build` (full workspace): ✓ pass
- `pnpm --filter @cluesmith/codev-streamdeck test`: ✓ 125 pass
- `pnpm --filter codev-vscode test:unit`: ✓ 822 pass
- `pnpm --filter @cluesmith/codev test` (codev): ✓ 4856 pass / 48 skipped
- `streamdeck validate`: ✓
- Manual verification: approved by the human at the **dev-approval** hardware SD+ session — the two-zone layout, dial-collect/Send-Fb flush in both delivery modes, the `Files · send`/`Files · queue` label, Row 2 Approve/Dev/Open-Terminal on the selected builder, and the diff/canvas focus back-sync were exercised on real hardware.

## Architecture Updates

**COLD** (`codev/resources/arch.md`, Integration Points): added a concise note recording the Stream-Deck↔VSCode **shared-selection coherence** invariant — the deck's selected builder and VSCode's focused artifact are kept equal by the `builder-active` activity hook (which this PR extends to fire for a focused *canvas*, not only a diff), and deck-driven review feedback mutates the queue only through `ReviewQueueStore`; the overview carries a per-builder `queuedFeedback` map + a `feedbackMode` scalar.

**HOT**: no `arch-critical.md` change — this is a deck+vscode feature within existing module boundaries and the existing "outside-in controller" fact already frames it; it doesn't rise to an always-injected system-shape fact.

## Lessons Learned Updates

**COLD** (`codev/resources/lessons-learned.md`, Testing): sharpened the existing #1414 dual-artifact lesson with *why* the deck bundle can be silently absent on a fresh worktree — the root `pnpm build` intentionally builds only the published `@cluesmith/codev` package + its deps, **not** `apps/streamdeck` / `apps/vscode` (CI builds those in separate jobs), so a relinked plugin with no `bin/plugin.js` renders nothing until `pnpm --filter @cluesmith/codev-streamdeck build` is run.

**HOT**: no `lessons-critical.md` change — the gotcha is a sharpening of an existing cold lesson, not a new always-on rule.

## Things to Look At During PR Review

- **Coherence anchors (the subtle part).** Row 1/Row 2 act on `selectedBuilder()`; the review dials act on the *focused* artifact; `feedback-*` writes attach to the *focused diff's* owner (correct — a comment must attach to the file in view) while Send Fb flushes `selectedBuilder()`. These agree because focusing a diff/canvas fires `builder-active` → `syncToBuilder`. The one transient divergence (rotate the Select dial without opening) self-heals on the next Row 1 press / focus. See the plan's "Layer integration" section.
- **`feedbackMode` sourcing.** Tower reads `<root>/.vscode/settings.json` (JSONC-tolerant, defaults to `forward`). This is single-folder-workspace only; a multi-root `.code-workspace` or user-level override isn't at that path and reads as the default — an accepted limitation (the deck falls back to `send`, never a wrong-way write, since the mode only labels the dial).
- **`send-queue` → `codev.submitReview` id forwarding.** The status-bar button still calls it arg-less (resolves target itself); the deck passes `[selectedId]`. Confirm the `typeof builderId === 'string'` guard.
- **Profile ships blank (deliberate).** `Codev.streamDeckProfile` has always shipped `Actions: null` (as #1404's Row 1 did); the two-zone layout is documented in the README and placed at the hardware session. No known-good `sdProfile` Actions schema exists in history to safely pre-populate.
- **E1 prerequisite.** The VSCode→deck focus sync needs a `builder-active` activity hook in `~/.codev/config.json` (documented in the README). Without it, only deck-driven selection moves the cursor.

## How to Test Locally

For reviewers pulling the branch (note: the deck plugin + VSCode extension are **separate builds** from the root `pnpm build`):

- **Build the surfaces**: `pnpm --filter @cluesmith/codev-streamdeck build` (plugin bundle), `pnpm --filter codev-vscode vsix` (extension), `pnpm -w run local-install` (CLI/Tower, for the badge/label wire).
- **View diff**: VSCode sidebar → right-click builder `pir-1410` → **Review Diff**.
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-1410`.
- **What to verify**: Row 1 window scrolls past 4 builders with the selected slot accented; a Row 1 press selects + opens; a diff-dial press enqueues (badge climbs) in `comment` mode and injects in `forward` mode, with the touchstrip naming the mode; Send Fb flushes; Row 2 Approve/Dev/Open-Terminal act on the selected builder; focusing a diff **or** a spec/plan canvas in VSCode moves the deck selection to it.

## Flaky Tests

None.
