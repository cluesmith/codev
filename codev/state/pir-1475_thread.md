# pir-1475 — Architect identity: hydrate from the WELCOME frame

Builder thread. Issue #1475 (`area/tower`), PIR protocol, strict mode.

## Spawn constraints (from the architect, 2026-08-18)

- **We are not cluesmith/codev maintainers.** The PR needs a maintainer/reviewer approval and the
  **maintainer merges**. When the protocol completes, **park the PR open** — never merge, never
  close #1475.
- The issue body is dated 2026-08-17 and `main` has moved — verify its claims against current code
  before planning. (Done; see below.)

## Plan phase (2026-08-18)

Investigated the seam end to end before writing anything. Findings:

- **Every claim in the issue still holds** against branch base `c2db0d70d` (`main` @ `9129ab81c`).
  Migration v16 is at `db/index.ts:575`; the legacy self-heal is the `?? restartOptions?.command`
  at `tower-terminals.ts:786` and `:1004`; `WelcomeMessage` (`shellper-protocol.ts:74-102`) carries
  no identity fields. Nothing on `main` since 2026-08-17 touches this area — last commits to these
  files are the #1313 merge and PIR #1354's mirror seeding.
- **The codebase names this fix itself.** `mailbox-wiring.ts:151-161` documents the stale-identity
  hazard and says "the authoritative fix is WELCOME-frame hydration". That comment is a deliverable
  of this project — it has to be rewritten once the fix lands.
