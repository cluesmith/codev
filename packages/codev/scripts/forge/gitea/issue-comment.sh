#!/bin/sh
# Forge concept: issue-comment (Gitea via tea CLI)
# Input: CODEV_ISSUE_ID, CODEV_COMMENT_BODY
# Output: exit code only
#
# `tea issues` has no `comment` subcommand (its subcommands are list/create/
# edit/close). `tea comments add` only exists on tea 0.14.2+ and fails with
# "No help topic for comments" on the still-current 0.14.1 release. The
# top-level `tea comment` shorthand works on both 0.14.1 and 0.14.2+.
exec tea comment "$CODEV_ISSUE_ID" "$CODEV_COMMENT_BODY"
