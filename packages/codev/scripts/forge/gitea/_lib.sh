# Shared helpers for the Gitea forge preset scripts.
#
# This file is SOURCED, not executed (`. "$(dirname "$0")/_lib.sh"`), so it has
# no shebang and defines only functions/vars. POSIX sh only — no bashisms — the
# scripts are #!/bin/sh and forge runs them via `sh -c`. It is not a forge
# concept: forge.ts builds presets from an explicit KNOWN_CONCEPTS allowlist, so
# a leading-underscore file in this directory is never registered as a concept.
#
# Sibling-file dependency: the five concept scripts that source this file need
# it to sit next to them. A hand-copied override in `.codev/scripts/forge/gitea/`
# must copy `_lib.sh` alongside the script, or the `.` line fails.

# Resolve owner/repo for the `tea api` path.
#
# `tea api` needs an explicit owner/repo in the path (unlike `tea pulls`/`tea
# issues`, which auto-detect it from the local git remote). Honor CODEV_REPO
# when set, else derive owner/repo from origin's URL (handles https, ssh, and
# scp-style remotes, with or without a .git suffix).
#
# Fails fast: if the result isn't a clean `owner/repo` (no origin remote, an
# unusual URL, etc.), print a stderr message naming CODEV_REPO as the remedy and
# return non-zero so the caller can `exit 1` — otherwise `tea api "repos//…"`
# fails later with a confusing 404. Callers must use:  REPO="$(gitea_repo)" || exit 1
gitea_repo() {
  _repo="${CODEV_REPO:-$(git remote get-url origin 2>/dev/null | sed -E -e 's#\.git$##' -e 's#.*[/:]([^/]+/[^/]+)$#\1#')}"
  _owner=${_repo%%/*}
  _rest=${_repo#*/}
  # Valid iff exactly one slash, both sides non-empty:
  #   - "$_owner" = "$_repo"       → no slash at all
  #   - -z "$_owner" / -z "$_rest" → empty owner or repo (e.g. "/x", "x/")
  #   - "$_rest" != "${_rest%/*}"  → a second slash (e.g. "a/b/c")
  if [ -z "$_repo" ] || [ "$_owner" = "$_repo" ] || [ -z "$_owner" ] || [ -z "$_rest" ] || [ "$_rest" != "${_rest%/*}" ]; then
    echo "gitea forge: could not determine owner/repo from the 'origin' remote; set CODEV_REPO=owner/repo" >&2
    return 1
  fi
  printf '%s' "$_repo"
}

