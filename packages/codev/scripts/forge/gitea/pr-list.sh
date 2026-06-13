#!/bin/sh
# Forge concept: pr-list (Gitea via tea CLI)
#
# Normalize tea's PR shape to the GitHub-compatible shape codev expects
# (see PrListItem in codev/src/lib/forge-contracts.ts):
#   index            -> number (int)
#   description      -> body
#   created          -> createdAt
#   author (string)  -> author.login
#   reviewDecision   -> ""  (Gitea has no GitHub-equivalent review-decision summary)
#   reviewRequests   -> []  (verified against tea 0.14.1: `pulls list` exposes
#                            no `reviewers` field, and its JSON output is limited
#                            to the selectable `--fields`, so requested reviewers
#                            are unreachable here. The VSCode sort silently skips
#                            the review-requested bucket when empty.)
#   isDraft          -> false (verified: tea 0.14.1 `pulls list` exposes no
#                              `draft` field among its selectable `--fields`.)
# The underlying Gitea API PR object does carry `draft` and `requested_reviewers`,
# but only the raw `tea api` passthrough can reach them — populating these two
# fields for Gitea would mean reworking this concept onto `tea api`, which is a
# separate, larger change than #787's scope.
exec tea pulls list --limit 200 \
  --fields index,title,state,author,url,created,description \
  --output json \
  | jq '[.[] | {
      number: (.index | tonumber),
      title,
      state,
      url,
      reviewDecision: "",
      body: (.description // ""),
      createdAt: .created,
      author: {login: .author},
      reviewRequests: [],
      isDraft: false
    }]'
