#!/bin/sh
# Forge concept: rate-limit (GitHub via gh CLI)
# Output: JSON {limit, remaining, used, reset} for the GraphQL budget.
# REST endpoint — costs nothing against the GraphQL budget it reports on.
exec gh api rate_limit --jq .resources.graphql
