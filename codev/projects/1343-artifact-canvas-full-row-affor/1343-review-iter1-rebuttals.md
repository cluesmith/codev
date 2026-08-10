# Iteration 1 Rebuttals — PIR #1343

## Codex (REQUEST_CHANGES) — all three findings confirmed real and fixed

### 1. Affordance-origin focus/keydown retargets nested lines

**Accepted, fixed in `ea234cd27`.** Tab-focusing the "+" (or a key pressed on it) re-resolved
through `closest('[data-line]')` to the HOST row, retargeting an `li`'s line to the `ul`'s line.
A shared `fromAffordance` guard now no-ops all three activation paths (pointer, focus, body
keydown) for events originating inside the wrapper; the button's native Enter/Space activation →
`onClick` carries the correct line. Regression test added: "focus and keydown on the affordance
never retarget it either" (`full-row-affordance.test.tsx`) — asserts the label stays on the
`li`'s line through focus and keydown, and that activation opens the composer for the `li`'s
0-based line (`onAddComment(7, …)`).

Mechanism refinement (from Claude's pass, `735818a84`): the React portal already isolates these
events from the body handlers (portal events propagate through the React tree, whose parent is
the canvas div, not the body div). The guards therefore act as defense-in-depth and the comments
+ test now state that explicitly — the test pins the behavior so a future non-portal rendering
(where DOM bubbling WOULD reach the body handlers) cannot silently regress nested-line targeting.

### 2. lessons-learned.md corruption

**Accepted, fixed in `ea234cd27`.** The `[From #1237]` focus-restoration lesson had lost its
header in my edit and its tail was glued onto the new `[From #1343]` portal lesson. Restored as
its own bullet; both lessons read correctly now.

### 3. Nested marker-card/composer hosts double-indented

**Accepted, fixed in `ea234cd27`, superseded by a cleaner rule in `735818a84`.** Stacks/hosts for
nested blocks are injected inside their row (which already carries the gutter), so the unscoped
`margin-left` double-indented them. Final form: one child-combinator rule,
`.codev-artifact-canvas-body > :not([data-line]) { margin-left: var(--codev-canvas-gutter) }`,
which scopes the gutter to top-level injected siblings only AND fixes Claude's unmapped-block
finding (below) in the same stroke. Pinned by CSS-contract assertions in `default-theme.test.ts`.

## Claude (COMMENT) — advisory notes, two acted on, one declined, one documented

1. **`hr` / raw-HTML blocks lost the leading indent** (renderer stamps `data-line` only on
   `_open`/fence tokens): **accepted, fixed in `735818a84`** via the generic `:not([data-line])`
   margin rule above.
2. **Affordance-origin guards unreachable via React portal event routing**: **accepted as
   accurate** — comments and the regression test now describe the real mechanism; guards kept
   deliberately (see Codex #1 disposition).
3. **Hoist `placeAffordance` above the effect that calls it**: **declined** — style preference;
   the file's established pattern defines handlers after the effects that close over them, and
   the call executes post-render, so there is no TDZ hazard.
4. **Narrow tables (`width: max-content`) don't span the full row** (hover to their right lands
   on sticky whitespace): **documented** in the review file as a v1 wrinkle alongside the
   table-scroll limitation — both share the same future fix (a full-width scroll wrapper around
   tables), which is out of scope here.

## State after fixes

98/98 package tests pass (2 added since the consultation snapshot), `tsc --noEmit` clean, build
clean. All fixes are on PR #1385 (`ea234cd27`, `735818a84`). PIR's consultation is single-pass:
these dispositions were not independently re-reviewed and are flagged for the human at the `pr`
gate.
