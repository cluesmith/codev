#!/bin/sh
# Forge concept: recently-merged (Gitea via tea CLI)
exec tea pulls list --state closed --limit 1000 --output json
