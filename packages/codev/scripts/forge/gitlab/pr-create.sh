#!/bin/sh
# Forge concept: pr-create (GitLab via glab CLI — merge requests)
# forge-executable: glab
#
# Input:  CODEV_PR_TITLE (required)
#         CODEV_PR_BODY  (required, may be empty)
#         CODEV_PR_BASE, CODEV_PR_HEAD, CODEV_PR_REPO, CODEV_PR_DRAFT (optional)
# Output: {"number": <int>, "url": "<web url>"}
#
# ⚠️ UNVERIFIED — `glab` is not available in the authoring environment (same
#    constraint as gitea/issue-search.sh, #920). Written against glab's
#    documented `mr create` flags; smoke-test before relying on it. Without this
#    file the gitlab preset would fall through to the GitHub default and shell
#    out to `gh` — the bug this concept exists to close (#1455).
#
# `glab mr create --yes` skips the interactive prompts and prints the new MR's
# URL; the number (GitLab's `iid`) is its last path segment.
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

set -- --title "$CODEV_PR_TITLE" --description "$CODEV_PR_BODY" --yes
if [ -n "$CODEV_PR_BASE" ]; then set -- "$@" --target-branch "$CODEV_PR_BASE"; fi
if [ -n "$CODEV_PR_HEAD" ]; then set -- "$@" --source-branch "$CODEV_PR_HEAD"; fi
if [ -n "$CODEV_PR_REPO" ]; then set -- "$@" --repo "$CODEV_PR_REPO"; fi
if [ "$CODEV_PR_DRAFT" = "1" ]; then set -- "$@" --draft; fi

url=$(glab mr create "$@" | grep -E '^https?://' | tail -n 1)

if [ -z "$url" ]; then
  echo "pr-create: glab mr create returned no MR URL" >&2
  exit 1
fi

number=${url##*/}
case "$number" in
  '' | *[!0-9]*)
    echo "pr-create: could not parse an MR number from '$url'" >&2
    exit 1
    ;;
esac

printf '{"number":%s,"url":"%s"}\n' "$number" "$url"
