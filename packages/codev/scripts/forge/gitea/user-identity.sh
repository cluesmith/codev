#!/bin/sh
# Forge concept: user-identity (Gitea via tea CLI)
# forge-executable: tea
# Output: plain text username
#
# `tea whoami` has no `--output json` flag (its only documented option is
# --help), so it can't feed a jq pipeline. Route through the raw REST
# passthrough instead: `tea api user` returns the Gitea `User` object, whose
# `.login` is the authenticated username (mirrors `gh api user --jq .login`).
#
# SHAPE VALIDATION. `tea api` exits 0 on an HTTP error and prints the error
# BODY, which has no `.login` — `jq -r .login` then printed the literal string
# "null" at exit 0, and callers took that as the current user's handle. Check
# for a non-empty string login first and fail with the server's message
# otherwise. The response is captured before the pipe because POSIX sh has no
# pipefail: `tea api user | jq` would report jq's status, not tea's.
USER_JSON="$(tea api user)" || exit 1
# jq given empty input emits nothing and exits 0, so an empty body at exit 0
# would leave the script "succeeding" with no username at all.
if [ -z "$USER_JSON" ]; then
  echo "gitea forge: empty \`tea api user\` response" >&2
  exit 1
fi
printf '%s' "$USER_JSON" | jq -r '
  if (type == "object") and ((.login | type) == "string")
     and ((.login | test("^\\s*$")) | not)
  then .login
  else
    ("gitea forge: unexpected `tea api user` response: "
      + (if type == "object" then (.message // tostring) else tostring end)
      + "\n") | halt_error(1)
  end'
