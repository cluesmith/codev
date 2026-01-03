# BUGFIX Protocol

**Lightweight protocol for minor bugfixes using GitHub Issues**

## Overview

BUGFIX is a streamlined protocol for addressing minor bugs reported as GitHub Issues. It uses the Architect-Builder pattern with isolated worktrees but skips the heavyweight specification and planning phases of SPIDER.

**Core Principle**: Bug → Builder → Fix → Review → Merge → Cleanup

**When to Use**:
- Minor bugs with clear reproduction steps
- Issues that can be fixed in < 300 lines of code
- No architectural changes required
- Fix is straightforward once the bug is understood

**When NOT to Use** (escalate to SPIDER or TICK):
- It's a new feature (not a bug)
- Bug reveals deeper architectural issues
- Fix requires > 300 lines of code
- Multiple components need coordinated changes
- Root cause is unclear after investigation

## Workflow Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            BUGFIX PROTOCOL                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ARCHITECT                           BUILDER                                │
│  ─────────                           ───────                                │
│                                                                             │
│  1. Identify issue #N                                                       │
│        │                                                                    │
│        ▼                                                                    │
│  2. af spawn --task "Fix #N"  ──────►  3. Comment "On it..."               │
│        │                                      │                             │
│        │                                      ▼                             │
│        │                               4. Investigate & Fix                 │
│        │                                      │                             │
│        │                              ┌───────┴───────┐                     │
│        │                              │               │                     │
│        │                        Too Complex?    Simple Fix                  │
│        │                              │               │                     │
│        │◄─── af send "Complex" ◄──────┘               │                     │
│        │                                              ▼                     │
│        │                               5. Create PR + CMAP review           │
│        │                                      │                             │
│        │◄─────────────────── af send "PR #M ready" ◄──┘                     │
│        │                                                                    │
│        ▼                                                                    │
│  6. Review PR + CMAP integration                                            │
│        │                                                                    │
│        ├───── gh pr comment (feedback) ─────►  7. Address feedback          │
│        │                                              │                     │
│        │◄─────────────────── af send "Fixed" ◄────────┘                     │
│        │                                                                    │
│        ▼                                                                    │
│  8. af send "Merge it"  ──────────────────────►  9. gh pr merge --merge     │
│        │                                              │                     │
│        │◄─────────────────── af send "Merged" ◄───────┘                     │
│        │                                                                    │
│        ▼                                                                    │
│  10. git pull && verify                                                     │
│        │                                                                    │
│        ▼                                                                    │
│  11. af cleanup && close issue                                              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Phase Details

### Phase 1: Issue Identification (Architect)

**Input**: GitHub Issue number

**Architect Actions**:
1. Read the issue: `gh issue view <N>`
2. Verify it's a valid bug (not a feature request)
3. Assess complexity - is it suitable for BUGFIX protocol?
4. If too complex, escalate to SPIDER instead

**Example**:
```bash
gh issue view 42
# Assess: Clear reproduction, simple fix expected → BUGFIX
# Assess: Unclear cause, architectural implications → SPIDER
```

### Phase 2: Spawn Builder (Architect)

**Architect Actions**:
1. Spawn a builder for the issue:
   ```bash
   af spawn --issue 42
   # or
   af spawn -i 42
   ```
2. The command automatically:
   - Fetches issue content via `gh issue view`
   - Creates branch `builder/bugfix-42-<slug-from-title>`
   - Creates worktree at `.builders/bugfix-42/`
   - Comments "On it!" on the issue (unless `--no-comment`)
   - Spawns builder with issue context

**Branch Naming**: `builder/bugfix-<issue-number>-<slug>`

The `builder/` prefix maintains consistency with Agent Farm tooling.

### Phase 3: Acknowledge Issue (Builder)

**Builder Actions**:
1. Comment on the issue to signal work has started:
   ```bash
   gh issue comment <N> --body "On it! Working on a fix now."
   ```
2. Read the full issue and any related discussion
3. Begin investigation

### Phase 4: Investigate and Fix (Builder)

