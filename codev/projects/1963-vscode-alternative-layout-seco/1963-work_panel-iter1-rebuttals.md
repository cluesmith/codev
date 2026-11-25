# Phase 8 (work_panel), iteration 1 — responses

Reviews: codex REQUEST_CHANGES, claude APPROVE. All changes are in `695870167`.

## Codex: empty sections under the notice before any overview — accepted, fixed

Codex is right. The host sends `{ data: null, error: 'Not connected to Tower.' }` while not
connected with nothing to keep. The shared `WorkView` rendered that as the notice over "No active
builders", "Nothing needs attention" and "No open issues", which claims the workspace is empty.
The spec says that before the first data arrives the panel shows a loading state.

- **Fix (shared view, `WorkView.tsx`).** When there is an error and no overview, Builders, Needs
  Attention and Backlog each say *Loading...* under the notice. The notice stays, because it says
  why.
- **Host contract (`workOverviewState`).** Unchanged. The table test's labels now say what the
  view shows: "the notice, nothing kept, while disconnected/reconnecting".
- **Dashboard.** It builds the same `{ data: null, error }` when its first overview read fails,
  and showed the same misleading empty sections there. This is a small adjacent bug, fixed in the
  same place and named in the PR. A first read still in flight (`{ data: null, error: null }`)
  keeps its empty sections exactly as before, and the Phase 6 test pinning that still passes.
  A dashboard rebuilt at `695870167` is compared against the pre-change snapshot (scenario 20).
- **Tests.**
  - `WorkView.test.tsx`: "shows each section loading under an error that came before any
    overview, never empty".
  - `WorkApp.test.tsx`: the same, through the VS Code webview's store.

## Claude (approved) — notes

1. **Unhandled rejection at the dispatch site — taken.** `PanelSession` now catches a rejected
   `onMessage` and logs it as `<Panel> panel: a message from its webview failed: <reason>`.
   This covers both panels. Test: an `openFile` that rejects is logged.
2. **Refusal toast after the panel closed — taken.** `openArtifact` checks the session's new
   `closed` getter after its async `realpath`s, and logs but does not toast. Test: dispose the
   panel while the resolve is in flight; no warning. An artifact that resolves after close still
   opens. The user asked for it, and opening an editor does not re-create the panel.
3. **"Failed to load overview: Not connected to Tower." wording — left as is.** It is the
   dashboard's template, and the spec asks for dashboard parity in the shared view. Rewording it
   is the owner's call. If they want it, a host-supplied notice would do it without changing the
   dashboard.
4. **Two Light Modern texts at 4.3:1 — noted, not changed.** `.recently-closed-check` and
   `.attention-row-age` sit above the harness's 3:1 floor and below 4.5:1.
   - The age is `--codev-wv-fg-muted`, which VS Code maps to its own readable muted grey,
     `input-placeholderForeground`.
   - The check is a ✓ glyph in `--codev-wv-status-active`, VS Code's chart green. Its meaning
     is carried by the "Recently Closed" heading.

   The PR body names them.

## Also in this round (architect, after viewing the increment-2 shots)

At about 470 px, keeping State on one line had cut titles to four characters, and half width is
Work's width in the Phase 9 split. Under 600 px a builder row is now two lines: issue, title and
*Open* on the first, the state under the title. This is VS Code-only CSS grid, so the dashboard is
unchanged. The half-width check fails unless at least 20 characters of a typical 44-character
title show, with each state on one line.
