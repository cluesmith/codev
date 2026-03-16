#!/bin/sh
# Forge concept: user-identity (Gitea via tea CLI)
tea whoami --output json | jq -r ".login"
