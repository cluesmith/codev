# Specification: Support Non-GitHub Repositories

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.

DO NOT include in this spec:
- Implementation phases or steps
- File paths to modify
- Code examples or pseudocode
- "First we will... then we will..."

These belong in codev/plans/589-non-github-repository-support.md
-->

## Metadata
- **ID**: 589-non-github-repository-support
- **Status**: draft
- **Created**: 2026-03-08
- **GitHub Issue**: #589

## Clarifying Questions Asked

1. **Q: What non-GitHub forges need explicit support (GitLab, Gitea, Forgejo, etc.)?**
   A: Rather than hard-coding adapters per forge, the recommended approach is to define **concept commands** — standardized text protocols for each forge operation (issue-view, pr-list, etc.) with configurable external commands. The default commands use `gh`, but any project can override them with any program that produces the expected JSON output. This follows the UNIX philosophy: structured text on stdout, composable programs, language-agnostic. A GitLab user writes a small script wrapping `glab`, a Gitea user wraps `tea`, and a fully-offline user provides a no-op or local-file-based implementation. Codev never needs to know about any specific forge beyond GitHub's defaults.

2. **Q: How deep is the GitHub coupling currently?**
   A: Extensive — 6 functional areas: (1) core issue/PR CRUD in `lib/github.ts`, (2) team activity in `lib/team-github.ts`, (3) builder spawn collision detection and "On it!" comments, (4) Work view (overview.ts) aggregating PRs/issues/backlog, (5) Analytics (analytics.ts) for merged PR metrics, (6) protocol `pr_exists` checks in protocol.json files. However, all GitHub functions already return `null` on failure with graceful degradation.

3. **Q: What should happen to features that fundamentally require a remote forge (e.g., PRs, issue comments)?**
   A: They degrade gracefully. The Work view shows builders and local spec/plan state without PR/issue data. Analytics shows what it can from git history alone. Builder spawn skips collision detection and comment posting.

4. **Q: Does `codev adopt` or `codev init` currently detect the forge?**
   A: No. There is no forge detection. The `gh` CLI is assumed available and authenticated.

## Problem Statement

Codev is tightly coupled to GitHub via the `gh` CLI. Every `gh` command fails in repositories that don't have a GitHub remote origin — this includes self-hosted GitLab, Gitea, Forgejo, Bitbucket, plain bare-repo setups, and fully offline development. The failure mode is noisy: spawn warnings, broken Work view data, empty Analytics, and failed protocol `pr_exists` checks.

While the codev methodology (SPIR, ASPIR, etc.) is forge-agnostic, the tooling is not. This blocks adoption for any team not on GitHub.

## Current State

- **`lib/github.ts`**: 14+ direct `gh` CLI invocations for issues, PRs, GraphQL queries. All return `null` on failure — graceful degradation exists but is accidental, not intentional.
- **`lib/team-github.ts`**: Team member activity queries via `gh api graphql`. Fully GitHub-specific.
- **`spawn-worktree.ts`**: Calls `fetchGitHubIssueOrThrow` (throws on failure), checks for "On it!" collision comments, detects open PRs for the issue, posts "On it!" comment on spawn.
- **`overview.ts` (Work view)**: Aggregates open PRs, open issues, recently closed issues, recently merged PRs. All sourced from GitHub. Cross-references with local spec/plan files for backlog derivation.
- **`analytics.ts`**: Computes metrics from merged PRs (median time-to-merge, protocol breakdown, wall-clock hours). Uses "On it!" comment timestamps for builder start time.
- **Protocol JSON files**: All protocols define `pr_exists` check as `gh pr list --state all --head "$(git branch --show-current)" ...` — blocks phase completion for non-GitHub repos.
- **`porch/next.ts`**: Merge instructions hardcode `gh pr merge --merge`.

**Existing graceful degradation**: Most functions in `github.ts` catch errors and return `null`. The overview and analytics endpoints include `errors` arrays. This means the architecture is already partially tolerant — the gap is making this intentional and complete.

## Desired State

