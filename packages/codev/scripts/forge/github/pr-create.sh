#!/bin/sh
# Forge concept: pr-create (GitHub via gh CLI)
# forge-executable: gh
#
# Input:  CODEV_PR_TITLE (required)
#         CODEV_PR_BODY  (required, may be empty)
#         CODEV_PR_BASE, CODEV_PR_HEAD, CODEV_PR_REPO, CODEV_PR_DRAFT (optional)
# Output: {"number": <int>, "url": "<web url>"}
#
# `gh pr create` prints the new PR's URL on stdout; the number is its last path
# segment. Anything gh writes that isn't a URL (hints, prompts) is ignored.
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

set -- --title "$CODEV_PR_TITLE" --body "$CODEV_PR_BODY"
if [ -n "$CODEV_PR_BASE" ]; then set -- "$@" --base "$CODEV_PR_BASE"; fi
if [ -n "$CODEV_PR_HEAD" ]; then set -- "$@" --head "$CODEV_PR_HEAD"; fi
if [ -n "$CODEV_PR_REPO" ]; then set -- "$@" --repo "$CODEV_PR_REPO"; fi
if [ "$CODEV_PR_DRAFT" = "1" ]; then set -- "$@" --draft; fi

url=$(gh pr create "$@" | grep -E '^https?://' | tail -n 1)

if [ -z "$url" ]; then
  echo "pr-create: gh pr create returned no PR URL" >&2
  exit 1
fi

number=${url##*/}
case "$number" in
  '' | *[!0-9]*)
    echo "pr-create: could not parse a PR number from '$url'" >&2
    exit 1
    ;;
esac

printf '{"number":%s,"url":"%s"}\n' "$number" "$url"
