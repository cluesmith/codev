#!/bin/sh
# forge-executable: tea
# Forge concept: recently-closed (Gitea via tea CLI)
#
# Normalize to GitHub-compatible shape (see IssueListItem in forge-contracts.ts).
# Gitea exposes no separate `closed_at` field on issue list output, so we map
# `updated` -> `closedAt`. For issues closed without subsequent edits this is
# exactly the close time; for issues edited after close it overestimates, which
# is acceptable for the "recently closed" overview filter.
#
# The CLI runs into a variable rather than straight into the `jq` pipe (#1645):
# POSIX sh has no pipefail, so a pipeline reports jq's exit status (0) even when
# the CLI failed — a rate-limited or unauthenticated call then looks like a
# successful empty result, and its stderr, the only place the reason is named,
# is discarded. Tower's rate-limit suspension depends on that exit status.
ISSUES="$(tea issues list --state closed --limit 1000 \
  --fields index,title,state,author,url,created,updated,labels \
  --output json)" || exit $?
printf '%s' "$ISSUES" | jq '[.[] | {
      number: (.index | tonumber),
      title,
      state,
      url,
      createdAt: .created,
      closedAt: .updated,
      labels: (if (.labels // "") == "" then []
               else (.labels | split(",") | map({name: ltrimstr(" ")})) end)
    }]'
