#!/bin/sh
# forge-executable: tea
# Forge concept: issue-list (Gitea via tea CLI)
#
# tea's default JSON output uses fields that don't match the GitHub-compatible
# shape codev's overview expects (see codev/src/lib/forge-contracts.ts).
# Normalize via jq so the same overview code path works for both forges:
#   index           -> number (int)
#   created         -> createdAt
#   author (string) -> author.login
#   labels    (CSV) -> labels[].name
#   assignees (CSV) -> assignees[].login
#
# The CLI runs into a variable rather than straight into the `jq` pipe (#1645):
# POSIX sh has no pipefail, so a pipeline reports jq's exit status (0) even when
# the CLI failed — a rate-limited or unauthenticated call then looks like a
# successful empty result, and its stderr, the only place the reason is named,
# is discarded. Tower's rate-limit suspension depends on that exit status.
ISSUES="$(tea issues list --limit 200 \
  --fields index,title,state,author,url,created,labels,assignees \
  --output json)" || exit $?
printf '%s' "$ISSUES" | jq '[.[] | {
      number: (.index | tonumber),
      title,
      state,
      url,
      createdAt: .created,
      author: {login: .author},
      labels: (if (.labels // "") == "" then []
               else (.labels | split(",") | map({name: ltrimstr(" ")})) end),
      assignees: (if (.assignees // "") == "" then []
                  else (.assignees | split(",") | map({login: ltrimstr(" ")})) end)
    }]'
