# PIR Plan: Scroll dial narrates itself (mode, builder, empty state)

## Understanding

On the Stream Deck board four dials sit side by side. Three of them — Zoom
(`ZoomNav`), Review: Files/Headings (`DiffFileNav`), Review: Changes/Blocks
(`DiffHunkNav`) — render the house touchstrip layout on every store change: line 1
the live semantic, line 2 the builder under review (`#issue title`), a progress bar.
The fourth, the Scroll dial (`ScrollNav`, `apps/streamdeck/src/actions.ts:933`), does
none of this. It calls `setTitle('Scroll')` once in `onWillAppear` and never touches
the touchstrip again — no `store.onChange` subscription, no `setFeedback`.

This is a correctness gap, not cosmetics, for two reasons the issue names:

1. **Its press is mode-dependent and it is the only dial that never names its mode.**
   Since #1410 the press sends the mode-neutral `feedback-selection`
   (`actions.ts:952`), which VS Code either forwards to the builder immediately *or*
   stages into the review queue depending on the workspace's `codev.diffCodelensMode`.
   That "immediate vs staged" surprise is exactly what #1410's touchstrip work
   eliminated on the neighbours by titling them `Files · queue` vs `Files · send`. The
   dial whose press is *most* mode-dependent is the only one that stays silent about
   its mode.
2. **It acts on the selected builder but never shows which one.** Every other
   builder-scoped surface names its builder; the Scroll dial does not, and shows an
   unchanging `Scroll` even when there is no builder to act on — live-looking and dead.

The store already holds every value needed: `feedbackMode()` returns
`'forward' | 'queue'` (`store.ts:179`) and `selectedBuilder()` returns the current
`OverviewBuilder` with `issueId`, `issueTitle`, and `progress` (`store.ts:146`). No
wire, relay, types, or VS Code change is required. `ReviewNav` (`actions.ts:775`)
already implements the exact target shape; this is adopting an existing pattern, not
inventing one.

## The two plan-time decisions

### Decision 1 — Does the press earn its place? **Recommendation: keep it.**

The board's own criterion: a gesture earns its place if the press completes an
intention, or opens a loop the deck itself can close. Judged narrowly, a selection
press is weak — to *have* a selection your hand is already on the keyboard, where
`Cmd/Ctrl+K B` lives, so the deck is not saving a context switch.

But two things make keeping it the right call:

- **Under queue mode the press is a genuinely deck-shaped loop.** It *stages* the
  selection into the review queue rather than interrupting the builder — cheap,
  reversible, and flushed later by the Send Fb key (`SendQueueAction`). That is a
  press-and-move-on loop the deck closes, not a keyboard shortcut in disguise.
- **The press is what makes the mode label meaningful.** The entire payoff of this
  change is line 1 naming `queue` vs `send` so the press is never a surprise. Drop the
  press and there is no mode to name; line 1 collapses back to a bare `Scroll` and the
  dial is once again the one dial that only scrolls. Keeping the press and *naming its
  mode* is the coherent resolution of the surprise, and it keeps the dial consistent
  with its three feedback-forwarding neighbours.

The honest tension is `send` (forward) mode, where the press *does* interrupt the
builder immediately — not deck-shaped. The fix is not to remove the press but to
label it: `Scroll · send` warns you before you press. That is precisely the legibility
this issue exists to add.

**Consequence for the empty state (small behaviour change, argued):** when there is no
selected builder, the press becomes a **silent no-op**, matching `ReviewNav`'s press in
its `none` mode (`actions.ts:847`). Today the press fires `feedback-selection`
unconditionally, which with nothing selected would forward whatever editor happens to
be focused — the opposite of "visibly inert". Gating the press on `selectedBuilder()`
makes the `No builder` state honest: the dial says No builder *and* the press does
nothing. Rotation is unaffected (see Scope).

### Decision 2 — What does the bar show? **Recommendation: builder progress.**

