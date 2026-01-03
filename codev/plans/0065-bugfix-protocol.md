# Plan 0065: BUGFIX Protocol and CLI Support

**Spec**: `codev/specs/0065-bugfix-protocol.md`
**Protocol**: SPIDER
**Created**: 2026-01-03

## Overview

This plan implements the BUGFIX protocol and CLI support as specified in Spec 0065.

## Implementation Phases

### Phase 1: Protocol Documentation

Create `codev/protocols/bugfix/protocol.md` with:
- Workflow diagram
- Phase details
- Success criteria checklist
- Edge case handling
- Triage guidelines

**Status**: Complete (already created)

### Phase 2: CLI - `af spawn --issue`

**File**: `packages/codev/src/commands/af/spawn.ts`

Add new option:
```typescript
.option('-i, --issue <number>', 'Spawn builder for a GitHub issue')
.option('--no-comment', 'Skip commenting on the issue')
.option('--force', 'Force spawn even if collision detected')
```

Implementation:

```typescript
async function spawnForIssue(issueNumber: number, options: SpawnOptions) {
  const worktreePath = `.builders/bugfix-${issueNumber}`;

  // 1. Check for existing worktree (collision detection)
  if (fs.existsSync(worktreePath)) {
    console.error(`Error: Worktree already exists at ${worktreePath}`);
    console.error(`Run: af cleanup --issue ${issueNumber}`);
    process.exit(1);
  }

  // 2. Fetch issue content
  let issue: { title: string; body: string; state: string; comments: any[] };
  try {
    const result = await execCapture(
      `gh issue view ${issueNumber} --json title,body,state,comments`
    );
    issue = JSON.parse(result);
  } catch (err) {
    console.error(`Error: Failed to fetch issue #${issueNumber}`);
    console.error(`Ensure 'gh' CLI is installed and authenticated`);
    process.exit(1);
  }

  const { title, body, state, comments } = issue;

  // 3. Check for existing work (collision detection)
  const onItComments = comments.filter((c: any) =>
    c.body.toLowerCase().includes('on it')
  );
  if (onItComments.length > 0) {
    const lastComment = onItComments[onItComments.length - 1];
    const age = Date.now() - new Date(lastComment.createdAt).getTime();
    const hoursAgo = Math.round(age / (1000 * 60 * 60));

    if (hoursAgo < 24) {
      console.warn(`Warning: Issue #${issueNumber} has "On it" comment from ${hoursAgo}h ago`);
      console.warn(`Someone may already be working on this. Continue anyway? (use --force)`);
      if (!options.force) {
        process.exit(1);
      }
    } else {
      console.warn(`Warning: Stale "On it" comment (${hoursAgo}h ago). Proceeding.`);
    }
  }

  // 4. Check for open PRs referencing this issue
  try {
    const prs = await execCapture(
      `gh pr list --search "in:body #${issueNumber}" --json number,title --limit 5`
    );
    const openPRs = JSON.parse(prs);
    if (openPRs.length > 0) {
      console.warn(`Warning: Found ${openPRs.length} open PR(s) referencing issue #${issueNumber}:`);
      openPRs.forEach((pr: any) => console.warn(`  - PR #${pr.number}: ${pr.title}`));
      if (!options.force) {
        console.warn(`Use --force to proceed anyway`);
        process.exit(1);
      }
    }
  } catch (err) {
    // Non-fatal: continue if PR check fails
  }

  if (state === 'CLOSED') {
    console.warn(`Warning: Issue #${issueNumber} is already closed`);
    // Continue but warn
  }

  // 5. Create slug from title (sanitized)
  const slug = slugify(title, { lower: true, strict: true }).slice(0, 30);

  // 6. Create branch name
  const branchName = `builder/bugfix-${issueNumber}-${slug}`;

  // 7. Create worktree
  await execCapture(`git worktree add -b ${branchName} ${worktreePath}`);

  // 8. Comment on issue (unless --no-comment)
  if (!options.noComment) {
    try {
      await execCapture(
        `gh issue comment ${issueNumber} --body "On it! Working on a fix now."`
      );
    } catch (err) {
      console.warn(`Warning: Failed to comment on issue (continuing anyway)`);
    }
  }

  // 9. Spawn builder with bugfix context
  const taskDescription = `Fix GitHub Issue #${issueNumber}: ${title}\n\n${body}`;
  await spawnBuilder({
    task: taskDescription,
    worktree: worktreePath,
    protocol: 'bugfix',
    identifier: `bugfix-${issueNumber}`
  });
}
```

**Naming Conventions**:
- Branch: `builder/bugfix-<N>-<slug>` (max 30 char slug)
- Worktree: `.builders/bugfix-<N>/`
- Builder ID: `bugfix-<N>`

### Phase 3: CLI - `af cleanup --issue`

**File**: `packages/codev/src/commands/af/cleanup.ts`

Add new option:
```typescript
.option('--issue <number>', 'Cleanup bugfix builder for a GitHub issue')
```

Implementation:

```typescript
async function cleanupBugfix(issueNumber: number, options: CleanupOptions) {
  const worktreePath = `.builders/bugfix-${issueNumber}`;
  const branchPattern = `builder/bugfix-${issueNumber}-*`;

  // 1. Verify worktree exists
  if (!fs.existsSync(worktreePath)) {
    console.warn(`Warning: Worktree ${worktreePath} does not exist`);
    // Continue to clean up any remote branches
  } else {
    // 2. Use existing cleanup logic (checks for uncommitted work)
    await cleanupWorktree(worktreePath, { force: options.force });
  }

  // 3. Find and verify remote branches before deletion
  const branches = await execCapture(`git branch -r --list 'origin/${branchPattern}'`);
  for (const branch of branches.split('\n').filter(Boolean)) {
    const branchName = branch.trim().replace('origin/', '');

    // 4. Safety check: verify PR is merged before deleting remote branch
    if (!options.force) {
      try {
        const prStatus = await execCapture(
          `gh pr list --head ${branchName} --state merged --json number --limit 1`
        );
        const mergedPRs = JSON.parse(prStatus);
        if (mergedPRs.length === 0) {
          // Check for open PRs
          const openPRs = await execCapture(
            `gh pr list --head ${branchName} --state open --json number --limit 1`
          );
          if (JSON.parse(openPRs).length > 0) {
            console.error(`Error: Branch ${branchName} has an open PR. Use --force to delete anyway.`);
            continue;
          }
          console.warn(`Warning: No merged PR found for ${branchName}. Use --force to delete anyway.`);
          continue;
        }
      } catch (err) {
        console.warn(`Warning: Could not verify PR status for ${branchName}`);
      }
    }

    // 5. Delete remote branch
    try {
      await execCapture(`git push origin --delete ${branchName}`);
      console.log(`Deleted remote branch: ${branchName}`);
    } catch (err) {
      console.warn(`Warning: Failed to delete remote branch ${branchName}`);
    }
  }
}
```

### Phase 4: Builder Context

**Task prompt template** for bugfix builders:

```
You are working on a BUGFIX task.

