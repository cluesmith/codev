# PIR Review: Move Pull Requests below Backlog in the VSCode sidebar default order

## Summary

Issue #932 asked to swap the default order of the **Pull Requests** and **Backlog** sections in the Codev VSCode sidebar. The new default order is Workspace → Builders → **Backlog** → **Pull Requests** → Recently Closed → Team → Status, which pairs the two surfaces checked together during active triage (Builders = in-flight, Backlog = next-to-start) and groups Pull Requests with Recently Closed as the completion-side surfaces. The change is a two-element reorder of the `contributes.views.codev` array in `packages/vscode/package.json` — no view definitions, `when` clauses, menus, or providers were touched.

## Files Changed

- `packages/vscode/package.json` — swapped the `codev.pullRequests` and `codev.backlog` entries within the `contributes.views.codev` array so `codev.backlog` now precedes `codev.pullRequests`. Net diff: +1/-1.
- `codev/plans/932-vscode-move-pull-requests-sect.md` — plan artifact (plan phase).
- `codev/state/pir-932_thread.md` — builder narrative thread.

## Architecture Updates

No architectural changes. VSCode tree views are contributed declaratively; their default display order is the array order in `contributes.views.<container>`. Reordering the declaration changes only the default order, which VSCode overrides per-workspace the moment a user manually drags a view. No new patterns, contracts, or modules were introduced, so `codev/resources/arch.md` needs no update.

## Lessons Learned Updates

No lessons learned updates needed for the change itself — it's a well-trodden VSCode manifest edit. One operational note worth recording for future builders working in fresh worktrees (not a codebase lesson, captured in the thread): porch's `implement`-phase `build` check runs the full workspace build (`tsc` via `npm run build`), which fails with `sh: tsc: command not found` if the worktree's `node_modules` was never installed. The committed `pnpm-lock.yaml` is identical to `main`, so this is a worktree-provisioning gap, not branch drift — resolved by `pnpm install` (then restoring the lockfile to keep the PR scoped). This is environmental, not a reusable code lesson, so `codev/resources/lessons-learned.md` is not updated.

## Test Results

- Build: ✓ porch `build` check passed (`npm run build` → full workspace `tsc` build, ~47s) after installing worktree deps.
- Tests: ✓ porch `tests` check passed (`npm test`, ~28s).
- JSON validity: ✓ `package.json` parses (`JSON.parse` guard).
- Manual verification: confirmed at the `dev-approval` gate — the contributed default order now lists Backlog above Pull Requests.

## Things to Look At

- **Scope of effect**: the new order only applies to fresh installs / users who have not manually reordered the sidebar. VSCode persists user-customized view order per-workspace, so existing customized users keep their order. This is intended and matches the issue's acceptance criteria.
- **No cross-surface obligation**: the Tower web dashboard (`packages/dashboard/src/components/WorkView.tsx`) does not mirror this section model — it has no standalone "Pull Requests" section (PRs are folded into an "Needs Attention" attention-aggregation that sits above Backlog). The two surfaces answer different questions, so the orderings can diverge without being inconsistent. No dashboard change is in scope for #932.

## How to Test Locally

1. Check out this branch (`builder/pir-932`) or run the worktree dev server (`afx dev pir-932`).
2. Load the extension in an Extension Development Host using a **fresh profile** (no prior sidebar customization), or install the packaged `.vsix` in a clean profile.
3. Open the Codev sidebar and confirm the section order top-to-bottom is: Workspace, Builders, **Backlog**, **Pull Requests**, Recently Closed, Team (if `codev.teamEnabled`), Status.
4. (Regression) In a profile where views were previously dragged into a custom order, confirm the custom order is preserved.

Fixes #932
