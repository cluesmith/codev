# PIR Plan: Issue view metadata (author, created date, assignees, labels, milestone)

## Understanding

Opening an issue in the VS Code extension (right-click a backlog row → "View Issue")
renders only title, state, body, and comments. Attribution and triage context (who
opened it, when, labels, assignees, milestone) are missing.

The gap is not primarily in the renderer — it is in the **wire contract**. The data
never reaches the extension:

1. The forge `issue-view` concept fetches only `title, body, state, url, comments`.
   Verified in every script: `packages/codev/scripts/forge/github/issue-view.sh`
   (`gh issue view … --json title,body,state,url,comments`), and the gitea/gitlab/linear
   equivalents.
2. `IssueViewResult` (`packages/codev/src/lib/forge-contracts.ts:20`) and the mirrored
   wire type `IssueView` (`packages/types/src/api.ts:411`) carry only those five fields.
3. Tower's `GET /api/issue` (`handleIssueView`, `tower-routes.ts:1177-1202`) serializes
   the forge result **verbatim** (`res.end(JSON.stringify(issue))`) — no field whitelist.
4. `renderIssue()` (`apps/vscode/src/commands/view-issue.ts:97`) emits `# title`,
   `**State:**`, body, comments.

Because Tower and the SDK pass the JSON through generically (`getIssue` →
`request<IssueView>`, `tower-client.ts:531`), the only code that must change to *carry*
new fields is the forge scripts and the two type declarations. `renderIssue()` changes
to *display* them. The refresh path already re-runs `getIssue` + `renderIssue` per open
preview (`refreshTracked`, `view-issue.ts:120-137`), so it picks up the new fields for
free — no extra requests (Requirement 5 satisfied by construction).