## Protocol
Follow the BUGFIX protocol: codev/protocols/bugfix/protocol.md

## Issue #${issueNumber}
**Title**: ${title}

**Description**:
${body}

## Your Mission
1. Reproduce the bug
2. Identify root cause
3. Implement fix (< 300 LOC)
4. Add regression test
5. Run CMAP review
6. Create PR

If the fix is too complex (> 300 LOC or architectural changes), notify the Architect.
```

### Phase 5: State Management

Bugfix builders use the existing SQLite state database with a new type:

```sql
-- Existing builders table works, just different identifier format
INSERT INTO builders (id, type, status, worktree, branch, created_at)
VALUES ('bugfix-42', 'bugfix', 'implementing', '.builders/bugfix-42', 'builder/bugfix-42-fix-login', NOW());
```

**Builder types**:
- `spec` - Spawned via `--project` for a spec
- `bugfix` - Spawned via `--issue` for a GitHub issue
- `task` - Spawned via `--task` for ad-hoc work

### Phase 6: Dashboard Integration

Bugfix builders appear in dashboard with:
- Type indicator: `[BUGFIX]` badge
- Issue link: Clickable `#42` that opens GitHub issue
- Same status indicators as spec builders

### Phase 7: Testing

**Extend spawn.test.ts** (`packages/codev/src/agent-farm/__tests__/spawn.test.ts`):

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

**Create collision.test.ts** (`packages/codev/src/agent-farm/__tests__/collision.test.ts`):

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

**BATS E2E test** (`tests/e2e/bugfix.bats`):

```bash
@test "af spawn --issue creates worktree and branch" {
  # Uses test repo with sample issues
}

@test "af cleanup --issue removes worktree and remote branch" {
  # Cleanup after spawn
}
```

### Phase 8: Documentation Updates

Update these files:
- `codev/roles/builder.md` - Add BUGFIX protocol summary
- `CLAUDE.md` / `AGENTS.md` - Add BUGFIX to protocol selection guide

## Files Changed

### New Files
- `codev/protocols/bugfix/protocol.md` ✓ (already created)
- `codev/plans/0065-bugfix-protocol.md` (this file)
- `packages/codev/src/agent-farm/__tests__/collision.test.ts`
- `tests/e2e/bugfix.bats`

### Modified Files
- `packages/codev/src/commands/af/spawn.ts` - Add `--issue` option
- `packages/codev/src/commands/af/cleanup.ts` - Add `--issue` option
- `packages/codev/src/agent-farm/__tests__/spawn.test.ts` - Add issue mode tests
- `packages/codev/src/agent-farm/types.ts` - Add `bugfix` to BuilderType
- `codev/templates/dashboard-split.html` - Show BUGFIX badge (if needed)
- `codev/roles/builder.md` - Add BUGFIX protocol summary
- `CLAUDE.md` / `AGENTS.md` - Add BUGFIX to protocol selection guide

## Dependencies

- `slugify` package (already available or add to dependencies)
- `gh` CLI must be installed and authenticated

## Risks

| Risk | Mitigation |
|------|------------|
| `gh` CLI not installed | Clear error message with instructions |
| Network failure during issue fetch | Graceful error handling |
| Collision detection false positives | `--force` flag to override |
