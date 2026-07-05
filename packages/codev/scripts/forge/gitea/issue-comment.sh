#!/bin/sh
# Forge concept: issue-comment (Gitea via tea CLI)
#
# `tea issues` has no `comment` subcommand; comments are managed under
# `tea comments` (`tea comments add <issue/pr index> <body>`).
exec tea comments add "$CODEV_ISSUE_ID" "$CODEV_COMMENT_BODY"
