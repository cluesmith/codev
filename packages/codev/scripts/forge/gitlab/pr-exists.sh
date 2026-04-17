#!/bin/sh
# Forge concept: pr-exists (GitLab via glab CLI)
# Returns true for open or merged MRs only. Closed-not-merged MRs are excluded.
# --all fetches MRs in all states (open, merged, closed); without it, only open MRs are returned.
glab mr list --all --source-branch "$CODEV_BRANCH_NAME" --output json | jq '[.[] | select(.state == "opened" or .state == "merged")] | length > 0'
