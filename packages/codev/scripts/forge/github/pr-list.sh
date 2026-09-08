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
# gh runs into a variable rather than straight into the pipe (#1645): piping
# would hand the caller jq's exit status, so a rate-limited `gh` looked like a
# successful empty result and its stderr — the only place the rate limit is
# named — was thrown away.
out=$(gh pr list --json number,title,url,reviewDecision,body,createdAt,author,reviewRequests,isDraft) || exit $?
printf '%s' "$out" | jq '[.[] | .reviewRequests = [.reviewRequests[].login // empty]]'