**Builder Actions**:
1. Reproduce the bug locally
2. Identify root cause
3. Implement the fix
4. Write/update tests to cover the bug
5. Verify the fix resolves the issue

**Complexity Check**:
If during investigation the builder determines the fix is too complex:
```bash
af send architect "Issue #N is more complex than expected. [Reason]. Recommend escalating to SPIDER/TICK."
```

The Architect will then decide whether to:
- Continue with BUGFIX (provide guidance)
- Escalate to SPIDER protocol (new feature complexity)
- Escalate to TICK protocol (amends existing spec)
- Abandon and close the issue with explanation

**Commits**:
```bash
git add <specific-files>
git commit -m "[Bugfix #N] Fix: <description>"
git commit -m "[Bugfix #N] Test: Add regression test"
```

### Phase 5: PR Creation and CMAP Review (Builder)

**Builder Actions**:
1. Push the branch:
   ```bash
   git push -u origin bugfix/<N>-description
   ```

2. Create the PR:
   ```bash
   gh pr create --title "[Bugfix #N] <description>" --body "$(cat <<'EOF'
   ## Summary
   Fixes #N

   ## Root Cause
   <Brief explanation of what caused the bug>

   ## Fix
   <Brief explanation of the fix>

   ## Test Plan
   - [ ] Added regression test
   - [ ] Verified fix locally
   - [ ] Existing tests pass

   ## CMAP Review
   <To be added after review>
   EOF
   )"
   ```

3. Run 3-way CMAP review:
   ```bash
   consult --model gemini --type pr-ready pr <PR_NUMBER> &
   consult --model codex --type pr-ready pr <PR_NUMBER> &
   consult --model claude --type pr-ready pr <PR_NUMBER> &
   wait
   ```

4. Address any REQUEST_CHANGES from the review

5. Update PR description with CMAP review summary

6. Notify Architect:
   ```bash
   af send architect "PR #<M> ready for review (fixes issue #<N>)"
   ```

### Phase 6: Integration Review (Architect)

**Architect Actions**:
1. Review the PR: `gh pr view <M>`

2. Run 3-way CMAP integration review:
   ```bash
   consult --model gemini --type integration-review pr <M> &
   consult --model codex --type integration-review pr <M> &
   consult --model claude --type integration-review pr <M> &
   wait
   ```

3. If changes needed, post feedback as PR comment:
   ```bash
   gh pr comment <M> --body "## Integration Review

   **Verdict: REQUEST_CHANGES**

   ### Issues
   - [Issue 1]
   - [Issue 2]

   ---
   Architect integration review"
   ```

4. Notify builder:
   ```bash
   af send <builder-id> "Check PR #<M> comments"
   ```

5. Once satisfied, approve and instruct merge:
   ```bash
   gh pr review <M> --approve
   af send <builder-id> "LGTM. Merge it."
   ```

### Phase 7: Address Feedback (Builder, if needed)

**Builder Actions** (if feedback received):
1. Read the feedback: `gh pr view <M> --comments`
2. Make requested changes
3. Push updates to the same branch
4. Notify Architect:
   ```bash
   af send architect "Fixed feedback on PR #<M>"
   ```

### Phase 8: Merge (Builder)

**Builder Actions**:
1. Merge the PR (do NOT delete branch - worktree limitation):
   ```bash
   gh pr merge <M> --merge
   ```

   **Important**: Do NOT use `--delete-branch`. The builder is on this branch in a worktree, so branch deletion will fail.

2. Notify Architect:
   ```bash
   af send architect "PR #<M> merged. Ready for cleanup."
   ```

### Phase 9: Cleanup (Architect)

**Architect Actions**:
1. Pull the changes:
   ```bash
   git pull
   ```

2. Verify the fix is on main:
   ```bash
   git log --oneline -5  # Should see the bugfix commits
   ```

3. Clean up the builder's worktree and remote branch:
   ```bash
   af cleanup --issue 42
   ```
   This removes the worktree at `.builders/bugfix-42/` and deletes the remote branch.

