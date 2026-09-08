# Phase 3 (Canvas remote command seam) — Iteration 1 Rebuttals

Verdicts: gemini APPROVE · codex REQUEST_CHANGES · claude REQUEST_CHANGES.

Every point is accepted and fixed, except one where the fix landed but the described failure
mode turned out not to be reproducible, and one where the reported symptom is pre-existing
behavior that the remote path reproduces faithfully. Both are documented below with the evidence,
because in each case the honest answer changed what the test should assert.

## Claude

**1. (Blocking) The traversal drift guard is inert.** Accepted, and this was the worst finding
because it is the exact defect class phase 1 was sent back for: a guard that cannot fail.

```ts
type _EveryTraversalCommandIsListed =
  Exclude<TraversalCommand, (typeof TRAVERSAL_COMMANDS)[number]> extends never ? true : never;
```

A bare type alias imposes no constraint, so an omitted command resolves to `never` and compiles.
I verified independently rather than taking the report on trust, with a minimal probe under the
workspace TypeScript: my form exited 0, the `Assert<T extends true>` form failed with TS2344.
Fixed by reusing phase 1's own pattern, and then **verified in the real file** by deleting
`'column-back'` from the list, confirming `check-types` fails with
`TS2344: Type 'false' does not satisfy the constraint 'true'`, and restoring.

The comment claiming enforcement was also false, so it now explains *why* the wrapper is what
makes the assertion bite. My thread log carried the same false claim and has been corrected.

**2. Unbounded `count` loop.** Accepted. `runCanvasCommand` now captures a position signature
before each step and breaks as soon as a step changes nothing, which stops at the edge and bounds
the work to what actually exists. The signature is origin line **plus** `scrollLeft`, because
column paging moves the scroll offset and leaves focus alone, so a line-only check would have
made counted paging stop after one step. Covered by a unit test with `count: 1_000_000` and a
browser test asserting a huge count lands at the end quickly.

**3. Quiet-focus not re-armed on the remote path.** Accepted; the spec does say remote navigation
focuses the way the keyboard does. `runCanvasCommand` now clears `codev-canvas-quiet-focus`, the
same first move `onBodyKeyDown` makes.

**4. Test gaps and the unused `act` import.** Accepted. Added adapter cases for `comment-prev`
and `heading-prev`, a backwards no-wrap case, and the Tab non-goal case (asserting the canvas
does not call `preventDefault` on Tab and does not move focus). The stale `act` import is gone.

**5. `readingMode` read from the closure in `currentBlock` while `toggleReadingMode` reads the
ref.** Accepted; `currentBlock` now reads the ref too, so a navigation batched behind a toggle
measures against the mode that toggle already chose.

## Codex

**1. `column-forward/back` do not check horizontal mode.** Fix accepted and applied: both actions
now return false unless the mode is horizontal, which also keeps the remote path consistent with
the key path (the handler already gated on mode before dispatching).

The stated consequence, however, does not reproduce, and the test I first wrote for it failed for
that reason. `overflow-x: auto` on the canvas body is scoped to
`.codev-canvas-mode-horizontal` (`default-theme.css:490-497`), so in vertical mode the body is
not a horizontal scroll container at all: my attempt to set `scrollLeft = 40` on it read back 0.
The guard is still right as defense against a host stylesheet that makes the body scrollable, and
it makes the intent explicit, so it stays. The browser test now asserts what is actually true and
verifiable (vertical mode has nothing to scroll, and paging leaves it at 0) and records why the
stronger scenario is unreachable, rather than passing vacuously while appearing to prove more.

**2. Counted traversal continues after an edge.** Same fix as claude's point 2.

**3. Missing coverage: all 14 commands, reverse jumps, scrolled clean-state origin, column
`count`, real-browser remote column paging.** Accepted. Reverse jumps and the remaining commands
are covered in the unit suite. For the browser gap I made the dev page a real host: it now
implements `CommandAdapter` over `window.__canvasCommand`, which is the shape any host
implements, and a new `playwright/remote-commands.spec.ts` drives it for column paging on the
measured grid, counted paging, the huge-count bound, vertical-mode inertness, and scroll-into-view.
This is the only way to assert paging at all, since jsdom reports no layout.

One sub-item resolved differently: I first asserted that remote `doc-end` scrolls the last block
into view, and it failed. Probing the keyboard equivalent showed `End` behaves **identically**
(both land on line 1106 with `scrollLeft` 0), because that fixture's last block is a table row
whose scrollable ancestor is the table rather than the canvas body. That is pre-existing
behavior, and reproducing it exactly is the parity the spec asks for, so changing it would breach
the phase's "no change to in-page behavior" non-goal. The test now mirrors the keyboard suite's
`n` case with a marked block, where the body genuinely is the scroller.

## Gemini (APPROVE)

No issues raised; no changes required.

## Verification after the fixes

- `check-types` clean; drift guard verified to fail on an omitted command, then restored.
- 173/173 unit tests (4 new since iteration 1).
- 38/38 Playwright, including 5 new remote-command specs, on the committed config.
