#!/bin/sh
# Forge concept: issue-view (Gitea via tea CLI)
exec tea issues view "$CODEV_ISSUE_ID" --output json
