#!/bin/sh
# Forge concept: recently-merged (GitLab via glab CLI)
exec glab mr list --state merged --per-page 1000 --output json
