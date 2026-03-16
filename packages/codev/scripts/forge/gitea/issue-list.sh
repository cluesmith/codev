#!/bin/sh
# Forge concept: issue-list (Gitea via tea CLI)
exec tea issues list --limit 200 --output json
