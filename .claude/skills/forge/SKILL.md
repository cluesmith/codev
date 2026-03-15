# Forge Concept Commands

Forge concept commands decouple codev from direct `gh` CLI calls. Each GitHub operation is routed through a configurable external command.

## Concepts

| Concept | Env Vars | Description |
|---------|----------|-------------|
| `issue-view` | `CODEV_ISSUE_ID` | Fetch issue details (JSON) |
| `pr-list` | — | List open PRs (JSON array) |
| `issue-list` | — | List issues (JSON array) |
| `issue-comment` | `CODEV_ISSUE_ID`, `CODEV_COMMENT_BODY` | Post a comment on an issue |
| `pr-exists` | `CODEV_BRANCH_NAME` | Check if a PR exists for a branch |
| `recently-closed` | `CODEV_SINCE_DATE` (optional) | List recently closed issues |
| `recently-merged` | `CODEV_SINCE_DATE` (optional) | List recently merged PRs |
| `user-identity` | — | Get current user's handle (plain text) |
| `team-activity` | `CODEV_GRAPHQL_QUERY` | Run a batched GraphQL query |
| `on-it-timestamps` | `CODEV_ISSUE_NUMBERS`, `CODEV_GRAPHQL_QUERY`, `CODEV_REPO_OWNER`, `CODEV_REPO_NAME` | Get "on it" comment timestamps |
| `pr-merge` | `CODEV_PR_NUMBER` | Merge a PR |
| `pr-search` | `CODEV_SEARCH_QUERY` | Search PRs (JSON array) |
| `pr-view` | `CODEV_PR_NUMBER`, `CODEV_INCLUDE_COMMENTS` (optional) | View PR details (JSON or text) |
| `pr-diff` | `CODEV_PR_NUMBER`, `CODEV_DIFF_NAME_ONLY` (optional) | Get PR diff |
| `gh-auth-status` | — | Check forge authentication status |

## Configuration

In `af-config.json`:

```json
{
  "forge": {
    "provider": "gitlab",
    "issue-comment": "my-custom-script $CODEV_ISSUE_ID"
  }
}
```

### Resolution order
1. Manual concept override in `forge` section
2. Provider preset (if `provider` is set)
3. Default (GitHub via `gh` CLI)

### Providers

Built-in presets: `github` (default), `gitlab` (via `glab`), `gitea` (via `tea`).

**Note:** Non-GitHub presets are best-effort. Output schemas may differ from GitHub's JSON contracts. Non-conforming JSON returns `null` — consumers handle this gracefully. Override individual concepts if a preset doesn't match your CLI version.

### Disabling concepts

Set a concept to `null` to disable it:
```json
{
  "forge": {
    "team-activity": null
  }
}
```

## Validation

Run `codev doctor` to see forge concept status, provider, and validation results.

## Code

- **Dispatcher**: `packages/codev/src/lib/forge.ts`
- **Contracts**: `packages/codev/src/lib/forge-contracts.ts`
- **Spec**: `codev/specs/589-non-github-repository-support.md`
