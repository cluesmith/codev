# Spec 0065: BUGFIX Protocol and CLI Support

**Status**: Draft
**Protocol**: SPIDER
**Priority**: High
**Created**: 2026-01-03

## Problem Statement

Codev currently has two protocols for development work:
- **SPIDER**: Full specification → planning → implementation cycle for new features
- **TICK**: Amendments to existing SPIDER specs

Neither is appropriate for **minor bugfixes** reported as GitHub Issues. SPIDER is too heavyweight (specs, plans, reviews), and TICK requires an existing spec to amend.

We need a lightweight protocol for bug fixes that:
1. Integrates with GitHub Issues as the trigger
2. Uses the Architect-Builder pattern with isolated worktrees
3. Includes quality gates (CMAP reviews) without excessive overhead
4. Has CLI support for streamlined workflow

## Goals

### Must Have

1. **BUGFIX Protocol** - A documented protocol for handling minor bugs
   - Clear scope boundaries (when to use vs. escalate to SPIDER)
   - Defined workflow from issue → fix → merge → cleanup
   - CMAP review at PR stage (intentionally lighter than SPIDER's throughout-consultation)
   - Success criteria checklist for builders
   - Edge case handling (can't reproduce, too complex, etc.)

2. **CLI Support: `af spawn --issue <N>`**
   - Fetch issue content automatically via `gh issue view`
   - Create branch with consistent naming: `builder/bugfix-<N>-<slug>`
   - Create worktree at `.builders/bugfix-<N>/`
   - Load bugfix-specific builder context
   - Optionally auto-comment "On it..." on the issue

3. **CLI Support: `af cleanup --issue <N>`**
   - Clean up bugfix worktrees by issue number
   - Delete remote branch after merge
   - Consistent with existing `af cleanup --project` pattern

4. **Builder Role Clarity**
   - Builder knows they're in BUGFIX mode (via task context)
   - Clear differences from SPIDER builder workflow
   - No spec/plan artifacts to produce

### Should Have

5. **Integration with existing tooling**
   - `af status` shows bugfix builders
   - `af send` works with bugfix builders
   - Dashboard displays bugfix builders

### Won't Have (Explicit Exclusions)

- **Projectlist integration** - BUGFIX issues are tracked in GitHub Issues, not `codev/projectlist.md`. The projectlist is for feature work with specs/plans.
- **Review documents** - BUGFIX produces no `codev/reviews/` artifacts. The PR serves as the review record.
- **Multi-builder support** - One builder per issue (no parallel work on same bug)

## Technical Design

### 1. BUGFIX Protocol (`codev/protocols/bugfix/protocol.md`)

The protocol defines the following workflow:

```
ARCHITECT                              BUILDER
─────────                              ───────

1. Identify issue #N
      │
      ▼
2. af spawn --issue N  ───────────────►  3. Comment "On it..."
      │                                        │
      │                                        ▼
      │                                  4. Investigate & Fix
      │                                        │
      │                               ┌────────┴────────┐
      │                               │                 │
      │                         Too Complex?      Simple Fix
      │                               │                 │
      │◄── af send "Complex" ◄────────┘                 │
      │                                                 ▼
      │                                  5. Create PR + CMAP review
      │                                        │
      │◄────────────────── af send "PR ready" ◄┘
      │
      ▼
6. Review PR + CMAP integration
      │
      ├─── gh pr comment ──────────────►  7. Address feedback
      │                                        │
      │◄────────────────── af send "Fixed" ◄───┘
      │
      ▼
8. af send "Merge it"  ────────────────►  9. gh pr merge --merge
      │                                        │
      │◄────────────────── af send "Merged" ◄──┘
      │
      ▼
10. git pull && verify
      │
      ▼
11. af cleanup --issue N && close issue
```

#### Success Criteria Checklist (Builder)

Before marking PR ready:
- [ ] Bug is reproduced locally
- [ ] Root cause is identified
- [ ] Fix is implemented (< 300 LOC net diff - see scope definition below)
- [ ] **Regression test added** (MANDATORY - prevents future recurrence)
- [ ] Existing tests pass
- [ ] CMAP review completed (3-way)
- [ ] Any REQUEST_CHANGES addressed
- [ ] PR body includes "Fixes #N" (for auto-close)
- [ ] PR description includes: Summary, Root Cause, Fix, Test Plan

#### Scope Definition: 300 LOC

The "< 300 LOC" threshold is measured as **net diff** (additions + deletions):
```bash
git diff --stat main | tail -1
# Example: "3 files changed, 145 insertions(+), 52 deletions(-)"
# Net diff = 145 + 52 = 197 LOC ✓ (under 300)
```

- **Includes**: All source files (code, tests, configs)
- **Excludes**: Generated files, lock files, vendored code
- **Guideline, not hard rule**: The 300 LOC threshold is a heuristic. Use judgment - a 350 LOC fix that's well-contained is fine; a 200 LOC fix that touches 10 files may warrant escalation.

#### Escalation Criteria

Builder escalates to Architect when:
- Fix requires > 300 lines of code
- Multiple modules/services affected
- Root cause is unclear after 30 minutes
- Architectural changes needed
- Cannot reproduce after good-faith effort

#### Edge Case Handling

| Scenario | Action |
|----------|--------|
| Cannot reproduce | Document attempts in issue, ask for more details, notify Architect |
| Issue already closed | Check with Architect before starting |
| Fix too complex | Notify Architect with details, recommend SPIDER |
| Unrelated test failures | Do NOT fix (out of scope), notify Architect |
| Documentation-only bug | Use BUGFIX (still a valid bug) |
| Stale "On it" comment | If no PR after 24h, comment "Stalled - clearing lock" and continue |
| Worktree already exists | Run `af cleanup --issue N` first, then retry spawn |
| Multiple bugs in one issue | Fix primary bug only, note others for separate issues |

#### CMAP Review Strategy

BUGFIX uses **PR-only CMAP reviews** (not throughout like SPIDER). This is intentional:

- **Why**: BUGFIX scope is small enough that mid-implementation review adds overhead without benefit
- **When**: Builder runs 3-way CMAP before marking PR ready; Architect runs 3-way integration review
- **Types**: `pr-ready` for builder, `integration-review` for Architect

### 2. CLI Changes: `af spawn --issue`

**New option**: `--issue <N>` or `-i <N>`

```bash
af spawn --issue 42
af spawn -i 42
af spawn --issue 42 --no-comment    # Skip "On it" comment
af spawn --issue 42 --force         # Override collision detection
```

**Behavior**:
1. Fetch issue content via `gh issue view`
2. Check for collisions (existing worktree, recent "On it" comments, open PRs)
3. Create worktree at `.builders/bugfix-<N>/`
4. Create branch `builder/bugfix-<N>-<slug>`
5. Comment "On it!" on the issue (unless `--no-comment`)
6. Spawn builder with issue context

**Collision Detection**:
- Blocks if worktree already exists
- Blocks if "On it" comment < 24h old (warns if > 24h)
- Blocks if open PR references the issue
- Use `--force` to override

### 3. CLI Changes: `af cleanup --issue`

**New option**: `--issue <N>`

```bash
af cleanup --issue 42
af cleanup --issue 42 --force    # Skip safety checks
```

**Behavior**:
1. Remove worktree at `.builders/bugfix-<N>/`
2. Verify PR is merged before deleting remote branch
3. Delete remote branch `builder/bugfix-<N>-*`

### 4. Naming Conventions

| Component | Pattern | Example |
|-----------|---------|---------|
| Branch | `builder/bugfix-<N>-<slug>` | `builder/bugfix-42-fix-login-spaces` |
| Worktree | `.builders/bugfix-<N>/` | `.builders/bugfix-42/` |
| Builder ID | `bugfix-<N>` | `bugfix-42` |
| Slug | First 30 chars of sanitized title | `fix-login-fails-when-userna` |

### 5. Builder Context

When spawned via `--issue`, the builder receives:
- Issue number, title, and body
- Reference to BUGFIX protocol
- Clear mission: reproduce → fix → test → PR

### 6. State Management

Bugfix builders are tracked with type `bugfix` in the existing state database.

**Builder types**:
- `spec` - Spawned via `--project`
- `bugfix` - Spawned via `--issue`
- `task` - Spawned via `--task`

### 7. Dashboard Integration

Bugfix builders appear with:
- `[BUGFIX]` badge
- Clickable issue link (`#42`)
- Standard status indicators

### 8. Git Commit Convention

```
[Bugfix #N] Fix: <what was fixed>
[Bugfix #N] Test: <what test was added>
```

This differs from SPIDER's `[Spec XXXX][Phase]` format intentionally:
- Issue numbers are shorter (no leading zeros)
- No phase names (BUGFIX is single-phase conceptually)
- Aligns with GitHub's `Fixes #N` convention

## Example Walkthrough

**Issue #42**: "Login fails when username contains spaces"

```bash
# 1. Architect identifies the issue
gh issue view 42

# 2. Architect spawns builder
af spawn --issue 42
# → Creates .builders/bugfix-42/
# → Creates branch builder/bugfix-42-login-fails-when-userna
# → Comments "On it!" on issue #42
# → Spawns builder with issue context

# 3. Builder investigates
# (In worktree, builder finds encoding bug in auth.ts)

# 4. Builder fixes and tests
git add src/auth.ts tests/auth.test.ts
git commit -m "[Bugfix #42] Fix: URL-encode username before API call"
git commit -m "[Bugfix #42] Test: Add regression test for spaces in username"

# 5. Builder runs CMAP review
consult --model gemini --type pr-ready pr 50 &
consult --model codex --type pr-ready pr 50 &
consult --model claude --type pr-ready pr 50 &
wait

# 6. Builder creates PR
gh pr create --title "[Bugfix #42] Fix login for usernames with spaces" \
  --body "Fixes #42..."

# 7. Builder notifies Architect
af send architect "PR #50 ready (fixes issue #42)"

# 8. Architect reviews + CMAP integration review
consult --model gemini --type integration-review pr 50 &
consult --model codex --type integration-review pr 50 &
consult --model claude --type integration-review pr 50 &
wait

# 9. Architect approves
gh pr review 50 --approve
af send bugfix-42 "LGTM. Merge it."

# 10. Builder merges (no --delete-branch due to worktree)
gh pr merge 50 --merge
af send architect "Merged. Ready for cleanup."

# 11. Architect cleans up
git pull
af cleanup --issue 42
# → Removes .builders/bugfix-42/
# → Deletes origin/builder/bugfix-42-login-fails-when-userna

# 12. Issue auto-closed by PR (via "Fixes #42")
```

**Total time**: ~45 minutes

## Files Changed

### New Files
- `codev/protocols/bugfix/protocol.md` - Protocol documentation (already drafted)

### Modified Files
- `packages/codev/src/commands/af/spawn.ts` - Add `--issue` option
- `packages/codev/src/commands/af/cleanup.ts` - Add `--issue` option
- `packages/codev/src/lib/state.ts` - Support `bugfix` builder type (if needed)
- `codev/templates/dashboard-split.html` - Show BUGFIX badge (if needed)
- `codev/roles/builder.md` - Add BUGFIX protocol summary
- `CLAUDE.md` / `AGENTS.md` - Add BUGFIX to protocol selection guide

## Testing Strategy

Testing is critical to prevent regressions. Tests follow the existing pattern in `packages/codev/src/agent-farm/__tests__/` using Vitest.

### Extend spawn.test.ts

Add to existing `packages/codev/src/agent-farm/__tests__/spawn.test.ts`:

```typescript
describe('--issue mode', () => {
  describe('validateSpawnOptions', () => {
    it('should accept --issue alone', () => {
      const options: SpawnOptions = { issue: 42 };
      expect(validateSpawnOptions(options)).toBeNull();
    });

    it('should accept --issue with --no-comment', () => {
      const options: SpawnOptions = { issue: 42, noComment: true };
      expect(validateSpawnOptions(options)).toBeNull();
    });

    it('should reject --issue + --project', () => {
      const options: SpawnOptions = { issue: 42, project: '0009' };
      const error = validateSpawnOptions(options);
      expect(error).toContain('mutually exclusive');
    });

    it('should reject --issue + --task', () => {
      const options: SpawnOptions = { issue: 42, task: 'Fix bug' };
      const error = validateSpawnOptions(options);
      expect(error).toContain('mutually exclusive');
    });
  });

  describe('getSpawnMode', () => {
    it('should return "bugfix" for --issue', () => {
      expect(getSpawnMode({ issue: 42 })).toBe('bugfix');
    });
  });

  describe('branch naming', () => {
    it('bugfix mode uses builder/bugfix-{issue}-{slug}', () => {
      const branchName = 'builder/bugfix-42-fix-login-spaces';
      expect(branchName).toMatch(/^builder\/bugfix-\d+-[a-z0-9-]+$/);
    });
  });

  describe('slug generation', () => {
    it('should sanitize special characters', () => {
      const slug = slugify("Fix: login fails! (spaces)", { lower: true, strict: true });
      expect(slug).toBe('fix-login-fails-spaces');
    });

    it('should truncate to 30 chars', () => {
      const title = 'This is a very long issue title that exceeds thirty characters';
      const slug = slugify(title, { lower: true, strict: true }).slice(0, 30);
      expect(slug.length).toBeLessThanOrEqual(30);
    });
  });
});
```

### New collision.test.ts

Create `packages/codev/src/agent-farm/__tests__/collision.test.ts`:

```typescript
describe('Collision Detection', () => {
  describe('worktree exists', () => {
    it('should detect existing worktree path', () => {...});
    it('should suggest cleanup command', () => {...});
  });

  describe('on-it comment detection', () => {
    it('should block if comment < 24h old', () => {...});
    it('should warn but proceed if comment > 24h old', () => {...});
    it('should respect --force flag', () => {...});
  });

  describe('open PR detection', () => {
    it('should block if open PR references issue', () => {...});
    it('should respect --force flag', () => {...});
  });
});
```

### Extend cleanup tests

Add to or create `packages/codev/src/agent-farm/__tests__/cleanup.test.ts`:

```typescript
describe('--issue cleanup', () => {
  it('should construct correct worktree path from issue number', () => {...});
  it('should construct correct branch pattern', () => {...});
  it('should verify PR merged before deleting remote branch', () => {...});
  it('should block if open PR exists (without --force)', () => {...});
  it('should proceed with --force despite open PR', () => {...});
});
```

### BATS E2E Tests

Add `tests/e2e/bugfix.bats` for full workflow testing:

```bash
@test "af spawn --issue creates worktree and branch" {
  # Uses test repo with sample issues
}

@test "af cleanup --issue removes worktree and remote branch" {
  # Cleanup after spawn
}
```

## Acceptance Criteria

1. **Protocol documented** - `codev/protocols/bugfix/protocol.md` is complete with workflow, success criteria, edge cases
2. **af spawn --issue works** - Creates worktree, branch, comments on issue, spawns builder
3. **Collision detection works** - Blocks spawn if existing worktree, recent "On it" comment, or open PR
4. **af cleanup --issue works** - Removes worktree, verifies PR merged, deletes remote branch
5. **Builder receives context** - Issue title/body included in task prompt
6. **Dashboard shows bugfix builders** - With appropriate type indicator
7. **Documentation updated** - CLAUDE.md, AGENTS.md, builder role updated
8. **Tests pass** - Unit, integration, and E2E tests for spawn and cleanup

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Issue doesn't exist | `gh issue view` fails with clear error |
| Issue already being worked | Check for existing "On it" comments before starting |
| Builder accidentally closes issue | Issue auto-closes only via PR "Fixes #N" |
| Worktree conflicts | Same conflict detection as spec worktrees |

## Triage Guidelines

Use these guidelines to determine whether an issue is appropriate for BUGFIX or should escalate to SPIDER:

### Use BUGFIX when:
- Clear reproduction steps provided
- Bug is isolated to a single module/component
- No architectural implications
- Fix is straightforward once root cause is understood
- < 300 LOC expected (net diff)

### Escalate to SPIDER when:
- "Feature request disguised as bug" (e.g., "bug: should support dark mode")
- Requires new specs or design discussion
- Affects multiple systems or services
- Root cause suggests deeper architectural issues
- Fix would require > 300 LOC
- Multiple stakeholders need to weigh in

### Decision Flowchart

```
Is there a GitHub Issue?
├── NO → Create issue first, then continue
└── YES → Is it actually a bug (not feature request)?
    ├── NO → Create SPIDER spec for the feature
    └── YES → Is it isolated to one module?
        ├── NO → Escalate to SPIDER
        └── YES → Is fix expected < 300 LOC?
            ├── NO → Escalate to SPIDER
            └── YES → Use BUGFIX ✓
```

## Appendix: Comparison with Other Protocols

| Aspect | BUGFIX | TICK | SPIDER |
|--------|--------|------|--------|
| **Trigger** | GitHub Issue | Amendment need | New feature |
| **Spec required** | No | Existing spec | New spec |
| **Plan required** | No | Update existing | New plan |
| **Review doc** | No | Yes | Yes |
| **Projectlist tracking** | No (GitHub Issues) | Yes | Yes |
| **Builder worktree** | Yes | Yes | Yes |
| **CMAP reviews** | PR only | End only | Throughout |
| **Typical duration** | 30 min - 2 hours | 1-4 hours | Days |
| **Typical scope** | < 300 LOC | < 300 LOC | Any |
