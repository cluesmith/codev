#!/bin/sh
# Forge concept: pr-view (Gitea via tea CLI)
# Input: CODEV_PR_NUMBER
# Output: JSON {title, body, state, url, author{login}, baseRefName, headRefName,
#               additions, deletions}  (see PrViewResult in forge-contracts.ts)
#
# `tea pulls view N --output json` returns a table header / empty list rather
# than the PR object, so route through the raw REST passthrough. `tea api`
# needs an explicit owner/repo in the path (unlike `tea pulls`, which
# auto-detects it from the local git remote), so resolve it here: honor
# CODEV_REPO when set, else derive owner/repo from origin's URL (handles
# https, ssh, and scp-style remotes, with or without a .git suffix).
#
# `url` is the PR's browser page (`html_url`). Gitea's own `url` field is the
# API endpoint (would render raw JSON in a browser), so map `html_url` and fall
# back to `url` only if it's absent — the same choice PIR #1179 made when this
# concept still went through `tea pulls view`.
. "$(dirname "$0")/_lib.sh"
REPO="$(gitea_repo)" || exit 1
tea api "repos/${REPO}/pulls/${CODEV_PR_NUMBER}" | jq '{
  title,
  body: (.body // ""),
  state,
  url: (.html_url // .url),
  author: {login: .user.login},
  baseRefName: .base.ref,
  headRefName: .head.ref,
  additions: (.additions // 0),
  deletions: (.deletions // 0)
}'