4. Close the issue (if not auto-closed by PR):
   ```bash
   gh issue close <N> --comment "Fixed in PR #<M>"
   ```
   Note: If PR body contains "Fixes #N", the issue is auto-closed on merge.

## Communication Summary

| From | To | Method | Example |
|------|-----|--------|---------|
| Architect | Builder | `af spawn` | `af spawn --task "Fix #42"` |
| Architect | Builder | `af send` | `af send builder "Check PR comments"` |
| Builder | Architect | `af send` | `af send architect "PR #50 ready"` |
| Builder | Issue | `gh issue comment` | `gh issue comment 42 --body "On it"` |
| Architect | PR | `gh pr comment` | `gh pr comment 50 --body "LGTM"` |

## Success Criteria Checklist

Before marking PR ready, the Builder must verify:

- [ ] Bug is reproduced locally
- [ ] Root cause is identified and documented in PR
- [ ] Fix is implemented (< 300 LOC net diff - see scope definition below)
- [ ] **Regression test added** (MANDATORY - prevents future recurrence)
- [ ] All existing tests pass
- [ ] CMAP review completed (3-way: Gemini, Codex, Claude)
- [ ] Any REQUEST_CHANGES from CMAP addressed
- [ ] PR body includes "Fixes #N" (for auto-close)
- [ ] PR description includes: Summary, Root Cause, Fix, Test Plan

### Scope Definition: 300 LOC

The "< 300 LOC" threshold is measured as **net diff** (additions + deletions):

```bash
git diff --stat main | tail -1
# Example: "3 files changed, 145 insertions(+), 52 deletions(-)"
# Net diff = 145 + 52 = 197 LOC ✓ (under 300)
```

- **Includes**: All source files (code, tests, configs)
- **Excludes**: Generated files, lock files, vendored code
- **Guideline, not hard rule**: The 300 LOC threshold is a heuristic. Use judgment - a 350 LOC fix that's well-contained is fine; a 200 LOC fix that touches 10 files may warrant escalation.

## Edge Case Handling

| Scenario | Builder Action |
|----------|----------------|
| Cannot reproduce bug | Document reproduction attempts in issue comment, ask reporter for more details, notify Architect via `af send` |
| Issue already closed | Check with Architect before starting work (may be duplicate or already fixed) |
| Fix too complex (> 300 LOC) | Notify Architect with complexity details, recommend escalation to SPIDER |
| Architectural changes needed | Notify Architect immediately, do not proceed with BUGFIX |
| Unrelated test failures | Do NOT fix (out of scope), notify Architect to handle separately |
| Documentation-only bug | Valid for BUGFIX - fix the docs, add test if applicable |
| Multiple bugs in one issue | Fix only the primary bug, note others for separate issues |

## Escalation Criteria

**Builder should escalate to Architect when**:
- Fix requires architectural changes
- Multiple services/modules affected
- Root cause is unclear after 30 minutes
- Fix would be > 300 lines of code
- Tests reveal deeper problems

**Architect escalation options**:
1. **Continue BUGFIX** - Provide guidance, builder continues
2. **Escalate to SPIDER** - Create proper spec for complex fix
3. **Close as won't fix** - Document reasoning on issue

## Git Commit Convention

```
[Bugfix #N] Fix: <what was fixed>
[Bugfix #N] Test: <what test was added>
[Bugfix #N] Docs: <if docs updated>
```

**Note**: This differs from SPIDER's `[Spec XXXX][Phase]` format intentionally:
- Issue numbers are shorter (no leading zeros)
- No phase names (BUGFIX is single-phase conceptually)
- Aligns with GitHub's `Fixes #N` convention in PR bodies

## Comparison with Other Protocols

| Aspect | BUGFIX | TICK | SPIDER |
|--------|--------|------|--------|
| Trigger | GitHub Issue | Amendment need | New feature |
| Spec required | No | Existing spec | New spec |
| Plan required | No | Update existing | New plan |
| Review doc | No | Yes | Yes |
| Builder worktree | Yes | Yes | Yes |
| CMAP reviews | PR only | End only | Throughout |
| Typical duration | 30 min - 2 hours | 1-4 hours | Days |

