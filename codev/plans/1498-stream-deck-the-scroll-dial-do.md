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

### Root cause: the dial was *declared* a different kind of control

This is not "nobody wrote the render code". The Scroll dial renders one static word
because it is **declared** title-only in the manifest: it is the only dial whose
`Encoder.layout` is `layouts/label.json` (a title-only layout, no `value` or `bar`
keys), while the other five dials declare `layouts/dial.json` (title / value / bar). So
the code (`setTitle('Scroll')`, no subscription) and the manifest (a label-only layout)
were *consistent with each other* and *inconsistent with every sibling* — the dial was
built as a different class of control. That is why the fix is two-sided: the render code
adopts the `ReviewNav` subscription-and-`setFeedback` shape **and** the manifest
declaration is corrected from title-only to a two-line (title + value) layout. Fixing
only the code would set a `value` line a title-only layout cannot draw; fixing only the
manifest would leave a static word under a layout that expects a live second line.

Note (per Decision 2 below): this dial adopts the *mechanism* of the house pattern — a
subscription that re-renders `setFeedback` — but deliberately **not** the progress bar.
So its corrected layout is title + value (line 1 + line 2), a third shape distinct from
both the old title-only `label.json` and the five siblings' title/value/**bar**
`dial.json`.

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

**The two halves are mutually reinforcing, not merely compatible — and this is *the*
argument.** The press justifies the label: a dial whose press stages reversibly into
the review queue is the deck-shaped loop the earns-its-place test asks for, and a press
that swings between forward and queue *needs* a mode label so it is never a surprise.
And the label justifies the press: a dial that only scrolls has no mode to name, so
line 1 would carry nothing but the bare word `Scroll` and the whole touchstrip lane
evaporates. Drop the press and you have not simplified the dial — you have removed the
reason the strip exists. This forecloses a later "simplification" that deletes the
press without noticing it has also deleted the point of the label.

**Consequence for the empty state (small behaviour change, argued):** when there is no
selected builder, the press becomes a **silent no-op**, matching `ReviewNav`'s press in
its `none` mode (`actions.ts:847`). Today the press fires `feedback-selection`
unconditionally, which with nothing selected would forward whatever editor happens to
be focused — the opposite of "visibly inert". Gating the press on `selectedBuilder()`
makes the `No builder` state honest: the dial says No builder *and* the press does
nothing. Rotation is unaffected (see Scope).

### Decision 2 — What does the bar show? **Decision (human reviewer): drop the bar.**

The bar is removed from this dial. Its touchstrip is line 1 (`Scroll · queue`/`send`)
and line 2 (the selected builder / `No builder`) — no progress bar.

