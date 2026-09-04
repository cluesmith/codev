#!/bin/sh
# Forge concept: pr-view (Gitea via tea CLI)
# forge-executable: tea
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
#
# SHAPE VALIDATION. `tea api` exits 0 on an HTTP error and prints the error
# BODY, e.g. {"message":"pull does not exist [index: 42]","url":"…/swagger"}.
# Normalizing that unchecked produced a structurally valid, entirely wrong
# contract object at exit 0 — every field null except `url`, which took the
# error body's own `url` (the swagger link) and shipped it to callers as the
# PR's browser page. Required fields are type-checked first and anything else
# is a hard failure carrying the server's message on stderr.
. "$(dirname "$0")/_lib.sh"
REPO="$(gitea_repo)" || exit 1
# Capture before piping: in POSIX sh (no pipefail) a `tea api … | jq` pipeline
# reports jq's exit status, so a failed fetch would surface as jq's exit-0 on
# empty stdin rather than an error.
PR="$(tea api "repos/${REPO}/pulls/${CODEV_PR_NUMBER}")" || exit 1
# An empty body at exit 0 would give jq nothing to work on: it emits no output
# and exits 0, so the script would "succeed" with empty stdout instead of
# failing. The validator below never runs on an empty response, so guard here.
if [ -z "$PR" ]; then
  echo "gitea forge: empty \`tea api\` response for pull ${CODEV_PR_NUMBER}" >&2
  exit 1
fi
printf '%s' "$PR" | jq '
  if (type == "object")
     and ((.number | type) == "number")
     and ((.title | type) == "string")
     and ((.state | type) == "string")
     and ((.user.login | type) == "string")
     and ((.base.ref | type) == "string")
     and ((.head.ref | type) == "string")
  then .
  else
    ("gitea forge: unexpected `tea api` response for pull "
      + (env.CODEV_PR_NUMBER // "?") + ": "
      + (if type == "object" then (.message // tostring) else tostring end)
      + "\n") | halt_error(1)
  end
  | {
  title,
  body: (.body // ""),
  state,
  url: (.html_url // .url),
  author: {login: .user.login},
  baseRefName: .base.ref,
  headRefName: .head.ref,
  # Type-checked, not just defaulted: the contract types these as numbers, and
  # a non-numeric value here would be passed straight through.
  additions: (if (.additions | type) == "number" then .additions else 0 end),
  deletions: (if (.deletions | type) == "number" then .deletions else 0 end)
}'
