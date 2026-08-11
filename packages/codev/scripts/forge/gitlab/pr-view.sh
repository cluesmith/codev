#!/bin/sh
# Forge concept: pr-view (GitLab via glab CLI)
# Adds a `url` field mapped from GitLab's `web_url` (the MR's browser page);
# all other fields glab emits are passed through unchanged. `. + {url: …}` is
# non-destructive — if `web_url` is absent, `url` is null (optional by contract).
glab mr view "$CODEV_PR_NUMBER" --output json | jq '. + {url: .web_url}'
