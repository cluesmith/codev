#!/bin/sh
# Forge concept: overview-bundle (GitHub via gh CLI) — Spec 1647
# Input: CODEV_SINCE_DATE (required): start of the 24 h windows, YYYY-MM-DDTHH:MM:SSZ.
# Output: JSON {prs, issues, recentlyClosed, recentlyMerged}  (OverviewBundleResult in
#         forge-contracts.ts). Each section carries what its sibling concept emits for the
#         same repository state (pr-list, issue-list, recently-closed, recently-merged), or
#         null when that search alone could not be fetched.
#
# One `gh api graphql` request carries the first page of every section. Follow-up requests,
# each its own gh process, are sent only on overflow and only up to the siblings' caps:
#   - one more page of open issues when there are more than 100 (cap 200, newest first);
#   - further pages of a search that returns more than 100 results (cap 1,000).
# Open PRs stop at 30, as `gh pr list` does by default.
#
# Exit status:
#   0          every section fetched, or a search failed on its own: that section is null
#              and the reason is on stderr (the one case where a non-zero gh status ends 0);
#   2          CODEV_SINCE_DATE missing or malformed; no request was sent;
#   gh's own   with gh's stderr, for every other failure: a rate limit anywhere, an error
#              without a path or on an open list, a failed issue page, auth, transport.
#
# Security: the GraphQL texts below are fixed. Every dynamic value travels as a GraphQL
# variable, and returned data is only ever read by jq, never evaluated by the shell.
# `-F` is used only where gh must expand {owner}/{repo}; cursors, which come from returned
# data, go through `-f` so gh never type-converts them.
#
# Signals: every gh runs in the background and the script waits for it. The forge layer
# enforces its time limit by sending SIGTERM to this shell alone, and POSIX sh defers a
# trapped signal until the running foreground command returns, so a foreground gh would
# hold the call open until it finished. `wait` returns at once on a trapped signal; the
# trap then kills the in-flight gh and exits, and the EXIT trap removes the temp directory.
# This only works because gh's output is staged to files: a `$(gh …)` capture would make
# gh hold the caller's pipe. Do not "simplify" either back. On native Windows a timeout
# kill does not deliver a signal the trap can catch, so the temp directory can be left
# behind in TMPDIR there.
#
# Never `gh … | jq`: POSIX sh has no pipefail, and a failed gh would read as an empty
# success (#1645). Each gh's status is captured, then jq reads the staged output.
# forge-executable: gh

# The same pattern forge-rate-limit.ts matches on (RATE_LIMIT_PATTERN), as an ERE.
RATE_LIMIT_PATTERN='rate limit (already )?exceeded|RATE_LIMITED|graphql_rate_limit|secondary rate limit'

case "${CODEV_SINCE_DATE-}" in
  [[:digit:]][[:digit:]][[:digit:]][[:digit:]]-[[:digit:]][[:digit:]]-[[:digit:]][[:digit:]]T[[:digit:]][[:digit:]]:[[:digit:]][[:digit:]]:[[:digit:]][[:digit:]]Z) ;;
  *)
    echo "overview-bundle: CODEV_SINCE_DATE must be a UTC timestamp of the form YYYY-MM-DDTHH:MM:SSZ" >&2
    exit 2
    ;;
esac

# --- GraphQL documents (fixed text; values arrive only as variables) -------------------------

F_PR='fragment OverviewPr on PullRequest {
  number title url reviewDecision body createdAt isDraft
  author { __typename login }
  reviewRequests(first: 100) { nodes { requestedReviewer { __typename ... on User { login } } } }
}'
F_ISSUE='fragment OverviewIssue on Issue {
  number title url createdAt
  labels(first: 100) { nodes { name } }
  author { __typename login }
  assignees(first: 100) { nodes { login } }
}'
F_CLOSED='fragment OverviewClosedIssue on Issue {
  number title url createdAt closedAt
  labels(first: 100) { nodes { name } }
}'
F_MERGED='fragment OverviewMergedPr on PullRequest {
  number title url body createdAt mergedAt headRefName
}'

