#!/bin/sh
# Forge concept: recently-closed (Jira Cloud via acli)
# forge-executable: acli
# Input (optional): CODEV_SINCE_DATE (ISO 8601), CODEV_JIRA_PROJECT, CODEV_JIRA_SITE
# Output: JSON [{number, title, url, labels, createdAt, closedAt}]
#
# Closed = status category Done, never status names (names are per-site).
#
# `workitem search` cannot return dates, but consumers drop items without
# `closedAt`, so each hit is fetched with `workitem view` (one key per call)
# for `statuscategorychangedate`, with bounded parallelism. The window is small
# (the overview asks for the last 24h) and capped at 25 hits.
#
# JQL date literals are day-or-minute precision in the user's Jira time zone,
# so the query bound is the since date minus one day: a superset. The consumer
# applies the exact cutoff against `closedAt`.
set -e
. "$(dirname "$0")/_lib.sh"

SCOPE="$(jira_scope)" || exit 1
SITE="$(jira_site)" || exit 1

DATE_CLAUSE=""
if [ -n "$CODEV_SINCE_DATE" ]; then
  SINCE_DAY="$(jq -rn --arg s "$CODEV_SINCE_DATE" '
    try (
      $s | (if test("T") then . else . + "T00:00:00Z" end)
         | sub("\\.[0-9]+"; "") | fromdateiso8601 - 86400 | strftime("%Y-%m-%d")
    ) catch ($s[0:10])')"
  # The fallback takes the input's first ten characters, so validate before it
  # reaches the JQL, as _lib.sh validates keys.
  if ! printf '%s' "$SINCE_DAY" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
    echo "jira: invalid CODEV_SINCE_DATE '$CODEV_SINCE_DATE' (expected an ISO 8601 date)" >&2
    exit 1
  fi
  DATE_CLAUSE=" AND statusCategoryChangedDate >= \"$SINCE_DAY\""
fi

HITS="$(acli jira workitem search \
  --jql "${SCOPE}statusCategory = Done${DATE_CLAUSE} ORDER BY statusCategoryChangedDate DESC" \
  --fields summary,status,labels \
  --limit 25 \
  --json)"

KEYS="$(printf '%s' "$HITS" | jq -r '.[] | select(. != null) | .key | select(type == "string" and test("^[A-Za-z][A-Za-z0-9_]*-[0-9]+$"))')"
if [ -z "$KEYS" ]; then
  echo '[]'
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK:?}"' EXIT

# One file per key, so concurrent views never interleave on a shared stdout.
# Each view writes a .part file that is renamed only on success: a failed view
# leaves no .json, its item is emitted without dates (the consumer drops it),
# and the warning makes that visible.
printf '%s\n' "$KEYS" | xargs -P 6 -I {} sh -c '
  if acli jira workitem view "$1" --fields created,statuscategorychangedate,resolutiondate --json > "$2/$1.part" 2>/dev/null; then
    mv "$2/$1.part" "$2/$1.json"
  else
    echo "jira: could not fetch dates for $1" >&2
  fi
' _ {} "$WORK"

DATES="$WORK/dates.map"
if ls "$WORK"/*.json >/dev/null 2>&1; then
  cat "$WORK"/*.json | jq -s 'map(select(.key != null) | { key: .key, value: .fields }) | from_entries' > "$DATES"
else
  echo '{}' > "$DATES"
fi

printf '%s' "$HITS" | jq --arg site "$SITE" --slurpfile dates "$DATES" "$JIRA_JQ_DEFS"'
  [.[] | select(. != null and (.key | type) == "string") | ($dates[0][.key] // {}) as $d | {
    number: .key,
    title: (.fields.summary // ""),
    url: "\($site)/browse/\(.key)",
    labels: labels_of,
    createdAt: $d.created,
    closedAt: ($d.statuscategorychangedate // $d.resolutiondate)
  }]'
