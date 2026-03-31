---
approved: 2026-02-15
validated: [architect]
---

# Specification: Replace projectlist.md with GitHub Issues

## Metadata
- **ID**: 0119
- **Status**: approved
- **Created**: 2026-02-15

## Problem Statement

Project tracking lives in `projectlist.md`, a manually-maintained YAML file. This creates friction:

1. **Manual numbering** — humans must reserve the "Next Available Number" before creating specs
2. **Manual status tracking** — lifecycle transitions (conceived → specified → integrated) are hand-edited
3. **Merge conflicts** — every builder that touches projectlist.md conflicts with every other
4. **Duplication** — bugs are already GitHub Issues, but projects aren't. Two systems to track work.
5. **No notifications** — GitHub Issues have watchers, assignments, comments. projectlist.md is a static file.
6. **File bloat** — 1183 lines and growing, needs manual archiving

GitHub Issues already handles all of this natively: auto-incrementing IDs, labels, milestones, assignees, state transitions, comments, and a UI.

## Current State

### What projectlist.md contains

```yaml
- id: "116"
  title: "Shellper Resource Leakage Prevention"
  summary: "Periodic runtime cleanup..."
  status: committed          # lifecycle stage
  priority: high
  release: null
  files:
    spec: codev/specs/0116-shellper-resource-leakage.md
    plan: codev/plans/0116-shellper-resource-leakage.md
    review: codev/reviews/0116-shellper-resource-leakage.md
  dependencies: []
  tags: [shellper, reliability]
  timestamps:
    conceived_at: "2026-02-15"
  notes: "..."
```

### What reads projectlist.md programmatically

| Component | What it reads | Can migrate? |
|-----------|--------------|--------------|
| `porch/prompts.ts` → `getProjectSummary()` | `summary` field | Yes — read from issue title/body |
| Dashboard `StatusPanel.tsx` | Entire file (polling) | Yes — query GitHub API or `gh` CLI |
| `codev init/adopt` (scaffold.ts) | N/A (writes template) | Remove template |

### What does NOT read projectlist.md

- `afx spawn -p XXXX` — uses filesystem glob on `codev/specs/`
- Porch state — uses `codev/projects/<id>/status.yaml`
- Spec/plan/review discovery — filename-based

## Desired State

### GitHub Issues as the single source of truth

Every project and bug is a GitHub Issue. Metadata is encoded via:

| projectlist.md field | GitHub Issues equivalent |
|---------------------|------------------------|
| `id` | Issue number (auto-assigned) |
| `title` | Issue title |
| `summary` | Issue body (first paragraph) |
| `status` | Labels: `status:conceived`, `status:specified`, `status:committed`, etc. |
| `priority` | Labels: `priority:high`, `priority:medium`, `priority:low` |
| `release` | GitHub Milestone |
| `tags` | Labels: `tag:shellper`, `tag:reliability`, etc. |
| `dependencies` | Issue body section or "depends on #42" in body |
| `timestamps` | Implicit from label change history / issue events |
| `notes` | Issue comments |
| `files.spec` | Convention: `codev/specs/<issue#>-<slug>.md` |
| `files.plan` | Convention: `codev/plans/<issue#>-<slug>.md` |
| `files.review` | Convention: `codev/reviews/<issue#>-<slug>.md` |

### Label scheme

```
# Type
type:project        — feature project (SPIR/TICK)
type:bug            — bugfix
type:experiment     — experiment protocol
type:maintenance    — maintenance run

# Status (lifecycle)
status:conceived
status:specified
status:planned
status:implementing
status:implemented
status:committed
status:integrated

# Priority
priority:high
priority:medium
priority:low

# Tags (examples, project-specific)
tag:shellper
tag:terminal
tag:consult
tag:porch
```

### Spec file naming

Spec files use the GitHub Issue number:
- `codev/specs/298-github-issues-tracking.md` (no leading zeros)
- `codev/plans/298-github-issues-tracking.md`
- `codev/reviews/298-github-issues-tracking.md`

