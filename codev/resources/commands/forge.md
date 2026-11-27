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

`linear` and `jira` are **hybrid** providers: they serve the issue concepts, and every PR concept deliberately falls through to the `gh` default, because the repository itself still lives on GitHub. Only `team-activity`, `on-it-timestamps` and `overview-bundle` are disabled (see [Tower Overview](#tower-overview-overview-bundle)). A hybrid workspace therefore needs two logins, the tracker's and `gh`'s; `codev doctor` reports both.

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

### Merge Mechanics (read-only, used by `codev check`)

| Concept | Env Vars | Output | Description |
|---------|----------|--------|-------------|
| `commit-checks` | `CODEV_COMMIT_SHA` | JSON array `[{name, state, url?, workflow?}]` | Check results reported on one commit |
| `workflow-runs` | `CODEV_WORKFLOW`, `CODEV_BRANCH` | JSON array `[{headSha, status, conclusion, url, createdAt}]`, newest first | Runs of one workflow on one branch |

`commit-checks` normalizes every result to one `state` word: `pass`, `fail`, `pending`, `skipped`
or `neutral`. Skipped and neutral count as passed. The github script reads the commit's check
runs (the latest attempt for each name) and its legacy commit statuses:

- A check run that has not completed is `pending`.
- `success` is `pass`, `skipped` is `skipped`, and `neutral` is `neutral`.
- Every other conclusion is `fail`: `failure`, `cancelled`, `timed_out`, `action_required`,
  `stale` and `startup_failure`.
- A status of `success` is `pass`, `pending` is `pending`, and `failure` or `error` is `fail`.

An empty array means nothing reported on the commit. A failure exits non-zero; it is never
an empty array.

`pr-view` also carries optional fields that `codev check` reads. Consumers that do not know
them are unaffected.

| Field | Meaning | github | gitlab | gitea |
|---|---|---|---|---|
| `headRefOid` | full SHA of the PR head | `headRefOid` | `sha` | `head.sha` |
| `isDraft` | draft flag | `isDraft` | `draft` | `draft` |
| `mergeable` | `MERGEABLE` / `CONFLICTING` / `UNKNOWN` | `mergeable` | from `detailed_merge_status` | from `mergeable` |
| `mergeStateStatus` | merge state, GitHub's words (`CLEAN` = clean) | `mergeStateStatus` | `detailed_merge_status` (`mergeable` → `CLEAN`, others upper-cased) | — |
| `mergeCommit` | `{oid}` of the merge/squash commit, `null` until merged | `mergeCommit` | `merge_commit_sha` / `squash_commit_sha` | `merge_commit_sha` |
| `mergedAt` | merge time, `null` until merged | `mergedAt` | `merged_at` | `merged_at` |
| `reviewDecision` | `APPROVED` / `CHANGES_REQUESTED` / `REVIEW_REQUIRED` | `reviewDecision` | `null` | `null` |

A preset that cannot supply a field omits it (or sends `null` where the table says so), and
`codev check` then reports the dependent check as `not run`. The gitlab mappings follow
GitLab's documented merge-request API but are unverified against a live `glab`.

**Providers.** github implements both new concepts, and so do linear and jira, which use the
github default for every PR concept. gitlab and gitea disable both explicitly, so a
`codev check` there shows `not run: commit-checks unavailable on gitlab`, never a silent `gh`
call. Supply an override to enable them, e.g. `"commit-checks": "./scripts/my-ci-status.sh"`.

### Analytics & Team

| Concept | Env Vars | Output | Description |
|---------|----------|--------|-------------|
| `recently-closed` | `CODEV_SINCE_DATE` | JSON array | Recently closed issues |
| `recently-merged` | `CODEV_SINCE_DATE` | JSON array | Recently merged PRs |
| `on-it-timestamps` | `CODEV_ISSUE_NUMBERS`, `CODEV_GRAPHQL_QUERY`, `CODEV_REPO_OWNER`, `CODEV_REPO_NAME` | JSON | "On it" comment timestamps |
| `team-activity` | `CODEV_GRAPHQL_QUERY` | JSON | Batched team activity query |
| `user-identity` | — | plain text | Current user's handle |

### Tower Overview (`overview-bundle`)

| Concept | Env Vars | Output | Description |
|---------|----------|--------|-------------|
| `overview-bundle` | `CODEV_SINCE_DATE` | JSON object `{prs, issues, recentlyClosed, recentlyMerged}` | All four overview sections from one call |

Tower's overview (the dashboard's Work view, and VS Code's) shows four forge-backed sections. On
GitHub it fetches them by default with one `overview-bundle` call per workspace per refresh, in
place of four calls to `pr-list`, `issue-list`, `recently-closed` and `recently-merged`. The
github script sends one `gh api graphql` request. It sends a follow-up request only when a
section overflows its first page: more than 100 open issues, or more than 100 results in a 24 h
window.

**Input.** `CODEV_SINCE_DATE`, always set by Tower: the start of the two 24 h windows, as
`YYYY-MM-DDTHH:MM:SSZ` (UTC, seconds precision). The github script exits 2 without sending a
request when it is missing or malformed.

**Output.** On exit 0, one JSON object with exactly these four required keys:

| Key | Holds what this concept emits | github cap |
|-----|-------------------------------|------------|
| `prs` | `pr-list` | 30 |
| `issues` | `issue-list` | 200, newest first |
| `recentlyClosed` | `recently-closed` | 1,000 |
| `recentlyMerged` | `recently-merged` | 1,000 |

Each key holds an array under that concept's contract, or `null`, which means that section alone
could not be fetched. Extra top-level keys are ignored. Tower still filters both searches to the
last 24 hours.

- **A `null` section is a successful fetch.** It is cached with the rest and tried again on the
  next refresh. A `null` list shows `overview-bundle returned no PRs` (or `issues`). A `null`
  search leaves the recently-closed list empty, or drops the links from merged PRs to their
  issues. Any `null` section makes the overview report `forgeStatus: unavailable`. The github
  script returns `null` only for a 24 h search that failed on its own.
- **A non-zero exit fails the whole bundle.** The reason goes on stderr, where the rate limiter
  reads it. Malformed output is a whole-bundle failure too: not JSON, not an object, a key
  missing, or a section that is neither an array nor `null`. All four sections are then blank
  until the failure window passes or, after a rate limit, until the suspension lifts. A failed
  bundle is never retried as four calls.
- **Limits.** The call runs with a 60 s time limit and a 40 MiB output limit, twice and four
  times a single concept's 30 s and 10 MiB.
- **Cadence.** The bundle is one cache entry per workspace. Like the open lists, it refreshes
  every 180 s and on invalidation, at most once a minute. The two 24 h lists therefore refresh
  every 180 s, not every 600 s.

**When the bundle is used.** Configuration decides, never a runtime fallback. The overview uses
the bundle when both hold:

1. `overview-bundle` resolves to a command, that is, it is not disabled;
2. the project overrides `overview-bundle` itself, **or** none of `pr-list`, `issue-list`,
   `recently-closed` and `recently-merged` is overridden or disabled.

Otherwise the overview makes the four calls, each cached on its own as before. A project that
overrides `issue-list` therefore keeps its own `issue-list`. An `overview-bundle` override is the
exception: it supplies all four sections and **bypasses** every constituent override or disable,
and `codev doctor` says so. It also counts as an overridden issue concept, so Tower no longer
reports the provider's issue-id shape (`issueIdKind`).

**Providers.** gitlab, gitea, linear and jira disable `overview-bundle`, so their overview keeps
making the four calls. For linear and jira this is required for correctness: their issues come
from the tracker, and the github bundle would show GitHub's issues instead.

**Repositories with issues disabled.** On a GitHub repository with issues disabled, `gh issue
list` fails, so the four calls show "could not fetch issues" and `forgeStatus: unavailable`.
GraphQL answers with no issues instead. The bundle therefore shows an empty backlog and an empty
recently-closed list, with PRs intact, and `forgeStatus: ok`.

**`codev doctor`** lists `overview-bundle` with the other concepts and adds an `overview` line:
how this workspace's overview fetches, why, and the projected forge calls per hour per watched
workspace, idle and under constant invalidation. The reasons it gives are:

- `bundled`: 20 calls an hour idle, 60 under churn;
- `bundled (overview-bundle override; bypasses the issue-list override)`;
- `four calls: issue-list overridden` (or `disabled`): 52 and 132 when all four constituents run;
- `four calls: overview-bundle disabled`;
- `four calls: disabled by the gitlab preset`.

Constituent causes combine, e.g. `four calls: issue-list overridden, recently-merged disabled`.

**Overriding it on another forge.** An override pays off when your forge can answer all four
sections in fewer requests than four calls, typically with one GraphQL query. The sketch below
shows the contract using the commands the gitlab preset's four concepts already run. It is one
invocation but still four `glab` processes, and its searches refresh every 180 s instead of
600 s, so replace those commands with a single request where your forge allows one.

```json
{
  "forge": {
    "provider": "gitlab",
    "overview-bundle": "./scripts/forge/overview-bundle.sh"
  }
}
```

```sh
#!/bin/sh
# forge-executable: glab
# Exit non-zero only when the whole overview failed. A 24 h search that fails on its own
# becomes null. Output is staged to files: POSIX sh has no pipefail, so `glab … | jq` would
# turn a failed call into an empty success. The two searches below ignore CODEV_SINCE_DATE,
# as the gitlab preset's own do, and Tower filters them to the last 24 h; where your forge can
# filter by close or merge date, pass it CODEV_SINCE_DATE instead of over-fetching.
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT

glab mr list --output json > "$tmp/prs" || exit $?
glab issue list --per-page 200 --output json > "$tmp/issues" || exit $?
glab issue list --state closed --per-page 1000 --output json > "$tmp/closed" || echo null > "$tmp/closed"
glab mr list --state merged --per-page 1000 --output json > "$tmp/merged" || echo null > "$tmp/merged"

jq -n --slurpfile prs "$tmp/prs" --slurpfile issues "$tmp/issues" \
  --slurpfile closed "$tmp/closed" --slurpfile merged "$tmp/merged" '{
    prs: ($prs[0] | map(. + {reviewRequests: [.reviewers[]?.username], isDraft: (.draft // false)})),
    issues: $issues[0],
    recentlyClosed: $closed[0],
    recentlyMerged: $merged[0]
  }'
```

`codev doctor` then reports `bundled — 20 forge calls/h idle, 60 under constant invalidation`.

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

This maps all concepts to `glab` equivalents. Concepts without a GitLab equivalent (`team-activity`, `on-it-timestamps`) are automatically disabled, as are `commit-checks` and `workflow-runs`, which could not be verified against GitLab, and `overview-bundle`, so Tower's overview makes its four calls.

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

Some Gitea concepts (`pr-search`, `pr-diff`) are disabled by default since `tea` doesn't support them directly; `commit-checks` and `workflow-runs` are disabled because they could not be verified against a Gitea server, and `overview-bundle` is disabled as on every non-GitHub preset. You can provide custom scripts:

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
- **Issue-less spawns never look like keys.** A task, protocol-only, shell, or worktree spawn gets a random four-character id, and Codev never generates one shaped like a key (`Ab-3`), so it cannot collide with a real issue's worktree. The one residual case is a worktree spawned *before* this rule with such an id (about one in 450 of them): porch inside it, and the dashboard when the builder's database row is missing, can read it as issue `AB-3`. Clean it up with `afx cleanup` if you have one.
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

Forge Concepts (provider: gitlab)

  ✓ issue-view           preset  glab
  …
  ○ team-activity        disabled
  ○ on-it-timestamps     disabled
  ✓ pr-create            preset  glab
  ✓ pr-merge             override  glab
  …
  ○ overview-bundle      disabled
  - overview             four calls: disabled by the gitlab preset — 52 forge calls/h idle, 132 under constant invalidation
```

Each concept shows where its command comes from (`default`, `preset` or `override`) and the
executable it needs; a missing executable is a warning. The `overview` line is described under
[Tower Overview](#tower-overview-overview-bundle).

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
