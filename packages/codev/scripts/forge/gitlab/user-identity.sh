#!/bin/sh
# Forge concept: user-identity (GitLab via glab CLI)
glab auth status --show-token 2>&1 | grep "Logged in" | sed "s/.*as //" | sed "s/ .*//"
