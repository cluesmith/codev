# Shared helpers for the Jira forge preset scripts (Jira Cloud via Atlassian's `acli`).
#
# This file is SOURCED, not executed (`. "$(dirname "$0")/_lib.sh"`), so it has
# no shebang and defines only functions/vars. POSIX sh only — no bashisms — the
# scripts are #!/bin/sh and forge runs them via `sh -c`. It is not a forge
# concept: forge.ts builds presets from an explicit KNOWN_CONCEPTS allowlist, so
# a leading-underscore file in this directory is never registered as a concept.
#
# Sibling-file dependency: the concept scripts that source this file need it to
# sit next to them. A hand-copied override in `.codev/scripts/forge/jira/` must
# copy `_lib.sh` alongside the script, or the `.` line fails.
#
# acli facts these helpers encode (verified against acli 1.3.39-stable):
#   - `acli jira auth status` round-trips to the site and prints text (no
#     --json): `Site: <host>`, `Email: <addr>`, `Authentication Type: …`.
#   - A work item's REST `self` link names an Atlassian infrastructure host, not
#     the site, so browser URLs are built from the site, never from `self`.
#   - Jira rejects unbounded JQL, so every query carries a status-category
#     clause; project scoping is optional on top of it.

# Print the site's browser base URL (`https://<site>.atlassian.net`), no
# trailing slash. Honors CODEV_JIRA_SITE (`forge.jira-site`), with or without a
# scheme; otherwise asks acli which site it is logged into. Callers must use:
#   SITE="$(jira_site)" || exit 1
jira_site() {
  if [ -n "$CODEV_JIRA_SITE" ]; then
    _site="$CODEV_JIRA_SITE"
  else
    _site="$(acli jira auth status 2>/dev/null | sed -n 's/^[[:space:]]*Site:[[:space:]]*//p' | head -n 1)"
  fi
  _site="$(printf '%s' "$_site" | sed -e 's#^[a-zA-Z]*://##' -e 's#/*$##')"
  if [ -z "$_site" ]; then
    echo "jira: cannot determine the Jira site; set forge.jira-site in .codev/config.json or run: acli jira auth login" >&2
    return 1
  fi
  printf 'https://%s' "$_site"
}

# Print the JQL project-scope prefix (`project = "KEY" AND `), or nothing when
# CODEV_JIRA_PROJECT (`forge.jira-project`) is unset. The key is validated
# rather than escaped: Jira project keys are `[A-Z][A-Z0-9_]+`, and anything
# else is a misconfiguration that must not reach the query. Callers must use:
#   SCOPE="$(jira_scope)" || exit 1
jira_scope() {
  [ -z "$CODEV_JIRA_PROJECT" ] && return 0
  _key="$(printf '%s' "$CODEV_JIRA_PROJECT" | tr '[:lower:]' '[:upper:]')"
  case "$_key" in
    [A-Z]*) ;;
    *) _key="" ;;
  esac
  if [ -z "$_key" ] || printf '%s' "$_key" | grep -q '[^A-Z0-9_]'; then
    echo "jira: invalid forge.jira-project '$CODEV_JIRA_PROJECT' (expected a project key like ENG)" >&2
    return 1
  fi
  printf 'project = "%s" AND ' "$_key"
}

# Fail unless CODEV_ISSUE_ID is a work item key (`KEY-123`). It is passed to
# acli as an argument, so the check also keeps a leading `-` from being read as
# a flag. Callers must use:  jira_require_issue_id || exit 1
jira_require_issue_id() {
  if [ -z "$CODEV_ISSUE_ID" ]; then
    echo "CODEV_ISSUE_ID is not set" >&2
    return 1
  fi
  if ! printf '%s' "$CODEV_ISSUE_ID" | grep -Eq '^[A-Za-z][A-Za-z0-9_]*-[0-9]+$'; then
    echo "jira: '$CODEV_ISSUE_ID' is not a Jira work item key (expected KEY-123)" >&2
    return 1
  fi
}

# jq definitions shared by the JSON-emitting scripts. Prepend to a filter:
#   jq "$JIRA_JQ_DEFS"' …filter… '
#
# adf_text flattens Atlassian Document Format (descriptions and comment bodies)
# to plain text: inline text joined per block, blocks separated by blank lines,
# list items prefixed with "- " or "N. ". Media and unknown leaf nodes drop out.
# No markdown fidelity is attempted.
#
# person maps a Jira user to the contract's `{login}`. The email is preferred
# because `user-identity` can only report the current user's email (acli
# exposes nothing else), and the "assigned to me" filter compares the two.
# Users who hide their email degrade to their display name.
JIRA_JQ_DEFS='
def adf_inline:
  if .type == "text" then (.text // "")
  elif .type == "hardBreak" then "\n"
  elif .type == "mention" then (.attrs.text // "")
  elif .type == "emoji" then (.attrs.text // .attrs.shortName // "")
  elif .type == "inlineCard" or .type == "blockCard" then (.attrs.url // "")
  elif (.content | type) == "array" then ([.content[] | adf_inline] | join(""))
  else "" end;
def adf_block:
  if .type == "paragraph" or .type == "heading" or .type == "codeBlock" then
    ([(.content // [])[] | adf_inline] | join(""))
  elif .type == "bulletList" then
    ([(.content // [])[] | "- " + ([(.content // [])[] | adf_block] | join("\n"))] | join("\n"))
  elif .type == "orderedList" then
    ([(.content // []) | to_entries[] | "\(.key + 1). " + ([(.value.content // [])[] | adf_block] | join("\n"))] | join("\n"))
  elif .type == "mediaSingle" or .type == "mediaGroup" or .type == "media" or .type == "rule" then ""
  elif (.content | type) == "array" then
    ([.content[] | adf_block | select(. != "")] | join("\n\n"))
  else adf_inline end;
def adf_text:
  if . == null then ""
  elif type == "string" then .
  elif type == "object" then ([(.content // [])[] | adf_block | select(. != "")] | join("\n\n"))
  else "" end;
def person:
  if . == null then null else { login: (.emailAddress // .displayName // "") } end;
def labels_of: [(.fields.labels // [])[] | { name: . }];
def assignees_of: (if .fields.assignee then [.fields.assignee | person] else [] end);
'
