#!/bin/sh
# Forge concept: recently-closed (GitHub via gh CLI)
# Input: CODEV_SINCE_DATE (optional, ISO date)
# Output: JSON [{number, title, url, labels, createdAt, closedAt}]

if [ -n "$CODEV_SINCE_DATE" ]; then
  exec gh issue list --state closed \
    --search "closed:>$CODEV_SINCE_DATE" \
    --json number,title,url,labels,createdAt,closedAt \
    --limit 1000
else
  exec gh issue list --state closed \
    --json number,title,url,labels,createdAt,closedAt \
    --limit 1000
fi
