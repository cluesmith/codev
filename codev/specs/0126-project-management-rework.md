# Specification: Project Management Rework

## Metadata
- **ID**: 0126
- **Status**: draft
- **Created**: 2026-02-16
- **Supersedes**: 0119 (abandoned)

## Problem Statement

`projectlist.md` is the canonical project tracking file and it has been a persistent source of bugs and friction:

1. **Constant drift** — builders don't update it, architect forgets, status gets stale within hours
2. **Merge conflicts** — every builder that reserves a number or updates status conflicts with every other
3. **Manual numbering** — humans must find and reserve the "next available number" before creating specs
4. **Redundant with GitHub** — bugs are already GitHub Issues, but projects aren't. Two systems track overlapping work.
5. **Display is noise** — a 1100+ line YAML file is impossible to scan. No filtering, no sorting, no search.
6. **Programmatic readers are fragile** — `getProjectSummary()` in porch parses YAML that's hand-edited and frequently malformed
7. **Lifecycle tracking is manual** — status transitions (conceived → specified → committed → integrated) require hand-editing

## Current State

### What reads projectlist.md

| Component | What it reads | Hard dependency? |
|-----------|--------------|-----------------|
| `porch/prompts.ts` → `getProjectSummary()` | `summary` field | Yes (strict mode only) |
| Dashboard `StatusPanel.tsx` | Entire file (polling) | Yes |
| `codev init/adopt` → `scaffold.ts` | Template creation | No (writes, doesn't read) |
| Architect (human) | Visual scanning | No (just convention) |

### What does NOT read projectlist.md

- `af spawn` — filesystem glob on `codev/specs/`
- Porch state — `codev/projects/<id>/status.yaml`
- Spec/plan/review discovery — filename-based
- `af cleanup` — doesn't touch it
- `af status` — reads Tower state, not projectlist
- **Soft mode builders** — no porch, no status tracking at all

The actual hard dependencies are surprisingly small: one function in porch (strict mode only) and one dashboard panel.

## Desired State

### Issue-first workflow

The GitHub Issue is created **before** the spec. The issue number becomes the universal identifier for everything — spec file, plan file, review file, branch, worktree.

**New workflow:**
1. `gh issue create --title "Feature name"` → Issue #315 auto-assigned
2. Write spec: `codev/specs/315-feature-name.md`
3. `af spawn 315` → finds spec on disk + fetches issue context from GitHub
4. Builder works, creates PR referencing #315
5. PR merged → issue closed

**Old workflow (eliminated):**
1. ~~Edit projectlist.md, reserve next number~~
2. ~~Create spec file with that number~~
3. ~~Commit both files~~
4. ~~Manually update projectlist.md status throughout lifecycle~~

### Derived status — no tracking needed

Status is **derived from what exists**, not manually tracked:

| Status | How to determine |
|--------|-----------------|
| Conceived | Open issue, no spec file on disk |
| Specified | Open issue, `codev/specs/<N>-*.md` exists |
| Planned | Open issue, `codev/plans/<N>-*.md` exists |
| Implementing | Active builder worktree in `.builders/` |
| Committed | Open PR referencing the issue |
| Integrated | Issue closed |

No labels needed for status. No manual updates. No drift.

### GitHub Issues as project registry

GitHub Issues is the **registry** (what exists, what's done) — not a status tracker.

| Current (projectlist.md) | New (GitHub Issues) |
|--------------------------|---------------------|
| `id: "0116"` | Issue #116 (auto-assigned) |
| `title` | Issue title |
| `summary` | Issue body |
| `status` | Derived (see table above) |
| `priority: high` | Label: `priority:high` (set once at creation) |
| `release: v2.0` | Milestone: `v2.0` |
| `notes` | Issue comments |
| `files.spec` | Convention: `codev/specs/<issue#>-<slug>.md` |

### No label churn

Labels are set at issue creation and rarely changed:

- `type:feature` / `type:bug` — set once at creation
- `priority:high` / `priority:medium` / `priority:low` — set once, maybe updated occasionally
- Open/Closed — the only state transition GitHub needs to know about

**Label defaults**: If no `type:*` label → treated as `feature`. If no `priority:*` label → treated as `medium`. Multiple labels of the same kind → first one wins (alphabetical).

Detailed phase tracking (specify → plan → implement → review) stays in porch's `status.yaml` for strict mode. Soft mode has no tracking. Dashboard derives status from filesystem + Tower state.

### Simplified spawn CLI

```bash
af spawn 315 --protocol spir           # Feature: SPIR protocol
af spawn 315 --protocol bugfix         # Bug: BUGFIX protocol
af spawn 320 --protocol tick --amends 315  # Amendment: TICK on spec 315, tracked as issue 320
af spawn 315 --soft                    # Soft mode (no porch)
af spawn 315 --resume                  # Resume existing worktree
af spawn --task "fix the bug"          # Ad-hoc (no issue)
af spawn --protocol maintain           # Protocol-only run
af spawn --shell                       # Bare session
```

The number is a positional argument, not a flag. `af spawn 315` replaces both `af spawn -p 315` and `af spawn --issue 315`. Protocol must be specified explicitly via `--protocol` — no magic auto-detection. The architect AI should recommend protocols based on convention (SPIR for features, BUGFIX for bugs, TICK for amendments) but the human always chooses.

**TICK amendments**: Create a new issue for the amendment work, then spawn with `--amends <original>`. The new issue tracks the work, the original spec is modified in-place, and the review file uses the new issue number.

The spawn flow:
1. Validate: `--protocol` is required (fail if missing)
2. Resolve spec: glob `codev/specs/<N>-*.md` (strips leading zeros for legacy specs, e.g., `af spawn 76` matches `0076-*.md`)
3. Fetch context: `gh issue view <N> --json title,body,comments` (non-fatal if issue doesn't exist — spec-only mode)
4. Dispatch: use the explicitly specified `--protocol` to choose the code path (SPIR, BUGFIX, TICK, etc.)

The `--protocol` flag replaces the old implicit detection. There is no ambiguity about which code path runs — the human chooses explicitly.

`-p` and `--issue` are removed entirely — no backward compat aliases. Old commands get a clear error message pointing to the new syntax.

### Dashboard layout changes

> **Visual mockup**: See `codev/spikes/work-view/mockup.html` for the interactive spike.

The top navigation tabs remain. The **Projects** and **Terminals** tabs are removed and replaced by a new **Work** tab. The **Files** tab moves from a top-level tab to a collapsible panel within the Work tab.

**Layout (2/3 – 1/3 vertical split):**

- **Top 2/3: Work view** — everything the architect needs on one screen
- **Bottom 1/3: File panel** — annotated file viewer (`af open`), collapsible to just the file search bar. When collapsed, the Work view expands to fill the full height.

**Work view sections (top to bottom):**

1. **Active builders** — what's running, what phase, with terminal links
   - Source: Tower workspace state + porch `status.yaml` from active worktrees
   - "Open" button opens the builder's Claude session as a new tab at the top (replaces the old Terminals tab)
   - Soft mode builders shown as "running" (no phase detail)
   - Blocked gates shown inline on the builder card

2. **Pending PRs** — what's ready for review/merge
   - Source: `gh pr list` (cached in Tower, 60s TTL)
   - Shows: PR title, review status, linked issue

3. **Backlog & Open Bugs** — what's in the pipeline but not actively being built
   - Source: open GitHub issues cross-referenced against `codev/specs/` on disk and `.builders/`
   - Features with no spec file = conceived (backlog)
   - Features with spec but no builder = ready to start
   - Open bugs with no active builder = unfixed
   - Shows: issue title, type (feature/bug), priority label, age

**Header actions:**
- `+ Shell` button in the Work view header — opens a new shell tab at the top (same as existing `+ Shell` button in the Tabs section)

**What changes:**
- Projects tab → removed (replaced by backlog/bugs section in Work view)
- Terminals tab → removed (builder cards with "Open" button replace it)
- Files tab → moved from top-level tab to collapsible panel within Work tab
- Info header → removed (the explanatory text and doc links at the top of the dashboard)
- Gate indicators → inline on builder cards

**What does NOT change:**
- Top navigation tabs (still present, Work replaces Projects/Terminals/Files)
- `af open` functionality (opens file in a new tab at the top, just repositioned within Work tab)

**What the Work view does NOT show:**
- Completed/integrated work (closed issues — use `gh issue list --state closed`)
- Full project history (use `git log`)

### Tower endpoint design

```
GET /api/overview
```

```json
{
  "builders": [
    {
      "id": "builder-315",
      "issueNumber": 315,
      "issueTitle": "Stale gate indicators",
      "phase": "pr",
      "mode": "strict",
      "gates": { "merge-approval": "pending" },
      "terminal": { "id": "abc-123", "active": true }
    }
  ],
  "pendingPRs": [
    {
      "number": 317,
      "title": "[Bugfix #315] Remove stale gate indicators",
      "reviewStatus": "approved",
      "linkedIssue": 315
    }
  ],
  "backlog": [
    {
      "number": 320,
      "title": "Rework consult CLI",
      "type": "feature",
      "priority": "medium",
      "hasSpec": false,
      "hasBuilder": false,
      "createdAt": "2026-02-16T..."
    },
    {
      "number": 321,
      "title": "Terminal flickers on resize",
      "type": "bug",
      "priority": "high",
      "hasSpec": false,
      "hasBuilder": false,
      "createdAt": "2026-02-16T..."
    }
  ]
}
```

Builder data: Tower state + `status.yaml`. PR data: cached `gh pr list --json number,title,reviewDecision,body`. Backlog: cached `gh issue list --json number,title,labels,createdAt` (open issues — both features and bugs) cross-referenced with `codev/specs/` glob and `.builders/` to determine what's conceived, ready, or unfixed.

**PR-to-issue linkage**: Parse the PR body for GitHub's closing keywords (`Fixes #N`, `Closes #N`, `Resolves #N`). Also check the PR title for `[Spec N]` or `[Bugfix #N]` patterns (existing commit message convention). If no linkage found, `linkedIssue` is `null`.

**Cache behavior**: Both PR and issue data use the same 60s TTL. Tower stores the cache in memory (not on disk). Manual refresh: the dashboard sends a `POST /api/overview/refresh` to invalidate the cache and re-fetch.

**Degraded mode**: If `gh` CLI fails (not authenticated, network down, rate limited), the `/api/overview` endpoint still returns `builders` (from Tower state) but `pendingPRs` and `backlog` are empty arrays with an `"error"` field explaining why. The dashboard shows "GitHub unavailable" inline where PR/backlog sections would be.

### `getProjectSummary()` replacement

The current `getProjectSummary()` in `porch/prompts.ts` extracts a `summary` field from projectlist.md YAML. It is replaced with a two-step lookup:

1. **GitHub issue** (primary): `gh issue view <N> --json title,body` → use `title` as the summary. The full `body` is available for the builder prompt but the summary is just the title.
2. **Spec file** (fallback): If the GitHub issue doesn't exist (e.g., legacy specs), read the first heading and first paragraph from `codev/specs/<N>-*.md` as the summary.
3. **Neither**: If neither exists, use the project title from `status.yaml` as a minimal summary.

This function is only called in strict mode (porch). Soft mode never calls it.

### Migration

There is no migration step. `projectlist.md` becomes a dead file:

- **Existing repos**: `projectlist.md` stays on disk as historical reference. No code reads it. No command deletes it. Over time, users can archive or delete it manually.
- **`projectlist-archive.md`**: Same treatment — dead file, no longer created or read.
- **`codev init`**: No longer creates `projectlist.md` or `projectlist-archive.md`.
- **`codev adopt`**: No longer creates these files. Does not delete existing ones.
- **`codev doctor`**: Does NOT warn about `projectlist.md` existing — it's harmless. Does check that `gh` CLI is authenticated (new check).

### Legacy spec compatibility

Existing specs use zero-padded 4-digit IDs (e.g., `0076`). GitHub issues use plain integers (e.g., `76`). The spec file lookup strips leading zeros before globbing: `af spawn 76` matches `codev/specs/0076-*.md`. The `stripLeadingZeros()` function already exists in the codebase.

For legacy specs with no corresponding GitHub issue, spawn works in spec-only mode — the spec file provides all context, and the `gh issue view` step is non-fatal.

## Success Criteria

- [ ] No code reads projectlist.md
- [ ] `af spawn <N>` works as positional arg for both features and bugs
- [ ] Porch reads project summary from GitHub Issues (with spec-file fallback)
- [ ] Dashboard shows: active builders, blocked gates, pending PRs, backlog
- [ ] Backlog + open bugs derived from open issues — no manual tracking
- [ ] Status derived from filesystem + Tower state — no labels needed
- [ ] `codev init` no longer creates projectlist.md
- [ ] Existing numbered specs (0001-0124) still work
- [ ] Soft mode works with zero tracking infrastructure

## Constraints

- GitHub is required — `gh` CLI must be installed and authenticated
- GitHub API rate limits: 5000/hr authenticated — sufficient for cached queries
- Must not break existing `af spawn -p` for numbered specs already on disk
- Soft mode builders need zero tracking infrastructure
- Work view must be responsive / usable on mobile (check builder status, approve gates, see PRs on the go)

## Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| `gh` CLI not authenticated | Medium | Medium | `codev doctor` checks, clear error messages |
| Soft builders have no phase info | Expected | None | Show as "running" without phase detail |
| PR/issue cache staleness | Low | Low | 60s TTL + refresh on demand |
| Network down / offline | Low | Medium | Degraded mode: builders still shown, PRs/backlog empty with error message |
| Rate limiting mid-session | Very Low | Low | Cached data served until TTL, error on next refresh |

## Testing Expectations

- **Playwright**: Work view layout, builder cards, PR list, backlog rendering, collapsible file panel, responsive layout
- **Unit tests**: `getProjectSummary()` replacement (GitHub fetch, spec-file fallback, neither), PR-to-issue linkage parsing, label defaults, `stripLeadingZeros()` matching
- **Integration tests**: `af spawn` positional arg with `--protocol`, legacy `-p` alias, `/api/overview` endpoint with mocked `gh` output, degraded mode (gh failure)
- **E2E**: Full spawn → build → PR flow using issue numbers

## Resolved Questions

- **Labels**: Create on first use — no setup step needed
- **Issue closure**: Merging the PR closes the linked issue automatically
- **Backlog filtering**: Show all open issues (features + bugs)
- **Supersedes 0119**: No work from 0119 was started (it was abandoned before implementation). Nothing to discard or roll in.
- **Issue number vs legacy ID collision**: Issue #76 and spec `0076-feature.md` are expected to refer to the same thing. If they're unrelated, the spec file takes precedence (it's the implementation artifact).
- **"Open" button**: Opens the builder's Claude session as a new tab in the dashboard's tab bar (not a browser tab).
- **File panel search bar**: Reuses the existing `af open` search functionality, just repositioned into the collapsible panel.

## Consultation Log

### Iteration 1 — 3-way spec review (Gemini, Codex, Claude)

**Gemini** (APPROVE): No issues. Called the spec comprehensive and feasible.

**Codex** (REQUEST_CHANGES): Identified four gaps:
1. PR-to-issue linkage rules undefined
2. No behavior for missing/ambiguous labels
3. No testing strategy section
4. Insufficient error handling spec for `gh` failures and caching

**Claude** (COMMENT): Identified three medium-severity gaps:
1. Migration path for existing repos unspecified
2. Unified positional arg collapses spec vs. issue-only code paths — resolution logic unclear
3. `getProjectSummary()` replacement lacks detail (what from issue body? what does fallback mean?)

Also flagged lower-severity items: `projectlist-archive.md` fate, offline behavior, cache TTL for backlog, legacy spec matching semantics, "Open" button ambiguity.

**Changes made in response:**

| Feedback | Change |
|----------|--------|
| PR-to-issue linkage (Codex) | Added linkage rules: parse `Fixes #N`/`Closes #N` from PR body + `[Spec N]`/`[Bugfix #N]` from PR title |
| Label defaults (Codex) | Added: no `type:*` → feature, no `priority:*` → medium, multiple → first alphabetical |
| Testing strategy (Codex) | Added "Testing Expectations" section with Playwright, unit, integration, and E2E categories |
| `gh` failure handling (Codex) | Added "Degraded mode" paragraph: endpoint returns builders but empty PR/backlog with error field |
| Migration path (Claude) | Added "Migration" section: `projectlist.md` becomes dead file, no migration step, no deletion |
| Spawn resolution (Claude) | Rewrote spawn flow as numbered steps: `--protocol` is required, drives code path, no ambiguity |
| `getProjectSummary()` (Claude) | Added replacement section: GitHub issue title (primary) → spec file heading (fallback) → status.yaml title (last resort) |
| `projectlist-archive.md` (Claude) | Addressed in Migration section: same treatment as `projectlist.md` |
| Offline/degraded (Claude) | Covered by degraded mode addition |
| Cache TTL (Claude) | Added: both PR and issue use same 60s TTL, in-memory, manual refresh via `POST /api/overview/refresh` |
| Legacy spec matching (Claude) | Added "Legacy spec compatibility" section: `stripLeadingZeros()` matching, spec-only mode when no issue exists |
| "Open" button ambiguity (Claude) | Added to Resolved Questions: opens in dashboard tab bar, not browser tab |
| File panel search bar (Claude) | Added to Resolved Questions: reuses existing `af open` search |