- **Do NOT bump `PROTOCOL_VERSION`.** `shellper-client.ts:223-227` rejects a shellper whose version
  is *lower* than Tower's, so a bump would disconnect every live pre-upgrade shellper on the first
  restart after upgrade — killing running sessions. The additive-optional-field pattern
  (`lastDataAt` #1198, `alwaysSendsReplay` #1215) is the established compatible extension and is
  what the plan uses. This is the single biggest trap in this change.
- **Two reconcile sites, not one** — startup adoption (`tower-terminals.ts:786/833`) and on-the-fly
  reconnect (`:1004/1049`) — plus the fresh-launch site in `tower-instances.ts:637-653`. Missing one
  would leave identity authoritative on some restart paths and not others.
- **Real drift closed**, not hypothetical: (a) a pre-v16 NULL row healed from *current* config while
  the live PTY runs the *old* harness; (b) in-flight relaunches via `session.client.spawn(...)` —
  the #1149 crash-loop fallback and #1264 clean-exit rerun swap argv without rewriting the DB row.
- **Deliberate non-goal**: builders launch through `.builder-start.sh`, so their WELCOME reports the
  wrapper — same as today, and the `harnessFromLaunchScript` backstop still carries it. The plan
  carries an explicit no-regression test for that path rather than pretending it improves.

Plan written to `codev/plans/1475-architect-identity-hydrate-fro.md` (6 layers: protocol → shellper
→ client → PtySession → persist-back → comment/doc truth-up). Sitting at the `plan-approval` gate.

## Plan revision 2 — 3-way review (2026-08-18)

Architect relayed a consolidated 3-way: gemini APPROVE / codex REQUEST_CHANGES / claude
REQUEST_CHANGES. I re-verified every finding against source before amending (not taken on trust);
all eight held. Two were genuinely blocking and both were **defects in my design, not nitpicks**:

1. **Snapshot-at-attach would have gone stale.** I had `attachShellper` *copy* the client's
   identity. An ordinary SPAWN relaunch replaces the PTY with no reconnect, so `attachShellper`
   never re-runs — the copy would freeze at the pre-relaunch value, defeating the very seam I
   listed as motivation. Now read-through: `this.shellperClient?.welcomeCommand ?? config`.
   `detachShellper` already nulls the client, so degradation is free.
   *Calibration I had wrong in the other direction*: both relaunch paths swap **args/env only**
   (`session.options.command` is never mutated, session-manager.ts:1187), and `resolveProfile`
   ignores args — so this closes a structural hazard, not a live drift. Plan no longer oversells it.
2. **Persist-back would have written `''` and permanently killed the legacy self-heal.**
   `createSessionRaw` defaults `command: opts.command ?? ''` (pty-manager.ts:156). Legacy NULL row
   + legacy shellper → `ptySession.command === ''` → saving that turns a healable NULL into `''`,
   and the heal is `??`, which does not catch `''`. That would have been a regression *introduced*
   in the exact path #1313 fixed. Now `ptySession.command || null` with a round-trip test.

Other verified corrections: **7** production `attachShellper` sites, not 3 (I had missed
`tower-server.ts:541`, the in-place `session-reconnected` re-attach — which is now the only place
`updateTerminalCommand` is used, since the reconcile sites DELETE+re-save the row and would wipe
it); interface members made **optional** because `tower-shellper-integration.test.ts:21` is a real
`implements` while five other doubles are `as unknown as` casts yielding `undefined`; and my
trust-boundary claim was **wrong** — `resolveProfile` matches by substring, so a garbled command
containing `claude` resolves a REAL profile. Socket is 0600, not 0700.

**One rebuttal** (codex #3, SPAWN-time row persistence): the row can go stale after a relaunch, but
it is never *observable* — `terminal_sessions.command` is read only at the two reconcile paths,
both of which attach a fresh client whose WELCOME supersedes it and then persist the correction.
The obvious hooks would not even work: `session-fresh-restart`/`session-restart` fire *before* the
delayed `client.spawn()`. Pinned with a test instead of new terminal→DB event plumbing.

Amended plan committed; architect will present it at the gate.

## Implement phase (2026-08-18)

plan-approval approved by the human (rev 2, ba15d2723); codex-#3 rebuttal accepted. Implemented in
four commits: protocol/shellper/client → PtySession read-through → persist-back → tests/docs.

Notes for whoever picks this up:

- **The worktree had no `node_modules`.** This repo ships no `.codev/config.json`, so worktrees get
  no `symlinks`/`postSpawn` install (see the `runnable-worktrees` skill for what a configured repo
  would do). Ran `pnpm install --frozen-lockfile` at the worktree root, then
  `pnpm --filter "@cluesmith/codev^..." build` — without the second step `tsc` reports ~100 bogus
  errors against `TowerClient`, because codev-sdk/codev-types are unbuilt, not because anything is
  wrong. Binaries land in `packages/codev/node_modules/.bin/`.
- **`persistableCommand` lives in `tower-utils.ts`, not `tower-terminals.ts`.** The plan put it in
  the latter; `tower-terminals` already imports `tower-instances`, so exporting from there and
  importing into `tower-instances` would have closed an import cycle. `tower-utils` is leaf-ward and
  already imported by all four consumers. Deviation from the plan's file list, same behavior.
- **Two reconcile sites needed a hoisted `identitySeed`.** Passing `persistableCommand(ptySession)`
  straight into the save would have dropped the Spec 1313 heal in the edge case where
  `manager.getSession()` returns undefined — there is no session to read identity from, so the seed
  is the only value left. Now `ptySession ? persistableCommand(ptySession) : identitySeed`.
- **Fresh-launch sites use `?? cmd` / `?? command` / `?? shellCmd`.** Hydration is a no-op there
  (the shellper echoes what we just asked for), but routing them through the same accessor keeps one
  rule at every persist site: the row records what is RUNNING, not what was requested.
- Two of the new tests are real regression tests, not decoration: the SPAWN-relaunch case fails
  against a snapshot-at-attach implementation, and the legacy-NULL case fails against a naive
  persist. Both were written to fail first against the design I originally proposed.

## Dev-approval evidence (2026-08-18)

The architect pushed back on my first dev-approval request: dev-approval is PIR's *tested-running*
gate, and "4943 tests pass" is not evidence that the thing runs. Right call — scripting the plan's
Manual section against a real Tower found a bug the whole unit suite missed.

`packages/codev/scripts/pir-1475-dev-approval-evidence.mts` spawns THIS worktree's built
`tower-server.js` on private ports 14782/14783 (`NODE_ENV=test`, `AF_TEST_DB=test-1475-<port>.db`,
its own `SHELLPER_SOCKET_DIR`), registers real shellper-backed PTYs and drives the real HTTP
endpoints — nothing about the identity path is stubbed. Transcript committed at
`codev/evidence/1475-dev-approval-transcript.txt`: **23/23 checks, 0 skips**, and the live Tower on
4100 asserted untouched before and after.

**The bug the evidence caught.** My bounded validation capped each WELCOME argument at 4096 bytes
and rejected the identity *atomically*. Architects launch as
`claude --session-id <uuid> --append-system-prompt "<entire role doc>"` — one argument several KB
long. Every architect tripped the cap and silently fell back to `source=config`: precisely the
sessions this feature exists to make authoritative, and precisely the `afx send architect` case
#1313 was about. The fix bounds the **aggregate** args size (512 KB) instead of each argument,
keeping the count bound (256) and the PATH_MAX-shaped command bound. Regression test:
"accepts a REAL architect argv, whose system prompt is several KB in one argument".

Lesson for the review: *a bound that rejects atomically must be sized against the largest real
input, not the typical one* — and a unit suite that builds its own fixtures will never tell you
what the real input is.

**Also added**: `logSessionIdentity()` in `tower-utils.ts`, wired at every attach site. The plan's
Manual step 3 promised an "identity hydrated from WELCOME" log line and the implementation had only
an ad-hoc one at `session-reconnected`. It is the line an operator wants when `afx send` holds
`no-profile`: what the gate thinks is running, whether that came from the process or the fallback,
and what the row held going in.

**One fixture trap, worth knowing.** Step 5's relaunched harness looked dead (`status=exited`,
delivery held `no-live-pty` forever). Not a Tower bug: `PtySession.startRestartWait` clears
`exitCode` on the respawned child's first `data` event (#1264), and my shim was a bare `cat`, which
prints nothing on startup. Real harnesses paint their UI. The canonical shim now paints its
composer, and `status=running` after the relaunch became evidence in its own right. The script also
resets its own `test-1475-*.db` per run — stale held rows from earlier runs were emitting
starvation notices for dead workspaces into the transcript.

Step 5 still cannot show the identity VALUE changing across a relaunch, because neither production
relaunch path mutates `session.options.command` (#1338). The transcript says so in a `note`; the
read-through-vs-snapshot distinction is pinned by the unit test instead. Keep it honest.
