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

Focused tests 40/40, tsc clean. Full suite green (306/6134). Advanced to PR phase.

## PR phase — PR #1689 + PR-CMAP + fixes

PR #1689 opened (Fixes #1629). PR-CMAP: Gemini APPROVE, Codex REQUEST_CHANGES, Claude
REQUEST_CHANGES. Both requesters found REAL guard-correctness defects (deeper analysis on
the full diff), not scope creep — fixed both:

1. Claude: the `owner.port === myPort` shortcut skipped the probe, but a wildcard bind
   (0.0.0.0:P, a bridge owner) and a loopback bind (127.0.0.1:P, second Tower) COEXIST
   on the same port — verified empirically (both listen() succeed, libuv). So a bridge
   owner was hijacked. Fix: the shortcut now also requires `owner.bindHost === myBindHost`
   (an identical bind is exclusive → proves the prior owner gone); a differing interface
   falls through to pid+probe, which detects the live wildcard owner.
2. Codex: the claim was a blind read→probe→upsert (TOCTOU) — two cold-start contenders
   could both overwrite the singleton and proceed. Fix: acquisition is now atomic — an
   empty table is claimed with a plain INSERT (singleton PK makes a second inserter lose
   and re-evaluate), a stale owner is taken over with a compare-and-set guarded on the
   observed row, and a lost race re-evaluates behind the winner. Invariant preserved:
   never overwrite a LIVE owner. Added a two-connection (shared file DB) regression:
   second contender refuses behind the first live claim, duplicate singleton INSERT
   throws, and CAS take-over of a stale row.

ownerIsLive signature now (owner, myPort, myBindHost, deps). Owner tests 33/33, tsc clean.
Non-blocking (documented, not fixed): mixed-version Towers (an old binary predating v19
ignores tower_owner) stay unguarded — unavoidable, note in review.

## PR-CMAP iter 2 + 3 (converging), then hand-off at gate

iter 2: Gemini APPROVE, Claude APPROVE, Codex RC (the resolveContendedClaim blind-upsert
after a lost CAS). Fixed: bounded read→liveness→CAS retry that FAILS CLOSED on persistent
contention (never blind-overwrites); + probe 5xx→'unreachable'; + resolveProbeHost handles
IPv6 [::]. Deterministic churning-probe regression added. Pushed (commit 3470b9d3e).

iter 3: Gemini APPROVE, Claude APPROVE, Codex RC — NEW point: the same-address shortcut
(owner.port==myPort && bindHost match → claim) is unsafe during GRACEFUL SHUTDOWN: the old
Tower closes its listener (step 1) but stays alive until process.exit (step 9), so a
same-host:port restart in that window binds OK, hits the shortcut, and claims/reconciles
while the old Tower is still alive.

WHY THIS IS THE ARCHITECT'S CALL (not a solo fix):
1. The two reviewers pull OPPOSITE directions on the same-address case. Codex: refuse when
   same-address pid is alive. Claude (iter 3): that refusal WEDGES on a recycled pid (a
   "phantom owner") with no --force/clear escape hatch. Resolving BOTH correctly needs a
   process-identity check (is owner.pid actually a tower-server?) — clear scope growth past
   the architect's "guard + tests, no scope growth" bound, and it couples db→process census.
2. SEVERITY is low: during GRACEFUL shutdown the old Tower does NOT delete terminal_sessions
   rows (explicit code comment), so the overlap is a transient shellper handoff to the new
   (legitimate) Tower, NOT the data-loss incident. The actual #1629 incident (different-port
   test Tower vs long-running production Tower serving /health) is fully fixed.
3. Two HIGH-confidence APPROVEs; Codex's items across rounds have narrowed to edges.

RECOMMENDATION to architect: ship the guard (resolves the incident) and file a follow-up
"owner-lock robustness" issue for: (a) graceful-shutdown same-address overlap via a
pid-is-a-tower identity check, (b) a --force/clear-owner escape hatch for a wedged/phantom
owner (Claude), (c) surface the conflict message to the CLI (afx tower start daemonizes, so
the loud error only lands in tower.log — the operator who caused it never sees it, Claude).
Handed off at the pr gate for the human decision.

## Architect ruling (gate)

Recommendation ACCEPTED: guard merges as-is on Amr's approval. Robustness triple filed as a
follow-up (my analysis credited), with a reorder — CLI-surfacing of the refusal is item 1
and most urgent (today a refused start reads as the generic ~30s timeout from the user's
chair, indistinguishable from #1685). Items 2 (shutdown-overlap pid-is-a-tower identity
check) + 3 (clear-owner/--force hatch) are COUPLED — ship together or not at all, per
Claude's phantom-pid warning. Recorded the Codex RC + this disposition in the PR #1689 body.
Holding at the pr gate; Amr's words cover 1687 then 1689. On approval: porch approve … pr →
gh pr merge 1689 --merge (no --delete-branch) → verify.
