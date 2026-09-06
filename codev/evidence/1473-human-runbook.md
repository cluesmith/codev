# PIR #1473 — Human Runbook

Manual checks that need a real harness, a real browser and a real pair of hands. Everything
else for this issue is already automated in `codev/evidence/1473-dev-approval-transcript.txt`.

Budget about 30 minutes. Follow the steps in order; step 1a gates the rest.

**Revision 3.** Steps 1a, 2, 3, 4a and 4b are banked. **Only 1b is outstanding.** Its two
earlier failures were both in this harness, not in your settings: the probe was missing from
the sidebar (rev 2), and then listed but unclickable (rev 3), because listing and clicking read
different sources and the probe's directory name has to satisfy both. `h1473 vscode-check` now
proves the click resolves before you go looking for it in the UI.

---

## Before you start

**Do not touch these.** Every command below runs against a throwaway Tower on port **14793**
with its own database and its own workspace.

- The live Tower on port **4100**.
- The two running builders on it.
- Nothing here uses `afx`. Do not substitute `afx send` / `afx inbox` — they always talk to 4100.
- Do not use `afx attach` at any point. It bypasses the code under test entirely, logs nothing,
  and would read as a pass when nothing was measured.

**You need:** this worktree, a browser, VS Code, and real `claude` and `codex` binaries on your
PATH. Run every command from
`/home/user/code/codev_root/codev/.builders/pir-1473/packages/codev`.

**Shorthand used below.** Paste this once into *each* terminal you open (it works in bash and
zsh alike):

```
h1473() { node --experimental-strip-types scripts/pir-1473-human-harness.mts "$@"; }
```

---

## Setup

1. Build the branch.

   ```
   pnpm --filter @cluesmith/codev build
   ```

   Expected: exits 0.

2. Start the isolated environment. Leave this terminal open and visible — the step 1 trace
   prints here.

   ```
   h1473 up --harness claude
   ```

   Expected: a `READY` banner giving a `Browser:` URL, VS Code settings, a terminal id, and an
   example `[input-signal …]` line. The line above it must say
   `Live Tower on 4100: LISTENING — it will not be touched`.
   If it says `Port 14793 is already in use`, something else owns the port — free it and retry.

3. Open a **second** terminal in the same directory. Every `send` / `inbox` / `calibrate` /
   `vscode-check` / `down` command below runs there.

4. Open the `Browser:` URL. Click the **`builder-pir-1473`** terminal.

   Expected: `claude` booting, then an empty composer. A second terminal named `architect` also
   exists — ignore it, it is created automatically when the workspace activates.

---

## Step 1 — Reply traffic (run this first)

If this fails, stop. Nothing downstream is trustworthy.

### 1a — Browser

1. Click once into the `builder-pir-1473` composer so it has focus.

2. **Take your hands off the keyboard and off the mouse for 60 seconds.** Watch terminal 1.

3. Read every `[input-signal …]` line printed during those 60 seconds.

   **PASS** — every line reads `survived=<NOTHING>`, and the `inputSeq=N→M` on each has `N == M`.
   Zero lines at all is also a pass.

   ```
   [input-signal 3c09c9db] raw="\e[?1;2c" stripped="\e[?1;2c" survived=<NOTHING> inputSeq=0→0
   ```

   **FAIL** — any line with a non-empty `survived`, or any line whose `inputSeq` advances.

   ```
   [input-signal 3c09c9db] raw="\e[>0;276;0c" stripped=<none> survived="\e[>0;276;0c" inputSeq=4→17
   ```

4. If it failed, copy the failing lines verbatim. The `raw=` field is the finding — it names the
   exact reply the filter does not recognize.

5. Confirm the trace is live rather than silent: type one character into the composer, then
   backspace it.

   Expected: a line with `survived="a"` and `inputSeq` advancing by 1. If nothing prints at all,
   the 60-second pass above was vacuous — the trace is not wired up. Report that, not a pass.

### 1b — VS Code integrated terminal

A different xterm build, and the one surface whose reply set may differ.

1. Before touching VS Code, in terminal 2:

   ```
   h1473 vscode-check
   ```

   Expected, on the last two lines:

   ```
   PASS: resolved to builder "builder-pir-1473" terminal <id>.
   Clicking the row in the VS Code Agents view will open that session.
   ```

   If it says `FAIL`, stop and report it — VS Code cannot work until this passes, and the
   message names which of the two lookups broke. Do not go hunting in the UI.

2. In VS Code, open User settings (JSON) and set both:

   ```json
   "codev.towerPort": 14793,
   "codev.workspacePath": "/home/user/.agent-farm/test-workspaces/pir1473-human/ws"
   ```

