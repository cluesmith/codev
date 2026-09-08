# CMAP dispositions — post-pivot delta (2026-08-09)

Three-way review of the design-pivot delta on PR #1203 (role → `--agent-file`, task → the
Spec 1313 mailbox, crash resume → guarded `kimi -c`), run after the `origin/main` merge at
`ae0d034a`. The brief asked reviewers to attack the shared `render-gate.ts` edit hardest,
per the architect's guardrail.

**Verdicts: gemini APPROVE · codex REQUEST_CHANGES · claude REQUEST_CHANGES.**

Both REQUEST_CHANGES verdicts were right, and they found the same two defects from opposite
directions. Neither was reachable from a happy-path live run — an empty composer and a clean
store both behave correctly, which is exactly why three passing demos missed them.

---

## Accepted and fixed

### 1. False CLEAN on a multi-row kimi composer — BLOCKING (claude F1)

`KIMI_MARKER` matches `` │ > ``; `findMarkerRow` takes the **last** match; the scan started
**at** that row. A draft whose final line begins with `>` puts the marker on the *continuation*
row, leaving the real text above the scanned region → the composer classifies `clean` while
holding unsent input, and a queued message is typed on top of it. That is the corruption class
the gate exists to prevent.

Claude reproduced it on a constructed screen and flagged that it had no live kimi to confirm
kimi's real multi-row geometry. **Measured on real kimi 0.34.0** (`pir-1201-kimi-gate-measure.mjs`,
extended for this): a two-line draft renders

```
 ╭────────────
 │ > implement the whole feature
 │   >
 ╰────────────
```

— exactly the shape, so the defect is real and reachable, not theoretical.

**Fix:** optional `regionStartPatterns` on `GateProfile`, an *exclusive* upper bound (kimi: the
box top `` ╭─── ``). Exclusive matters: the box-top row's right corner `╮` is not an ignorable
glyph, and including that row held every idle composer forever — caught by the fixture suite
when the first attempt regressed `kimi-idle.clean`.

Committed as fixtures from the live capture: `kimi-multiline-bare` (the false CLEAN itself),
`kimi-multiline`, `kimi-menu`, `kimi-picker` — the last two answering claude's "kimi ships 3
fixtures where claude/codex ship menu and picker" point.

**Claude's second input — a marker-matching row *below* the composer in a second box — is not
reachable in the shipped UI, measured:** kimi's `/` menu renders as unclosed `│` rows with no
`╰` beneath them, so any marker inside it yields `no-region-end` → held. Recorded rather than
"fixed", with the fixtures to show it.

### 2. The store probe diverges from `findLatestKimiSessionId` — BLOCKING (codex #1, claude F2)

Two reviewers, two directions, same root cause: the probe and the TypeScript are the same
question in two languages, and the cross-check test compared them against each other rather
than against kimi's continuation semantics — agreement between duplicated omissions.

- **codex #1 (dangerous direction):** an `archived: true` session matched on cwd alone, so the
  probe authorized `-c`; kimi excludes archived sessions from the listing `-c` continues from,
  starts a fresh one, and that session never saw `--agent-file` → silently **roleless** builder.
- **claude F2 (safe direction, still harmful):** `readdirSync` on a stray non-directory threw
  `ENOTDIR` into the single **outer** try, aborting the whole scan — one `.DS_Store` in
  `~/.kimi-code/sessions/` disabled resume machine-wide, permanently and silently. Same for a
  symlinked worktree and a trailing slash on the recorded cwd.

**Fix:** both implementations now share one resumability predicate (`archived !== true`,
`session_`-prefixed id) and `sameDir`'s realpath tolerance; each directory level gets its own
`try`. Every listed case is now a test asserting **both** implementations.

### 3. Unescaped interpolation in the generated script (codex #3, claude F3, gemini MINOR)

