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

## 2026-11-09 — PR review (CMAP)

- First round: gemini APPROVE, codex APPROVE, claude COMMENT. Claude verified each xterm assumption against the installed 5.5 source and raised five points. All fixed or documented:
  1. **xterm clears the textarea on blur** (`_handleTextAreaBlur`), so every keyboard dismissal on a phone would have tripped the desync alarm. The bridge now follows the clear with a blur listener on the textarea. It is registered after xterm's, so it runs after the clear. The Playwright guard fails without it (`expectedLength: 6, actualLength: 0`).
  2. **A sub-floor replace diverged silently.** Example: paste `teh`, autocorrect to `the `, PTY shows `tehthe `. The mirror now has two floors:
     - `replaceFloor`: a replace can't reach past other input;
     - `deleteFloor`: text that never reached the PTY can't be deleted.

     A paste is *accepted* as already on the PTY, last line only, so autocorrecting it replaces it. A replace that does reach back past other input now fails loud.
  3. **Soft backspace had no test.** It also turned up a real bug: with the single floor, a soft backspace right after any foreign input (a virtual Tab, an arrow) sent nothing. The delete-only case now sends one DEL per removed code point, bounded only by `deleteFloor`. Guarded at the unit, component and Playwright levels (`execCommand('delete')` after keydown 229).
  4. iOS/WebKit is the least-verified path. Documented in the PR; the owner's real-device check is the real acceptance test.
  5. The resync log now carries lengths, never the user's command line.
- Second round, on d26a58fd1: gemini APPROVE, codex APPROVE, claude APPROVE. Claude's non-blocking points:
  1. **Terminal replies count as foreign input.** In steady state xterm sends DA/CPR/DECRPM/OSC replies through `onData` (`wasUserInput=false`, which the public API doesn't expose), and the web client filters them only during `rc.initialPhase`. A reply mid-typing raises `replaceFloor`. The next autocorrect that reaches back then fails loud and leaves a duplicate for that one replace. Not silent, and far narrower than the original bug. The fix needs the reply table, which today lives only server-side (`packages/codev/src/terminal/terminal-replies.ts`; the client can't import it). That's a scope call, taken to the architect at the PR gate.
  2. Typing during a reconnect logs "edit not delivered" per keystroke. Kept: those keystrokes really are dropped, and the condition is "never drop silently".
  3. CJK IME on touch now streams kana, then DELs and the kanji, instead of buffering to `compositionend`. Converges in a line editor; untested on a real device.
  4. TDZ hazard: `imeBridge` was a `const` used in the key handler before its declaration. Fixed by hoisting it as a `let`.
  5. A real-phone check is still the acceptance gate (iOS especially).

## 2026-11-09 — integration review (architect)

Architect's 3-way: gemini APPROVE, codex + claude REQUEST_CHANGES. The architect agreed and asked for three changes, which are done:

1. **`noteForeignInput()` only for input actually sent.** It now runs after every drop point in `onData`: socket closed, the #517 dedup, the initial-phase filter, and the Cmd-C/Cmd-V sticky returns. It also skips payloads that are only terminal replies, using the three inline regexes, now shared as `stripTerminalReplies` with the initial-phase filter. Codex had traced a filtered DA reply during replay raising the floor. The jsdom tests for a CPR reply in steady state and a DA reply during replay both fail on ae8f93cfd. A Playwright test drives a real `ESC[6n` through the fake PTY and has real xterm answer it. Moving the table into codev-types is issue #1885.
2. **No silent detach.** Cut, drag, drop, yank and undo/redo now sync like any other edit. A cut of sent text deletes it; a mid-line cut reaching back past other input fails loud. `NOT_TYPED` is gone; only paste stays special.
3. **The Playwright harness is type-checked:** `apps/web/tsconfig.json` include, `pnpm check-types`, and a step in the `web-browser` job. Same precedent as artifact-canvas.

Smaller items:
- A closed-socket edit now logs `console.warn`, not `console.error`.
- CJK behaviour on touch is stated in the PR body.
- `arch.md` notes the invariant that every non-`onData` PTY writer must call `noteForeignInput()`.
- `onKeySent` is a `useCallback`.
- Filed issue #1886: the touch dedup drops repeated hardware keys.

