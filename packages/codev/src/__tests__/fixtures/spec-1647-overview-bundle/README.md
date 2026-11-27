# Spec 1647 fixtures: one recorded repository state

Used by `spec-1647-overview-bundle-script.test.ts` to prove that each section of the
`overview-bundle` script equals what its sibling concept script (`pr-list`, `issue-list`,
`recently-closed`, `recently-merged`) emits for the same repository state.

## How it was recorded

- **Repository:** `grafana/grafana` (public). This repository (`cluesmith/codev`) had no open
  bot-authored PR, no PR without a review decision, no issue with several assignees and no
  closed-unmerged PR in its window when the recording was made; grafana had all four.
- **When:** `recording.json` holds the instant (`recordedAt`), the window start
  (`sinceDate`, 36 h earlier, wide enough that the merged search overflows one page) and the
  gh version (2.102.0).
- **How:** with `GH_REPO=grafana/grafana`, a `gh` shim on `PATH` passed each call through to
  the real `gh` and saved its stdout. The real `overview-bundle.sh` ran first, then the four
  sibling commands, then the window evidence, back to back. Before trimming, all four bundle
  sections were checked equal to the siblings' outputs, so the two sides saw one state.

| file | captured from |
|---|---|
| `graphql-bundle.json` | the script's `OverviewBundle` request |
| `graphql-issues-page-2.json` | the script's `OverviewIssuesPage` request (cursor in `recording.json`) |
| `graphql-merged-page-2.json` | the script's `OverviewSearchPage` request for the merged search (cursor in `recording.json`) |
| `gh-pr-list.json` | `gh pr list --json number,title,url,reviewDecision,body,createdAt,author,reviewRequests,isDraft` |
| `gh-issue-list.json` | `gh issue list --limit 200 --json number,title,url,labels,createdAt,author,assignees` |
| `gh-recently-closed.json` | `gh issue list --state closed --search "closed:>$SINCE" --json number,title,url,labels,createdAt,closedAt --limit 1000` |
| `gh-recently-merged.json` | `gh pr list --state merged --search "merged:>$SINCE" --json number,title,url,body,createdAt,mergedAt,headRefName --limit 1000` |
| `window-closed-prs.json` | `gh pr list --state closed --search "closed:>$SINCE" --json number,state --limit 1000`: every PR closed in the window, merged or not |

## Trimming (applied identically to both sides)

- **Open PRs:** 6 of 30 kept: #139061 (bot author, `app/renovate-sh-app`), #139079 and
  #139078 (no review decision), #139057 (`APPROVED`), #139080 and #139086 (user review
  requests; drafts and non-drafts).
- **Open issues:** 3 from the first page and 3 from the second, keeping the real page
  boundary and cursor: multi-label issues and issues with 2, 3 and 5 assignees. The second
  page still reports `hasNextPage: true`, which is what makes "never a third page" a cap.
- **Searches:** complete, so the exclusion checks below see every result GitHub returned.
- **Bodies:** PR and merged-PR bodies cut to their first 40 characters, to keep the files
  small. Both sides pass `body` through unchanged, so the cut does not touch the mapping.

## Constructed cases (not observed live)

Each is an edit to a recorded node, made on both sides:

- **#139086** gains a team reviewer and a bot reviewer. GraphQL side:
  `{"requestedReviewer":{"__typename":"Team"}}` and `{"requestedReviewer":{"__typename":"Bot"}}`
  (the shape the script's query returns for them). gh side: the team as gh exports it
  (`{"__typename":"Team","name":…,"slug":…}`); the bot is absent, because gh's export keeps
  only `User` and `Team` reviewers. Both must be dropped.
- **#139078** has an absent author. GraphQL side: `"author": null`. gh side:
  `{"is_bot":true,"login":"app/"}`, which is how gh 2.102.0's `Author.MarshalJSON` renders an
  author with no user id.

## Search qualifiers

A fake `gh` cannot test search qualifiers: it returns whatever its fixture holds. The
filtering happens at GitHub, so the recording is the evidence. `window-closed-prs.json` lists
121 merged and 33 closed-unmerged PRs inside the window; the test asserts that none of them
is in `recentlyClosed` and that no closed-unmerged PR is in `recentlyMerged`.

The script searches with `type: ISSUE`, while gh 2.102.0 uses `ISSUE_ADVANCED` when the host
supports it. On 2026-11-27 both types returned identical results in identical order for these
qualifier-only queries (this repository, 7-day windows), and `ISSUE` also works on GitHub
Enterprise Server versions without advanced search.
