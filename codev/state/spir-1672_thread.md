# Builder thread: spir-1672 — Lane Card (#1672)

Protocol: SPIR (strict). Owning architect: architect:vscode.

## 2026-09-29 — Specify phase start

Now: reading sources of truth and drafting the spec for the per-lane status card.

- Spawned into the specify phase; no prior spec exists, so I author it from issue #1672 (amended 2026-09-10) + main's routing comment + the vscode architect's lane brief.
- Lane brief rulings (fixed): #1672 alone (companion #1674 not folded in; card must render with the last-ask field absent — first-class test); absorbs #1595 as ONE sdk-side ball-owner/attention-state module near pir-1566 `compareAttention`; data plane rides OverviewCache only (nothing spawns gh); design coexistence of the card row with a future #1729 park chip (don't build it); flag every contract-surface section (types/sdk/core/Tower endpoints) in the spec-gate message for routing to main; respect the pir-1566 file fence; `Now:` convention lands in both trees; spec/plan gates are the owner's alone.
- Kicked off a read-only exploration of OverviewCache, compareAttention/#1595, thread-file writes, porch status.yaml, Tower routing, codev-types, global.db/held messages, afx status/attach, and the #1049 VS Code panel to ground the spec.

### Grounding findings (from exploration)
- OverviewCache: `packages/codev/src/agent-farm/servers/overview.ts:866`; `getOverview()` returns `OverviewData`; staleness via `forgeStatus`/`forgeResetAt` + TTLs. **CI status is NOT cached today** — `OverviewPR` (api.ts:233) carries `reviewStatus`/`isDraft`/`reviewRequests` only. "CI 7/7" is a real design decision under the no-new-gh guardrail.
- Attention: `compareAttention` (#1566) and #1595's working/needs-input/idle/dead states DO NOT EXIST yet. Only bucket-based `deriveAttention`/`isIdleWaiting` in `packages/sdk/src/builder-helpers.ts`. This spec introduces the single sdk-side ball-owner state module and absorbs #1595.
- Thread files: freeform prose, no writer helper. `Now:` is a pure convention on existing writes (matches "no new write moment").
- status.yaml: `parseStatusYaml`/`ParsedStatus` at overview.ts:41-78; gate-requested = `gates[g]==='pending' && gateRequestedAt[g]`. Reusable: detectBlocked/detectBlockedGate/detectBlockedSince/GATE_LABELS.
- Tower routing: `tower-routes.ts` ROUTES table + `/workspace/:enc/*`; security choke `isRequestAllowed`→`isPublicRoute` (server-utils.ts:148). Card endpoint keyed-by-default: just don't add to isPublicRoute.
- Types: `LaneCard` → `packages/types/src/api.ts` (wire-only). global.db `~/.agent-farm/global.db`; held via `db/mailbox.ts`→`heldCount`. Terminal liveness = `lastDataAt`.
- CLI: `afx card` = new `.command('card')`+`commands/card.ts`; `afx status --cards` = option on existing status command (cli.ts:216).
- VS Code host: `apps/vscode/src/contextual-panel/` `ContextualPanelProvider` follows terminal focus, already renders `deriveAttention` as the Attention fallback. Card strip = new descriptor kind. (Not in the pir-1566 fence, but may need 1566 attention-format helpers — flag in plan.)

### Specify iter1 consultation — all three REQUEST_CHANGES (HIGH), strong consensus
Verified the three load-bearing corrections against the tree before acting:
- Route: `/workspace/:ws/lane/:id/card` (non-`api/` subpath) returns TRUE from `isPublicRoute` = PUBLIC. Must be `/workspace/:ws/api/lane/:id/card`. CONFIRMED (server-utils.ts:169-190).
- Forge plane is NOT a GraphQL selection Codev owns; it's per-forge shell scripts (`scripts/forge/{github,gitlab,gitea}/pr-list.sh`, `gh pr list --json`) behind `PrListItem` (forge-contracts.ts:104), with the #1645 capture-then-pipe shape; `gh pr list` is OPEN-only; merged PRs via `MergedPrItem` (:135). CONFIRMED. OQ1 must be restated (CI field on PrListItem, GitHub-first acceptable?).
- `isIdleWaiting`/`deriveAttention` have live consumers (extension.ts:423/484, views/builders.ts:59/60/628, builder-row.ts:63, contextual-panel:185, streamdeck face.ts note). CONFIRMED. SSOT criterion narrowed: module owns the precedence chain; deriveAttention becomes a projection over it.
Other consensus fixes folded: AGENT WORKING must not key on terminal output (contradicted STALLED?); add terminal states (DONE/COMPLETE, DEAD/OFFLINE) so completed lanes don't fall to STALLED?; add draft LaneCard interface + timestamped thread-entry grammar (beats/Now ages need provenance; forge age needs a wire fetched-at field = contract surface); security criteria for path-traversal on :id/:ws and ANSI+HTML escaping of authored Now/beat text; lane→PR resolution rule; EXTERNAL fallback (CI-pending only if OQ5 negative); STALLED? default threshold; afx card no-id resolution; fleet sort tie-breaker; watcher-scale risk row.

## 2026-09-29 — spec-approval gate requested

Now: spec-approval gate REQUESTED (head 83d5acc0b); stopped, awaiting the owner's relayed decision via architect:vscode.

- Consultation resolved in one iteration: revised the spec to fold in all consensus fixes, wrote the rebuttal, porch advanced straight to the gate (no iter2 needed).
- Sent the gate message to architect:vscode with head SHA + what to eyeball + the five contract-surface flags (LaneCard type, sdk module placement + helper-projection disposition, Tower endpoint, OQ1 forge CI field, OQ2 per-source fetchedAt) for routing to main before the plan gate.
- NOT inferring approval from silence. Will run `porch approve 1672 spec-approval` only on the architect's relayed owner word. Still owe the #1595 re-scope comment (will post on ruling or if asked).

## 2026-09-29 — spec review fix + #1595 proposal (pre-gate)

Now: applied architect:vscode's one pre-gate fix (head 2441a0d6d, pushed) and posted the #1595 re-scope proposal; waiting on main's OQ1/OQ2 answers + the owner's gate word before starting the plan.

- Architect verified my four load-bearing code claims against main (isPublicRoute api/ rule, private CacheEntry.fetchedAt, IDLE_WAITING_THRESHOLD_MS=5min, gh pr list --json field set). All held.
- Fix: rebuttal item 10 over-claimed a lane->PR resolution rule the spec text lacked. Added it as its own bullet in "Renderers and endpoint" (linked-issue match against OverviewCache open-PR set; no-match => no-PR zone + ci unknown; merged via MergedPrItem, which also drives the disagreement render). Touched nothing else. Committed + pushed; new head 2441a0d6d.
- #1595 proposal posted (issuecomment-5878360367), marked "proposal, pending owner ruling". Proposes a SPLIT: #1672 absorbs the single whose-move computation + state enum (satisfies #1595 constraints 2-enum and 4); #1595 narrows to the harness lifecycle-hook DATA SOURCE (Stop/UserPromptSubmit/Notification/PermissionRequest reporter, PID liveness, global.db state rows, HarnessProvider neutrality) which #1672 does NOT build. Avoids double-build without prematurely closing #1595.
- Architect is routing my five contract-surface items to main now. HARD CONSTRAINT: do not start the plan until BOTH main's OQ1/OQ2 answers land AND the owner's spec-gate word arrives (relayed by architect:vscode). Not inferring approval from silence; I run porch approve on the relayed word.

## 2026-09-29 — main's contract rulings folded in (pre-gate)

Now: folded main's five contract-seat rulings into the spec (head 5530759ff, pushed); still holding for the owner's spec-gate word before any plan work.

- Main ratified all five items with amendments and RESOLVED OQ1 + OQ2 (verified the rebuttal's code claims against main). Folded in (spec only): kebab ballOwner union ('stalled', no `?` on wire; presentation is renderer-side); dropped now.selfReported (self-reported set documented in type doc comment); sdk co-location with NO import dependency on 1566 + pure data-in/verdict-out + boundary/builder-helpers tests stay green; endpoint home = packages/codev (agent-farm/servers/), packages/core must not import codev-sdk (#1189); OQ1 (optional ci on PrListItem, GitHub pr-list.sh reduces statusCheckRollup via jq, keep #1645 shape + forge-executable, re-run forge.test.ts) and OQ2 (per-source fetchedAt as epoch ms on OverviewData, Tower derives ageMs at assembly, negative-cache window never advances fetchedAt) moved into a new "Main's contract-seat rulings (2026-09-29)" block. Approach 1 selected; Approach 2 documented as no-longer-needed fallback.
- These are main's contract-seat word only. Spec-approval gate remains the OWNER's, presented in parallel, still OUTSTANDING. Plan gate follows the protocol.
- HARD HOLD: no plan work until the owner's gate word arrives (relayed by architect:vscode). Not inferring approval from silence; I run porch approve on the relayed word.

## 2026-09-29 — reviewed the owner's Lane Card design canvas

Now: reviewed the owner's design canvas artifact and confirmed the spec matches it; flagged three deliberate spec-vs-mock divergences to architect:vscode; still holding at the owner's spec gate.

- Artifact: claude.ai/artifact/7ovAzkJbDCMpRBoWSk8dt9 (Claude Design canvas "Lane Card", 6 artboards: Main, BallStates, CliCard, VSCodePanel, DataFlow, canvas.json). Extracted the .dc.html artboards from the appifact-doc block to scratchpad to read them.
- Spec (2441a0d6d) matches the mock on all six zones, five core ball-owner states + precedence, both CLI renderers, the #1049 strip, and the whole data plane. Mock uses the CI rollup, confirming Approach 1 was always the intent.
- Three DELIBERATE spec-vs-mock divergences (all reviewed/ratified): (1) AGENT WORKING drops terminal activity (guardrail #4 + CMAP; else STALLED? unreachable); (2) added terminal DONE + OFFLINE (mock has 5; exhaustiveness + #1595 dead); (3) endpoint /api/ prefix (mock omits it; main-confirmed). Everything else mock-only is presentation (chip colors, CODEV tab, glyphs) = renderer-side per main's ruling (1a), so plan detail.
- Proposed to architect: add the design-canvas link to References + a one-line ball-owner note on the deliberate divergences. Holding for their word; not touching the spec at the live gate without it, not inferring approval from silence.

## 2026-09-29 — design-canvas reconciliation folded into spec

Now: folded the design-canvas reference + divergence note into the spec (head b2666ebaf, pushed) on architect:vscode's word; still holding at the owner's spec gate.

- architect:vscode approved the fold-in (spec content under their seat, NOT the gate). Added: design-canvas link in References + one-line ball-owner note (terminal activity excluded from AGENT WORKING; DONE/OFFLINE added beyond the canvas's five; endpoint carries /api/). One commit, pushed, SHA reported.
- Spec content SHA is now b2666ebaf. Spec-approval word remains the owner's and is still OUTSTANDING. No plan work until it lands (and main's OQ1/OQ2 already landed). Not inferring approval from silence.
