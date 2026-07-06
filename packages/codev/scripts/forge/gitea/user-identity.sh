#!/bin/sh
# Forge concept: user-identity (Gitea via tea CLI)
# Output: plain text username
#
# `tea whoami` has no `--output json` flag (its only documented option is
# --help), so it can't feed a jq pipeline. Route through the raw REST
# passthrough instead: `tea api user` returns the Gitea `User` object, whose
# `.login` is the authenticated username (mirrors `gh api user --jq .login`).
tea api user | jq -r ".login"
