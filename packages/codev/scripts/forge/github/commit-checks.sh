#!/bin/sh
# Forge concept: commit-checks (GitHub via gh CLI) — Spec 1951
# Input: CODEV_COMMIT_SHA (full or abbreviated commit SHA)
# Output: JSON [{name, state, url?}]  (CommitCheckItem[] in forge-contracts.ts)
#
# Two read-only GETs: the commit's check runs (GitHub Actions and other apps, latest
# attempt per name, paginated) and its legacy commit statuses. Both are normalized to
# one state vocabulary: pass | fail | pending | skipped | neutral.
#   check run: not completed → pending; success → pass; skipped → skipped;
#              neutral → neutral; any other conclusion (failure, cancelled,
#              timed_out, action_required, stale, startup_failure) → fail
#   status:    success → pass; pending → pending; failure or error → fail
# `workflow` is not emitted: naming it costs a third call per commit, and the
# contract makes it optional.
#
# Not `gh … | jq`: POSIX sh has no pipefail, so a failed gh would look like a
# commit with no checks (#1645). Capture first, then normalize.
# forge-executable: gh
runs="$(gh api --paginate "repos/{owner}/{repo}/commits/${CODEV_COMMIT_SHA}/check-runs?per_page=100" \
  --jq '.check_runs[] | {kind: "run", name, status, conclusion, url: .html_url}')" || exit 1
statuses="$(gh api "repos/{owner}/{repo}/commits/${CODEV_COMMIT_SHA}/status?per_page=100" \
  --jq '.statuses[] | {kind: "status", name: .context, state, url: .target_url}')" || exit 1
printf '%s\n%s\n' "$runs" "$statuses" | jq -s '
  map(
    (if .kind == "run" then
       (if .status != "completed" then "pending"
        elif .conclusion == "success" then "pass"
        elif .conclusion == "skipped" then "skipped"
        elif .conclusion == "neutral" then "neutral"
        else "fail" end)
     else
       (if .state == "success" then "pass"
        elif .state == "pending" then "pending"
        else "fail" end)
     end) as $state
    | {name, state: $state}
      + (if (.url | type) == "string" and .url != "" then {url} else {} end)
  )'