# A jq prelude defining `gitea_epoch`: parse a timestamp to epoch seconds, or
# null if it isn't one. Prepend it to a jq program that needs to compare times:
#   jq "${GITEA_JQ_LIB} <program>"
#
# Two input shapes, because two different producers feed it:
#   - Gitea's RFC3339 response times. Gitea marshals them in the SERVER's
#     timezone, so `Z` is NOT guaranteed — `2026-07-05T14:00:00+02:00` is a real
#     response. `fromdateiso8601` only accepts `Z`, and a lexicographic compare
#     across mixed offsets is simply wrong, so the offset is parsed and
#     subtracted explicitly.
#   - CODEV_SINCE_DATE, which callers set to either a full timestamp
#     (`github.ts`) or a bare `YYYY-MM-DD` (`team-update.ts`). A bare date is
#     read as midnight UTC, and a timestamp with no offset at all is read as
#     UTC too.
#
# Input that isn't a recognizable date yields null, and every caller treats null
# as "don't know" — keep the item, keep walking — so a surprising format
# degrades to the old unbounded behavior rather than silently dropping data.
# This is shape validation, not a calendar: `2026-02-30` is normalized by
# `fromdateiso8601` into March rather than rejected. That only matters for a
# hand-written cutoff, and lands it a day or two off rather than anywhere wild.
GITEA_JQ_LIB='
def gitea_epoch:
  if type == "string" then
    ((capture("^(?<d>\\d{4}-\\d{2}-\\d{2})(T(?<t>\\d{2}:\\d{2}:\\d{2})(\\.\\d+)?(?<o>Z|[+-](0\\d|1[0-4]):[0-5]\\d)?)?$")) // null) as $c
    | if $c == null then null
      # `try`: the regex only proves the SHAPE. `2026-13-99` matches it and then
      # makes `fromdateiso8601` throw, which would abort the script with a raw
      # jq error instead of degrading to "unknown time".
      else (try (($c.d + "T" + ($c.t // "00:00:00") + "Z") | fromdateiso8601) catch null) as $e
        | if $e == null then null
          elif ($c.o == null or $c.o == "Z") then $e
          else ($c.o | capture("^(?<s>[+-])(?<h>\\d{2}):(?<m>\\d{2})$")) as $z
            | $e - (((($z.h | tonumber) * 3600) + (($z.m | tonumber) * 60))
                    * (if $z.s == "+" then 1 else -1 end))
          end
      end
  else null end;
'

# Page size to request per page. Gitea caps list responses at the server's
# `max_response_items` (default 50), so `&limit=200` silently truncates to ~50
# with no client-side pagination. Requesting 50 matches that default cap; a
# server tuned higher just returns more per page (fewer round-trips).
GITEA_PAGE_LIMIT=50

# Hard ceiling on pages fetched, so a misbehaving server that never returns a
# short page can't spin forever. 100 pages × 50 = 5000 items — far beyond any
# real open-PR / recently-merged / all-pulls window we page over. Reaching it is
# an ERROR, not a stop condition (see below).
GITEA_MAX_PAGES=100

# Fetch a paginated Gitea list endpoint and emit ONE concatenated JSON array on
# stdout, so the caller's existing jq normalizer sees the same shape as before.
#
# Usage: tea_api_paged "repos/<owner>/<repo>/pulls" "state=all" ["<jq stop filter>"]
#   $1 = API path (no page params)
#   $2 = extra query string (may be empty), e.g. "state=open"
#   $3 = optional jq program run on each page's array, with the PREVIOUS page
#        bound as `$prev` (`null` on page 1); when it outputs `true` the walk
#        stops after that page. Used by `recently-merged` to bound the walk with
#        CODEV_SINCE_DATE — `$prev` is what lets it check ordering ACROSS a page
#        boundary and not just within one page. It must be conservative: a false
#        negative just costs another page, a false positive silently truncates.
#
# Loops page=1,2,3… appending "&limit=<N>&page=<page>", concatenates each page's
# array, and stops when a page returns fewer than the requested limit (the last
# page), an empty/blank response, or the caller's stop filter fires.
#
# A page that parses but ISN'T an array is a hard error, not a stop condition.
# `tea api` exits 0 on HTTP errors and prints the error body, and `jq length` is
# 0 for both `null` and `{}` — so an error body mid-walk used to look exactly
# like an exhausted list and return the partial array at exit 0.
#
# Reaching GITEA_MAX_PAGES without any of those terminal conditions means we do
# NOT know we have the whole list. Returning the partial array at exit 0 would
# be exactly the silent-truncation class this paginator exists to prevent (a
# short `pr-exists` walk reads as "no PR exists" and passes a porch pr_exists
# gate on a repo we simply failed to finish reading), so it fails loudly
# instead: stderr message, non-zero return, no stdout.
tea_api_paged() {
  _path="$1"
  _query="$2"
  _stop="$3"
  _page=1
  _acc='[]'
  _page_size=''
  _terminal=''
  _prev=''
  while [ "$_page" -le "$GITEA_MAX_PAGES" ]; do
    if [ -n "$_query" ]; then
      _url="${_path}?${_query}&limit=${GITEA_PAGE_LIMIT}&page=${_page}"
    else
      _url="${_path}?limit=${GITEA_PAGE_LIMIT}&page=${_page}"
    fi
    _resp="$(tea api "$_url")" || return 1
    # Blank body or an empty array → no more pages.
    if [ -z "$_resp" ]; then
      _terminal=1
      break
    fi
    # Length AND type in one jq pass; a non-array page is prefixed with "!".
    _count="$(printf '%s' "$_resp" | jq -r 'if type == "array" then length else "!" + type end')" || return 1
    case "$_count" in
      '!'*)
        echo "gitea forge: page ${_page} of '${_path}' is not an array but a ${_count#!} (an HTTP error body reaches us at exit 0); refusing to return a truncated result" >&2
        return 1
        ;;
    esac
    if [ "$_count" -eq 0 ]; then
      _terminal=1
      break
    fi
    _acc="$(printf '%s\n%s' "$_acc" "$_resp" | jq -s 'add')" || return 1
    if [ -n "$_stop" ]; then
      _hit="$(printf '%s' "$_resp" | jq --argjson prev "${_prev:-null}" "$_stop")" || return 1
      if [ "$_hit" = "true" ]; then
        _terminal=1
        break
      fi
    fi
    _prev="$_resp"
    # A server whose max_response_items is tuned below GITEA_PAGE_LIMIT
    # truncates every page to its own cap, not the requested limit — so
    # stopping when a page is shorter than the *requested* limit would break
    # after page 1 even though more pages exist. Compare against the size
    # actually observed on the first page instead.
    [ -z "$_page_size" ] && _page_size="$_count"
    if [ "$_count" -lt "$_page_size" ]; then
      _terminal=1
      break
    fi
    _page=$((_page + 1))
  done
  if [ -z "$_terminal" ]; then
    echo "gitea forge: pagination for '${_path}' reached the ${GITEA_MAX_PAGES}-page ceiling without a terminal page; refusing to return a truncated result" >&2
    return 1
  fi
  printf '%s' "$_acc"
}
