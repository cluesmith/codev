#!/bin/sh
# Forge concept: pr-view (GitLab via glab CLI)
# Input: CODEV_PR_NUMBER
# Output: glab's merge-request JSON, passed through, plus the PrViewResult fields
#         (forge-contracts.ts) that GitLab names differently:
#   web_url                        -> url            (the MR's browser page)
#   description                    -> body ("" when GitLab sends null, as github/gitea do)
#   target_branch / source_branch  -> baseRefName / headRefName
#   sha                            -> headRefOid     (Spec 1951)
#   draft                          -> isDraft
#   merge_commit_sha // squash_commit_sha -> mergeCommit {oid}
#   merged_at                      -> mergedAt
#   detailed_merge_status          -> mergeable: conflict → CONFLICTING;
#                                       checking/unchecked/preparing → UNKNOWN;
#                                       anything else → MERGEABLE
#                                     mergeStateStatus: mergeable → CLEAN; else upper-cased
#   reviewDecision                 -> explicit null (GitLab has no single equivalent)
# A field glab does not supply is omitted, never invented.
#
# ⚠️ UNVERIFIED — `glab` is not available in the authoring environment; the field
#    names follow GitLab's documented merge-request API. Smoke-test before relying on it.
#
# Not `glab … | jq`: POSIX sh has no pipefail, so a failed glab would surface as jq's
# exit 0 on empty input (#1645). The capture hides glab from extractExecutable's
# first-line heuristic, so the backend is declared explicitly (#1455).
# forge-executable: glab
out="$(glab mr view "$CODEV_PR_NUMBER" --output json)" || exit 1
# An empty body at exit 0 would give jq nothing to work on: it would print nothing and
# exit 0, an ambiguous "success" with no data. Fail loudly instead, as gitea's script does.
if [ -z "$out" ]; then
  echo "gitlab forge: empty \`glab mr view\` response for merge request ${CODEV_PR_NUMBER}" >&2
  exit 1
fi
printf '%s' "$out" | jq '
  def str($v): ($v | type) == "string";
  . + {url: .web_url, reviewDecision: null}
  + {body: (if str(.description) then .description else "" end)}
  + (if str(.target_branch) then {baseRefName: .target_branch} else {} end)
  + (if str(.source_branch) then {headRefName: .source_branch} else {} end)
  + (if str(.sha) then {headRefOid: .sha} else {} end)
  + (if (.draft | type) == "boolean" then {isDraft: .draft} else {} end)
  + ((.merge_commit_sha // .squash_commit_sha) as $m
     | {mergeCommit: (if str($m) then {oid: $m} else null end)})
  + {mergedAt: (if str(.merged_at) then .merged_at else null end)}
  + (if str(.detailed_merge_status) then
       .detailed_merge_status as $s
       | {mergeable: (if $s == "conflict" then "CONFLICTING"
                      elif $s == "checking" or $s == "unchecked" or $s == "preparing" then "UNKNOWN"
                      else "MERGEABLE" end),
          mergeStateStatus: (if $s == "mergeable" then "CLEAN" else ($s | ascii_upcase) end)}
     else {} end)'
