#!/bin/sh
# Forge concept: pr-list (GitHub via gh CLI)
# Output: JSON [{number, title, url, reviewDecision, body, createdAt, author,
#                reviewRequests, isDraft}]
#
# `reviewRequests` is normalized to a flat array of user logins. gh returns it
# as objects (users carry `login`; teams carry `slug`/`name` and no `login`), so
# `.login // empty` keeps user reviewers and drops team reviewers — matching the
# `reviewRequests: string[]` contract in PrListItem (forge-contracts.ts).
#
# Not `gh … | jq`: POSIX sh has no pipefail, so the caller would see jq's exit
# status and a rate-limited gh would look like a successful empty list (#1645).
# forge-executable: gh
out="$(gh pr list --json number,title,url,reviewDecision,body,createdAt,author,reviewRequests,isDraft)" || exit 1
printf '%s' "$out" | jq '[.[] | .reviewRequests = [.reviewRequests[].login // empty]]'
