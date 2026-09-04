#!/bin/sh
# Forge concept: recently-merged (Gitea via tea CLI)
# forge-executable: tea
# Input: CODEV_SINCE_DATE (optional, ISO-8601 timestamp)
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
#
# The closed-pulls list is paginated (Gitea caps a page at max_response_items,
# default 50), so on a busy repo the most-recent merges could push older ones
# past the first page — tea_api_paged walks every page (see _lib.sh).
#
# CODEV_SINCE_DATE BOUNDS THE WALK. This concept feeds a 24h analytics window,
# but the closed-pulls list is the repo's whole merge history: on an
# established repo an unbounded walk issues up to GITEA_MAX_PAGES sequential
# requests inside forge's 30s timeout, and a timeout yields `null` — a worse
# outcome for the dashboard than truncation was. When CODEV_SINCE_DATE is set
# we ask the server for update-time-descending order and stop at the first page
# that reaches back past the cutoff.
#
# The stop filter refuses to trust the sort blindly: it fires only when the
# page is ACTUALLY non-increasing in `updated_at` (proving the server honored
# `sort=recentupdate`) AND some item on it predates the cutoff. A server that
# ignores the parameter falls back to the full walk rather than silently
# dropping merges. `updated_at >= merged_at` always holds — a merge updates the
# PR — so nothing merged after the cutoff can sit beyond the first page whose
# update times have fallen behind it. Timestamps go through `gitea_epoch`
# because Gitea emits RFC3339 in the server's timezone, not necessarily `Z`.
. "$(dirname "$0")/_lib.sh"
REPO="$(gitea_repo)" || exit 1

if [ -n "$CODEV_SINCE_DATE" ]; then
  QUERY="state=closed&sort=recentupdate"
  STOP="${GITEA_JQ_LIB}"'
    [ .[] | (.updated_at | gitea_epoch) ] as $t
    | (env.CODEV_SINCE_DATE | gitea_epoch) as $since
    | ($since != null)
      and (($t | length) > 0)
      and ([ $t[] | . != null ] | all)
      and ([ range(($t | length) - 1) | $t[.] >= $t[.+ 1] ] | all)
      and (($t | min) < $since)
  '
else
  QUERY="state=closed"
  STOP=""
fi

# Capture the paginator's output before piping to jq: in POSIX sh (no
# pipefail), a `cmd | jq` pipeline reports jq's exit status (0) even when
# `cmd` failed mid-walk, which would silently truncate the list instead of
# surfacing the error.
PULLS="$(tea_api_paged "repos/${REPO}/pulls" "$QUERY" "$STOP")" || exit 1
printf '%s' "$PULLS" | jq "${GITEA_JQ_LIB}"'
    (env.CODEV_SINCE_DATE | gitea_epoch) as $since
    | [ .[]
      | select(.merged == true)
      # Drop merges older than the cutoff. An unparseable/absent timestamp on
      # either side keeps the item — the caller filters the window again, so
      # over-reporting is harmless where dropping a real merge is not.
      | select($since == null
               or ((.merged_at | gitea_epoch) as $m | $m == null or $m >= $since))
      | {
      number,
      title,
      url: (.html_url // .url),
      body: (.body // ""),
      createdAt: .created_at,
      mergedAt: .merged_at,
      headRefName: (.head.ref // "")
    }]'