Q_BUNDLE="query OverviewBundle(\$owner: String!, \$repo: String!, \$closedQuery: String!, \$mergedQuery: String!) {
  repository(owner: \$owner, name: \$repo) {
    pullRequests(first: 30, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { ...OverviewPr }
    }
    issues(first: 100, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { ...OverviewIssue }
    }
  }
  closed: search(type: ISSUE, query: \$closedQuery, first: 100) {
    pageInfo { hasNextPage endCursor }
    nodes { ...OverviewClosedIssue }
  }
  merged: search(type: ISSUE, query: \$mergedQuery, first: 100) {
    pageInfo { hasNextPage endCursor }
    nodes { ...OverviewMergedPr }
  }
}
$F_PR
$F_ISSUE
$F_CLOSED
$F_MERGED"

Q_ISSUES_PAGE="query OverviewIssuesPage(\$owner: String!, \$repo: String!, \$cursor: String!) {
  repository(owner: \$owner, name: \$repo) {
    issues(first: 100, after: \$cursor, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { ...OverviewIssue }
    }
  }
}
$F_ISSUE"

Q_SEARCH_PAGE="query OverviewSearchPage(\$search: String!, \$cursor: String!) {
  search(type: ISSUE, query: \$search, first: 100, after: \$cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { ...OverviewClosedIssue ...OverviewMergedPr }
  }
}
$F_CLOSED
$F_MERGED"

# The search strings carry the qualifiers gh adds for the sibling concepts. Both start with
# `repo:`, so `-F` cannot type-convert them; gh expands {owner}/{repo} inside them.
CLOSED_SEARCH="repo:{owner}/{repo} type:issue state:closed closed:>$CODEV_SINCE_DATE"
MERGED_SEARCH="repo:{owner}/{repo} type:pr is:merged merged:>$CODEV_SINCE_DATE"

# --- Staging and signals ---------------------------------------------------------------------

tmp=
gh_pid=

on_signal() {
  if [ -n "$gh_pid" ]; then
    kill "$gh_pid" 2>/dev/null
  fi
  exit "$1"
}

trap 'if [ -n "$tmp" ]; then rm -rf "$tmp"; fi' EXIT
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

tmp=$(mktemp -d "${TMPDIR:-/tmp}/codev-overview-bundle.XXXXXX") || exit 1

# Run one gh request in the background and wait for it (see "Signals" above).
# $1 names the staged pair $tmp/$1.out and $tmp/$1.err; the rest is gh's argv.
# Sets gh_status.
gh_request() {
  stage=$1
  shift
  gh "$@" >"$tmp/$stage.out" 2>"$tmp/$stage.err" &
  gh_pid=$!
  wait "$gh_pid"
  gh_status=$?
  gh_pid=
}

# Whole-bundle failure: replay gh's stderr and exit with gh's status.
fail_with_gh() {
  cat "$tmp/$1.err" >&2
  exit "$gh_status"
}

# True when the staged request $1 failed on a rate limit, by gh's stderr or the body's errors.
is_rate_limited() {
  if grep -Eiq "$RATE_LIMIT_PATTERN" "$tmp/$1.err"; then
    return 0
  fi
  jq -e --arg re "$RATE_LIMIT_PATTERN" \
    'any(.errors[]?; (.type? // "") == "RATE_LIMITED" or ((.message? // "") | tostring | test($re; "i")))' \
    <"$tmp/$1.out" >/dev/null 2>&1
}

