#!/bin/sh
# Forge concept: pr-view (Gitea via tea CLI)
exec tea pulls view "$CODEV_PR_NUMBER" --output json
