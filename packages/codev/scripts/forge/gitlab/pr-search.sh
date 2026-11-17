#!/bin/sh
# Forge concept: pr-search (GitLab via glab CLI — merge requests)
# Output: JSON [{number, headRefName, baseRefName, state, ...glab fields}]
#
# ⚠️ UNVERIFIED — `glab` is not available in the authoring environment (#920);
#    written against glab's documented `mr list --output json` shape (confirmed
#    against the field mappings already documented in gitlab/pr-list.sh and
#    gitlab/pr-exists.sh). Smoke-test before relying on it.
#
# --all is required so the search includes merged/closed MRs; without it
# `glab mr list` defaults to opened only and post-merge lookups return nothing (#759).
#
# Maps glab's GitLab-shaped fields into the forge-neutral PrSearchItem contract
# (forge-contracts.ts); `. + {…}` is non-destructive for keys we don't touch:
#   iid           -> number        (the MR number glab mr view/merge expects)
#   source_branch -> headRefName
#   target_branch -> baseRefName
# Without this the spawn guard's message reads `PR #undefined` and consult's
# findPRForIssue can't resolve the MR's base branch on GitLab.
#
# glab reports state lowercase (opened/merged/closed/locked); normalize to the
# GitHub convention (OPEN/MERGED/CLOSED) so consumers filter with one comparison.
# The spawn collision guard keys off state === "OPEN" to ignore merged MRs (#1637).
# `locked` (a transient merging state) maps to OPEN too: the guard should err
# toward the recoverable --force prompt, never silently skip a live collision.
#
# Not `glab … | jq`: POSIX sh has no pipefail, so the caller would see jq's exit
# status and a failed glab would look like a successful empty list (#1645).
# The capture-then-pipe shape hides `glab` from extractExecutable's first-line
# heuristic (it lands on the `printf` builtin), so declare the backend explicitly
# — same as github/pr-list.sh (#1645).
# forge-executable: glab
out="$(glab mr list --all --search "$CODEV_SEARCH_QUERY" --output json)" || exit 1
printf '%s' "$out" | jq 'map(.
  + {number: .iid}
  + {headRefName: .source_branch}
  + {baseRefName: .target_branch}
  + {state: ((.state // "") | ascii_downcase as $s | if $s == "opened" or $s == "locked" then "OPEN" else ($s | ascii_upcase) end)})'
