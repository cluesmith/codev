# Plan: Team page — surface review-blocking relationships

## Metadata
- **ID**: plan-2026-04-21-team-page-review-blocking
- **Status**: draft
- **Specification**: [codev/specs/694-team-page-surface-review-block.md](../specs/694-team-page-surface-review-block.md)
- **Created**: 2026-04-21
- **GitHub Issue**: #694

## Executive Summary

Implements **Approach 1** from the spec: extend the existing batched GraphQL query in `packages/codev/src/lib/team-github.ts` with four new fields on the per-member `openPRs` fragment (`isDraft`, `createdAt`, `reviewDecision`, `reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }`). Derive review-blocking relationships on the server using a two-pass parse that iterates every team member's authored PRs, then emits one entry into each affected member's new `reviewBlocking` array (author + each requested team-member reviewer). The dashboard's `MemberCard` renders the entries as second-person sentences with a relative-age label; the section is omitted entirely when empty.

This is deliberately small and additive — no new services, no new protocols, and one new wire-type field that is backwards-compatible for the VS Code extension consumer.

## Success Metrics

Copied from the spec's Success Criteria and augmented with implementation-specific checks:

- [ ] Review-blocking sentences render on member cards in the form "**`<Author>` is waiting for `<Reviewer>` to review** `<PR link>`" (second-person variant on the subject's own card).
- [ ] Each relationship appears on **both** cards (author + reviewer).
- [ ] Only members in `codev/team/people/*.md` generate sentences; external reviewers and `Team`-based review requests are silently skipped.
- [ ] `APPROVED`, draft, and "no team reviewer requested" PRs do not appear.
- [ ] Empty section is omitted (no dangling header).
- [ ] Existing team tab behaviour (assigned issues, open PRs, recent activity, messages) is unchanged.
- [ ] Unit tests cover the 12 scenarios from the spec's Test Scenarios section.
- [ ] Playwright E2E team-tab test covers at least one render of the new section.
- [ ] `packages/vscode/src/views/team.ts` continues to compile against the updated wire type (no code change required — additive field).
- [ ] `pnpm build`, `pnpm test`, and the type-check pipeline all pass.
- [ ] Zero new lint warnings.

## Phases (Machine Readable)

<!-- REQUIRED: porch uses this JSON to track phase progress. Update this when adding/removing phases. -->

```json
{
  "phases": [
    {"id": "phase_1_wire_type", "title": "Extend wire type with reviewBlocking array"},
    {"id": "phase_2_query_and_parser", "title": "Extend GraphQL query and add two-pass relationship derivation"},
    {"id": "phase_3_dashboard_ui", "title": "Render review-blocking section in MemberCard"},
    {"id": "phase_4_e2e_and_docs", "title": "Add E2E coverage and update docs"}
  ]
}
```

## Phase Breakdown

---

### Phase 1: Extend wire type with `reviewBlocking` array
**Dependencies**: None

#### Objectives
- Add the new `reviewBlocking` entry shape to `TeamMemberGitHubData` in both code locations (canonical + internal duplicate).
- Establish the wire contract so subsequent phases have a stable type to target.

#### Deliverables
- [ ] Update canonical `TeamMemberGitHubData` in `packages/types/src/api.ts` — add `reviewBlocking: ReviewBlockingEntry[]` and define `ReviewBlockingEntry`.
- [ ] Update internal duplicate in `packages/codev/src/lib/team-github.ts` to match.
- [ ] Both types stay byte-for-byte identical (same field order, same shape).
- [ ] Type-check passes across all packages.

#### Implementation Details

New exported type in `packages/types/src/api.ts`:

```typescript
export interface ReviewBlockingEntry {
  /** 'authored' = viewer is the author, waiting on reviewer.
   *  'reviewing' = viewer is the reviewer, author is waiting on them. */
  direction: 'authored' | 'reviewing';
  /** Display name of the OTHER party (pre-resolved from codev/team/people/*.md).
   *  If author, this is the reviewer's display name. If reviewing, the author's. */
  otherName: string;
  /** GitHub handle of the other party (for debugging / aria labels). */
  otherGithub: string;
  /** PR metadata. */
  pr: {
    number: number;
    title: string;
    url: string;
    /** ISO 8601 timestamp. Used to render relative-age labels and sort oldest-first. */
    createdAt: string;
  };
}
```

Extend `TeamMemberGitHubData` in both locations:

```typescript
export interface TeamMemberGitHubData {
  assignedIssues: { number: number; title: string; url: string }[];
  openPRs: { number: number; title: string; url: string }[];
  recentActivity: {
    mergedPRs: { number: number; title: string; url: string; mergedAt: string }[];
    closedIssues: { number: number; title: string; url: string; closedAt: string }[];
  };
  /** Review-blocking relationships involving this member, oldest-first. */
  reviewBlocking: ReviewBlockingEntry[];
}
```

The field is **required** (not optional) to force subsequent phases to populate it — but the parser will emit an empty array when there are no relationships, which the UI omits rather than renders.

**Backwards compatibility note**: The field is additive. VS Code extension (`packages/vscode/src/views/team.ts`) reads `github_data` as `TeamApiMember['github_data']` but only references `assignedIssues`, `openPRs`, and `recentActivity` — adding a new field does not break its compile or runtime behaviour.

#### Acceptance Criteria
- [ ] `pnpm --filter @cluesmith/codev-core build` succeeds.
- [ ] `pnpm --filter @cluesmith/codev build` succeeds (uses the shared type).
- [ ] `pnpm --filter @cluesmith/codev-dashboard build` succeeds.
- [ ] Both `TeamMemberGitHubData` definitions match.

#### Test Plan
- **Unit Tests**: No new tests in this phase — the type change is exercised by subsequent phases.
- **Integration Tests**: The existing type-check pipeline catches any consumer breakage.
- **Manual Testing**: Confirm `pnpm build` from the repo root succeeds.

#### Rollback Strategy
Revert the type additions. Because the field is additive and unreferenced elsewhere until later phases, this is a clean revert.

#### Risks
- **Risk**: Duplicate type drifts between the two files.
  - **Mitigation**: Keep this phase's diff to exactly the same field and shape in both files; add a comment in `team-github.ts` reminding future editors to sync with the canonical type.

---

### Phase 2: Extend GraphQL query and add two-pass relationship derivation
**Dependencies**: Phase 1

#### Objectives
- Pull the new PR fields from GitHub.
- Derive `reviewBlocking` entries in the server-side parser and distribute them to both author and reviewer.
- Cover every inclusion/exclusion rule from the spec with unit tests.

#### Deliverables
- [ ] Extend `buildTeamGraphQLQuery` in `packages/codev/src/lib/team-github.ts` to add `isDraft`, `createdAt`, `reviewDecision`, and `reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }` to the `openPRs` PR fragment only (other fragments remain unchanged).
- [ ] Add a new exported helper `deriveReviewBlocking(parsedPrsByMember, members)` (pure function) that implements the two-pass algorithm.
- [ ] Wire it into `parseTeamGraphQLResponse` so every returned `TeamMemberGitHubData` includes the new array.
- [ ] Sort each member's `reviewBlocking` array by PR `createdAt` ascending (oldest first).
- [ ] Add tests in `packages/codev/src/__tests__/team-github.test.ts` covering the 12 scenarios from the spec.

#### Implementation Details

**GraphQL fragment change** — only the `${alias}_prs` search is extended:

```graphql
${alias}_prs: search(query: "repo:${repo} author:${m.github} is:pr is:open", type: ISSUE, first: 20) {
  nodes {
    ... on PullRequest {
      number
      title
      url
      isDraft
      createdAt
      reviewDecision
      reviewRequests(first: 20) {
        nodes {
          requestedReviewer {
            ... on User { login }
          }
        }
      }
    }
  }
}
```

**Two-pass algorithm** (`deriveReviewBlocking`):

1. **Pass 1 — collect**: For each team member (author), iterate their parsed PRs. For each PR that satisfies all inclusion rules (open, not draft, `reviewDecision !== 'APPROVED'`), extract the requested reviewers whose `login` matches a team member (case-insensitive).
2. **Pass 2 — distribute**: For each (author, reviewer, pr) tuple:
   - Add an `authored` entry to the author's `reviewBlocking` (`otherName` = reviewer's display name).
   - Add a `reviewing` entry to the reviewer's `reviewBlocking` (`otherName` = author's display name).

