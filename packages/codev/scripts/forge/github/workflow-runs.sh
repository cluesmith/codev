#!/bin/sh
# Forge concept: workflow-runs (GitHub via gh CLI) — Spec 1951
# Input: CODEV_WORKFLOW (workflow file name or name), CODEV_BRANCH
# Output: JSON [{headSha, status, conclusion, url, createdAt}], newest first
#         (WorkflowRunItem[] in forge-contracts.ts)
exec gh run list --workflow "$CODEV_WORKFLOW" --branch "$CODEV_BRANCH" --limit 50 \
  --json headSha,status,conclusion,url,createdAt
