#!/bin/sh
# Forge concept: issue-search (GitLab via glab CLI)
#
# ⚠️ UNVERIFIED — mirrors gitlab/issue-list.sh (raw `glab ... --output json`,
#    no field normalization) plus a state flag and a `body` field surfaced from
#    glab's `description`. `glab` is not available in the authoring environment
#    (#920); smoke-test before relying on it. Confirm: glab's closed/all flags
#    (`--closed` / `--all`) and that the body lives in `.description`.
#
# Input (optional): CODEV_ISSUE_STATE — open|closed|all (default: open)
# Output: JSON [{... glab issue fields ..., body}]
case "${CODEV_ISSUE_STATE:-open}" in
  closed) STATE_FLAG="--closed" ;;
  all)    STATE_FLAG="--all" ;;
  *)      STATE_FLAG="" ;;
esac
# shellcheck disable=SC2086
exec glab issue list --per-page 200 $STATE_FLAG --output json \
  | jq '[.[] | . + { body: (.description // .body // "") }]'