# Reads the connection at JSON path $2 (an array literal) of staged response $1.
# Sets page_count and page_cursor (empty when there is no next page).
read_connection() {
  info=$(jq -r --argjson path "$2" '
    getpath($path)
    | if (type == "object") and ((.nodes | type) == "array") then
        "\(.nodes | length) \(if .pageInfo.hasNextPage == true then (.pageInfo.endCursor // "") else "" end)"
      else error("unexpected response shape") end' <"$tmp/$1.out" 2>/dev/null)
  if [ $? -ne 0 ] || [ -z "$info" ]; then
    echo "overview-bundle: unexpected response shape from gh ($1)" >&2
    exit 1
  fi
  page_count=${info%% *}
  page_cursor=${info#* }
}

# --- First request: every section's first page -----------------------------------------------

closed_ok=true
merged_ok=true

gh_request first api graphql \
  -f query="$Q_BUNDLE" \
  -F owner='{owner}' \
  -F repo='{repo}' \
  -F closedQuery="$CLOSED_SEARCH" \
  -F mergedQuery="$MERGED_SEARCH"

if [ "$gh_status" -ne 0 ]; then
  # Search-local only when the body is JSON, both open lists arrived, and every error sits
  # on a search field and is not a rate limit. Anything else fails the whole bundle.
  failed_searches=
  if ! is_rate_limited first; then
    failed_searches=$(jq -r '
      if (type == "object")
         and ((.data | type) == "object")
         and ((.data.repository | type) == "object")
         and ((.data.repository.pullRequests | type) == "object")
         and ((.data.repository.issues | type) == "object")
         and ((.errors | type) == "array") and ((.errors | length) > 0)
         and all(.errors[];
               (type == "object")
               and ((.path | type) == "array") and ((.path | length) > 0)
               and (.path[0] == "closed" or .path[0] == "merged"))
      then [.errors[].path[0]] | unique | .[]
      else empty end' <"$tmp/first.out" 2>/dev/null)
  fi
  if [ -z "$failed_searches" ]; then
    fail_with_gh first
  fi
  for section in $failed_searches; do
    case "$section" in
      closed) closed_ok=false ;;
      merged) merged_ok=false ;;
    esac
  done
  jq -r '.errors[] | "overview-bundle: \(.path[0]) search failed, section reported as null: \(.message // "no message")"' \
    <"$tmp/first.out" >&2
fi

read_connection first '["data","repository","pullRequests"]'
read_connection first '["data","repository","issues"]'
issues_cursor=$page_cursor

# Follow-up pages are appended, in order, to one stream after the first response:
# the issue page, then the closed-search pages, then the merged-search pages. The shell
# counts them so the assembly can split the stream back apart.
cp "$tmp/first.out" "$tmp/pages.json"

# --- Open issues: at most one follow-up page (cap 200) ---------------------------------------

issue_pages=0
if [ -n "$issues_cursor" ]; then
  gh_request issues.2 api graphql \
    -f query="$Q_ISSUES_PAGE" \
    -F owner='{owner}' \
    -F repo='{repo}' \
    -f cursor="$issues_cursor"
  if [ "$gh_status" -ne 0 ]; then
    fail_with_gh issues.2
  fi
  read_connection issues.2 '["data","repository","issues"]'
  cat "$tmp/issues.2.out" >>"$tmp/pages.json"
  issue_pages=1
fi

# --- Searches: page while there is more, up to 1,000 results each ---------------------------

# $1 = section (closed|merged), $2 = its search string. Appends each follow-up page to the
# stream and sets search_pages to how many it appended. A failed page sets search_ok=false
# (the section becomes null, never truncated) unless it is a rate limit, which fails the
# whole bundle. A failed page's output is never appended.
page_search() {
  section=$1
  search=$2
  search_ok=true
  search_pages=0
  read_connection first "[\"data\",\"$section\"]"
  count=$page_count
  cursor=$page_cursor
  page=1
  while [ -n "$cursor" ] && [ "$count" -lt 1000 ]; do
    page=$((page + 1))
    gh_request "$section.$page" api graphql \
      -f query="$Q_SEARCH_PAGE" \
      -F search="$search" \
      -f cursor="$cursor"
    if [ "$gh_status" -ne 0 ]; then
      if is_rate_limited "$section.$page"; then
        fail_with_gh "$section.$page"
      fi
      echo "overview-bundle: $section search page $page failed (gh exit $gh_status), section reported as null" >&2
      cat "$tmp/$section.$page.err" >&2
      search_ok=false
      return
    fi
    read_connection "$section.$page" '["data","search"]'
    cat "$tmp/$section.$page.out" >>"$tmp/pages.json"
    search_pages=$((search_pages + 1))
    count=$((count + page_count))
    cursor=$page_cursor
  done
}

closed_pages=0
if [ "$closed_ok" = true ]; then
  page_search closed "$CLOSED_SEARCH"
  closed_ok=$search_ok
  closed_pages=$search_pages
fi
merged_pages=0
if [ "$merged_ok" = true ]; then
  page_search merged "$MERGED_SEARCH"
  merged_ok=$search_ok
  merged_pages=$search_pages
fi

# --- Assembly: one jq over the staged pages --------------------------------------------------
#
# Each section carries exactly the fields its sibling asks `gh --json` for, in gh's value
# conventions: an author that is not a User is spelled `app/<login>` (gh renders a bot that
# way, and an absent author as `app/`); reviewRequests are user logins only (gh's export
# drops team and bot reviewers); an absent reviewDecision is ""; labels are {name} and
# assignees {login}. Sections are sliced to the siblings' caps.

if ! jq -c -n \
  --argjson issuePages "$issue_pages" \
  --argjson closedPages "$closed_pages" \
  --argjson mergedPages "$merged_pages" \
  --argjson closedOk "$closed_ok" \
  --argjson mergedOk "$merged_ok" '
  def login_of: if (type == "object") and (.__typename == "User") then .login
                else "app/" + ((.login? // "") | tostring) end;
  def nodes_at($path): [.[] | getpath($path) | .nodes[]];
  def pr: {number, title, url,
           reviewDecision: (.reviewDecision // ""),
           body, createdAt,
           author: {login: (.author | login_of)},
           reviewRequests: [.reviewRequests.nodes[]?.requestedReviewer
                            | select((type == "object") and (.__typename == "User")) | .login],
           isDraft};
  def issue: {number, title, url,
              labels: [.labels.nodes[]? | {name}],
              createdAt,
              author: {login: (.author | login_of)},
              assignees: [.assignees.nodes[]? | {login}]};
  def closed_issue: {number, title, url, labels: [.labels.nodes[]? | {name}], createdAt, closedAt};
  def merged_pr: {number, title, url, body, createdAt, mergedAt, headRefName};
  [inputs] as $all
  | ($all[0:1]) as $first
  | ($all[1:1 + $issuePages]) as $issueRest
  | ($all[1 + $issuePages:1 + $issuePages + $closedPages]) as $closedRest
  | ($all[1 + $issuePages + $closedPages:1 + $issuePages + $closedPages + $mergedPages]) as $mergedRest
  | if ($all | length) != (1 + $issuePages + $closedPages + $mergedPages)
    then error("staged page count mismatch") else . end
  | {
      prs: ($first | nodes_at(["data","repository","pullRequests"]) | map(pr) | .[:30]),
      issues: (($first | nodes_at(["data","repository","issues"]))
               + ($issueRest | nodes_at(["data","repository","issues"]))
               | map(issue) | .[:200]),
      recentlyClosed: (if $closedOk then
                         (($first | nodes_at(["data","closed"]))
                          + ($closedRest | nodes_at(["data","search"]))
                          | map(closed_issue) | .[:1000])
                       else null end),
      recentlyMerged: (if $mergedOk then
                         (($first | nodes_at(["data","merged"]))
                          + ($mergedRest | nodes_at(["data","search"]))
                          | map(merged_pr) | .[:1000])
                       else null end)
    }' <"$tmp/pages.json" >"$tmp/bundle.json" 2>"$tmp/assemble.err"; then
  echo "overview-bundle: could not assemble the bundle from gh's responses" >&2
  cat "$tmp/assemble.err" >&2
  exit 1
fi

cat "$tmp/bundle.json"