This mirrors the existing optional `url` field precedent exactly (Spec 589 "best-effort
presets"): fields are optional so a forge or forge script that doesn't emit them degrades
gracefully. `IssueListItem` (`forge-contracts.ts:40-56`) already carries `author`,
`assignees`, `labels`, `createdAt` in the exact nested shapes I'll reuse.

## Proposed Change (overview)

Add five optional fields, forge-neutrally, threaded through the existing passthrough path,
and render a metadata block. The change spans two ownership surfaces, split into their own
sections below:

- **Contract surface** (main-architect-owned): the two type declarations. Routed for
  stakeholder review before the plan-approval gate.
- **Implementation surface** (vscode-lane-owned): forge scripts + `renderIssue`.

Field shapes reuse the conventions already in `IssueListItem` (nested objects, not flat
strings) so the contract stays internally consistent.

---

## Section A — Contract Surface (main-architect-owned; route for stakeholder review)

> This section changes the `IssueView` wire contract and its server-side mirror. Per the
> lane brief it is owned by the main architect and reviewed by the types/sdk/core
> stakeholders **before** Amr's plan-approval gate. No policy or rendering logic lives
> here — these are pure shape additions.

Add the same five optional fields to **both** mirrored declarations:

```ts
author?: { login: string };
createdAt?: string;                     // ISO 8601, as the forge emits
assignees?: Array<{ login: string }>;
labels?: Array<{ name: string }>;
milestone?: { title: string } | null;   // GitHub emits `null` when unset
```

- `packages/types/src/api.ts:411-431` — extend `IssueView` (the wire type consumed by the
  SDK and the VSCode extension).
- `packages/codev/src/lib/forge-contracts.ts:20-37` — extend `IssueViewResult` (the
  server-side shape `fetchIssue` returns), keeping it byte-parallel with `IssueView`. The
  file header calls out that these two are mirrors — they must stay in sync.

Design notes for the reviewers:

- **All optional** (`?`), matching the `url` precedent, so a forge/script that does not
  emit a field degrades gracefully — never a hard failure.
- **`milestone` is `{ title } | null`**, not just optional, because `gh` emits a literal
  `null` when unset (verified against issue #1592). Consumers guard on `milestone?.title`.
- **Nested object shapes** (`{ login }`, `{ name }`) rather than flat strings, matching
  `IssueListItem`, comments, and `PrViewResult.author` already in these files. This lets
  GitHub's native JSON pass through with no remapping.
- **No Tower-route edit.** `handleIssueView` (`tower-routes.ts:1177`) already serializes
  the forge result verbatim (`JSON.stringify(issue)`); once the types permit the fields,
  they flow through untouched (Requirement 3). The SDK's `getIssue`
  (`tower-client.ts:531`) is likewise generic `request<IssueView>`. Both omissions are
  deliberate — flagged here so the reviewer knows nothing was missed.

### Acceptance criteria (main-architect stakeholder ruling, binding)

Ratified by the types/sdk/core stakeholder seat. These are conditions on the Section A work,
not open questions:

1. **Field-level doc comments on BOTH mirrored declarations** (rider, binding). Each new
   field carries a doc comment on both `IssueView` (`packages/types/src/api.ts`) and
   `IssueViewResult` (`packages/codev/src/lib/forge-contracts.ts`), the way the existing
   `url` comment already appears in both files. The comments must include the
   `milestone: … | null` rationale (GitHub emits a literal `null` when unset; guarded on
   `milestone?.title`) and the forge-neutral optionality note (all fields optional so a
   forge/script that omits them degrades gracefully).
2. **Both mirrored declarations change in the SAME commit** (remit condition). Extending
   `IssueViewResult` in `forge-contracts.ts` is within this lane's remit on the condition
   that `IssueView` (api.ts) and `IssueViewResult` (forge-contracts.ts) are edited together
   in a single commit, field-for-field parallel — the two never drift across commits.
3. **Field shapes ratified as proposed**: nested `{login}` / `{name}`, `createdAt: string`,
   `milestone: { title } | null`; all optional per the `url` precedent. No Tower-route or
   SDK edit.
4. **PRView follow-up endorsed**: filed as a separate issue at completion (not in this PR).

---

## Section B — Implementation Surface (vscode lane)

### B1. Forge scripts (all four degrade gracefully)

GitHub is the default and fully supported; the presets are best-effort (the established
doctrine in `forge-contracts.ts:5-11`), relying on field optionality. Absent fields simply
never appear in the JSON → the render block omits their lines.

- **GitHub** (`github/issue-view.sh`): extend the `--json` list to
  `title,body,state,url,comments,author,createdAt,assignees,labels,milestone`. `gh` emits
  all five in the exact neutral shapes above (verified live against #1592). No jq needed.
- **GitLab** (`gitlab/issue-view.sh`): `glab issue view --output json` exposes `author`
  (has `.username`), `created_at`, `assignees` (each `.username`), `labels`, `milestone`
  (`.title`). Extend the existing `. + {url: .web_url}` jq to also map
  `author: {login: .author.username}`, `createdAt: .created_at`,
  `assignees: [.assignees[]? | {login: .username}]`,
  `labels: [.labels[]? | {name: .}]` (glab emits label names as strings),
  `milestone: (if .milestone then {title: .milestone.title} else null end)`.
- **Gitea** (`gitea/issue-view.sh`): extend the jq to map `poster.login → author.login`,
  `.created → createdAt`, `assignees[]?.login`, `labels[]?.name`, `milestone.title` where
  tea exposes them; anything tea omits is left absent (optional).
- **Linear** (`linear/issue-view.sh`): extend the GraphQL query with `createdAt`,
  `creator { displayName }`, `assignee { displayName }` (Linear has a single assignee →
  emit as a one-element `assignees` array), `labels { nodes { name } }`, and
  `project { name }` mapped into `milestone.title` (Linear has projects, not milestones).
  Map in the existing jq block.

### B2. Render the metadata block (`apps/vscode/src/commands/view-issue.ts:97-113`)

Insert a metadata block directly under the title, each line omitted when its data is
absent (Requirement 4):

```
# #1592 <title>

**State:** open
**Opened by** @amrmelsayed on 2026-09-02
**Labels:** area/cross-cutting, area/vscode
**Assignees:** @alice, @bob
**Milestone:** v3.4.0

<body>
```

- Creation date rendered as the `YYYY-MM-DD` prefix of the ISO string (sliced, no locale
  dependency), consistent with the terse style already used for comment headers
  (`view-issue.ts:105`, which renders `c.createdAt` raw).
- "Opened by" collapses author + date onto one line; render just the present fragment if
  only one exists.
- Labels join with `, `; assignee logins prefixed `@` and joined with `, `.
- `milestone` guarded on `?.title` so both absent and `null` omit the line.
- **Export `renderIssue`** (currently module-private) so the metadata block is unit
  testable. Pure function `(issueId, IssueView) → string`; no caller behavior changes.

This is the only file in the vscode `commands/` tree I touch. It is **not** among the
fenced files (pir-1566: `views/tower*.ts`, `workspace-label.ts`, `switch-workspace.ts`;
pir-1568: `terminal-link-provider.ts`, `open-terminal-ref.ts`; pir-1563: `views/
builders.ts`, `terminal-manager.ts`, `command-relay.ts`).

### B3. Docs

- `apps/vscode/CHANGELOG.md` + `docs/releases/UNRELEASED.md` — one user-facing entry: the
  in-editor issue preview now shows who opened the issue, when, plus labels, assignees,
  and milestone.

## Files to Change

Contract surface (Section A):
- `packages/types/src/api.ts:411-431`
- `packages/codev/src/lib/forge-contracts.ts:20-37`

Implementation surface (Section B):
- `apps/vscode/src/commands/view-issue.ts:97-113` — export + render metadata block, add
  ISO→`YYYY-MM-DD` helper.
- `packages/codev/scripts/forge/github/issue-view.sh`
- `packages/codev/scripts/forge/gitlab/issue-view.sh`
- `packages/codev/scripts/forge/gitea/issue-view.sh`
- `packages/codev/scripts/forge/linear/issue-view.sh`
- `apps/vscode/src/__tests__/view-issue-render.test.ts` (new) — `renderIssue` unit tests.
- `packages/codev/src/__tests__/github.test.ts` — assert `fetchIssue` surfaces the new
  fields when the concept command emits them.
- `apps/vscode/CHANGELOG.md`, `docs/releases/UNRELEASED.md`

No change: `tower-routes.ts`, `packages/sdk/src/tower-client.ts` (see Section A note).

## PRView / GET /api/pr — decision: follow-up, not a ride-along

Confirmed in source that `PrViewResult` (`forge-contracts.ts:120-141`) and `PRView`
(`api.ts:438-457`) carry `author` but no `createdAt`, `labels`, `assignees`, or
`milestone` — so the contract has an analogous gap.

**But it is not a mechanical mirror of this change, because there is no PR render surface
to fill.** The issue-view work is motivated by an in-editor markdown preview
(`renderIssue` + the `codev-issue:` content provider). The PR side has **no equivalent
render path**: the only consumer of `getPR` is `apps/vscode/src/commands/open-pr-by-id.ts:43`,
which uses the result solely to open the PR's `url` in a browser — it never renders
title/author/metadata in-editor. Adding fields to `PRView` would therefore ship a wire
change with zero consumer, and building an in-editor PR preview is a separate feature, not
a cheap tail of this one.

**Decision:** do not include PRView here. On completion I will file a separate issue
("PR view has no in-editor metadata render; PRView contract lacks labels/assignees/
createdAt") referencing `forge-contracts.ts:120`, `api.ts:438`, and
`open-pr-by-id.ts:43`, per the issue's own scope note. This keeps the contract review
focused on `IssueView` alone.

## Risks & Alternatives Considered

- **Risk — non-GitHub CLI field names unverifiable in this worktree.** I can runtime-verify
  `gh` (done, against #1592) but not `glab`/`tea`/Linear GraphQL here. Mitigation: the
  optional-field contract means a wrong/absent preset mapping degrades to "line omitted",
  never a crash — identical to how `url` behaves for presets today. GitHub (the default)
  is fully verified. Where a preset field name is uncertain I will comment it as
  best-effort in the script rather than assert a shape I could not confirm.
- **Risk — `milestone: null` rendering an empty line.** Typed `{ title } | null` and
  guarded on `milestone?.title`. Verified `gh` emits literal `null` when unset.
- **Alternative — flat string fields** (`author?: string`, `assignees?: string[]`).
  Rejected: `IssueListItem`/`PrViewResult`/comments already use nested `{login}`/`{name}`
  objects; matching them keeps the contract consistent and lets GitHub's native shapes
  pass through with less remapping.
- **Alternative — render metadata as a table or inside the body.** Rejected: bold-label
  lines match the existing `**State:**` style and make the omit-when-absent requirement
  trivial (one line per field).

## Test Plan

- **Unit (`renderIssue`)** — new `view-issue-render.test.ts`:
  - all five fields present → opened-by+date, labels, assignees, milestone lines render in
    order under the title.
  - subset present (author only; labels only) → only those lines appear.
  - none present (bare `IssueView`) → output byte-identical to today (title, state, body,
    comments) — regression guard.
  - `milestone: null` → no milestone line.
  - `createdAt` ISO → rendered as `YYYY-MM-DD`.
- **Unit (`fetchIssue` passthrough)** — `github.test.ts`: mock the `issue-view` concept
  output with the new fields; assert `fetchIssue` returns them unchanged (confirms nothing
  strips them before Tower serializes).
- **Type check** — `pnpm --filter @cluesmith/codev-types build` + workspace `check-types`
  (tsc) green; the two `IssueView`/`IssueViewResult` declarations stay in sync.
- **Manual (running worktree, dev-approval gate)**:
  1. Run the extension against Tower, right-click a backlog row → "View Issue".
  2. Verify the metadata block appears under the title with correct author, date, labels,
     assignees; milestone line present only when the issue has one.
  3. Open an issue with no assignees/milestone → those lines absent.
  4. Leave the preview open; trigger a sidebar refresh → metadata persists, no extra
     network churn (throttle intact).
- **CMAP** — run the 3-way consultation after implementation and after tests.
