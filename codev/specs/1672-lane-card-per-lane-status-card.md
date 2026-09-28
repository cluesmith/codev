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
- **Forge data** is served through `OverviewCache.getOverview()` (`overview.ts`), shaped into `OverviewPR`. The forge is reached through the **forge-concept scripts** (`packages/codev/scripts/forge/{github,gitlab,gitea}/pr-list.sh`) behind the typed `PrListItem` contract (`packages/codev/src/lib/forge-contracts.ts`). The GitHub script runs `gh pr list --json number,title,url,reviewDecision,body,createdAt,author,reviewRequests,isDraft` with a deliberate capture-then-pipe shape (#1645: POSIX `sh` has no `pipefail`, so a rate-limited `gh` must not look like an empty list). Two consequences matter for the card:
  - **CI status is not carried today.** `PrListItem` / `OverviewPR` have `reviewStatus` / `isDraft` / `reviewRequests`, no status-check rollup.
  - **`pr-list` returns open PRs only.** Merged PRs come from a separate concept, cached as `MergedPrItem` (`forge-contracts.ts`; `overview.ts` around line 969). The "porch says review while the PR merged 2h ago" disagreement therefore has two distinct data sources, not one.
- **Forge freshness is coarse.** Staleness is expressed on the wire only through `forgeStatus` (`ok` / `rate-limited` / `unavailable`) and `forgeResetAt`. The cache's per-entry `fetchedAt` is private and is not on `OverviewData` today, so a precise "gh 40s" age is not derivable from the current wire contract without exposing it.
- **Held messages** live in `~/.agent-farm/global.db` (`db/mailbox.ts`), summarized per workspace and attached to a builder as `heldCount`. **Terminal liveness** is `lastDataAt` (last data frame from the shellper), injected into the overview by Tower.
- **The thread narrative** (`codev/state/<id>_thread.md`) is freeform builder-authored prose. There is no writer helper that appends entries at porch task boundaries; entries are ordinary file edits, and headings today are date-level (for example a `## 2026-09-29 ...` heading), not per-entry timestamped. A file carries one filesystem `mtime`, so per-beat ages are not derivable from the current format.
- **"Whose move is it" is not computed as one model.** The SDK exposes `deriveAttention(OverviewData)` and `isIdleWaiting(...)` in `packages/sdk/src/builder-helpers.ts`, which bucket attention into rows rather than resolving a single per-lane state. These already have live consumers: `apps/vscode/src/extension.ts`, `apps/vscode/src/views/builders.ts`, `apps/vscode/src/views/builder-row.ts`, `apps/vscode/src/contextual-panel/panel-provider.ts`, and a noted future need in `apps/streamdeck/src/face.ts`. The harness-lifecycle states named by #1595 (working / needs-input / idle / dead) are **not** yet a computed model, and `compareAttention` (#1566) does not exist in the tree yet.

The limitation: a fused, at-a-glance answer requires the human to be the fusion engine, every hop.

## Desired State

A **Lane Card**: a per-lane status card that answers the four questions in about five seconds, rendered wherever the user already is. One canonical JSON shape (`LaneCard`) is assembled once in Tower and rendered many ways.

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
2. **Ball owner**: whose court the lane is in, a single computed state (see the precedence table below). Computed, never authored.
3. **Artifact state**: PR, CI rollup, review decision, branch, last-commit age. The lane is judged by what it produced, not by terminal signal.
4. **Now line**: the single authored field (see the thread-entry grammar below).
5. **Recent beats**: the last roughly three thread-entry headings, with ages (see grammar).
6. **Freshness and links**: per-source data age, held-message count, and deep links (issue, PR, thread file, porch status).

### Ball-owner precedence (the absorbed #1595 model)

First match wins. The chain is exhaustive: a lane always resolves to exactly one state.

| Order | State | Derived from (source of truth) |
|------|-------|--------------------------------|
| 1 | `WAITING ON YOU` | A porch gate requested and unapproved (`gates[g]==='pending' && gateRequestedAt[g]`), or forge review requested from the user. Never from agent self-report. |
| 2 | `HELD` | One or more messages held in the lane's mailbox (`heldCount > 0`, global.db). |
| 3 | `EXTERNAL` | Something outside the lane owes the next move: CI pending on the linked PR. ("Consult lanes in flight" folds in only if a signal exists; see Open Questions and the EXTERNAL fallback below.) |
| 4 | `AGENT WORKING` | Phase is active **and** a produced artifact (a commit, a thread-entry write, or a PR-state change) is within the freshness threshold. Terminal `lastDataAt` does **not** qualify a lane as working. |
| 5 | `STALLED?` | Phase says working but no produced artifact has moved within the threshold. Rendered as a question, never a hard "dead". |
| T | `DONE` | Phase is a terminal completion state (for example `complete` / `verified` / merged), with no pending gate or held mail. Completed lanes exit here rather than falling to `STALLED?`. |
| T | `OFFLINE` | The lane's shellper is gone (no live PTY / `lastDataAt` absent past a liveness bound) while the phase is not a completion state. This is the #1595 `dead` state. It is a liveness fact, distinct from `STALLED?` (which is about produced artifacts). |

`DONE` and `OFFLINE` are terminal/liveness outcomes evaluated within the same single computation; the table lists all reachable states so no lane is unclassified. Secondary conditions (for example held mail while at a gate) render as small badges beside the primary chip.

### One computation, many renderers (disposition of the existing helpers)

The precedence chain lives in exactly one SDK-side module, near where `compareAttention` (#1566) will live (`packages/sdk/src/builder-helpers.ts`). Tower calls it once during assembly and serves the result on `LaneCard`; the CLI and VS Code renderers consume that JSON. The existing `deriveAttention` / `isIdleWaiting` are **not** deleted and their five call sites are **not** rewritten by this lane; they are re-expressed as **projections over the one precedence module** (for example "idle waiting" becomes a view of the module's output), so there is a single source of the "whose move" answer and no competing computation. The exact re-expression is a plan concern; the spec's requirement is that the precedence logic exists once and the buckets derive from it.

### Draft `LaneCard` wire shape (contract surface; for main to ratify)

A concrete draft so main and downstream builders review an unambiguous contract, not prose. Field names and nullability are indicative; main owns the final shape (this is `packages/types` contract surface).

```
LaneCard {
  laneId: string
  protocol: string
  issue: { number: number | null; title: string | null }
  ballOwner: {
    state: 'WAITING_ON_YOU' | 'HELD' | 'EXTERNAL' | 'AGENT_WORKING' | 'STALLED' | 'DONE' | 'OFFLINE'
    reason: string            // e.g. "pr gate", "CI pending"
    sinceMs: number | null    // age of the condition
    badges: string[]          // secondary conditions
  }
  artifact: {
    pr: { number: number; url: string } | null
    reviewStatus: string | null
    ci: { state: 'passing' | 'failing' | 'pending' | 'unknown'; passed?: number; total?: number }
    branch: string | null
    lastCommitAgeMs: number | null
    merged: boolean
    phaseArtifactDisagreement: boolean   // porch phase vs merged PR, etc.
  }
  now: { text: string; ageMs: number; selfReported: true } | null
  beats: { heading: string; ageMs: number | null }[]
  freshness: {
    forge: { status: 'ok' | 'rate-limited' | 'unavailable'; ageMs: number | null }
    statusYaml: { ageMs: number }
    thread: { ageMs: number }
    heldCount: number
  }
  links: { issue?: string; pr?: string; thread: string; porch: string }
  lastAsk?: { text: string; ageMs: number }   // reserved for #1674; absent until then
  park?: { note: string; ageMs: number }       // reserved for #1729 coexistence; absent until then
}
```

Every displayed field pairs a value with a source and an age; `now` (and the beats) are the only self-reported fields and are rendered visibly distinct from derived fields.

### Thread-entry grammar (the one authored field, both trees)

The `Now:` line is a convention added to the **existing** thread-entry writes at porch task boundaries: no new file, no new write moment. To make `Now` and per-beat ages derivable (today headings are date-level only), the convention is:

- Each entry heading carries a machine-readable timestamp (an ISO instant or `YYYY-MM-DD HH:MM`), so a beat age and the `Now:` age are parseable without `git log` or `git blame` (which are slow and blind to uncommitted writes).
- Each entry may carry one `Now:` one-sentence line; the card shows the latest one with its age.
- The card tolerates the convention's absence (no timestamp, no `Now:` line): it degrades to the file `mtime` for a coarse age and renders no `Now:` line rather than fabricating one.

This wording lands in the SPIR/protocol thread guidance in **both** `codev/` and `codev-skeleton/`.

### Renderers and endpoint

- `afx card [id]` prints the six-zone card as ANSI; the same block prints on `afx attach`. With `id` omitted, resolution is: the focused/attached lane if determinable, else the lane owning the current worktree (cwd), else a clear error listing candidates.
- `afx status --cards` prints a fleet twin: one compact row per lane (id, ball chip, now line, age). Sort: your-court (`WAITING ON YOU`) first, then `HELD`, then the rest by descending age of the ball-owner condition, with lane id as the stable tie-breaker.
- Tower serves the assembled `LaneCard` JSON from one **keyed** endpoint under the workspace API namespace: `GET /workspace/:ws/api/lane/:id/card` (the `api/` prefix is required; a non-`api/` workspace subpath is treated as a public static asset by `isPublicRoute`). It fuses the sources with file-watch on status.yaml and thread files, and takes forge data only from the OverviewCache. The lane `:id` is validated against the registered lane set and never interpolated into a filesystem path unvalidated.
- The VS Code contextual panel (#1049) shows a compact card strip as the header of its builder view, re-resolving as terminal focus changes, with the full card on click. The panel's Attention fallback (#1553) is the host. Builder-authored text (`Now:` line, beat headings) is escaped before it enters the webview HTML and sanitized of terminal control sequences before ANSI rendering.

The card renders gracefully in every degraded case: forge stale or unavailable, no PR yet, no thread file, the last-ask field absent (#1674), a parked lane (#1729).

## Success Criteria

- [ ] `afx card <id>` renders all six zones for a live lane, and the same block prints on `afx attach`. With `id` omitted it resolves per the documented rule or errors clearly.
- [ ] `afx status --cards` renders one row per lane with the documented sort (your-court first, then held, then by descending condition age, lane-id tie-break).
- [ ] Tower serves `LaneCard` JSON from `GET /workspace/:ws/api/lane/:id/card`; an unauthenticated request is rejected (the path is under the `api/` namespace, not the public static-asset rule).
- [ ] The endpoint validates `:id` against the registered lane set; a path-traversal or unknown-lane `:id`/`:ws` yields a 4xx and never reads outside the lane's own status.yaml / thread file / worktree.
- [ ] Builder-authored `Now:` and beat text is HTML-escaped before entering the VS Code webview and stripped of terminal control sequences before ANSI rendering (no injection via authored prose).
- [ ] The ball-owner precedence chain is computed in exactly one SDK-side module; the card, the VS Code attention surface, and any dashboard surface consume it, and `deriveAttention` / `isIdleWaiting` are projections over it rather than a second computation (verified by review: one module owns the chain).
- [ ] Ball owner is derived only from porch gate rows, forge review-request state, held-mailbox rows, and produced artifacts. A lane whose `Now:` line says "done" while its `pr` gate is requested-and-unapproved still shows `WAITING ON YOU`.
- [ ] `AGENT WORKING` requires an active phase plus a produced-artifact write within the threshold; a lane with fresh terminal `lastDataAt` but stale artifacts resolves to `STALLED?`, not `AGENT WORKING`.
- [ ] A completed/verified lane resolves to `DONE` (not `STALLED?`); a lane whose shellper is gone resolves to `OFFLINE`.
- [ ] Rendering the card, at any frequency, spawns **zero** new forge invocations; all forge facts come from the OverviewCache (verified by asserting the card path invokes no `pr-list` / `recently-merged` fetch beyond the cache read).
- [ ] Every displayed field carries a source and an age; self-reported (`Now:`, beats) is visibly distinct from derived.
- [ ] When porch phase and the artifact disagree (porch `review` while the linked PR merged), the card sets `phaseArtifactDisagreement` and renders both.
- [ ] The card renders correctly with the last-ask field (#1674) absent, with no thread file, with no PR, and with `forgeStatus` `rate-limited` / `unavailable` (each a first-class test).
- [ ] `STALLED?` uses a concrete default threshold (see Open Questions) so the criterion is testable at plan time; protocol-aware tuning is deferred.
- [ ] The card row and a future #1729 park chip have a defined coexistence rule (design only; #1729 is not built here).
- [ ] The `Now:` line and timestamped-heading convention are documented in protocol/thread wording in **both** `codev/` and `codev-skeleton/`.
- [ ] A re-scope proposal for #1595 is posted (comment on #1595) for the owner's ruling.

## Constraints

### Baked Decisions (fixed; from the issue guardrails, its Architecture section, and the vscode architect's lane brief)

The issue body carries no heading literally named "Baked Decisions", but its **Guardrails (non-negotiable)** and **Architecture** sections, together with the owning architect's lane brief, are fixed decisions. They are copied here and treated as settled. They are not re-opened in Solution Approaches; a genuine problem with one is raised via `afx send architect:vscode`, not overridden.

1. **Read-only fusion.** The card introduces no new state store and is never a second place agents report to. Every fact keeps its existing single source of truth: status.yaml (phase/gates), the forge (PR/CI/review), the worktree's git (branch/commit age), global.db (held messages, terminal activity), the thread file (`Now:` line).
2. **Forge data rides the OverviewCache; the card adds nothing that spawns `gh`.** The card's only forge path is the OverviewCache and its negative-caching discipline (#1652 / #1647 / #1650). Surface staleness; never poll harder.
3. **One authored field only.** The `Now:` line is a convention on the existing thread-entry writes at porch task boundaries: no new file, no new write moment. Its wording lands in both `codev/` and `codev-skeleton/`.
4. **Computed-never-authored is absolute for the ball owner.** `WAITING ON YOU` derives from porch gate rows and forge review-request state, never from agent self-report (the #1446 stale-phase class and the gate-discipline scars are why). `STALLED?` derives from produced artifacts (commits, thread writes, PR state), never terminal activity.
5. **Every field carries source and age.** Self-reported versus derived is always visible.
6. **Disagreement is rendered, not hidden.** When porch phase and the artifact disagree, the card shows both rather than picking one.
7. **The card endpoint is a keyed route**, never on the public allowlist.
8. **One state SSOT, shared with #1595.** The ball-owner precedence chain is a superset of #1595's agent-attention states and overlaps #1594's held indicator. This issue **absorbs #1595**: the state computation lives in exactly one place, SDK-side, near where #1566 puts `compareAttention`. Tower remains the fusion and serving layer. #1595 is re-scoped at spec time (a comment proposing the re-scope; the owner posts the ruling).
9. **`LaneCard` type in `@cluesmith/codev-types`** (wire contract only; no implementation or policy there).
10. **Assembly in Tower**: one endpoint, fusing the sources with file-watch on status.yaml and thread files, forge data via the OverviewCache.
11. **Renderers consume the same JSON**: CLI (`afx card`, attach banner, `afx status --cards`), VS Code (compact strip in the #1049 panel), dashboard/cloud (a later follow-up).
12. **Lane-brief rulings.** (a) #1672 ships **alone**; #1674 (last-ask capture) is a companion lane and is not folded in; the card must render gracefully with the last-ask field absent, treated as a first-class test from day one. (b) The state module lands near pir-1566's `compareAttention` in `packages/sdk/src/builder-helpers.ts` (branch `builder/pir-1566`, currently unmerged). (c) The card row and a future #1729 park chip must have a defined coexistence rule (design for it; do not build it). (d) Any spec/plan section touching `packages/types`, `packages/sdk`, `packages/core`, or Tower endpoints is main's contract surface and is flagged for routing to main before the plan gate. (e) File fence: pir-1566 owns `apps/vscode` `views/tower*.ts`, `workspace-label.ts`, `fleet-order.ts`, `attention-format.ts`, `switch-workspace.ts`, `icons/tower.svg`; this lane does not edit them. (f) spec-approval and plan-approval are the owner's alone.

### Technical constraints grounded in the current code

- **CI rollup is not in the forge contract today** and the forge is reached through per-forge shell scripts, not a Codev-owned GraphQL query. Showing "CI 7/7" requires adding a status-check rollup field to `PrListItem` (`forge-contracts.ts`) and to the GitHub `pr-list.sh` `--json` selection (preserving the #1645 capture-then-pipe shape), plus a ruling on what non-GitHub presets (GitLab `head_pipeline`, Gitea) emit versus an explicit "GitHub-first, others report unknown" carve-out. This is the central open design choice (see Solution Approaches) and is contract surface for main.
- **Merged-PR facts come from `MergedPrItem`**, a separate cached concept from open `pr-list`. The phase/artifact disagreement case reads both.
- **Precise forge age ("gh 40s") is not on the wire today.** Surfacing it requires exposing a per-source fetched-at through the OverviewCache/`OverviewData` (contract surface); absent that, freshness degrades to `forgeStatus` only.
- **The ball-owner / `compareAttention` module does not exist yet.** This spec introduces it. It must supersede #1595's four lifecycle states, including a terminal-liveness `OFFLINE` (#1595 `dead`) state.
- **The card endpoint is keyed by placing it under the workspace `api/` namespace** (`/workspace/:ws/api/...`); a non-`api/` workspace subpath is public by `isPublicRoute`'s static-asset rule (`packages/codev/src/agent-farm/utils/server-utils.ts`), so the `api/` prefix is load-bearing, not cosmetic.
- **`@cluesmith/codev-types` is wire-contracts-only.** The ball-owner computation lives in `@cluesmith/codev-sdk`, not in types.

### EXTERNAL and STALLED? defaults (so criteria are testable)

- **EXTERNAL fallback**: if no existing signal for "consult lanes in flight" is found (Open Question 5), `EXTERNAL` means **CI-pending on the linked PR only**. The card ships with that scope; consult-lane detection is a later enhancement if a signal appears.
- **STALLED? default threshold**: a single default (proposed: no produced-artifact movement for longer than the existing idle waiting threshold, `IDLE_WAITING_THRESHOLD_MS`, currently 5 minutes) so the state is testable at plan time. Protocol-aware tuning (a spec phase produces differently than an implement phase) is a follow-up.

### Fence (do-not-edit) and cross-lane sequencing

- Do not edit the pir-1566-owned files listed above. If the VS Code strip needs 1566's `attention-format` helpers, the plan flags it and the two lanes' merges are sequenced.

## Assumptions

- **pir-1566 lands first, or its module home is stable.** The ball-owner module is placed near `compareAttention` in `packages/sdk/src/builder-helpers.ts`. If 1566 has not merged when this lane's plan starts, the plan sequences against it (this lane does not edit 1566-owned files).
- **The OverviewCache remains the sole forge path.** Any freshness or CI need that requires new fields is met by extending the OverviewCache/contract (flagged to main), never by a new forge call from the card.
- **Thread entries continue to be builder-authored prose**; the timestamped-heading and `Now:` line are a documented convention, not an enforced schema, and the card tolerates their absence.
- **#1674 (last-ask) and #1729 (park) are not delivered here**; the `LaneCard` shape reserves optional `lastAsk` and `park` fields so the companion lanes slot in without a re-cut.

## Solution Approaches

The architecture is largely fixed by the Baked Decisions (SDK-side state SSOT, Tower fusion, keyed endpoint, OverviewCache-only forge, CLI-first renderers). The genuinely open space is **how the CI rollup reaches the card**, given that it is not in the forge contract today and the forge is reached through cross-forge shell scripts. This drives whether the v1 card matches the mockup's "CI 7/7" line.

### Approach 1: Extend the forge contract with a CI rollup (recommended, with a fallback)

Add a status-check rollup to `PrListItem` and to the GitHub `pr-list.sh` `--json` selection (preserving the #1645 shape), surfaced through the OverviewCache so CI reaches the card with no new forge call (it rides the existing cached `pr-list` fetch). Non-GitHub presets report the field as `unknown` under an explicit, contract-documented carve-out until they gain an equivalent.

- **Pros**: the v1 card is complete (matches the mockup, including CI); one coherent data model; the no-new-`gh` guardrail holds because CI is a field on an existing call.
- **Cons**: touches the cross-forge `PrListItem` contract and the GitHub script (contract surface + forge-quota and payload sensitive: `statusCheckRollup` is a nested per-check selection across all open PRs, so the real hazard is response/node-limit growth on a large PR list, not an extra request). Needs main's review and a GitLab/Gitea ruling.
- **Risk/complexity**: moderate, concentrated in the forge-contract change and its cross-forge story.

### Approach 2: Minimal-contract fusion, CI deferred to a follow-up

The v1 card renders only fields already in the forge contract (PR number, review decision, branch, commit age, held, phase/gate). CI is a first-class absent field (rendered `unknown`, like the last-ask absent case) and added once the contract extension is agreed.

- **Pros**: touches no forge script or contract; smallest contract-surface change; ships the re-orientation value fastest and validates the data model cheaply.
- **Cons**: the v1 card does not show CI, so it does not fully match the mockup; introduces a visible `unknown` that must later be filled.
- **Risk/complexity**: low.

**Recommendation: Approach 1**, because CI rollup is part of "judge the lane by what it produced" and it rides an existing call. Because the change is cross-forge contract surface and payload-sensitive, it is flagged for main at the spec gate, with **Approach 2 as the pre-agreed fallback** if main declines: CI then ships as a first-class `unknown` field and follows later. Everything downstream of the data source (state module, Tower endpoint, renderers) is identical between the two approaches, so the fallback costs no rework.

## Open Questions

**Critical (blocks progress):**

1. May `PrListItem` gain a CI status-check rollup field, with the GitHub `pr-list.sh` extended (preserving the #1645 shape) and a **GitHub-first, non-GitHub-reports-unknown** carve-out accepted (Approach 1), or is CI deferred (Approach 2)? This is cross-forge contract surface for main and gates the artifact-state zone.
2. May the OverviewCache/`OverviewData` expose a per-source `fetchedAt` so the card can show a precise forge age ("gh 40s")? If not, freshness degrades to `forgeStatus` only. Contract surface for main.

**Important (shapes design):**

3. Confirm the `STALLED?` default threshold (proposed: `IDLE_WAITING_THRESHOLD_MS`, currently 5 minutes, on produced-artifact movement) and whether it should be protocol-aware in v1 or deferred.
4. Coexistence of the ball-owner chip and a #1729 park chip in one row: a leading park badge that visually pre-empts the computed chip while preserving the computed value beneath (honoring "disagreement is rendered"), versus park replacing the chip. This spec proposes the former; the plan wires the reserved `park` field only.
5. Is there any existing signal for "consult lanes in flight" that `EXTERNAL` can use without a new data source? If not, `EXTERNAL` is CI-pending-only (the stated fallback).
6. How are `OFFLINE` / dead lanes discovered for the fleet view, given that the live overview may filter them out? (The card must be reachable for a lane whose shellper is gone.)

**Nice-to-know (optimization):**

7. Whether `afx status --cards` eventually becomes the default `afx status` output, or stays behind the flag.
8. Whether the attach-time banner is shown once on attach or refreshes.

## Test Scenarios

- **Happy path, CLI**: a live BUGFIX lane at the `pr` gate with an open PR renders all six zones; ball chip is `WAITING ON YOU` with `pr gate <age>`; artifact zone shows PR number, review-requested, and CI (Approach 1) or an explicit CI `unknown` (Approach 2).
- **Computed-never-authored**: a lane whose latest `Now:` line asserts completion while its `pr` gate is requested-and-unapproved renders `WAITING ON YOU`.
- **AGENT WORKING vs STALLED? boundary**: a lane whose phase is implementing, whose composer is emitting output (fresh `lastDataAt`), but whose last commit and last thread write are older than the threshold renders `STALLED?`, not `AGENT WORKING`.
- **Completed lane**: a `verified`/`complete` lane with no pending gate or held mail renders `DONE`, not `STALLED?`.
- **Offline lane**: a lane whose shellper is gone (no live PTY) while not in a completion state renders `OFFLINE`, and its card is still reachable in `afx status --cards`.
- **Disagreement rendered**: porch phase `review` while the linked PR (via `MergedPrItem`) is merged; the card sets `phaseArtifactDisagreement` and shows both.
- **Forge degraded**: with `forgeStatus` `rate-limited` (and `unavailable`), the card renders from cached/local facts, shows the degraded freshness, and never triggers a fetch.
- **Absent fields (first-class)**: last-ask absent (#1674); no thread file (no `Now:` line, no beats, coarse `mtime` age); no PR yet (artifact zone shows branch and commit age only). Each renders cleanly with no crash and no fabricated value.
- **Held state and precedence**: a lane with held rows renders `HELD`; a lane with both a pending gate and held rows renders `WAITING ON YOU` with held as a secondary badge.
- **Fleet twin sort**: `afx status --cards` places `WAITING ON YOU` lanes first, then `HELD`, then the rest by descending condition age, lane id tie-break.
- **`afx card` no-id**: with `id` omitted, resolves to the focused/cwd lane, or errors with candidates.
- **Security, path traversal**: an authenticated request with `:id` or `:ws` containing `../` is rejected; no file outside the resolved lane is read.
- **Security, authored-text injection**: a `Now:` line or beat heading containing HTML and terminal control sequences renders inert in the VS Code webview and in ANSI (escaped/stripped).
- **Single-source invariant (non-functional)**: review confirms one module owns the precedence chain and the attention buckets derive from it.
- **Zero-forge invariant (non-functional)**: repeated card renders invoke no forge fetch beyond the cache read.
- **Both trees (non-functional)**: the `Now:` / timestamped-heading convention wording is present in both `codev/` and `codev-skeleton/`.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| The forge-contract CI change grows response payload / node limits on large open-PR lists, or is bigger than estimated across forges | Medium | High (quota/perf regression; #1652 lineage) | Confirm with main; measure payload on a large PR list; GitHub-first carve-out; Approach 2 fallback needs no downstream rework |
| Card endpoint exposed unauthenticated via the wrong route shape | Low | High (leaks lane/forge data) | Route under `/workspace/:ws/api/...` (keyed by `isPublicRoute`); explicit unauthenticated-rejection test |
| Path traversal / authored-text injection through `:id`, `:ws`, or `Now:`/beat prose | Medium | High | Validate `:id` against the registered lane set; never interpolate into a path; HTML-escape and strip control sequences before render; dedicated tests |
| A second "whose move" computation creeps in (card vs #1595 vs #1594) | Medium | High (answers disagree within a week) | One SDK-side module owns the precedence chain; existing helpers become projections; review-enforced; #1595 re-scoped, not re-implemented |
| Contract-surface changes (types/sdk/core/Tower) collide with main or pir-1566 | Medium | Medium | Flag every contract-surface section at the spec gate for main to route; respect the pir-1566 file fence; sequence merges in the plan |
| File-watching status.yaml + thread files across every lane in every workspace exhausts fd/watch ceilings | Medium | Medium | Bound watchers (per active lane, shared where possible); fall back to on-demand read + debounce; measure at fleet scale |
| `STALLED?` misfires (false stall on a slow phase, or misses a real stall) | Medium | Medium | Produced-artifact derivation with a documented default threshold; render as a question, never a hard "dead"; surface underlying ages |
| `Now:` / timestamp convention unevenly adopted | Medium | Low | Card tolerates absence (coarse `mtime`, no `Now:` line); convention ships in both trees; no enforced schema |
| Absent companion fields (#1674 last-ask, #1729 park) force a later re-cut | Low | Medium | `LaneCard` reserves optional `lastAsk` and `park`; absent cases tested |

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
- #1729: `afx park` (owner-set attention flag), a companion lane; the card row defines coexistence with a park chip.
- Current-code anchors: `packages/codev/src/agent-farm/servers/overview.ts` (OverviewCache, status.yaml parsing, gate/blocked derivation, `MergedPrItem` cache), `packages/codev/scripts/forge/*/pr-list.sh` and `packages/codev/src/lib/forge-contracts.ts` (`PrListItem` / `MergedPrItem` forge contract), `packages/sdk/src/builder-helpers.ts` (`deriveAttention`, `isIdleWaiting`, future `compareAttention`), `packages/types/src/api.ts` (`OverviewPR` / `OverviewBuilder` / `HeldMessage`; future `LaneCard`), `packages/codev/src/agent-farm/servers/tower-routes.ts` and `utils/server-utils.ts` (routing and `isPublicRoute`), `packages/codev/src/agent-farm/db/mailbox.ts` (held messages), `packages/codev/src/agent-farm/cli.ts` (`afx status` / `afx attach`), `apps/vscode/src/contextual-panel/` (the panel host).
