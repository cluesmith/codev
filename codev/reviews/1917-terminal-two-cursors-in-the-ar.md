# PIR Review: Two cursors in the architect terminal on Windows (Spec 1658 M2)

Fixes #1917

## Summary

On native Windows the dashboard terminal showed claude's own drawn cursor and a second block
cursor. Neither suspect in the issue was the cause: the ConPTY stream hides the cursor correctly
and xterm.js honours it. The cause was Tower's viewer-attach snapshot. `SessionScreen.serialize()`
uses `@xterm/addon-serialize`, which does not write cursor visibility (DECTCEM), so every dashboard
attach (opening it, a reload, a tab switch, a reconnect) re-showed a cursor claude had hidden.
Under ConPTY that cursor is parked at the end of the last row, away from claude's drawn cursor. On
macOS it sits on claude's cursor, which hid the same bug there. `serialize()` now appends
`?25l` or `?25h` from the mirror's own state.

Why it came and went: three things had to be true at once. Claude had to be drawing its own
cursor; that mode comes and goes and its trigger is still unknown (M15). The dashboard had to
attach while it was in that mode. And on Windows the hidden cursor had to be parked away from
claude's. The stray cursor followed ConPTY's repaints (the end of the last row when idle, just past
the last cell drawn while typing). It stayed until claude next toggled visibility, because ConPTY
only emits DECTCEM when visibility changes.

## Files Changed

- `packages/codev/src/terminal/session-screen.ts` (+27 / -1)
- `packages/codev/src/terminal/__tests__/session-screen-serialize.test.ts` (+81 / -0)
- `codev/reviews/1658-windows-native-non-wsl-support.md` (+13 / -0): the M2 entry records the cause
- `codev/resources/arch.md` (+1 / -1)
- `codev/resources/lessons-learned.md` (+2 / -0)
- `codev/plans/1917-terminal-two-cursors-in-the-ar.md` (+130 / -0)
- `codev/reviews/1917-terminal-two-cursors-in-the-ar.md` (this file)
- `codev/state/pir-1917_thread.md` (+46 / -0)
- `codev/projects/1917-terminal-two-cursors-in-the-ar/status.yaml` (porch)

## Commits

