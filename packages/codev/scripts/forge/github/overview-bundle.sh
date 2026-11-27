#!/bin/sh
# Forge concept: overview-bundle (GitHub via gh CLI)
#
# Everything Tower's overview needs, from one GraphQL query (Spec 1995).
#
# Input:  CODEV_INCLUDE_WINDOWS  "1" also returns the two 24 h windows (recently
#                                closed issues, recently merged PRs)
#         CODEV_SINCE_DATE       cutoff for the windows (ISO 8601); unset means
#                                no cutoff, as in recently-closed / recently-merged
# Output: JSON {prs, issues} — the same items as pr-list (30 newest open PRs) and
#         issue-list (200 newest open issues). With the windows requested it also
#         carries either {recentlyClosed, recentlyMerged} (up to 1000 each) or
#         {windowsError}: a GraphQL error confined to the window searches (a
#         search timeout or outage) fails only the windows, never the open lists.
#
# One request carries every section. A connection with more results than one
# page is paged with a follow-up request that asks for that connection only;
# `gh api graphql --paginate` would re-send, and re-cost, the whole query.
#
# Exit status stays honest (POSIX sh has no pipefail, #1645): gh writes to a
# file, never into a pipe, and its stderr is passed through untouched so a rate
# limit reaches the caller's rate-limit detection. Output is printed once, after
# the last page, so a process killed mid-paging prints nothing.
# forge-executable: gh

ISSUE_CAP=200
WINDOW_CAP=1000

tmp="$(mktemp -d)" || exit 1
trap 'rm -rf "$tmp"' EXIT
trap 'exit 1' INT TERM

windows=false
[ "$CODEV_INCLUDE_WINDOWS" = 1 ] && windows=true
since=""
[ -n "$CODEV_SINCE_DATE" ] && since=" closed:>$CODEV_SINCE_DATE"
merged_since=""
[ -n "$CODEV_SINCE_DATE" ] && merged_since=" merged:>$CODEV_SINCE_DATE"
# Both search strings are always sent: search(query:) takes a String!, and
# variables are coerced before @include(if: false) drops the searches.
# gh fills {owner}/{repo} inside them with the same substitution it applies to
# the owner/repo fields (one whole-string replace per -F value, gh >= 2.0.0).
# That matters: GitHub answers an unsubstituted repo:{owner}/{repo} search with
# zero results, not an error, but an unsubstituted owner fails the whole call.
closed_query="repo:{owner}/{repo} is:issue is:closed$since"
merged_query="repo:{owner}/{repo} is:pr is:merged$merged_since"

# GraphQL rejects a query that defines a fragment it does not use, so each
# query carries exactly the fragments it spreads.
AUTHOR_FRAGMENT='
fragment author on Actor { login __typename }'
OPEN_PR_FRAGMENT='
fragment openPr on PullRequest {
  number title url reviewDecision body createdAt isDraft
  author { ...author }
  reviewRequests(first: 100) {
    nodes { requestedReviewer { __typename ... on User { login } } }
  }
}'
OPEN_ISSUE_FRAGMENT='
fragment openIssue on Issue {
  number title url createdAt
  author { ...author }
  labels(first: 100) { nodes { name } }
  assignees(first: 100) { nodes { login } }
}'
CLOSED_ISSUE_FRAGMENT='
fragment closedIssue on Issue {
  number title url createdAt closedAt
  labels(first: 100) { nodes { name } }
}'
MERGED_PR_FRAGMENT='
fragment mergedPr on PullRequest { number title url body createdAt mergedAt headRefName }'

MAIN_QUERY='
query($owner: String!, $repo: String!, $windows: Boolean!, $closedQuery: String!, $mergedQuery: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: 30, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { ...openPr }
    }
    issues(states: OPEN, first: 100, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { ...openIssue }
    }
  }
  closed: search(query: $closedQuery, type: ISSUE, first: 100) @include(if: $windows) {
    pageInfo { hasNextPage endCursor }
    nodes { ...closedIssue }
  }
  merged: search(query: $mergedQuery, type: ISSUE, first: 100) @include(if: $windows) {
    pageInfo { hasNextPage endCursor }
    nodes { ...mergedPr }
  }
}'"$AUTHOR_FRAGMENT$OPEN_PR_FRAGMENT$OPEN_ISSUE_FRAGMENT$CLOSED_ISSUE_FRAGMENT$MERGED_PR_FRAGMENT"

