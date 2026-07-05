#!/bin/sh
# Forge concept: pr-exists (Gitea via tea CLI)
# Returns true when an open or merged pull exists for the current branch.
#
# In `tea pulls list --output json`, `head` is the branch-name STRING (not a
# {ref} object), and a merged pull is reported as state="merged" (the CLI list
# output has no `.merged` boolean). `--state all` includes closed pulls;
# `--limit` is required because the default page size (30) can miss the branch.
tea pulls list --state all --limit 200 --fields index,head,state --output json \
  | jq --arg b "$CODEV_BRANCH_NAME" \
      '[.[] | select(.head == $b and (.state == "open" or .state == "merged"))] | length > 0'
