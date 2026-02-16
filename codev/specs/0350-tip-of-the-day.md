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
   - `af` CLI shortcuts (`af spawn --task`, `af status`, `af send`)
   - `porch` commands (`porch pending`, `porch status`)
   - `consult` usage (3-way reviews, `--type integration-review`)
   - Workflow best practices (commit before spawn, `--resume` for existing worktrees)
   - Dashboard features (file panel, refresh, opening builders)
4. Tips rotate daily — selection is deterministic based on the date (not random), so all users see the same tip on the same day

### UI

5. The tip appears as a subtle, single-line banner below the Work header and above the Builders section
6. Styled as a muted/secondary element — not attention-grabbing, just passively helpful
7. Prefixed with "Tip:" or a similar short label
8. Left/right arrow buttons to navigate to previous/next tip
9. A dismiss button (X) that hides the banner until the next day. Dismissed state is stored in `localStorage` keyed by date — on a new day, the banner reappears automatically
10. Inline `code` spans should be styled with the existing code/monospace styling

### Architecture

10. Frontend-only change — no new API endpoints, no backend changes
11. A single new component (`TipBanner.tsx`) containing the tip array and rotation logic
12. Rotation logic: `tips[dayOfYear % tips.length]` — deterministic, cycles through all tips
13. Rendered in `WorkView.tsx` between the header div and the first section

## Acceptance Criteria

- [ ] Tip banner appears in the Work view below the header
- [ ] Tip changes daily (based on day-of-year modulo)
- [ ] At least 48 tips ship with the initial implementation
- [ ] Tips include inline code formatting that renders correctly
- [ ] Left/right arrows navigate between tips
- [ ] Dismiss button hides banner until the next day
- [ ] Visually subtle — doesn't compete with builders/PRs/backlog for attention
- [ ] No backend changes required

## Out of Scope

- User-customizable tips
- Backend-served tips or tip analytics
- Tip categories or filtering