3. Reload the window.

   Expected: the Codev **Status** view shows `Tower: connected`.

4. Open the **Agents** view.

   Expected: one entry, labelled `#1473`, grouped under a heading of **`UNKNOWN`**. That
   grouping is expected and is not a fault: the group is the porch phase, and this throwaway
   workspace has no porch project.

5. Click it.

   Expected: a VS Code integrated terminal opens on the same session the browser shows. Type a
   character into its composer and backspace it.

   Expected: two new `[input-signal …]` lines in terminal 1, one with `survived="a"` and one
   with `survived="\x7f"`. If nothing prints, you are attached to a different session — stop and
   report it rather than proceeding.

   If instead you get "**…terminal isn't available yet**", step 1 was not run or has since
   changed — re-run `h1473 vscode-check` and report its output.

6. Click into that composer, then **take your hands off the keyboard and mouse for 60 seconds.**

   **PASS** — every `[input-signal …]` line in that window reads `survived=<NOTHING>`. Zero
   lines is also a pass.

   **FAIL** — any line with a non-empty `survived`. Copy the `raw=` fields verbatim.

7. **Put the settings back** when you are done: `"codev.towerPort": 4100` and
   `"codev.workspacePath": ""`. Reload the window.

> The browser at the `Browser:` URL renders the same session, but it is the SAME xterm build as
> 1a — it does **not** substitute for this step. If VS Code cannot be made to attach, report 1b
> as blocked rather than passed.

---

## Step 2 — The 300 ms calibration

1. In terminal 2:

   ```
   h1473 calibrate --harness claude
   ```

2. When it asks, confirm the composer is booted and empty, then press Enter.

   Expected: `sampled 40/40`, then a percentile table and a `VERDICT:` line. It types single
   characters and backspaces them; it never presses Enter, so nothing is submitted.

3. Read the verdict line. It is one of exactly three:

   - `ROLLBACK CRITERION DID NOT FIRE.` — p99 is within the 300 ms budget. Nothing to do.
   - `ROLLBACK CRITERION FIRED.` — it names the new constant to use. Report it.
   - `ROLLBACK CRITERION FIRED, AND A BIGGER CONSTANT IS THE WRONG FIX.` — this re-opens the
     plan. Report it and stop; do not change the constant.

4. Repeat against codex. In terminal 1 press Ctrl-C, then:

   ```
   h1473 down
   h1473 up --harness codex
   ```

   and in terminal 2:

   ```
   h1473 calibrate --harness codex
   ```

   Expected: a second verdict line. Record both.

5. Note when reporting: both runs are shellper-backed. The non-shellper terminal path cannot be
   exercised — it fails with `nodePty.spawn is not a function` on this branch **and identically
   at the merge base**, so it is pre-existing and out of scope.

6. Restart on claude for the remaining steps: Ctrl-C in terminal 1, then `h1473 down`, then
   `h1473 up --harness claude`.

---

## Step 3 — Mouse

Banked as a PASS from the first run. Repeat only if you want to re-confirm it.

1. Make sure the browser tab is showing the `builder-pir-1473` composer, that it is **empty**,
   and that the agent is idle.

2. In terminal 2:

   ```
   h1473 send "mouse test" --delay 5 --watch 20
   ```

3. As soon as it prints `Watching for 20s`, click into the composer about twice a second and
   keep clicking until the watch ends. Do not type.

4. Read the timeline.

   **PASS** — `busy:recent-input` appears, then `DELIVERED`:

   ```
       +0.0s  pending
       +5.1s  busy:recent-input
       +5.6s  DELIVERED
   ```

   **FAIL** — `pending` straight to `DELIVERED` with no hold; or the composer now contains
   "mouse test"; or the text was submitted.

   **VOID** — `busy:user-text` (the composer was not empty, or the agent was mid-response).

---

## Step 4a — The input signal (this is the assertion for this issue)

The verdict `busy:recent-input` can only appear when the composer is **empty**. A non-empty
composer is classified `user-text` first and the input logic is never reached — so every action
in this step must move the cursor without leaving a draft.

**Use only:** Right arrow, Left arrow, Home, End.
**Never:** printable characters, Up/Down (they recall history into the composer), Enter, Escape.

Before each repetition:

- the agent must be **idle** — not mid-response — and its composer **empty**. A repetition run
  against a working agent returns `user-text` and is void.
- if the composer has anything in it, clear it and wait for the screen to settle.

1. For each repetition, in terminal 2 run:

   ```
   h1473 send "input signal <n>" --delay 5 --watch 20
   ```

