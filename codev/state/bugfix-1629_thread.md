# bugfix-1629 — a second Tower against a live global.db hijacks + deletes production shellper sessions

Protocol: BUGFIX (strict). Issue #1629.

## Investigate phase

### The incident (from the issue, verified against tower.log + global.db)
A test Tower started on port 14733 from a builder worktree exported `AGENT_FARM_DIR`
instead of `CODEV_AGENT_FARM_DIR` (#1515), so it opened the *production*
`~/.agent-farm/global.db`. Its startup reconcile connected to all 56 live production
shellper sockets (stealing them from the real Tower on 4100), then deleted 53 of 56
`terminal_sessions` rows. Recovery was manual (copy rows back from the checkpointed main
DB file). Two independent defects.

### Root cause — Defect #1 (no owner lock → hijack)
- `AGENT_FARM_DIR` (packages/core/src/constants.ts:18) resolves from env
  `CODEV_AGENT_FARM_DIR`, NOT `AGENT_FARM_DIR`. Exporting the wrong name is a no-op → the
  test Tower resolved to `~/.agent-farm` = production. `getGlobalDbPath()`
  (db/index.ts:122) → `resolve(AGENT_FARM_DIR, 'global.db')`.
- Nothing in `ensureGlobalDatabase` (db/index.ts:133) or `bootSequence`
  (tower-server.ts:496) checks whether another live Tower already owns this DB. The port
  bind (tower-server.ts:467) is a SAME-PORT mutex only (comment at :402). The test Tower
  on a different port (14733) bound fine and opened the shared DB.
- `reconcileTerminalSessions` (tower-terminals.ts:621) then read all rows and reconnected
  to their shellper sockets. A shellper holds ONE client, so the real Tower lost them all.

### Root cause — Defect #2 (reconcile deletes rows it merely failed to attach)
- Phase 1: `reconnectSession` (tower-terminals.ts:762) returns null on a *failed connect*
  (transient contention here). Code logs "stale (PID/socket dead) — will clean up"
  (:803) and does NOT add the id to `matchedSessionIds`.
- Phase 2 sweep (:920-937): any row not matched → `process.kill(session.pid, SIGTERM)`
  (:930) + `DELETE FROM terminal_sessions` (:935). It only guards on `manager.getSession`
  (in-memory, empty on a fresh Tower). It does NOT verify the shellper pid is dead or the
  socket file is gone. Live-but-momentarily-unreachable shellpers get SIGTERM'd + deleted.

### Fix design (guard = the required 3.3.4 deliverable)
DB owner-lock record in a new singleton `tower_owner` table (pid, port, hostname,
started_at, db_dir) — the record travels with the DB file, which is exactly the shared
resource being contended. At boot, BEFORE reconcile:
1. Read the existing owner record.
2. If present AND live (owner pid alive AND a Tower answers `/health` on owner.port),
   refuse to start LOUDLY (exit 1), naming the owner pid/port and the AGENT_FARM_DIR vs
   CODEV_AGENT_FARM_DIR mistake.
3. Else (no record, or stale from a dead Tower — self-clears) claim ownership.
Liveness via HTTP `/health` probe (unauthenticated per server-utils.ts:151) handles the
recycled-pid false positive and, critically, the different-port second Tower.
- Legitimate single-Tower restart: same-port EADDRINUSE handles the still-alive case; a
  crashed Tower leaves a dead pid → stale → self-clears. No regression.
- Test isolation (`CODEV_AGENT_FARM_DIR`) unaffected: an isolated DB has no production
  owner record.

### Scope
Guard + migration v19 + tests: ~180-220 LOC, well under BUGFIX's 300 ceiling.
Defect #2 (reconcile delete hardening) is a SEPARATE code path. Architect's 3.3.4 rider
was "guard + tests, no scope growth" → proposing defect #2 be spun off as its own issue.
Asked architect to confirm before implementing. #1685 lane is concurrently touching
startup — will flag if I collide on tower-server.ts.

Signal: PHASE_COMPLETE (guard fits BUGFIX).

## Fix phase

Architect confirmed guard-only; defect #2 filed separately (credited to this investigation).

Implemented:
- `db/tower-owner.ts` (new): singleton owner record read/write/release, Tower-shaped
  `/health` liveness probe, `ownerIsLive` decision seam (injectable isAlive/probe),
  `claimGlobalDbOwnership` guard, and a loud teaching `ownershipConflictMessage`.
- `db/schema.ts` + `db/migrations.ts`: `tower_owner` table; migration v19;
  GLOBAL_CURRENT_VERSION 18 → 19.
- `servers/tower-server.ts`: guard is the FIRST thing in `bootSequence` (before
  consolidation/reconcile/killOrphanedShellpers — all of which touch the shared DB,
  sockets, or production shellpers). Refuse → log ERROR + exit(1). Also releases the
  owner record (pid-scoped) on graceful shutdown.

Decision rule (`ownerIsLive`): claim if (owner.port == myPort) OR (owner pid dead) OR
(/health on owner.port is not Tower-shaped); refuse only when owner pid alive AND a
Tower answers /health on a DIFFERENT port. Dead owner self-clears → legitimate restart
never blocked. Same-port live conflict is already caught by EADDRINUSE before boot.

Known accepted edge (for the review): a ~20s window where owner A is still mid-boot
(its /health held by the readiness gate) — a second Tower could claim then. The
realistic incident is a manually-started test Tower vs a long-running production Tower
that IS serving /health, so this is out of scope; a stronger OS-lock is a possible
follow-up but would be scope growth.

Tests: `bugfix-1629-tower-owner.test.ts` (19 assertions incl. real http /health probe:
tower-shaped vs garbage vs nothing-listening; the incident refuse; dead-owner + garbage
self-clear; recycled-pid; same-port; pid-scoped release) and `bugfix-1629-migration.test.ts`
(v19 create/singleton-CHECK/idempotent/fresh-schema convergence). Updated the
send-architect-identity source guard 18 → 19. Build green; migration whole-chain
convergence green.

Files touched: db/tower-owner.ts (new), db/schema.ts, db/migrations.ts,
servers/tower-server.ts, 2 new tests, send-architect-identity.test.ts. No
codev-skeleton mirror (server code is package-only, not skeleton). No #1685 collision
avoided beyond tower-server.ts bootSequence top + gracefulShutdown tail — will note to
architect.

## CMAP iter 1 (impl) + hardening

Verdicts: Gemini APPROVE (no issues); Claude COMMENT; Codex REQUEST_CHANGES. Both
Codex + Claude (HIGH confidence) converged on ONE real defect: the /health probe
FAILED OPEN — a 1.5s budget against a /health that shells out to `ps -A` (5s, verified
process-census.ts:62) + getInstances() would time out under the incident's load (60+
shellpers) and resolve to "stale, claim it" → hijack proceeds. Same for the owner's
~20s mid-boot window. Verified both claims against source before acting.

