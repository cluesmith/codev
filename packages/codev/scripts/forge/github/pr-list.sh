#!/bin/sh
# Forge concept: pr-list (GitHub via gh CLI)
# Output: JSON [{number, title, url, reviewDecision, body, createdAt, author}]
exec gh pr list --json number,title,url,reviewDecision,body,createdAt,author
