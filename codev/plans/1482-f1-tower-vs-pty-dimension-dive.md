# PIR Plan: F1 — Tower-vs-PTY dimension divergence causes indefinite false-busy

Issue: #1482 (workstream A "dims leg" of tracking issue #1483)
Branch: `builder/pir-1482` off `main` @ `cc83b6a3`

## Understanding

The render gate is the sole authority for "may this message be written to that composer?".
It fails toward *hold*, which is the right direction for corruption — but a hold that can
never clear is an indefinite delivery outage. #1482 is the **dims leg** of that: the screen
the classifier reads is a headless mirror rendered at a geometry Tower *believes*, and that
belief can silently stop matching the geometry the real TUI laid itself out at. A small
disagreement re-wraps the composer's rule line out of the region the classifier scans, and
`no-region-end` / `no-composer-marker` becomes permanent.

### What the code actually does today (verified at HEAD, not from the issue body)

**1. The classifier reads the mirror's dims, not `session.info`.**
`classifyAgentScreen` (`packages/codev/src/agent-farm/servers/mailbox-wiring.ts:185-190`)
does `const { term, cols, rows } = await screen.read()` and hands those to `classifyBuffer`.
`SessionScreen.read()` returns its own `_cols/_rows`
(`packages/codev/src/terminal/session-screen.ts:139-142`). So the issue body's "classifies at
`session.info.cols/rows`" is one step stale — but the conclusion is unchanged and in fact
*sharper*: the mirror's geometry is set from exactly two places, and both take Tower's
believed dims on faith.

**2. Both of those places commit before the resize is known to have landed.**

- `PtySession.resize()` (`packages/codev/src/terminal/pty-session.ts:567-583`) assigns
  `this.cols`/`this.rows` at `:568-569` and resizes the gate mirror at `:572` — *then* at
  `:575` calls `this.shellperClient.resize(...)`, which returns `false` when the socket is
  gone (`packages/codev/src/terminal/shellper-client.ts:460-464`). On that `false`, Tower's
  dims and the classification mirror have moved and the kernel winsize has not. Every caller
  discards the boolean: `agent-farm/servers/tower-websocket.ts:80`,
  `terminal/pty-manager.ts:243` (`resizeSession`) and `terminal/pty-manager.ts:373`.
- `packages/codev/src/terminal/pty-session.ts:488` creates the mirror lazily at first output
  with `new SessionScreen(this.cols, this.rows)` — so a dropped resize that mutated
  `this.cols` also poisons a mirror born *later*, including the one seeded on re-attach.

**3. Nothing ever reconciles Tower's belief against the process.** The shellper knows the
truth and already reports it: `ShellperProcess` caches the last RESIZE
(`packages/codev/src/terminal/shellper-process.ts:447-459`), re-applies it across a SPAWN
relaunch (`:495`), and advertises `cols`/`rows` in every WELCOME frame (`:386-387`).
`ShellperClient` parses that WELCOME (`shellper-client.ts:342-381`) and adopts `command`/
`args`/`lastDataAt` from it — but **drops `cols`/`rows` on the floor**. `attachShellper`
(`pty-session.ts:216`) therefore seeds the mirror at whatever Tower last believed, which
after a Tower restart is a value restored from the DB, not measured.

**4. `shellper-main.ts:89` is the weakest of the four claims.** `ptyInstance?.resize()` can
only no-op between `this.pty = this.createPty()` and `this.pty.spawn(...)` in
`ShellperProcess.spawnPty` — synchronous and adjacent, so the window is effectively closed in
practice, and `ShellperProcess.handleResize` already guards on `this.pty && !this.exited` and
caches the dims for the next spawn. It is still an unreported drop, and it is cheap to make
truthful, so it is in scope — but the plan does not pretend it is the live defect.

### The second, separable half of the issue: the verdict detail dies at the DB edge

