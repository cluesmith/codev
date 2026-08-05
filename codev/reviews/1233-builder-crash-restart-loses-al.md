# PIR Review: Builder crash-restart resumes the session instead of respawning fresh

Fixes #1233

## Summary

Builder `.builder-start.sh` wrappers previously handled any claude crash (notably the #1227 jetsam-SIGKILL class) by respawning a brand-new session with the original spawn prompt — total conversation amnesia, two seconds after every kill. This PR expresses the architect resume pattern (#832/#1264) in the generated bash: a session UUID is minted and pinned at spawn (`--session-id`), unnatural exits resume that conversation (`--resume` plus a re-orientation nudge so the unattended builder acts instead of idling), three consecutive fast failures degrade to the historical prompt-replay under a re-minted id, and #1267's clean-exit-stays-fresh semantics are preserved but now crash-protected under a new id. Session-less harnesses (codex/gemini/opencode/custom) generate byte-identical scripts to before.

## Files Changed

- `packages/codev/src/agent-farm/commands/spawn-worktree.ts` (+238 / -23) — `buildSessionLaunchLoop` state machine, `scriptSessionForms`, `CRASH_RESUME_NUDGE`; `startBuilderSession` / `buildWorktreeLaunchScript` wiring
- `packages/codev/src/agent-farm/utils/harness.ts` (+20 / -0) — optional `newSessionScriptFragment` / `resumeScriptFragment` on the `session` seam; Claude implementation
- `packages/codev/src/agent-farm/__tests__/pir-1233-session-launch-loop.test.ts` (+241 / -0) — new executed-bash suite
- `packages/codev/src/agent-farm/__tests__/spawn-worktree.test.ts` (+27 / -15) — #929/#1267 assertions updated to the session-aware launcher names (intents preserved)
- `packages/codev/src/agent-farm/__tests__/launch-loop-exit-code.test.ts` (+4 / -2) — crash-branch message wording
- `codev/protocols/pir/{builder-prompt,protocol}.md` + `codev-skeleton/protocols/pir/{builder-prompt,protocol}.md` (+2 / -2 each) — crash-relaunch wording now describes resume semantics; both trees byte-identical
- `codev/projects/1280-prompt-surface-judgment-not-ru/manifests/pir-1233-crash-resume.md` (+17) — T16 manifest rows for the four prompt-bearing doc touches
- `codev/resources/arch.md`, `codev/resources/lessons-learned.md` — routed updates (see below)
- `codev/plans/1233-builder-crash-restart-loses-al.md`, `codev/state/pir-1233_thread.md` — plan and thread artifacts

## Commits

- `8e4156c2` [PIR #1233] Crash restarts resume the pinned session instead of respawning fresh
- `11e788c8` [PIR #1233] docs: crash-restart now resumes; update PIR loop descriptions in both trees
- `d158f2fd` [PIR #1233] Test: execute the session-aware loop and assert resume/degrade/re-mint behavior
- `05184d2e` [PIR #1233] thread: implement-phase notes
- `6c020959` [PIR #1233] Test: update #929/#1241/#1267 assertions to the session-aware launcher names
- `b4cdd57f` [PIR #1233] Manifest: register prompt-bearing doc touches for T16 (Spec 1280)
- (review-phase commit) [PIR #1233] Review + retrospective

## Test Results

- `pnpm build`: ✓ pass
- `pnpm test`: ✓ pass (4,406 passed / 48 skipped; 13 new executed-bash tests)
- Empirical CLI verification: `claude -p --session-id <uuid>` then `claude -p --resume <uuid> "<prompt>"` — context restored (codeword round-trip) and the positional nudge prompt processed as the next turn
- Manual verification: human-reviewed at the `dev-approval` gate (code + generated-script walkthrough; live kill -9 test procedure provided)

## Architecture Updates

Routed **COLD** (`codev/resources/arch.md`, Agent Farm Internals): a new paragraph "Builder crash restarts resume the pinned conversation (#1233)" alongside the existing #832/#1145 architect-resume paragraph — covering the pin-at-spawn/resume-on-crash state machine, the nudge rationale, the fast-fail degrade, `.builder-session-id` with bash as sole writer (consumption deferred to #1112), session-less byte-identity, and why the machinery lives in generated bash (builder PTYs outlive Tower). Not HOT: this is subsystem mechanics to consult when touching spawn/recovery, not a fact that should steer every decision; the hot cap is better spent on its current entries.

## Lessons Learned Updates

Routed **COLD** (`codev/resources/lessons-learned.md`, Protocol Orchestration): `--resume` restores the transcript, not the momentum — unattended agents need a turn trigger (the nudge prompt) or a context-loss fix silently becomes a stalled-lane incident. Not HOT: narrow to agent-resume design, below the cross-cutting bar.

## Things to Look At During PR Review

- **The bash state machine** (`buildSessionLaunchLoop`, `spawn-worktree.ts`) is the subtle core: the degrade path must never `--resume` a stale id after falling back to an unpinned launch (guarded by the launcher-name check), and the clean-exit re-mint must happen *after* the `read` so a vanished terminal (EOF) never mutates state on the way out. The executed-bash tests pin both.
- **The fast-fail threshold heuristic** (3 consecutive nonzero exits under 15s) is a wrapper-side approximation of the shellper's SessionManager crash-loop detector. A jetsam storm that kills three resumes inside 15s would degrade to prompt-replay — i.e., today's behavior; acceptable, but it is a heuristic, not a proof.
- **Test-layer discipline** (#1244 finding): the wrapper sees bash's 128+N for signal deaths; node-pty reports `{exitCode: 0, signal}`. All new tests execute real bash and assert wrapper-layer codes only.
- **Deviation from the approved plan** (minor, deliberate): Node does not pre-write `.builder-session-id` at spawn; the bash script is the sole writer (runs `codev_persist_session_id` before the first launch). One writer beats two writers of the same value.
- Behavioral side effects flagged at the plan gate, on the record for reviewers: crash-restart no longer re-reads `.builder-prompt.txt`/`.builder-role.md` (edits land only on a clean-exit relaunch), and crashes no longer accidentally "solve" a near-full context window (use `afx reset` for that).

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-1233` → **View Diff**
- **Automated**: `cd .builders/pir-1233/packages/codev && pnpm exec vitest run src/agent-farm/__tests__/pir-1233-session-launch-loop.test.ts`
- **Live end-to-end** (requires installing the branch build: `pnpm build && pnpm -w run local-install` from the worktree):
  1. Spawn a scratch builder; verify `.builder-start.sh` contains `codev_launch_resume()` and `.builder-session-id` holds its UUID
  2. Tell it a codeword, `kill -9` its claude pid → "Resuming the conversation in 2 seconds…" → ask for the codeword back
  3. Double-Ctrl+C → Enter → fresh conversation, new UUID in `.builder-session-id`
  4. Move the session jsonl out of `~/.claude/projects/<encoded-worktree>/`, `kill -9` → three fast resume attempts, then fresh prompt-replay relaunch

## Notes

- New builders get the resumable wrapper only at spawn time; already-running builders keep the old loop until respawned. No migration needed.
- `.builder-session-id` format (one lowercase UUID + newline) becomes a soft contract for #1112, which owns making `--resume`/recover consume it in place of mtime discovery.
