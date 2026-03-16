#!/bin/sh
# Forge concept: auth-status (GitHub via gh CLI)
# Output: text + exit code (0 = authenticated)
exec gh auth status
