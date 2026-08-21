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
# Creates the PR with the raw REST passthrough (`tea api -X POST …/pulls`),
# which RETURNS THE CREATED PR — number and `html_url` — in its response body.
# There is no lookup afterwards, so there is nothing to race and nothing to
# paginate.
#
# Why not `tea pulls create`: it prints a rendered, line-wrapped, ANSI-decorated
# view of the new PR rather than anything parseable, so it has to be followed by
# a search for the PR it just made. That search was the bug. #1146 established
# that Gitea caps every list response at the server's `max_response_items`
# (default 50 — confirmed against Forgejo 15.0.2: `settings/api` reports 50, and
# a `?limit=200` request returns exactly 50 items where paging at 50 returns 53),
# so `tea pulls list --limit 200` silently truncates. On a busy repo the
# just-created PR falls off the first page and this script would have reported
# failure for a PR that exists — inviting a duplicate retry.
#
# Verified against tea 0.14.2 + Forgejo 15.0.2:
#   - POST repos/{owner}/{repo}/pulls returns the full PR object, incl. `number`
#     and `html_url` (its `url` is the browser page too on create, unlike the GET
#     shape where `url` is the API endpoint — hence `.html_url // .url`).
#   - `{owner}`/`{repo}` are substituted by tea from the repo context, and
#     `--repo <owner>/<name>` supplies that context when the cwd has no Gitea
#     remote. Verified with https and scp-style Gitea remotes.
#   - `base` is REQUIRED by the API (it answers `[Base]: Required` without it),
#     unlike `tea pulls create`, which defaults it client-side. So when
#     CODEV_PR_BASE is unset this resolves the repo's default branch first.
#   - `draft: true` in the payload is SILENTLY IGNORED (the response comes back
#     `draft: false`). Gitea marks a PR draft by a `WIP:` title prefix, which is
#     exactly what `tea pulls create --draft` does, so that is replicated here.
#   - `tea api` EXITS 0 on HTTP errors, printing the error body (JSON with
#     `.message`, or bare text like `404 page not found`). Failure therefore has
#     to be detected by inspecting the response, never by exit status — see the
#     assertion below, which is the load-bearing check in this script.
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

# Gitea has no draft flag on the API; a "WIP:" title prefix is the draft marker.
title=$CODEV_PR_TITLE
if [ "$CODEV_PR_DRAFT" = "1" ]; then
  title="WIP: $CODEV_PR_TITLE"
fi

# Shared tea options: which host/repo to talk to. `{owner}`/`{repo}` in the
# endpoint are filled from this context.
set --
if [ -n "$CODEV_PR_REPO" ]; then set -- "$@" --repo "$CODEV_PR_REPO"; fi
if [ -n "$CODEV_PR_LOGIN" ]; then set -- "$@" --login "$CODEV_PR_LOGIN"; fi

base=$CODEV_PR_BASE
if [ -z "$base" ]; then
  # The API rejects a missing base, so mirror `tea pulls create`'s default.
  base_response=$(tea api "$@" 'repos/{owner}/{repo}') || base_response=
  base=$(printf '%s' "$base_response" | jq -r '.default_branch // empty' 2>/dev/null) || base=
  if [ -z "$base" ]; then
    # An unresolvable repo (404 — same cause as the POST path below) means the
    # actual remedy is CODEV_PR_REPO, not CODEV_PR_BASE; only a resolvable repo
    # with a genuinely missing default_branch calls for CODEV_PR_BASE.
    case "$base_response" in
      404*)
        echo "pr-create: Gitea answered 404 — could not resolve owner/repo for this repository." >&2
        echo "pr-create: set CODEV_PR_REPO=owner/repo, or run from a checkout whose remote is a configured Gitea host." >&2
        ;;
      *)
        echo "pr-create: could not resolve the repository's default branch; set CODEV_PR_BASE" >&2
        ;;
    esac
    exit 1
  fi
fi

# Build the payload with jq so an arbitrary body — quotes, backticks, newlines,
# backslashes, unicode — is JSON-escaped rather than interpolated, and feed it
# on stdin (`-d @-`) so it never has to survive an argv round-trip.
response=$(
  jq -n --arg title "$title" --arg body "$CODEV_PR_BODY" \
        --arg head "$head" --arg base "$base" \
        '{title: $title, body: $body, head: $head, base: $base}' \
    | tea api "$@" -X POST -d @- 'repos/{owner}/{repo}/pulls'
)

# `tea api` exits 0 on HTTP errors, so the response body is the ONLY signal that
# the PR was created. Trusting the exit code here would reintroduce exactly the
# silent success #1455 exists to kill — this time in the fix for it. So assert
# the response really is a PR object: an object carrying a numeric `number` AND
# a non-empty browser URL. Anything else is a failure, however it is dressed.
result=$(printf '%s' "$response" | jq -c '
  if type != "object" then empty
  elif (.number | type) != "number" then empty
  else
    (.html_url // .url) as $url
    | if ($url | type) == "string" and ($url | length) > 0
      then {number: .number, url: $url}
      else empty
      end
  end
' 2>/dev/null) || result=

if [ -z "$result" ]; then
  # A numeric `number` with no usable URL means the PR WAS created and only the
  # URL is missing. Say so, and name the number: the operator must not read this
  # as "nothing happened" and retry into a duplicate.
  number=$(printf '%s' "$response" | jq -r '
    if type == "object" and (.number | type) == "number" then .number else empty end
  ' 2>/dev/null) || number=
  if [ -n "$number" ]; then
    echo "pr-create: PR #$number WAS CREATED, but the Gitea response carried no browser URL." >&2
    echo "pr-create: do not retry — that would open a duplicate. Response: $response" >&2
    exit 1
  fi

  message=$(printf '%s' "$response" | jq -r '.message // empty' 2>/dev/null) || message=
  if [ -n "$message" ]; then
    echo "pr-create: Gitea refused to create the PR: $message" >&2
  else
    case "$response" in
      404*)
        # `{owner}`/`{repo}` stayed unsubstituted, so tea requested `repos//pulls`.
        # Name the remedy rather than leaving a bare 404 (cf. `_lib.sh#gitea_repo`).
        echo "pr-create: Gitea answered 404 — could not resolve owner/repo for this repository." >&2
        echo "pr-create: set CODEV_PR_REPO=owner/repo, or run from a checkout whose remote is a configured Gitea host." >&2
        ;;
      *)
        echo "pr-create: unexpected response from the Gitea API: $response" >&2
        ;;
    esac
  fi
  exit 1
fi

printf '%s\n' "$result"