- **Concept commands**: Each forge operation codev needs (fetch issue, list PRs, post comment, etc.) is defined as a **concept command** with a standardized JSON output contract. Codev's runtime calls the configured command, parses its stdout, and never knows which forge produced the data.
- **Default `gh` commands**: Out of the box, all concept commands default to `gh`-based implementations. Existing GitHub projects see zero behavior change.
- **Per-project overrides via `af-config.json`**: Projects configure their forge commands in the existing `af-config.json` override pattern. Any executable that produces the expected JSON on stdout works — written in any language, wrapping any forge CLI.
- **Graceful absence**: If a concept command is not configured and the default `gh` command fails (or `gh` is not installed), the operation returns null/empty and codev degrades gracefully — the same pattern already partially in place.
- **Concept-level granularity**: Projects can override some concepts and leave others at defaults, or explicitly disable concepts they don't need (e.g., `"issue-comment": null` to skip "On it!" posting).
- **Clear UX signals**: When a concept command is missing or fails, codev logs which concept was unavailable. On first use, if no forge commands succeed, a notice explains that forge features are unavailable.
- **No codev code changes for new forges**: Supporting GitLab, Gitea, Forgejo, Bitbucket, or any future forge requires only writing external commands — no PRs to codev itself.

## Stakeholders

- **Primary Users**: Developers using codev on non-GitHub repositories (self-hosted forges, bare repos, offline)
- **Secondary Users**: GitHub users who work offline temporarily (airplane mode, VPN issues)
- **Technical Team**: Codev maintainers
- **Community**: Issue #589 author (nharward) and future contributors from non-GitHub ecosystems

## Success Criteria

- [ ] All GitHub-calling code paths go through concept commands, not direct `gh` invocations
- [ ] Default `gh`-based concept commands produce identical behavior for existing GitHub projects
- [ ] Projects can override any concept command via `af-config.json` with an external program
- [ ] Projects can disable individual concepts (e.g., `null` to skip issue commenting)
- [ ] `codev adopt` succeeds on a repository with no GitHub remote and no `gh` installed
- [ ] `af spawn` works when forge concepts are unavailable (no errors, graceful skip)
- [ ] `porch check` and `porch done` work with overridden `pr-exists` concept
- [ ] Work view renders without errors when forge concepts return empty (builders + local state visible)
- [ ] Analytics page renders without errors when forge concepts return empty (git-derived metrics shown)
- [ ] Each concept command has a documented JSON output contract
- [ ] `codev doctor` validates forge concept commands in `af-config.json` — reports any configured paths that are not executable by the current user
- [ ] User-level documentation explains the override system conceptually and practically, with worked examples for two concepts using a non-GitHub forge (e.g., GitLab). Linked from README.md if not inline.
- [ ] All existing tests continue to pass
- [ ] New tests cover: concept command dispatch, override loading, null/disabled concepts, default `gh` fallback, malformed output handling
- [ ] No new runtime dependencies added

## Constraints

### Technical Constraints

