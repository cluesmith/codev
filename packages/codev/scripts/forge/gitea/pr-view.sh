#!/bin/sh
# Forge concept: pr-view (Gitea via tea CLI)
# Input: CODEV_PR_NUMBER
# Output: JSON {title, body, state, author{login}, baseRefName, headRefName,
#               additions, deletions}  (see PrViewResult in forge-contracts.ts)
#
# `tea pulls view N --output json` returns a table header / empty list rather
# than the PR object, so route through the raw REST passthrough. `tea api`
# needs an explicit owner/repo in the path (unlike `tea pulls`, which
# auto-detects it from the local git remote), so resolve it here: honor
# CODEV_REPO when set, else derive owner/repo from origin's URL (handles
# https, ssh, and scp-style remotes, with or without a .git suffix).
REPO="${CODEV_REPO:-$(git remote get-url origin 2>/dev/null | sed -E -e 's#\.git$##' -e 's#.*[/:]([^/]+/[^/]+)$#\1#')}"
tea api "repos/${REPO}/pulls/${CODEV_PR_NUMBER}" | jq '{
  title,
  body: (.body // ""),
  state,
  author: {login: .user.login},
  baseRefName: .base.ref,
  headRefName: .head.ref,
  additions: (.additions // 0),
  deletions: (.deletions // 0)
}'