The selected builder's `progress`, exactly as the three neighbours render it. This is
honest and consistent.

Scroll *position* is deliberately **not** shown. VS Code owns the viewport and the deck
never mirrors it — `ReviewNav`'s own comment (`actions.ts:773-774`) records the
principle: "VSCode owns the actual position, so the screen shows what the dial does
(line 1) and which builder is under review (line 2 + progress bar) — not a counter."
No scroll-position bar will be invented.

## Proposed Change

Rewrite `ScrollNav` to follow the `ReviewNav` shape, and switch its touchscreen layout
to the house dial layout so it can render a bar.

### 1. `ScrollNav` (`apps/streamdeck/src/actions.ts:933`)

Turn it into a store-subscribed `SingletonAction` that tracks its dial and re-renders
on every overview tick:

- Constructor subscribes `this.store.onChange(() => this.render())`.
- Track `current?: DialAction`; set it in `onWillAppear`, clear it in
  `onWillDisappear` (mirrors `ReviewNav`).
- `onWillAppear` calls `renderTo(action)` instead of `setTitle('Scroll')`.
- `renderTo(action)` composes `setFeedback({ title, value, bar })`:
  - **title** = `Scroll · ${this.store.feedbackMode() === 'queue' ? 'queue' : 'send'}`
    — the `A · B` form the neighbours use.
  - **value** = the selected builder's `#issueId issueTitle` (falling back to `id`), or
    `No builder` when none — identical to `ReviewNav`'s line-2 logic
    (`actions.ts:816-818`).
  - **bar** = `Math.round(b?.progress ?? 0)`.
- `onDialRotate` is **unchanged** — the same viewport `scroll` command,
  `revealCursor: false`, `SCROLL_LINES_PER_TICK`.
- `onDialDown` gains a guard: if `!this.store.selectedBuilder()` return (silent no-op,
  like `ReviewNav` `none` mode); otherwise fire `feedback-selection` exactly as today.

To avoid duplicating the line-2 logic verbatim between `ScrollNav` and `ReviewNav`
(same file, same three lines), extract a tiny module-level helper
`selectedBuilderLine(store): string` that returns `#id title` / `id` / `No builder`,
and call it from both. This is an SSOT tidy of an exact duplication, produces
byte-identical output (existing `ReviewNav` string assertions stay green), and stays
inside the file. *(Alternative if a reviewer prefers minimal blast radius: inline the
three lines in `ScrollNav` and leave `ReviewNav` untouched — the duplication is small.
I lean to the helper.)*

### 2. Manifest layout (`apps/streamdeck/com.cluesmith.codev.sdPlugin/manifest.json`)

