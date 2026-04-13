#!/bin/sh
# Forge concept: pr-exists (Gitea via tea CLI)
# Returns true for open or merged pulls only. Closed-not-merged pulls are excluded.
# Gitea: merged PRs have state="closed" + merged=true; abandoned PRs have state="closed" + merged=false
tea pulls list --fields index --output json | jq "[.[] | select(.head.ref == \"$CODEV_BRANCH_NAME\" and (.state == \"open\" or (.state == \"closed\" and .merged == true)))] | length > 0"
