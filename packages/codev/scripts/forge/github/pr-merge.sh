#!/bin/sh
# Forge concept: pr-merge (GitHub via gh CLI)
# Input: CODEV_PR_NUMBER
# Output: exit code only
exec gh pr merge "$CODEV_PR_NUMBER" --merge