All three flagged the same lines from different angles. The recovery hints interpolated
`builderId` / `taskFile` into double-quoted bash `echo`s, where bash re-scans them — so `$(…)`
in a builder id executed when the hint printed. `cd "${worktreePath}"` was unquoted too.

**Fix:** every value enters the script once as a single-quoted escaped assignment; later uses go
through the shell variable, and hints print via `printf '%s\n'` on the expansion (bash does not
re-scan an expansion). Pinned by a test that runs the generated function with a metacharacter
id and asserts nothing executed.

### 4. Crash loop re-queues the task indefinitely (codex #4)

`codev_launch_fresh` queues the task, so a kimi dying before it mints a session re-queued the
same mission every ~2s. The mailbox *persists* a held row, so one enqueue suffices.

**Fix:** a `codev_task_queued` guard, reset only on the human-gated clean-exit relaunch (which
is a deliberate new conversation and does want its task again). Pinned by driving the generated
function through three crash iterations plus a clean-exit relaunch against a stub `afx`.

### 5. Drift probes report healthy forever after a migration (codex #5)

Both probes returned `ok` if **any** record matched, so post-migration the old records hide
every new one — reporting healthy through exactly the rename the probe exists to catch.

**Fix:** compare the newest conforming record against the newest non-conforming one; report
drift only when the bad one is *strictly* newer. Ties stay `ok` — my first attempt used
mixed units (`updatedAt` vs filesystem mtime) and made the verdict depend on directory
iteration order, which a test caught.

### 6. Cleanups (claude F6, F7)

- `buildRoleInjection`'s user-facing error and a `doctor.ts` comment still described the retired
  seed-session bootstrap. Both now describe `--agent-file` and *why* it does not fit the
  architect path (it needs a file written into the agent's directory; only the builder launch
  path has that seam).
- `verifyKimi`: `spawnSync` returns `status: null` on spawn failure or timeout, and `null !== 0`
  reported "kimi doctor reports config issues" — a false accusation against a healthy install on
  a slow machine. Now distinguishes "learned nothing" from "reported a problem".

### 7. Dangling evidence references (claude F5)

`gate-profiles.ts` and `harness.ts` cite spike scripts that were untracked. The three
`pir-1201-kimi-*.mjs` probes ship in this PR, so the evidence chain resolves after merge.

---

## Accepted as accurate, no code change

- **claude:** the `markerSpanEnd` edit is a genuine no-op for claude/codex/agy — attacked and
  held up. The docstring's "only narrow glyphs" premise is slightly wrong (U+3000 is `\s` *and*
  wide), but that direction under-shoots the span → over-counts → holds. Safe both ways; codex
  reached the same conclusion independently.
- **codex:** trust filename construction has no traversal issue; pacing resolution is total.

## Maintainer decisions, not mine (both surfaced in the PR body)

- **codex #2 — automatic workspace trust.** Codex argues `--yolo` governs tool approval while
  workspace trust governs whether repository-controlled MCP processes load at all, so a fork-PR
  branch could get its project MCP config loaded without a human decision. Claude reviewed the
  same code and concluded the opposite (a `--yolo` builder in a Codev-created worktree already
  holds strictly more authority). The disagreement is real and is a policy call, so it goes to
  the maintainer with both arguments rather than being settled here. Kept fail-soft, drift-probed,
  and dated in `arch.md`; the PR offers to cut it for one human keypress per Kimi builder.
- **claude F4 — no worktree write-guard for kimi builders.** Correct, and materially broader than
  the trust question. Kimi *does* have a blocking `PreToolUse` hook seam, so parity is achievable
  follow-up work; the PR asks whether it lands here or separately.

---

## What this round says about the process

The three passing live demos were not worthless — they proved the mechanism end to end — but
every defect above lives in a state the happy path does not produce. Two independent reviewers
converged on the same two blocking defects from opposite directions, and the live measurement
rig then settled which of claude's two proposed inputs was real. Review found them; measurement
sized them.
