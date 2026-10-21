#!/bin/sh
# Forge concept: issue-comment (Jira Cloud via acli)
# forge-executable: acli
# Input: CODEV_ISSUE_ID, CODEV_COMMENT_BODY
# Output: exit code only
#
# The body goes to acli as plain text through a temp file (no quoting or argv
# length limits). acli accepts plain text or Atlassian Document Format there;
# codev's markdown is not converted, so it renders as plain text.
set -e
. "$(dirname "$0")/_lib.sh"

jira_require_issue_id || exit 1
if [ -z "${CODEV_COMMENT_BODY+set}" ]; then
  echo "CODEV_COMMENT_BODY is not set" >&2
  exit 1
fi

BODY_FILE="$(mktemp)"
trap 'rm -f "${BODY_FILE:?}"' EXIT
printf '%s\n' "$CODEV_COMMENT_BODY" > "$BODY_FILE"

acli jira workitem comment create --key "$CODEV_ISSUE_ID" --body-file "$BODY_FILE" >/dev/null
