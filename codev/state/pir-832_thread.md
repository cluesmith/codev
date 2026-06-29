# PIR #832 — Multi-architect conversation resume via per-architect session UUID

## Phase: plan (in progress)

### What this is
Follow-up to #830. Main-architect conversation resume shipped via jsonl-discovery
(newest `*.jsonl` by mtime). That heuristic can't disambiguate named sibling
architects (Spec 755) because they share `cwd = workspacePath` — all their jsonls
land in the same encoded-cwd dir. Fix: persist a per-architect Claude session UUID
in the `architect` state.db row; pass `--session-id <uuid>` at spawn and
`--resume <uuid>` at every revive surface.

### Investigation findings
- claude CLI confirmed to support both `--session-id <uuid>` and `-r/--resume [value]`
  (verified via `claude --help`). Resume WITHOUT `--fork-session` keeps the same
  session id, so a stored UUID stays valid across unlimited revivals.
- Three revive surfaces, all need the same lookup branch:
  1. `tower-instances.ts launchInstance` (main cold-spawn) — currently uses
     `findLatestSessionId` + `safeToResume = getArchitects().length <= 1` guard
     (the guard this issue removes).
  2. `tower-instances.ts addArchitect` (sibling cold-spawn + sibling reconcile loop) —
     currently NO resume (deliberate in #830).
  3. `tower-terminals.ts reconcileTerminalSessions` ~L636-679 (shellper auto-restart
     options bake) — currently `buildArchitectArgs` only, no resume. This is the
     silent-context-loss path (claude crash inside a live shellper).
- `removeArchitect` calls `setArchitectByName(..., null)` which DELETEs the whole
  row → UUID cleared automatically (satisfies "removal-clears-UUID").
- DB migrations are at v11; add v12 `ALTER TABLE architect ADD COLUMN claude_session_id TEXT`.
- `findLatestSessionId` stays (builders/#831 still use it via spawn.ts); only main
  stops using it.

### Design decisions to flag at plan gate
- Main loses jsonl-discovery fallback → one-time context loss on the FIRST reboot
  after this lands (legacy row has no stored UUID). Accepted per issue's
  Backwards-compat section. Hybrid alternative (keep jsonl fallback for main when
  count<=1) considered + rejected to keep the path uniform.
- setArchitect/setArchitectByName switched to COALESCE-preserving upsert so a
  later row update that omits the UUID can't wipe it (mirrors upsertBuilder's
  spawned_by_architect COALESCE pattern).

Plan written to codev/plans/832-multi-architect-conversation-r.md.

### Plan revision 1 (answering architect: "consistent approach for recovering architects?")
Tightened the design into one uniform model + fixed a real gap:
- **Consistency rule**: UUID minted exactly once at cold-spawn; every other surface
  only reads it. Single `resolveArchitectLaunch(...)` helper in
  claude-session-discovery.ts, called by all three sites (no per-site branch drift).
  `mintIfAbsent: true` for cold-spawn (launchInstance/addArchitect), false for the
  shellper-restart bake.
- **Gap fixed**: stored UUID whose jsonl was pruned would make `--resume` fail.
  Added `sessionFileExists` guard → resume only when the jsonl exists, else re-mint
  (cold) / role-inject (restart). Makes stored-UUID resume as safe as #830's
  jsonl-discovery. claude-session-discovery.ts now hosts BOTH builder discovery and
  architect resume, documented side by side.

### Plan revision 2 (architect chose STATELESS approach)
Architect asked "can we avoid DB updates?" → chose stateless derived session IDs.
Rewrote plan: NO db column, NO migration v12, NO schema/state.ts/types changes.
- sessionId = UUIDv5(ARCHITECT_NS, canonicalWorkspacePath + ':' + name) — pure
  function (node:crypto sha1, no new dep). Name in the key → siblings sharing cwd
  derive distinct IDs (solves the collision jsonl-discovery couldn't).
- Every site recomputes + resolveArchitectLaunch: jsonl exists → --resume, else
  --session-id (create at derived id). No store step anywhere.
- removeArchitect prunes the derived jsonl so remove-then-readd is fresh.
- Architect Q: "why is main recoverable but siblings not today?" → it's cwd-based,
  not capability-based. findLatestSessionId picks newest jsonl in the cwd's project
  dir; unique cwd (main-only, or builders) → recency disambiguates; shared cwd
  (siblings) → it can't. In multi-arch workspaces main ALSO skips resume (safeToResume
  guard). Fix puts NAME into the key.

### Empirical verification (architect Q: "do we control the IDs?")
Ran headless claude in a temp dir:
- `claude --print --session-id <v5-uuid>` → jsonl written at OUR exact id. We control it.
- `claude --print --resume <same-id>` → recalled prior turn, SAME jsonl grew
  (10977→13505 B), no fork. Resume-by-chosen-id works.
- v5 uuid derived with node:crypto sha1 only → no new dependency needed.
Load-bearing assumption confirmed. Promoted from risk → fact in plan.

### Backward-compat / main-recovery analysis (architect Qs)
- Backward compatible: yes. No migration/state/schema. v4 (existing, claude-random)
  and v5 (our derived) jsonls coexist (different uuid version space). Rollback-safe:
  old Tower can --resume any id incl v5; new Tower ignores old v4 files.
- Main impact: today main runs WITHOUT --session-id → history is a random v4 jsonl.
  First post-upgrade restart: derived v5 id has no jsonl → fresh (one-time loss),
  then deterministic forever. Same one-time loss the DB-column approach would've had.
- Verified sessionId is EMBEDDED in jsonl content (== filename) → can't adopt main's
  v4 history by renaming to <v5>.jsonl. So one-time loss is unavoidable w/o a hybrid.
- After the one restart main recovery is MORE robust than today (newest-by-mtime can
  grab a stray manual `claude` session in the same dir; derived id can't) + main newly
  recovers in multi-arch workspaces.
- Open decision for architect: accept one-time main loss (clean unified) vs hybrid
  (keep jsonl-discovery for main → zero loss but keeps safeToResume + 2 mechanisms).
- Recalled original DB proposal: architect.claude_session_id col + migration v12 +
  db/types + types + state.ts setters; spawn stored a random v4 uuid, revive read it.

### Plan revision 3 (architect: keep #830 discovery as a fallback for main)
Adopted. Reframed the count-check: #830 used getArchitects()<=1 to DISABLE main's
resume when siblings exist (the bug); we reuse it to SELECT mechanism — main recovers
in BOTH branches.
- Lone main (single-arch): discoveryFallback ON → #830 newest-by-mtime resume. ZERO
  loss for existing main users (keeps resuming its v4 conversation as today).
- Multi-arch main + all siblings: derived v5 id (discovery ambiguous there).
- Only fresh-spawn for main now is the single→multi crossing instant (discovery
  ambiguous → fresh is the only safe option anyway). Siblings fresh only on first-ever
  revival (no regression — never recovered before).
- Helper gains discoveryFallback?:boolean; launchInstance(main) passes
  getArchitects()<=1; addArchitect + restart-bake pass false.
- Deliberate, architect-approved deviation from issue's "remove the guard entirely"
  letter; the guard's GOAL (main recovers in multi-arch) is still met.

## Phase: implement (started)
plan-approval gate approved by human. Implementing the stateless derived-id design
with #830 discovery fallback for lone main.

## Implement phase — done
Implemented stateless derived-id design + #830 discovery fallback for lone main.
- claude-session-discovery.ts: architectSessionId (UUIDv5 via node:crypto, no dep),
  sessionFileExists, deleteArchitectSessionFile, ARCHITECT_SESSION_NAMESPACE const.
- tower-utils.ts: resolveArchitectLaunch (derived-id resume → discovery fallback →
  fresh; canonicalizes workspacePath via realpath so id/existence match claude's cwd).
- tower-instances.ts: launchInstance(main, discoveryFallback=getArchitects<=1) +
  addArchitect(sibling, no fallback) call helper; removeArchitect prunes derived jsonl.
- tower-terminals.ts: BOTH restart-bake sites (startup reconcile + on-the-fly
  reconnect) call helper; added isLoneMainArchitect() so a crash-restart of lone
  legacy main keeps its v4 conversation (silent-context-loss path closed).
- Refinement beyond literal plan: restart bake gives lone main the discovery
  fallback too (plan said derived-only); without it an in-process crash would drop
  main's pre-#832 conversation. Faithful to issue's "second silent path" goal.
- Layering: resolveArchitectLaunch lives in tower-utils (server layer, needs
  buildArchitectArgs), pure id/path helpers in claude-session-discovery (utils).
Build: green. Tests: full suite 3390 passed / 48 skipped / 0 failed. 25 in
tower-utils.test.ts, helper tests in claude-session-discovery.test.ts.
Verified --session-id/--resume control empirically earlier. Pushing for dev-approval.

## Implement phase — PIVOT to DB approach (architect feedback at dev-approval gate)
Architect reviewed the stateless derived-id impl and called it fragile. Empirically
confirmed claude REQUIRES a valid UUID for --session-id ("Invalid session ID. Must be
a valid UUID." for a plain string), which is why derivation had to fabricate one.
Pivoting to: persist the REAL session id in the architect DB row.

Decisions locked:
- Column is AGENT-NEUTRAL `session_id` (NOT claude_session_id) — codex-as-architect
  is a live path (#1059). Resume mechanics route through HarnessProvider.session
  (newSessionArgs/resumeArgs/captureRunningSession); claude implements, others omit
  → graceful fresh spawn. No claude flags in Tower code.
- Spawn: generate crypto.randomUUID() → --session-id → store in session_id. New
  architects restart-safe from birth. Revive: read stored id → --resume.
- DROP discoverLatestSession / all jsonl discovery from spawn/revive path.
- removeArchitect: row delete clears id (no jsonl prune). Simpler than derived.
- Backfill: `afx workspace stop --capture-sessions` (TRANSITIONAL, one-off, removable
  later — architect confirmed no long-term role). Captures live ids of pre-#832
  running architects before kill so start resumes them. Tower-side
  captureArchitectSessions before deactivateWorkspace. Disambiguation: single-arch →
  findLatestSessionId (no lsof); multi-arch → lsof process-subtree → open jsonl.
  shannon workspace has 5 live architects → multi-arch capture genuinely needed.
- DB: session_id column + migration v12 (additive ALTER, idempotent). No COALESCE
  (no partial updates — caller graph verified earlier).

NEXT: revert the stateless implementation commits, implement DB+capture approach.
Plan rewritten + committed. Code still holds stateless impl pending revert.

## DB approach implemented (replaces stateless impl)
All committed. Build green, full suite 3392 passed / 48 skipped / 0 failed.
- DB: types.ts ArchitectState.sessionId; db/types DbArchitect.session_id + converter;
  schema.ts column; migration v12 (idempotent ALTER); state.ts setters write it.
- harness.ts: HarnessProvider.session {newSessionArgs, resumeArgs, captureRunningSession};
  CLAUDE_HARNESS implements; codex/gemini/opencode omit → graceful fresh.
- claude-session-discovery.ts: removed derived helpers; added captureRunningClaudeSession
  (process-subtree lsof correlation → open jsonl; sole-architect → findLatestSessionId).
- tower-utils resolveArchitectLaunch: stored id → resume; else mint uuid + --session-id;
  returns sessionId to persist; no-session harness → plain fresh, null.
- tower-instances: launchInstance(main) + addArchitect read stored id (defensive try/catch
  so state.db read failure → fresh), persist returned id; removeArchitect row-delete clears;
  captureArchitectSessions(workspacePath) added (skips already-known + no-session agents).
- tower-terminals: both restart-bake sites read stored id → resume (inside existing try).
- CLI: workspace stop --capture-sessions → stop({captureSessions}) → client.captureArchitectSessions
  → POST /api/workspaces/:p/capture-sessions → captureArchitectSessions. Marked transitional.
- Tests: state round-trip + removal-clears + sibling-distinct; harness capability;
  resolveArchitectLaunch decision (resume/mint/no-session/baseArgs-order); capture fallback.
  lsof success path = manual integration test at dev-approval gate.

## Follow-up filed
#1112 (area/tower): unify builder conversation resume onto the persisted
session_id + harness.session mechanism from #832, retiring jsonl-discovery.
Scoped OUT of #832 (builders work today via unique-cwd jsonl-discovery — not a bug,
just a consistency/robustness improvement). Storage location (builders.session_id vs
shared terminal_sessions.session_id) left open in the issue.

## Backfill restructured: script instead of CLI flag/API (architect feedback)
Architect objected to --capture-sessions polluting CLI/API namespace for a one-off.
Removed: cli.ts flag, stop.ts capture block, tower-routes /capture-sessions route,
core tower-client.captureArchitectSessions method, tower-instances
captureArchitectSessions fn (+ its getArchitectHarness import).
Added: packages/codev/scripts/backfill-architect-sessions.ts (run via tsx) —
library-only, reads architect pids from global.db terminal_sessions, resolves live id
via harness.session.captureRunningSession, writes via new targeted
state.setArchitectSessionId (session_id-only UPDATE, race-safe vs live Tower).
captureRunningClaudeSession helper unchanged. Build green, suite 3394 passed.
Script type-checked via one-off tsconfig (scripts/ is outside the tsc build include).

## Removed captureRunningSession from HarnessProvider interface (architect feedback)
Architect: capture is backfill-only, shouldn't pollute the permanent agent interface.
- HarnessProvider.session now = { newSessionArgs, resumeArgs } only (steady-state).
- CLAUDE_HARNESS.session drops captureRunningSession; harness.ts drops the
  captureRunningClaudeSession import.
- Script calls captureRunningClaudeSession DIRECTLY (it's Claude-specific +
  transitional, lives in claude-session-discovery.ts), gated on !!harness.session
  (permanent capability = "is this agent resumable at all"). Non-Claude → no ~/.claude
  jsonl → null → skipped anyway.
Build green, suite 3394 passed.

## Added --dry-run to backfill script (architect request)
backfill-architect-sessions.ts now accepts --dry-run: performs the full read-only
resolution (lsof/findLatestSessionId are read-only anyway) and prints the exact
session id each architect WOULD get, skipping only the setArchitectSessionId write.
Banner: "[DRY RUN — no changes written]" + "Would capture (...)". Smoke-tested via
tsx in an isolated test DB (empty workspace early-returns; flag parsed cleanly).

## Added --all to backfill script (architect request)
backfill-architect-sessions.ts now supports --all: enumerates every workspace with
architects via `SELECT DISTINCT workspace_path FROM terminal_sessions WHERE
type='architect'` (precise set; getKnownWorkspacePaths()/listWorkspaces() exist but
are broader). Refactored to backfillWorkspace(ws, dryRun) + per-workspace printResult;
--all composes with --dry-run. Smoke-tested --all --dry-run in isolated DB (0 ws).

## Backfill reworked to Option B: Tower-mediated writes (architect chose B)
Architect: the script reaching around Tower into a cwd-derived state.db is the smell.
Implemented Option B — single-writer via the owning Tower:
- NEW narrow route PUT /api/workspaces/:ws/architects/:name/session-id ->
  handleSetArchitectSessionId -> setArchitectSessionId (targeted UPDATE). Transitional.
- NEW TowerClient.setArchitectSessionId(ws,name,id).
- Script rewritten as a thin Tower client: listWorkspaces (--all) / getWorkspaceStatus
  (live architect name+pid) + captureRunningClaudeSession (lsof) + the setter. NO
  state.db/config/global.db imports -> no cwd coupling, runs from anywhere.
- Dropped the stored-sessionId skip (would've needed session_id on the WIRE
  ArchitectState in @cluesmith/codev-types — two distinct ArchitectState types!).
  Instead captures every live architect; non-Claude -> null -> skip; already-#832 ->
  same id -> idempotent re-write.
Build green, suite 3394 passed, script type-checks. Plan + Files-to-Change updated.
Note: like all variants, only works once Tower runs #832 code (endpoint must exist).

## Added resume log line (architect request, for e2e verification)
resolveArchitectLaunch now returns resumed:boolean. All 4 callers (launchInstance main,
addArchitect, both tower-terminals restart-bake sites) log INFO
"Resuming architect '<name>' session <id8>… in <ws>" when a stored id is resumed.
Makes Phase 1/2 of e2e test eyeball-able from Tower logs. Tests assert resumed flag.
Build green, suite 3394 passed.

## Reworked backfill capture: read session id off the command line (architect feedback)
Architect asked why the backfill couldn't identify sibling sessions. Root cause
captured empirically against live agents: Claude does NOT hold its session jsonl
open (lsof -p <claude> | grep .claude -> empty; lsof +D over the project dir -> no
holder), so the lsof process->open-file correlation found nothing — every prior
"success" was purely the sole-architect newest-by-mtime fallback. The dashboard/
VSCode identify architects by terminalId (PTY handle), NOT by Claude conversation
UUID, so that mechanism can't be reused for --resume.
Fix: capture now reads --session-id/--resume <uuid> straight off the process
subtree's command line (exact, works for siblings sharing a cwd; the id is on the
claude proc space-separated AND on the shellper parent inside the JSON args blob).
Removed the lsof path (+ basename import). Kept the sole-architect mtime fallback
for legacy fresh spawns; a pre-#832 SIBLING returns null and self-heals on its first
#832 revival. Extracted pure extractSessionIdFromCmdline(cmdline) helper + 8 unit
tests (space form, resume form, shellper JSON form, =form, lowercasing, bare-prose
null, no-flag null, glued-token null). Backfill skip message now explains WHY per
case. Build green; claude-session-discovery suite 20 passed.

## Dropped the backfill layer entirely; restored sole-architect jsonl fallback (architect decision)
Architect reasoned: if pre-#832 siblings are unrecoverable (Claude holds no jsonl fd;
no robust pid→jsonl bridge) and the backfill could only ever rescue main — which #830
ALREADY self-recovered via jsonl-discovery (a path THIS branch had removed) — then the
clean fix is to not remove it. Verified via git: base (#830) launchInstance used
`safeToResume = getArchitects()<=1; resumeSessionId = safeToResume ? findLatestSessionId : null`;
my branch had replaced that with stored-id-only (no fallback), so a legacy main would
lose context once. Decision: restore the fallback, delete the whole backfill layer.
Changes:
- launchInstance (main): storedSessionId = row.sessionId ?? (getArchitects()<=1 ?
  findLatestSessionId(workspacePath) : null). resolveArchitectLaunch persists the
  resolved id back onto the row → discovered id self-migrates into the stored-UUID path
  on the same revival (no manual step). The <=1 check no longer gates resume wholesale
  (the #830 bug) — it gates ONLY the legacy jsonl fallback; stored-UUID resume applies
  regardless of architect count. Re-added findLatestSessionId import.
- Deleted: scripts/backfill-architect-sessions.ts, state.setArchitectSessionId, PUT
  /api/workspaces/:ws/architects/:name/session-id route + handleSetArchitectSessionId,
  TowerClient.setArchitectSessionId, captureRunningClaudeSession +
  extractSessionIdFromCmdline + processSubtree + execCapture (claude-session-discovery.ts,
  + execFileSync import), and their tests (capture + extract describes, 2 state setter
  tests). Fixed stale backfill comment in tower-terminals.ts.
- Siblings (addArchitect) keep storedSessionId ?? null (no jsonl — shared cwd ambiguous);
  restart-bake sites keep stored-id-or-fresh (no jsonl fallback, matches #830). Both
  self-heal once for legacy rows.
- Plan rewritten: Revision note 2 documents the pivot; summary, Legacy-bridge section,
  Files/Risks/Test sections updated; removed backfill/lsof/capture references.
Core builds, codev builds, full suite 3389 passed | 48 skipped (was 3402; -13 removed
backfill tests). Net simpler than both the original plan and the prior branch state.