- `ac5acbf5f` [PIR #1917] Plan draft
- `9512d4b7e` [PIR #1917] Carry cursor visibility in the attach snapshot
- `743d7a857` [PIR #1917] Record the M2 cause in the 1658 review; builder thread
- `43b0aa855` [PIR #1917] Thread: Tower incident, holding at the tests check
- `d604e1b6e` [PIR #1917] Thread: rebase onto #1926, tests-check timeout, orphan shellpers
- plus porch state commits and two merges of `main` (`5bce03080`, `c6c534051`), both without conflicts

## Test Results

- Build: ✓ pass (porch `build` check)
- Full `packages/codev` suite: ✓ pass (porch `tests` check, 131.6s, on the merged head; the live
  Tower, PID 39120, was the same before and after)
- 7 new tests in `session-screen-serialize.test.ts`. The ConPTY ghost-idle, macOS ghost and
  reused-client tests fail when the append is disabled and pass with it. The other two pin the
  private field and check that a visible cursor stays visible. Two more, added after the
  consultation, cover the empty-snapshot canary and the `undefined` fallback.
- Targeted suites after each merge of `main`: session-screen*, pty-session-replay-snapshot,
  attach-replay, pty-terminal-type, render-gate, spec-1658-conpty-gate-replay: 161/161.
- Windows CI on the branch: run 44208299681 green (Node 22 and 24). The PR head has its own
  dispatch: https://github.com/cluesmith/codev/actions/runs/44263468954
- Manual: the owner approved the running code at `dev-approval`.

## Architecture Updates

COLD `codev/resources/arch.md`: one sentence added to the PIR #1354 "Viewer attach serves the
mirror's serialized snapshot" paragraph. It says the addon does not serialize DECTCEM, that
`serialize()` appends it from the mirror, and that anything else a viewer must see after a
reconnect has to be checked against what the addon serializes. Nothing goes in the HOT tier:
this is subsystem detail, not a cross-cutting rule.

## Lessons Learned Updates

COLD `codev/resources/lessons-learned.md`, Debugging and Root Cause Analysis: a symptom seen on
one platform can come from a platform-neutral bug that another platform masks. Trace the state
hop by hop on a captured stream before blaming the platform layer, and check what a serializer
drops, not only what it round-trips (the #1354 round-trip suite compared cells and cursor
position, so a lost mode was invisible to it).

## Things to Look At During PR Review

- **Consultation (single pass): codex APPROVE, claude COMMENT, gemini skipped (agy CLI not installed).** How each of claude's points was handled:
  1. *The `empty-snapshot` desync canary had become unreachable* (an empty screen serialized to `[?25h`). **Fixed:** `serialize()` passes an empty addon payload through untouched. The new test fails without the guard.
  2. *A `Co-Authored-By` trailer might survive on the plan commit.* **Already resolved:** the commit was rewritten without it on the architect's order, and `git log <merge-base>..HEAD` shows no attribution trailer. The thread line the reviewer read predated that.
  3. *The `undefined` fallback was untested.* **Fixed:** a getter-spy test asserts that the snapshot is the plain addon output.
  4. *The normal-buffer delta-resume path carries no DECTCEM.* **Documented** in `arch.md`; pre-existing and narrow (cursor-hiding apps are almost always alt-screen, which takes the snapshot route).
  5. *A mirror seeded after a Tower restart can report the cursor visible.* **Documented** with item 4: the same behaviour as before the fix, self-healing on the next toggle.

- **Private field.** `cursorHidden` reads `term._core.coreService.isCursorHidden`, because
  `@xterm/headless` 6.0 has no public visibility field. If the field is missing it returns
  `undefined` and `serialize()` falls back to the old output. A test pins the field, so an
  upgrade that removes it fails CI. I rejected the alternative, a public parser hook on
  `CSI ? h/l`, because it would duplicate the emulator's state and every reset path (RIS,
  DECSTR, multi-parameter DECSET).
- **`?25h` is always sent for a visible cursor.** The dashboard writes the replay into its
  existing xterm instance on reconnect, so a hidden state from before the disconnect could
  otherwise survive. It changes nothing for a fresh terminal (visible is the default).
- **POSIX.** Live rendering is untouched. After a reconnect, a hidden cursor now stays hidden on
  macOS and Linux too. For claude's software cursor the screen looks the same (claude's cell is
  still drawn). For full-screen apps that hide the cursor (vim, less) a stray cursor no longer
  appears after a reconnect.
- **Not addressed:** cursor style (DECSCUSR) is also not serialized. Nothing has been seen to depend on it.
- **Still unknown:** what makes claude switch into drawing its own cursor (M15). It no longer
  matters for M2, which this PR fixes whichever mode claude is in.
- **Process note.** At 00:19Z on 2026-11-18 a local full-suite run from this worktree stopped the
  live Tower (attributed to `launchers.windows.test.ts`; #1926 added a guard). Two test-orphan
  shellpers from this worktree's `dist` are still running, left alone on the architect's order:
  PID 20476 (`bash -c "node dev-server.cjs"` in `~/.agent-farm/test-workspaces/codev-1658-p6-EOuHsQ/ws`)
  and PID 41076 (`cmd.exe /d /q /k "echo MARK-1658-A"`). Details are in the thread.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-1917 → **View Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-1917`
- **What to verify**:
  - On Windows, with claude idle and drawing its own cursor (an inverse cell over the dim
    suggestion), reload the dashboard and switch tabs away and back: one cursor each time, idle
    and while typing. If claude shows only the plain dim hint, there was one cursor before the
    fix too, so this check proves nothing; the ghost-idle unit test covers that case.
  - On macOS, the same reload: one cursor, as before.
  - `npx vitest run src/terminal/__tests__/session-screen-serialize` in `packages/codev`.

## Flaky Tests

Under full-suite load on the owner's Windows machine, before #1926: `cold-tier-materialization`
(2) and `update.test` bootstrap-docs hint (4) failed on EPERM removing their temp dirs, and
`bugfix-1691-tower-start-surface-refusal` failed on its "No output was captured" assertion.
One run also failed `agy-auth-cache` "keeps spawning per call when the cache is disabled"
(EPERM). The first Windows CI run's Node 22 job hit `Worker exited unexpectedly` with every test
passing, and passed on re-run. These are tracked in #1923 and #1926. None reproduced on the
merged head.