`GateVerdict.detail` (`agent-farm/servers/render-gate.ts:135`) already distinguishes the safe,
intended hold (`user-text` — a human is at the line) from the defect class (`no-region-end` /
`no-composer-marker` — the classifier could not verify anything). It is carried in memory on
`DeliveryOutcome.detail` (`mailbox-delivery.ts:355`) and feeds the classifier-stuck liveness
net (`:368-373`, `:1147`). It then dies: the mailbox row's `reason` CHECK admits only
`busy | no-profile | no-live-pty` (`agent-farm/db/schema.ts:269`), so `afx inbox`
(`agent-farm/commands/inbox.ts:137,170`), the send response
(`agent-farm/servers/tower-routes.ts:2246-2262`), the held log lines
(`tower-routes.ts:1640-1644`, `mailbox-delivery.ts:1051-1053`), the escalation broadcast
(`mailbox-wiring.ts:414-425`) and the owner starvation notice
(`mailbox-wiring.ts:328-336`) all show a bare `busy`. In the field these two situations are
indistinguishable, which is precisely why F1 sat latent.

Per #1483's landing order this diagnostic slice lands **first** and must stand on its own:
it is what makes the rest of workstream A field-diagnosable.

### Root cause, stated once

Tower treats a *requested* geometry as an *applied* geometry. The gate's correctness rests on
the mirror wrapping identically to the real TUI, so an unverified assignment in `resize()` —
plus the absence of any reconciliation against the one component that knows the truth — turns
a dropped socket write into a permanent, invisible delivery outage.

## Proposed Change

Four phases, each a commit in one PR. Phase 1 is the #1483 "first slice" and is coherent
alone; phases 2–4 are the dims hardening.

### Phase 1 — Persist the gate detail on the held row and surface it everywhere

- **Migration v18** (`GLOBAL_CURRENT_VERSION` 17 → 18): `ALTER TABLE mailbox ADD COLUMN
  detail TEXT`, PRAGMA-gated exactly like v16/v17 (a blanket try/catch would record a real
  ALTER failure as migrated). Mirror the column in `GLOBAL_SCHEMA`.
  **Deliberately no CHECK constraint**, because SQLite cannot add one via `ALTER TABLE`: a
  CHECK in `GLOBAL_SCHEMA` would make a fresh install and an upgraded install structurally
  different, and the migration suite's convergence invariant is what would catch that. The
  value set is enforced in TypeScript (`MailboxGateDetail`), matching the precedent set by
  `command` (v16) and `not_before` (v17), both of which are CHECK-less for the same reason.
- **One write, not two.** Replace `setHeldReason` with `setHeldVerdict(db, id, reason, detail,
  now)` writing both columns in one statement, still `status='held'`-guarded, and only when
  `(reason, detail)` actually changed — so `updated_at` continues to mean "when the verdict
  last moved". `markDelivered` clears `detail` alongside `reason`.
- **`detail` is only ever the gate's.** The `hold(reason)` helper
  (`mailbox-delivery.ts:554-558`) — used for `no-live-pty`, `no-profile`, and the post-classify
  token/settle re-holds — writes `detail = null`, so a stale detail can never outlive the
  verdict that produced it. Only the not-clean branch at `:594-600` persists a detail.
- **Surfaces** (all read the persisted column, so a Tower restart does not lose it):
  - `afx inbox` list: render a compound `reason:detail` cell (`busy:user-text`,
    `busy:no-region-end`) and widen the REASON column from 13 to 20 — the longest value,
    `busy:no-composer-marker`, is truncated to `busy:no-composer-…`, and every other value
    fits. Chosen over a fifth column because the table is already at five and PR #1486 is
    concurrently widening FROM → TO (see Risks).
  - `afx inbox show <id>`: a `Detail` kv line under `Reason`.
  - Send response JSON (`tower-routes.ts` held branches at `:1633-1657` and `:2246-2262`):
    additive `detail` field; `afx send` prints `held (busy: user-text)`.
  - Held / escalation log lines: append the detail.
  - `mailbox-escalation` SSE payload: additive `detail` on `MailboxEscalationPayload`
    (`packages/types/src/sse.ts:37-45`).
  - `HeldMessage` (`packages/types/src/api.ts:608-629`) and the `/api/inbox` projection
    (`tower-routes.ts:2315-2325`): additive `detail`.
  - Dashboard held-mail popover (`apps/web/src/components/HeldCountBadge.tsx:60-78`): render
    the same compound cell, so the popover and `afx inbox` never disagree.
