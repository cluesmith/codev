#!/bin/sh
# Forge concept: recently-closed (GitLab via glab CLI)
exec glab issue list --state closed --per-page 1000 --output json
