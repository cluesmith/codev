#!/bin/sh
# Forge concept: pr-list (Gitea via tea CLI)
#
# Normalize tea's PR shape to the GitHub-compatible shape codev expects
# (see PrListItem in codev/src/lib/forge-contracts.ts):
#   index            -> number (int)
#   created          -> createdAt
#   author (string)  -> author.login
#   reviewDecision   -> ""  (Gitea has no GitHub-equivalent review-decision summary)
#   body             -> ""  (`tea pulls list` exposes no body/description field;
#                            requesting `description` fails with
#                            `Error: invalid field 'description'`. The per-PR body
#                            is only reachable via
#                            `tea api repos/:owner/:repo/pulls/:index` — out of
#                            scope for the list overview.)
#   reviewRequests   -> []  (`pulls list` exposes no `reviewers` field, so
#                            requested reviewers are unreachable here. The VSCode
#                            sort silently skips the review-requested bucket when
#                            empty.)
#   isDraft          -> false (`pulls list` exposes no `draft` field.)
# The underlying Gitea API PR object carries `body`, `draft`, and
# `requested_reviewers`, but only the raw `tea api` passthrough can reach them.
exec tea pulls list --limit 200 \
  --fields index,title,state,author,url,created \
  --output json \
  | jq '[.[] | {
      number: (.index | tonumber),
      title,
      state,
      url,
      reviewDecision: "",
      body: "",
      createdAt: .created,
      author: {login: .author},
      reviewRequests: [],
      isDraft: false
    }]'
