# PR review, iteration 1: rebuttals and changes

Codex: REQUEST_CHANGES. Claude: APPROVE, with four non-blocking findings. The architect ruled on the
open points at 16:39Z.

## Codex

1. **The dormant no-workspace window is a deviation awaiting acceptance.** **Rebutted, with the
   architect's agreement.**
   - The deviation is the architect's option-A ruling, which keeps issue #1144's dormant-window
     inertness.
   - The owner decides it at the `pr` gate, which is the human acceptance step the review names.
   - The review and the PR body both record it as *Partly met*. No code change.
2. **The `vscode-test` Electron suite was never run.** **Not run, by the architect's ruling (A).**
   - It is a pre-existing suite in `apps/vscode/src/test/`, and this PR does not touch it.
   - No workflow runs it on main.
   - Open issue #1765 says it cannot launch recent VS Code on macOS.
   - Running it here would also download VS Code and load the extension against the owner's live
     Tower (`codev.towerPort` 4100, `autoStartTower` on).

   The spec's "full `apps/vscode` suites" criterion is met by the vitest suite. The review and the
   PR say exactly that.
3. **The branch is 71 commits behind `origin/main`, with overlapping files and version 3.3.7.**
   **Changed.**
   - Merged in merge commit `f331978a7`, with no rebase or force-push.
   - The two conflicts, `apps/vscode/CHANGELOG.md` and `lessons-learned.md`, kept both sides.
   - The extension is now 3.3.8.
   - After the merge:
     - type-check is clean (host and webview);
     - lint shows the 2 existing warnings;
     - apps/vscode has 1820 tests passing, with 1 Windows-only skip;
     - workspace-views passes 197.
   - The one failure after the merge was a source-shape test pinning the old optional call, which
     claude's finding 3 changed. It was updated in `98a7c2c17`.
   - The vsix is rebuilt at 3.3.8 for the final `verify arrange`.

## Claude

1. **`unanswered()` forwards a raw transport message to the Decisions webview.** **Changed**
   (`69aa91e3d`).
   - Only the client's two fixed texts pass through: *Tower not running* and *Request timeout*.
   - Anything else reads *Could not reach Tower: the connection failed*.
   - A test feeds a transport error naming `127.0.0.1:4100` and a URL through `read`, `rule` and
     `image`. It asserts none of them reaches a message.
2. **Four ~9k-line `dashboard-snapshot.json` files are evidence bloat.** **Changed, more widely,
   by the architect's ruling.**
   - All rendered evidence left the PR's tree for the never-merged orphan branch
     `evidence/spir-1963` (`1d5cc1e40`): screenshots, results JSON, the snapshots and the spike's
     PNGs.
   - The PR branch keeps `verification.md`, which indexes 127/127 checks with SHA permalinks
     (`03f99d9cf`).
   - The PR went from +66,052 lines in 299 files to +28,673 in 165.
3. **`openArchitect`'s `terminalManager?.` leaves "the user was told why" implicit.** **Changed**
   (`69aa91e3d`, `98a7c2c17`).
   - Without a terminal manager it throws, so arrange stops with *Arrange Cockpit stopped: the
     terminal manager is not running*.
   - The wiring test pins that.
4. **`SingleWebviewPanel.dispose()` leaves `adopt()`'s subscriptions.** **Changed**
   (`69aa91e3d`).
   - `dispose()` now disposes the open panel's listeners, as closing the panel does.
   - A Work panel test shows the view-state listener gone after `dispose()`. It failed on the
     previous file.
5. **Unverified test results, and `origin/main` past the local tip.** Both are covered by codex
   point 3 above.
