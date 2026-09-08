# PIR Plan: forward-hunk / feedback-hunk press erroring inside a visibly changed hunk

## Understanding

A reviewer presses "forward the change under the cursor" (deck `forward-hunk` /
`feedback-hunk`, or the in-editor commands) while the cursor sits visibly inside a green
changed region, and gets the status-bar error **"Codev: place the cursor in a changed
hunk."** Amr hit this live at the deck on 2026-08-20. This is an *observed failure*, not
speculative hardening.

Both press paths validate the cursor against `entry.hunks`:

- `codev.forwardCurrentHunkToBuilder` — `apps/vscode/src/extension.ts:1296-1300`
  (`entry.hunks.find(...)`, else the error at `:1298`).
- `hunkAnchor` — `apps/vscode/src/review-queue/feedback.ts:66-70` (the same
  `entry.hunks.find(...)`, same error at `:68`); `feedbackHunk` at `:126`.

`entry.hunks` is our own parse of `git diff -M --unified=3 <baseRef>` via `parseHunkRanges`
(`apps/vscode/src/diff-inject-ref.ts:94`). Two independent, source-verified mechanisms make a
press fail exactly where the cursor is visibly in a change:

**1. Stale snapshot.** `entry.hunks` is computed once, at diff-open / lens-registration time,
and never refreshed:

- `viewDiff` — `apps/vscode/src/commands/view-diff.ts:388-402`
- `registerFileInjectSession` — `apps/vscode/src/commands/view-diff.ts:467-478`

There is no `onDidChangeTextDocument` / `onDidSaveTextDocument` hook re-running the parse
(verified by grep — the only `parseHunkRanges` / `parseUnifiedDiff` callers are those two
open-time sites). When the builder keeps committing after the reviewer opens the diff, VS
Code recomputes its green regions live but our frozen ranges do not: the cursor lands in a
freshly-changed line that the stale ranges never recorded, `hunks.find` misses, error.