- Must work with the existing `af-config.json` configuration pattern
- Concept commands must be external processes (exec'd, not imported) — any language, any runtime
- Each concept command's JSON contract must be documented and stable across codev versions
- Concept command execution must be non-blocking where possible (timeouts, async)
- Protocol JSON files are shared templates; concept command overrides happen at runtime via config, not by modifying protocol files
- Default `gh` commands must not be invoked when overridden — avoid requiring `gh` to be installed on non-GitHub projects

### Business Constraints

- Must be non-breaking — zero impact on existing GitHub workflows
- Should be implementable as a focused set of PRs (not a massive rewrite)
- Should not slow down the happy path (GitHub users) with unnecessary abstraction layers

## Assumptions

- The default `gh`-based commands are correct for GitHub-hosted repos and require no configuration
- Non-GitHub projects configure their concept commands explicitly via `af-config.json`
- Concept commands are short-lived processes (not daemons) — exec'd per invocation with JSON on stdout
- The set of concepts needed is finite and stable (issue-view, pr-list, issue-list, issue-comment, pr-exists, recently-closed, recently-merged, user-identity, team-activity, on-it-timestamps)
- Projects may only need a subset of concepts — unconfigured concepts that fail gracefully are acceptable

## Forge Concepts

The following concepts capture every forge operation codev currently uses. Each becomes a configurable command with a defined JSON output contract.

| Concept | Current `gh` Usage | Output Type | Used By |
|---------|-------------------|-------------|---------|
| `issue-view` | `gh issue view N --json ...` | Single issue object | spawn-worktree (fetch issue details) |
| `pr-list` | `gh pr list --json ...` | Array of open PRs | overview (PR panel) |
| `issue-list` | `gh issue list --json ...` | Array of open issues | overview (backlog derivation) |
| `issue-comment` | `gh issue comment N --body ...` | Exit code (0 = success) | spawn ("On it!" posting), protocol hooks |
| `pr-exists` | `gh pr list --state all --head branch` | JSON boolean on stdout (`true`/`false`) | protocol checks (phase completion) |
| `recently-closed` | `gh issue list --state closed --search ...` | Array of closed issues | overview (recently closed panel) |
| `recently-merged` | `gh pr list --state merged --search ...` | Array of merged PRs | overview, analytics |
| `user-identity` | `gh api user --jq .login` | String (username) | team commands |
| `team-activity` | `gh api graphql` (batched) | Per-member stats object | team tab, team-update |
| `on-it-timestamps` | `gh api graphql` (batched) | Map of issue → timestamp | analytics (wall-clock metrics) |
| `pr-merge` | `gh pr merge N --merge` | Exit code (0 = success) | porch/next.ts merge instructions |
| `pr-search` | `gh pr list --search "..." --json ...` | Array of PRs matching query | spawn collision detection, cleanup PR status, consult PR lookup |
| `pr-view` | `gh pr view N --json ...` | Single PR object with metadata | consult PR review data |
| `pr-diff` | `gh pr diff N` | Diff text (stdout, not JSON) | consult PR review diff |
| `gh-auth-status` | `gh auth status` | Exit code (0 = authenticated) | doctor health check |

**Input passing**: Concept commands receive their arguments via environment variables (e.g., `CODEV_ISSUE_ID=PROJ-42`, `CODEV_BRANCH_NAME=feature/foo`, `CODEV_SINCE_DATE=2026-03-01`). All identifiers (issue IDs, PR IDs, etc.) are treated as **opaque strings** — codev never assumes they are numeric. This ensures compatibility with systems like Jira (`PROJ-123`), GitLab (numeric but different namespace), and any other tracker. The current codebase uses `number` for issue IDs internally (`fetchGitHubIssue(issueNumber: number)`); this must be refactored to `string | number` as part of implementation.

**Execution model**: Concept commands are executed via a shell (`sh -c` / `cmd /c`) to allow pipes, redirects, and variable expansion in user-configured commands. Environment variables are set by codev before invocation — they are **not** interpolated into the command string by codev. The user's command string may reference `$CODEV_*` vars directly (shell expands them) or the command can read them from its environment. This is the same trust model as git hooks and `$EDITOR`. The security section addresses the injection surface.

**Error contract**: Exit code 0 = success (parse stdout as JSON). Non-zero = failure (codev treats as unavailable, same as current `null` return pattern). Stderr is passed through for diagnostics.

**Protocol check integration**: Protocol JSON files currently define `pr_exists` as a raw `gh` shell command. Rather than modifying protocol templates, porch will be updated to intercept the `pr_exists` check name and route it through the concept command dispatch. This keeps protocol templates stable across projects while allowing per-project forge configuration.

## Solution Approaches

### Approach 1: Concept Commands with Text Protocol Contracts (Recommended)

**Description**: Define each forge operation as a **concept command** — an external process with a standardized JSON output contract. Codev ships default commands that wrap `gh`. Projects override commands via `af-config.json`. Codev's runtime execs the configured command, parses JSON stdout, and never calls `gh` directly.

Example `af-config.json`:
```json
{
  "forge": {
    "pr-list": "glab mr list --json id,title,web_url,state",
    "issue-list": "glab issue list --json iid,title,web_url,labels",
    "issue-comment": "glab issue note $CODEV_ISSUE_NUMBER --message \"$CODEV_COMMENT_BODY\"",
    "pr-exists": "glab mr list --state all --source-branch $CODEV_BRANCH_NAME --json iid | jq 'length > 0'",
    "team-activity": null,
    "on-it-timestamps": null
  }
}
```

Setting a concept to `null` explicitly disables it (codev skips that operation gracefully).

**Pros**:
- **UNIX philosophy** — any program that outputs the right JSON works, in any language
- **Infinitely extensible** — new forges require zero codev code changes, just external commands
- **Follows established pattern** — same `af-config.json` override mechanism used by spec 550 for porch checks
- **Granular** — override only the concepts you need; leave the rest at defaults or disabled
- **Backward compatible** — no config = `gh` defaults = identical behavior for GitHub projects
- **Community-friendly** — users can publish concept command packages for their forge (`codev-gitlab`, `codev-gitea`)
- **Analogy to git hooks** — familiar pattern for git users: configurable external commands at defined extension points

**Cons**:
- JSON output contracts must be documented and kept stable across minor codev versions (major versions may break compatibility)
- Complex concepts (team-activity, on-it-timestamps) require batched GraphQL — harder to replicate for non-GitHub forges
- Users must write/find concept commands for their forge (no built-in auto-detection)

**Estimated Complexity**: Medium
**Risk Level**: Low

### Approach 2: Hard-Coded Forge Adapters

**Description**: Introduce a `ForgeAdapter` TypeScript interface. Implement `GitHubAdapter` (wraps existing `gh` calls) and `LocalAdapter` (returns empty/null). Auto-detect which adapter to use based on remote URL. All consumers call through the adapter.

**Pros**:
- Clean TypeScript interface — type-safe, testable
- No process exec overhead — in-process calls
- Codev controls the full implementation

**Cons**:
- Every new forge requires a PR to codev with a new adapter class
- Adapter interface may not anticipate future forge needs — locked to codev's release cycle
- Community cannot add forge support independently
- Still requires touching every consumer of `github.ts`

**Estimated Complexity**: Medium
**Risk Level**: Medium (maintenance burden scales with forge count)

### Approach 3: Guard Clauses at Each Call Site

**Description**: Add `isGitHubRepo()` checks before every `gh` CLI invocation. If not GitHub, skip and return default. No abstraction.

**Pros**:
- Smallest initial diff
- No new abstractions

**Cons**:
- Scattered conditionals, hard to maintain
- No path to supporting other forges
- Violates DRY

**Estimated Complexity**: Low
**Risk Level**: Medium (maintenance burden)

## Open Questions

### Critical (Blocks Progress)

- [x] Should forge detection be automatic or configured? **Decision: No auto-detection needed.** `gh` is the default for all concept commands. Projects that don't use GitHub override the concepts they need in `af-config.json`. No remote URL inspection required.
- [x] Should the abstraction be hard-coded adapters or external commands? **Decision: External concept commands.** Follows UNIX philosophy, enables community-driven forge support without codev code changes.

### Important (Affects Design)

- [x] Should concept commands receive arguments via environment variables, command-line arguments, or stdin? **Decision: Environment variables.** Codev sets them explicitly for each invocation. Avoids shell escaping, language-agnostic, consistent.
- [x] Should `codev adopt` scaffold a commented-out `forge` section in `af-config.json` when no GitHub remote is detected? **Decision: No.** Reserve examples for user-level documentation only.
- [x] How should `af spawn <issueID>` work when `issue-view` is not configured? **Decision: Fail with a helpful error.** An issue ID is required. The error message should suggest that the `issue-view` concept command needs to be configured in `af-config.json`, or removed to fall back to the `gh` default.
- [x] Should codev ship community concept command packages (e.g., `@codev/forge-gitlab`)? **Decision: No.** Leave to the community. User documentation should include one or two worked examples.

### Nice-to-Know (Optimization)

- [x] Should concept command results be cached (with TTL)? **Decision: No new caching.** Reuse existing caching infrastructure if present (e.g., overview.ts 30-second cache). Do not add new caching framework. Individual commands can handle their own caching internally if expensive.
- [x] Should there be a `codev doctor` check? **Decision: Yes.** Validate that configured concept command executables exist and are executable by the current user.
- [x] Should concept commands support a `--capabilities` flag? **Decision: No.** Programs either adhere to the JSON contract or they don't. Optional parts of a concept should be optional fields in the JSON output.

## Performance Requirements

- **Concept command exec**: Reuse the same timeout logic (if any) already used for invoking `gh`. Do not introduce new timeout infrastructure.
- **No new caching**: Individual concept commands are responsible for their own caching if expensive. Codev does not cache concept command results beyond what existing code already does (e.g., overview.ts 30-second cache).
- **No regression for GitHub users**: Default `gh` commands have identical performance to current direct invocations (same process exec, same JSON parsing).

## Security Considerations

- Concept commands execute with the same privileges as the user running codev — no escalation beyond what `gh` already had
- `af-config.json` forge overrides could point to arbitrary executables — same trust model as porch check overrides (spec 550) and shell command overrides
- **Shell execution surface**: Concept commands are executed via `sh -c` to support pipes and variable expansion. Environment variables set by codev (e.g., `CODEV_COMMENT_BODY`) could contain shell metacharacters. This is the same trust model as git hooks — the user controls both the config and the environment. Users writing concept commands should follow standard shell safety practices (quoting variables). Codev does not sanitize env var values, as doing so would break legitimate use cases.
- Disabling concepts (setting to `null`) could bypass review workflows — this is a team policy concern, mitigated by logging when concepts are disabled
- No credentials are stored or managed by codev — each concept command handles its own authentication (just as `gh` handles GitHub auth today)
- Concept command stdout is parsed as JSON — malformed output is rejected, not eval'd

## Test Scenarios

### Functional Tests

1. **GitHub repo, no overrides**: Default `gh` concept commands selected, all existing behavior unchanged
2. **Non-GitHub repo, no overrides**: `gh` defaults fail gracefully, features degrade to empty state
3. **Non-GitHub repo with forge overrides**: Custom concept commands called, output parsed correctly
4. **Partial overrides**: Some concepts overridden (e.g., `pr-list`), others left at defaults or disabled
5. **Concept set to `null`**: Operation skipped entirely, logged, no error
6. **Builder spawn with `issue-view` unavailable**: Fails with a helpful error explaining that the `issue-view` concept command needs to be configured in `af-config.json` (consistent with Q&A decision). Builder spawn requires issue context.
7. **`porch done` with custom `pr-exists`**: Overridden command determines phase completion
8. **Work view with partial concepts**: Shows data from available concepts, empty panels for unavailable ones
9. **Analytics with partial concepts**: Shows git-derived metrics when PR concepts unavailable
10. **Malformed concept command output**: Invalid JSON rejected gracefully, treated as unavailable
11. **Non-numeric issue identifiers**: Concept commands work correctly with opaque string IDs (e.g., `PROJ-123` Jira-style, `group/project#42` GitLab-style). Any printable characters are valid in identifiers.

### Non-Functional Tests

1. **Performance**: Concept command exec adds <100ms per invocation; caching reduces repeated calls
2. **Error handling**: Concept command crashes (segfault, timeout) treated as unavailable, not fatal
3. **Backward compatibility**: Zero-config GitHub repos produce identical results to current implementation

## Dependencies

- **Internal**: `lib/github.ts` (to be refactored into concept command dispatch), `lib/team-github.ts` (team-activity and on-it-timestamps concepts), `agent-farm/utils/config.ts` (af-config.json loading — add `forge` section), all consumers of github.ts functions
- **External**: None — no new runtime dependencies. `gh` CLI becomes the default concept command implementation rather than a hard requirement.

## References

- GitHub Issue #589: https://github.com/cluesmith/codev/issues/589
- Existing `lib/github.ts` graceful degradation pattern
- `af-config.json` override pattern (established in spec 550)
- Waleed's comment on issue: "we are pretty tightly coupled to Github"

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| JSON output contracts drift across codev versions | Medium | Medium | Version the contracts; document in a stable reference file; validate with JSON schema |
| Process exec latency is noticeable vs. current in-process calls | Low | Low | Current `gh` calls already exec a process; no regression. Cache results with TTL. |
| Complex concepts (team-activity, on-it-timestamps) are hard to reimplement for other forges | Medium | Low | These are optional/nice-to-have; projects can set them to `null` without losing core functionality |
| Consumers in codev source bypass concept commands and call `gh` directly | Medium | Low | Code review discipline during codev development to ensure new forge operations go through concept command dispatch. Users are free to configure any command including `gh` directly — the safety check is valid JSON matching the contract. |
| Large refactor scope causes regressions | Medium | High | Phased implementation: concept command infrastructure first, then migrate one concept at a time |
| Community concept command packages have inconsistent quality | Low | Low | Document contracts clearly; provide a test harness for validating concept command output |

## Expert Consultation

*Pending — to be conducted after draft review.*

## Approval

- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [ ] Expert AI Consultation Complete

## Notes

This spec replaces direct GitHub coupling with a **concept command architecture** inspired by git hooks and the UNIX philosophy. The key insight: forge operations are not GitHub-specific concepts — issues, PRs, comments, and reviews exist across all forges. By defining stable JSON contracts and delegating to external commands, codev becomes forge-agnostic without needing to know about any specific forge.

The existing graceful degradation in `github.ts` (all functions return `null` on failure) validates this approach — codev already tolerates missing forge data. This spec formalizes that tolerance into an intentional, configurable system.

**Phasing note**: This is a large refactor best done incrementally. The plan should define a migration order that keeps the codebase functional at every step — likely starting with the concept command infrastructure and `af-config.json` loading, then migrating one concept at a time from direct `gh` calls to concept command dispatch.

---

## Amendments

This section tracks all TICK amendments to this specification. TICKs are lightweight changes that refine an existing spec rather than creating a new one.

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
