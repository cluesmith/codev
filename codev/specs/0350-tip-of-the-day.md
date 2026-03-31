# Spec 0350: Tip of the Day

## Problem

New codev users don't discover useful features, shortcuts, and best practices organically. There's no in-context learning mechanism — users only find capabilities by reading docs or asking.

## Solution

Display a rotating "Tip of the Day" banner in the dashboard Work view, positioned between the header and the first section. Tips surface codev features, CLI shortcuts, and workflow best practices directly where users are working.

## Requirements

### Tip Content

1. Tips are stored as a static array in the dashboard source code (no backend changes needed)
2. Each tip is a short string (one sentence, max ~120 chars) with inline code formatting
3. Ship with at least 48 tips covering:
   - `afx` CLI shortcuts (`afx spawn --task`, `afx status`, `afx send`)
   - `porch` commands (`porch pending`, `porch status`)
   - `consult` usage (3-way reviews, `--type integration-review`)
   - Workflow best practices (commit before spawn, `--resume` for existing worktrees)
   - Dashboard features (file panel, refresh, opening builders)
4. Tips rotate daily — selection is deterministic based on the date in local time (not random), so all users see the same tip on the same day
5. Tips use backtick-delimited code spans (e.g., `` Use `afx status` to check builders ``) which the component parses and renders as `<code>` elements

### UI

6. The tip appears as a subtle, single-line banner below the Work header and above the Builders section (below any error messages if present)
7. Styled as a muted/secondary element — not attention-grabbing, just passively helpful
8. Prefixed with "Tip:" or a similar short label
9. Left/right arrow buttons to navigate to previous/next tip. Navigation is ephemeral (resets to the daily tip on page reload) and wraps around at both ends
10. A dismiss button (X) that hides the banner until the next day. Dismissed state is stored in `localStorage` with key `tip-dismissed-YYYY-MM-DD` — on a new day, the banner reappears automatically. Dismissal applies to the entire banner regardless of which tip is currently displayed
11. Inline `code` spans should be styled with the existing code/monospace styling
12. On narrow viewports, the tip text may wrap to a second line — this is acceptable

### Architecture

13. Frontend-only change — no new API endpoints, no backend changes
14. A single new component (`TipBanner.tsx`) with a separate `tips.ts` data file for the tip array
15. Rotation logic: `tips[dayOfYear % tips.length]` using local time — deterministic, cycles through all tips
16. Rendered in `WorkView.tsx` between the header div and the first section

## Acceptance Criteria

- [ ] Tip banner appears in the Work view below the header
- [ ] Tip changes daily (based on day-of-year modulo, local time)
- [ ] At least 48 tips ship with the initial implementation
- [ ] Tips include inline code formatting (backtick-delimited) that renders correctly
- [ ] Left/right arrows navigate between tips with wraparound
- [ ] Dismiss button hides banner until the next day (localStorage keyed by date)
- [ ] Visually subtle — doesn't compete with builders/PRs/backlog for attention
- [ ] No backend changes required
- [ ] Unit tests cover rotation logic, navigation, dismiss behavior, and code span rendering

## Out of Scope

- User-customizable tips
- Backend-served tips or tip analytics
- Tip categories or filtering
- Accessibility beyond basic semantic HTML (ARIA enhancements can follow in a future iteration)