## CMAP Review Strategy

BUGFIX uses **PR-only CMAP reviews**, which is intentionally lighter than SPIDER's throughout-consultation approach.

**Why PR-only?**
- BUGFIX scope is small (< 300 LOC) - mid-implementation review adds overhead without benefit
- The issue itself serves as the "spec" - no spec review needed
- No plan document exists - no plan review needed
- All review effort is concentrated where it matters: the final PR

**Review Types**:
- Builder: `consult --model X --type pr-ready pr N`
- Architect: `consult --model X --type integration-review pr N`

**3-Way Review Pattern**:
```bash
# Run all three in parallel, in background
consult --model gemini --type pr-ready pr 50 &
consult --model codex --type pr-ready pr 50 &
consult --model claude --type pr-ready pr 50 &
wait
```

## Example Walkthrough

**Issue #42**: "Login fails when username contains spaces"

```bash
# 1. Architect identifies the issue
gh issue view 42
# → Clear bug report, simple fix expected → BUGFIX appropriate

# 2. Architect spawns builder
af spawn --issue 42
# → Creates .builders/bugfix-42/
# → Creates branch builder/bugfix-42-login-fails-when-userna
# → Comments "On it!" on issue #42
# → Spawns builder with issue context

# 3. Builder investigates (in worktree)
cd .builders/bugfix-42
# → Finds encoding bug in src/auth.ts line 47

# 4. Builder fixes and tests
git add src/auth.ts tests/auth.test.ts
git commit -m "[Bugfix #42] Fix: URL-encode username before API call"
git commit -m "[Bugfix #42] Test: Add regression test for spaces in username"

# 5. Builder creates PR
git push -u origin builder/bugfix-42-login-fails-when-userna
gh pr create --title "[Bugfix #42] Fix login for usernames with spaces" \
  --body "Fixes #42

## Root Cause
Username was passed to API without URL encoding.

## Fix
Added encodeURIComponent() call in auth.ts:47.

## Test Plan
- [x] Added regression test
- [x] Verified fix locally"

# 6. Builder runs CMAP review
consult --model gemini --type pr-ready pr 50 &
consult --model codex --type pr-ready pr 50 &
consult --model claude --type pr-ready pr 50 &
wait
# → All APPROVE

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
git log --oneline -3  # Verify fix is on main
af cleanup --issue 42
# → Removes .builders/bugfix-42/
# → Deletes origin/builder/bugfix-42-login-fails-when-userna

# Issue #42 auto-closed by PR (via "Fixes #42")
```

**Total time**: ~45 minutes

## Best Practices

1. **Comment early** - Let the reporter know someone is working on it
2. **Keep fixes minimal** - Fix the bug, don't refactor surrounding code
3. **Add regression tests** - Prevent the bug from recurring
4. **Reference the issue** - Use "Fixes #N" in PR to auto-close
5. **Escalate promptly** - Don't waste time on complex issues
6. **Clean up promptly** - Merge and cleanup shouldn't linger

## Projectlist Integration

**BUGFIX issues are NOT tracked in `codev/projectlist.md`.**

Rationale:
- BUGFIX work is tracked in GitHub Issues (the source of truth)
- Projectlist is for feature work that requires specs and plans
- Adding bugfixes would clutter projectlist with transient work
- The PR and closed issue serve as the permanent record

To find past bugfixes, search GitHub:
```bash
gh issue list --state closed --label bug
gh pr list --state merged --search "Bugfix"
```

## Triage Guidelines

Use these guidelines to determine whether an issue is appropriate for BUGFIX:

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

## Limitations

1. **No spec/plan artifacts** - Less documentation than SPIDER
2. **Limited scope** - Only for truly minor fixes
3. **Single builder** - No parallel work on same issue
4. **Issue dependency** - Requires GitHub Issue to exist first
5. **No projectlist tracking** - Must use GitHub Issues for history
