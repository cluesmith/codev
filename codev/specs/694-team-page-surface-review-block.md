# Specification: Team page — surface review-blocking relationships

## Metadata
- **ID**: spec-2026-04-21-team-page-review-blocking
- **Status**: draft
- **Created**: 2026-04-21
- **GitHub Issue**: #694
- **Related Specs**: 587 (original team tab), 650 (team page issue/PR detail)

## Clarifying Questions Asked
The GitHub issue for #694 is detailed and self-contained. The spec author (Waleed) already made the key decisions:
- **Q: Who is the audience?** A: Lead Architect (Waleed) and team members who need to see who is blocking whom on reviews.
- **Q: What sentence format?** A: "`<Author> is waiting for <Reviewer> to review` `<PR link>`".
- **Q: Which members?** A: Only people listed in `codev/team/people/*.md`. External reviewers are excluded.
- **Q: How is "waiting" determined?** A: Use each PR's `reviewRequests` and `reviewDecision` so we don't claim someone is "waiting" on a PR that's already approved.
- **Q: Drafts?** A: Out of scope.
- **Q: CI / merge-conflict blocking?** A: Out of scope. Review blocking only.

Open interpretation questions that this spec answers definitively below:
- What does "waiting on X" mean operationally (see [Review-Blocking Semantics](#review-blocking-semantics)).
- Should the same relationship appear on both cards (author's and reviewer's)? Yes — both directions (see success criteria).

## Problem Statement

The team tab in Tower's right panel currently shows each member's own work (assigned issues, authored open PRs, recent merged PRs, recent closed issues). It does **not** show who is blocking whom on reviews.

As a result, the Lead Architect has no quick way to see "Amr is waiting for me to review PR #688" without manually scanning GitHub. Team members similarly have no at-a-glance view of what reviews they owe or are waiting on from teammates.

This creates two visible pains:
1. **Reviews silently queue up.** PRs sit in a reviewer's queue without any ambient reminder in the tools the team already uses.
2. **Authors don't know who to ping.** Authors need to open GitHub and cross-reference requested reviewers against who is a teammate vs. who is external.

## Current State

The team tab in Tower's right panel renders, per member:
- **Working on** — assigned GitHub issues (number, title, link).
- **Open PRs** — PRs authored by the member (number, title, link).
- **Recent activity** — merged PRs and closed issues in the last 7 days.

The `/api/team` endpoint (`packages/codev/src/agent-farm/servers/tower-routes.ts`) returns this shape by calling `handleWorkspaceTeam()`, which in turn uses a batched GraphQL query built in `packages/codev/src/lib/team-github.ts` and executed by the `team-activity` forge concept.

**Neither `reviewRequests` nor `reviewDecision` is queried today.** The only PR fields pulled are `number`, `title`, `url`, and (for recent merged) `mergedAt`. Without those fields, it is impossible to know whether a PR is waiting on a team member, already approved, or in `CHANGES_REQUESTED`.

As of writing (2026-04-21), Amr has two open PRs authored by him that are implicitly waiting on Waleed's review — but nothing in the team tab reflects that relationship:
- #688 — chore: consolidate local-install flow into a single shell script
- #682 — fix + feat: surface activation failures; builder terminal lifecycle improvements

## Desired State

Each team member's card on the team tab surfaces review-blocking sentences in **both directions**:

**On the author's card** (showing PRs the member is waiting on someone to review):
> You're waiting for **Waleed** to review [#688 chore: consolidate local-install flow into a single shell script](…)

**On the reviewer's card** (showing PRs authored by others that this member has been asked to review):
> **Amr** is waiting for you to review [#688 chore: consolidate local-install flow into a single shell script](…)

The sentences are grouped into a dedicated section on each card (distinct from "Open PRs" and "Working on") and are human-readable — they use `<name>` rather than `<github-handle>`, and the PR number + title linkify to GitHub.

When a PR is not blocked on any team member (approved, or only external reviewers requested, or draft), it does not appear in this section.

## Stakeholders

- **Primary Users**: Lead Architect (Waleed) and active team reviewers who need to see review-blocking state without leaving Tower.
- **Secondary Users**: PR authors on the team, who benefit from seeing "who am I waiting on" surfaced.
- **Technical Team**: Anyone extending the team tab or the `team-github` enrichment layer.
- **Business Owners**: Waleed (as project owner / architect of Codev).

## Success Criteria

- [ ] The team tab's member cards render review-blocking sentences of the form "**`<Author>` is waiting for `<Reviewer>` to review** `<PR link>`" (or the second-person variant on the subject's own card).
- [ ] Each blocking relationship appears **on both cards** (the author's card and the reviewer's card), with the sentence subject/object swapped appropriately (second-person on the subject's own card).
- [ ] Only team members present in `codev/team/people/*.md` are counted as reviewers. External reviewers on a PR do not generate sentences.
- [ ] A PR with `reviewDecision = APPROVED` does not appear, even if a team member is still listed in `reviewRequests`.
- [ ] A PR in draft status does not appear.
- [ ] A PR with no requested reviewers (or only external requested reviewers) does not appear.
- [ ] When no review-blocking relationships exist for a member (in either direction), the section is either omitted or shows a clear empty state — no dangling headers with empty bodies.
- [ ] Existing team tab data (assigned issues, open PRs, recent activity, messages) continues to render correctly — this is additive, not a replacement.
- [ ] Unit tests cover the review-blocking-relationship derivation: the rules for inclusion/exclusion above.
- [ ] Documentation updated: the team tab section in any user-facing docs mentions the new review-blocking block.

## Constraints

### Technical Constraints
- **GraphQL query budget.** The existing query is already batched across all members. New fields (`reviewRequests`, `reviewDecision`, `isDraft`) must be added without breaking the batched shape or exceeding GitHub's query complexity limits.
- **Forge concept boundary.** The `team-activity` forge concept is a thin shell wrapper around `gh api graphql`. All query-building logic must stay in `team-github.ts` on the Node side.
- **Shared types.** `TeamMemberGitHubData` in `packages/types/src/api.ts` is the canonical wire type; any new field is a breaking change that must be reflected in both backend and dashboard.
- **No new GitHub permissions.** The existing `gh` CLI token must be sufficient; `reviewRequests` and `reviewDecision` are readable with standard repo read scope.
- **Team roster is a file on disk.** The set of "team members" is what `loadTeamMembers()` returns — no dynamic API, no org membership queries.

### Business Constraints
- Additive change — must not regress the existing team tab behaviour.
- No new external services or paid APIs.

## Assumptions

- GitHub's `pullRequest.reviewRequests` GraphQL field reflects *currently requested* reviewers: when a reviewer submits an approval or requests changes, they are removed from `reviewRequests`. This is standard GitHub behaviour; the implementation should verify it on a sample PR before finalising logic.
- `reviewDecision` is a reliable aggregate signal across the PR, with values `REVIEW_REQUIRED`, `APPROVED`, `CHANGES_REQUESTED`, or null for PRs without any requested reviewers.
- A "team member" is matched by the `github` field in `codev/team/people/*.md` YAML frontmatter — case-insensitive string match against the GitHub login returned by the API.
- The PR author is always available via `pullRequest.author.login`; the team tab only renders sentences for PRs authored by a team member (since external-authored PRs don't appear on any team card today anyway).

## Review-Blocking Semantics

This section pins down the rules precisely so the plan and implementation have no ambiguity.

**A PR generates a "waiting-for-review" relationship** `(author → reviewer)` if and only if **all of the following** are true:

1. The PR is **open** (not merged, not closed).
2. The PR is **not a draft** (`isDraft = false`).
3. The PR's `reviewDecision` is **not** `APPROVED`. (It may be `REVIEW_REQUIRED`, `CHANGES_REQUESTED`, or null.)
4. The PR's `author.login` matches a team member (case-insensitive).
5. The reviewer's login appears in the PR's `reviewRequests` **and** matches a team member (case-insensitive).

**Exclusion notes:**
- If a PR has team member Y in `reviewRequests` and no team member author, it does not appear (no "author side" to render). The issue framing is about *team* relationships; both ends must be on the team.
- `CHANGES_REQUESTED` state: the reviewer who requested changes is removed from `reviewRequests` by GitHub, so they are not shown as "waiting" — consistent with reality (the PR is now waiting on the author).
- Multiple requested reviewers on one PR → generate one relationship per requested team-member reviewer.

**Rendering:**
- On the **author's** card: "You're waiting for **`<Reviewer name>`** to review [#N title]".
- On the **reviewer's** card: "**`<Author name>`** is waiting for you to review [#N title]".
- Names are taken from the `name:` YAML field in the `codev/team/people/<handle>.md` file. GitHub handle is the fallback if `name` is missing.
- Multiple relationships on the same card are listed; optionally sort by PR age (oldest first) so stale reviews surface. (See open questions.)

## Solution Approaches

### Approach 1: Extend the existing GraphQL query in place
**Description**: Add `reviewRequests { nodes { requestedReviewer { ... on User { login } } } }`, `reviewDecision`, and `isDraft` to the existing per-member `openPRs` fragment. Derive relationships server-side in `team-github.ts`, attaching a new `reviewBlocking` array to each member's `github_data`. Dashboard reads this array.

**Pros**:
- One query, one round-trip.
- No duplication — relationships are derived once in a single place (server).
- Wire type stays simple: a new array alongside the existing ones.

**Cons**:
- Requires a shape change to `TeamMemberGitHubData` and coordinated updates to backend + dashboard + tests.
- GraphQL complexity grows; need to verify we stay under GitHub's complexity budget for workspaces with many team members.

**Estimated Complexity**: Medium
**Risk Level**: Low

### Approach 2: Second, separate query just for review requests
**Description**: Keep the existing team query unchanged. Issue a second batched query that searches per team member for open, non-draft PRs where they are the reviewer, returning author + review state. Merge the two result sets in `handleWorkspaceTeam()`.

**Pros**:
- Isolation — existing query stays untouched; review-blocking logic is modular.
- Easier to disable independently if GitHub API limits become a concern.

**Cons**:
- Two round-trips instead of one.
- Duplicated data (PR metadata appears in both queries), requiring dedup logic.
- More code to maintain.

**Estimated Complexity**: Medium-High
**Risk Level**: Low-Medium

### Approach 3: Derive entirely client-side from existing data
**Description**: Leave the API unchanged. Pull `reviewRequests` / `reviewDecision` as part of a new field on existing `openPRs` results; the dashboard computes relationships itself.

**Pros**:
- No new array on the wire — just new fields on each PR object.

**Cons**:
- Duplicates relationship logic in the UI (the dashboard has to iterate every member's PRs to discover "Waleed is a requested reviewer on Amr's PR #688" and then render it on Waleed's card too).
- Cross-member data stitching in the UI is error-prone and doesn't match how the rest of the team tab works.

**Estimated Complexity**: Medium
**Risk Level**: Medium

**Recommended**: Approach 1. It keeps the single-query model, derives once on the server where all team-member context is available, and surfaces the relationships as a clean wire-level array.

## Open Questions

### Critical (Blocks Progress)
- None. The issue description and this spec cover the decisions needed to plan.

### Important (Affects Design)
- [ ] Should the review-blocking section have a **PR age** indicator (e.g., "3d waiting")? Optional but mentioned as a likely-useful cue. **Proposal:** include a simple relative-age label per entry.
- [ ] Sort order of entries within the section — by PR age (oldest first, most stale) or by PR number? **Proposal:** oldest first (most stale first) to surface attention-worthy reviews.

### Nice-to-Know (Optimization)
- [ ] If a PR has `reviewDecision = CHANGES_REQUESTED` and the author has pushed new commits since, could we surface "Waleed requested changes, now waiting on Amr"? Out of scope for this feature; note as possible future enhancement.
- [ ] Team-level aggregate ("Team has N review-blocking relationships") as a header summary? Out of scope; could be a follow-up.

## Performance Requirements

- **GraphQL response time**: The existing team query budget is ~1–3s end-to-end. Adding review fields should not more than double query complexity; p95 should remain under 5s with up to 20 team members.
- **Payload size**: Adding review-blocking relationships adds at most `O(open PRs with team reviewers)` entries per member — expected low single digits in practice.
- **UI render**: No measurable regression on team tab render time.

## Security Considerations

- **Data scope**: Only data the user's `gh` token already has access to is surfaced. Review requests on private PRs are only visible if the token can read the repo.
- **No new auth surface**: Uses the existing GitHub CLI token flow; no new secrets.
- **No PII beyond what's already shown**: GitHub handles and display names from the team roster — identical to what the current team tab already shows.

## Test Scenarios

### Functional Tests
1. **Happy path — team reviewer requested**: Amr authors PR #N; Waleed is in `reviewRequests`; `reviewDecision = REVIEW_REQUIRED`. Assert the relationship appears on both cards (Amr: "waiting for Waleed", Waleed: "Amr is waiting for you").
2. **Approved PR**: Same as above but `reviewDecision = APPROVED`. Assert no sentence is rendered on either card.
3. **Changes requested**: `reviewDecision = CHANGES_REQUESTED`; Waleed already reviewed and is no longer in `reviewRequests`. Assert no sentence is rendered.
4. **Draft PR**: PR is draft; Waleed is in `reviewRequests`. Assert no sentence is rendered.
5. **External reviewer only**: PR's `reviewRequests` contains only a non-team-member login. Assert no sentence is rendered on any team card.
6. **Multiple team reviewers**: PR has two team members in `reviewRequests`. Assert both see the sentence on their respective cards, and the author sees two sentences.
7. **Multiple blocked PRs**: An author has three PRs each waiting on a different team reviewer. Assert three sentences on the author's card.
8. **No review-blocking work**: Member has no authored PRs awaiting team review and no review requests on other teammates' PRs. Assert the section is omitted (or shows an appropriate empty state — whichever is chosen in the plan).
9. **Case mismatch on GitHub login**: Team roster has `github: waleedkadous` but API returns `WaleedKadous`. Assert the match succeeds and the sentence renders.

### Non-Functional Tests
1. **GraphQL response schema**: Validate the new fields (`reviewRequests`, `reviewDecision`, `isDraft`) are present and correctly typed in the response parser.
2. **Missing data fallback**: If GitHub query fails or a member has `github_data: null`, the team tab still renders (existing behaviour preserved) and no review-blocking section appears for that member.
3. **Type safety**: `TeamMemberGitHubData` wire type changes pass type-check across backend, dashboard, and any consumers.

## Dependencies

- **External Services**: GitHub GraphQL API (via `gh api graphql` through the `team-activity` forge concept).
- **Internal Systems**:
  - `packages/codev/src/lib/team-github.ts` — GraphQL query builder + response parser.
  - `packages/codev/src/agent-farm/servers/tower-routes.ts` — `/api/team` handler.
  - `packages/types/src/api.ts` — `TeamMemberGitHubData` wire type.
  - `packages/dashboard/src/components/TeamView.tsx` — `MemberCard` rendering.
  - `codev/team/people/*.md` — team roster source of truth.
- **Libraries/Frameworks**: None new. Existing React, TypeScript, `gh` CLI, Vitest.

## References

- GitHub Issue #694 — "Team page: surface review-blocking relationships (Amr is waiting for Waleed to...)"
- `codev/specs/587-team-tab-in-tower-right-panel.md` — original team tab spec
- `codev/specs/650-team-page-show-issue-pr-detail.md` — recent team-tab enhancement (issue/PR detail)
- GitHub GraphQL docs: `PullRequest.reviewRequests`, `PullRequest.reviewDecision`, `PullRequest.isDraft`

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|---------------------|
| GraphQL complexity limits exceeded for large teams | Low | Medium | Measure query complexity in dev; if an issue, fall back to Approach 2 (second query) |
| `reviewRequests` semantics differ from assumption (e.g., still lists reviewer after approval) | Low | Medium | Validate on a live PR during implementation; adjust rules to incorporate `reviewDecision` as authoritative |
| Wire type change breaks unknown downstream consumer | Low | Low | `TeamMemberGitHubData` is internal; changes are additive (new array field); type-check catches mismatches |
| UI clutter on member cards with many relationships | Medium | Low | Cap visible entries (e.g., top 5) with a "+N more" link, or rely on natural list length |
| Empty state noise (section with zero rows) | Medium | Low | Omit the section entirely when empty, or render a subtle "No reviews blocking" line — decide in plan phase |

## Expert Consultation
<!-- Populated by porch-orchestrated 3-way consultation (Gemini, Codex, Claude) -->

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [ ] Expert AI Consultation Complete

## Notes

- This feature is intentionally small and additive. It reuses the existing team tab infrastructure, adds three new fields to the existing GraphQL query, and derives one new array on the wire. No new protocols, no new services, no new UI sections elsewhere in Tower.
- The "you're waiting for X / X is waiting for you" second-person framing on the subject's own card is a conscious product choice — it makes the card actionable ("do something about these") rather than descriptive.

---

## Amendments

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
