# bugfix-1814 — porch per-check timeout_ms

## Investigate (2026-10-16)

Reproduced both halves of the issue.

**Main bug — `timeout_ms` is ignored.** A scratch protocol with
`"tests_py": { "command": "sleep 3", "timeout_ms": 1000 }` loads as
`{"command":"sleep 3"}` and the check runs to completion (3 s, passed). Root cause is a chain,
not one line:
- `protocol.ts` `normalizeProtocol` builds each `CheckDef` with only `command`/`cwd` (two
  duplicated loops: `defaults.checks` and per-phase `checks`) — every other key is dropped.
- `types.ts` `CheckDef` has no timeout field.
- `getPhaseChecks` rebuilds `{command, cwd}` when a config override applies.
- `runPhaseChecks` passes a single `timeoutMs` to every check; all three `index.ts` call sites
  pass `undefined`, so `DEFAULT_TIMEOUT_MS` (5 min) is the only value ever used.

**Secondary bug — a timed-out check can hang porch forever.** Mirroring `runCheck`'s spawn
logic on `sleep 12 | cat` with a 1 s timeout: the shell dies at 1 s, but `sleep`/`cat` keep the
stdout pipe open, so `close` (which resolves the check) only fires at 12 s — never, for a hung
test worker. The SIGKILL escalation is dead code too: `proc.killed` is true as soon as SIGTERM
is *sent*, so `if (!proc.killed) kill('SIGKILL')` never runs.

Note: `getPhaseCompletionChecks` has no production caller — phase checks via
`getPhaseChecks` → `runPhaseChecks` are the only path that runs checks.

## Decisions
- `timeout_ms` is accepted on a protocol.json check AND on a `.codev/config.json`
  `porch.checks` override (the documented adopter path — "you don't need to fork
  protocol.json"); otherwise a Python adopter with a long suite would have to fork.
- Invalid `timeout_ms` fails loudly at load (positive integer ≤ setTimeout's 2^31−1 ceiling);
  no silent fallback to 5 minutes.
- Timeout kills the whole process group (`detached: true` + `process.kill(-pid)`), matching
  the pty-session / cleanup precedent. Because `detached` also leaves porch's foreground
  group, porch relays its own SIGINT/SIGTERM/SIGHUP to the check's group while it runs, so
  Ctrl+C still stops a check.

## Fix (2026-10-16)

- Regression test `porch/__tests__/bugfix-1814-check-timeout.test.ts`: 11 of 13 cases fail
  against the unfixed source (the 2 that pass both ways pin invariants: no-`timeout_ms` keeps
  the default; a normal exit removes the signal relay). Without the fix the grandchild case
  hangs until vitest's 15 s test timeout — the issue's "waits forever".
- Verified the real user paths outside vitest: the scratch protocol from investigate now
  fails at `Timed out after 1s`; a real SIGINT to a node process running a check exits 130
  (ordinary Ctrl+C death) and the check's grandchild is gone.
- First `porch done` failed `tests` on `session-manager.test.ts` › "bounds a harness that exits
  0 immediately" (already `skipIf(CI)`, timing-based against real shellpers). Machine load avg
  was 22–41; it passed 3/3 in isolation and the retry passed the whole suite. Unrelated to this
  change (terminal code; separate vitest worker). Left as is — noted in the PR as a flake.

## PR #1815 + CMAP (2026-10-16)

- Lanes per `.codev/config.json`: codex + claude. `consult` auto-detect failed in this
  worktree ("Multiple projects found") — needed `--issue 1814 --project-id bugfix-1814`.
- Round 1: codex REQUEST_CHANGES (real): `runCheck` resolved on the shell's `close`, and
  `porch done` / gate approval `process.exit(1)` right after a failed check, cancelling the 5 s
  SIGKILL timer — a member ignoring SIGTERM with no pipe survived. Fixed: after a timeout the
  runner waits until the process group is empty (bounded by the grace) before resolving; new
  test with a `trap "" TERM` grandchild on /dev/null fails without it. claude APPROVE with nits
  (`!== undefined` instead of truthiness for `timeout_ms`; skill wording implied
  `phase_completion` takes a timeout) — both taken.
- Round 2: codex COMMENT, claude APPROVE. Taken: keep the signal relay alive through the
  post-timeout wait; widen the 5 s-grace test's timeout to 30 s. Left as pre-existing drift,
  not this PR: draft-07 schemas type `defaults.checks` as string-only (loader already accepted
  objects); adopter skeleton docs have no `porch.checks` section at all (Spec #550 never
  mirrored it); checks are a flat name-keyed map, so one name in two phases collides.

## Architect integration review, round 1 (2026-10-17)

- Asked: document `timeout_ms` in the adopter skeleton (its porch skill twins and
  `agent-farm.md` had no `porch.checks` section at all — added a minimal one each); announce an
  override that sets only `timeout_ms` (`logCheckOverrides` checked only command/cwd — exported
  it, added `timeout: Nms`, one test that fails without the change); two doc comments on
  `runCheck` (detached = setsid, no controlling terminal; process-level signal listeners, so
  CLI-only). Only `index.ts` calls the runner (`next.ts` doesn't), so the comment names it alone.
- CMAP round 3: codex COMMENT (PR-body drift only, fixed), claude APPROVE. Full suite 6253
  passed. Follow-ups and known limits listed in the PR body.
