#!/bin/sh
# Forge concept: recently-merged (Gitea via tea CLI)
#
# `tea pulls list --state closed` returns both merged and closed-without-merge
# pulls. In the CLI's flattened list output a merged pull is reported as
# state="merged" (there is no `.merged` boolean), and `head` is the branch-name
# STRING (not a {ref} object). Filter to merged, then map to the
# GitHub-compatible shape (see MergedPrItem in forge-contracts.ts):
#   index    -> number (int)
#   created  -> createdAt
#   updated  -> mergedAt  (tea exposes no merged_at field via --fields;
#                          close-then-edit overestimates merged time but is
#                          acceptable for the 24h overview window)
#   head     -> headRefName
#   body     -> ""  (`tea pulls list` exposes no body/description field)
exec tea pulls list --state closed --limit 1000 \
  --fields index,title,state,author,url,created,updated,head \
  --output json \
  | jq '[.[] | select(.state == "merged") | {
      number: (.index | tonumber),
      title,
      state,
      url,
      body: "",
      createdAt: .created,
      mergedAt: .updated,
      headRefName: (.head // "")
    }]'
