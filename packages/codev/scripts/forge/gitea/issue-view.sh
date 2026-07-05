#!/bin/sh
# Forge concept: issue-view (Gitea via tea CLI)
#
# `tea issues view` (plural) returns a list-style array without the issue body,
# so use the singular `tea issue <id>`, which returns the full issue object.
#
# Sets `url` to the issue's browser page (`html_url`). Gitea's own `url` field is
# the API endpoint (would render raw JSON in a browser), so we prefer `html_url`
# and fall back to the existing `url` only if `html_url` is absent.
tea issue "$CODEV_ISSUE_ID" --output json | jq '.url = (.html_url // .url)'
