#!/bin/sh
# Forge concept: user-identity (GitHub via gh CLI)
# Output: plain text username
exec gh api user --jq .login
