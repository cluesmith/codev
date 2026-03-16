#!/bin/sh
# Forge concept: pr-merge (Gitea via tea CLI)
exec tea pulls merge "$CODEV_PR_NUMBER"
