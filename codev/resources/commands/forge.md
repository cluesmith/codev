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

Available providers: `github` (default), `gitlab` (uses `glab` CLI), `gitea` (uses `tea` CLI), `linear` (uses the Linear API), `jira` (Jira Cloud, uses Atlassian's `acli` CLI).

`linear` and `jira` are **hybrid** providers: they serve the issue concepts, and every PR concept deliberately falls through to the `gh` default, because the repository itself still lives on GitHub. Only `team-activity` and `on-it-timestamps` are disabled. A hybrid workspace therefore needs two logins, the tracker's and `gh`'s; `codev doctor` reports both.

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
| `pr-create` | `CODEV_PR_TITLE`, `CODEV_PR_BODY`, `CODEV_PR_BASE`, `CODEV_PR_HEAD`, `CODEV_PR_REPO`, `CODEV_PR_DRAFT` | JSON `{number, url}` | Open a PR (title + body required — set the body to `""` for none; rest optional. Gitea also reads `CODEV_PR_LOGIN`) |
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
| `auth-status` | — | text | Check forge authentication (`codev doctor` reports it for `github`, `jira`, and `linear`) |

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

**`CODEV_REPO` means two different things.** For `repo-archive` it is an *input*: the
`owner/repo` of the foreign repository to download, supplied by the caller. For the Gitea
preset's read concepts (`pr-view`, `pr-list`, `pr-exists`, `issue-view`, `recently-merged`) it
is an *override*: `tea api` needs an explicit `owner/repo` in the endpoint path, and those
scripts default to deriving it from the `origin` remote, so `CODEV_REPO` only comes into play
when that derivation is wrong or unavailable (a worktree with no `origin`, or reading a
different repo than the checkout). The scripts fail fast with a message naming `CODEV_REPO`
rather than issuing a `repos//…` request. Exporting `CODEV_REPO` globally therefore retargets
every Gitea read at that repo — set it per invocation instead.

### Jira Cloud with `acli`

```json
{
  "forge": {
    "provider": "jira",
    "jira-site": "https://your-site.atlassian.net",
    "jira-project": "ENG"
  }
}
```

**Prerequisites.** Install Atlassian's CLI (`acli`, e.g. `brew tap atlassian/homebrew-acli && brew install acli`) and log in once with `acli jira auth login` (browser OAuth or an API token). `acli` owns the credential: Codev never reads, stores, or passes a Jira token. Use a standard user account; token login for service accounts is a known upstream limitation. The preset was verified against `acli` 1.3.39.

**Scope.** Jira **Cloud** only. Jira Data Center is not supported by this preset.

**Configuration keys.** Set these in `.codev/config.json` under `forge`, next to `provider` (see the example above):

| Key | Purpose |
|-----|---------|
| `jira-site` | Site for browser links (`https://<site>.atlassian.net`). Recommended: when unset, each script asks `acli` which site it is logged into, and `auth-status` cannot check that `acli` is logged into the right site. |
| `jira-project` | Project key that scopes issue lists, search, and recently closed. When unset, those concepts span every project the account can see. |

Codev hands each key to the preset scripts as an environment variable (`jira-site` → `CODEV_JIRA_SITE`, `jira-project` → `CODEV_JIRA_PROJECT`), the same way every concept receives its inputs. The names only matter if you write your own override script for a Jira concept.

**Behavior notes.**

- **Issue ids are work item keys** (`ENG-123`), end to end: `afx spawn ENG-123 --protocol bugfix`, worktrees and branches (`builder/bugfix-ENG-123`), porch state, and VS Code's Open Issue by ID. Keys are canonicalized to upper case.
- **Issue-less spawns never look like keys.** A task, protocol-only, shell, or worktree spawn gets a random four-character id, and Codev never generates one shaped like a key (`Ab-3`), so it cannot collide with a real issue's worktree. The one residual case is a worktree spawned *before* this rule with such an id (about one in 450 of them): porch run inside it, and the dashboard when the builder's database row is missing, can read it as issue `AB-3`. Clean it up with `afx cleanup` if you have one.
- **Open and closed follow the status *category*,** never status names, which differ per site: open is any category but Done, and closed is Done.
- **Comments are plain text.** Markdown is posted as written, not converted to Atlassian's rich-text format. Descriptions and comments read from Jira are flattened to plain text.
- **No created dates in the backlog.** `acli`'s search returns no date fields, so backlog items have no age; they are still ordered newest first.
- **Lists are capped at 100 items** (`issue-list`, `issue-search`; GitHub's cap is 200), because `acli` search takes about 5s per 100 items and forge commands time out at 30s. Set `jira-project` to keep the newest open items of one project within the cap.
- **No smart commits.** Codev does not rely on `Fix ENG-123` commit messages to transition issues. Closing the issue on merge stays a manual step, as on every forge.
- **PR linking.** Codev's views link a PR to its Jira issue from the protocol's own conventions: the bracketed commit tags (`[PIR #ENG-123]`, `[Bugfix #ENG-123]`, `[Spec ENG-123]`) and a closing keyword on a `#`-prefixed key (`Fixes #ENG-123`, `Fix #ENG-123: …`). On GitHub those keywords are inert for a Jira key: GitHub closes nothing in Jira. A bare `Closes ENG-123` without `#` is not linked.

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

`codev doctor` reports the executable each concept needs on `PATH`, inferred from the script's
first substantive command. A script that opens with `set -e` or an input guard should say so
explicitly instead:

```bash
#!/bin/sh
# forge-executable: tea
set -e
...
```
