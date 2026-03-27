#!/bin/sh
# Forge concept: issue-list (GitHub via gh CLI)
# Output: JSON [{number, title, url, labels, createdAt, author}]
exec gh issue list --limit 200 --json number,title,url,labels,createdAt,author
