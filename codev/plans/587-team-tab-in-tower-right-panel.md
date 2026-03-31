# Plan: Team Tab in Tower Right Panel

## Metadata
- **ID**: plan-587
- **Status**: draft
- **Specification**: codev/specs/587-team-tab-in-tower-right-panel.md
- **Created**: 2026-03-07

## Executive Summary

Implement the Team tab feature using the file-based team directory approach (Approach 1 from the spec). Work is divided into 5 phases: team directory infrastructure, backend API, frontend Team tab, `afx team` CLI commands, and automatic hourly updates via cron.

## Success Metrics
- [ ] All specification success criteria met
- [ ] Test coverage >90% across server, hooks, CLI, and UI layers
- [ ] Tab loads in <2s for 10 team members (batched GraphQL)
- [ ] No regression in existing Tower functionality

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "team_directory", "title": "Team Directory Infrastructure"},
    {"id": "backend_api", "title": "Backend API and GitHub Integration"},
    {"id": "frontend_tab", "title": "Frontend Team Tab"},
    {"id": "af_team_cli", "title": "afx team CLI Commands"},
    {"id": "auto_updates", "title": "Automatic Hourly Team Updates"}
  ]
}
```

## Phase Breakdown

### Phase 1: Team Directory Infrastructure
**Dependencies**: None

#### Objectives
- Establish the `codev/team/people/` directory convention and file format
- Implement team file parsing (YAML frontmatter) and message log parsing
- Define TypeScript interfaces for team data and the communication channel abstraction

#### Deliverables
- [ ] TypeScript module for reading/parsing team member files from `codev/team/people/*.md`
- [ ] TypeScript module for reading/parsing `codev/team/messages.md`
- [ ] `MessageChannel` interface and `FileMessageChannel` implementation
- [ ] `TeamMember` and `TeamMessage` TypeScript interfaces
- [ ] Unit tests for parsing (valid files, missing fields, malformed YAML, duplicates, message parsing)

#### Implementation Details

**New file**: `packages/codev/src/lib/team.ts`

Interfaces:
```typescript
interface TeamMember {
  name: string;
  github: string;
  role: string;  // defaults to "member"
  filePath: string;
}

interface TeamMessage {
  author: string;
  timestamp: string;  // ISO 8601
  body: string;
  channel: string;    // "file" for messages.md
}

interface MessageChannel {
  name: string;
  getMessages(): Promise<TeamMessage[]>;
}
```

Functions:
- `loadTeamMembers(teamDir: string): Promise<{ members: TeamMember[]; warnings: string[] }>` — reads `people/*.md`, parses frontmatter, deduplicates by GitHub handle (first file wins), skips files missing `name` or `github`
- `loadMessages(messagesPath: string): Promise<{ messages: TeamMessage[]; warnings: string[] }>` — parses `---`-separated entries from `messages.md`
- `hasTeam(teamDir: string): Promise<boolean>` — returns true if `codev/team/` exists and `people/` has 2+ valid member files
- `class FileMessageChannel implements MessageChannel` — wraps `loadMessages`

For YAML frontmatter parsing, split file content on `---` delimiters and parse the frontmatter block with `js-yaml` (already a dependency via `yaml` package). Do NOT use `gray-matter` — it is not in the project. Simple approach: split on first two `---` occurrences, parse the middle section with `yaml.parse()`.

#### Acceptance Criteria
- [ ] `loadTeamMembers()` returns parsed members from `people/*.md` files
- [ ] Files missing `name` or `github` frontmatter are skipped with warnings
- [ ] Duplicate GitHub handles: first file wins, duplicate skipped with warning
- [ ] `loadMessages()` parses `---`-separated message entries correctly
- [ ] `hasTeam()` returns false when directory missing or <2 valid members
- [ ] All tests pass

#### Test Plan
- **Unit Tests**: Parse valid member files, missing fields, malformed YAML, duplicate handles, empty directory, message parsing (valid, malformed, empty/missing file), `hasTeam` threshold logic
- **Integration Tests**: End-to-end parsing of a realistic `codev/team/` directory

#### Rollback Strategy
Revert the single commit — no existing code is modified.

---

### Phase 2: Backend API and GitHub Integration
**Dependencies**: Phase 1

#### Objectives
- Create `/api/team` Tower endpoint that returns team members enriched with GitHub data, plus messages
- Add `teamEnabled: boolean` field to `DashboardState` (returned by `/api/state`) so the frontend can conditionally show the Team tab without a separate probe
- Implement batched GraphQL query for GitHub data (assigned issues, open PRs, recent activity)

#### Deliverables
- [ ] `teamEnabled: boolean` added to `DashboardState` in `/api/state` response (calls `hasTeam()` on each poll)
- [ ] `/api/team` endpoint in `tower-routes.ts`
- [ ] GitHub data fetching function using batched GraphQL via `gh api graphql`
- [ ] Response includes members (with GitHub data) and messages (with channel field)
- [ ] Graceful degradation when GitHub API unavailable or `gh` not authenticated
- [ ] Unit and integration tests

#### Implementation Details

**New file**: `packages/codev/src/lib/team-github.ts`

```typescript
interface TeamMemberGitHubData {
  assignedIssues: { number: number; title: string; url: string }[];
  openPRs: { number: number; title: string; url: string }[];
  recentActivity: {
    mergedPRs: { number: number; title: string; mergedAt: string }[];
    closedIssues: { number: number; title: string; closedAt: string }[];
  };
}

async function fetchTeamGitHubData(
  members: TeamMember[],
  repoOwner: string,
  repoName: string,
  cwd: string
): Promise<Map<string, TeamMemberGitHubData>>
```

Uses a single batched GraphQL query (pattern from `src/lib/github.ts` `fetchOnItTimestamps`):
- For each member, include aliased query fragments for assigned issues, authored PRs, and recent activity
- All members in one request to stay within 2s target
- GitHub handles sanitized: reject any handle not matching `/^[a-zA-Z0-9-]+$/`

**Modified file**: `packages/codev/src/agent-farm/servers/tower-routes.ts`

1. In the `/api/state` handler, add `teamEnabled: boolean` to the `DashboardState` response by calling `hasTeam(workspacePath + '/codev/team')`. This is a lightweight filesystem check (just counts files in `people/`) and runs on each state poll. This solves the tab visibility chicken-and-egg: `buildTabs()` already receives `DashboardState` and can conditionally include the Team tab based on `state.teamEnabled`.

2. Add route: `'GET /api/team'` → handler that:
   1. Detects workspace root from request context
   2. Calls `hasTeam()` — if false, returns `{ enabled: false }`
   3. Calls `loadTeamMembers()` and `loadMessages()`
   4. Calls `fetchTeamGitHubData()` (with try/catch for graceful degradation)
   5. Returns `{ enabled: true, members: [...], messages: [...], warnings: [...], githubError?: string }`

**API response shape**:
```typescript
interface TeamApiResponse {
  enabled: boolean;
  members: (TeamMember & { github_data?: TeamMemberGitHubData })[];
  messages: TeamMessage[];
  warnings: string[];
  githubError?: string;
}
```

#### Acceptance Criteria
- [ ] `/api/team` returns member data with GitHub enrichment
- [ ] Batched GraphQL fetches all members in one request
- [ ] Returns `{ enabled: false }` when team directory missing or <2 members
- [ ] Graceful degradation: returns members without GitHub data when API fails
- [ ] Invalid GitHub handles are sanitized (alphanumeric + hyphens only)
- [ ] All tests pass

#### Test Plan
- **Unit Tests**: GraphQL query construction, response parsing, handle sanitization, graceful degradation on API failure
- **Integration Tests**: `/api/team` endpoint with mock filesystem and GitHub data

#### Rollback Strategy
Remove route from `tower-routes.ts`, revert new files.

---

### Phase 3: Frontend Team Tab
**Dependencies**: Phase 2

#### Objectives
- Add Team tab to the Tower dashboard tab bar (conditionally, only when team is enabled)
- Create `TeamView` component displaying member cards and messages
- Implement `useTeam` hook with fetch-on-activation pattern

#### Deliverables
- [ ] `'team'` added to tab type union in `useTabs.ts`
- [ ] Team tab registered in `buildTabs()` (conditional on API returning `enabled: true`)
- [ ] `useTeam.ts` hook with fetch-on-activation pattern (like `useAnalytics`)
- [ ] `TeamView.tsx` component with member cards and message list
- [ ] Tab icon in `TAB_ICONS` (use `'team'` key)
- [ ] Render logic in `App.tsx` `renderPersistentContent()`
- [ ] CSS styles following existing theme variables
- [ ] Unit tests for component rendering

#### Implementation Details

**Modified file**: `packages/codev/dashboard/src/hooks/useTabs.ts`
- Add `'team'` to the type union (line 6)
- In `buildTabs()`, conditionally add Team tab when `state.teamEnabled === true`. Unlike Analytics (which is always present), Team is only added when the backend signals that `codev/team/people/` has 2+ members. The `teamEnabled` flag comes from `DashboardState` which `buildTabs()` already receives.

**New file**: `packages/codev/dashboard/src/hooks/useTeam.ts`
- Fetch-on-activation pattern (like `useAnalytics`):
  - Fetch `/api/team` when `isActive` prop is true
  - Re-fetch on manual refresh
  - No polling
- Returns `{ data: TeamApiResponse | null, error: string | null, refresh: () => void }`

**New file**: `packages/codev/dashboard/src/components/TeamView.tsx`
- Layout: Two sections — **Members** (card grid) and **Messages** (reverse-chronological list)
- Member card: Name, role badge, GitHub handle link, assigned issues count, open PRs count, recent activity summary
- Messages: Author, timestamp, body (plain text, no HTML rendering)
- Refresh button in header
- Error banner when GitHub data unavailable
- "No messages yet" state when no messages

**Modified file**: `packages/codev/dashboard/src/components/TabBar.tsx`
- Add icon for `'team'` type in `TAB_ICONS`

**Modified file**: `packages/codev/dashboard/src/components/App.tsx`
- Add Team tab rendering alongside the AnalyticsView rendering branch (NOT inside `renderPersistentContent()` — Analytics is rendered separately as a non-terminal tab, and Team follows the same pattern)
- Pass `isActive` prop to control fetch-on-activation
- Conditionally render only when `state.teamEnabled === true`

**Modified file**: `packages/codev/dashboard/src/index.css`
- Add `.team-view`, `.team-member-card`, `.team-messages` styles using existing CSS variables

**Modified file**: `packages/codev/dashboard/src/lib/api.ts`
- Add `TeamApiResponse` type export

#### Acceptance Criteria
- [ ] Team tab appears only when `/api/team` returns `enabled: true`
- [ ] Tab does NOT appear when team is not configured
- [ ] Member cards show name, role, GitHub handle, issue/PR counts
- [ ] Messages display in reverse chronological order as plain text
- [ ] Refresh button triggers re-fetch
- [ ] Error banner shown when GitHub data unavailable
- [ ] Styling matches existing dashboard theme
- [ ] All tests pass

#### Test Plan
- **Unit Tests**: `useTeam` hook behavior (fetch on activation, refresh, error states), `TeamView` rendering (members, messages, empty states, error states)
- **Playwright E2E Tests** (required for UI changes per repo instructions):
  - Team tab appears only when team has 2+ members
  - Team tab does NOT appear when team directory is missing
  - Member cards render with correct data
  - Messages section shows entries in reverse chronological order
  - Refresh button triggers re-fetch
  - GitHub error banner appears when API unavailable

#### Rollback Strategy
Revert changes to `useTabs.ts`, `TabBar.tsx`, `App.tsx`, remove new files.

---

### Phase 4: afx team CLI Commands
**Dependencies**: Phase 1

#### Objectives
- Add `afx team list` and `afx team message` subcommands
- Follow existing Commander.js command registration pattern

#### Deliverables
- [ ] `afx team list` command showing team members
- [ ] `afx team message "text"` command appending to `messages.md`
- [ ] Command registered in `cli.ts` following existing pattern
- [ ] Unit tests for command logic

#### Implementation Details

**New file**: `packages/codev/src/agent-farm/commands/team.ts`

```typescript
export async function teamList(options: { cwd?: string }): Promise<void>
// - Detects workspace root
// - Loads team members from codev/team/people/
// - Prints table: Name | GitHub | Role
// - Warns if <2 members found

export async function teamMessage(options: { text: string; author?: string; cwd?: string }): Promise<void>
// - Detects workspace root
// - If options.author provided, use it (for cron/auto-updates)
// - Otherwise, gets author GitHub handle via `gh api user --jq .login` or git config user.name
// - Formats entry: ---\n**<handle>** | <UTC timestamp>\n<text>\n
// - Creates messages.md with header if missing
// - Appends entry to messages.md
// - Logs success
```

**Modified file**: `packages/codev/src/agent-farm/cli.ts`

Add `team` command group (pattern from `cron` command group):
```typescript
const teamCmd = program
  .command('team')
  .description('Team interactions and messages');

teamCmd.command('list')...
teamCmd.command('message <text>')...
```

**Modified file**: `packages/codev/src/agent-farm/commands/index.ts`
- Export `teamList` and `teamMessage` from `team.ts`

#### Acceptance Criteria
- [ ] `afx team list` displays members from `codev/team/people/`
- [ ] `afx team message "hello"` appends correctly formatted entry to `messages.md`
- [ ] `afx team message` creates `messages.md` with header if file doesn't exist
- [ ] Author detected from `gh` CLI or git config
- [ ] All tests pass

#### Test Plan
- **Unit Tests**: Message formatting, file creation, append logic, author detection
- **Integration Tests**: End-to-end `afx team list` and `afx team message` with temp directory

#### Rollback Strategy
Remove command from `cli.ts`, revert new file.

---

### Phase 5: Automatic Hourly Team Updates
**Dependencies**: Phase 1, Phase 4

#### Objectives
- Create a cron task that posts hourly architect activity summaries to `messages.md`
- Collect notable events: builder spawns, gate approvals, PR merges, completed reviews

#### Deliverables
- [ ] Cron task YAML file (`.af-cron/team-update.yaml`)
- [ ] Activity collector script/module that gathers events from the last hour
- [ ] Integration with `afx team message` for appending summaries
- [ ] Unit tests for event collection and summary formatting

#### Implementation Details

**New file**: `packages/codev/src/agent-farm/commands/team-update.ts`

```typescript
export async function teamUpdate(options: { cwd?: string }): Promise<void>
// 1. Determine time window: now - 1 hour
// 2. Collect notable events:
//    - Builder spawns: parse git log for spawn-related commits in last hour
//    - Gate approvals: check codev/projects/*/status.yaml for recent gate transitions
//    - PR merges: `gh pr list --state merged --search "merged:>=<1hr-ago>" --json number,title`
//    - Completed reviews: check codev/reviews/ for recently modified files
// 3. If no notable events, exit silently (no message posted)
// 4. Format summary message, e.g.:
//    "Hourly update: Spawned builder for #42. Approved spec for #43. Merged PR #100."
// 5. Append via teamMessage() function with author override (e.g., workspace name or "tower-cron")
```

**New file template**: `.af-cron/team-update.yaml`

Cron tasks are discovered per-workspace by `tower-cron.ts` via `loadWorkspaceTasks(workspacePath)`, which reads all `.yaml` files from `<workspace>/.af-cron/`. The file is created in the workspace root (not in `codev/`). Tower's 60-second cron tick evaluates all task schedules via `isDue()`.

```yaml
name: team-update
schedule: "0 * * * *"
enabled: true
command: "afx team update"
timeout: 30
```

**Modified file**: `packages/codev/src/agent-farm/cli.ts`
- Add `afx team update` subcommand (called by cron, can also be run manually)

#### Acceptance Criteria
- [ ] Cron task runs hourly and collects events from the last hour
- [ ] Summary appended to `messages.md` only when notable events exist
- [ ] No message posted when no events occurred
- [ ] Summary includes correct event types (spawn, gate, merge, review)
- [ ] Manual invocation via `afx team update` works
- [ ] All tests pass

#### Test Plan
- **Unit Tests**: Event collection from mock data sources, summary formatting, no-event suppression
- **Integration Tests**: End-to-end cron task execution with mock git history and GitHub data

#### Rollback Strategy
Remove cron YAML file, remove `team-update.ts`, revert CLI changes.

---

## Dependency Map
```
Phase 1 (Team Directory) ──→ Phase 2 (Backend API) ──→ Phase 3 (Frontend Tab)
         │
         ├──→ Phase 4 (afx team CLI)
         │
         └──→ Phase 5 (Auto Updates) ←── Phase 4
