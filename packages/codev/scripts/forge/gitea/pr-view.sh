#!/bin/sh
# Forge concept: pr-view (Gitea via tea CLI)
#
# `tea pulls view` renders a list-style table (an empty JSON array under
# --output json) and cannot produce the single-PR PrViewResult shape (see
# forge-contracts.ts). Use the REST API passthrough, which returns the full
# Gitea PR object including additions/deletions and head/base refs.
#
# `tea api` requires an explicit repos/:owner/:repo path (there is no
# {owner}/{repo} substitution like gh's). codev passes CODEV_REPO to some
# concepts (e.g. repo-archive) but not pr-view, so fall back to deriving
# owner/repo from the origin remote (handles https and scp-like SSH URLs).
REPO="${CODEV_REPO:-$(git config --get remote.origin.url \
  | sed -e 's#\.git$##' -e 's#^[a-z][a-z0-9+.-]*://[^/]*/##' -e 's#^[^/@]*@[^:]*:##')}"

tea api "repos/${REPO}/pulls/${CODEV_PR_NUMBER}" \
  | jq '{
      title,
      body: (.body // ""),
      state,
      author: {login: .user.login},
      baseRefName: .base.ref,
      headRefName: .head.ref,
      additions,
      deletions
    }'
