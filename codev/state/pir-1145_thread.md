# pir-1145 — builder thread

## 2026-07-08 — Plan phase

Investigated issue #1145 (main architect hijacks unrelated Claude session on fresh workspaces).

**Root cause**: the #832 legacy jsonl-discovery fallback in `launchInstance` (tower-instances.ts:493-499) is gated on `getArchitects().length <= 1`, which a *fresh* workspace (0 rows) satisfies. So first-ever launch runs mtime discovery over `~/.claude/projects/<encoded-cwd>/` and resumes the user's personal Claude conversation if one exists for that directory — with role injection skipped (resume branch of `resolveArchitectLaunch`). Second vector: the project-dir encoding maps both `/` and `.` to `-` (lossy), so distinct paths can collide into one store dir → genuine cross-project pickup.

**Plan** (codev/plans/1145-codev-adopt-launchinstance-mai.md):
1. Gate discovery on a legacy `main` row *existing* without a session id (the bridge case it was built for). No row → always fresh.
2. Ownership verification: jsonl candidates must record a `cwd` matching the requested path (discovery side), plus an optional harness-gated `session.verifyOwnership` checked in `resolveArchitectLaunch` before any stored-id resume.

Confirmed `afx workspace stop` preserves architect rows, so normal stop/start resume is unaffected. Sitting at plan-approval gate.

## 2026-07-09 — Plan revised, approved; implement phase

Reviewer challenged the row-gated fallback: even gated, mtime discovery can't distinguish the architect's last session from a *newer personal session in the same cwd* (and the cwd ownership check passes trivially there). Revised plan to drop the architect discovery fallback entirely; approved.

Implementation:
- `claude-session-discovery.ts`: candidates now verified against the cwd recorded inside the jsonl (realpath-canonicalized both sides); new `readSessionCwd` + `verifySessionOwnership` (checks both logical and physical path encodings — macOS /tmp symlinks).
- `harness.ts`: optional `session.verifyOwnership` capability; Claude implements it. `buildResume` doc updated: builder resume is its sole consumer now.
- `tower-utils.ts`: `resolveArchitectLaunch` verifies stored-id ownership before the resume branch; failure falls through to fresh (new minted id replaces the stale one on persist). `homeDir` test seam threaded through.
- `tower-instances.ts`: discovery fallback deleted; stored row id is the only architect resume source.

Test gotcha worth remembering: asserting `JSON.stringify(spawnCall).not.toContain('--resume')` false-fails because the injected architect role prompt *text* contains `--resume` in its CLI examples. Assert on argv tokens instead.

115 tests green on the four touched files; full suite + push next, then dev-approval gate.

## 2026-07-10 — dev-approval feedback: content scanning removed

Reviewer walked the design back in three steps at the gate: (1) why scan file contents at all → only real justification was lossy-encoding collisions; (2) the fixed 64KB scan window made resume content-dependent → made it streaming/semantic; (3) collisions are contrived for both architects (row-gated) and builders (Agent-Farm-managed worktree paths) → dropped content scanning entirely.

Final shape: architect resume = stored row id + file-*existence* check (both logical/physical path encodings, macOS symlink case); builder discovery = plain newest-by-mtime (pre-#1145 behavior). The #1145 fix proper (no discovery fallback in launchInstance) is untouched. Deviation from the approved plan (which specified cwd-content verification) to be recorded in the review file.

Lesson: when a reviewer asks "why is this here at all", enumerate what each layer actually defends against before defending the layer — two of three protections were against a threat the system's own path conventions already preclude.
