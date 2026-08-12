# PIR Plan: Map review dials to composer-open-or-submit / composer-cancel

## Understanding

The bridge command `composer-open-or-submit` landed on main in PR #1424 (the #1420
bridge lane) and is wired through all four allowlists, but nothing on the deck sends it
yet, so the hands-free review flow does not exist on hardware. This lane is the deck half:
wire the two canvas-mode review dial presses to the new command pair and make the
touchstrip say which press does what.

Today both review dials share one press handler. In canvas mode (`ReviewNav.onDialDown`,
`apps/streamdeck/src/actions.ts:602-612`) both presses send `composer-open` — the #1400
decision this issue supersedes. The two concrete dials are:

- `DiffFileNav` — the **coarse** dial; canvas rotate steps `Headings`
  (`actions.ts:641-658`).
- `DiffHunkNav` — the **fine** dial; canvas rotate steps `Blocks`
  (`actions.ts:660-678`).

`CanvasSpec` (`actions.ts:509-516`) has no press field precisely because the press was
identical across dials (see its doc comment at `actions.ts:504-508`). Both target
`CanvasCommand` members that already exist in the type and the canvas-relay allowlist:
`composer-open-or-submit` and `composer-cancel` (`packages/types/src/canvas-command.ts:54,56`;
`packages/codev/src/agent-farm/servers/canvas-relay.ts:81-82`). The canvas already
implements both semantics (`packages/artifact-canvas/src/components/ArtifactCanvas.tsx:948,957`):
open-or-submit opens at the focused block when none is open, submits (trim, no-op on empty)
when one is; cancel is a no-op when nothing is open. So the deck change is purely a client
remap plus label — no bridge, canvas, types, or host changes (issue requirement 4).

## Proposed Change

**1. Per-dial press command.** Give `CanvasSpec` a `press: CanvasCommand` field and have
`onDialDown` send `this.canvas.press` in canvas mode instead of the hardcoded
`composer-open`. Set:

- `DiffHunkNav` (fine): `press: 'composer-open-or-submit'`
- `DiffFileNav` (coarse): `press: 'composer-cancel'`

This is the natural extension of the existing spec pattern — the reason the field did not
exist is stated in the current doc comment, and that reason no longer holds. Update the
`CanvasSpec` doc comment accordingly.

**2. Touchstrip legibility.** Add a `pressLabel: string` to `CanvasSpec` (a short human
hint) and render it in canvas mode so a reviewer can tell the two presses apart at a
glance. The dial feedback today is `{ title: label, value: details, bar }`
(`actions.ts:583`), where line 1 (`title`) names the rotate axis and line 2 (`value`)
identifies the builder under review. In canvas mode, make line 1 read
`` `${label} · ${pressLabel}` `` so the rotate axis and the press meaning sit together
while line 2 keeps the builder identity. Proposed labels:

- Fine / `Blocks`: `pressLabel: 'Open/Submit'` → line 1 `Blocks · Open/Submit`
- Coarse / `Headings`: `pressLabel: 'Cancel'` → line 1 `Headings · Cancel`

`Open/Submit` (not just `Submit`) is honest about the contextual command: the first fine
press opens the composer, the second submits. Diff mode is untouched — its `title` stays
the bare `diff.label`.

Width note: the Stream Deck+ touchstrip title is narrow. `Headings · Cancel` is short;
`Blocks · Open/Submit` (~20 chars) is the one to watch. This is the single item to confirm
on hardware at dev-approval — if it truncates, the fallback is to shorten the fine label to
`Blocks · Submit` (the submit is the action a reviewer waits on). I will surface the
rendered strip to the architect at the gate before deciding.

**3. Submit/cancel only, no text entry** (issue requirement 5, unchanged): the deck only
sends the command verbs; dictation happens in the composer textarea via the OS, exactly as
today. No text ever crosses the deck.

### Dial-semantics summary (routed to architect before the gate)

| Dial | Canvas rotate | Canvas press → command | Touchstrip line 1 |
|---|---|---|---|
| Fine (`DiffHunkNav`) | Blocks | `composer-open-or-submit` | `Blocks · Open/Submit` |
| Coarse (`DiffFileNav`) | Headings | `composer-cancel` | `Headings · Cancel` |

Tap and rotate are unchanged. Diff mode (implement/review phases) is unchanged.

## Files to Change

