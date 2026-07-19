#!/bin/sh
# Forge concept: recently-merged (Gitea via tea CLI)
# Output: JSON [{number, title, url, body, createdAt, mergedAt, headRefName}]
#         (MergedPrItem in forge-contracts.ts)
#
# `tea pulls list --fields …,head,description,merged` errors on the `description`
# field and emits `.head` as a string, so it can't populate `body` or
# `.head.ref`. Route through the raw REST passthrough instead, whose closed
# pulls carry `.merged`, `.merged_at`, nested `.head.ref`, and `.body`. Keep
# only merged pulls (closed-without-merge have `.merged == false`). `tea api`
# needs an explicit owner/repo in the path (unlike `tea pulls`, which
# auto-detects it from the local git remote), so resolve it here: honor
# CODEV_REPO when set, else derive owner/repo from origin's URL (handles https,
# ssh, and scp-style remotes, with or without a .git suffix).
REPO="${CODEV_REPO:-$(git remote get-url origin 2>/dev/null | sed -E -e 's#\.git$##' -e 's#.*[/:]([^/]+/[^/]+)$#\1#')}"
tea api "repos/${REPO}/pulls?state=closed&limit=200" \
  | jq '[.[] | select(.merged == true) | {
      number,
      title,
      url: (.html_url // .url),
      body: (.body // ""),
      createdAt: .created_at,
      mergedAt: .merged_at,
      headRefName: (.head.ref // "")
    }]'
