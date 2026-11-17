#!/bin/sh
# Forge concept: user-identity (Jira Cloud via acli)
# forge-executable: acli
# Output: plain text — the logged-in account's email
#
# acli reports the current account only as `Email:` in `auth status` (no
# display name or account id), so the email is the identity. The issue scripts
# map assignees to their email for the same reason, which keeps the "assigned
# to me" filter matching.
set -e

STATUS="$(acli jira auth status)"
EMAIL="$(printf '%s\n' "$STATUS" | sed -n 's/^[[:space:]]*Email:[[:space:]]*//p' | head -n 1)"
if [ -z "$EMAIL" ]; then
  echo "jira: acli auth status reported no account email" >&2
  exit 1
fi
printf '%s\n' "$EMAIL"