This means `afx spawn -p 298` finds `codev/specs/298-*.md` — same filesystem glob, just with issue numbers instead of manual IDs.

### Workflow changes

**Creating a project (before):**
1. Edit projectlist.md, reserve next number
2. Create spec file with that number
3. Commit both files

**Creating a project (after):**
1. `gh issue create --title "Feature name" --label "type:project,status:conceived,priority:high"`
2. Issue #298 is auto-assigned
3. Create `codev/specs/298-feature-name.md`

**Spawning a builder (before):**
```bash
afx spawn -p 0116     # looks for codev/specs/0116-*.md
```

**Spawning a builder (after):**
```bash
afx spawn -p 298      # looks for codev/specs/298-*.md
afx spawn --issue 298 # same thing (unify project and bugfix spawning)
```

**Status transitions:**
```bash
# Automated by porch/afx commands:
gh issue edit 298 --remove-label "status:conceived" --add-label "status:specified"

# Or manual:
gh issue edit 298 --remove-label "status:implementing" --add-label "status:committed"
```

## Implementation

### Phase 1: Label setup and CLI changes

1. Create label set via `gh label create` (idempotent script)
2. Modify `afx spawn -p` to accept issue numbers and unify with `--issue` flag
3. Modify `getProjectSummary()` in `porch/prompts.ts` to read from `gh issue view`
4. Modify `afx spawn` to auto-update issue label to `status:implementing` on spawn
5. Modify `afx cleanup` to auto-update issue label to `status:committed` on PR merge

### Phase 2: Remove projectlist.md dependency

1. Remove `projectlist.md` template from `codev-skeleton/templates/`
2. Remove `projectlist-archive.md` template
3. Update `codev init/adopt` to skip projectlist scaffolding
4. Update `scaffold.ts` to remove `copyProjectlist()`
5. Update all protocol docs, CLAUDE.md, AGENTS.md to reference GitHub Issues instead

### Phase 3: Dashboard integration

1. Replace `StatusPanel.tsx` file polling with GitHub API query
2. Or: add a Tower endpoint that runs `gh issue list --json` and caches results
3. Display projects as cards with label-based status

### Phase 4: Migration (this repo only)

1. Create GitHub Issues for all active projects currently in projectlist.md
2. Apply labels matching current status
3. Archive projectlist.md (don't delete — git history)
4. Update CLAUDE.md instructions

## Success Criteria

- [ ] `afx spawn -p <issue#>` finds spec by issue number
- [ ] `afx spawn --issue <num>` works for both projects and bugs (unified)
- [ ] Porch can read project summary from GitHub Issue
- [ ] Status labels are auto-updated by `afx spawn`, `afx cleanup`, and porch
- [ ] No code references projectlist.md
- [ ] Dashboard shows projects from GitHub Issues
- [ ] `codev init` no longer creates projectlist.md

## Constraints

- Must work offline (cache issue data, degrade gracefully)
- Must not break existing `afx spawn -p` for numbered specs already on disk
- GitHub API rate limits: 5000/hr authenticated — sufficient for our usage
- `gh` CLI must be installed (already a dependency via bugfix protocol)

## Open Questions

- [ ] Should `codev init` create the label set automatically? Or require a one-time `codev setup-labels`?
- [ ] How to handle the `dependencies` field? GitHub Issues doesn't have native dependency tracking. Options: body text ("depends on #42"), or a "blocked by" label, or just drop it.
- [ ] Should closed issues = `integrated`? Or keep open until explicitly marked?

## Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| GitHub API unavailable | Low | Medium | Cache last-known state locally |
| `gh` CLI not installed | Low | High | `codev doctor` checks for it |
| Rate limiting | Very Low | Low | Only query on spawn/status, not polling |
| Offline development | Medium | Medium | Spec files still on disk, only status tracking needs network |
