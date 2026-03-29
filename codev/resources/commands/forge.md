# Forge Concept Commands

Codev uses **forge concept commands** to interact with your repository hosting platform. By default, all concepts use the GitHub CLI (`gh`). Projects using GitLab, Gitea, or other forges can override these commands.

## Quick Start

### Using a Provider Preset

Add to `.codev/config.json`:

```json
{
  "forge": {
    "provider": "gitlab"
  }
}
```

Available providers: `github` (default), `gitlab` (uses `glab` CLI), `gitea` (uses `tea` CLI).

> **Note:** Non-GitHub presets are best-effort. Their CLI tools may produce output schemas that differ from GitHub's JSON contracts. Codev handles this gracefully — concepts that return non-conforming JSON are treated as unavailable (null). If a preset command doesn't work correctly for your setup, override the individual concept with a command that produces the expected output.

### Overriding Individual Concepts

```json
{
  "forge": {
    "issue-view": "glab issue view \"$CODEV_ISSUE_ID\" --output json",
    "pr-merge": "glab mr merge \"$CODEV_PR_NUMBER\" --yes"
  }
}
```

### Combining Provider + Overrides

Manual overrides take precedence over the provider preset:

```json
{
  "forge": {
    "provider": "gitlab",
    "issue-comment": "my-custom-comment-script $CODEV_ISSUE_ID \"$CODEV_COMMENT_BODY\""
  }
}
```

Resolution order: manual override > provider preset > default (github).

### Disabling Concepts

Set a concept to `null` to disable it. The feature that uses it will gracefully degrade:

```json
{
  "forge": {
    "team-activity": null,
    "on-it-timestamps": null
  }
}
```

## Concepts Reference

### Core Issue/PR Operations

| Concept | Env Vars | Output | Description |
|---------|----------|--------|-------------|
| `issue-view` | `CODEV_ISSUE_ID` | JSON | Fetch issue details |
| `pr-list` | — | JSON array | List open PRs |
| `issue-list` | — | JSON array | List issues |
| `issue-comment` | `CODEV_ISSUE_ID`, `CODEV_COMMENT_BODY` | — | Post issue comment |
| `pr-exists` | `CODEV_BRANCH_NAME` | truthy/falsy | Check if PR exists for branch |
| `pr-merge` | `CODEV_PR_NUMBER` | — | Merge a PR |
| `pr-search` | `CODEV_SEARCH_QUERY` | JSON array | Search PRs |
| `pr-view` | `CODEV_PR_NUMBER`, `CODEV_INCLUDE_COMMENTS` | JSON or text | View PR details |
| `pr-diff` | `CODEV_PR_NUMBER`, `CODEV_DIFF_NAME_ONLY` | text | Get PR diff |

### Analytics & Team

| Concept | Env Vars | Output | Description |
|---------|----------|--------|-------------|
| `recently-closed` | `CODEV_SINCE_DATE` | JSON array | Recently closed issues |
| `recently-merged` | `CODEV_SINCE_DATE` | JSON array | Recently merged PRs |
| `on-it-timestamps` | `CODEV_ISSUE_NUMBERS`, `CODEV_GRAPHQL_QUERY`, `CODEV_REPO_OWNER`, `CODEV_REPO_NAME` | JSON | "On it" comment timestamps |
| `team-activity` | `CODEV_GRAPHQL_QUERY` | JSON | Batched team activity query |
| `user-identity` | — | plain text | Current user's handle |

### System

| Concept | Env Vars | Output | Description |
|---------|----------|--------|-------------|
| `auth-status` | — | text | Check forge authentication |

## Worked Examples

### GitLab with `glab`

```json
{
  "forge": {
    "provider": "gitlab"
  }
}
```

This maps all concepts to `glab` equivalents. Concepts without a GitLab equivalent (`team-activity`, `on-it-timestamps`) are automatically disabled.

To customize specific concepts:

```json
{
  "forge": {
    "provider": "gitlab",
    "pr-merge": "glab mr merge \"$CODEV_PR_NUMBER\" --squash --yes"
  }
}
```

### Gitea with `tea`

```json
{
  "forge": {
    "provider": "gitea"
  }
}
```

Some Gitea concepts (`pr-search`, `pr-diff`) are disabled by default since `tea` doesn't support them directly. You can provide custom scripts:

```json
{
  "forge": {
    "provider": "gitea",
    "pr-diff": "curl -s https://gitea.example.com/api/v1/repos/owner/repo/pulls/$CODEV_PR_NUMBER.diff"
  }
}
```

### Custom Forge (any platform)

For unsupported platforms, configure each concept individually:

```json
{
  "forge": {
    "issue-view": "./scripts/forge/issue-view.sh",
    "pr-list": "./scripts/forge/pr-list.sh",
    "issue-comment": null,
    "team-activity": null,
    "on-it-timestamps": null
  }
}
```

Each script receives `CODEV_*` environment variables and should output JSON to stdout.

## Validation

Run `codev doctor` to check forge configuration:

```
$ codev doctor

Forge Concepts (custom command overrides)
  ✓ Provider: gitlab
  ✓ Concept 'pr-merge' overridden: glab mr merge "$CODEV_PR_NUMBER" --squash --yes
  ○ Concept 'team-activity' is explicitly disabled
  ✓ All forge concepts valid
```

## Writing Custom Concept Commands

A concept command is any shell command that:
1. Reads `CODEV_*` environment variables for input
2. Outputs JSON to stdout (or plain text for `raw` concepts like `pr-diff`)
3. Exits 0 on success, non-zero on failure

Example script (`scripts/forge/issue-view.sh`):

```bash
#!/bin/bash
curl -s "https://forge.example.com/api/issues/$CODEV_ISSUE_ID" \
  -H "Authorization: Bearer $FORGE_TOKEN" \
  | jq '{title: .title, body: .description, state: .state}'
```
