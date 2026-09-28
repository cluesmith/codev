# Specification: Lane Card (per-lane status card for fast re-orientation)

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
File paths and module names appear here only to fix the sources of truth and the
contract surface; sequencing, code, and "first we will… then we will…" belong in
codev/plans/1672-lane-card-per-lane-status-card.md.
-->

## Problem Statement

Working a fleet means hopping between many terminals: architects and builders, in the IDE, the dashboard, and plain tmux. On every hop the human pays a re-orientation tax, needing to re-answer four questions:

1. Which issue is this lane on?
2. Where did it get to?
3. Whose move is it (mine, the agent's, or something external)?
4. What just happened?

Today those answers live in scrollback archaeology, an issue-tab context switch, or in knowing to run `porch status <id>` and `cat codev/state/<id>_thread.md` and `gh pr view`. The information all exists and each fact already has a single owner; nothing fuses them into one glance. The affected party is the human operator running more than one lane, and the cost is paid per hop, many times a day.

## Current State

The facts a re-orienting human needs are already computed and served, but scattered across surfaces that must be visited one at a time:

- **Phase and gate state** live in `codev/projects/<id>-<name>/status.yaml`, parsed by `parseStatusYaml` into `ParsedStatus` (`packages/codev/src/agent-farm/servers/overview.ts`). Derived signals already exist here: `detectBlocked` / `detectBlockedGate` / `detectBlockedSince`, the gate-label allowlist `GATE_LABELS`, `derivePrReady`, and `computeIdleMs`. Gate-requested is `gates[g] === 'pending' && gateRequestedAt[g]`; gate-approved is `gateApprovedAt[g]` present.
- **Forge data** (PR number, review decision, review-requested, draft) is served through `OverviewCache.getOverview()` (`overview.ts`), shaped into `OverviewPR`. CI status is **not** carried on `OverviewPR` today; the cached PR GraphQL selection does not fetch a status-check rollup. Staleness is expressed on the wire only through `forgeStatus` (`ok` / `rate-limited` / `unavailable`) and `forgeResetAt`, not a per-item fetched-at stamp.
- **Held messages** live in `~/.agent-farm/global.db` (`db/mailbox.ts`), summarized per workspace and attached to a builder as `heldCount`. **Terminal liveness** is `lastDataAt` (last data frame from the shellper), injected into the overview by Tower.
- **The thread narrative** (`codev/state/<id>_thread.md`) is freeform builder-authored prose. There is no writer helper that appends entries at porch task boundaries; entries are ordinary file edits.
- **"Whose move is it" is not computed as one model.** The SDK today exposes `deriveAttention(OverviewData)` and `isIdleWaiting(...)` in `packages/sdk/src/builder-helpers.ts`, which bucket attention into rows (pending gates, waiting, held) rather than resolving a single per-lane state. The harness-lifecycle states named by #1595 (working / needs-input / idle / dead) are **not** yet a computed model, and `compareAttention` (#1566) does not exist in the tree yet. Any surface that wants "whose move" either re-derives it or renders the buckets.

The limitation: a fused, at-a-glance answer requires the human to be the fusion engine, every hop.

## Desired State

A **Lane Card**: a per-lane status card that answers the four questions in about five seconds, rendered wherever the user already is (a focused terminal, `afx`, the VS Code panel). One canonical JSON shape (`LaneCard`) is assembled once and rendered many ways.

The card has six zones (illustrative layout, not a fixed width):

```
┌─ bugfix-1586 · BUGFIX · #1586 tower: cloud-proxied requests 401'd ────┐
│ ● WAITING ON YOU  pr gate 2h          PR #1588  CI 7/7  review req'd  │
│ Now: pushed fail-closed fix; CMAP done; awaiting gate + merge   (2h)  │
│ 3h fixed composer false-CLEAN · 5h mailbox redesign · 6h merged main  │
│ builder/bugfix-1586 · commit 2h · thread 2h · gh 40s · 0 held         │
└─ [issue] [PR] [thread] [porch] ───────────────────────────────────────┘
```

1. **Identity**: lane id, protocol, issue number and title (status.yaml + forge).
2. **Ball owner**: whose court the lane is in, a single computed state with precedence (first match wins): `WAITING ON YOU` (a gate requested and unapproved, or review requested from the user) → `HELD` (messages held in the lane's mailbox) → `EXTERNAL` (CI pending, consult lanes in flight) → `AGENT WORKING` (phase active with recent output, commits, or thread writes) → `STALLED?` (phase says working but nothing produced beyond a threshold). Secondary conditions render as small badges beside the chip. This state is **computed, never authored**.
3. **Artifact state**: PR, CI rollup, review decision, branch, last-commit age. The lane is judged by what it produced, not by terminal signal.
4. **Now line**: the single authored field. Each builder thread entry carries a one-sentence `Now:` line; the card shows the latest one, with its age, marked self-reported.
5. **Recent beats**: the last roughly three thread-entry headings, with ages.
6. **Freshness and links**: per-source data age, held-message count, and deep links (issue, PR, thread file, porch status).

Concretely, after this ships:

- `afx card [id]` prints the six-zone card as ANSI. The same block prints on `afx attach`.
- `afx status --cards` prints a fleet twin: one compact row per lane (id, ball chip, now line, age), with your-court lanes sorted first, then held, then by age within groups.
- Tower serves the assembled `LaneCard` JSON from one keyed endpoint, fusing the sources above, watching status.yaml and thread files, and taking forge data only from the OverviewCache.
- The VS Code contextual bottom panel (#1049) shows a compact card strip as the header of its builder view, re-resolving as terminal focus changes, with the full card on click. The panel's Attention fallback (#1553) is the host; the card is its per-lane refinement.
- The ball-owner / attention state is computed in exactly one SDK-side module, near where `compareAttention` (#1566) will live. The card, the sidebar attention view, and any future dashboard surface are renderers of that one module. This **absorbs #1595**.

The card renders gracefully in every degraded case: forge stale or unavailable, no PR yet, no thread file, the last-ask field absent (see Constraints), a parked lane (#1729, see Constraints).

## Success Criteria

- [ ] `afx card <id>` renders all six zones for a live lane, and the same block prints on `afx attach`.
- [ ] `afx status --cards` renders one row per lane with the documented sort (your-court first, then held, then by age).
- [ ] Tower serves `LaneCard` JSON from a single endpoint that is **keyed** (absent from `isPublicRoute`); an unauthenticated request to it is rejected.
- [ ] The ball-owner state is computed in exactly one SDK-side module; the card, the VS Code attention surface, and any dashboard surface all consume it. No second "whose move" computation exists in the tree (verified by grep at review time).
- [ ] Ball owner is derived only from porch gate rows, forge review-request state, held-mailbox rows, and produced artifacts. A lane whose `Now:` line says "done" while its `pr` gate is requested-and-unapproved still shows `WAITING ON YOU` (computed-never-authored, verified by test).
- [ ] `STALLED?` is derived from produced artifacts (commits, thread writes, PR state), never from terminal `lastDataAt` activity (verified by test: a lane with a busy composer but no artifact movement past the threshold shows `STALLED?`, not `AGENT WORKING`).
- [ ] Rendering the card, at any frequency, spawns **zero** new `gh` invocations. All forge facts come from the OverviewCache; a burst of `afx card` calls adds no GraphQL points (verified by asserting the card path invokes no forge fetch beyond the cache read).
- [ ] Every field carries a source and an age; self-reported (the `Now:` line) is visibly distinct from derived.
- [ ] When porch phase and the artifact disagree (for example porch says `review` while the linked PR merged 2h ago), the card renders both rather than picking one.
- [ ] The card renders correctly with the last-ask field (#1674) absent, with no thread file, with no PR, and with `forgeStatus` `rate-limited` / `unavailable` (each a first-class test).
- [ ] The card row and a future #1729 park chip have a defined coexistence rule in this spec (design only; #1729 is not built here).
- [ ] The `Now:` line convention is documented in protocol/template wording in **both** `codev/` and `codev-skeleton/`.
- [ ] A re-scope proposal for #1595 is posted (comment on #1595) for the owner's ruling.

## Constraints

### Baked Decisions (fixed; from the issue guardrails, its Architecture section, and the vscode architect's lane brief)

The issue body carries no heading literally named "Baked Decisions", but its **Guardrails (non-negotiable)** and **Architecture** sections, together with the owning architect's lane brief, are fixed decisions. They are copied here and treated as settled. They are not re-opened in Solution Approaches; a genuine problem with one is raised via `afx send architect:vscode`, not overridden.

1. **Read-only fusion.** The card introduces no new state store and is never a second place agents report to. Every fact keeps its existing single source of truth: status.yaml (phase/gates), the forge (PR/CI/review), the worktree's git (branch/commit age), global.db (held messages, terminal activity), the thread file (`Now:` line).
2. **Forge data rides the OverviewCache; the card adds nothing that spawns `gh`.** The card's only forge path is the OverviewCache and its negative-caching discipline (#1652 / #1647 / #1650). Surface staleness (the `gh 40s` stamp); never poll harder.
3. **One authored field only.** The `Now:` line is a convention added to the existing thread-entry writes at porch task boundaries: no new file, no new write moment. Its protocol/template wording lands in both `codev/` and `codev-skeleton/`.
4. **Computed-never-authored is absolute for the ball owner.** `WAITING ON YOU` derives from porch gate rows and forge review-request state, never from agent self-report (the #1446 stale-phase class and the gate-discipline scars are why). `STALLED?` derives from produced artifacts (commits, thread writes, PR state), never terminal activity.
5. **Every field carries source and age.** Self-reported versus derived is always visible.
6. **Disagreement is rendered, not hidden.** When porch phase and the artifact disagree, the card shows both rather than picking one.
7. **The card endpoint is a keyed route**, never on the public allowlist.
8. **One state SSOT, shared with #1595.** The ball-owner precedence chain is a superset of #1595's agent-attention states (working / needs-input / idle / dead) and overlaps #1594's held indicator. This issue **absorbs #1595**: the state computation lives in exactly one place, SDK-side, near where #1566 puts `compareAttention`. Tower remains the fusion and serving layer; the precedence logic is the shared module it calls. #1595 is re-scoped at spec time (a comment proposing the re-scope; the owner posts the ruling).
9. **`LaneCard` type in `@cluesmith/codev-types`** (wire contract only; no implementation or policy there).
10. **Assembly in Tower**: one endpoint (for example `GET /workspace/:ws/lane/:id/card`), fusing the sources with file-watch on status.yaml and thread files, forge data via the OverviewCache.
11. **Renderers consume the same JSON**: CLI (`afx card`, attach banner, `afx status --cards`), VS Code (compact strip in the #1049 panel), dashboard/cloud (a later follow-up).
12. **Lane-brief rulings.** (a) #1672 ships **alone**; #1674 (last-ask capture) is a companion lane and is not folded in; the card must render gracefully with the last-ask field absent, treated as a first-class test from day one. (b) The state module lands near pir-1566's `compareAttention` in `packages/sdk/src/builder-helpers.ts` (branch `builder/pir-1566`, currently unmerged). (c) The card row and a future #1729 park chip must have a defined coexistence rule (design for it; do not build it). (d) Any spec/plan section touching `packages/types`, `packages/sdk`, `packages/core`, or Tower endpoints is main's contract surface and is flagged for routing to main before the plan gate. (e) File fence: pir-1566 owns `apps/vscode` `views/tower*.ts`, `workspace-label.ts`, `fleet-order.ts`, `attention-format.ts`, `switch-workspace.ts`, `icons/tower.svg`; this lane does not edit them. (f) spec-approval and plan-approval are the owner's alone.

### Technical constraints grounded in the current code

- **CI rollup is not in the OverviewCache today.** `OverviewPR` carries `reviewStatus` / `isDraft` / `reviewRequests` only; the cached PR query fetches no status-check rollup. Showing "CI 7/7" therefore requires either extending the existing cached PR GraphQL selection (no new `gh` invocation; the rollup rides the same fetch) or deferring CI from the v1 card. This is the central open design choice (see Solution Approaches) and is contract surface for main.
- **The ball-owner / `compareAttention` module does not exist yet.** This spec introduces it. It must supersede #1595's four lifecycle states, including a terminal-liveness `dead`/offline state derived from `lastDataAt` and the builders table, mapped into the precedence chain.
- **The card endpoint is keyed by default** by leaving it out of `isPublicRoute` (`packages/codev/src/agent-farm/utils/server-utils.ts`); no allowlist widening.
- **`@cluesmith/codev-types` is wire-contracts-only.** Derived UI policy (the ball-owner computation) lives in `@cluesmith/codev-sdk`, not in types.

### Fence (do-not-edit) and cross-lane sequencing

- Do not edit the pir-1566-owned files listed above. If the VS Code strip needs 1566's `attention-format` helpers, the plan flags it and the two lanes' merges are sequenced.

## Assumptions

- **pir-1566 lands first, or its module home is stable.** The ball-owner module is placed near `compareAttention` in `packages/sdk/src/builder-helpers.ts`. If 1566 has not merged when this lane's plan starts, the plan sequences against it (this lane does not edit 1566-owned files).
- **The OverviewCache remains the sole forge path** and its `forgeStatus` / `forgeResetAt` (and TTLs) are sufficient to express freshness; the card does not need a per-item fetched-at stamp beyond what the cache exposes.
- **Extending the cached PR GraphQL selection with a status-check rollup adds no extra forge request** (it is one more field on an already-issued query). This is the assumption behind the recommended approach and is validated with main.
- **Thread entries continue to be builder-authored prose**; the `Now:` line is a documented convention, not an enforced schema, and the card tolerates its absence.
- **#1674 (last-ask) and #1729 (park) are not delivered here**; the `LaneCard` shape reserves for them (optional last-ask field, a park-badge slot) so the companion lanes slot in without a re-cut.

## Solution Approaches

The architecture is largely fixed by the Baked Decisions (SDK-side state SSOT, Tower fusion, keyed endpoint, OverviewCache-only forge, CLI-first renderers). The space that remains genuinely open is **how the CI rollup reaches the card** given that it is not cached today, and this drives whether the v1 card matches the mockup's "CI 7/7" line.

### Approach 1: OverviewCache-native fusion, CI folded into the existing forge query (recommended)

Assemble the `LaneCard` in Tower by fusing status.yaml (file-watch), the thread file (file-watch), the worktree git (branch and last-commit age), global.db (held count, liveness), and the OverviewCache (PR number, review decision, and a newly added status-check rollup). CI reaches the card by extending the OverviewCache's existing PR GraphQL selection with a status-check rollup field, so the rollup rides the same already-cached fetch and spawns no new `gh` invocation. The ball-owner state is one SDK-side function that all renderers call.

- **Pros**: the v1 card is complete (matches the mockup, including CI); one coherent data model; the no-new-`gh` guardrail is honored because CI is a field on an existing query, not a new call.
- **Cons**: touches the OverviewCache PR shape and the forge query (contract surface + forge-quota sensitive), so it needs main's review and careful verification that the rollup adds no request and does not enlarge the cached payload problematically.
- **Risk/complexity**: moderate, concentrated in the forge-query change; the rest is read-only fusion of local, cheap sources.

### Approach 2: Minimal-cache fusion, CI deferred to a follow-up

Same fusion, but the v1 card renders only fields already on the OverviewCache (PR number, review decision, branch, commit age, held, phase/gate). CI is treated as a first-class absent field (rendered as an explicit "CI n/a" / unknown, like the last-ask absent case) and added in a follow-up once the forge-query extension is agreed.

- **Pros**: touches no forge query; smallest contract-surface change; ships the re-orientation value fastest and validates the data model cheaply.
- **Cons**: the v1 card does not show CI, so it does not fully match the mockup; introduces a visible "unknown" state that must later be filled.
- **Risk/complexity**: low.

**Recommendation: Approach 1**, because CI rollup is part of "judge the lane by what it produced" and the extension is a single field on an already-issued query (no new call), which keeps the forge-quota guardrail intact. Because the forge-query change is contract surface and quota-sensitive, it is flagged explicitly for main at the spec gate, with **Approach 2 as the pre-agreed fallback** if main declines extending the forge query: in that case CI ships as a first-class absent field and follows later. Everything downstream of the data source (state module, Tower endpoint, renderers) is identical between the two approaches, so the fallback costs no rework.

## Open Questions

**Critical (blocks progress):**

1. May the OverviewCache PR GraphQL selection be extended with a status-check rollup (Approach 1), confirmed to add no forge request, or is CI deferred (Approach 2)? This is contract surface for main and gates the artifact-state zone. (Resolvable at the spec gate.)
2. How does #1595's `dead`/offline lifecycle state map into the ball-owner precedence chain (a distinct terminal chip, a badge, or folded into `STALLED?`)? The state module must express it, and the re-scope comment on #1595 must reflect the mapping.

**Important (shapes design):**

3. Exact `STALLED?` threshold and which produced artifacts count (commit age, thread-write age, PR-state change), and whether the threshold is protocol-aware (a spec phase produces differently than an implement phase).
4. Coexistence of the ball-owner chip and a #1729 park chip in one row: leading park badge that visually pre-empts the computed chip while preserving the computed value beneath (honoring "disagreement is rendered"), versus park replacing the chip. This spec proposes the former; the plan wires the reserved slot only.
5. How the `EXTERNAL` state detects "consult lanes in flight" without a new data source (from existing signals only).

**Nice-to-know (optimization):**

6. Whether `afx status --cards` becomes the default `afx status` output eventually, or stays behind the flag.
7. Whether the attach-time banner is shown once on attach or refreshes.

## Test Scenarios

- **Happy path, CLI**: a live BUGFIX lane at the `pr` gate with an open PR renders all six zones; ball chip is `WAITING ON YOU` with `pr gate <age>`; artifact zone shows PR number, review-requested, and CI (Approach 1) or an explicit CI-unknown (Approach 2).
- **Computed-never-authored**: a lane whose latest `Now:` line asserts completion while its `pr` gate is requested-and-unapproved renders `WAITING ON YOU`, not any agent-reported "done" state.
- **STALLED? from artifacts, not terminal**: a lane whose phase says implementing, whose composer is emitting output (recent `lastDataAt`), but whose last commit and last thread write are older than the threshold, renders `STALLED?`.
- **Disagreement rendered**: porch phase `review` while the linked PR is merged; the card shows both the phase and the merged artifact, not one silently chosen.
- **Forge degraded**: with `forgeStatus` `rate-limited` (and `unavailable`), the card renders from cached/local facts, shows the stale `gh` age stamp, and never triggers a fetch.
- **Absent fields (first-class)**: last-ask field absent (#1674 not present); no thread file (no `Now:` line, no beats); no PR yet (artifact zone shows branch and commit age only). Each renders cleanly with no crash and no fabricated value.
- **Held state**: a lane with held mailbox rows renders `HELD` with the held count in the freshness zone; a lane with both a pending gate and held rows renders `WAITING ON YOU` (precedence) with held as a secondary badge.
- **Fleet twin sort**: `afx status --cards` places your-court lanes first, then held, then by age within groups.
- **Single-source invariant (non-functional)**: a repo-wide grep finds exactly one "whose move" computation; the VS Code and CLI renderers import it.
- **Zero-`gh` invariant (non-functional)**: repeated card renders invoke no forge fetch beyond the cache read.
- **Keyed endpoint (non-functional)**: an unauthenticated request to the card endpoint is rejected; it is absent from `isPublicRoute`.
- **Both trees (non-functional)**: the `Now:` convention wording is present in both `codev/` and `codev-skeleton/`.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Extending the forge query silently adds `gh` cost or enlarges cache payload | Medium | High (violates the #1652 quota guardrail) | Confirm the rollup rides the existing query with main; assert zero new fetches in test; Approach 2 fallback needs no downstream rework |
| A second "whose move" computation creeps in (card vs #1595 vs #1594) | Medium | High (two answers disagree within a week) | Single SDK-side module as the SSOT; grep-enforced at review; #1595 re-scoped so its states are absorbed, not re-implemented |
| Contract-surface changes (types/sdk/core/Tower) collide with main or pir-1566 | Medium | Medium | Flag every contract-surface section at the spec gate for main to route; respect the pir-1566 file fence; sequence merges in the plan |
| `Now:` convention is unevenly adopted, leaving cards without a now line | Medium | Low | The card tolerates an absent `Now:` line as a first-class case; the convention ships in both trees' protocol wording; no enforced schema |
| `STALLED?` misfires (false stall on a legitimately slow phase, or misses a real stall) | Medium | Medium | Derive from produced artifacts with a protocol-aware threshold; render as `STALLED?` (a question), never a hard "dead"; surface the underlying ages so the human can judge |
| Absent companion fields (#1674 last-ask, #1729 park) force a later re-cut | Low | Medium | The `LaneCard` shape reserves an optional last-ask field and a park-badge slot from day one; absent cases are tested |

## References

- Issue #1672 (amended 2026-09-10) and main's routing comment (2026-09-29): the requirements.
- #1049: the VS Code contextual bottom panel (the VS Code host surface).
- #1553: the panel's Attention fallback (the card's per-lane refinement host).
- #1595: attention states (working / needs-input / idle / dead), **absorbed** by this issue; re-scoped at spec time.
- #1594: held-indicator overlap.
- #1566: `compareAttention` home (SDK-side), where the state module lands (`packages/sdk/src/builder-helpers.ts`, branch `builder/pir-1566`).
- Spec 1313: the mailbox, source of the `HELD` state.
- #1446: the stale-phase class the "disagreement is rendered" rule exists for.
- #1652 / #1647 / #1650: forge-quota discipline (the OverviewCache is the only forge path).
- #1674: last-ask capture, a companion lane; the card renders with its field absent.
- #1729: `afx park` (owner-set attention flag), a companion lane; the card row must define coexistence with a park chip.
- Current-code anchors: `packages/codev/src/agent-farm/servers/overview.ts` (OverviewCache, status.yaml parsing, gate/blocked derivation), `packages/sdk/src/builder-helpers.ts` (`deriveAttention`, future `compareAttention`), `packages/types/src/api.ts` (`OverviewPR`/`OverviewBuilder`/`HeldMessage`; future `LaneCard`), `packages/codev/src/agent-farm/servers/tower-routes.ts` and `utils/server-utils.ts` (routing and `isPublicRoute`), `packages/codev/src/agent-farm/db/mailbox.ts` (held messages), `packages/codev/src/agent-farm/cli.ts` (`afx status` / `afx attach`), `apps/vscode/src/contextual-panel/` (the panel host).
