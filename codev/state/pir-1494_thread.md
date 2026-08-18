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

## REVIEW-PHASE MATERIAL (architect, capture in codev/reviews/1494 — do NOT lose)
Two instances, DIFFERENT failure modes, pair stronger than either alone. Frame as demonstration, NOT mea culpa.
- **pir-1070**: structural guarantee BYPASSED — porch state produced from prose typed into a builder's
  pane, so the record stopped being independent evidence and became a copy of what it exists to check.
  Precondition for the self-merge class. NEVER say a self-merge occurred; no unauthorized merge happened.
- **pir-1494 (this lane, tonight)**: guarantee NOT bypassed — a human genuinely decided ("approve 1494"
  verbatim in the architect's channel, replying to a status report that named the residual he approved)
  and an architect genuinely carried it — and the RECORD still could not demonstrate it. porch stores
  approved_at, never approved_by (#1457), so the state machine can't settle it either. Correct conduct,
  unprovable afterward. The lane whose whole purpose is human-traceable gate decisions had its OWN plan
  gate reach a reviewer as an unverifiable assertion, inside a system structurally unable to answer.
- Together: the gap is NOT a discipline problem — one instance had a defect in the chain, one had none,
  neither settleable from the artifact.
- **Process correction (load-bearing for the convention this lane writes)**: full provenance was given
  on a pr gate but not a plan gate (merge felt irreversible, plan routine). That distinction should not
  exist. An attestation is for the RECORD, not for the risk; a record that only exists for irreversible
  acts is not a record. Plan and dev gates get the SAME treatment as pr.

## Implement phase (2026-08-18)
Gate approved (Amr "approve 1494" → architect ran porch approve, uniform rule in action). porch at
implement. Building exactly the approved plan incl. the item-2 residual (Amr approved it knowingly) —
NOT reopening option (a), NOT improving the residual away. pir-1497 (merged) converged on REFUSE for
the same routing question; my table is consistent. At pr gate expect a FREEZE (don't narrate through).
CI has a hung job: Artifact-Canvas Browser Tests (#1502, no timeout) — if board sits on that, not my
lane; tell architect, don't retry.

## Implement complete → dev-approval gate (2026-08-18)
Built exactly the approved plan. Code: approve.ts relayApproval + pure decideApprovalRelay (4 branches)
+ buildRelayMessage + interpretRelayResult (held first-class); runPorchApprove kept ONLY for the
no-live-architect fallback (reworded, liveness-truthful). Tests: approve-relay.test.ts, 15 new. Docs:
uniform rule in architect.md (defect fix + VS Code on-receipt) + builder.md (rewrite) + pir/builder-
prompt.md:46 (one-sentence), all mirrored to codev-skeleton (twins byte-identical). BUGFIX untouched.
Checks: full vitest 873 green, tsc (both configs) clean, eslint clean, esbuild bundle builds. porch
build+tests green → dev-approval pending.

Note: porch build check first failed on `Cannot find module 'three'` — a STALE-DEPS issue (three is
declared at packages/codev/package.json:70 but wasn't in this worktree's node_modules after the
rebase). Fixed with `pnpm install` (legitimate setup, NOT routing around a check; unrelated to my
diff). Separate from the #1502 hung CI job the architect flagged.

## dev-approval evidence — capture + HONEST scope split (architect requires real e2e, not unit-only)
Capturable from builder shell (real): 15 relay-core unit tests; full 873 suite; tsc+lint+esbuild;
AND tonight's live proof of the SECOND half of the button's chain — the architect ran porch approve
carrying Amr's decision and THIS builder's plan-approval gate advanced (porch next → implement). The
relay TRANSPORT is the same Tower /api/send mailbox path every `afx send architect` this session used
(delivered/held). This builder has spawnedByArchitect set + architect live → the `relay` branch fires.
Needs the HUMAN's VS Code window (cannot come from builder shell): the literal button click (sidebar ✓
/ Cmd+K G / gate toast) invoking codev.approveGate in an Extension Development Host against a live
blocked builder, observing the relay land in the architect terminal. Loading the extension UI is not
a builder-shell action; stated plainly rather than claimed.

## DESIGN REVERSAL (2026-08-18) — Amr ruled builder-runs-it (opposite of the relayed uniform ruling)
At dev-approval Amr reviewed the built (architect-runs-it) version and chose the OPPOSITE unification:
- VS Code button relays a SHORT human-style notice to the spawning architect (no porch command).
  Message (option B): "Human approved the <gate> gate for <id> (#<issue>) in VS Code."
- Architect RELAYS to the builder (does not run porch).
- Builder runs porch approve — matching SPIR/AIR (roles/builder.md default).
Rationale (Amr): minimal blast radius, no role-md churn, porch runs in the builder's worktree.
vscode architect stood down, confirmed "follow Amr," is raising its objection to Amr directly (not
through me), and told me: don't carry its dissent into code/comments.

### TRADEOFF TO RECORD IN codev/reviews/1494 (architect's explicit request — state plainly, don't soften, don't editorialize)
BUGFIX's canon (bugfix/protocol.md:38) — "the merge trigger is porch state rather than free text
typed into the builder's pane... a builder cannot infer authorization from ambiguous prose" — is
KNOWINGLY NOT extended to the other protocols under this decision. PIR's own protocol.md:35-37 states
the SAME principle for its pr gate; builder-runs-it reverses it (the builder now records porch state
from the architect's relayed prose = inferring authorization from prose, the exact self-merge
precondition the passage names). The owner accepted this tradeoff with the argument in front of him.
Record it as a decision-with-reasoning so it stays revisitable. Two instances remain relevant
(pir-1070 bypass, pir-1494 unprovable-record) — keep those too.

### PIR change is BIGGER than "5 lines" — surfaced to Amr for confirmation before cutting:
- 5 prohibition lines (builder-prompt.md:46, plan.md:117, implement.md:143, review.md:243, protocol.md:42).
- PLUS protocol.md:35-37 — PIR's flagship self-merge/structural-authorization rationale, becomes false.
- PLUS roles/builder.md parenthetical ("PIR's gates are typed by the human reviewer, via Cmd+K G")
  becomes false when prohibitions are stripped — a NEW two-texts-disagree instance (the exact defect
  this lane fixes). Role-doc scope Amr forbade → asking him, not fixing unilaterally (architect concurred).

## FINAL builder-runs-it implementation (2026-08-18) — reworked from architect-runs-it at Amr's direction
Resolved all open items with Amr at the gate:
- **Message** = option B (short, human-style, no porch): "Human approved the <gate> gate for <id> (#<issue>) in VS Code."
- **approve.ts**: buildRelayMessage simplified to option B; interpretRelayResult reworded (sent/held/failed,
  "they'll pass it on to the builder", never "approved"); routing (4 branches) + held-first-class kept.
  Tests updated. 872 suite green, tsc+lint clean, esbuild builds.
- **roles/architect.md**: REVERTED to original (untouched) — it already said "relay; the builder runs the
  command", which IS the builder-runs-it design. No change needed. Vindicates the minimal approach.
- **roles/builder.md**: removed the PIR carve-out parenthetical ("PIR's gates are typed by the human via
  Cmd+K G") so PIR inherits the "you run it" default like SPIR (Amr chose option a). This was the one
  authorized role-doc edit — it fixes the two-texts-disagree contradiction the rework would otherwise ship.
- **PIR prompts** (both trees): all 5 prohibitions reframed to "run porch approve only when the architect
  relays the human's approval, never on your own initiative" (builder-prompt.md:46, plan.md:117,
  implement.md:143, review.md:243, protocol.md:41); protocol.md:35-36 self-merge rationale reworked to
  describe the mechanism without the now-false "porch state independent of prose" claim.
- Final consistency: architect relays → builder runs it, stated coherently across architect.md (relay),
  builder.md (default + defer to phase prompts), PIR prompts (run when relayed). Matches SPIR.

OPEN: issue #1494 AC still says "architect runs it / builder not in chain" (the reverted design). Need to
annotate the issue that the shipped design is builder-runs-it. Asked Amr whether to edit AC or add a comment.

REVIEW-ARTIFACT TODO still stands (see TRADEOFF block above): record that BUGFIX's structural-authorization
canon is knowingly NOT extended to PIR/others; owner accepted with the argument in front of him.

## E2E bug found + fixed (2026-08-18) — relay message was passive, architect misread it as "done"
Amr's real VS Code test: architect received "Human approved the plan review gate for 158 (#158) in
VS Code", read it as a COMPLETED FACT, said "all plans approved" and never relayed → builders stuck
at plan-approval (nothing ran porch approve). Root cause = the message, not the code path.
Fixes to buildRelayMessage:
- Imperative, not past-tense: "Approve the <gate> gate for <id>, please pass it to the builder (via VS Code)."
- "please pass it to the builder" cue is LOAD-BEARING: without it "Approve X" reads as "architect, you
  approve it" → architect runs porch itself (architect-runs-it, wrong cwd/#1235). The cue pins it to
  builder-runs-it.
- "(via VS Code)" provenance at the very end (Amr's placement).
- id/issueId dedup: no more "158 (#158)" (only append (#issue) when id doesn't already contain it).
- No em dashes (Amr feedback: applies to generated strings too, not just prose).
16 relay-core tests green, tsc/lint/esbuild clean.

## Status
Implement committed (92a4ee58f code+tests, a60bcb2bb docs) + pushed. dev-approval gate PENDING. Amr
owns dev-approval + pr; architect relays; I never run porch approve.
