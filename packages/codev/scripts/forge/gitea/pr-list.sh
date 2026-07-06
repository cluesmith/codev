#!/bin/sh
# Forge concept: pr-list (Gitea via tea CLI) — open pulls
# Output: JSON [{number, title, url, reviewDecision, body, createdAt, author,
#                reviewRequests, isDraft}]  (PrListItem in forge-contracts.ts)
#
# `tea pulls list --fields …,description` errors ("invalid field 'description'")
# and its flattened output can't carry a PR body, draft flag, or requested
# reviewers. Route through the raw REST passthrough instead, whose PR objects
# expose all of them. `tea api` needs an explicit owner/repo in the path (unlike
# `tea pulls`, which auto-detects it from the local git remote), so resolve it
# here: honor CODEV_REPO when set, else derive owner/repo from origin's URL
# (handles https, ssh, and scp-style remotes, with or without a .git suffix).
#
# Field mapping:
#   .number                       -> number (already an int in the REST shape)
#   .html_url                     -> url (browser page; Gitea `.url` is the API endpoint)
#   .body                         -> body
#   .created_at                   -> createdAt
#   .user.login                   -> author.login
#   .requested_reviewers[].login  -> reviewRequests (user logins; teams have no login → dropped)
#   .draft                        -> isDraft
#   reviewDecision                -> ""  (Gitea has no GitHub-equivalent review-decision summary)
REPO="${CODEV_REPO:-$(git remote get-url origin 2>/dev/null | sed -E -e 's#\.git$##' -e 's#.*[/:]([^/]+/[^/]+)$#\1#')}"
tea api "repos/${REPO}/pulls?state=open&limit=200" \
  | jq '[.[] | {
      number,
      title,
      url: (.html_url // .url),
      reviewDecision: "",
      body: (.body // ""),
      createdAt: .created_at,
      author: {login: .user.login},
      reviewRequests: [ (.requested_reviewers // [])[] | .login // empty ],
      isDraft: (.draft // false)
    }]'
