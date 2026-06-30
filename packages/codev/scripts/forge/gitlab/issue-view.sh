#!/bin/sh
# Forge concept: issue-view (GitLab via glab CLI)
# Adds a `url` field mapped from GitLab's `web_url` (the issue's browser page);
# all other fields glab emits are passed through unchanged. `. + {url: …}` is
# non-destructive — if `web_url` is absent, `url` is null (optional by contract).
glab issue view "$CODEV_ISSUE_ID" --output json | jq '. + {url: .web_url}'