ISSUES_PAGE_QUERY='
query($owner: String!, $repo: String!, $first: Int!, $after: String!) {
  repository(owner: $owner, name: $repo) {
    issues(states: OPEN, first: $first, after: $after, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { ...openIssue }
    }
  }
}'"$AUTHOR_FRAGMENT$OPEN_ISSUE_FRAGMENT"

CLOSED_PAGE_QUERY='
query($q: String!, $first: Int!, $after: String!) {
  closed: search(query: $q, type: ISSUE, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ...closedIssue }
  }
}'"$CLOSED_ISSUE_FRAGMENT"

MERGED_PAGE_QUERY='
query($q: String!, $first: Int!, $after: String!) {
  merged: search(query: $q, type: ISSUE, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ...mergedPr }
  }
}'"$MERGED_PR_FRAGMENT"

# The error text of a response whose every GraphQL error sits on a window
# search path (`closed` / `merged`) while both open connections are present.
# Fails for anything else: a top-level error (rate limit included), an
# open-list path, a missing open connection, or a response that is not JSON.
window_only_error() {
  jq -er '
    if type == "object"
       and (.errors | type == "array" and length > 0)
       and .data.repository.pullRequests != null
       and .data.repository.issues != null
       and all(.errors[]; (.path | type == "array") and (.path[0] == "closed" or .path[0] == "merged"))
    then [.errors[].message | select(type == "string" and test("\\S"))]
         | if length == 0 then "window search failed" else join("; ") end
    else error("not a window-only error")
    end' "$1" 2>/dev/null
}

# The error text of a failed window follow-up page whose errors all sit on its
# own alias. Fails for a top-level error.
window_page_error() {
  jq -er --arg alias "$2" '
    if type == "object"
       and (.errors | type == "array" and length > 0)
       and all(.errors[]; (.path | type == "array") and .path[0] == $alias)
    then [.errors[].message | select(type == "string" and test("\\S"))]
         | if length == 0 then "window search failed" else join("; ") end
    else error("not a window error")
    end' "$1" 2>/dev/null
}

windows_error=""
main="$tmp/main.json"
if ! gh api graphql -f query="$MAIN_QUERY" -F owner='{owner}' -F repo='{repo}' \
    -F windows="$windows" -F closedQuery="$closed_query" -F mergedQuery="$merged_query" > "$main"; then
  [ "$windows" = true ] || exit 1
  windows_error="$(window_only_error "$main")" || exit 1
fi

# --- open issues: page to ISSUE_CAP -------------------------------------------
: > "$tmp/issue-pages.json"
count="$(jq -er '.data.repository.issues.nodes | length' "$main")" || exit 1
more="$(jq -r '.data.repository.issues.pageInfo.hasNextPage' "$main")" || exit 1
cursor="$(jq -r '.data.repository.issues.pageInfo.endCursor // ""' "$main")" || exit 1
while [ "$more" = true ] && [ "$count" -lt "$ISSUE_CAP" ]; do
  first=$((ISSUE_CAP - count))
  [ "$first" -gt 100 ] && first=100
  page="$tmp/page.json"
  gh api graphql -f query="$ISSUES_PAGE_QUERY" -F owner='{owner}' -F repo='{repo}' \
    -F first="$first" -f after="$cursor" > "$page" || exit 1
  cat "$page" >> "$tmp/issue-pages.json" || exit 1
  n="$(jq -er '.data.repository.issues.nodes | length' "$page")" || exit 1
  count=$((count + n))
  more="$(jq -r '.data.repository.issues.pageInfo.hasNextPage' "$page")" || exit 1
  cursor="$(jq -r '.data.repository.issues.pageInfo.endCursor // ""' "$page")" || exit 1
done

