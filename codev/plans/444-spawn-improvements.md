# Plan: afx spawn Improvements

## Metadata
- **ID**: plan-2026-02-19-spawn-improvements
- **Status**: draft
- **Specification**: codev/specs/444-spawn-improvements.md
- **Created**: 2026-02-19

## Executive Summary

Modify `spawnSpec()` in `spawn.ts` to:
1. Read the protocol's `input.required` field before requiring a spec file
2. When `input.required` is `false` and no spec exists, derive the project slug from the GitHub issue title
3. When a GitHub issue is available (for any protocol), prefer the issue title for naming

This is a low-risk change. All building blocks exist (`slugify()`, `fetchGitHubIssue`, `loadProtocol`). The primary modification is in `spawnSpec()` with supporting changes to handle the no-spec code path.

## Success Metrics
- [ ] `afx spawn N --protocol aspir` works without a spec file
- [ ] `afx spawn N --protocol spir` works without a spec file
- [ ] TICK still requires spec file (via `options.amends` path)
- [ ] Naming uses GitHub issue title when available
- [ ] `--resume` works for no-spec spawns
- [ ] All existing tests pass
- [ ] New unit tests cover the no-spec path

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "no-spec-spawn", "title": "Support spawning without a spec file"},
    {"id": "github-naming", "title": "Use GitHub issue title for project naming"},
    {"id": "tests", "title": "Unit tests for new behavior"}
  ]
}
```

## Phase Breakdown

### Phase 1: Support spawning without a spec file
**Dependencies**: None

#### Objectives
- Allow `spawnSpec()` to proceed when no spec file exists and the protocol's `input.required` is `false`
- Derive project slug from GitHub issue title when no spec file exists

#### Deliverables
- [ ] Modified `spawnSpec()` to conditionally skip spec-file requirement
- [ ] GitHub issue fetch promoted to fatal when it's the only source of project name
- [ ] Worktree/branch/porch naming uses issue title slug when no spec exists
- [ ] Builder prompt indicates no spec exists yet (Specify phase will create it)

#### Implementation Details

**File: `packages/codev/src/agent-farm/commands/spawn.ts`**

In `spawnSpec()` (currently lines 245-341):

1. Load the protocol definition (`loadProtocol()`) early, before the spec file check
2. Check `protocolDef.input?.required !== false` before calling `fatal()` on missing spec
3. When no spec file exists:
   - Fetch GitHub issue (fatal if it fails — we need a name)
   - Use `slugify(issue.title)` for the project slug
   - Construct `specName` as `${projectId}-${slug}` (e.g., `444-af-spawn-should-not-require-a`)
   - The rest of the naming logic (`worktreeName`, `branchName`, `worktreePath`, `porchProjectName`) follows from `specName` as before
4. Template context: when no spec file exists, set `spec.path` to the expected path (where the Specify phase will create it) and add a `spec_missing: true` flag
5. The builder prompt template (`spawn-roles.ts` `buildPromptFromTemplate`) already renders the spec path — the `spec_missing` flag is available in the template context but does not require a template file change since the template already says "Read the specification at: {spec.path}" which will point to the correct expected path. The Specify phase prompt will create the file there.

**Key code flow change:**

```
BEFORE:
  specFile = findSpecFile(...)
  if (!specFile) → fatal()

AFTER:
  specFile = findSpecFile(...)
  if (!specFile) {
    if (protocolDef.input?.required === false && !options.amends) {
      ghIssue = fetchGitHubIssue(issueNumber)  // fatal wrapper
      slug = slugify(ghIssue.title)
      specName = `${strippedId}-${slug}`
    } else {
      fatal(...)  // existing behavior (covers input.required: true AND TICK amends)
    }
  }
