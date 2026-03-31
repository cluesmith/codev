# Specification: afx spawn Improvements

## Metadata
- **ID**: spec-2026-02-19-spawn-improvements
- **Status**: draft
- **Created**: 2026-02-19

## Clarifying Questions Asked

1. **Should TICK protocol also skip the spec requirement?** No. TICK amends an existing spec, so the spec file must already exist. Only protocols with a Specify phase (SPIR, ASPIR) should skip the requirement.

2. **What happens to the worktree/branch naming when no spec file exists?** The project slug should be derived from the GitHub issue title via `slugify()`, the same utility already used by bugfix mode.

3. **Should the `input.required` field in protocol.json be used to control this behavior?** Yes. The field already exists and is set to `false` for SPIR and ASPIR. The spawn code should read it instead of unconditionally requiring a spec file.

## Problem Statement

`afx spawn` currently requires a spec file (`codev/specs/N-*.md`) to exist before spawning a builder for SPIR/ASPIR protocols. This forces the architect to create a stub spec, commit it, and push before spawning — unnecessary friction when the protocol's own Specify phase will create the spec.

Additionally, SPIR/ASPIR project naming is derived from the spec filename slug (e.g., `spawn-improvements`), while bugfix derives its project name from the GitHub issue title. This creates inconsistency: the spec filename is often abbreviated while the issue title is descriptive.

## Current State

### Spec-file requirement (`spawnSpec()` in `spawn.ts:245-259`)

```
afx spawn 444 --protocol aspir
→ [error] Spec not found for issue #444. Expected: codev/specs/444-*.md
```

The architect must:
1. Create `codev/specs/444-stub.md` with minimal content
2. Commit it to `main`
3. Then run `afx spawn 444 --protocol aspir`

This adds 2-3 extra steps per spawn. The protocol definition (`aspir/protocol.json`) already declares `"input": { "required": false }`, but the spawn code ignores this field.

### Project naming (`spawnSpec()` in `spawn.ts:261-265`)

Project names are derived from the spec filename:
- Spec file: `codev/specs/444-spawn-improvements.md`
- Slug: `spawn-improvements`
- Worktree: `.builders/aspir-444-spawn-improvements`
- Porch project name: `spawn-improvements`

By contrast, bugfix mode fetches the GitHub issue title and uses `slugify(issue.title)`:
- Issue title: "afx spawn should not require a pre-existing spec file"
- Slug: `af-spawn-should-not-require-a`
- Worktree: `.builders/bugfix-444-af-spawn-should-not-require-a`

SPIR/ASPIR already fetches the GitHub issue non-fatally (line 301) but only uses it to enrich the builder prompt, not for naming.

## Desired State

### 1. Spec-file requirement removed for protocols with a Specify phase

When a protocol's `input.required` is `false` (or the protocol has a `specify` phase), `afx spawn` should proceed without a spec file. When no spec file exists:
- The project slug is derived from the GitHub issue title via `slugify()`
- The worktree, branch, and porch project are named using this slug
- The builder prompt indicates no spec exists yet and the Specify phase will create it
- Porch's Specify phase creates the spec as its first artifact

When a spec file does exist (pre-written by the architect), the spec file is still used by porch for its Specify phase (skip as pre-approved). However, naming is determined by GitHub issue title regardless of whether a spec exists — see §2 below.

### 2. GitHub issue title used for all protocol naming

When spawning with a GitHub issue number, the project name should always prefer the GitHub issue title (via `slugify()`), regardless of protocol. If no GitHub issue is available (offline, missing `gh` CLI), fall back to the spec filename slug. If no spec file exists either, fail with a clear error.

This makes naming consistent across all protocols and produces more descriptive project names.

## Stakeholders
- **Primary Users**: Architects spawning builders via `afx spawn`
- **Secondary Users**: Builders that receive the initial prompt
- **Technical Team**: Codev maintainers

## Success Criteria
- [ ] `afx spawn 444 --protocol aspir` succeeds without a spec file when protocol has `input.required: false`
- [ ] `afx spawn 444 --protocol spir` succeeds without a spec file (same condition)
- [ ] When no spec file exists, the worktree/branch/porch use the GitHub issue title slug
- [ ] When a spec file exists, porch behavior is unchanged (spec is used as pre-approved artifact)
- [ ] Naming uses GitHub issue title even when a spec file exists (naming behavior change)
- [ ] `afx spawn 444 --protocol tick --amends 30` still requires the amends spec file (TICK unchanged)
- [ ] All existing tests pass
- [ ] New unit tests cover the no-spec spawn path
- [ ] Documentation updated (if any user-facing docs reference the spec requirement)

