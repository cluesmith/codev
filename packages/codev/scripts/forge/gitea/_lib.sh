# Shared helpers for the Gitea forge preset scripts.
#
# This file is SOURCED, not executed (`. "$(dirname "$0")/_lib.sh"`), so it has
# no shebang and defines only functions/vars. POSIX sh only — no bashisms — the
# scripts are #!/bin/sh and forge runs them via `sh -c`. It is not a forge
# concept: forge.ts builds presets from an explicit KNOWN_CONCEPTS allowlist, so
# a leading-underscore file in this directory is never registered as a concept.

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

# Page size to request per page. Gitea caps list responses at the server's
# `max_response_items` (default 50), so `&limit=200` silently truncates to ~50
# with no client-side pagination. Requesting 50 matches that default cap; a
# server tuned higher just returns more per page (fewer round-trips).
GITEA_PAGE_LIMIT=50

# Hard ceiling on pages fetched, so a misbehaving server that never returns a
# short page can't spin forever. 100 pages × 50 = 5000 items — far beyond any
# real open-PR / recently-merged / all-pulls window we page over.
GITEA_MAX_PAGES=100

# Fetch a paginated Gitea list endpoint and emit ONE concatenated JSON array on
# stdout, so the caller's existing jq normalizer sees the same shape as before.
#
# Usage: tea_api_paged "repos/<owner>/<repo>/pulls" "state=all"
#   $1 = API path (no page params)
#   $2 = extra query string (may be empty), e.g. "state=open"
#
# Loops page=1,2,3… appending "&limit=<N>&page=<page>", concatenates each page's
# array, and stops when a page returns fewer than the requested limit (the last
# page) or an empty/blank response, bounded by GITEA_MAX_PAGES.
tea_api_paged() {
  _path="$1"
  _query="$2"
  _page=1
  _acc='[]'
  while [ "$_page" -le "$GITEA_MAX_PAGES" ]; do
    if [ -n "$_query" ]; then
      _url="${_path}?${_query}&limit=${GITEA_PAGE_LIMIT}&page=${_page}"
    else
      _url="${_path}?limit=${GITEA_PAGE_LIMIT}&page=${_page}"
    fi
    _resp="$(tea api "$_url")" || return 1
    # Blank body or an empty array → no more pages.
    [ -n "$_resp" ] || break
    _count="$(printf '%s' "$_resp" | jq 'length')" || return 1
    _acc="$(printf '%s\n%s' "$_acc" "$_resp" | jq -s 'add')" || return 1
    [ "$_count" -lt "$GITEA_PAGE_LIMIT" ] && break
    _page=$((_page + 1))
  done
  printf '%s' "$_acc"
}