The scroll-nav action currently declares `"layout": "layouts/label.json"` — a
title-only layout with no `value` or `bar` keys (`manifest.json:263`). Every
house-layout dial uses `layouts/dial.json`, which defines `title` / `value` / `bar`.
Change scroll-nav's `Encoder.layout` to `layouts/dial.json` so `setFeedback` can render
line 2 and the bar. Optionally refine the `Push` `TriggerDescription` to name the
mode-dependent behaviour (e.g. "Forward selection now, or queue it, per workspace
mode").

`layouts/label.json` is used **only** by scroll-nav (confirmed by grep), so after the
switch it is orphaned. Delete it as dead weight, provided no test enumerates it (the
only reference is the manifest line being changed). *(Alternative: leave it in place —
harmless but dead; I lean to deleting.)*

### 3. Tests (`apps/streamdeck/src/__tests__/actions.test.ts`)

Extend the existing ScrollNav coverage (currently one rotate+press test at
`actions.test.ts:637`), modelled on the ReviewNav legibility tests
(`actions.test.ts:976-1004`):

- Existing rotate+press test stays valid — the fixture has a selected builder
  (`pir-1`), so the guarded press still fires `feedback-selection`.
- New: renders `Scroll · send` / `#101 Add the relay` / bar `45` for the selected
  builder under the default (forward) fixture.
- New: renders `Scroll · queue` when the overview's `feedbackMode` is `queue`.
- New: no-builder state renders `value: 'No builder'`, `bar: 0`, and the press is a
  silent no-op (no `feedback-selection` sent).
- New: the dial re-titles on a store change (subscription wired), e.g. selection moves
  between builders — asserting `onChange` re-render like ReviewNav's move test.

## Files to Change

- `apps/streamdeck/src/actions.ts:933-954` — rewrite `ScrollNav` to a store-subscribed
  dial rendering `setFeedback({title,value,bar})`; guard the press on a selected
  builder; rotation unchanged. Add module-level `selectedBuilderLine(store)` helper
  (and point `ReviewNav.renderTo` at it).
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/manifest.json:263` — scroll-nav
  `Encoder.layout` `layouts/label.json` → `layouts/dial.json`; optionally refine the
  `Push` trigger description.
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/layouts/label.json` — delete (orphaned
  after the switch).
- `apps/streamdeck/src/__tests__/actions.test.ts` — extend ScrollNav coverage
  (mode label, builder line, empty state + inert press, onChange re-render).

## Risks & Alternatives Considered

- **Risk: switching the manifest layout changes an installed board.** The layout key is
  read from the manifest at plugin load; a reinstalled/reloaded plugin picks up
  `dial.json`. No user data or key placement changes. Verified on hardware at the
  dev-approval gate. Mitigation: this is a display-only layout swap; rotation and press
  wiring are independent of it.
- **Risk: press-gating is a behaviour change.** Today the press always fires; gating it
  on `selectedBuilder()` means it no-ops when nothing is selected. This is deliberate
  (Decision 1) and matches `ReviewNav`. It only affects the no-builder case, which
  previously forwarded an arbitrary editor's selection — the change makes the inert
  state honest.
- **Alternative — drop the press entirely** (Decision 1). Rejected: it removes the
  queue-mode reversible loop and leaves line 1 as a bare `Scroll` with no mode to name,
  which defeats the issue's core goal.
- **Alternative — scroll-position bar** (Decision 2). Rejected: position is not on the
  overview; VS Code owns it; the deck deliberately shows what the dial does, not a
  counter (`actions.ts:773-774`).
- **Alternative — inline the line-2 logic** instead of the shared helper. Acceptable;
  the helper is the SSOT-cleaner choice and both live in one file.

## Test Plan

- **Unit** (`apps/streamdeck`, `pnpm --filter @cluesmith/codev-streamdeck test` or the
  repo test runner): the four new/updated ScrollNav cases above, plus the full
  streamdeck suite green (ReviewNav string assertions must remain unchanged, proving the
  shared helper is byte-identical). Run `check-types` too, not just vitest.
- **Manual (dev-approval — hardware session, both modes are mandatory):** the mode label
  is the entire point, so a single-mode demo proves nothing.
  1. Select a builder with a diff. Confirm the Scroll dial reads `Scroll · send` (line
     1), `#<id> <title>` (line 2), and a progress bar matching the builder.
  2. Rotate: the focused editor's viewport scrolls up/down, caret unmoved
     (`revealCursor:false`) — unchanged from today.
  3. With the workspace in **forward** mode (`codev.diffCodelensMode`), select text and
     press: the selection is forwarded to the builder immediately. Line 1 read `send`
     beforehand.
  4. Switch the workspace to **comment/queue** mode. Confirm line 1 now reads
     `Scroll · queue`. Select text and press: it stages into the review queue (visible
     on the Send Fb key's badge) rather than interrupting the builder.
  5. Deselect (no builder selected / empty fleet): confirm the dial reads `No builder`
     with an empty/zero bar, and a press does nothing (no forward, no queue) — visibly
     inert.
- **Cross-platform:** n/a (Stream Deck plugin only).