- **The "composer occupied since" hint.** `HeldOwnerNoticeInfo` gains `detail` and `streak`;
  `findStarvingAgents` carries a representative `MAX(detail) AS detail` alongside its existing
  `MAX(reason)`; `noticeOverdue` reads the agent's consecutive not-clean count straight off the
  drainer's existing `notCleanStreak` map (no new state, no new column). `formatOwnerNoticeBody`
  then says one of two different things:
  - `user-text` → "composer OCCUPIED ~Xm (confirmed N consecutive checks) — a draft or menu is
    on the line. This is usually a human at the keyboard; `afx interrupt` clears it."
  - `no-region-end` / `no-composer-marker` → "the classifier CANNOT verify this composer
    (`<detail>`) — a drifted profile, a torn frame, or a dims divergence. This will not clear
    on its own."
  That is the whole point of the slice: the remedy differs, so the notice must too.

### Phase 2 — Make `resize()` tell the truth

- `PtySession.resize()` becomes: attempt the resize first; commit `this.cols`/`this.rows` and
  `this._gateScreen?.resize(...)` **only** on success; return the boolean unchanged.
- Keep the *requested* geometry in new private `_requestedCols`/`_requestedRows`, seeded from
  the constructor dims and updated on every call (successful or not). `spawn()`
  (`pty-session.ts:183-188`) uses the requested pair, so a resize that arrives before the
  process exists is still honoured at spawn time — that is the one behaviour the naive
  "just don't assign" fix would regress. `this.cols`/`this.rows` — what `info`, the gate mirror
  and every consumer read — now mean **applied**, and are documented as such.
