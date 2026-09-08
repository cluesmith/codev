# Spec 1380 — iteration 1 rebuttals

Both reviews were substantive and verified claims against the code; every finding was either
accepted into the spec or is answered below. No finding is disputed.

## Codex (REQUEST_CHANGES)

1. **Over-tall individual marker card defeats `break-inside: avoid`.** Accepted — this was a
   real gap in D1, and the spike's finding 3 (Chromium fragments + overflows a too-tall
   protected block) makes it consequential, not theoretical. D1 now caps a card's body at the
   column height with inner vertical scroll, same mechanism as code, so the protected-block
   fallback is never entered for any protected type.

2. **Standalone `MarkdownView` scope unclear.** Accepted. Desired State now states horizontal
   mode is a composed-surface (`ArtifactCanvas`) feature only; `MarkdownView` gets no toggle,
   no mode class, no new CSS.

3. **Wheel behavior over inner vertical scrollers undefined.** Accepted — an unconditional
   remap would make tall code/tables/the composer unscrollable, which would fail the spec's
   own "fully readable via inner scroll" criterion. Desired State now defines yield-first
   semantics (inner scroller consumes while it can; remap only what content cannot consume),
   with test scenario 5 extended to cover it.

4. **Resize/zoom coverage missing.** Accepted. New success criterion + test scenario 5b:
   column geometry, caps, and progress recompute on container resize/zoom, and the
   viewport-start block is kept in view (reusing D7's anchor).

5. **Persistence validation/failure behavior unspecified.** Accepted. D4 now specifies:
   unrecognized persisted values are coerced to vertical, persistence failures degrade to the
   vertical default with a functional toggle; success criterion and test scenario 15 added.

## Claude (COMMENT)

1. **Bounded-height assumption is false in both v1 hosts; host work hidden.** Accepted — the
   strongest finding of the round, and correct on disk (neither the webview template nor the
   example page establishes a height context, and the body is not a scroll container today).
   Constraint 3 now scopes the minimal host wiring (a height rule per host + D4 persistence
   glue) explicitly into v1, states that no mode logic lives in hosts, and the Assumptions
   section defines where column height comes from (canvas root's resolved height, observed
   for resize). Unbounded-height embeds self-bound to the visual viewport height — new
   success criterion so it's testable.

2. **`--codev-canvas-prose-max-width` collides with the multicol container.** Accepted — a
   host setting the token's documented value would collapse the mode to one column. D6 now
   declares the prose cap inert in horizontal mode; measure is governed solely by the
   column-width token.

3. **Keyboard scrolling of the container undefined.** Accepted. Desired State now defines
   PageDown/PageUp as one-column steps, preserves every existing block binding (Space/Enter
   keep their composer meaning), and exempts composer focus from interception.

4. **Cross-column text selection unspecified.** Accepted as a verification scenario (5c):
   selection/copy across a boundary must follow document order; engine-owned defects, if any,
   are documented as known limitations rather than worked around.

5. **Coerce garbage persisted mode values.** Accepted — folded into D4 with Codex 5.

6. **Promote the spike into a committed Playwright fixture.** Accepted — test scenario 14:
   the load-bearing fragmentation invariants (protected-rect counts, tall-block fit,
   per-fragment rects) become a committed real-browser regression test over a fixture
   document. The spike page itself stays throwaway; what gets committed is a test asserting
   its findings.

## Not changed

- Approach 1 and all eight decision records stand as reviewed (both reviewers concurred with
  the approach and the decisions; the changes above refine their edges, not their substance).
