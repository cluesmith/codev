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
1. Checks for `codev/specs/315-*.md` on disk
2. Fetches GitHub issue #315 for context (title, body, comments)
3. Uses the explicitly specified protocol

Keep `-p` and `--issue` as hidden aliases for backwards compatibility.

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

Builder data: Tower state + `status.yaml`. PR data: cached `gh pr list`. Backlog: cached `gh issue list` (open issues — both features and bugs) cross-referenced with `codev/specs/` glob and `.builders/` to determine what's conceived, ready, or unfixed.

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

## Resolved Questions

- **Labels**: Create on first use — no setup step needed
- **Issue closure**: Merging the PR closes the linked issue automatically
- **Backlog filtering**: Show all open issues (features + bugs)
