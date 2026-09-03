# pir-1482 — F1: Tower-vs-PTY dimension divergence (render gate)

## 2026-09-03 — PLAN phase

Investigated #1482 against HEAD (`cc83b6a3`) before writing anything. Findings that
changed the framing versus the issue body:

- **The gate does not read `session.info.cols/rows`.** `classifyAgentScreen`
  (`mailbox-wiring.ts:185-190`) classifies at the *mirror's* own dims
  (`SessionScreen.read()` → `_cols/_rows`). The architect's pre-spawn comment noted line
  drift; this is a semantic drift too. Conclusion is unchanged but sharper: the mirror's
  geometry has exactly two sources, and both take Tower's belief on faith
  (`pty-session.ts:568-572` on resize, `:488` on lazy mirror creation).
- **`shellper-main.ts:89` is the weakest of the four claims.** `ShellperProcess.handleResize`
  (`shellper-process.ts:447-459`) already caches dims and guards `this.pty && !this.exited`,
  and re-applies them across a SPAWN relaunch (`:495`). The `ptyInstance?.` no-op window is
  between `createPty()` and `.spawn()` — synchronous and adjacent. Kept in scope (cheap, makes
  the adapter honest) but not sold as the live defect.
- **The reconciliation channel already exists and is being thrown away.** WELCOME carries
  `cols`/`rows` (`shellper-process.ts:386-387`); `ShellperClient` parses the frame and adopts
  `command`/`args`/`lastDataAt` from it but drops the dims (`shellper-client.ts:342-381`).
  That is the natural fix for the post-restart case, and it follows an existing precedent
  (`welcomeCommand`/`welcomeArgs`, PIR #1475).
- **Two columns' worth of design pressure, resolved to one.** `detail` needs no CHECK
  constraint (SQLite can't ALTER one in; a CHECK in `GLOBAL_SCHEMA` only would break the
  migration suite's fresh-vs-upgraded convergence invariant). Precedent: v16 `command`,
  v17 `not_before`. And no `detail_since` column — the changed-only guard on the new
  `setHeldVerdict` keeps `updated_at` meaning "when the verdict last moved", and the
  drainer's existing `notCleanStreak` supplies the confirmation count for the
  "composer occupied since" hint.

Plan: 4 phases in one PR. Phase 1 is #1483's "first slice" (detail on the held row + every
surface) and stands alone; Phase 2 makes `resize()` commit only what landed (with
requested-vs-applied dims so a pre-spawn resize is still honoured); Phase 3 adopts and
reconciles the shellper's WELCOME dims on attach; Phase 4 pins it all with tests, including
a dims-sensitivity characterization test over an already-committed gzipped fixture.

Conflict surface noted and mitigated in the plan: PR #1491 owns `render-gate.ts` (so Phase 4
adds a test there and changes no behaviour), PR #1486 owns `commands/inbox.ts` FROM → TO
(so the inbox edit is confined to the REASON column).

Constraint carried from the issue: we are not cluesmith/codev maintainers. Do not merge,
do not close, do not clean up the worktree.

**Gate: plan-approval pending.**
