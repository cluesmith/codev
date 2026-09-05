# PIR #1473 — Human Runbook

Four manual checks that need a real harness, a real browser and a real pair of hands. Everything
else for this issue is already automated in `codev/evidence/1473-dev-approval-transcript.txt`.

Budget about 30 minutes. Follow the steps in order; step 1 gates the rest.

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

3. Open a **second** terminal in the same directory. Every `send` / `inbox` / `calibrate`
   command below runs there.

4. Open the `Browser:` URL. Click the **`pir-1473-probe`** terminal.

   Expected: `claude` booting, then an empty composer. A second terminal named `architect` also
   exists — ignore it, it is created automatically when the workspace activates.

---

## Step 1 — Reply traffic (run this first)

If this fails, stop. Nothing downstream is trustworthy.

### 1a — Browser

1. Click once into the `pir-1473-probe` composer so it has focus.

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

1. In VS Code, open User settings (JSON) and set both:

   ```json
   "codev.towerPort": 14793,
   "codev.workspacePath": "/home/user/.agent-farm/test-workspaces/pir1473-human/ws"
   ```

2. Reload the VS Code window, then open the Codev terminal for that workspace and click the
   `pir-1473-probe` session.

3. Repeat 1a steps 2–5, watching terminal 1.

   PASS and FAIL are identical to 1a.

4. **Put the settings back** when you are done with the whole runbook:
   `"codev.towerPort": 4100` and `"codev.workspacePath": ""`. Reload the window.

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

1. Make sure the browser tab is showing the `pir-1473-probe` composer, and that it is **empty**.

2. In terminal 2:

   ```
   h1473 send "mouse test" --delay 8
   ```

   Expected: `scheduled → pir-1473-probe in 8s.`

3. Immediately click into the composer, and keep clicking about once a second for 15 seconds.
   Do not type.

4. Stop clicking. In terminal 2:

   ```
   h1473 inbox
   ```

   **PASS** — a row is listed, and its verdict is `busy:recent-input`:

   ```
   6c268d2d…  → pir-1473-probe  from architect  busy:recent-input  3s ago
   ```

   **FAIL** — `(no held messages)`, i.e. the message was delivered while you were clicking. Also
   a FAIL if the composer now contains "mouse test" or the text was submitted.

   **NEITHER** — a verdict of `pending` means the 8 seconds are not up yet. Keep clicking, wait,
   and run `h1473 inbox` again.

5. Stop clicking and wait 5 seconds, then run `h1473 inbox` again.

   Expected: `(no held messages)` — the hold cleared on its own and the message was delivered.
   Confirm the composer is untouched and the message arrived as a normal turn.

---

## Step 4 — Send while typing

Ten repetitions, varying **where in the keystroke stream** the send lands.

1. For each repetition below, in terminal 2 run:

   ```
   h1473 send "typing test <n>" --delay 8
   ```

   then do the listed typing in the browser composer across the 8-second window, then run
   `h1473 inbox`.

   | # | What to be doing when the send comes due |
   |---|---|
   | 1 | Composer empty; type your first character right at the 8s mark |
   | 2 | Mid-word, typing steadily |
   | 3 | Mid-word, typing as fast as you can (a burst) |
   | 4 | Immediately after a 2-second pause — resume typing at the 8s mark |
   | 5 | Holding a key down so it auto-repeats |
   | 6 | Typing, then pressing Backspace repeatedly |
   | 7 | Pasting a line of text (Ctrl-V) |
   | 8 | Typing a multi-line draft (Shift+Enter between lines) |
   | 9 | Typing with a `/` slash-command menu open |
   | 10 | Typing one character every ~250 ms (slower than the settle) |

2. After each repetition:

   **PASS** — `h1473 inbox` shows a row whose verdict is exactly:

   ```
   busy:recent-input
   ```

   and your draft in the composer is **unchanged** — same text, cursor where you left it,
   nothing submitted.

   **FAIL** — any of:
   - `(no held messages)` while you were still typing (delivered onto your line);
   - the message text appears inside your draft;
   - your half-typed draft was submitted as a turn;
   - the verdict is `busy:no-region-end`, `busy:no-composer-marker`, or `no-profile` (the
     classifier could not read the composer — a different defect, report the exact string).

   **NEITHER** — a verdict of `pending` means the send is not due yet. Keep typing, wait, and
   run `h1473 inbox` again.

3. After each PASS, clear the composer (select all, delete) and wait 2 seconds.

   Expected: `h1473 inbox` reports `(no held messages)` and the message is delivered.

4. Record the tally: how many of the 10 passed, and the exact verdict string for any that
   did not.

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

3. Restore the two VS Code settings from step 1b.4 and reload the window.

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
5. Step 4: the tally out of 10, plus every verdict string that was not `busy:recent-input`.
