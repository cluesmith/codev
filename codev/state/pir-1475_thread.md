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
