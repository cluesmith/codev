# bugfix-1883 thread — mobile autocomplete re-inserts fragments

## 2026-11-09 — investigate

**Reproduced** in headless Chromium against the real xterm.js 5.5 bundle. The keyboard edits
were driven through CDP's real IME pipeline (`Input.imeSetComposition` with replacement
ranges, `Input.insertText`, each preceded by `keydown` 229 the way Chrome Android sends them).
The harness is scratch-only, not committed.

| Scenario (Gboard-style op) | textarea ends as | stock xterm sends to the PTY |
|---|---|---|
| suggestion tapped while the partial word is still composing | `under normal circumstances ` | correct |
| IME recomposes an already-committed word (`ciecu` → `circumstances`) | `under normal circumstances ` | `under normal ciecumstances ` |
| smart punctuation: trailing space → `. ` | `since we last spoke. ` | `since we last spoke since we last spoke. ` |
| autocorrect of the last word outside a composition (`afain` → `again`) | `check again. ` | `check afain` + whole value / lost edit (timing-dependent) |

Row 3 is sample 3 from the issue in miniature.

**Root cause.** xterm.js keeps everything typed since the last Enter in its hidden textarea. The
mobile IME edits that text in place, because it is the IME's context for autocomplete. All three of xterm's
textarea-derived emitters assume the textarea only grows by appends:

1. `CompositionHelper._handleAnyTextareaChanges` (keydown 229 *outside* a composition) sends
   `newValue.replace(oldValue, '')`. After an in-place edit, `oldValue` is no longer a
   substring, so the **entire textarea is resent**; an equal-length change also resends the whole
   value. This is the repeated clause. It is not the compositionend path the issue guessed.
2. `CompositionHelper._finalizeComposition` sends `value.substring(start)` with `start`
   recorded at the *end* of the value on `compositionstart`. When the IME's composing region
   begins earlier (recomposition), the result is a **misaligned tail** (`…ciecu` + `mstances`).
3. `Terminal._inputEvent` sends `ev.data` as an append.

None of these can retract characters already sent. The #253/#517 guard only drops exact repeats.

**Consequence for the prescribed fix.** A fix scoped to the composition (`compositionend`)
leaves path 1 untouched, so samples 1 and 3 (the clause repeats) would still happen. The fix has
to treat *every* IME-driven textarea edit as a replace, not only compositions.

**Fix shape (prototyped in scratch, all 5 scenarios produce a PTY line equal to the textarea):**
on touch devices (`pointer: coarse`) the dashboard owns IME text input.
- Stop xterm's textarea IME listeners from running: return `false` from the custom key handler
  for keydown 229, and `stopPropagation` on the container's capture phase for
  `compositionstart/update/end` and `input`. xterm then only sees real keys (Enter, Backspace,
  arrows, hardware keyboard) and paste.
- On each `input` event, send `reconcileComposition(mirror, textarea.value)`: N × DEL for the
  diverging tail, then the new text. Route it through `term.input(edit, true)` so
  scroll-to-bottom, the sticky-modifier path and `onData` all stay single-sourced.
- Mirror bookkeeping: a pass-through key or paste, or an out-of-band textarea write (xterm
  clears the textarea on Enter/Ctrl-C/paste, and its context-menu handler puts the selection
  there), rebases the mirror so no DEL can reach text the PTY did not get from the textarea.
- The exact-duplicate guard stays as it is (desktop CJK and the #517 case).

Upstream context (corrected after I read the diff): xterm.js PR #5704 (open, changes
requested) hits the same failure family for WKWebView Korean IME. It patches xterm internals to
buffer `insertReplacementText`, and it suppresses `_handleAnyTextareaChanges` during that
replacement composition. It is a different mechanism from ours and not a precedent for our
design. My first message to the architect said otherwise, based on an unverified search
summary; I corrected it.

**Gotcha found while prototyping:** with xterm's composition listeners bypassed, a **0×0**
textarea (xterm's CSS default before the first render) makes Blink collapse the caret to 0 on
commit, so the IME inserts at the start. Once xterm has rendered, `_syncTextArea` sizes it to
one cell and the problem goes away. The real dashboard always renders, but the browser test must
render too, and the fix should make sure the textarea is never 0×0 on touch.

**Deviation from the prescription:** the sync is live, per `input` event, not deferred to
`compositionend`. Deferring would require bypassing xterm's composition overlay, so the user
would type blind until the word ends. Live sync shows the text in the composer as it is typed,
the same as on desktop. Flagged to the architect.

**Scope:** ~60 LOC pure module + ~50 LOC wiring in `Terminal.tsx`, plus tests. Within BUGFIX.

## 2026-11-09 — fix

The architect approved the extended fix with four conditions:

1. Touch-only.
2. Tests for Enter, Backspace, arrows, sticky Ctrl-C, paste, and an iPad hardware keyboard.
3. A desync fails loud and resyncs from `textarea.value`.
4. A corrective comment on #1883 (posted).

- `apps/web/src/lib/imeInput.ts`:
  - `reconcileComposition` (pure).
  - `TextareaMirror`: sync/rebase, with a `floor` so no DEL ever reaches text the PTY didn't get from the textarea.
  - `attachImeInput`: shields xterm's composition/input listeners, sends a diff on each `input` event, and runs the loud resync with `console.error('[Terminal IME #1883] …')` on beforeinput mismatch or undelivered edit.
  - Rebases silently on paste-insert, context menu and foreign input.
- `Terminal.tsx`: bridge only when `pointer: coarse`. It owns keydown 229 through the custom key handler. Its edits go out through `term.input`, so they get scroll-to-bottom and the sticky modifiers, and they bypass the exact-dup guard (otherwise "ll" typed fast would drop). Every other `onData` payload rebases the mirror.
- `VirtualKeyboard.tsx`: `onKeySent` for Esc/Tab, which go straight to the WebSocket.
- Surprise: xterm's paste handler does not `preventDefault`, so the browser *also* inserts the clipboard into the textarea (`insertFromPaste`). The bridge must not resend it.
- Tests:
  - unit: 23;
  - component (jsdom): 11, of which 9 fail on the pre-fix `Terminal.tsx` and 2 are must-not-change controls (iPad hardware keyboard, desktop);
  - Playwright `apps/web/playwright/ime-replace.spec.ts`: 7, with the real xterm and the real Terminal through CDP IME. 5 failed before the fix with the exact sample signatures. Stable across 3 repeats.
  - CI: new `web-browser` job.
- Environment note: Node 26's built-in `localStorage` shadows jsdom's and breaks every Terminal component test locally (pre-existing, not ours). Run with `NODE_OPTIONS=--no-experimental-webstorage`. CI uses Node 20.
- Pre-existing, out of scope: on touch devices the #517 exact-dup guard (always on for `pointer: coarse`) would drop a repeated hardware-keyboard key within 150 ms (iPad key repeat). To be raised as a separate issue.