- Callers stop discarding the boolean: `tower-websocket.ts:76-82` and `pty-manager.ts:373` log
  a WARN naming the session and the dropped geometry; `pty-manager.resizeSession`
  (`:240-245`) returns `null` on a dropped resize so its REST caller
  (`tower-routes.ts:978`, `pty-manager.ts:480`) answers 409 rather than echoing back dims the
  process never adopted. (`resizeSession` already returns `null` for an unknown id, so the
  route's error path exists; the message distinguishes the two.)
- `shellper-main.ts:88-90`: when `ptyInstance` is undefined, stash the dims and apply them in
  `spawn()` instead of dropping them. Narrow, and it makes the adapter's contract honest.

### Phase 3 — Reconcile against the process that knows

- `ShellperClient` exposes `welcomeCols`/`welcomeRows`, populated from the WELCOME frame
  exactly as `welcomeCommand`/`welcomeArgs` are today (`shellper-client.ts:187-193`,
  `:342-381`) — same nullable-getter shape, so nothing else changes.
- `attachShellper` (`pty-session.ts:216`) adopts those dims into `this.cols`/`this.rows`
  **before** it seeds the mirror, when the client reports them. The shellper is authoritative
  for the kernel winsize; Tower's restored-from-DB value is a guess. This is where a Tower
  restart currently bakes in a wrong geometry for the life of the session.
- Immediately after adopting, if the *requested* geometry differs from the adopted one,
  re-send that resize through the (now truthful) `resize()` — so a viewer's geometry still
  wins, but only once the process has actually taken it.
- A single WARN when adopted ≠ believed, naming both pairs: this is the log line that would
  have made F1 self-evident in the field.

### Phase 4 — Pin the sensitivity, and the fix, with tests

Characterization plus regression (details in Test Plan). No production code.

## Files to Change

**Phase 1**
- `packages/codev/src/agent-farm/db/migrations.ts:29` — `GLOBAL_CURRENT_VERSION` → 18; new v18 block after `:543`.
- `packages/codev/src/agent-farm/db/schema.ts:269` — add `detail TEXT` to the mailbox CREATE.
- `packages/codev/src/agent-farm/db/types.ts:93,115` — `MailboxGateDetail` type; `DbMailbox.detail`.
- `packages/codev/src/agent-farm/db/mailbox.ts:242-249,261-268,340-353` — `markDelivered` clears detail; `setHeldReason` → `setHeldVerdict`; `MAX(detail)` in `findStarvingAgents` + `StarvingAgent.detail`.
- `packages/codev/src/agent-farm/db/index.ts:186` — re-export the new type/function names.
- `packages/codev/src/agent-farm/servers/mailbox-delivery.ts:554-558,594-600,1034-1060,1087-1117,1124-1150` — persist detail on the gate hold, null it on every other hold, carry `detail`+`streak` into `HeldOwnerNoticeInfo`, include detail in the escalation log/broadcast.
- `packages/codev/src/agent-farm/servers/mailbox-wiring.ts:328-336,414-425` — two-branch notice body; `detail` on the broadcast payload.
- `packages/codev/src/agent-farm/servers/tower-routes.ts:1633-1657,2246-2262,2311-2325` — `detail` in both held responses, both held log lines, and the `/api/inbox` projection.
- `packages/codev/src/agent-farm/commands/inbox.ts:26,64,121,137,170` — `detail` on the row types, widened REASON column, compound cell, `Detail` kv.
- `packages/codev/src/agent-farm/commands/send.ts:347-351,391-395` — show the detail in the held message.
- `packages/types/src/api.ts:608-629`, `packages/types/src/sse.ts:37-45` — `detail` on `HeldMessage` and `MailboxEscalationPayload`.
- `apps/web/src/components/HeldCountBadge.tsx:60-78` — compound reason cell.

**Phase 2**
- `packages/codev/src/terminal/pty-session.ts:183-188,488,567-583` — requested-vs-applied dims; commit-on-success.
- `packages/codev/src/terminal/pty-manager.ts:240-245,373` — honour the boolean.
- `packages/codev/src/agent-farm/servers/tower-websocket.ts:76-82` — WARN on a dropped resize.
- `packages/codev/src/agent-farm/servers/tower-routes.ts:978` — 409 on a dropped resize.
- `packages/codev/src/terminal/shellper-main.ts:88-90` — pending-resize applied at spawn.

**Phase 3**
- `packages/codev/src/terminal/shellper-client.ts:56,82-88,151-152,187-193,342-381` — `welcomeCols`/`welcomeRows` (and the `IShellperClient` interface).
- `packages/codev/src/terminal/pty-session.ts:216-262` — adopt-then-reconcile on attach.

**Phase 4 (tests)**
- `packages/codev/src/agent-farm/__tests__/spec-1313-migration.test.ts` — v18 against the real `runGlobalMigrations`.
- `packages/codev/src/agent-farm/__tests__/mailbox.test.ts`, `send-delivery.test.ts` — detail persistence + surfacing.
- `packages/codev/src/agent-farm/__tests__/render-gate.test.ts` — dims-sensitivity characterization.
- `packages/codev/src/terminal/__tests__/` — new `pty-session-resize.test.ts`; `pty-manager.test.ts:40-47` updated for the boolean contract.
- `apps/web/__tests__/HeldCountBadge.test.tsx` — compound cell.
- `codev/state/pir-1482_thread.md` — builder log, committed with the PR.

## Risks & Alternatives Considered

- **Risk: adopting WELCOME dims makes the shellper authoritative over a live viewer.** A
  viewer's geometry must still win. Mitigated by adopting only at attach and then immediately
  re-sending the requested geometry, so the steady state is still viewer-driven — the adoption
  only fixes the window where Tower has *no* measurement.
- **Risk: `resizeSession` returning `null` on a dropped resize changes an API's meaning.**
  Today `null` means "no such session"; it will also mean "resize not applied". Both are
  already 4xx/409-shaped at the route, and `pty-manager.test.ts:47` pins only the unknown-id
  case. The alternative — a `{ info, applied }` shape — is cleaner but ripples into two route
  handlers and the terminal REST contract for no field benefit. Revisit if a caller ever needs
  to distinguish them.
- **Risk: migration v18 collides with another in-flight v18.** `GLOBAL_CURRENT_VERSION` is 17
  at `main` and no open sibling PR touches `db/`. Re-checked immediately before the PR.
- **Risk: merge conflicts with parked sibling PRs.** #1491 owns `render-gate.ts` /
  `gate-profiles.ts` / `render-gate.test.ts`; #1486 owns `commands/inbox.ts` (it de-truncates
  FROM → TO), `commands/send.ts`, `tower-routes.ts`, `utils/message-format.ts`. This branch
  touches `inbox.ts`, `send.ts`, `tower-routes.ts` and `render-gate.test.ts`, so overlap is
  real. Mitigations: branch from `main` (never from those branches); make no *behavioural*
  change to `render-gate.ts` itself (Phase 4 only adds a test); keep the inbox change to the
  REASON column so #1486's FROM → TO widening merges as an adjacent edit.
