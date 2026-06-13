#!/bin/sh
# Forge concept: pr-list (GitLab via glab CLI — merge requests)
#
# Populate the two fields this concept must emit (PrListItem in
# forge-contracts.ts) from glab's real output:
#   reviewRequests <- [.reviewers[].username]   (glab exposes assigned reviewers)
#   isDraft        <- .draft                     (GitLab's draft/WIP flag)
# The rest of glab's output is passed through unchanged. (glab's base shape uses
# `iid`/`web_url`/`created_at`/`author.username` rather than the GitHub-style
# `number`/`url`/`createdAt`/`author.login`; normalizing that is a pre-existing
# concern outside this concept's two-field responsibility.)
exec glab mr list --output json \
  | jq '[.[] | . + {reviewRequests: [.reviewers[]?.username], isDraft: (.draft // false)}]'
