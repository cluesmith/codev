# PIR Review: Codelens-Driven Review Comments in the Builder Diff (per-builder queue + batched submit)

Fixes #1037

## Summary

The builder diff gains a structured review-comment surface layered on #789's fire-and-forget PTY injection: the reviewer composes comments in inline VSCode comment threads (codelens, gutter "+", or context menu), the comments persist in a per-builder queue at `.builders/<id>/.codev/pending-comments.json`, and a single `Submit Review` action (status-bar button + palette command) packages the whole queue into one markdown message typed into the builder PTY's prompt buffer, wrapped in bracketed-paste escapes, with no Enter pressed — the human reviews and sends. The codelens shows exactly one action per anchor, controlled by `codev.diffCodelensMode` (default `forward`, so existing #789 users see zero change; comment mode is a per-workspace opt-in via the diff title-bar toggle). The panel display surface for the queue is explicitly out of scope — it belongs to #1049, which will consume this PR's `ReviewQueueStore` read + event API.

## Files Changed

- `apps/vscode/package.json` (+132 / -0): setting, 10 commands, title-bar toggle, context-menu, comments menus
- `apps/vscode/src/review-queue/queue.ts` (+169, new): pure schema / packaging / bracketed paste / exclude block
- `apps/vscode/src/review-queue/store.ts` (+252, new): per-builder fs persistence, watcher sync, info/exclude write
- `apps/vscode/src/review-queue/reconcile.ts` (+75, new): pure thread-reconcile planning
- `apps/vscode/src/review-queue/submit.ts` (+112, new): Submit Review / Discard flows
- `apps/vscode/src/review-queue/status-bar.ts` (+45, new): `Submit Review (N)` counter
- `apps/vscode/src/comments/builder-review.ts` (+365, new): comment controller, input via built-in addComment, mount/reconcile, edit/delete
- `apps/vscode/src/diff-inject-codelens.ts` (+64 / -~10): mode-aware lenses, mode context key, registry entries accessor
- `apps/vscode/src/diff-inject-ref.ts` (+27 / -~10): `LensDescriptor.range` + label parameter
- `apps/vscode/src/extension.ts` (+53 / -~13): wiring, new commands, forward-selection cursor fallback
- 7 test files (+903 total: 6 new + 2 extended)
- `codev/plans/1037-vscode-codelens-driven-review-.md`, `codev/state/pir-1037_thread.md`

## Commits

