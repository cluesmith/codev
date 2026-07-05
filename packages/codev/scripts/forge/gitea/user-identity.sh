#!/bin/sh
# Forge concept: user-identity (Gitea via tea CLI)
#
# `tea whoami` has no `--output json` flag (any tea version — its only option is
# `--help`), so read the login from the REST API passthrough instead. Mirrors
# the github preset's `gh api user --jq .login`.
tea api user | jq -r ".login"
