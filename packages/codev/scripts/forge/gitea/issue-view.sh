#!/bin/sh
# Forge concept: issue-view (Gitea via tea CLI)
# Input: CODEV_ISSUE_ID
# Output: JSON {title, body, state, url, comments[]}  (IssueViewResult)
#
# `tea issues view N --output json` returns a flattened single-element list
# (no body/html_url/url), so route through the raw REST passthrough. `tea api`
# needs an explicit owner/repo in the path (unlike `tea issues`, which
# auto-detects it from the local git remote), so resolve it here: honor
# CODEV_REPO when set, else derive owner/repo from origin's URL (handles
# https, ssh, and scp-style remotes, with or without a .git suffix).
#
# `url` is mapped to the issue's browser page (`html_url`); Gitea's own `url`
# is the API endpoint (would render raw JSON in a browser), so we fall back to
# it only if `html_url` is absent.
#
# Gitea's issue object reports `comments` as an integer count, not the array
# the contract requires (consumers call `.comments.filter(...)`), so the
# comments array is fetched separately and merged in. A failed/empty comments
# fetch degrades to [].
REPO="${CODEV_REPO:-$(git remote get-url origin 2>/dev/null | sed -E -e 's#\.git$##' -e 's#.*[/:]([^/]+/[^/]+)$#\1#')}"
COMMENTS_JSON="$(tea api "repos/${REPO}/issues/${CODEV_ISSUE_ID}/comments" 2>/dev/null)"
[ -n "$COMMENTS_JSON" ] || COMMENTS_JSON="[]"
tea api "repos/${REPO}/issues/${CODEV_ISSUE_ID}" \
  | jq --argjson comments "$COMMENTS_JSON" '{
      title,
      body: (.body // ""),
      state,
      url: (.html_url // .url),
      comments: [ $comments[] | {
        body: (.body // ""),
        createdAt: .created_at,
        author: {login: .user.login}
      } ]
    }'
