#!/bin/sh
# Forge concept: issue-comment (Gitea via tea CLI)
# Input: CODEV_ISSUE_ID, CODEV_COMMENT_BODY
# Output: exit code only
#
# `tea issues` has no `comment` subcommand (its subcommands are list/create/
# edit/close). Commenting lives under the top-level `tea comments add`.
exec tea comments add "$CODEV_ISSUE_ID" "$CODEV_COMMENT_BODY"