Test-harness fixes found along the way:
- The phone `afterEach` now unmounts before asserting. A failing assertion there had skipped `cleanup()` and cascaded into unrelated failures, which made 7 tests look broken on the old code when only 2 were.
- The desktop Playwright control flaked under 3× load. A keydown-229 space on desktop reaches stock xterm only through a `setTimeout(0)` diff, and real desktop keyboards don't send spaces that way. It now types spaces as real keys.
- One unexplained `cdpSession.send: Target page… has been closed` on sample 2 in a single run. It has not recurred in 5 solo runs plus two full 3× runs.
- CMAP after the integration fixes (200fc88ce): gemini APPROVE, claude APPROVE, codex REQUEST_CHANGES. Codex raised four points:
  1. *Native paste ordering*: codex claimed the browser's default paste insert runs before the queued microtask, so the rebase would clobber `accept()`. **Disproved in Chromium.** A new Playwright test does a real native paste: clipboard permission, plus a CDP key event carrying the `paste` editing command. It fires a trusted `paste`, then the browser's own `insertFromPaste`. The test passes with no alarm, and autocorrecting the pasted word replaces it. With the rebase deferred to `setTimeout` (codex's ordering), the same test fails with exactly the predicted alarms, so it would catch that ordering. A microtask checkpoint runs after each listener callback of a browser-dispatched event (HTML spec), so this should hold on WebKit too; it can't be verified in CI, which runs Chromium only.
  2. *A sticky Cmd-C/Cmd-V swallowing a soft-keyboard char*: **real.** The mirror counted the char as sent, so backspacing it sent a DEL into real text. New `noteSwallowedEdit()` (detach) covers a char swallowed or turned into a control char. Nothing typed before a control char can be deleted or replaced, because the line state after it is unknown. Component tests for Cmd-C and Cmd-V fail on 200fc88ce.
  3. *Virtual Esc/Tab notifying on a closed socket*: **real.** Claude found it too. `sendRawKey` now returns whether it sent, and `onKeySent` is gated on that. The component test fails on 200fc88ce.
  4. *Bulk deletes crossing `replaceFloor`*: **real.** Only a backspace-type delete (`deleteContentBackward`/`deleteWordBackward`/…) may delete past other input. A cut, drag or undo that would fails loud and deletes only what was sent since.
- Claude (APPROVE), non-blocking: on the alternate screen (vim normal mode, less, fzf), streamed composing text and its retracting DELs act as commands. That needs a follow-up decision, e.g. suppressing the bridge when `term.buffer.active.type === 'alternate'`. Not changed here.
- CMAP round 4 on 6a7d58862: gemini APPROVE, claude APPROVE, codex REQUEST_CHANGES. Codex's only blocker is the real-device check (the owner's acceptance gate); it found no code issue. Codex and claude both asked for the alternate-screen and CJK behaviour to be tracked: filed as issue #1887. Architect pinged; the pr gate is pending human approval.

## 2026-11-09 — issue #1886, second PR from this worktree

PR #1884 merged as 9c51d4aa4. The owner (via the architect) asked me to take issue #1886 here, on branch `builder/bugfix-1886-touch-dedup` from origin/main. There is no porch project for it: it is a second PR from this worktree, at the architect's direction.

- **Root cause.** #517 made the 150ms exact-duplicate guard always on for `(pointer: coarse)`, against xterm's multiple textarea emitters double-firing on soft-keyboard input. Since PR #1884 the IME bridge keeps soft-keyboard input away from those emitters on touch: compositions are shielded, keydown 229 is owned, and the bridge's own edits bypass the guard. So on touch the guard only saw hardware keys, paste and replies, and only dropped real repeats. The #517 comment's tradeoff note ("repeat rates >250ms are above the 150ms window") confused the initial repeat delay with the repeat interval, which is ~30-80ms.
- **Fix.** The guard is composition-window only. The composition arm, which covers desktop CJK and the #517 double period, is unchanged.
- **Tests, failing-first.** Three jsdom tests on a touch device: fast double letters, a held Backspace/arrow, Enter twice. Plus one Playwright test with real hardware keydowns on an emulated touch device: `hello`, 3 auto-repeat Backspaces, `p!`. On main the line came out `help!`, with the second `l` and two of the three repeats dropped. With the fix it is `hep!` and the frames are exact, which also shows the IME bridge doesn't double-send hardware keys. The #517 "extra period" test moved to the composition suite; the old touch tests that pinned dropping "ll" were replaced.
- Adjacent: none found that needs fixing. Not verifiable here: whether an iOS soft keyboard ever sends letters as real keydowns that it doesn't let xterm cancel. That needs a real device.