**Edge-case handling** (matching spec test scenarios):
- **Team-based review requests** (where `requestedReviewer` has no `login` because it's a Team, not a User): skipped silently. The GraphQL fragment uses `... on User { login }`, so a Team resolves to `{ login: undefined }` or similar; treat as "no match".
- **Case-insensitive match**: Compare `login.toLowerCase()` against `team-member.github.toLowerCase()`.
- **Display name fallback**: If the team roster has no `name` field for a member, fall back to the github handle.
- **Author is not a team member**: Impossible here because the GraphQL query is scoped to `author:${m.github}` for each team member — every PR in the response is team-authored by construction. Still, guard against a null `author` defensively.
- **`APPROVED` with stale `reviewRequests`**: Rule 3 excludes `APPROVED` outright, so stale entries never render.

**Sort**: Stable sort by `createdAt` ascending (oldest first). Ties broken by PR number ascending for determinism.

**Error handling**: If GitHub omits any of the new fields (e.g., API quirk), treat as "no relationship" — do not throw. The existing graceful-degradation envelope in `fetchTeamGitHubData` already catches unhandled errors.

#### Acceptance Criteria
- [ ] Every test scenario from the spec (1–12) has a corresponding `it(...)` case.
- [ ] `pnpm test` passes in `@cluesmith/codev`.
- [ ] No mutation of input member/PR data (pure function).
- [ ] Query string contains `isDraft`, `createdAt`, `reviewDecision`, and `reviewRequests(first: 20)` — verified with a `toContain` assertion.

#### Test Plan
- **Unit Tests** (in `packages/codev/src/__tests__/team-github.test.ts`):
  - `describe('buildTeamGraphQLQuery')` — add one `it` asserting the four new fields appear in the `openPRs` fragment only.
  - `describe('deriveReviewBlocking')` — twelve `it` cases, one per spec test scenario (happy path; APPROVED; CHANGES_REQUESTED with requester removed; draft; external-only reviewer; multiple team reviewers; multiple blocked PRs; no relationships; case mismatch; mixed CHANGES_REQUESTED + still-pending; Team-based requestedReviewer; empty-state).
  - `describe('parseTeamGraphQLResponse')` — add one `it` confirming `reviewBlocking` is populated end-to-end from a mocked GraphQL response, sorted oldest-first.
- **Integration Tests**: None new; existing `team-tab.test.ts` runs in a later phase.
- **Manual Testing**: Against the live repo, run Tower locally and confirm Amr/Waleed's cards show the expected sentences for PRs #688 and #682.

#### Rollback Strategy
Revert the `team-github.ts` changes and the corresponding tests. Wire-type from Phase 1 remains but is unused (empty array populated). UI phase hasn't landed yet, so no user-visible impact.

#### Risks
- **Risk**: GraphQL query complexity exceeds GitHub's limit for large teams.
  - **Mitigation**: `reviewRequests(first: 20)` adds a bounded connection per PR. With the existing 20-PR-per-member cap, the worst case is `members × 20 × 20` = 400 reviewer lookups per member. For teams of 4–10, this is well under GitHub's 500,000-point complexity budget. Monitor in manual testing; if exceeded, reduce `first` to 10 or split into a second query (Approach 2 from the spec).
- **Risk**: `requestedReviewer` resolving to `Team` produces `null` `login` but still appears as a node — need to filter, not throw.
  - **Mitigation**: Filter with `r.requestedReviewer?.login` guard in the derivation.

---

### Phase 3: Render review-blocking section in `MemberCard`
**Dependencies**: Phase 2

#### Objectives
- Add the new section to each member card.
- Use second-person phrasing on the subject's own card.
- Show relative-age labels; omit the section entirely when there are zero entries.

#### Deliverables
- [ ] Add a `ReviewBlockingSection` component (inline or extracted) in `packages/dashboard/src/components/TeamView.tsx` rendered inside `MemberCard` between "Open PRs" and the activity footer.
- [ ] Add a small helper `relativeAge(iso: string): string` producing "3d waiting", "5h waiting", etc. (reuse or extract from the existing `relativeDate` helper if symmetric).
- [ ] Wire CSS styles (append to the existing Tower stylesheet used by `team-member-*` classes) for `team-review-blocking-*` classes.
- [ ] Update `useTeam.ts` only if its type derivation needs attention (expected: no change — it passes `TeamApiMember` through).

#### Implementation Details

**Component placement**: Inside the existing `{gh && (...)}` conditional in `MemberCard`, after the "Open PRs" section, before the activity footer. The section renders only when `gh.reviewBlocking.length > 0`.

**Sentence rendering**:
- `direction === 'authored'`: "You're waiting for **`<otherName>`** to review [#N title]"
- `direction === 'reviewing'`: "**`<otherName>`** is waiting for you to review [#N title]"

**Age label**: Right-aligned subtle text, e.g., "3d waiting". Derived from `entry.pr.createdAt` via a `relativeAge` helper that mirrors the existing `relativeDate` but with a "waiting" suffix.

**Linkification**: The PR portion `[#N title]` is an `<a>` that opens in a new tab, matching the existing open-PR link pattern.

**Accessibility**: Use semantic markup — a `<ul>` of `<li>` entries inside a labelled section. Each link has `rel="noopener noreferrer"` (matching existing pattern).

**Ordering**: Already sorted server-side (oldest first); the UI renders `entry` order as-is.

**No cap on visible entries** for v1. The spec notes a future option to cap at 5+"more" — deferring to a follow-up.

**Empty state**: If `reviewBlocking` is an empty array, do not render the section at all (no header, no placeholder line). Per the spec's resolved UX decision.

#### Acceptance Criteria
- [ ] Tower dev server starts and the team tab renders without regressions.
- [ ] When the API returns `reviewBlocking` entries, each renders with the correct sentence form and link.
- [ ] Empty state case: a member with `reviewBlocking: []` shows no review-blocking header.
- [ ] `authored` vs `reviewing` directions render the correct sentence.
- [ ] Age label updates sensibly (a 3-day-old `createdAt` shows "3d waiting").
- [ ] Existing sections (Working on, Open PRs, recent activity) remain visually unchanged.
- [ ] Playwright team-tab test still passes (see Phase 4 for new assertion).

#### Test Plan
- **Unit Tests**: None added in this phase for the React component itself (the dashboard has no component tests today; adding Vitest + RTL setup is out of scope). The logic is simple rendering over data that's already unit-tested upstream.
- **Integration Tests**: Extended in Phase 4 (Playwright E2E).
- **Manual Testing** (MANDATORY per CLAUDE.md — UI code must be tested in a browser):
  1. Run `pnpm local-install` + restart Tower.
  2. Open Tower, navigate to the team tab in the right panel.
  3. Verify Amr's card shows "You're waiting for Waleed to review #688 …" (assuming #688 is still open and Waleed is a requested reviewer).
  4. Verify Waleed's card shows "Amr is waiting for you to review #688 …".
  5. Verify a member with no review-blocking entries shows no dangling section.
  6. Verify links open GitHub in new tabs.

#### Rollback Strategy
Revert the `TeamView.tsx` changes. API still returns `reviewBlocking` but nothing renders it — zero user impact.

#### Risks
- **Risk**: CSS regressions leak into adjacent Tower panels.
  - **Mitigation**: Scope new class names under `team-member-card` and reuse the existing section class pattern (`team-member-section`, `team-section-label`).
- **Risk**: Relative-age helper produces awkward output for very fresh PRs (<1h).
  - **Mitigation**: Fall back to "just now" or "<1h waiting" for sub-hour values.

---

### Phase 4: E2E coverage and docs
**Dependencies**: Phase 3

#### Objectives
- Guard the new rendering against future regressions with an E2E assertion.
- Update any user-facing docs that describe the team tab.

#### Deliverables
- [ ] Add one assertion to `packages/codev/src/agent-farm/__tests__/e2e/team-tab.test.ts` that mocks a team API response with a `reviewBlocking` entry and verifies the rendered sentence in the DOM.
- [ ] Update `codev/resources/arch.md` if it describes the team tab (check first; if it doesn't, skip with a comment in the PR).
- [ ] Update `codev/resources/commands/team.md` if it exists and describes the tab content (check first).
- [ ] Add a short section to `codev/specs/587-team-tab-in-tower-right-panel.md`'s Amendments log pointing at this spec as a follow-up (optional — captures project history).

#### Implementation Details

**E2E test**: Use the existing Playwright harness in `team-tab.test.ts`. Mock the `/api/team` response (the harness already stubs this endpoint) to include a `reviewBlocking` entry of each direction; assert both sentences appear in the DOM and that the GitHub link has the expected `href`.

**Doc updates**: Quick edits only. No new files unless the team tab is already documented.

#### Acceptance Criteria
- [ ] E2E test passes locally (`pnpm test:e2e` or equivalent in the codev package).
- [ ] Docs (if updated) render correctly — Markdown syntax valid, links resolve.
- [ ] PR description references the issue and lists touched files.

#### Test Plan
- **Unit Tests**: None new.
- **Integration Tests**: One new Playwright assertion.
- **Manual Testing**: Re-run the full smoke flow in Phase 3 to confirm no regression.

#### Rollback Strategy
Revert the test and doc changes. Feature still works in production; CI coverage returns to Phase 3 state.

#### Risks
- **Risk**: Playwright test flakes because the new section renders conditionally.
  - **Mitigation**: Explicit wait for the section selector before asserting text — don't rely on implicit timing.

---

## Dependency Map

```
Phase 1 (wire type)
   ↓
Phase 2 (query + parser + unit tests)
   ↓
Phase 3 (dashboard rendering)
   ↓
Phase 4 (E2E + docs)
```

Strictly linear — each phase depends on the previous one.

## Resource Requirements

### Development Resources
- **Engineers**: One builder; no extra expertise needed beyond the existing team-tab stack (TypeScript, React, GitHub GraphQL).
- **Environment**: Local dev with `pnpm`, `gh` CLI authenticated against the repo, Tower running.

### Infrastructure
- No new services, databases, config changes, or monitoring.

## Integration Points

### External Systems
- **System**: GitHub GraphQL API (via `gh api graphql`)
  - **Integration Type**: API (existing)
  - **Phase**: Phase 2
  - **Fallback**: Existing graceful-degradation envelope (`fetchTeamGitHubData` catches and returns `{ data: emptyMap, error }`). Dashboard falls back to `github_data: null` → no review-blocking section rendered.

### Internal Systems
- **System**: `TeamMemberGitHubData` wire type
  - **Integration Type**: Shared TypeScript type
  - **Phase**: Phase 1 (shape change), Phases 2–3 (producers/consumers)
  - **Fallback**: N/A — additive change.

## Risk Analysis

### Technical Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| GraphQL complexity exceeds GitHub limit for large teams | Low | Medium | `reviewRequests(first: 20)` bounds the expansion; measure in Phase 2 manual test; fall back to a second query if needed | Builder |
| `reviewRequests` semantics differ from assumption after API change | Low | Medium | Verify on live PR #688 during Phase 2 manual test; treat `reviewDecision = APPROVED` as authoritative override | Builder |
| Duplicate `TeamMemberGitHubData` drifts between `api.ts` and `team-github.ts` | Medium | Low | Phase 1 adds both in one commit with identical shape; comment flags future editors | Builder |
| CSS regression in Tower team tab | Low | Low | Reuse existing class naming pattern; manual-test all adjacent panels | Builder |

### Schedule Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| Scope creep (cap on entries, VS Code extension update, team-aggregate header) | Medium | Low | Explicitly out-of-scope in spec; defer to follow-up issues | Builder |

## Validation Checkpoints

1. **After Phase 1**: Type-check passes across all three packages (core, codev, dashboard).
2. **After Phase 2**: All new and existing unit tests pass; live GraphQL query returns the new fields for a known PR.
3. **After Phase 3**: Manual browser walkthrough confirms expected sentences on Amr's and Waleed's cards; no regressions on other cards.
4. **Before PR**: E2E test passes, `pnpm build` clean, no new lint warnings, PR body lists the checklist.

## Monitoring and Observability

No runtime metrics added — this is a read-only UI enrichment with no write path or scheduled job.

### Logging Requirements
- None new. Existing `fetchTeamGitHubData` error path already logs via its return envelope.

### Alerting
- None.

## Documentation Updates Required
- [ ] `codev/resources/arch.md` if it describes the team tab (Phase 4).
- [ ] `codev/resources/commands/team.md` if it exists and describes the tab content (Phase 4).
- [ ] The PR body includes a before/after screenshot of the team tab for reviewers.

## Post-Implementation Tasks
- [ ] Monitor the first session after merge for any unexpected team-tab errors.
- [ ] File a follow-up issue for VS Code extension parity if desired.
- [ ] File a follow-up issue for "cap at N visible, show 'more' link" if card clutter becomes a real problem.

## Expert Review
<!-- Populated by porch-orchestrated 3-way consultation (Gemini, Codex, Claude) -->

## Approval
- [ ] Technical Lead Review
- [ ] Engineering Manager Approval
- [ ] Resource Allocation Confirmed
- [ ] Expert AI Consultation Complete

## Change Log
| Date | Change | Reason | Author |
|------|--------|--------|--------|
| 2026-04-21 | Initial plan | Implements spec 694 | Builder (aspir-694) |

## Notes

- **Why the required `reviewBlocking` field (not optional)**: Making it required forces the parser to always populate the array (empty when no relationships), which means the UI never has to worry about `undefined` vs `[]`. Since no external consumer reads `github_data` without passing through the parser, this is safe.
- **Why server-side display-name resolution**: Keeps the dashboard free of team-roster lookups (which would duplicate logic and re-introduce cross-member coupling).
- **Why a dedicated helper for derivation**: Makes the algorithm unit-testable as a pure function, isolated from GraphQL plumbing.

---

## Amendment History

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