The reasoning that moved this off the earlier "builder progress" recommendation: on
this dial the rotation and the bar would be **unrelated axes**. Rotation scrolls the
*viewport within a file*; builder `progress` is *how far the builder is through its
protocol run*. The bar would not report anything the dial does. The two candidate bars
are therefore: builder progress (available, but unrelated to the dial's motion) or
scroll position (related to the motion, but **not available** — VS Code owns the
viewport and never publishes it to the overview; inventing it is out of scope and
against the deck's stated principle, `actions.ts:773-774`). Given neither bar is both
available *and* related, the honest choice is to show none rather than a bar whose fill
means something the reviewer's hand is not moving.

This is a deliberate, reviewer-made trade of **strict visual uniformity** (a bar like
the three neighbours) for **honesty** (no readout that implies a relationship that
isn't there). The uniformity cost is real and acknowledged: the Scroll dial will be the
one dial without a bar. It is mitigated by line 1 + line 2 still matching the house
`A · B` + builder-line shape, so the dial reads as a member of the cluster, just a
two-line member. Scroll *position* is still never invented, for the same reason as
before.

**Noted consequence (on the record; not acted on here).** The "unrelated axes" argument
generalises past this dial: the Files/Changes/Headings/Blocks dials' bars also show the
*selected builder's progress*, which is equally unrelated to what those dials rotate
through (files, hunks, headings, blocks). So "the bar must relate to the dial's motion"
would condemn all four bars, not just this one. The coherent alternative reading is that
the bar belongs to **line 2** — it describes the builder named there, not the rotation —
under which Scroll could carry a bar consistently. Both readings are defensible; the
owner chose "drop it" for this dial. This is recorded so that if the other three dials'
bars are ever questioned, the reasoning is already here rather than rediscovered. **No
change to the other dials is proposed or made by this lane.**

### What line 2 carries — the two-line strip is minimal, not broken

Dropping the bar makes line 2 load-bearing: five siblings render title + value + bar and
this one renders title + value, so if line 2 were thin or often empty the strip would
degrade to a bare title beside populated neighbours and read as **broken** rather than
deliberately minimal — reintroducing misinformation by a different door (an apparent
failure, not a false relationship). It does not, and here is the confirmation the
hardware gate will ask for:

- **Ordinary use (a builder is selected):** line 2 is the **selected builder**, exactly
  as its siblings render it — `#<issueId> <issueTitle>` (falling back to the builder
  `id` when it has no issue title). This is the same `selectedBuilderLine` the review
  dials use (`actions.ts:816-818`). The press acts on that builder, so naming it is the
  point, and the line is populated whenever anything is selected.
- **Nothing selected:** line 2 is `No builder` — a filled, intentional empty state, not
  a blank. Paired with the inert press (Decision 1), the dial then reads as visibly
  off, never as a failed render.

So line 2 is **always populated** — a builder line or `No builder`, never absent. The
strip is a deliberate two-line control (one fewer line than its neighbours: the bar),
not a broken three-line one. It never degrades to a bare title. There is no case where a
"viewport scroll" would leave line 2 with no meaningful value, so the lane stays
title + value and never collapses to title-only.

## Proposed Change

Rewrite `ScrollNav` to follow the `ReviewNav` subscription-and-`setFeedback` shape, and
give its touchscreen a two-line (title + value) layout — no bar (Decision 2).

### 1. `ScrollNav` (`apps/streamdeck/src/actions.ts:933`)

Turn it into a store-subscribed `SingletonAction` that tracks its dial and re-renders
on every overview tick:

- Constructor subscribes `this.store.onChange(() => this.render())`.
- Track `current?: DialAction`; set it in `onWillAppear`, clear it in
  `onWillDisappear` (mirrors `ReviewNav`).
- `onWillAppear` calls `renderTo(action)` instead of `setTitle('Scroll')`.
- `renderTo(action)` composes `setFeedback({ title, value })` — **no `bar` key**
  (Decision 2):
  - **title** = `Scroll · ${this.store.feedbackMode() === 'queue' ? 'queue' : 'send'}`
    — the `A · B` form the neighbours use.
  - **value** = the selected builder's `#issueId issueTitle` (falling back to `id`), or
    `No builder` when none — identical to `ReviewNav`'s line-2 logic
    (`actions.ts:816-818`).
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

### 2. Touchscreen layout (`apps/streamdeck/com.cluesmith.codev.sdPlugin/`)

The scroll-nav action currently declares `"layout": "layouts/label.json"` — a
title-only layout with no `value` or `bar` keys (`manifest.json:278`). It needs a
**title + value** layout: line 2 (the builder) is required, the bar is not (Decision 2).

Do **not** point it at the siblings' `layouts/dial.json`: that layout carries a `bar`
item with a default `value: 0`, so a dial that never sets `bar` would render a
permanently-empty bar — a false "0% / stalled" signal, the exact ambiguity Decision 2
avoids.

Add a **new layout named for its shape** — `layouts/title-value.json`, id
`codev-title-value` — containing `dial.json`'s `title` and `value` items (title at
`[8,8]`, value at `[8,40]`, both left-aligned) and **no `bar`** item. Point scroll-nav's
`Encoder.layout` at it. `dial.json` is untouched (the five siblings keep their bar).
Optionally refine the `Push` `TriggerDescription` to name the mode-dependent behaviour
(e.g. "Forward selection now, or queue it, per workspace mode").

*Why a new shape-named layout, not a rename of `label.json`:* a rename would be **safe**
— `label.json` is referenced exactly once (`manifest.json:278`, by scroll-nav itself),
so orphaning is not the concern. The choice is about naming for reuse. The two files are
not the same shape — `label.json` (`codev-label`) is a single **centered** line at
`[8,24,184,52]`, a true label; this dial needs two **left-aligned** lines (`dial.json`
minus the bar) — so a "rename" is really a rewrite, leaving a file whose name and id
describe a shape it no longer has. And a `scroll.json` named after its one consumer
would not survive a second dial wanting title-without-bar (any dial whose readout is
unrelated to its rotation — the general case this very decision creates). A shape name
(`title-value.json`) reuses cleanly. This is a preference, not a blocker; the add + the
`label.json` delete are no more work than the rewrite-under-a-rename would be.

**Then delete the now-orphaned `layouts/label.json` (required).** Scroll was its only
consumer (grep-confirmed: the manifest line is the sole reference) and Scroll is leaving
it for `title-value.json`, so nothing references it: no action, no code path, no doc.
This is #1440's dead-asset precedent applied to a **layout** rather than an icon —
shipping an unreferenced file in a packaged plugin is the same defect. (The original
deletion requirement survives the bar reversal; only its reason changes — orphaned
because Scroll moved off it, not because Scroll moved onto `dial.json`.)

### 3. Tests (`apps/streamdeck/src/__tests__/actions.test.ts`)

Extend the existing ScrollNav coverage (currently one rotate+press test at
`actions.test.ts:637`), modelled on the ReviewNav legibility tests
(`actions.test.ts:976-1004`):

- Existing rotate+press test stays valid — the fixture has a selected builder
  (`pir-1`), so the guarded press still fires `feedback-selection`.
- New: renders `{ title: 'Scroll · send', value: '#101 Add the relay' }` for the
  selected builder under the default (forward) fixture — and asserts **no `bar` key** is
  passed to `setFeedback` (Decision 2), so a regression that re-adds the bar is caught.
- New: renders `Scroll · queue` when the overview's `feedbackMode` is `queue`.
- New: no-builder state renders `value: 'No builder'`, and the press is a silent no-op
  (no `feedback-selection` sent).
- New: the dial re-titles on a store change (subscription wired), e.g. selection moves
  between builders — asserting `onChange` re-render like ReviewNav's move test.

## Files to Change

- `apps/streamdeck/src/actions.ts:933-954` — rewrite `ScrollNav` to a store-subscribed
  dial rendering `setFeedback({ title, value })` (no bar); guard the press on a selected
  builder; rotation unchanged. Add module-level `selectedBuilderLine(store)` helper
  (and point `ReviewNav.renderTo` at it).
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/layouts/title-value.json` — **new**
  layout, id `codev-title-value`: `dial.json`'s title + value items, no `bar`.
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/layouts/label.json` — **delete**
  (orphaned once Scroll moves to `title-value.json`; grep-verified as its only
  consumer). #1440 dead-asset precedent, applied to a layout.
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/manifest.json:278` — scroll-nav
  `Encoder.layout` `layouts/label.json` → `layouts/title-value.json`; optionally refine
  the `Push` trigger description.
- `apps/streamdeck/src/__tests__/actions.test.ts` — extend ScrollNav coverage
  (mode label, builder line, no-bar assertion, empty state + inert press, onChange
  re-render).

### Out-of-band: one doc file folded from a merged sibling lane

Not part of the Scroll change; carried in this PR at the architect's direction to save a
standalone CI cycle (precedent #1454). A doc-only append to a file this lane does not
otherwise touch, kept as its own clearly-labelled commit so it stays separable in review
and in the consult pass:

- `codev/reviews/1495-stream-deck-architect-action-k.md` — append the "Protocol Note —
  the pir-1495 lane reproduced #1462 live" section (verbatim from the architect, with
  the one edit "this lane" → "the pir-1495 lane"). Landed against the current `main`
  copy of the file (fetch `origin/main` first so the append lands on its live content).

## Risks & Alternatives Considered

- **Risk: the layout change alters an installed board.** The layout is read from the
  manifest at plugin load; a reinstalled/reloaded plugin picks up `title-value.json`. No
  user data or key placement changes. A stale install pointing at the removed
  `label.json` path is not a concern — the manifest that names the layout and the layout
  files ship together in the same package. Verified on hardware at the dev-approval gate.
  Mitigation: display-only layout change; rotation and press wiring are independent of it.
- **Risk: press-gating is a behaviour change.** Today the press always fires; gating it
  on `selectedBuilder()` means it no-ops when nothing is selected. This is deliberate
  (Decision 1) and matches `ReviewNav`. It only affects the no-builder case, which
  previously forwarded an arbitrary editor's selection — the change makes the inert
  state honest.
- **Alternative — drop the press entirely** (Decision 1). Rejected: it removes the
  queue-mode reversible loop and leaves line 1 as a bare `Scroll` with no mode to name,
  which defeats the issue's core goal.
- **Alternative — builder-progress bar** (Decision 2, the earlier recommendation).
  Set aside by the reviewer: on this dial the bar's fill and the dial's rotation are
  unrelated axes, so a builder-progress bar would imply a relationship that isn't there.
  Uniformity with the neighbours was judged the weaker value here.
- **Alternative — scroll-position bar** (Decision 2). Rejected: position is not on the
  overview; VS Code owns it; the deck deliberately shows what the dial does, not a
  counter (`actions.ts:773-774`).
- **Alternative — keep `dial.json` and hide the bar via `setFeedback`.** Rejected:
  relies on per-item feedback overrides and still ships a bar item the dial never means;
  a dedicated title+value layout is declarative and assertable in the manifest tests.
- **Alternative — inline the line-2 logic** instead of the shared helper. Acceptable;
  the helper is the SSOT-cleaner choice and both live in one file.
- **Risk: adding `title-value.json` + deleting `label.json` breaks a packaged/validation
  test.** The new layout is referenced by scroll-nav; `label.json` is deleted only after
  grep confirms scroll-nav was its sole reference (`manifest.json:278`). The streamdeck
  suite (`validate`, `manifest-icons`) runs green as a gate — every referenced layout
  must ship and every shipped layout must be referenced.

## Test Plan

- **Unit** (`apps/streamdeck`, `pnpm --filter @cluesmith/codev-streamdeck test` or the
  repo test runner): the new/updated ScrollNav cases above, plus the full streamdeck
  suite green (ReviewNav string assertions must remain unchanged, proving the shared
  helper is byte-identical). Run `check-types` too, not just vitest.
- **Manual (dev-approval — hardware session, both modes are mandatory):** the mode label
  is the entire point, so a single-mode demo proves nothing.
  1. Select a builder with a diff. Confirm the Scroll dial reads `Scroll · send` (line
     1) and `#<id> <title>` (line 2), with **no progress bar** on the strip.
  2. Rotate: the focused editor's viewport scrolls up/down, caret unmoved
     (`revealCursor:false`) — unchanged from today.
  3. With the workspace in **forward** mode (`codev.diffCodelensMode`), select text and
     press: the selection is forwarded to the builder immediately. Line 1 read `send`
     beforehand.
  4. Switch the workspace to **comment/queue** mode. Confirm line 1 now reads
     `Scroll · queue`. Select text and press: it stages into the review queue (visible
     on the Send Fb key's badge) rather than interrupting the builder.
  5. Deselect (no builder selected / empty fleet): confirm the dial reads `No builder`,
     and a press does nothing (no forward, no queue) — visibly inert.
- **Cross-platform:** n/a (Stream Deck plugin only).