```

Phase 4 can run in parallel with Phases 2-3 since it only depends on Phase 1.

## Integration Points

### External Systems
- **GitHub API**: GraphQL via `gh api graphql` for member activity data
  - Phase: 2, 5
  - Fallback: Show member cards without GitHub data; error banner in UI

### Internal Systems
- **Tower Server**: New `/api/team` route
  - Phase: 2
- **Dashboard React App**: New tab, hook, and component
  - Phase: 3
- **afx CLI**: New `team` command group
  - Phase: 4
- **Tower Cron**: New scheduled task
  - Phase: 5

## Risk Analysis

### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| GitHub GraphQL rate limiting | Medium | Medium | Single batched query, fetch-on-activation only |
| Concurrent writes to messages.md | Low | Low | Append-only format; atomic write via `fs.appendFile`. Add lockfile if issues arise |
| Cron task conflicts with manual messages | Low | Low | Append-only format; concurrent appends are safe for this use case |

## Expert Review

**Date**: 2026-03-07
**Models Consulted**: Gemini, Codex (GPT), Claude

**Key feedback incorporated**:
- **Gemini** (REQUEST_CHANGES): Fixed circular tab visibility dependency by adding `teamEnabled` to `DashboardState`. Corrected `gray-matter` dependency claim — using `js-yaml` + string split instead.
- **Codex** (REQUEST_CHANGES): Added Playwright E2E test plan for UI changes. Added author override to `teamMessage()` for cron context. Clarified cron config discovery path (`.af-cron/*.yaml` per workspace).
- **Claude** (COMMENT): Clarified `buildTabs()` conditional wiring via `state.teamEnabled`. Fixed `renderPersistentContent` guidance — Team renders alongside Analytics, not inside that function. Added concurrent write risk to risk table.

## Documentation Updates Required
- [ ] Architecture docs (`codev/resources/arch.md`) — new team module
- [ ] CLI reference for `afx team` commands
- [ ] README update for `codev/team/` directory convention