# --- 24 h windows: page each to WINDOW_CAP --------------------------------------
# page_window <alias> <query> <search string> <pages file>
page_window() {
  : > "$4"
  wcount="$(jq -er --arg a "$1" '.data[$a].nodes | length' "$main")" || return 2
  wmore="$(jq -r --arg a "$1" '.data[$a].pageInfo.hasNextPage' "$main")" || return 2
  wcursor="$(jq -r --arg a "$1" '.data[$a].pageInfo.endCursor // ""' "$main")" || return 2
  while [ "$wmore" = true ] && [ "$wcount" -lt "$WINDOW_CAP" ]; do
    wfirst=$((WINDOW_CAP - wcount))
    [ "$wfirst" -gt 100 ] && wfirst=100
    wpage="$tmp/window-page.json"
    if ! gh api graphql -f query="$2" -F q="$3" -F first="$wfirst" -f after="$wcursor" > "$wpage"; then
      windows_error="$(window_page_error "$wpage" "$1")" || return 2
      return 1
    fi
    cat "$wpage" >> "$4" || return 2
    wn="$(jq -er --arg a "$1" '.data[$a].nodes | length' "$wpage")" || return 2
    wcount=$((wcount + wn))
    wmore="$(jq -r --arg a "$1" '.data[$a].pageInfo.hasNextPage' "$wpage")" || return 2
    wcursor="$(jq -r --arg a "$1" '.data[$a].pageInfo.endCursor // ""' "$wpage")" || return 2
  done
  return 0
}

: > "$tmp/closed-pages.json"
: > "$tmp/merged-pages.json"
if [ "$windows" = true ] && [ -z "$windows_error" ]; then
  page_window closed "$CLOSED_PAGE_QUERY" "$closed_query" "$tmp/closed-pages.json"
  rc=$?
  [ "$rc" -eq 2 ] && exit 1
  if [ "$rc" -eq 0 ]; then
    page_window merged "$MERGED_PAGE_QUERY" "$merged_query" "$tmp/merged-pages.json"
    [ $? -eq 2 ] && exit 1
  fi
fi

# --- assemble, in gh's --json rendering ----------------------------------------
# gh renders a bot author as `app/<login>` and a null reviewDecision as "". Its
# reviewRequests export keeps users and teams only (bots, Copilot included, are
# dropped), and pr-list keeps the logins, so only user reviewers survive. A
# null author (a deleted account) comes out of gh as `app/`: its bot check is
# "not a User", and the login is empty. That is reproduced, because the
# overview shows `author.login` and must not change with the transport.
# The search index can lag a reopen: an issue reopened moments ago can still
# match is:closed, with its closedAt already null. recently-closed drops such
# an item in the 24 h filter, so it is dropped here too.
jq -n \
  --slurpfile main "$main" \
  --slurpfile issuePages "$tmp/issue-pages.json" \
  --slurpfile closedPages "$tmp/closed-pages.json" \
  --slurpfile mergedPages "$tmp/merged-pages.json" \
  --arg windows "$windows" \
  --arg windowsError "$windows_error" \
  --argjson issueCap "$ISSUE_CAP" \
  --argjson windowCap "$WINDOW_CAP" '
  def author: if . == null then {login: "app/"}
              elif .__typename == "Bot" then {login: ("app/" + .login)}
              else {login: .login} end;
  def openPr: {number, title, url, reviewDecision: (.reviewDecision // ""), body, createdAt, isDraft,
               author: (.author | author),
               reviewRequests: [.reviewRequests.nodes[].requestedReviewer
                                | select(. != null and .__typename == "User") | .login]};
  def openIssue: {number, title, url, createdAt, author: (.author | author),
                  labels: [.labels.nodes[] | {name}], assignees: [.assignees.nodes[] | {login}]};
  def closedIssue: {number, title, url, createdAt, closedAt, labels: [.labels.nodes[] | {name}]};
  def mergedPr: {number, title, url, body, createdAt, mergedAt, headRefName};
  $main[0].data as $d
  | {
      prs: [$d.repository.pullRequests.nodes[] | openPr],
      issues: ([$d.repository.issues.nodes[], ($issuePages[] | .data.repository.issues.nodes[])]
               | .[:$issueCap] | map(openIssue))
    }
  + if $windows != "true" then {}
    elif $windowsError != "" then {windowsError: $windowsError}
    else {
      recentlyClosed: ([$d.closed.nodes[], ($closedPages[] | .data.closed.nodes[])]
                       | .[:$windowCap] | map(select(.closedAt != null) | closedIssue)),
      recentlyMerged: ([$d.merged.nodes[], ($mergedPages[] | .data.merged.nodes[])]
                       | .[:$windowCap] | map(mergedPr))
    }
    end' || exit 1
