# PIR Plan: Stream Deck SD+ two-zone builder workflow (selectors + action palette, dial-driven feedback queue)

## Owner decision (requirement 6 — single approve affordance) — RESOLVED

**Decided by Amr (2026-08-13): retire the generic `ApproveGate` singleton.** Row 2 [Approve gate]
becomes the single, selected-scoped approve affordance; the singleton's jump-to-next + gate-count
badge fold into Row 2 [Next / attention]. The recommendation below is the confirmed path (the
"flip" alternative is retained only as a record).

Today the deck has one approve affordance: the standalone `ApproveGate` singleton
(`actions.ts:187`). It targets the **top pending gate** (`store.topGateBuilderId()` = first
blocked builder), renders a **pending-gate count badge**, and on press relays
`approve-gate [topBuilderId]` — the VSCode side then shows the confirmation modal (never a
silent approve). This issue adds a Row 2 **[Approve gate]** key that must act on the
**selected** builder. Shipping both would leave two approve keys with *different* targeting
(top-pending vs selected) — the confusing outcome the issue and the streamdeck architect both
call out.

**My recommendation (matches the streamdeck architect's stated prior):**

- Row 2 **[Approve gate]** becomes the *single* approve affordance. It relays
  `approve-gate [selectedBuilderId]` — approving whoever is selected, through the existing
  confirmation modal. No approval semantics change on the VSCode side; only the target id
  changes (selected instead of top-pending).
- The standalone singleton's two useful behaviours **fold into Row 2 [Next / attention]**
  (the 4th palette key):
  - its **jump-to-next** becomes: press = move the shared selection/cursor to the
    highest-priority pending-gate builder (`store.topGateBuilderId()`), so the reviewer lands
    on the builder needing attention and then presses Approve;
  - its **pending-gate count badge** moves onto the [Next / attention] key face, so the
    at-a-glance "N gates waiting" signal is preserved.
- The singleton `ApproveGate` action is **retired** (class + manifest action removed; its
  profile slot reassigned to Row 2).

Net: exactly one approve key (selected-scoped), and the "sweep the fleet for gates" ergonomic
survives as Next/attention. **If Amr prefers instead to keep the singleton top-gate Approve and
make Row 2 key 4 a free/other action, say so and I will flip the plan** (Row 2 Approve would
then also be selected-scoped, but the singleton stays — accepting two approve keys, which I
advise against).

## Understanding

After #1404, each Row 1 key is a Builder Action: it renders a builder's status and, on press,
selects that builder (the shared `store.cursor` follows via `syncToBuilder`) and opens the
phase artifact. Covering a builder end-to-end needs more than select+open — approve a gate, run
dev, send queued review feedback — and the queued code-review feedback (#1037/#1382) has no
hardware trigger. The issue asks for a stable **two-zone** SD+ layout (no modal reflow):

- **Row 1** = the fleet-selector keys, upgraded from #1404's fixed absolute slots into a
  **4-wide window that follows the selection**, so a fleet larger than 4 is fully reachable
  (see "Row 1 windowing" below). The Select dial = `ZoomNav` rotate scrolls the window across
  the whole fleet.
- **Row 2** = a fixed action palette always acting on the **selected** builder:
  **[Approve gate] [Run Dev] [Send Fb (N)] [Next / attention]**.

Two behaviour changes ride along:

1. **Dials collect, key commits.** The diff dials' *press* moves from immediate send
   (`forward-file` / `forward-hunk`) to a **mode-neutral** verb (`feedback-file` /
   `feedback-hunk`; `feedback-selection` for the Scroll dial). VSCode routes each **forward-now
   or enqueue** per the workspace setting `codev.diffCodelensMode` (`forward` = immediate,
   `comment` = queue). Dial rotate (navigate) and tap (jump-to-first) are unchanged.
2. **Send Fb (N) = flush.** A new `send-queue` verb flushes the selected builder's queue
   (VSCode's existing `codev.submitReview`). The badge `N` mirrors the builder's queued count
   from the overview: in immediate mode nothing ever enqueues so `N` stays 0 and the key is
   inert; in queue mode `N` climbs and the key sends. No deck-side mode inference.

Two supporting wire additions (both binding, from the sdk/vscode stakeholder seats):

3. **Per-builder queued-count map** on the overview (`builderId -> queuedCount`), never a
   scalar total — so the deck renders `N` per builder and #1049's future Attention rollup
   consumes the same field.
4. **Feedback mode on the wire**, so the dial touchstrip can name the live semantic
   (`Files · queue` vs `Files · send`) — requirement 4, "a press is never a surprise." The mode
   is a per-workspace value (unlike the count, which is per-builder), so it is a scalar on the
   overview.

Binding invariant honoured throughout: the `feedback-*` / `send-queue` verbs mutate the queue
**only through `ReviewQueueStore`** (`apps/vscode/src/review-queue/store.ts`) — the same store
the inline threads, status bar, and Submit Review already use — so every surface reflects
deck-driven changes for free. (Tower *reads* the queue file to count it for the overview; that
is a read of the file the store owns, consistent with how `discoverBuilders` already reads
worktree files, not a parallel write path.)

## Layer integration — the shared-selection coherence model

Row 1/Row 2 bind to the **shared cursor** (`selectedBuilder()`); the review dials bind to the
**focused editor / MRU canvas**. These are two different anchors, and the design's integrity is
one invariant: **`selectedBuilder()` == the builder whose artifact is focused.** Where each
surface's target actually resolves (verified against the code):

| Surface | Acts on | Anchor |
|---|---|---|
| Row 1 selector | shared cursor (windowed); press = **select + open** | `syncToBuilder(b.id)` + `open-* [b.id]` (`actions.ts:131-133`) |
| Row 2 palette | `selectedBuilder().id`, builder-id verbs | `run-dev`/`approve-gate`/`send-queue` + id |
| Dial **mode** (diff/canvas) | `selectedBuilder().phase` | `reviewMode(selectedBuilder())` (`actions.ts:590`) |
| Dial **action — diff** | **focused / last-opened diff's builder**, not selection | `resolveDiffContext` via `getDiffInjectEntry` + `lastPosition` (`commands/diff-nav.ts`) |
| Dial **action — canvas** | workspace **MRU canvas** | `sendCanvasCommand({ workspace })` (`actions.ts:655`) |
| `feedback-*` **write** | **focused diff's owner** (artifact-anchored — correct) | `getDiffInjectEntry(activeEditor).builderId` (`extension.ts:1217-1240`) |
| Send Fb flush + badge | `selectedBuilder().id` | new Row 2 action |

**Two mechanisms hold the invariant, so all surfaces converge on one builder:**

1. **Row 1 press is select + open in one gesture** (`actions.ts:131-133`) — it moves the cursor
   *and* opens that builder's diff/canvas, so the dials' focused artifact becomes that builder's.
   The press calls `syncToBuilder` directly, so it converges even for canvas (no hook needed).
   This mirrors requirement 2's "dials collect, key commits": the Select dial scrolls/previews
   the window; **pressing a Row 1 key is what commits + opens** — you cannot act on a builder you
   have not opened.
2. **Focusing a diff back-syncs the cursor.** `onDidChangeActiveTextEditor` →
   `announceActiveBuilderFromEditor` fires `builder-active` with the focused diff's builder id
   (`extension.ts:679-685`) → deep link → deck `syncToBuilder` (`plugin.ts:56-64`). So clicking
   builder 3's diff in VSCode snaps the deck selection to 3; mode, Row 2, and the Row 1 highlight
   realign to what is viewed.

**Send Fb (N) internal consistency:** the badge (`queuedFeedback[selectedId]`) and the flush
(`send-queue [selectedId]`) are keyed to the **same** `selectedBuilder()`, so they can never
badge-one / flush-another. The `feedback-*` write is artifact-anchored (focused diff owner) and
agrees with Send Fb in steady state because focus == selection; the only divergence is the
unnatural "rotate Select dial without opening", which the next press/open closes. A test asserts
this (Test Plan).

**Two edges (E1 fixed by docs, E2 needs an owner call):**

- **(E1) The focus→deck back-sync requires a configured activity hook.** `builder-active` only
  reaches the deck if the personal-config hook (`on:['builder-active'] → streamdeck://…/active`)
  exists (`activity-hooks.ts:37-57`, resolved from `~/.codev/config.json` only, for security).
  Without it, only deck-driven selection (Row 1 press / Select dial) moves the cursor — VSCode
  focus changes won't. **Setup prerequisite** for the hardware dev-approval session; documented in
  the deck README. Not a code change.
- **(E2) Canvas focus does NOT back-sync (asymmetry with diff)** — OWNER DECISION.
  `announceActiveBuilderFromEditor` gates on `getDiffInjectEntry` (`extension.ts:682-683`), and a
  spec/plan canvas is not a diff-inject file, so no `builder-active` fires. In canvas mode,
  coherence rests only on the Row 1 press (which syncs directly); opening a different builder's
  canvas via VSCode won't move the deck cursor.
  - **(a) Accept + document (recommended):** the Row 1 press is the convergence gesture for canvas
    review; matches current shipped behavior; keeps #1410 scoped to the deck + relay + wire.
  - **(b) Add a symmetric `canvas-active` event** so focusing a canvas back-syncs too — small
    VSCode addition, but reaches into the canvas work (#1401/#1425) and widens scope.
  - *Awaiting Amr; plan assumes (a) unless told otherwise.*

## Proposed Change

### A. Wire contract (`packages/types`) — routes to `main`

`packages/types/src/api.ts`:
- Add to `OverviewData`:
  - `queuedFeedback: Record<string, number>` — per-builder queued review-comment counts, keyed
    by `OverviewBuilder.id`. Absent builders read as 0. **Map, never a scalar** (binding
    constraint 1). Required-with-default `{}` so consumers never branch on `undefined` (mirrors
    the `heldCount` / `architects` "never undefined" convention).
  - `feedbackMode: 'forward' | 'queue'` — the workspace's current feedback delivery mode,
    projected from `codev.diffCodelensMode` (`comment` → `queue`, `forward` → `forward`).
    Default `'forward'` (matches `getDiffCodelensMode`'s default).

Naming (`queuedFeedback`, `feedbackMode`, and the `'forward' | 'queue'` union) is the section
that routes to `main` for confirmation before the gate — happy to rename to the stakeholders'
preference.

### B. Tower overview (`packages/codev`) — routes to `main`

`packages/codev/src/agent-farm/servers/overview.ts`, in `getOverview`:
- **queuedFeedback**: for each discovered builder, read
  `<worktreePath>/.codev/pending-comments.json` and count its `comments[]` (tolerant parse: a
  missing/corrupt file = 0; identical tolerance to `parseQueueFile`). Build the
  `Record<builderId, count>`; include only non-zero entries (or all — decide with `main`). This
  is a synchronous small-file read per builder, gated behind the same worktree scan
  `discoverBuilders` already does — no new fetch/round-trip. The JSON shape
  (`{version, builderId, comments}`) is stable; I'll parse it inline (the `packages/codev`
  server cannot import `apps/vscode`), counting `comments.length` defensively.
- **feedbackMode**: read `<workspaceRoot>/.vscode/settings.json` for `codev.diffCodelensMode`;
  map to `'forward' | 'queue'`; default `'forward'` when the file/key is absent or unreadable.
  (See Risks for the multi-root / settings-scope caveat — this is the other point I want
  `main`'s read on.)

### C. VSCode command relay (`apps/vscode`) — routes to `main`

`apps/vscode/src/command-relay.ts` — add to the `VERB_COMMANDS` allowlist:
- `feedback-file` → `codev.feedbackCurrentFileToBuilder`
- `feedback-hunk` → `codev.feedbackCurrentHunkToBuilder`
- `feedback-selection` → `codev.feedbackSelectionToBuilder`
- `send-queue` → `codev.submitReview` (existing command; `submitReview` already resolves the
  target builder from the active diff / sole-pending / QuickPick, and accepts a `builderIdArg`
  — the relay forwards the selected builder id).

`apps/vscode/src/extension.ts` — three new commands, each a thin mode-router that reuses the
existing forward helpers and the queue store:
- Each resolves the diff-inject entry (`getDiffInjectEntry`) exactly as the `forward*` commands
  do today (`extension.ts:1180-1240`).
- If `getDiffCodelensMode() === 'forward'`: delegate to the existing immediate-forward path
  (`codev.forwardCurrentFileToBuilder` / `…Hunk…` / `…Selection…`) unchanged.
- If `=== 'comment'`: build a `PendingComment` (`randomUUID`, `createdAt`, `file = entry.relPath`,
  `lineRange` from the hunk/selection or `null` for whole-file, `body` = a short deck-origin
  reference marker — the same ref text `buildBuilderFileRef`/`buildBuilderRangeRef` produce, so
  the queued item is self-describing without typed prose) and call
  `reviewQueueStore.add(builderId, comment)` — **the single-source-of-truth mutation**
  (binding constraint 2). The store fires `onDidChangeQueue`, so the status bar and any inline
  threads update, and Tower's next overview reflects the new count.

Rationale for new commands rather than overloading the `forward*` ones: the `forward*` commands
are still used by the CodeLens forward path and the `forward-*` verbs may remain for any
explicit-immediate binding; the mode-router is the deck's entry point. (I'll confirm with `main`
whether the old `forward-file`/`forward-hunk` verbs should be retired from the allowlist once
the deck stops using them — leaning yes, to avoid a dead immediate-only path.)

### D. Deck: Row 2 palette + dial repoint + mode label (`apps/streamdeck`) — streamdeck lane

**Row 1 windowing (requirement 1 — reach a fleet larger than 4).** Today `slotBuilder`
(`actions.ts:82`) resolves a key's PI `slot` to a **fixed absolute index** (`builders()[slot-1]`),
so Row 1 only ever shows builders 1-4. #1410 turns Row 1 into a **4-wide window that follows the
selection**:

- The visible page is **derived from the shared cursor** (no new stored offset, so nothing can
  desync): `page = Math.floor(store.cursor.builder / 4)`; slot *i* (0-3) renders
  `builders()[page*4 + i]`. Add a `store.windowedBuilder(slotIndex)` reader; `slotBuilder`
  (or its Row 1 caller) switches to it. The per-key `slot` setting now means **position within
  the window** (1-4), not an absolute index — shape-compatible with existing profiles.
- The **Select dial** (`ZoomNav` rotate → `store.rotateCursor`) already walks `cursor.builder`
  across the whole fleet; because the page derives from the cursor, rotating past index 3 flips
  Row 1 to builders 5-8, then 9-N (trailing slots render the existing `{kind:'empty'}` face).
  No new gesture.
- **Selected-slot highlight**: the slot whose builder is `selectedBuilder()` gets an accent
  (border / brighter ground) via a `selected` flag on the face, so the live builder is
  unmistakable among the four. `face.ts` gains that accent branch.
- This is a **page**, not a per-tick slide: the four keys stay put between 4-boundaries (only the
  highlight moves), preserving muscle memory; a page flips only when the selection crosses a
  boundary. A page flip changes *which builder* each selector shows, never a key's *purpose* — so
  it is not the modal key-reflow requirement 1 rejects. (*Owner alternative:* a sliding window
  that pins the selection to a fixed edge slot and repaints every tick — worse muscle memory;
  offered if preferred.)

`apps/streamdeck/src/actions.ts`:
- **Dial press → feedback-\*** (requirement 2): in `DiffSpec.forward`, change
  `forward-file` → `feedback-file` (`DiffFileNav`) and `forward-hunk` → `feedback-hunk`
  (`DiffHunkNav`). `ScrollNav.onDialDown`: `forward-selection` → `feedback-selection`. Rotate
  and tap verbs unchanged.
- **Touchstrip mode label** (requirement 4): in `ReviewNav.renderTo`, when in diff mode append
  the mode to line 1: `Files · queue` / `Files · send` (and `Changes · …`), read from
  `store.feedbackMode()`. Canvas mode is unaffected (it already pairs axis · press meaning).
- **Row 2 [Approve gate]** (per owner decision above; recommended = selected-scoped): repurpose
  the existing `ApproveGate` action to target `store.selectedBuilder()` and relay
  `approve-gate [selectedId]`; render the selected builder's gate state (inert/alert when the
  selected builder is not blocked). *(If the owner keeps the singleton, this becomes a new
  action instead — see decision.)*
- **Row 2 [Run Dev]**: reuse the existing `DevServerAction` (already selected-scoped
  `run-dev [selectedId]`) — placed in the Row 2 profile slot. No code change.
- **Row 2 [Send Fb (N)]** (requirement 3): new `SendQueueAction` — badge `N =
  store.queuedFeedback(selectedId)`; press relays `send-queue [selectedId]`; inert (`showAlert`,
  no send) when `N === 0`. Face built via `face.ts` (a new `sendFbFaceSvg(n)` twin of
  `gatesFaceSvg`).
- **Row 2 [Next / attention]** (per owner decision; recommended): new `NextAttentionAction` —
  badge = `store.pendingGates().length` (the count the retiring singleton showed); press moves
  the selection to `store.topGateBuilderId()` via `store.syncToBuilder(...)` (a cursor move, no
  verb). Inert when no gate pends.

`apps/streamdeck/src/store.ts`: add `feedbackMode()` and `queuedFeedback(builderId)` readers off
`this.overview` (defaulting to `'forward'` / `0`), and `windowedBuilder(slotIndex)` (the
cursor-derived 4-wide window reader for Row 1).

`apps/streamdeck/src/face.ts`: add `sendFbFaceSvg(n)` (and, if Next/attention needs a distinct
glyph, a small addition) reusing the existing composite frame — accepted twin pattern; plus a
`selected`-slot accent branch on the builder face for the Row 1 highlight.

`apps/streamdeck/com.cluesmith.codev.sdPlugin/manifest.json`: add the `send-queue` action
(and `next-attention` action) UUIDs, Keypad controllers, icons; remove the retired singleton if
the owner approves retirement.

`apps/streamdeck/com.cluesmith.codev.sdPlugin/Codev.streamDeckProfile` (a zip): unzip, lay out
the 8 keys — Row 1 = 4× `builder-action` (slots 1-4), Row 2 = `approve-gate`, `dev-server`,
`send-queue`, `next-attention` — rezip. Verified visually at the hardware dev-approval session.

`apps/streamdeck/src/plugin.ts`: register the new action(s).

### E. Tests, README, docs

- Unit: deck `store` readers (`feedbackMode`/`queuedFeedback`/`windowedBuilder`); Row 1 window
  paging + selected-slot highlight (page derivation, trailing-empty slots, boundary flip);
  `SendQueueAction` inert-at-0 vs send; `NextAttentionAction` jump target; `ReviewNav` touchstrip
  mode-label; dial press relays `feedback-*` (extend `actions.test.ts`).
- Unit: VSCode mode-router commands (forward → delegates; comment → `store.add` with the right
  `PendingComment`); relay allowlist includes the new verbs and excludes an options 2nd arg
  where relevant.
- Unit: Tower overview populates `queuedFeedback` from queue files and `feedbackMode` from
  settings (fixture worktrees, matching the existing overview test style).
- Unit: the shared-selection invariant — Row 1/Row 2/dial-mode all read the same
  `selectedBuilder()`; Send Fb badge source == flush target; a diff-focus `builder-active`
  (VSCode side) fires with the focused diff's builder id (`announceActiveBuilderFromEditor`).
- `apps/streamdeck/README.md`: document the two-zone layout, the `feedback-*`/`send-queue`
  verbs, the mode-follows-setting behaviour (replace the `forward-file`/`forward-hunk` mention at
  README:120), the shared-selection coherence model (Row 1 press = select+open; diff focus
  back-syncs), and **the `builder-active` activity-hook prerequisite (E1)** for the VSCode→deck
  focus sync.

## Files to Change

- `packages/types/src/api.ts` — `OverviewData.queuedFeedback` map + `feedbackMode`. *(→ main)*
- `packages/codev/src/agent-farm/servers/overview.ts:801+` — populate both. *(→ main)*
- `packages/codev/src/agent-farm/__tests__/…` — overview wire tests. *(→ main)*
- `apps/vscode/src/command-relay.ts:24-61` — allowlist `feedback-*` + `send-queue`. *(→ main)*
- `apps/vscode/src/extension.ts:~1217-1240` — 3 mode-router commands. *(→ main)*
- `apps/vscode/src/__tests__/…` — relay + mode-router tests. *(→ main)*
- `apps/streamdeck/src/actions.ts` — Row 1 windowing (`windowedBuilder` + selected highlight),
  dial press verbs, touchstrip label, Approve repurpose, `SendQueueAction`, `NextAttentionAction`.
- `apps/streamdeck/src/store.ts` — `feedbackMode()`, `queuedFeedback()`, `windowedBuilder()`.
- `apps/streamdeck/src/face.ts` — `sendFbFaceSvg` (+ any Next glyph), selected-slot accent.
- `apps/streamdeck/src/plugin.ts` — register new actions.
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/manifest.json` — new action(s), retire singleton.
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/Codev.streamDeckProfile` — 8-key layout (zip).
- `apps/streamdeck/src/__tests__/actions.test.ts` (+ store/face tests) — deck-side coverage.
- `apps/streamdeck/README.md` — layout + verbs + mode behaviour.

## Risks & Alternatives Considered

- **Risk — `feedbackMode` sourcing from `.vscode/settings.json`.** `diffCodelensMode` is written
  with `ConfigurationTarget.Workspace`, i.e. `<root>/.vscode/settings.json` for a single-folder
  workspace (codev's normal case). A multi-root `.code-workspace` file or a user-level override
  would not be at that path, so the deck would show the default `send` label while VSCode is
  actually in `comment` mode. Mitigation: default to `'forward'`; document the single-folder
  assumption; this is the point I most want `main`'s ruling on. *Alternative:* have VSCode push
  its mode to Tower (a small state write or a relay-back channel) so the deck reads an
  authoritative push instead of Tower guessing from a file — heavier machinery; rejected for v1
  unless `main` prefers it.
- **Risk — retiring the `ApproveGate` singleton** could disrupt an existing user profile that
  pins it. Mitigation: SD+-only, pre-release; the profile is updated in the same PR and verified
  on hardware. Gated on the owner decision above.
- **Risk — enqueued deck comment has no typed body.** A dial press carries no prose, so the
  queued `PendingComment.body` is a reference marker only. Mitigation: use the same
  self-describing ref text the forward path injects; the reviewer can still edit it via the
  existing inline-thread edit flow before Submit. *Alternative:* block enqueue without a body —
  rejected; it would make the dial press useless in queue mode.
- **Risk — `forward-*` verbs left dangling.** Keeping them alive is a dead immediate-only path
  once the deck moves to `feedback-*`. Leaning to retire them from the allowlist with `main`'s
  sign-off; keeping them is the low-risk fallback.
- **Alternative rejected (per issue req 1):** activating a builder to re-flow all 8 keys into a
  per-builder modal. Kills muscle memory, ambiguous state. The two fixed zones are the design.

## Test Plan

Reviewer verifies at the **dev-approval gate on real SD+ hardware** (this is why the issue is
PIR). **Prerequisite (E1):** the `builder-active` → `streamdeck://…/active` activity hook must be
configured in `~/.codev/config.json` for the VSCode→deck focus sync — the session confirms it is
present before testing the coherence steps below:

- **Unit / CI:** `pnpm -C apps/streamdeck test`, `pnpm -C apps/vscode test`,
  `pnpm -C packages/codev test`, plus a full build. All green before the gate.
- **Manual (hardware), two-zone layout + >4 fleet:** with ≥6 (ideally 10) live builders, Row 1
  shows a 4-wide window; the selected builder's slot is highlighted. Rotating the Select dial
  (ZoomNav) past the 4th builder flips Row 1 to builders 5-8, then 9-N (trailing slots empty) —
  the four keys stay put between page boundaries (no per-tick reshuffle), and each still means
  "selector". Pressing any visible slot selects that builder (dials + Row 2 re-target it) and
  opens its phase artifact. Builders past the window are still fully actionable: dial-select →
  touchstrip tap opens the artifact, Row 2 acts on them.
- **Manual — Row 2 palette on the selected builder:** [Run Dev] starts its worktree dev;
  [Approve gate] pops the confirmation modal for the *selected* builder (approve → `porch
  approve` runs); [Next / attention] jumps the selection to the pending-gate builder and shows
  the gate count; [Send Fb (N)] is inert at N=0.
- **Manual — dials collect / mode legibility:** with `diffCodelensMode = comment`, the dial
  touchstrip reads `Files · queue` / `Changes · queue`; a diff dial press enqueues (the Send Fb
  badge `N` on the selected builder increments, the VSCode status bar / inline thread updates —
  proving the mutation went through `ReviewQueueStore`). Set `diffCodelensMode = forward`: the
  touchstrip flips to `· send`, a dial press injects into the builder terminal immediately, and
  `N` stays 0.
- **Manual — flush:** in `comment` mode, queue 2-3 chunks, then press [Send Fb (N)] → the
  batched review message lands in the selected builder's prompt buffer (VSCode's Submit Review
  flow), and `N` returns to 0.
- **Manual — overview wire:** confirm the per-builder counts are correct across ≥2 builders
  simultaneously (each key's `N` is its own builder's count, proving the map — not a scalar).
- **Manual — layer coherence (the crux):** select builder A on Row 1 → its diff opens, dials +
  Row 2 act on A. Click builder B's diff *in VSCode* → the deck selection snaps to B (Row 1
  highlight, Row 2 target, and dial mode all move to B — proving the `builder-active` back-sync).
  Enqueue a chunk with a diff dial, then flush with Send Fb — it targets the same builder you
  were viewing. Verify the Select-dial-rotate-without-open transient self-heals on the next Row 1
  press / tap-to-open.
