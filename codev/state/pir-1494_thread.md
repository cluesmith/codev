# pir-1494 builder thread

## Issue
vscode: approval gates relay through spawning architect instead of `porch approve` directly.
Deliberately the SMALL version (owner chose it over #1194, closed). Reuse `client.sendMessage` +
`spawnedByArchitect`; no new frame/bus/sender-type/Tower surface.

## Plan phase (2026-08-18)
Wrote `codev/plans/1494-vscode-approval-gates-should-r.md`. Key decisions:
- Routing via pure `decideApprovalRelay(owner, liveArchitectNames)` → 4-way union: relay /
  refuse-offline / refuse-unknown-owner / direct-fallback(CLI-only, announced). No `|| 'main'`
  (that's #1406 — misrouted approval is materially worse than a misrouted status line).
- `held` is first-class: on held relay the approval has NOT happened; UI must not say "approved".
  Wording changes click semantics from "Approved" → "Relayed / Held / Failed".
- Role-doc correction framed per architect's two mid-turn corrections:
  - FOUR positions, not three. builder.md is NOT stale — it names the human (Cmd+K G) for PIR,
    accurate today; #1494 changes the PIR actor human→architect.
  - architect.md:32-45 is a straight defect (contradicts PIR's 5 prompt locations) — fix regardless.
  - Scope = PIR + two role docs ONLY. SPIR/AIR/ASPIR left to builder.md default. Narrow-vs-uniform
    is an OPEN QUESTION routed to owner via main architect.
  - pir-1070 citation precise: only the PR gate deviated (architect inserted builder); plan+dev
    gates were human-typed correctly. Commit author does NOT prove actor (shared git identity, #1457
    gap). Architect's account is the evidence.
- dev-approval will demand REAL e2e (relay reaches architect, architect runs porch approve, builder
  advances) — unit tests alone rejected. Held case must be demonstrated too.

Two route-to-main items delineated in the plan for main to act on before the plan gate:
(1) role-doc correction, (2) null/unregistered routing table.

## Status
Plan committed. Awaiting plan-approval gate (Amr owns all three gates; I never run porch approve).
