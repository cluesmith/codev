#!/bin/sh
# Forge concept: issue-view (Gitea via tea CLI)
# forge-executable: tea
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
# comments array is fetched separately and merged in. A failed comments fetch
# degrades to [], but warns on stderr so the degraded path is distinguishable
# from a genuinely uncommented issue (stdout stays pure JSON — it's parsed by
# forge.ts). `tea api` exits 0 on HTTP errors and prints the error BODY, so the
# degrade check tests for an actual JSON array rather than only for a blank
# response — an error OBJECT reached `--argjson` and blew up with a raw jq
# parse/iteration error instead of the warned [] degrade.
#
# SHAPE VALIDATION. Same exit-0-on-error problem for the issue itself: an error
# body normalized into an all-null IssueViewResult whose `url` was the error
# body's own `url`. Required fields are type-checked before normalizing and
# anything else is a hard failure carrying the server's message on stderr.
. "$(dirname "$0")/_lib.sh"
REPO="$(gitea_repo)" || exit 1
# Fetch and validate the issue BEFORE its comments, so a bad issue id reports
# only its own error instead of preceding it with a comments-degrade warning
# about an issue that doesn't exist — and doesn't spend a request on it.
# Capture before piping: POSIX sh has no pipefail, so `tea api … | jq` would
# report jq's exit status rather than a failed fetch.
ISSUE="$(tea api "repos/${REPO}/issues/${CODEV_ISSUE_ID}")" || exit 1
# jq given empty input emits nothing and exits 0, so an empty body at exit 0
# would slip past the validator below rather than failing.
if [ -z "$ISSUE" ]; then
  echo "gitea forge: empty \`tea api\` response for issue ${CODEV_ISSUE_ID}" >&2
  exit 1
fi
printf '%s' "$ISSUE" | jq -e '
  if (type == "object")
     and ((.title | type) == "string")
     and ((.state | type) == "string")
     and (((.html_url // .url) | type) == "string")
     and ((.number | type) == "number")
  then .
  else
    ("gitea forge: unexpected `tea api` response for issue "
      + (env.CODEV_ISSUE_ID // "?") + ": "
      + (if type == "object" then (.message // tostring) else tostring end)
      + "\n") | halt_error(1)
  end' >/dev/null || exit 1

COMMENTS_JSON="$(tea api "repos/${REPO}/issues/${CODEV_ISSUE_ID}/comments" 2>/dev/null)"
if [ -z "$COMMENTS_JSON" ] || ! printf '%s' "$COMMENTS_JSON" | jq -e 'type == "array"' >/dev/null 2>&1; then
  echo "gitea forge: comments fetch failed for issue ${CODEV_ISSUE_ID}; reporting 0 comments" >&2
  COMMENTS_JSON="[]"
fi

printf '%s' "$ISSUE" | jq --argjson comments "$COMMENTS_JSON" '{
      title,
      body: (.body // ""),
      state,
      url: (.html_url // .url),
      # The array itself is validated above; its ELEMENTS are whatever the
      # server sent, so each field is defaulted to the type the contract
      # declares rather than emitting nulls into IssueViewResult.comments.
      comments: [ $comments[] | {
        body: (if (.body | type) == "string" then .body else "" end),
        createdAt: (if (.created_at | type) == "string" then .created_at else "" end),
        author: {login: (if (.user.login | type) == "string" then .user.login else "" end)}
      } ]
    }'
