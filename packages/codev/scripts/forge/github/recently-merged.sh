#!/bin/sh
# Forge concept: recently-merged (GitHub via gh CLI)
# Input: CODEV_SINCE_DATE (optional, ISO date)
# Output: JSON [{number, title, url, body, createdAt, mergedAt, headRefName}]

if [ -n "$CODEV_SINCE_DATE" ]; then
  exec gh pr list --state merged \
    --search "merged:>$CODEV_SINCE_DATE" \
    --json number,title,url,body,createdAt,mergedAt,headRefName \
    --limit 1000
else
  exec gh pr list --state merged \
    --json number,title,url,body,createdAt,mergedAt,headRefName \
    --limit 1000
fi
