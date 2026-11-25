#!/bin/sh
# Forge concept: pr-view (GitHub via gh CLI)
# Input: CODEV_PR_NUMBER, CODEV_INCLUDE_COMMENTS (optional, "1" to include)
# Output: JSON or text (with comments)
#
# headRefOid, isDraft, mergeable, mergeStateStatus, mergeCommit, mergedAt and reviewDecision are the
# optional PrViewResult fields `codev check` reads (Spec 1951).

if [ "$CODEV_INCLUDE_COMMENTS" = "1" ]; then
  exec gh pr view "$CODEV_PR_NUMBER" --comments
else
  exec gh pr view "$CODEV_PR_NUMBER" \
    --json title,body,state,url,author,baseRefName,headRefName,additions,deletions,headRefOid,isDraft,mergeable,mergeStateStatus,mergeCommit,mergedAt,reviewDecision
fi