2. As soon as it prints `Watching for 20s`, start the action for that row in the browser
   composer, and keep it up until the watch ends.

   | # | Action across the window |
   |---|---|
   | 1 | Right arrow, one deliberate press about every half second |
   | 2 | Left arrow, same pace |
   | 3 | Alternate Right and Left, about twice a second |
   | 4 | `End`, then `Home`, alternating about twice a second |
   | 5 | Right arrow twice a second, but stop 2 seconds before the watch ends |
   | 6 | Nothing for the first 6 seconds, then Right arrow twice a second |
   | 7 | Click into the composer with the mouse about twice a second |
   | 8 | Alternate a mouse click and a Right arrow |
   | 9 | Right arrow at a slow pace — one press about every 1.5 seconds |
   | 10 | Right arrow presses in bursts of three, with a 1-second gap between bursts |

3. Read the timeline the watch prints.

   **PASS** — `busy:recent-input` appears at least once:

   ```
       +0.0s  pending
       +5.1s  busy:recent-input
       +5.6s  DELIVERED
   ```

   **FAIL** — the timeline goes straight from `pending` to `DELIVERED` with no hold at all,
   i.e. the message was written while you were driving input.

   **VOID, re-run it** — any of:
   - `busy:user-text` — the composer was not empty, or the agent was mid-response.
   - only `pending` for the whole watch — the send never came due.

   **NOT a failure** — a plain `busy` with no detail. That is the output settle holding on the
   repaint your own keypress caused; it is the pre-existing guard doing its job. Only a run with
   **no hold whatsoever** is a failure. If you press keys much faster than twice a second you
   will see mostly plain `busy`, because the output settle is checked before the input settle —
   press deliberately rather than holding a key down.

4. After each repetition, wait for the delivered message to finish being answered and the
   composer to return to empty before starting the next.

5. Record: how many of the 10 showed `busy:recent-input`, and the full timeline of any that
   did not.

---

## Step 4b — Draft integrity

Same procedure as revision 1. Its expected verdict is `busy:user-text` — the **pre-existing**
guard. This step does not test the input signal; it tests that a send never corrupts a draft.

1. For each row below, in terminal 2 run:

   ```
   h1473 send "typing test <n>" --delay 5 --watch 20
   ```

   then do the listed typing in the browser composer across the window.

   | # | What to be doing when the send comes due |
   |---|---|
   | 1 | Composer empty; type your first character right as the watch starts |
   | 2 | Mid-word, typing steadily |
   | 3 | Mid-word, typing as fast as you can (a burst) |
   | 4 | Immediately after a 2-second pause — resume typing mid-window |
   | 5 | Holding a key down so it auto-repeats |
   | 6 | Typing, then pressing Backspace repeatedly |
   | 7 | Pasting a line of text (Ctrl-V) |
   | 8 | Typing a multi-line draft (Shift+Enter between lines) |
   | 9 | Typing with a `/` slash-command menu open |
   | 10 | Typing one character every ~250 ms |

2. After each:

   **PASS** — the verdict is `busy:user-text`, **and** your draft is untouched: same text,
   cursor where you left it, nothing submitted.

   **FAIL** — any of:
   - the timeline shows `DELIVERED` while you were still typing;
   - the message text appears inside your draft;
   - your half-typed draft was submitted as a turn;
   - the verdict is `busy:no-region-end`, `busy:no-composer-marker`, or `no-profile` (the
     classifier could not read the composer — a different defect; report the exact string).

   A verdict of `busy:recent-input` here is also a pass; it just means the gate caught the
   keystroke before the draft was painted.

3. After each pass, clear the composer and wait for it to settle.

   Expected: the held message then delivers on its own.

4. Record the tally out of 10, and note any rep where the draft was altered.

---

## Teardown

1. In terminal 1, press Ctrl-C.

2. In terminal 2:

   ```
   h1473 down
   ```

   Expected:

   ```
   Port 14793: free
   Live Tower on 4100: still listening (untouched)
   ```

   Ctrl-C alone is not enough — the harness sessions are detached and outlive it.

3. Restore the two VS Code settings from step 1b.7 and reload the window.

4. Confirm the live Tower is unharmed:

   ```
   afx status
   ```

   Expected: `Tower: running`, and both builders still listed.

---

## What to report

1. Step 1a: PASS or FAIL. If FAIL, the verbatim `raw=` fields.
2. Step 1b: PASS or FAIL, same.
3. Step 2: both verdict lines (claude and codex), with their p50/p95/p99.
4. Step 3: PASS or FAIL.
5. Step 4a: how many of the 10 showed `busy:recent-input`, and the full timeline of any that
   did not.
6. Step 4b: the tally out of 10, and any rep where the draft was altered.
