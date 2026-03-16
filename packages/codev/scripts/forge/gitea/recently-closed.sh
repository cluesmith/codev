#!/bin/sh
# Forge concept: recently-closed (Gitea via tea CLI)
exec tea issues list --state closed --limit 1000 --output json