- `apps/streamdeck/src/actions.ts:509-516` — add `press: CanvasCommand` and
  `pressLabel: string` to `CanvasSpec`; rewrite its doc comment (the "press is always
  composer-open, so it is shared" rationale is now obsolete).
- `apps/streamdeck/src/actions.ts:604-606` — `onDialDown` canvas branch sends
  `this.canvas.press` instead of `'composer-open'`.
- `apps/streamdeck/src/actions.ts:578-584` — `renderTo` composes line 1 as
  `` `${label} · ${this.canvas.pressLabel}` `` in canvas mode; diff mode unchanged.
- `apps/streamdeck/src/actions.ts:652-657` (`DiffFileNav.canvas`) — add
  `press: 'composer-cancel'`, `pressLabel: 'Cancel'`.
- `apps/streamdeck/src/actions.ts:672-677` (`DiffHunkNav.canvas`) — add
  `press: 'composer-open-or-submit'`, `pressLabel: 'Open/Submit'`.
- `apps/streamdeck/src/__tests__/actions.test.ts:198-227` — update the two canvas-mode
  press assertions (`composer-open` → per-dial command); add a coarse-press-cancel
  assertion; add a `renderTo`/`setFeedback` assertion that line 1 carries the pressLabel in
  canvas mode. No new test file.

Scope is `apps/streamdeck` only (requirement 4).

## Risks & Alternatives Considered

- **Risk: touchstrip truncation** of `Blocks · Open/Submit`. Mitigation: confirm on
  hardware at dev-approval; documented fallback is `Blocks · Submit`. Low blast radius
  (cosmetic, one string).
- **Risk: mislabeling the fine press as one action** when it is contextual (open then
  submit). Mitigation: `Open/Submit` names both states; the canvas is the sole owner of
  open/closed state and already branches correctly (`ArtifactCanvas.tsx:957`), so the deck
  stays stateless.
- **Alternative: encode press meaning on line 2 (`value`) instead of line 1.** Rejected —
  line 2 identifies the builder under review (id + title + progress bar), which a reviewer
  needs; press meaning is a property of the dial, so it belongs with the axis label on
  line 1.
- **Alternative: keep one shared press and branch on `manifestId` inside `onDialDown`.**
  Rejected — the spec-per-dial pattern already exists for rotate/tap; a `manifestId` switch
  would be a second, inconsistent dispatch mechanism.
- **Alternative: a dynamic touchstrip that flips the label to `Submit` once a composer is
  open.** Rejected — the deck has no composer-open signal (canvas owns that state, #1420),
  and adding a back-channel is out of scope (requirement 4). A static per-dial label is
  legible enough.

## Test Plan

**Unit (`apps/streamdeck`, `pnpm --filter @cluesmith/codev-streamdeck test`):**

- Fine dial in canvas mode: `onDialDown` sends `composer-open-or-submit` (workspace target,
  `count: undefined`).
- Coarse dial in canvas mode: `onDialDown` sends `composer-cancel`.
- Diff mode press unchanged (still forwards `forward-file` / `forward-hunk`).
- `renderTo` in canvas mode: `setFeedback` line 1 includes the dial's `pressLabel`
  (`Open/Submit` for fine, `Cancel` for coarse); diff mode line 1 is the bare `diff.label`.
- `check-types` + `test` green in the worktree.

**Hardware (dev-approval gate — a physical Stream Deck+ session):**

Sideload swap (current Elgato Plugins symlink points at the **pir-1400** worktree —
verified `…/Plugins/com.cluesmith.codev.sdPlugin -> …/.builders/pir-1400/…`):

```bash
# from the monorepo root (main checkout)
pnpm --filter @cluesmith/codev-sdk build
pnpm --filter @cluesmith/codev-streamdeck build   # builds pir-1425/.../bin/plugin.js
streamdeck unlink com.cluesmith.codev
streamdeck link .builders/pir-1425/apps/streamdeck/com.cluesmith.codev.sdPlugin
streamdeck restart com.cluesmith.codev
streamdeck list                                   # confirm it points at pir-1425
```

Verify the flow from the issue:

1. Navigate to a block (fine dial rotate) → touchstrip reads `Blocks · Open/Submit`.
2. Fine press → composer opens at the focused block.
3. Dictate into the composer (OS dictation).
4. Fine press again → draft submits as a comment.
5. Coarse press with a composer open → composer cancels (draft discarded).
6. Fine press on an open-but-empty composer → nothing happens, draft/composer preserved
   (open-or-submit trims and no-ops on empty).
7. Touchstrip on the coarse dial reads `Headings · Cancel`; confirm neither line-1 string
   truncates unacceptably.

Restore the sideload after the gate (return the deck to the prior build):

```bash
# from the monorepo root
streamdeck unlink com.cluesmith.codev
streamdeck link .builders/pir-1400/apps/streamdeck/com.cluesmith.codev.sdPlugin
streamdeck restart com.cluesmith.codev
streamdeck list                                   # confirm restored to pir-1400
```

(If pir-1400's worktree is gone by then, relink whatever build the architect designates —
the restore target is "the deck's prior state," confirmed with the architect at the gate.)
