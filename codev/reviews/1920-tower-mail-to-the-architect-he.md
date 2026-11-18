# PIR Review: Architect mail held with no-composer-marker on Windows

Fixes #1920

## Summary

On native Windows, mail to the `main` architect was held with `busy:no-composer-marker` after a Tower restart, and the hold never cleared. The cause was the environment, not the gate's logic. node-pty sets `TERM` from its `name` option only on POSIX, and architects launch as bare `claude`, with Tower's env and no `TERM`. With no Unicode signal in its env on win32, claude draws its `figures` ASCII fallbacks: the composer marker becomes `>` followed by U+00A0 instead of `❯`, and the claude gate profile only matched `❯`/`›`.

Builders never showed this, because Git Bash sets `TERM=xterm-256color` before `claude` starts. The fix has two parts:

1. Every Tower-launched PTY child now gets `TERM=xterm-256color`, enforced at the spawn chokepoint. New sessions draw `❯`.
2. The claude profile also accepts the ASCII marker, so sessions already drawn in fallback mode (including the live architects at install time) deliver without a restart.

## Files Changed

- `codev/plans/1920-tower-mail-to-the-architect-he.md` (+214 / -0)
- `codev/projects/1920-tower-mail-to-the-architect-he/status.yaml` (+22 / -0)
- `codev/resources/arch.md` (+2 / -0)
- `codev/resources/lessons-learned.md` (+2 / -0)
- `codev/state/pir-1920_thread.md` (+23 / -0)
- `packages/codev/scripts/spec-1658-conpty-capture.mts` (+24 / -5)
- `packages/codev/src/agent-farm/__tests__/fixtures/gate/README.md` (+19 / -0)
- `packages/codev/src/agent-farm/__tests__/fixtures/gate/claude-conpty-ghost-idle-ascii.replay.bin.gz` (new, binary)
- `packages/codev/src/agent-farm/__tests__/fixtures/gate/conpty/conpty-claude-ascii-draft.capture.jsonl.gz` (new, binary)
- `packages/codev/src/agent-farm/__tests__/fixtures/gate/conpty/conpty-claude-ascii-idle.capture.jsonl.gz` (new, binary)
- `packages/codev/src/agent-farm/__tests__/fixtures/gate/conpty/conpty-claude-ascii-midturn.capture.jsonl.gz` (new, binary)
- `packages/codev/src/agent-farm/__tests__/fixtures/gate/conpty/conpty-claude-ascii-prefix-left.capture.jsonl.gz` (new, binary)
- `packages/codev/src/agent-farm/__tests__/helpers/conpty-replay.ts` (+6 / -0)
- `packages/codev/src/agent-farm/__tests__/render-gate.test.ts` (+76 / -0)
- `packages/codev/src/agent-farm/__tests__/spec-1658-conpty-gate-replay.test.ts` (+2 / -1)
- `packages/codev/src/agent-farm/servers/gate-profiles.ts` (+25 / -1)
- `packages/codev/src/agent-farm/servers/render-gate.ts` (+2 / -1)
- `packages/codev/src/lib/agent-env.ts` (+23 / -0)
- `packages/codev/src/terminal/__tests__/pty-terminal-type.test.ts` (+72 / -0)
- `packages/codev/src/terminal/__tests__/session-manager-spawn-config.test.ts` (+25 / -4)
- `packages/codev/src/terminal/__tests__/session-manager.test.ts` (+24 / -1)
- `packages/codev/src/terminal/pty-session.ts` (+6 / -3)
- `packages/codev/src/terminal/session-manager.ts` (+7 / -4)

## Commits

