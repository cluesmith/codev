# PIR #909 — area/* labels as first-class organizing concept

## 2026-05-28 — plan phase

Drafted `codev/plans/909-architect-treat-area-labels-as.md`. Key design calls made (these are the items the plan-approval gate is for):

- **Placement**: subsection under `## Quick Start`, directly after `### Project Tracking`. Topical adjacency > another top-level heading.
- **Vocabulary rendering**: mini-table (label / one-line scope), 10 rows. Bulleted list and paragraph-per-area rejected.
- **Codev / skeleton split**: codev file has the concrete 10-label table inline; skeleton files contain zero codev area names (framework-neutral discipline). Skeleton teaches the pattern via `<prefix>/<value>` placeholders.
- **Live list inline + pointer**: codev file has both (inline table for zero-memory ops, `gh label list --search area/` as the source of truth). Skeleton has only the pointer.
- **gh recipes**: group / edit / audit / bulk-move, one-liner each, ~10 lines total. Same shape in codev and skeleton, different vocabulary level.
- **`codev-skeleton/roles/architect.md`**: new `## Working with project labels` section after `## Project Tracking`.

Live label inventory captured from `gh label list --search area/` (10 labels). No mention of `area/agent-farm` — `area/tower` covers afx/agent-farm work (confirmed already in personal memory and consistent with the issue body).

Awaiting `plan-approval`.

## 2026-05-28 — plan revision after reviewer feedback

User raised two questions worth recording the answers to:

