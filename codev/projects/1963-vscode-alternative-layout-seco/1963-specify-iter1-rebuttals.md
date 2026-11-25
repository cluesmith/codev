# Spec 1963 — iteration 1 rebuttals

All points from both reviewers were accepted. Nothing is disputed. Changes are in commit
`[Spec 1963] Specification with multi-agent review`.

## Claude (REQUEST_CHANGES)

1. **Menu `when` contradiction (must fix).** Accepted. The spec now chooses option (b): existing
   `view/item/context` / `view/title` entries for `codev.workspace` / `codev.agents` / `codev.tower`
   stay byte-for-byte. The combined view gets its own mirrored entries, and a generated parity test
   fails if any source-view row entry lacks a combined-view counterpart. A1's wording no longer says
   clauses are widened. This keeps `contributes-tower.test.ts:47` and the "additions only" criterion
   true together.
2. **Freshness gap (must fix).** Accepted. Desired State now says the combined view (and the Work
   panel) count toward the existing periodic overview refresh gate. The "no new polling" criterion
   is reworded to "no *second* poll loop or SSE subscription; it takes part in the existing ones".
   A new criterion, a unit scenario (4) and a rendered scenario (18) check that the overview
   refreshes with the Codev container hidden and only the Cockpit visible. A new risk row covers
   it too.
3. **Provider instances vs row identity.** Accepted. The spec now commits to *own provider instances
   over shared caches*: rows are built by the same code (same labels, `contextValue`s and
   `command`s) but are distinct objects. Per-view state (accordion, group-parent map, expansion)
   therefore stays per view.
4. **`worktree-window-1809.test.ts` asserts on source text.** Accepted. It is named in Success
   Criteria (such tests may be updated to follow generalised wiring, with behaviour unchanged) and
   in Risks.
5. **Auto-arrange escape hatch.** Accepted. Added `codev.cockpit.autoArrange` (default on), covered
   by a criterion, unit scenario 6, the contributes test and a risk row.
6. **Footprint in every window.** Accepted. A *Footprint* bullet states the button appears in every
   window where the extension activates, and that today's Codev and Codev Tower containers already
   do.
7. **Restore path for the trigger.** Accepted. The trigger now runs the check when the view is
   created as well as on visibility change; unit scenario 6 tests it.
8. **`img-src` needs `blob:`.** Accepted. It is in Constraints: `blob:` for object URLs or `data:`
   if encoded, and no `connect-src` for Tower.

## Codex (COMMENT)

1. **"First show" across reload / restored panels.** Accepted. A window session is now defined as
   ending at reload; the next first show arranges again. Arranging is idempotent, so an intact
   restored layout changes nothing visible, and the architect terminal (not restored by VS Code) is
   reopened on the left.
2. **Connection, transport and disposal states.** Accepted. A *Connection and failure states*
   bullet covers them: loading before first data; last-known-good with a not-connected notice while
   Tower is unreachable; Decisions' existing error state and failed-submit behaviour; late
   responses dropped after panel close. There is a criterion and a rendered scenario, simulated in
   the isolated instance and never by stopping the owner's Tower.
3. **Canonical-path containment and http(s)-only external opens.** Accepted. This is in Constraints
   (symlink-resolved containment, not string prefix; `http:`/`https:` allowlist), the Work mapping
   table, a criterion, unit scenario 5 and a risk row.
4. **Arrange command invocable where the title action is hidden.** Accepted. *Arrange Cockpit*,
   *Open Work* and *Open Decisions* stay in the palette in builder-worktree and no-workspace
   windows. Invoking one there shows why it does nothing. Only the title-bar action is hidden.