- `8d7b2451d` [PIR #1920] arch.md: TERM at the PTY spawn chokepoint and claude's ASCII-fallback marker; thread update
- `6325afd3c` [PIR #1920] Thread: implement status and Tower-stop incident
- `91258ee51` [PIR #1920] Lesson: a recorder that adds env production lacks records the wrong screen
- `269eaf66a` [PIR #1920] Recorder --bare-env and ASCII-marker ConPTY captures
- `acd025292` [PIR #1920] Claude gate profile accepts claude's ASCII-fallback '>' marker
- `f55f9d4ad` [PIR #1920] Give every Tower-launched PTY child TERM=xterm-256color
- `8b30ce9b2` [PIR #1920] Plan draft
- Plus porch state commits (`chore(porch): 1920 …`)

## Test Results

- `npm run build`: ✓ pass
- `npm test` (full `packages/codev` suite, on native Windows, after rebasing onto #1926): ✓ pass. It passed at `porch done` (134.4s) and again on the `porch approve` re-check (129.7s). The first attempt timed out at 300s because several builders were running the full suite at once; it passed once the runs were serialized.
- New tests:
  - `render-gate.test.ts`: 10 cases in "claude's ASCII-fallback composer marker (Issue #1920)":
    - the derived ghost fixture is clean, and is `no-composer-marker` under the old pattern;
    - NBSP, space, and bare `>` idle lines are clean;
    - typed text is `user-text`;
    - a `> …` echo above the composer is clean;
    - an ASCII picker is `user-text`;
    - a parked ghost is clean, while inverse plus non-dim is `user-text`;
    - `>>` and `>foo` are `no-composer-marker`;
    - codex `>` stays `no-composer-marker`.
  - `pty-terminal-type.test.ts`: the helper, and the non-shellper `PtySession.spawn` (name and `env.TERM`).
  - `session-manager*.test.ts`: TERM at first spawn on win32 and linux, an inherited `xterm` replaced, and the crash and clean-exit relaunch `SPAWN` frames.
  - `spec-1658-conpty-gate-replay.test.ts`: the four new real bare-env claude 2.1.327 captures (idle, draft, prefix-left, midturn) replay with the expected verdicts.
- Windows workflow (on demand, suites): https://github.com/cluesmith/codev/actions/runs/44242152525
- Manual verification:
  - Before the fix: a read-only viewer attach captured the held `main` architect's screen. It showed `>` + U+00A0, which classifies `no-composer-marker` under the old profile and `clean` under the new one.
  - Dev approval: the owner installed this build on their Windows machine and restarted Tower. Mail to `main` now delivers. The backlog held as `no-composer-marker` delivered on install:
    - PR #1918 ready;
    - 1917 and 1919 plan-approval;
    - 1920 plan-approval;
    - attribution acks;
    - the CI Health Check and team-update crons.

    The 2026-11-02 cron (`dc384851`) was superseded by the 00:00Z team-update row and did not deliver.

## Architecture Updates

COLD: `codev/resources/arch.md`, "PTY Environment". `TERM` is now enforced at the spawn chokepoint by `withPtyTerminalType()`, at four places:
- the shellper config;
- both relaunch `SPAWN` frames;
- the non-shellper `PtySession.spawn`.

The same entry explains why (node-pty sets `TERM` on POSIX only), and that the claude gate profile accepts the ASCII-fallback marker while codex keeps the strict one. Nothing hot-tier: the mailbox and gate invariant in `arch-critical.md` is unchanged.

## Lessons Learned Updates

COLD: `codev/resources/lessons-learned.md`, Testing (`[From #1920]`). A fixture recorder that adds environment that production does not add records a screen that production never shows. Spec 1658's recorder set `TERM` itself, so every capture drew `❯` and the suite stayed green while real architects drew `>`. Record with the env the production launch path builds, and put any deviation behind a named switch (`--bare-env`).

Not routed, but worth knowing: `launchers.windows.test.ts` (before #1926) stopped the live Tower on port 4100 during a local full-suite run. #1926 added the guard.

## Things to Look At During PR Review

- **The ASCII ghost-cursor fixture is derived, not recorded.** `claude-conpty-ghost-idle-ascii.replay.bin.gz` is the real M15 capture with every `❯` replaced by `>`; no other byte changed. Six idle recordings of claude 2.1.327, with the bare env and the normal env, never drew the inverse software cursor, so the focused state could not be recorded live. It shows that `isGhostCursorCell`'s first-input-cell anchor holds with a one-column ASCII marker. It does not prove claude draws exactly that screen.
- **The marker regex** (`gate-profiles.ts`, `CLAUDE_COMPOSER_MARKER`): `>` must be followed by a space, U+00A0, or end of line. Without that lookahead, `>>`, `>foo` or a quoted `>` line would read as a marker. The last-match-wins search plus the region-end rule requirement still bound the composer. A transcript `> …` echo above the composer is fine: the composer's own marker is the last match.
- **TERM is overwritten, not defaulted.** An inherited `xterm` (mintty) fails claude's win32 Unicode check, and the PTY really is `xterm-256color`. The change is in shared code; on POSIX node-pty already set the same value from `name`, so behaviour there is unchanged.
- **No hold became a force-inject.** The gate still requires a clean, bounded composer region; only the set of accepted marker glyphs grew.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-1920 → **View Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-1920`
- **What to verify**:
  - On Windows, install the build and restart Tower. `afx send architect "…"` to an idle architect reports `delivered`, not `held … no-composer-marker`.
  - A newly started architect draws `❯` (its env has `TERM=xterm-256color`).
  - `npx vitest run src/agent-farm/__tests__/render-gate.test.ts src/agent-farm/__tests__/spec-1658-conpty-gate-replay.test.ts src/terminal/__tests__/session-manager.test.ts src/terminal/__tests__/session-manager-spawn-config.test.ts src/terminal/__tests__/pty-terminal-type.test.ts` (from `packages/codev`).
