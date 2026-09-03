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

## 2026-09-03 — IMPLEMENT phase

Plan approved by the human; architect confirmed one PR, four commits, and re-verified every
load-bearing claim against HEAD independently.

### Two things the plan did not anticipate

**1. The attach re-send undid the adoption it was paired with.** Phase 3 adopts the shellper's
WELCOME geometry, then re-sends the requested geometry so a viewer still wins. Written as
"re-send when requested !== applied", that fires for a session whose *constructor defaults*
merely differ from the running geometry — which is Tower's memory, the very thing the adoption
just corrected. The first attach test caught it (adopted 139×63, immediately reverted to
104×101). Fixed with an explicit `resizePending` flag: set when a resize is dropped, cleared
when one lands, and the only thing that authorizes a re-send. Adoption re-bases the request
unless one is genuinely outstanding. Worth noting because "requested vs applied" felt like
enough state and was not — the missing bit was *outstanding*, not *different*.

**2. `setWelcomeGeometry` briefly got cleared inside `setIdentity`'s reject path.** A scripted
edit landed the geometry reset in the wrong function — an invalid *identity* would have thrown
away a perfectly good *geometry*. Caught on read-back before building. They are independent
capabilities and stay that way.

### Design decisions taken during implementation

- `formatVerdict` / `isUnverifiableVerdict` live in a NEW `agent-farm/utils/hold-verdict.ts`
  rather than in `utils/message-format.ts` — the latter is about formatting message bodies for
  PTY delivery, and it is one of PR #1486's files. New module, zero conflict surface.
- The dashboard gets a PORTED copy (`formatHoldVerdict` in `apps/web/src/lib/heldMail.ts`),
  not an import: the web app must not import from codev-core (#1189), and `heldMail.ts` already
  documents that exact precedent for its age formatters.
- `CronDeliveryResult` gained `detail` too. Not in the plan, but a cron send has no human
  waiting on a response, so its log line is the ONLY place that hold is ever described.
- The REST resize routes now answer **409 RESIZE_DROPPED**, distinguished from 404 by an
  existence check. The old code answered 200 and echoed back the requested dimensions, which is
  precisely how a divergence became invisible.

### Measurement recorded in the test suite

Swept the committed `claude-smallring-idle` fixture (true 139×63) over columns 131/135/139/143
× rows 61/63/65. At the true row count, **139 and 143 classify CLEAN; 135 and 131 classify
`busy:no-region-end`**. A four-column disagreement is enough, and `no-region-end` never clears
on its own. That measurement is now `render-gate.test.ts`'s dimension-sensitivity suite — it
changes no behaviour, it is the executable statement of the premise the rest of the issue rests
on.