**2. Model split (rotation vs press).** The deck dials rotate with
`diff-next-hunk` / `diff-prev-hunk`, which the relay maps to VS Code's built-in
`workbench.action.compareEditor.nextChange` / `previousChange`
(`apps/vscode/src/command-relay.ts:54-55`) — the diff editor's own **live** change model. The
press verbs validate against **our git snapshot**. The two models disagree even with a fresh
parse in one documented case: a **deletion-only** change. VS Code's navigation stops on a pure
deletion, but `parseHunkRanges` yields *no* new-side range for it (no `+` lines — see the
function's own comment at `diff-inject-ref.ts:78-84`). Rotate onto a deletion, press → the
cursor is on a real change the press model cannot represent → guaranteed error, right where
the rotation just parked the reviewer.

**The keyboard path already solved a superset of this.** `codev.forwardCursorContextToBuilder`
(Cmd/Ctrl+K H, #1073) resolves through `resolveCursorRef` (`diff-inject-ref.ts:289`):
**symbol → hunk → file**. It never errors — a cursor in a symbol forwards the symbol; a cursor
in nothing forwards the file with an informational note (`extension.ts:1311-1329`). The two
press verbs are strictly narrower: hunk-only, and against a stale snapshot. The message is also
misleading (it instructs the reviewer to do what they have already done — the #1445/#1448/#1456
"instrument answering a narrower question than it names" principle): the real condition is "no
*recorded* new-side range contains this line", not "you are not in a changed hunk."

## Proposed Change

**Adopt the keyboard path's `resolveCursorRef` fallback in both press sites, but resolve it
against a *freshly re-parsed* hunk snapshot** — a combination of the architect's directions
**(a) degrade symbol→hunk→file** and **(b) refresh the snapshot**, behind one shared helper so
the two press sites and their mirror can never drift again.

Why this combination, argued:

- **(a) alone** turns the error into a fallback, but keeps consulting the *stale* git snapshot.
  A rotation onto a line the stale ranges never recorded, and that no forwardable symbol covers
  (e.g. a changed bare comment line), would silently fall back to forwarding the *whole file* —
  wrong scope, no signal. It masks staleness rather than removing it.
- **(b) alone** fixes staleness and boundary drift, but a **deletion-only** hunk *still* has no
  new-side range even in a fresh parse (documented above), so a rotate-to-deletion press would
  *still* error. (b) without a graceful fallback does not close the observed failure.
- **(a) + (b) together**: the fresh parse removes the staleness/boundary-drift class; the
  symbol→hunk→file degrade removes the deletion-only and no-representable-range class by
  forwarding *something sensible* instead of erroring. The press verbs become the fresh-hunk
  equivalent of the already-shipped Cmd+K H path — one resolution model across all three cursor
  entry points (deck press, feedback press, keyboard). This is the minimal change that makes the
  *observed* failure impossible while preserving press semantics: when a fresh hunk covers the
  cursor, the press still forwards exactly that hunk range.
- **(c) full unification** (drive `diff-next-hunk` from `entry.hunks`, or validate the press
  against the compare editor's live change model) is larger, touches navigation, and is made
  unnecessary *for the observed symptom* by (a)+(b). The two models still differ after this fix,
  but the disagreement can no longer surface as an error or a wrong-scope forward: a deletion the
  rotation stops on now degrades to the enclosing symbol or the file, not a red status bar. I
  recommend a follow-up issue if literal one-model unification is later wanted, and will name it
  as residual in the review rather than smuggling it into this fix.

### Shape of the fix

1. **Carry the git coordinates on the diff entry** so a press can re-run the parse.
   `DiffInjectSessionEntry` (`diff-inject-codelens.ts:60-69`) gains `baseRef: string` and
   `worktreePath: string`. Both are already in scope at every construction site (`viewDiff` has
   `wt` + `baseRef`; `registerFileInjectSession` has `args.worktreePath` + `args.baseRef`).
   Storing them (rather than re-deriving the worktree from `fsPath`/`relPath`) keeps the real
   identifiers on the record instead of a fragile suffix-strip.

2. **One shared resolver** — new `apps/vscode/src/commands/press-cursor-ref.ts` exporting
   `resolvePressCursorRef(entry, uri, cursorLine): Promise<CursorRef>`:
   - Re-parse hunks live: `git diff -M --unified=3 <entry.baseRef> -- <entry.relPath>` in
     `entry.worktreePath` → `parseHunkRanges`. On git failure, fall back to the frozen
     `entry.hunks` (non-fatal — never worse than today).
   - Fetch document symbols for `uri` (`vscode.executeDocumentSymbolProvider`, mapped via the
     existing `toSymbolNode`), empty on failure — same as `extension.ts:1317-1324`.
   - Return `resolveCursorRef(entry.relPath, symbols, freshHunks, cursorLine)` (the existing pure
     function — unchanged).

3. **`forwardCurrentHunkToBuilder`** (`extension.ts:1290-1303`) calls the helper: forward
   `resolved.refText`. On `kind === 'file'` (no symbol *and* no fresh hunk at the cursor) show an
   honest status note and still forward the file, matching Cmd+K H — no error.

4. **`hunkAnchor`** (`feedback.ts:61-72`) becomes async and calls the same helper:
   symbol/hunk → `lineRange = { start, end }`; file → `lineRange: null` (whole-file anchor) plus
   the honest note. `feedbackHunk` (`:126`) awaits it. Forward-mode and queue-mode parity is
   preserved because both still flow through `route(...)`.

5. **Message fix** — replace `"Codev: place the cursor in a changed hunk"` at both sites. It now
   fires only on the genuine no-change fallback, so it should say what actually happened, e.g.
   `"Codev: no changed lines at the cursor — forwarded the whole file (reopen the diff if it
   looks stale)."`

6. **`forwardCursorContextToBuilder`** (Cmd+K H, `extension.ts:1311-1329`) is refactored to reuse
   the shared helper too, so the keyboard path also gets the *fresh* hunk parse (it silently used
   the stale snapshot as well; its file-fallback merely hid it). Behavior-preserving, and it
   collapses the duplicated symbol-fetch block.

No `packages/types` and no Tower changes: `DiffInjectSessionEntry` is defined in
`apps/vscode/src/diff-inject-codelens.ts`, not in `@cluesmith/codev-types` (grep-confirmed). No
`apps/streamdeck` changes — the deck already sends the correct canonical verbs; all hunk logic is
host-side.

## Files to Change

- `apps/vscode/src/diff-inject-codelens.ts:60-69` — add `baseRef` + `worktreePath` to
  `DiffInjectSessionEntry`.
- `apps/vscode/src/commands/view-diff.ts:371-378, 395-402, 466, 475` — pass `baseRef` +
  `worktreePath` at the three entry-construction sites.
- `apps/vscode/src/commands/press-cursor-ref.ts` — **new.** `resolvePressCursorRef` (fresh git
  parse + symbols + `resolveCursorRef`).
- `apps/vscode/src/extension.ts:1290-1303` — `forwardCurrentHunkToBuilder` uses the helper;
  honest fallback message.
- `apps/vscode/src/extension.ts:1311-1329` — `forwardCursorContextToBuilder` reuses the helper
  (behavior-preserving; picks up the fresh parse).
- `apps/vscode/src/review-queue/feedback.ts:61-72, 126` — `hunkAnchor` async via the helper;
  honest fallback message.
- `apps/vscode/src/diff-inject-ref.ts` — no logic change expected; `resolveCursorRef` /
  `parseHunkRanges` are reused as-is.

## Risks & Alternatives Considered

- **Risk: degrading a hunk-press to a whole-file forward surprises the reviewer.** When neither a
  fresh hunk nor a forwardable symbol covers the cursor, the press forwards the whole file. This
  is exactly the shipped Cmd+K H behavior and is announced by the status note; with the fresh
  parse the fallback is now rare (only a cursor genuinely outside any change). *Alternative:*
  forward nothing and only show the message. Rejected — "do nothing" is what reads as broken at
  the deck; the architect explicitly endorsed degrade over error. Noted for the gate in case Amr
  prefers the stricter variant (a one-line switch).
- **Risk: a git call on every press adds latency.** It is a single-file `git diff` in a local
  worktree (fast); the architect's fix-direction #1 endorses exactly this ("Cheap: one file, one
  git call"). *Alternative:* debounce a refresh on save/change instead. Rejected as more moving
  parts for no observed benefit; press-time re-resolve is simplest and self-healing.
- **Risk: git failure at press time.** The helper falls back to the frozen `entry.hunks`, so the
  worst case is exactly today's behavior — never worse.
- **Residual (not fixed here):** rotation (compare-editor model) and press (git model) remain two
  models. After this fix the disagreement can no longer error or mis-scope; true single-model
  unification (direction c) is a larger, navigation-touching change I recommend as a follow-up
  issue, not part of an observed-bug fix.
- **Lens "wrong position" report:** the issue notes a "(lines N-M)" lens above a comment banner is
  likely the *symbol* lens behaving per API (`DocumentSymbol.range` includes leading comments),
  not the staleness defect. Out of scope for this fix; I will verify it is unchanged, not
  "corrected," so I do not chase a non-defect.

## Test Plan

Evidence bar (observed failure): reproduce the failure shape, show it gone, and regress the
working path.

- **Unit — `diff-inject-ref.test.ts` (extend):** a deletion-only diff → `parseHunkRanges` returns
  `[]`, and `resolveCursorRef` with those empty hunks resolves to the enclosing symbol (or file),
  never throws. Confirms the deletion-only class degrades rather than erroring.
- **Unit — new `press-cursor-ref.test.ts`:** mock git + `executeDocumentSymbolProvider`:
  1. fresh hunk covers the cursor where the *stale* `entry.hunks` did not → resolves to `hunk`
     with the fresh range (proves staleness fixed);
  2. deletion-only fresh diff → resolves to `symbol`/`file`, no throw (proves deletion class
     fixed);
  3. git failure → falls back to `entry.hunks` (non-fatal).
- **Unit — `feedback.test.ts` (extend):** `feedbackHunk` with a fresh hunk covering the cursor →
  enqueues/forwards that range (forward + queue modes); with no coverage → whole-file anchor +
  the honest status message, and the old `"place the cursor in a changed hunk"` string is never
  emitted.
- **Manual (dev-approval, in the running worktree):**
  - *Staleness repro:* open a builder diff, make the builder commit more lines so positions
    shift, rotate onto a change with the dial, press forward-hunk → previously errored; now
    forwards the correct range.
  - *Deletion-only repro:* rotate onto a pure deletion, press → previously errored; now degrades
    (symbol or file) with the honest note.
  - *Regression:* press inside an ordinary modification still forwards the exact hunk range; the
    feedback-queue press still enqueues the same range.
- **Physical deck (route out):** the Stream Deck architect offered consumer-stakeholder
  verification against the physical deck at dev-approval. I can drive everything above from the
  in-editor commands and unit mocks from the builder shell; the physical dial-press confirmation
  is the part I cannot drive here — route to the streamdeck architect / Amr.
- **Full check set before PR:** `pnpm --filter codev-vscode test` and
  `check-types` (tsc) from the worktree — vitest ignores type errors, and the entry now carries
  new required fields, so tsc is the real guard on every construction site.