```

**Additional changes in the no-spec path:**
- Logger: `logger.kv('Spec', '(will be created by Specify phase)')` instead of logging null
- Template context: set `spec_missing: true` to signal the builder prompt template

#### Acceptance Criteria
- [ ] `afx spawn 444 --protocol aspir` succeeds without a spec file
- [ ] `afx spawn 444 --protocol tick --amends 30` still fails without the amends spec file
- [ ] Worktree is named correctly from GitHub issue title
- [ ] Porch is initialized with the correct project name

#### Rollback Strategy
Revert the single file change to `spawn.ts`. No database or state changes.

#### Risks
- **Risk**: `fetchGitHubIssue` becomes fatal in the no-spec path but `gh` CLI may not be available
  - **Mitigation**: Clear error message instructing user to install/authenticate `gh`

---

### Phase 2: Use GitHub issue title for project naming
**Dependencies**: Phase 1

#### Objectives
- When a GitHub issue is available, prefer the issue title slug for naming even when a spec file exists
- Fall back to spec filename slug when GitHub issue is unavailable

#### Deliverables
- [ ] Modified naming logic in `spawnSpec()` to prefer GitHub issue title
- [ ] Fallback to spec filename when GitHub is unavailable

#### Implementation Details

**File: `packages/codev/src/agent-farm/commands/spawn.ts`**

After Phase 1, the no-spec path already uses GitHub issue title. In Phase 2, extend this to the spec-exists path:

1. Move the GitHub issue fetch (`fetchGitHubIssueNonFatal`) earlier, before naming derivation
2. When `ghIssue` is available: `slug = slugify(ghIssue.title)`, construct naming from `${strippedId}-${slug}`
3. When `ghIssue` is not available: fall back to existing behavior (derive slug from spec filename)
4. Note: the actual spec file on disk may have a different name — `specFile` is tracked separately for porch/template use
4. The rest of the naming chain (`worktreeName`, `branchName`, `worktreePath`, `porchProjectName`) remains unchanged — it already derives from `specName`

**Key change:**

```
BEFORE:
  specName = basename(specFile, '.md')
  // ... naming derived from specName ...
  ghIssue = fetchGitHubIssueNonFatal(issueNumber)  // used only for prompt enrichment

AFTER:
  ghIssue = fetchGitHubIssueNonFatal(issueNumber)
  if (ghIssue) {
    slug = slugify(ghIssue.title)
    specName = `${strippedId}-${slug}`
  } else {
    specName = basename(specFile, '.md')  // fallback
  }
  // ... naming derived from specName as before ...
```

Note: `specFile` is still tracked separately for template context (so porch can find the actual file).

#### Acceptance Criteria
- [ ] When spec exists + GitHub available: naming uses GitHub issue title
- [ ] When spec exists + GitHub unavailable: naming falls back to spec filename
- [ ] `--resume` still finds existing worktrees (matches on `{protocol}-{id}-*`)

#### Rollback Strategy
Revert the naming change in `spawn.ts`. Phase 1 can remain independently.

---

### Phase 3: Unit tests for new behavior
**Dependencies**: Phase 1, Phase 2

#### Objectives
- Add unit tests covering the new no-spec and GitHub-naming paths
- Verify existing tests still pass

#### Deliverables
- [ ] New test cases in `packages/codev/src/agent-farm/__tests__/spawn.test.ts`
- [ ] All existing tests pass

#### Implementation Details

**File: `packages/codev/src/agent-farm/__tests__/spawn.test.ts`**

New test cases:
1. **No spec file, `input.required: false`**: Mock `findSpecFile` to return null, mock `loadProtocol` to return `input: { required: false }`, mock `fetchGitHubIssue` to return issue. Assert spawn succeeds with correct worktree name.
2. **No spec file, `input.required: true`**: Mock `findSpecFile` to return null, mock `loadProtocol` to return `input: { required: true }`. Assert spawn calls `fatal()`.
3. **No spec file, GitHub fetch fails**: Mock both to fail. Assert spawn calls `fatal()` with clear message.
4. **Spec exists + GitHub available**: Assert naming uses GitHub issue title slug.
5. **Spec exists + GitHub unavailable**: Assert naming falls back to spec filename slug.
6. **TICK with missing amends spec**: Mock `findSpecFile` to return null for the amends spec, with `options.amends` set. Assert spawn calls `fatal()` even though TICK has `input.required: false`.

#### Acceptance Criteria
- [ ] All new tests pass
- [ ] All existing tests pass
- [ ] Build succeeds (`npm run build`)

#### Test Plan
- **Unit Tests**: As described above
- **Manual Testing**: Run `afx spawn` with and without spec files in a test environment

## Dependency Map
```
Phase 1 (no-spec-spawn) ──→ Phase 2 (github-naming) ──→ Phase 3 (tests)
```

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| `--resume` breaks for GitHub-titled worktrees | Low | High | `inferProtocolFromWorktree` matches on `{protocol}-{id}-*`, ignores slug |
| TICK accidentally bypasses spec check | Low | High | TICK uses `options.amends` before `input.required` check |
| Existing tests break from naming change | Medium | Medium | Run full test suite after each phase |

## Validation Checkpoints
1. **After Phase 1**: `afx spawn` works without spec file for ASPIR/SPIR
2. **After Phase 2**: Naming uses GitHub issue title consistently
3. **After Phase 3**: Full test suite green, build succeeds