**Q1: What exactly propagates to other repos at install/update time?**
Verified at `packages/codev/src/lib/scaffold.ts:159-194` and `commands/{init,adopt,update}.ts`:
- Path 1 (copied to disk): `codev-skeleton/templates/{CLAUDE,AGENTS}.md`, `codev-skeleton/skills/*`
- Path 2 (runtime resolution via tier-4): everything else under `codev-skeleton/` — `roles/`, `protocols/`, etc.
- Path 3 (never leaves this repo): `CLAUDE.md` / `AGENTS.md` at the codev repo root, `codev/roles/architect.md` (tier-2 override for codev's own sessions)

Plan revision:
- Added `codev/roles/architect.md` to the codev-specific file set (belt-and-suspenders — architect knows the policy via either CLAUDE.md auto-load OR role-file load).
- Extended the vocabulary-leak grep to `grep -rE … codev-skeleton/` (catches any leak anywhere in the skeleton tree).

**Q2: Is the 10-area list comprehensive? What about web / dashboard / mobile?**
Hard data from `gh label list` and `gh issue list --state all`:
- 10 areas, all currently active.
- "dashboard" = `area/panel` (naming gap; user-facing synonym, label-internal name).
- "web", "mobile" — no such code exists in the repo, nothing to label.
- Real undocumented gaps: release tooling, scaffold/install (both currently catch-all under `area/core`). Issue explicitly puts new-label decisions out of scope — flagged in the plan as follow-up candidates.

Plan revision:
- Added "Synonym alert" line + bolded "dashboard" in the `area/panel` scope hint.
- Added `area/tower` "no separate area/agent-farm" callout to the table.
- Added "Areas Not Currently Labeled" section listing release / scaffold as follow-up candidates, plus a "what's not missing" subsection for the user's specific terms.

## 2026-05-28 — implement phase

Plan approved (`plan-approval` gate). Applied the 6 edits per plan:

- `CLAUDE.md` + `AGENTS.md` (root) — codev-specific `### Area Labels` subsection after `### Project Tracking`.
- `codev/roles/architect.md` — codev-specific `## Working with Area Labels` after `## Project Tracking`.
- `codev-skeleton/templates/CLAUDE.md` + `AGENTS.md` — framework-neutral `## Working with Project Labels` between `## Key Locations` and `## Quick Start`.
- `codev-skeleton/roles/architect.md` — framework-neutral `## Working with Project Labels` after `## Project Tracking`.

Mid-implementation tweak: discovered `gh issue list` defaults to 30 results, which silently truncated the group recipe (showed only 5 of 9 areas with open issues). Added `--limit 500` to all list-based recipes (group, audit, bulk-move) across all 6 files. Not in the original plan but a usability defect worth fixing before code lands. Documented here so the dev-approval reviewer knows why the recipes have `--limit 500`.

All 4 verification checks pass:
- `diff CLAUDE.md AGENTS.md` → empty (byte-identical)
- `diff codev-skeleton/templates/{CLAUDE,AGENTS}.md` → only the 4-line preamble differs (intentional)
- `grep -rE "area/(docs|vscode|panel|consult|tower|cross-cutting|porch|config|terminal|core)" codev-skeleton/` → no output (no vocab leak)
- `npm run build` → green (✓ built in 1.43s)
- Group/audit recipes smoke-tested against the live repo — produce sensible output
- `npm test` running in background; will report on completion

Worktree had no `node_modules` (no postSpawn hook configured), so I ran `pnpm install` once before the build/test cycle. Recorded so a future spawn doesn't repeat the dead-end.

## 2026-05-28 — forge-direct vs forge-abstract design call (at dev-approval)

User flagged: "instructions shouldn't mention GitHub directly, isn't there a forge or git abstraction?"

Investigated and confirmed the existing pattern:
- **Internal automation layer**: forge concept commands at `packages/codev/scripts/forge/<provider>/`, dispatched via `packages/codev/src/lib/forge.ts`. Routes through `gh`/`glab`/`tea` per `.codev/config.json`'s `forge.provider`. Used by porch, doctor, project-summary, etc.
- **User-facing layer** (skeleton docs + AI prompts): hardcodes `gh` everywhere. `codev-skeleton/roles/architect.md` already has `gh pr diff`, `gh pr view`, `gh pr comment`, `gh issue close`, `gh issue list`, `gh issue view`. Every protocol prompt (`codev-skeleton/protocols/*/prompts/*.md`, `*/builder-prompt.md`) uses `gh pr create`, `gh pr merge`, `gh pr view`, etc.

Why two layers: the forge concept set is read-mostly (`issue-view`, `issue-list`, `pr-list`, `pr-merge`, ...) — no concepts for label management, issue editing, jq-piping. Architect interactive ops need flag shapes the abstraction doesn't expose. And there's no user-facing `codev forge <concept>` CLI.

User confirmed: keep new section consistent with existing `gh` pattern. Localized forge-CLI awareness in one section would create inconsistency vs. neighboring sections (and the rest of the skeleton). Wholesale forge-agnostic skeleton refactor is a separate, much larger concern — file as a follow-up if/when wanted.

No edits to the codebase. Recorded the pattern as memory ([feedback-skeleton-gh-direct]) so future sessions don't re-litigate.

## 2026-05-28 — scope expansion: area-label restructure at dev-approval

Reviewer audit during the dev-approval gate surfaced gaps the original plan missed. After discussion, scope expanded beyond what #909's "out of scope" section listed.

**Label restructure (executed via gh CLI):**
- Created: area/dashboard, area/web, area/release, area/scaffold, area/protocols
- Relabeled 4 panel-tab issues (#812, #813, #814, #815) from area/panel → area/vscode (they're VSCode work, all titled "vscode: migrate ...")
- Deleted: area/panel

**Critical correction caught mid-flight:**
`area/panel` does NOT cover the React dashboard package. The dashboard package (`packages/dashboard/`, `@cluesmith/codev-dashboard`) is served by Tower over HTTP and opened in a browser via "Open Tower dashboard in browser". `area/panel` covered VSCode bottom-panel-area UI work (issues #812-815). I had conflated the two earlier; user clarification + grep over `tower-routes.ts:1406` ("Serve React dashboard static files directly") disambiguated. The reviewer was about to authorize a rename that would've tagged VSCode UX issues with a dashboard-package label.

**Doc edits:**
- Updated 14-row area table in CLAUDE.md/AGENTS.md/codev/roles/architect.md
- Removed `--assignee @me` policy line (user correction: "reporting an issue doesn't mean the user wants it to be assigned to him")
- Removed synonym-alert paragraph and inline synonym alerts
- Removed Kubernetes/Terraform parenthetical
- Updated plan file with "Scope Expansion" section documenting the post-plan-approval changes
- Memory file `feedback_assign_issues_to_user.md` updated to scope the self-assign rule to actual user-take-on intent
- Memory file `reference_area_labels.md` updated to reflect the new 14-label set

**Final label set (14):**
docs, vscode, dashboard, consult, tower, cross-cutting, porch, protocols, config, terminal, scaffold, release, web, core.

All verification checks still green:
- diff CLAUDE.md AGENTS.md → empty
- diff skeleton CLAUDE.md AGENTS.md → only the 4-line preamble
- grep -rE "area/(...)" codev-skeleton/ → no leaks
- grep "--assignee @me" across all 6 doc files → no hits
- npm run build → ✓ (in progress: tests)