Hardened (guard now fails CLOSED):
- Replaced boolean `towerHealthResponds` with tri-state `probeTowerHealth` →
  'tower' | 'gone' | 'unreachable'. Budget 1.5s → 6s (only paid on the conflict path).
  200-healthy OR 503 STARTING_UP → 'tower' (live, incl. mid-boot). ECONNREFUSED or a
  non-Tower HTTP response → 'gone' (claim). Timeout / other transport error →
  'unreachable'.
- `ownerIsLive`: refuse when probe != 'gone' (i.e. 'tower' OR 'unreachable' = live).
  Only a positive proof of absence ('gone') claims. Dead pid still short-circuits →
  legitimate restart unaffected.
- `readTowerOwner`: rethrow anything but "no such table" (was swallow-all → fail open).
  bootSequence's catch exits(1) = fail closed on a real DB error.
- Added boot-order SOURCE guard test (claim precedes reconcile/consolidation/
  killOrphanedShellpers; refusal calls process.exit(1)) — pattern from
  send-architect-identity.test.ts; scoped to the bootSequence() slice to skip comment
  refs. Added 503-STARTING_UP='tower' and unreachable→refuse test cases. Source guard
  now also asserts Migration v19.

Deferred with rationale (both reviewers ranked minor/low):
- TOCTOU read→probe→write not atomic: only bites a sub-second SIMULTANEOUS two-Tower
  start (not the incident shape). Documented.
- Probe hardcodes 127.0.0.1: covers default loopback + bridge 0.0.0.0 (accepts
  loopback); a non-loopback-ONLY bind is a rare config. Documented.

Re-verified: build exit 0; focused tests 35/35; tsc clean on my files. Full suite green
(306 files / 6129 tests).

## CMAP iter 2 (impl) + bridge-host fix

Verdicts: Gemini APPROVE, Claude APPROVE, Codex COMMENT (downgraded from REQUEST_CHANGES
— fail-open blocker resolved). Codex's one remaining point (HIGH): the probe hardcoded
127.0.0.1, so a Tower bound only to a specific non-loopback BRIDGE_TOWER_HOST would get
ECONNREFUSED → 'gone' → claim → "permits the original destructive behavior."

Fixed (v19 is unshipped in this PR, so the table was extended in place — no migration
churn): added `bind_host` to tower_owner (schema + v19), TowerOwner.bindHost, persisted
from tower-server's bindHost, and a `resolveProbeHost` that probes the recorded bind host
(wildcard 0.0.0.0/:: → loopback; a specific bridge host is probed directly). Probe
signature is now (host, port). Added tests: resolveProbeHost mapping, bind-host persist,
bridge-host detection, and ownerIsLive probes the resolved host.

Claude's non-blocking suggestions, deliberately NOT taken (documented for the reviewer):
- e2e two-Tower-same-DB test: covered by the source-order guard + decision matrix; a real
  double-Tower e2e is heavy/flaky — skipped as a suggestion.
- wedged-owner recovery doc: the conflict message already points at `afx tower stop` and
  the named pid; the wedged case (recycled live pid + unreachable port) is rare.
- conflict message prints dir not file path; shutdown release ordering: negligible.

Focused tests 40/40, tsc clean. Rebuild + full suite pending, then porch done + PR.
