#!/bin/sh
# Refuse to build if `main` is checked out and behind `origin/main`.
# This prevents "build from stale source" bugs where someone forgets to
# `git pull` after a builder merges a PR and ships old code.
#
# Override: SKIP_GIT_FRESHNESS_CHECK=1 pnpm build

set -e

if [ "${SKIP_GIT_FRESHNESS_CHECK:-0}" = "1" ]; then
  exit 0
fi

# Only enforce on `main`. Other branches (worktrees, builder branches,
# release branches) build whatever's in the worktree by design.
BRANCH="$(git symbolic-ref --short -q HEAD || true)"
if [ "$BRANCH" != "main" ]; then
  exit 0
fi

# Don't fail if there's no `origin` remote (fresh clones, forks, etc).
if ! git remote get-url origin >/dev/null 2>&1; then
  exit 0
fi

git fetch --quiet origin main 2>/dev/null || exit 0

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse origin/main)"

if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

# Count how far behind we are. If we're ahead or diverged, that's fine —
# only fail when we're strictly behind.
BEHIND="$(git rev-list --count HEAD..origin/main)"
if [ "$BEHIND" = "0" ]; then
  exit 0
fi

echo "error: local main is $BEHIND commit(s) behind origin/main." >&2
echo "       Run 'git pull' before building, or set SKIP_GIT_FRESHNESS_CHECK=1 to override." >&2
exit 1
