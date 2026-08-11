#!/bin/sh
# Forge concept: pr-view (Gitea via tea CLI)
# Sets `url` to the PR's browser page (`html_url`). Gitea's own `url` field is
# the API endpoint (would render raw JSON in a browser), so we prefer `html_url`
# and fall back to the existing `url` only if `html_url` is absent.
tea pulls view "$CODEV_PR_NUMBER" --output json | jq '.url = (.html_url // .url)'
