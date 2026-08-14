#!/bin/sh
# Forge concept: pr-create (Gitea/Forgejo via tea CLI)
# forge-executable: tea
#
# Input:  CODEV_PR_TITLE (required)
#         CODEV_PR_BODY  (required, may be empty)
#         CODEV_PR_BASE, CODEV_PR_HEAD, CODEV_PR_REPO, CODEV_PR_DRAFT (optional)
#         CODEV_PR_LOGIN (optional, gitea-only: tea's --login, for multi-login hosts)
# Output: {"number": <int>, "url": "<web url>"}
#
# `tea pulls create` takes the body as --description (not --body) and prints a
# rendered, line-wrapped, ANSI-decorated view of the new PR — not something to
# parse. Its whole output is sent to stderr and the created PR is then looked up
# by head branch via `tea pulls list`, whose `--output json` carries `index`,
# `url` (the browser URL) and `head` (a plain branch-name string).
#
# Verified against tea 0.14.2 + Forgejo: with a single configured login and an
# explicit --head, `tea pulls create` neither prompts nor needs --repo/--login
# (it autodetects from the git remote). Both are still forwarded when set, for
# multi-login hosts and for the tea 0.11.x autodetect prompt (#1146).
set -e

if [ -z "$CODEV_PR_TITLE" ]; then
  echo "pr-create: CODEV_PR_TITLE is required" >&2
  exit 2
fi

# An empty body is allowed; an *absent* one is not. Without this, forgetting the
# variable opens a PR with no body at exit 0 — the silent failure #1455 is about.
if [ -z "${CODEV_PR_BODY+x}" ]; then
  echo "pr-create: CODEV_PR_BODY is required (set it to \"\" for an empty body)" >&2
  exit 2
fi

head=$CODEV_PR_HEAD
if [ -z "$head" ]; then
  head=$(git rev-parse --abbrev-ref HEAD)
fi

set -- --title "$CODEV_PR_TITLE" --description "$CODEV_PR_BODY" --head "$head"
if [ -n "$CODEV_PR_BASE" ]; then set -- "$@" --base "$CODEV_PR_BASE"; fi
if [ -n "$CODEV_PR_REPO" ]; then set -- "$@" --repo "$CODEV_PR_REPO"; fi
if [ -n "$CODEV_PR_LOGIN" ]; then set -- "$@" --login "$CODEV_PR_LOGIN"; fi
if [ "$CODEV_PR_DRAFT" = "1" ]; then set -- "$@" --draft; fi

tea pulls create "$@" >&2

# Look the PR up by head branch. A cross-repo head is "<user>:<branch>" on the
# way in but lists as the bare branch name, so match either form. --limit 200
# matches the other gitea scripts: on tea's default page size a busy repo could
# push the just-created PR off the list, and this would report a failure for a
# PR that exists.
set -- --state open --limit 200 --fields index,url,head --output json
if [ -n "$CODEV_PR_REPO" ]; then set -- "$@" --repo "$CODEV_PR_REPO"; fi
if [ -n "$CODEV_PR_LOGIN" ]; then set -- "$@" --login "$CODEV_PR_LOGIN"; fi

# `.head` is a plain branch string on tea 0.14.2, but sibling scripts were written
# against an object with `.ref` — accept either rather than risk a lookup miss,
# which would report failure for a PR that exists and invite a duplicate retry.
result=$(tea pulls list "$@" | jq -c --arg head "${head#*:}" '
  [ .[] | select(((.head | if type == "object" then .ref else . end) | sub("^[^:]*:"; "")) == $head) ]
  | max_by(.index | tonumber)
  | if . == null then null else {number: (.index | tonumber), url} end')

if [ -z "$result" ] || [ "$result" = "null" ]; then
  echo "pr-create: created the PR but could not find an open pull for head '$head'" >&2
  exit 1
fi

printf '%s\n' "$result"