- `35b79381` [PIR #1037] Pure review-queue module: schema, packaging, bracketed paste, exclude block
- `9e15670a` [PIR #1037] ReviewQueueStore: per-builder fs persistence, watcher sync, info/exclude block
- `ca3ee865` [PIR #1037] Mode-aware diff codelenses: diffCodelensMode setting, title-bar toggle, always-on context menu
- `9aafea09` [PIR #1037] Builder-review comment controller: inline threads, reconcile, edit/delete
- `f0383162` [PIR #1037] Submit Review: batched bracketed-paste flush to builder PTY, status-bar counter, wiring
- `67cb80d0` [PIR #1037] Focus comment input on codelens click via built-in addComment command
- `f58047ff` [PIR #1037] Comment input: pass range args to addComment, refresh commenting ranges on registry change
- `24ba4610` [PIR #1037] Mount queued threads on their full range so the widget sits after the last line
- `1f8e3218` [PIR #1037] Extend thread ranges to last-line content end so the range highlight covers every line
- `a094352e` [PIR #1037] Flip diffCodelensMode default to forward (preserve #789 for existing users)

## Test Results

- `pnpm build` (porch check): pass
- Extension unit suite (`vitest`): 695 tests / 60 files passing (38 new across 6 new test files + extensions to 2 existing)
- `pnpm check-types` + `eslint`: clean
- Manual verification at dev-approval: the human reviewer exercised the live flow in an extension host against a real builder over multiple iterations (comment capture via lens/gutter/menu, queue persistence, thread re-mount, submit-to-prompt-buffer with bracketed paste, mode toggle). Three UX defects found and fixed during the gate (input focus, stale commenting ranges, thread anchoring/highlight); one report verified not-a-bug against the stored queue JSON. Gate approved 2026-08-10.

## Deviations From the Approved Plan

1. **Default mode is `forward`, not `comment`** — human decision at the dev-approval gate (2026-08-10), deliberately overriding the issue's "comment is the default": existing #789 users see zero behavior change; comment mode is opt-in per workspace. This also removed the need for a behavior-change changelog warning.
2. **Comment input opens via the built-in `workbench.action.addComment`** (args-based) instead of programmatically created threads — the stable API cannot focus a created thread's input. Whole-file comments use the native `fileComment` concept (`thread.range === undefined`).
3. **`lineRange` is nullable in the schema** (null = whole-file comment) so the packaged section header reads `### path` instead of a fabricated line ref.
4. **#789's context-menu forward action** now shows without a selection (cursor-line fallback) to satisfy the "context menu always exposes both actions" criterion; the `Cmd/Ctrl+K B` keybinding keeps its original selection guard.
5. **Changelog files not edited on this branch** — `apps/vscode/CHANGELOG.md` and `docs/releases/UNRELEASED.md` are maintained on the `docs/vscode-changelog` branch per that workflow; suggested entry handed to the architect: "Builder diff review comments: compose queued review comments in inline threads (opt-in comment mode via the diff title-bar toggle), batch-submit to the builder's prompt via Submit Review."
6. **`terminal-manager.ts` unchanged** — the plan listed an `injectBuilderTextMultiline` method; instead `submit.ts` wraps the message with `wrapBracketedPaste` at the call site and reuses the existing `injectBuilderText`, leaving the #789 injection path byte-identical. (Flagged by the PR consultation as an undocumented deviation; documented here.)
7. **Gutter "+" is mode-independent** (plan said comment-mode-only) — forced by a real defect the PR consultation caught: `workbench.action.addComment` validates against the provider's commenting ranges, so a comment-mode-only provider broke the always-visible context-menu `Comment for Builder` in forward mode, the shipped default. Ranges are now provided for registered builder-diff files in every mode (regression-pinned in `builder-review-ranges.test.ts`); the codelens remains the mode-distinct surface.

## Architecture Updates

Routed COLD: added a "Builder review-comment queue (#1037)" entry to `codev/resources/arch.md` under VS Code Extension → Key Design Decisions (storage location + single-owner store + the #789/#1037 never-merge-state invariant + the #1049 seam). Nothing HOT: the feature is extension-scoped, not a cross-cutting system-shape fact that changes implementation choices elsewhere.

## Lessons Learned Updates

Routed COLD: three `[From 1037]` entries in `codev/resources/lessons-learned.md` under UI/UX — (1) programmatic `CommentThread` creation cannot focus its input; open inputs via `workbench.action.addComment` with `{range}`/`{fileComment}` args; (2) VS Code caches a document's commenting ranges and only re-queries on its own triggers; re-assign `commentingRangeProvider` to force a recompute when eligibility changes after the editor opened; (3) a thread range ending at column 0 excludes its last line from the range highlight, and the widget renders after the range's last line. Nothing HOT: all three are VS Code comments-API recipes, not cross-cutting rules.

## Things to Look At During PR Review

- **`review-queue/store.ts` mutate path**: load-mutate-write folds in concurrent writers from other windows; the watcher echo-suppression compares against last-written bytes. Worth a read for race assumptions.
- **Bracketed-paste injection** (`queue.ts wrapBracketedPaste` + `submit.ts`): `\n` → `\r` conversion inside `\x1b[200~ … \x1b[201~`. Verified live at dev-approval against a real Claude REPL; the wrapped payload travels `sendText` → Tower WebSocket → PTY stdin.
- **`info/exclude` managed block** (`store.ts ensureExclude`): writes to `$GIT_COMMON_DIR/info/exclude` resolved via `git rev-parse`; the `.builder-*` family glob also silences spawn scaffolding files. Failures are deliberately swallowed (cosmetic concern, never blocks a comment write).
- **`comments/builder-review.ts`**: the commenting-ranges refresh trick (provider re-assignment) and the reconciler's mount/dispose lifecycle are the least obvious parts; the pure planner (`reconcile.ts`) carries the tests.
- **#789 surface untouched**: `codev.forwardToBuilder` and the keybinding are unchanged; the only #789-adjacent edits are the context-menu `when` relaxation + cursor fallback (deviation 4) and lens titles/commands swapping by mode.
- **PR consultation findings and dispositions** (single advisory pass; claude=APPROVE, codex=REQUEST_CHANGES — all three codex findings assessed as valid and fixed, since PIR does not auto-re-review):
  1. *Context-menu comment action broken in forward mode (real defect)* — commenting ranges were comment-mode-only while `workbench.action.addComment` validates against them; with forward as the shipped default, `Codev: Comment for Builder` from the context menu could not create a thread. Fixed by making the ranges mode-independent (deviation 7); regression test `builder-review-ranges.test.ts` pins ranges + `enableFileComments` in every mode.
  2. *Palette blind to persisted queues after reload* (also flagged by claude) — fixed: `ReviewQueueStore.preloadFromDisk()` scans `.builders/*/.codev/pending-comments.json` at activation, so the palette command and status-bar counter see queues before any diff opens. Covered by two new store tests.
  3. *Plan-promised tests missing* — added: watcher echo-suppression (own write suppressed, external write honored, via captured watcher handlers) and out-of-bounds anchor clamping (extracted as pure `clampAnchorLines` in `reconcile.ts`, 5 cases).

## How to Test Locally

- Pull the branch; `pnpm install`; launch the extension host from `apps/vscode` (F5) or `pnpm vsix` and install.
- Open a builder diff from the Agents view. Default (forward) mode: lenses read `Forward to Builder` and behave exactly as #789.
- Click the title-bar `$(comment)` toggle: lenses flip to `Comment for Builder`, gutter "+" appears. Add comments via lens, gutter, and right-click; watch the status-bar `Submit Review (N)` counter.
- Reload the window, re-open the diff: queued threads re-mount at their ranges.
- `Codev: Submit Review`: packaged message lands in the builder's prompt buffer without submitting; queue and threads clear; press Enter in the terminal to deliver.
- Two-builder isolation: queue comments on two builders' diffs; each `.builders/<id>/.codev/pending-comments.json` stays separate; each submit flushes only its builder.
- `git status` inside a builder worktree: neither the queue file nor `.builder-*` scaffolding shows as untracked.
