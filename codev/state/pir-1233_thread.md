# Thread: pir-1233 — builder crash-restart loses context

## Plan phase (2026-08-05)

Investigated the post-#1244/#1267 launch-loop code. Key findings that shaped the plan:

- The issue body and even the 2026-07-27 re-triage comment are both partially stale: #1267 has since restructured `buildLaunchLoop(initial, fresh)` with a sticky clean-exit→fresh switch. The amnesia path (nonzero exit → rerun prompt-carrying fresh invocation) is still fully present on fresh spawns; my own worktree's `.builder-start.sh` is a live specimen.
- The architect side (#832/#1145/#1149/#1224/#1264, `tower-utils.ts:340-529`) already implements the complete target pattern: mint+pin, ownership check, bounded crash-loop fallback, fresh-with-new-id on clean exit. Builders need the same state machine expressed in generated bash.
- Design decision argued in the plan (architect asked for an explicit argument, leaning resume): keep the clean-exit relaunch FRESH per shipped #1267/#1264 semantics, but pin it to a newly minted id so post-relaunch crashes are also protected.
- Discovered a subtlety not in the issue: `claude --resume <id>` without a prompt restores context but leaves an unattended builder idle. Plan adds a crash-resume nudge prompt (empirical verification of `--resume <id> "<prompt>"` scheduled before implementation).
- Scope coordination: #1112 (persisted builder session ids) gets `.builder-session-id` written by the wrapper as its accurate current-id surface; storage/consumption stays out of this PR.

Plan written to `codev/plans/1233-builder-crash-restart-loses-al.md`; sitting at plan-approval gate.

Gate discussion (recorded for the review): blast radius (every Claude builder spawn; contained by session-less byte-identity, untouched architect path, spawn-time-only script generation), and why `.builder-session-id` is a worktree file rather than a DB row — builders have no session row today (#1112's scope), and after spawn only the bash wrapper knows the current id (re-mints on clean exit / degrade), so DB writes would go stale and bash writing global.db would violate the never-modify-state-by-hand invariant. Also why crash-resume can't reuse recover's mtime discovery: the session to resume doesn't exist yet at spawn time (pin-then-resume is the only way to name it), discovery-in-bash would bake Claude's storage layout into every worktree, and unattended newest-jsonl resume risks hijacking a human's stray session (#1145 lesson).

## Implement phase (2026-08-05)

- Empirically verified pin-then-resume round trip: `claude -p --session-id <uuid>` then `claude -p --resume <uuid> "<prompt>"` restores context AND accepts a positional prompt (codeword test). The crash-resume nudge design is sound.
- Harness seam: added optional `newSessionScriptFragment`/`resumeScriptFragment` to `HarnessProvider.session` (dual-form convention); Claude only.
- `buildSessionLaunchLoop` in spawn-worktree.ts: pin at entry → resume-with-nudge on unnatural exit → 3-consecutive-fast-failures degrade to prompt-replay under a re-minted id → clean exit stays fresh (per #1267) but pinned to a new id. `CODEV_LAUNCH_FAST_FAIL_SECS` (default 15) drives the fast-fail threshold. uuidgen→/proc→unpinned fallback chain for runtime minting.
- Deviation from plan (minor): Node does NOT write `.builder-session-id` at spawn — bash is the sole writer (runs `codev_persist_session_id` before the first launch). One writer beats two writers of the same value; the file exists within milliseconds of PTY start.
- Byte-identity subtlety: kept the historical double-space in role-bearing commands with empty fragments (gemini) so session-less scripts are truly byte-identical.
- 13 new executed-bash tests green (crash→resume, clean-exit re-mint, sticky switch, degrade, threshold gating, recover variant, harness gating, reset detection).
- Docs: PIR builder-prompt + protocol "crash relaunches you with the same prompt" wording updated to resume semantics, mirrored to codev-skeleton (verified byte-identical).
- Spec 1280's T16 manifest guard fired on the doc touches; registered them in `manifests/pir-1233-crash-resume.md` (pir-1189 precedent).

## Review phase (2026-08-05)

- dev-approval approved after gate Q&A (blast radius, file-vs-DB persistence, discovery-vs-pin, nudge rationale, death-capture mechanics, test procedure). Review file written; arch routed COLD (arch.md Agent Farm Internals paragraph), lesson routed COLD (lessons-learned.md Protocol Orchestration: resume restores transcript, not momentum).
- PR #1356 opened with review as body; recorded via porch done --pr.
- CMAP (2-way, single pass): claude=APPROVE/HIGH, codex=APPROVE/HIGH, none blocking. Claude's substantive minor (no direct worktree-mode loop assertion) fixed in 06e8a9e3; nudge-in-worktree-mode wording, `.builder-*` gitignore idea, and degrade-message wording acknowledged in review (gitignore noted as #1112-adjacent follow-up).
- Sitting at the pr gate.
