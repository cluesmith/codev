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

## Plan revision (2026-08-18, at gate) — owner ruled UNIFORM
Four mid-turn architect corrections landed while at gate; revised the plan:
- **UNIFORM ruling** (supersedes earlier narrow-vs-uniform open question, now removed): the ARCHITECT
  runs porch approve carrying the human's decision, every protocol, every gate; the BUILDER never
  runs it (human may always run their own shell). Both role docs state the rule directly.
- **Anchor** = bugfix/protocol.md:38-42 "The gate exists to make merge authorization structural"
  (porch state independent of prose; closes self-merge class). Cite it; don't invent per-protocol
  wording. BUGFIX is the one that got it right — DO NOT rewrite bugfix/prompts/pr.md:64 (already
  "architect approves").
- **pir-1070 framed EXACTLY** (architect overstated twice, corrected twice): NO unauthorized merge;
  Amr decided and got the merge he wanted; only the pr gate deviated. What failed = the structural
  GUARANTEE (porch state was produced FROM prose = a transcription, not independent evidence). It's
  the PRECONDITION for the self-merge class, silent. Phrase: "the guarantee this passage exists to
  provide was not in force." Never "a self-merge occurred." Lesson: hold architect citations to the
  same standard as a reviewer's — verify against artifacts (I verified the anchor + gates + role docs).
- **Packaging**: one lane, one PR (docs + button ship together, no contradiction window). Issue
  relabelled area/cross-cutting; larger review accepted.
- **builder.md:26-28 = REWRITE not patch** (its "by default...unless" structure has no default under
  uniform).
- **Per-protocol verification = plan deliverable**, gates enumerated from protocol.json (authoritative),
  NOT prose grep. Result: edit surface = the TWO role docs only. Every protocol prompt already aligns
  (BUGFIX anchor), forbids builder (PIR), or is covered by universal role-doc rule; spike has no gate
  → no text. release = codev-only, no protocol.json, out of scope. Grep BOTH trees after edits.

## Route-to-main rulings back (2026-08-18) — both resolved
- **Item 1 (role docs): APPROVED.** Kept my agents-vs-human carve-out. Added ONE file per ruling:
  `pir/builder-prompt.md:46` (both trees) one-sentence fix — that line ("the gate stays pending until
  THE HUMAN runs porch approve") is the file whose reading caused the pir-1347 refusal from the other
  direction (a builder could deem an architect-approved gate illegitimate). Keep the "never call it
  yourself" prohibition; drop the human-runs actor claim. Do NOT touch plan.md:117/implement.md:143/
  review.md:243/protocol.md:42 (actor-neutral prohibitions). Edit surface now = 2 role docs + 1 PIR
  builder-prompt sentence, all mirrored both trees.
- **Item 2 (routing): 3 branches APPROVED** (relay, refuse-offline, refuse-unknown-owner, incl.
  refuse-not-reroute + pure-function shape). 4th branch was DEFECTIVE: `overview.architects` is
  LIVENESS not registration (api.ts:298-305), so []==CLI-only is unsound (can't tell from all-down).
  Ruling: prefer registration signal (opt a) if cheaply reachable, else opt (b). **Checked (a): NOT
  reachable** — both /api/overview AND /api/state use the SAME live-filtered `liveArchitects` helper
  (tower-routes.ts:1077/1153/2709); persisted registration table (state.ts getArchitects) is exposed
  over NO client endpoint; surfacing it = new wire data = MAIN's surface, can't add unilaterally.
  → Took **opt (b)**: branch renamed `no-live-architect`; announcement states only liveness ("No live
  architect … no architect will be notified"), never "no architect registered". Residual (all-down
  workspace still direct-approves after honest announcement) stated for the gate. Incidental: the
  DashboardState.architects TYPE COMMENT (api.ts:80-86) claims "registered" but server fills via
  liveArchitects — stale comment, noted not fixed (out of scope).

## Rebase on main (2026-08-18)
Rebased builder/pir-1494 onto origin/main (was 115 commits behind; clean, no conflicts). porch state
intact (still WAITING FOR HUMAN APPROVAL at plan-approval). Re-verified EVERY file:line in the plan:
- approve.ts (:69/:114/:136/:148/:160) and builder-grouping.ts:122 — UNCHANGED (untouched by the 115).
- api.ts spawnedByArchitect :45/:201, overview.architects :305 (+liveness comment :295), DashboardState
  :80-86 — all still exact. sendMessage :774 + held/delivered fields intact.
- Role docs architect.md:39 / builder.md:26, all 5 PIR prompt sites, bugfix anchor protocol.md:38 +
  pr.md:64 — all exact. Twin parity CONFIRMED (all 5 key files byte-identical codev/ vs skeleton).
- Gate enumeration re-run from protocol.json: identical to plan table. release still codev-only.
- ONLY drift: tower-routes.ts liveArchitects call sites shifted → updated plan citations to :1087,
  :1163, :2776 and the getArchitects note to :1080-1081 (+ state.ts:511). api.ts range → :295-305.
- Only 1 of the 115 commits touched a target file: an auth-header rename in tower-client.ts
  (codev-web-key→codev-tower-key) — does NOT affect sendMessage's held/delivered contract.
Plan remains valid; implementation targets stable. Force-pushed rebased branch.

## Rebase on main #2 (2026-08-18)
Rebased again onto origin/main (was 50 behind; clean, no conflicts). porch state intact (plan-approval
pending). git log confirmed NONE of the 50 commits touched any plan target file (approve.ts, send.ts,
gate-toast, tower-client, api.ts, tower-routes.ts, role docs, protocols). Spot-verified anchors:
approve.ts:114/:136, api.ts:295/:305, tower-routes liveArchitects :1163/:2776, builder-grouping:122,
pir/builder-prompt.md:46, bugfix protocol.md:38 + pr.md:64 — all EXACT, no plan edits needed. Force-pushed.

## Status
Plan committed + revised twice + rebased on main (x2). Awaiting plan-approval gate (Amr owns all three
gates; I never run porch approve). Both route-to-main items resolved and recorded. Code change (relay
+ held-first-class) unchanged and re-verified against latest main.