## Constraints
### Technical Constraints
- Must not break `--resume` behavior (existing worktree lookup by pattern)
- Must not break TICK protocol (always requires an existing spec). Note: TICK's protocol.json also has `input.required: false`, but TICK's spec requirement is enforced via the separate `options.amends` code path in `spawnSpec()`, not via `input.required`. This distinction must be preserved.
- The `slugify()` function already exists and produces filesystem-safe names (max 30 chars, lowercase, alphanumeric + hyphens)
- Porch `initPorchInWorktree()` requires a project name — must be derivable without a spec file
- GitHub issue fetching is already non-fatal for SPIR/ASPIR — needs to become fatal when it's the only source of project name

### Business Constraints
- Backward compatibility: porch behavior unchanged when spec files exist. Naming changes from spec-filename-derived to GitHub-issue-title-derived (intentional improvement, not a regression)

## Assumptions
- The `gh` CLI is available and authenticated (already assumed for bugfix mode)
- GitHub issue numbers map 1:1 to project IDs (already the case)
- The `input.required` field in protocol.json is the correct mechanism to control spec-file requirement

## Solution Approaches

### Approach 1: Read `input.required` from protocol definition (Recommended)

**Description**: Modify `spawnSpec()` to load the protocol definition and check `input.required`. When `false` and no spec file exists, derive naming from the GitHub issue title.

**Pros**:
- Uses the existing protocol definition field that was designed for this purpose
- Minimal code change (the field already exists in all protocol.json files)
- Protocol authors control the behavior per-protocol

**Cons**:
- None significant

**Estimated Complexity**: Low
**Risk Level**: Low

### Approach 2: Check for `specify` phase in protocol definition

**Description**: Instead of reading `input.required`, check if the protocol has a phase with `id: "specify"`. If it does, the spec file is optional.

**Pros**:
- Implicit — no additional configuration needed
- Self-documenting: "if the protocol creates specs, specs aren't required upfront"

**Cons**:
- Less explicit than `input.required`
- Requires parsing the phases array

**Estimated Complexity**: Low
**Risk Level**: Low

### Recommended: Approach 1

`input.required` is the explicit, declarative mechanism. It already exists in all protocol definitions and is more flexible (a protocol could have a specify phase but still require a pre-existing spec).

## Open Questions

### Critical (Blocks Progress)
- [x] Should GitHub issue title be the primary naming source even when a spec file exists? **Yes — for consistency. Fall back to spec filename only when GitHub is unavailable.**

### Important (Affects Design)
- [x] When `input.required: false` and no spec file exists AND GitHub issue fetch fails, should we fail or generate a fallback name? **Fail with clear error. The project needs a name.**

## Performance Requirements
- No performance impact — `slugify()` and protocol.json reads are negligible
- GitHub issue fetch already happens (non-fatal) — may become fatal in the no-spec path

## Security Considerations
- No security impact — no new inputs, no new external calls
- `slugify()` already sanitizes input for filesystem safety

## Test Scenarios
### Functional Tests
1. **No spec file, protocol with `input.required: false`**: Spawn succeeds, worktree named from GitHub issue title
2. **No spec file, protocol with `input.required: true` (or TICK)**: Spawn fails with existing error message
3. **Spec file exists + GitHub available**: GitHub issue title drives naming; porch uses spec as pre-approved artifact
4. **Spec file exists + GitHub unavailable**: Spec filename drives naming (fallback)
5. **No spec file, GitHub issue fetch fails**: Spawn fails with clear error message
6. **Resume with no-spec spawn**: `--resume` finds the existing worktree by issue number pattern (not slug)
7. **GitHub issue title changes after spawn**: `--resume` still works because it matches on `{protocol}-{id}-*` pattern, not the slug

### Non-Functional Tests
1. Existing spawn test suite passes without modification
2. Existing porch test suite passes without modification

## Dependencies
- **External Services**: GitHub API via `gh` CLI (already used)
- **Internal Systems**: `slugify()` utility, `loadProtocol()`, `fetchGitHubIssue()`
- **Libraries/Frameworks**: None new

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Naming mismatch between spec file and GitHub issue | Low | Low | GitHub title takes priority; spec filename is fallback |
| `--resume` breaks for no-spec spawns | Medium | High | Use same worktree pattern detection as bugfix mode |
| TICK accidentally skips spec check | Low | High | TICK handler checks `options.amends` separately before `input.required` logic |
