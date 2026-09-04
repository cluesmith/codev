# Builder pir-1592 — issue view metadata (#1592)

## Plan phase (2026-09-03)

Wrote `codev/plans/1592-vscode-issue-view-omits-core-m.md`, committed (acfe32339) and
pushed to `builder/pir-1592`. At the **plan-approval** gate, waiting.

### What the plan does
Adds 5 optional fields — author, createdAt, assignees, labels, milestone — to the
`IssueView` wire contract so the VS Code in-editor issue preview can show attribution +
triage context under the title. Data flow: forge `issue-view` script → `IssueViewResult`
(`forge-contracts.ts:20`) → `fetchIssue` → Tower `handleIssueView` (verbatim
`JSON.stringify`, `tower-routes.ts:1177`) → SDK generic `getIssue` → `IssueView`
(`api.ts:411`) → `renderIssue` (`view-issue.ts:97`).

Key finding: **Tower + SDK need no code change** — both pass JSON through generically. Only
the two type declarations, the 4 forge scripts, and `renderIssue` change. Refresh path
(`refreshTracked`, `view-issue.ts:120`) picks up new fields for free (Requirement 5).

### Lane brief (from vscode architect) — how addressed
1. Contract surface isolated in plan **Section A** (main-architect-owned) for routing to
   main's stakeholder review before Amr's gate.
2. **PRView = follow-up, not ride-along.** Gap confirmed (`PrViewResult` forge-contracts.ts:120,
   `PRView` api.ts:438 lack the fields) but there is NO PR in-editor render surface —
   `getPR`'s only consumer is `open-pr-by-id.ts:43` (browser open). Will file separate issue
   on completion.
3. All 4 forge scripts degrade gracefully via field optionality (Section B1). GitHub verified
   live against #1592; presets best-effort.
4. Fences respected: only vscode `commands/` file touched is `view-issue.ts`. Stayed out of
   pir-1566 / pir-1568 / pir-1563 files.

### Field shapes (matching IssueListItem convention — nested objects, not flat strings)
`author?: {login}`, `createdAt?: string`, `assignees?: [{login}]`, `labels?: [{name}]`,
`milestone?: {title} | null` (gh emits literal null when unset).

## Section A stakeholder ruling folded in (2026-09-03)

Main architect's types/sdk/core seat ratified the 5-field shape. Folded two binding
acceptance criteria into Section A and revised the plan:
- **Rider:** field-level doc comments on BOTH mirrored declarations (api.ts `IssueView` +
  forge-contracts.ts `IssueViewResult`), incl. milestone-null rationale + forge-neutral
  optionality note, mirroring the existing `url` comment.
- **Same-commit condition:** both mirrored declarations must change in ONE commit,
  field-for-field parallel.
- PRView follow-up endorsed.

Revised plan SHA: `b518dc072` (pushed). Reported to architect; he presents to Amr on it.
This ruling is the stakeholder seat only — **NOT** the plan-approval gate.

## Plan approved + implemented (2026-09-04)

Amr approved plan-approval (attested via architect, plan head b518dc072). Ran
`porch approve` and advanced to implement. Implemented on `builder/pir-1592`:

- **9c24c7488** — contract: 5 fields on BOTH `IssueView` (api.ts) + `IssueViewResult`
  (forge-contracts.ts) in ONE commit, field-for-field parallel, doc comments on both
  (satisfies the same-commit condition + rider).
- **727a69380** — forge scripts: all four map fields forge-neutrally. GitHub verified
  live vs #1592; gitlab/gitea/linear best-effort, null-safe jq validated on sample JSON.
- **30f48dd2a** — `renderIssue` exported + metadata block (opened-by/date, labels,
  assignees, milestone), omit-when-absent.
- **a5345ce59** — tests: `view-issue-render.test.ts` (9 cases, incl. byte-identical
  regression + `milestone:null`) and github.test.ts passthrough case.

No Tower-route/SDK edit (verbatim passthrough). Verification green: porch build+tests;
codev 5378 passed, vscode 962 passed; types/sdk/codev builds + vscode check-types clean.

**Changelog decision:** did NOT add changelog entries to the builder branch — per the
UNRELEASED.md template, VS Code changelog/release-notes entries live on the separate
`docs/vscode-changelog` branch (architect step). Flagged to the architect.

**PRView:** follow-up issue to file at completion. **CMAP:** runs in review phase after PR.

## Dev-gate review feedback (2026-09-04)

Amr tested the running build and gave feedback; addressed on-branch:
- **7b6a797eb** — State + label(s) on one line (`**State:** OPEN · **Label:** area/agent`);
  singular `Label`/`Assignee` for a single item (plural otherwise).
- **a51cfbec6** — Fixed a **pre-existing** race: a preview tab VSCode restores on launch
  (before Tower connects) showed "Content unavailable" and stayed stuck, because the
  refresh loop only re-fetched `knownIssueIds()` (cache keys set this session). Now refresh
  iterates OPEN codev-issue documents (`openIssueDocIds()`), doesn't burn the throttle while
  disconnected, and fetches immediately on `onStateChange('connected')` /
  `onDidOpenTextDocument` / activation. New `view-issue-refresh.test.ts` (3). Flagged the
  scope expansion to the architect (Amr requested it at the gate).

Cache model (for reference): content lives in an in-memory `Map` bounded to open previews;
`onDidCloseTextDocument -> forget()` deletes on tab close; not persisted (empty on launch).

Verification after each: full vscode suite green (970 passed), check-types clean.

## Next
Still at **dev-approval** gate (Amr's). Will NOT run `porch approve` until the architect
relays his decision. Then review phase: open PR, run CMAP, write review, file PRView follow-up.
