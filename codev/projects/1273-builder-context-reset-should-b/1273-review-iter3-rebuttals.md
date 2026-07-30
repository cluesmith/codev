# Rebuttal — PR review, iteration 3

**Verdicts**: Gemini APPROVE · Claude APPROVE · Codex REQUEST_CHANGES

**Accepted.** Third consecutive finding on the same three lines of advisory code, and the third distinct
false-report mechanism. That pattern is itself the lesson.

---

## Codex — "Clear confirmation can still report a false success by matching the echoed save request"

**Accepted.** Verified: `buildSaveRequest` opens with **`CONTEXT RESET INCOMING — save your working state
now.`**, which matches `/context (?:cleared|reset)/i`. Reset sends that request into the same terminal
moments before clearing, so it is in the buffer on **every run**. Last round I removed the `/clear`
alternative and did not ask the obvious follow-up: *what else in this buffer did I put there?*

**The three failures in sequence, because the progression is the point:**

1. `readRecentOutput` unbound → always **unconfirmed**. A check that never looked.
2. Pattern matched `/clear` → always **confirmed**. A check that looked at its own keystroke echo.
3. Pattern matched the save request's header → always **confirmed**. A check that looked at its own
   *message*.

Each fix was a better regex, and each time the regex was the wrong layer. The real defect was scanning a
buffer that **contains reset's own writes** and hoping the pattern would not collide. With reset writing
into the terminal three times per run, collision is not a risk to mitigate — it is the default.

**Changed structurally, not with a fourth regex.** `readRecentOutput` becomes
`readOutput(): { lines, total }`. The orchestrator snapshots `total` immediately before sending `/clear`
and confirms against **only the lines produced after that point**. Everything reset wrote sits at or below
the snapshot and is excluded *by construction*. A future pattern change cannot reintroduce this class.

The test harness now models it honestly: `PRE_CLEAR_BUFFER` contains the real save-request header, so if
the windowing regresses, reset's own words leak into the check and the negative tests fail. Two tests pin
the closed cases (echoed `/clear`, echoed save request) and one confirms the check still fires on genuine
post-clear harness output — a guard that only ever returns false is no better than the unbound version.

**Carried to the review as a named gap, because it is the honest limit here:** the *pattern* remains
unvalidated. I have never observed what a real Claude Code `/clear` emits, so the strings it matches are
still an educated guess. The window fix closes the false-**positive** class; it cannot prove the pattern
ever matches in production. `clear-confirmed` should be read as *"the harness said something clear-like"*,
never as proof. The live e2e settles it, and the pattern may need adjusting afterwards. This is exactly
why confirmation is advisory and report-only — the re-orientation is correct either way, and no invariant
depends on it.

**On whether to keep this at all:** three rounds of defects in a non-load-bearing nicety is a fair
argument for deleting it. I kept it because the failure it reports on — a `/clear` that silently no-ops —
is the one failure mode the rest of the design cannot detect, and a windowed check is now structurally
sound rather than a guess stacked on a guess. If the architect would rather ship without it, removing
`confirmClear` and its two step names is a clean five-line deletion.

---

## Gemini — APPROVE · Claude — APPROVE

No issues raised.

---

## Net effect

Confirmation reads only post-clear output; reset's own text can no longer confirm reset. Suite
4015 → 4016, build clean, branch current with `main`.
