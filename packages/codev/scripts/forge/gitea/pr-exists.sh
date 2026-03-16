#!/bin/sh
# Forge concept: pr-exists (Gitea via tea CLI)
tea pulls list --fields index --output json | jq "[.[] | select(.head.ref == \"$CODEV_BRANCH_NAME\")] | length > 0"
