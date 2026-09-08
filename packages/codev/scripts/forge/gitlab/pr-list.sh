#!/bin/sh
# forge-executable: glab
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
#
# The CLI runs into a variable rather than straight into the `jq` pipe (#1645):
# POSIX sh has no pipefail, so a pipeline reports jq's exit status (0) even when
# the CLI failed — a rate-limited or unauthenticated call then looks like a
# successful empty result, and its stderr, the only place the reason is named,
# is discarded. Tower's rate-limit suspension depends on that exit status.
MRS="$(glab mr list --output json)" || exit $?
printf '%s' "$MRS" | jq '[.[] | . + {reviewRequests: [.reviewers[]?.username], isDraft: (.draft // false)}]'
