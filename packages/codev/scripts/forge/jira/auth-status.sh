#!/bin/sh
# Forge concept: auth-status (Jira Cloud via acli)
# forge-executable: acli
# Input (optional): CODEV_JIRA_SITE — the site this workspace expects
# Output: exit code (0 = authenticated); acli's status text on stdout
#
# `acli jira auth status` round-trips to the site (it fails when the site is
# unreachable), so it is an authenticated call, not a local config read. acli
# owns the credential (`acli jira auth login`, browser OAuth or API token);
# codev never reads or passes a Jira token. When CODEV_JIRA_SITE is set, a login
# to a different site is reported as unauthenticated, so `codev doctor` never
# reports success against the wrong site.
set -e

STATUS="$(acli jira auth status 2>&1)" || {
  printf '%s\n' "$STATUS" >&2
  exit 1
}

if [ -n "$CODEV_JIRA_SITE" ]; then
  WANT="$(printf '%s' "$CODEV_JIRA_SITE" | sed -e 's#^[a-zA-Z]*://##' -e 's#/*$##' | tr '[:upper:]' '[:lower:]')"
  HAVE="$(printf '%s\n' "$STATUS" | sed -n 's/^[[:space:]]*Site:[[:space:]]*//p' | head -n 1 | tr '[:upper:]' '[:lower:]')"
  if [ "$WANT" != "$HAVE" ]; then
    echo "jira: acli is logged into '${HAVE:-no site}', but forge.jira-site is '$WANT'; run: acli jira auth switch" >&2
    exit 1
  fi
fi

printf '%s\n' "$STATUS"
