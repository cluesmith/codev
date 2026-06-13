#!/bin/sh
# Forge concept: pr-list (GitHub via gh CLI)
# Output: JSON [{number, title, url, reviewDecision, body, createdAt, author,
#                reviewRequests, isDraft}]
#
# `reviewRequests` is normalized to a flat array of user logins. gh returns it
# as objects (users carry `login`; teams carry `slug`/`name` and no `login`), so
# `.login // empty` keeps user reviewers and drops team reviewers — matching the
# `reviewRequests: string[]` contract in PrListItem (forge-contracts.ts).
exec gh pr list --json number,title,url,reviewDecision,body,createdAt,author,reviewRequests,isDraft \
  | jq '[.[] | .reviewRequests = [.reviewRequests[].login // empty]]'
