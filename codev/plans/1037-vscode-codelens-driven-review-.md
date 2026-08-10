# PIR Plan: Codelens-Driven Review Comments in the Builder Diff (#1037)

## Understanding

#789 (PR #1023) shipped fire-and-forget PTY injection from the builder diff: codelenses on each changed file (file-level, per-symbol, per-changed-run) type a `path:L42-L58 ` reference into the builder's prompt buffer, and the reviewer keeps typing. This issue layers a second, structured surface on top: the reviewer composes paragraph-length comments in inline comment threads (VSCode `comments` API), the comments accumulate in a per-builder queue persisted at `.builders/<id>/.codev/pending-comments.json`, and a single `Submit Review` action packages the whole queue into one batched message written to the builder PTY's prompt buffer (no Enter; the human reviews and submits).

**Scope boundary (per architect instruction at plan time):** this PIR is #1037 only. The capture surface (codelens + inline threads), the persistence layer, and the batched submit (palette command + status-bar button). The bottom-panel display surface belongs to #1049 and is NOT built here; no panel views, no `PanelModeContributor`. The deliverable is fully usable standalone. The queue store exposes a clean read + event API as the seam #1049 will consume later.

Key codebase facts the design builds on:

- The diff surfaces are `viewDiff` (multi-file `vscode.changes` editor) and `openBuilderFileDiff` (per-file `vscode.diff`), both in `apps/vscode/src/commands/view-diff.ts`. Right sides are plain `file:` docs inside the worktree, registered in the diff-inject registry (`apps/vscode/src/diff-inject-codelens.ts`) keyed by fsPath with `{builderId, relPath, hunks}`.
- Lens anchors come from pure helpers in `apps/vscode/src/diff-inject-ref.ts` (`buildAllLensDescriptors`): a file-level lens at line 0, per-symbol lenses, per-changed-run lenses. The issue's "file/hunk header" language maps onto these existing anchors; no new anchor computation is needed.
- CodeLens is suppressed by VSCode in the multi-file `vscode.changes` editor (pre-existing #789 limitation). There, the context menu (and the comment gutter "+") are the working affordances. Documented, unchanged.
- PTY injection is `TerminalManager.injectBuilderText` → `Terminal.sendText(text, false)` → `terminal-adapter.ts handleInput` → raw bytes over WebSocket to the Tower PTY. Raw `\n` bytes act as Enter in the Claude REPL, so multi-line submit needs bracketed-paste wrapping (design locked below, verified at dev-approval).
- `apps/vscode/src/comments/plan-review.ts` already uses `vscode.comments.createCommentController` with the edit/save/cancel/delete command pattern (#1055). The new controller mirrors it. Comments API surface used (`createCommentController`, `CommentThread`, `commentingRangeProvider`, `CommentMode`) is long-stable and already exercised in this codebase against the pinned engine (`^1.105`), so no newer API surface is required.

## Locked Plan-Gate Decisions

### 1. Codelens surface (locked by issue + sub-decisions)

- Exactly one lens per anchor, matching `codev.diffCodelensMode`: `Comment for Builder (…)` in comment mode (default), `Forward to Builder (…)` in forward mode.
- **Setting**: `codev.diffCodelensMode`, enum `"comment" | "forward"`, default `"comment"`, declared in `package.json` configuration, written with `ConfigurationTarget.Workspace` (persists per workspace as the issue requires).
- **Title-bar toggle**: single action button following the established Issue-1104 pattern (VSCode has no pressed-state for toolbar buttons): two commands, exactly one visible via a `when` clause on a `codev.diffCodelensMode` context key kept in sync with the setting; each shows the icon + title of the mode clicking switches TO. Icons: `$(comment)` for "switch to comment mode", `$(terminal)` for "switch to forward mode". Shown only when `codev.activeEditorIsBuilderFile`.
- **No sidebar duplication** of the toggle: title-bar button + settings UI only (single canonical entry point).
- **Context menu**: `editor/context` on builder-diff files always shows BOTH `Codev: Comment for Builder` (new; uses selection if present, else cursor line) and the existing forward actions, regardless of mode.
- **Gutter "+"**: the comments API's native `commentingRangeProvider` is enabled on registered builder-diff right-side docs in comment mode. It is the line-precise entry the lens anchors can't give. In forward mode the provider returns no ranges so the two modes stay visually distinct.
- **Keybinding**: none added in v1 (`Cmd/Ctrl+K B` keeps injecting regardless of mode, untouched). A comment keybinding is a follow-up once verified unbound against the bundled defaults.

### 2. Submit format: one markdown-sectioned message

```
Review feedback (3 comments):

### packages/vscode/src/views/builders.ts:L42-L58
the early return here is wrong because Y; suggest Z

### apps/vscode/src/extension.ts:L1140
...
```

Written to the prompt buffer as a single injection, wrapped in bracketed-paste escapes (`\x1b[200~` … `\x1b[201~`, with inner `\n` converted to `\r` to mimic a terminal paste) so the Claude REPL treats it as pasted buffer content rather than Enter presses. No trailing Enter: the human reviews and submits (deliberate human-in-the-loop step, per issue and architect instruction).

Rejected: JSON envelope (requires builder-side parsing); multiple sequential PTY writes (N interleaving opportunities, and the REPL prompt state between writes is unknowable).

### 3. Edit / delete of queued comments

Per-comment **edit** and **delete** via the native comment UI, mirroring the #1055 pattern from `plan-review.ts` (edit/save/cancel/delete commands, `contextValue`-scoped menus). Plus a `Codev: Discard Review Comments` palette command that clears the active builder's queue (with confirm). No reorder (queue order = `createdAt`).

### 4. No active terminal at submit time

Fall through to the existing `openBuilderByRoleOrId(builderId, true)` open/recovery flow, then inject; warning toast on failure. Exactly matches #789's `codev.forwardToBuilder`.

### 5. Replies

None in v1. `thread.canReply = false` once a comment is queued; one comment per thread; changes go through edit. Replies-as-separate-comments is a follow-up.

### 6. Thread persistence across reloads

Re-mount when the diff is re-opened for that builder: a reconciler listens to the diff-inject registry change event (`onDidChangeDiffInjectRegistry`) plus queue-change events, and creates/disposes threads so that every queued comment whose file is currently registered has exactly one visible thread (keyed by comment id; anchor line clamped to document bounds). Queued comments for unopened files stay invisible until their diff opens.

### 7. Sync mechanism: hybrid (in-process events + file watcher)

- In-process: the store fires `onDidChangeQueue(builderId)` on every mutation it performs. Same-window surfaces (threads, status bar) update instantly.
- Cross-window / external: a `FileSystemWatcher` on `RelativePattern(workspaceRoot, '.builders/*/.codev/pending-comments.json')` with a **200ms debounce** catches other VSCode windows' writes and external deletes (`afx cleanup` removing the worktree). Watcher events re-read the file and fire the same in-process event.
- Own-write echo suppression: the store compares file content mtime/hash before firing from the watcher path.

### 8. Gitignore mechanism (architect-flagged decision)

**Chosen: a managed block in `$GIT_COMMON_DIR/info/exclude`, written idempotently by the extension when the store first creates a queue file.** Block content:

```
# codev: builder worktree local state (managed block)
.builder-*
.codev/pending-comments.json
```

Weighing the two options the architect named:

- Committed `.gitignore` entry: one visible, versioned line. But codev is a framework: every adopter repo would need the same entry, which means a `codev update` migration touching user `.gitignore` files, and until adopted the file shows as untracked noise in every builder's `git status` (and trips "keep worktree clean" checks). Heavier for the same result.
- Spawn-time `.git/info/exclude` write: reaches every adopter automatically with zero committed footprint, and `info/exclude` lives in the shared common dir so ONE write covers all worktrees, past and future. But wiring it into spawn means the fix only applies at the next spawn with a new codev version, and this PR is extension-side.

The chosen variant takes the info/exclude approach but writes from the extension at queue-file creation (the moment the file is born), so it works for already-spawned builders and keeps this PR self-contained. It also adopts the family glob `.builder-*`, which retroactively silences the accumulating scaffolding-file class (`.builder-prompt.txt`, `.builder-role.md`, `.builder-session-id`, `.builder-start.sh`; the glob does NOT match the `.builders/` directory itself). Downsides accepted: invisibility (mitigated by the comment header) and non-survival of a fresh clone (rewritten on next use). Open question for the gate: whether to also include `.claude/hooks/` (spawn-written, currently untracked in worktrees); left out for now to keep the exclude scope tight.

### 9. Schema (v1)

```jsonc
{
  "version": 1,
  "builderId": "pir-859",
  "comments": [
    {
      "id": "<crypto.randomUUID()>",
      "createdAt": "2026-08-06T10:00:00Z",
      "file": "packages/vscode/src/views/builders.ts",   // repo-relative
      "lineRange": { "start": 42, "end": 58 },            // 1-based inclusive
      "body": "markdown text"
    }
  ]
}
```

Changes vs the issue sketch: `diffContext` dropped for v1 (nothing consumes it; the parser tolerates unknown fields so it can return later without a version bump). Corrupt/unparseable file reads as empty without destroying the bytes; the file is only rewritten on the next mutation.

## Proposed Change

New modules (following the repo's pure-logic-vs-vscode-shell split, precedent `diff-inject-ref.ts`):

1. **`apps/vscode/src/review-queue/queue.ts`** (pure, no `vscode` import): schema types, tolerant parse + serialize, mutation helpers (add/edit/remove/clear returning new state), `buildSubmitMessage(comments)` (the exact packaging format), `wrapBracketedPaste(text)`, and exclude-block helpers (`mergeExcludeBlock(existing)` idempotent).
2. **`apps/vscode/src/review-queue/store.ts`**: `ReviewQueueStore`. Resolves each builder's queue path from its `worktreePath` (authoritative, from the overview; not synthesized from workspace root). Read/write, `ensureExcludeEntry` on first write, `onDidChangeQueue` emitter, file watcher + debounce wiring, pending-count reads. Disposal-safe.
3. **`apps/vscode/src/comments/builder-review.ts`**: comment controller `codev-builder-review` ("Codev Builder Review"). `commentingRangeProvider` over diff-inject-registry files (comment mode only). Thread mount/reconcile against queue + registry state. Commands: submit-from-thread (queue add, thread flips to Preview, `canReply = false`), start-edit / save-edit / cancel-edit / delete (mirroring `plan-review.ts` #1055).
4. **`apps/vscode/src/review-queue/submit.ts`**: `codev.submitReview` implementation. Resolve target builder (active builder-diff file's owner; else, if exactly one builder has pending comments use it, else QuickPick among builders with non-empty queues). Package → open terminal via `openBuilderByRoleOrId` → multi-line inject → remove exactly the submitted comment ids from the queue (comments added mid-flight survive) → dispose their threads. `codev.discardReviewComments` with confirm lives here too.
5. **Status bar** (small module or in `extension.ts`): item `$(comment) Submit Review (N)`, command `codev.submitReview`, visible when the active editor is a builder-diff file whose builder has N > 0 pending comments; updates on queue events and active-editor changes.

Changes to existing files:

- **`apps/vscode/src/diff-inject-ref.ts`**: extend `LensDescriptor` with the underlying line range so the provider can build either command from one descriptor set (pure change, existing tests keep passing).
- **`apps/vscode/src/diff-inject-codelens.ts`**: provider reads `codev.diffCodelensMode`; comment mode emits the same anchors titled `Comment for Builder (…)` invoking `codev.commentForBuilder(builderId, fsPath, relPath, start, end)`; forward mode unchanged. Lens refresh on configuration change.
- **`apps/vscode/src/extension.ts`**: register new commands (`codev.commentForBuilder`, `codev.commentSelectionForBuilder`, `codev.submitReview`, `codev.discardReviewComments`, the two mode-toggle commands), sync the `codev.diffCodelensMode` context key, instantiate store + controller + status bar, activate the reconciler.
- **`apps/vscode/src/terminal-manager.ts`**: add `injectBuilderTextMultiline(builderId, text)` (bracketed-paste wrap; single-line callers untouched).
- **`apps/vscode/package.json`**: the setting; command declarations; `editor/title` toggle buttons; `editor/context` comment action (unconditional on mode, scoped by `codev.activeEditorIsBuilderFile`); `comments/*` menus scoped `commentController == codev-builder-review`; `commandPalette` scoping (toggles hidden, submit/discard visible).
- **`apps/vscode/CHANGELOG.md` + `docs/releases/UNRELEASED.md`**: user-facing entry, explicitly noting the #789 behavior change: the inject codelens is no longer shown by default (comment mode is the new default; forward mode is one title-bar toggle or context-menu click away; `Cmd/Ctrl+K B` unchanged).

Explicitly NOT changed: `codev.forwardToBuilder` and all #789 flows (they never touch the queue), spawn code, porch, Tower, the committed `.gitignore`, anything panel-related (#1049).

## Files to Change

- `apps/vscode/src/review-queue/queue.ts` (new, pure)
- `apps/vscode/src/review-queue/store.ts` (new)
- `apps/vscode/src/review-queue/submit.ts` (new)
- `apps/vscode/src/comments/builder-review.ts` (new)
- `apps/vscode/src/diff-inject-ref.ts` (extend `LensDescriptor`)
- `apps/vscode/src/diff-inject-codelens.ts` (mode-aware lenses)
- `apps/vscode/src/terminal-manager.ts` (multi-line inject)
- `apps/vscode/src/extension.ts` (wiring, commands, status bar, context key)
- `apps/vscode/package.json` (setting, commands, menus)
- `apps/vscode/src/__tests__/…` (new tests, see Test Plan)
- `apps/vscode/CHANGELOG.md`, `docs/releases/UNRELEASED.md`

## Risks & Alternatives Considered

- **Risk: bracketed-paste injection through the Tower PTY chain is unverified against the live Claude REPL.** Mitigation: spike this first in the implement phase against a real builder terminal; it is also the first item in the dev-approval script. Fallback if it fails: write the packaged message to a worktree-local file and inject a one-line reference to it (would be raised at the gate as a deviation, since the issue asks for the message itself in the buffer).
- **Risk: CodeLens absent in the multi-file `vscode.changes` editor** (pre-existing VSCode behavior). The comment entry inherits it. Context menu + gutter "+" work there; per-file diffs get the full surface. Documented, matches #789.
- **Risk: line drift.** Queued anchors go stale as the builder keeps committing. v1 clamps to document bounds on re-mount and does not verify content (no `diffContext`). The submit message carries the recorded range; a drifted range is still useful prose context for the builder.
- **Risk: controller overlap.** Worktree files under `codev/plans|specs/` are eligible for BOTH the existing plan-review controller and the new one when opened via a builder diff. Both inputs may appear on "+". Accepted for v1; noted for a follow-up if confusing.
- **Risk: `editor/title` button visibility on diff editors** keys off the context key (window-scoped), so it can appear on a non-diff editor focused while a builder file was last active. The context key already drives #789's menus with the same semantics; accepted.
- **Alternative rejected: workspaceState (Memento) persistence** instead of the worktree-local file. Loses cross-window sync, doesn't travel with the worktree, and dies with the window's storage; the file matches the per-builder state convention (`codev/state/<id>_thread.md`) and cleans up with `afx cleanup` for free.
- **Alternative rejected: extending #789's inject path to optionally queue.** The issue is explicit that the surfaces never merge state; a mode flag on one path invites exactly that.

## Test Plan

Unit (vitest, `apps/vscode/src/__tests__/`, mocked `vscode` where needed; pure modules tested directly):

- `queue.ts`: parse/serialize round-trip; tolerant parse (unknown fields, corrupt JSON reads as empty); add/edit/remove/clear; `buildSubmitMessage` exact-string format; `wrapBracketedPaste` (escapes + `\n`→`\r`); exclude-block merge idempotence (`.builder-*` glob present once).
- `store.ts` (real fs in temp dirs): create-on-first-write; per-builder isolation (two builders, no cross-talk); missing/removed worktree dir handled (stale-builder queue); `ensureExcludeEntry` appended exactly once; own-write echo suppression.
- Codelens: provider emits exactly one entry per anchor with the mode-matching title/command; flips on configuration change.
- Contributes assertions (pattern: `contributes-commands.test.ts`): setting declared with default `"comment"`; both context-menu actions present without mode conditions; toggle buttons' `when` clauses mutually exclusive; comment menus scoped to `codev-builder-review`.
- Submit: resolves the active builder; calls open-then-inject in order; clears only submitted ids; warning path when no terminal materializes.
- Reconciler: mounts threads on registry event; no duplicate threads across repeated events; disposes on delete; clamps out-of-bounds anchors.

Manual at dev-approval (the running-flow demonstration; UI change, so per the testing guide expectations the reviewer exercises the real flow):

1. Spawn/attach two builders; open both diffs. Add 3 comments to each via codelens, gutter "+", and context menu. Confirm queues in the two `.builders/<id>/.codev/pending-comments.json` files stay isolated.
2. `git status` inside a builder worktree: pending-comments file AND the `.builder-*` scaffolding files no longer show as untracked.
3. Toggle to forward mode: lens flips to `Forward to Builder`, gutter "+" disappears, context menu still shows both actions, `Cmd/Ctrl+K B` still injects. Forward clicks never appear in any queue. Toggle persists across reload.
4. Reload the window; re-open one builder's diff: queued threads re-mount at their anchors. The other builder's queue survives untouched.
5. Edit one queued comment, delete another; confirm file + status bar counter follow.
6. Submit builder A via the status-bar button, builder B via the palette command. Verify each PTY receives the packaged multi-line message in the prompt buffer WITHOUT submitting (bracketed-paste check), terminal is focused, and the queue + threads + counter clear after the corresponding submit.
7. Close builder A's terminal, submit again with a fresh comment: the open-terminal recovery flow kicks in (decision 4).
8. Second VSCode window on the same workspace: add a comment in window 1, see window 2's counter update within the watcher debounce.
9. `afx cleanup` a finished builder: its queue file disappears with the worktree; no stale UI remains.