- **Risk: a UI change needs browser verification** (project rule). The dashboard edit is one
  compound string in an existing component with existing tests; it will be verified in a
  browser via the worktree dev server. If the worktree cannot run the dashboard, the fallback
  is to keep the additive `HeldMessage.detail` field and drop the render change — I will say
  so at the gate rather than claim a verification I did not do.
- **Alternative: make the classifier dims-robust** (scan for the region end with tolerance, or
  classify at several geometries). Rejected — it weakens the fail-toward-hold invariant that
  the whole gate rests on, and it treats the symptom. The dims *should* be right.
- **Alternative: a `dims-unverified` gate verdict/detail.** Rejected as scope creep: once
  Phase 3 reconciles at attach and Phase 2 refuses to commit an unapplied resize, there is no
  steady state left that the new detail would name. Reconsider only if Phase 4's tests show
  a residual window.
- **Alternative: a `detail_since` column for the "occupied since" hint.** Rejected —
  `setHeldVerdict`'s changed-only guard already makes `updated_at` the moment the verdict last
  moved, and the drainer's existing streak counter supplies the confirmation count.

## Test Plan

**Unit / integration (vitest)**

1. *Migration v18* — drive the real `runGlobalMigrations` from a v17 fixture; assert the
   `detail` column exists, is nullable, that a fresh `GLOBAL_SCHEMA` database and an upgraded
   one converge on the same `PRAGMA table_info(mailbox)`, and that a second run is a no-op.
2. *Detail persistence* — a gate hold with each `GateVerdict.detail` writes that value;
   `no-live-pty`/`no-profile`/token-re-hold write `null`; delivery clears both columns; the
   changed-only guard leaves `updated_at` alone when the verdict repeats.
3. *Surfacing* — `/api/inbox` projects `detail`; the held send response carries it; the
   escalation broadcast carries it; the owner notice body takes the `user-text` branch for a
   human-at-the-line and the classifier-can't-verify branch for `no-region-end`, and quotes the
   streak count.
4. *Resize truth* — with a shellper client whose `resize()` returns `false`: `PtySession.resize`
   returns `false`, `session.cols/rows` are **unchanged**, and the gate mirror's geometry is
   unchanged. With `true`: both move. A resize before `spawn()` is still applied at spawn.
   `pty-manager.resizeSession` returns `null` on a dropped resize and still returns `null` for
   an unknown id.
5. *Attach reconciliation* — a client whose WELCOME reports 139×63 while Tower believes 104×101:
   after `attachShellper`, the session and the mirror are at 139×63, the mismatch is logged, and
   the requested geometry is re-sent once.
6. *Dims-sensitivity characterization* — classify the committed `claude-smallring-idle`
   fixture (139×63) at its true dims and at ±2 rows / ±4 cols, asserting the verdict flips. This
   test does not change behaviour; it is the executable statement of *why* phases 2–3 matter, and
   it will fail loudly if a future change makes the classifier silently dims-insensitive.
   It reuses an already-committed gzipped fixture — nothing new is copied out of
   `codev/spir-1313-captures/` (read-only reference material; the raw multi-MB binaries stay out
   of the PR).

**Manual (reviewer, at `dev-approval`)**

- `afx send <a-busy-builder> "test"` → `afx inbox` shows `busy:user-text`; `afx inbox show <id>`
  shows a `Detail` line. Send to an agent whose composer is mid-repaint → `busy:no-region-end`.
- Leave a message held past the owner-notice threshold → the architect's notice names the
  occupied-composer case and its confirmation count, not a bare `busy`.
- Resize a terminal in the dashboard/VSCode viewer; confirm the session's reported dims track
  it and no WARN fires. Then kill the shellper socket, resize again, and confirm the WARN fires
  and the session's dims do **not** move.
- Restart Tower with a live shellper at a non-default geometry and confirm the adopted dims
  match the shellper's, and that a held message to that agent delivers.
- Dashboard held-mail popover (browser, per `codev/resources/testing-guide.md`): the row shows
  the same compound reason the CLI does.

**Cross-platform** — n/a (server + CLI; the one web change is a text render with no
platform-specific behaviour).
