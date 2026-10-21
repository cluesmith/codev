# PIR Review: Jira forge provider preset (hybrid, via acli)

Fixes #1740

## Summary

Adds a `jira` forge provider for Jira Cloud, wrapping Atlassian's official `acli` CLI, on the Linear hybrid model (spec 719). Jira serves the seven issue concepts, and every PR concept, `pr-create` included, falls through to the `gh` default. It also makes tracker-key issue ids (`ENG-123`) work end to end. Spec 719 had only widened spawn parsing; every place that recovered an id after spawn assumed digits, so this repairs Linear's lifecycle as well. Finally, it gives `codev doctor` an honest auth report for hybrid providers: the tracker's login and `gh`'s.

## Files Changed

Jira preset (new):
- `packages/codev/scripts/forge/jira/_lib.sh` (+113 / -0)
- `packages/codev/scripts/forge/jira/auth-status.sh` (+29 / -0)
- `packages/codev/scripts/forge/jira/issue-comment.sh` (+23 / -0)
- `packages/codev/scripts/forge/jira/issue-list.sh` (+32 / -0)
- `packages/codev/scripts/forge/jira/issue-search.sh` (+40 / -0)
- `packages/codev/scripts/forge/jira/issue-view.sh` (+41 / -0)
- `packages/codev/scripts/forge/jira/recently-closed.sh` (+75 / -0)
- `packages/codev/scripts/forge/jira/user-identity.sh` (+18 / -0)

Forge, doctor, issue ids (codev):
- `packages/codev/src/lib/forge.ts` (+62 / -1)
- `packages/codev/src/lib/forge-contracts.ts` (+4 / -2)
- `packages/codev/src/lib/issue-id.ts` (+53 / -0)
- `packages/codev/src/lib/github.ts` (+31 / -0)
- `packages/codev/src/commands/doctor.ts` (+36 / -4)
- `packages/codev/src/commands/porch/state.ts` (+22 / -8)
- `packages/codev/src/commands/consult/index.ts` (+12 / -1)
- `packages/codev/src/agent-farm/cli.ts` (+17 / -10)
- `packages/codev/src/agent-farm/commands/attach.ts` (+1 / -1)
- `packages/codev/src/agent-farm/commands/cleanup.ts` (+4 / -3)
- `packages/codev/src/agent-farm/commands/reset/context.ts` (+10 / -4)
- `packages/codev/src/agent-farm/commands/spawn.ts` (+25 / -12)
- `packages/codev/src/agent-farm/commands/spawn-worktree.ts` (+13 / -1)
- `packages/codev/src/agent-farm/lib/builder-lookup.ts` (+25 / -10)
- `packages/codev/src/agent-farm/servers/overview.ts` (+166 / -19)
- `packages/types/src/api.ts` (+15 / -2)
- `packages/types/src/index.ts` (+1 / -0)

VS Code:
- `apps/vscode/src/issue-id.ts` (+65 / -0)
- `apps/vscode/src/commands/open-issue-by-id.ts` (+45 / -10)
- `apps/vscode/src/views/backlog-search.ts` (+22 / -3)
- `apps/vscode/src/views/backlog-filter.ts` (+12 / -1)
- `apps/vscode/src/commands/search-backlog.ts` (+5 / -1)
- `apps/vscode/src/terminal-manager.ts` (+5 / -4)
- `apps/vscode/src/architect-reference-injection.ts` (+6 / -3)
- `apps/vscode/src/extension.ts` (+4 / -3)
- `apps/vscode/src/commands/approve.ts` (+4 / -3)
- `apps/vscode/src/commands/view-diff.ts` (+4 / -3)
- `apps/vscode/src/commands/view-issue.ts` (+4 / -3)
- label-only (`#` dropped for keys), +2 / -1 each:
  - `apps/vscode/src/builder-pick-rows.ts`
  - `apps/vscode/src/commands/cleanup.ts`
  - `apps/vscode/src/commands/open-worktree-folder.ts`
  - `apps/vscode/src/commands/open-worktree-window.ts`
  - `apps/vscode/src/commands/run-worktree-dev.ts`
  - `apps/vscode/src/commands/run-worktree-setup.ts`
  - `apps/vscode/src/commands/view-artifact.ts`
  - `apps/vscode/src/views/backlog.ts`
  - `apps/vscode/src/views/builder-row.ts`

Web dashboard:
- `apps/web/src/lib/issueIds.ts` (+36 / -0)
- `apps/web/src/components/WorkView.tsx` (+3 / -8)
- label-only, +2 / -1 each:
  - `apps/web/src/components/BacklogList.tsx`
  - `apps/web/src/components/BuilderCard.tsx`
  - `apps/web/src/components/NeedsAttentionList.tsx`
  - `apps/web/src/components/RecentlyClosedList.tsx`

Tests:
- `packages/codev/src/__tests__/forge-jira-preset.test.ts` (+386 / -0)
- `packages/codev/src/__tests__/doctor.test.ts` (+110 / -0)
- `packages/codev/src/__tests__/forge.test.ts` (+103 / -0)
- `packages/codev/src/__tests__/issue-id.test.ts` (+55 / -0)
- `packages/codev/src/__tests__/github.test.ts` (+40 / -0)
- `packages/codev/src/agent-farm/__tests__/overview.test.ts` (+167 / -0)
- `packages/codev/src/agent-farm/__tests__/pir-1740-issue-key-worktree.test.ts` (+53 / -0)
- `packages/codev/src/agent-farm/__tests__/attach.test.ts` (+37 / -0)
- `packages/codev/src/agent-farm/__tests__/spawn.test.ts` (+19 / -10)
- `packages/codev/src/agent-farm/__tests__/spec-1273-reset-context.test.ts` (+7 / -0)
- `packages/codev/src/commands/porch/__tests__/state.test.ts` (+30 / -0)
- `apps/vscode/src/__tests__/issue-id.test.ts` (+70 / -0)
- `apps/vscode/src/__tests__/open-issue-by-id.test.ts` (+48 / -1)
- `apps/vscode/src/__tests__/backlog-search.test.ts` (+28 / -0)
- `apps/vscode/src/__tests__/architect-reference-injection.test.ts` (+11 / -0)
- `apps/vscode/src/__tests__/backlog-filter.test.ts` (+6 / -0)
- `apps/web/__tests__/issueIds.test.ts` (+40 / -0)

Docs and artifacts:
- `codev/resources/commands/forge.md` (+37 / -3)
- `.claude/skills/forge/SKILL.md` (+1 / -1), `.codex/skills/forge/SKILL.md` (+1 / -1)
- `codev/resources/arch.md`, `codev/resources/lessons-learned.md` (this commit)
- `codev/plans/1740-forge-add-a-jira-provider-pres.md` (+258 / -0)
- `codev/state/pir-1740_thread.md`
- `codev/projects/1740-forge-add-a-jira-provider-pres/status.yaml` (porch)

## Commits

Integration review round 1:
- `e2ced0414` [PIR #1740] jira recently-closed: validate the since date; document the 100-item cap
- `db9d92fa0` [PIR #1740] Pin the issue-key grammar's homes with a parity test
- `179c45542` [PIR #1740] Link numeric [PIR #N] tags like Spec and Bugfix tags
- `90e954290` [PIR #1740] VS Code: search rows and recently closed label keys via issueRef
- `03862e60f` [PIR #1740] Canonicalize a stored lower-case issue key in the overview
- `3cbdc6b8f` [PIR #1740] Make issue createdAt optional end to end; no NaN age, undated items sort last

Implementation:
- `c3315f406` [PIR #1740] Web dashboard: open builder terminals by roleId; key labels without #
- `c7281ad0f` [PIR #1740] VS Code: key-aware id sort, key labels without #, key-safe terminal titles
- `9b7eef618` [PIR #1740] forge.md: Jira keys are configured in .codev/config.json; env vars are script inputs
- `f251a98d6` [PIR #1740] Match buildAgentName for short-id role ids; link BUGFIX PRs by Fixes #KEY
- `ba0477180` [PIR #1740] Recognize provider settings (jira-site, jira-project, linear-team) in forge validation
- `fdceb8fe3` [PIR #1740] Document the jira provider (prerequisites, config keys, Cloud-only scope)
- `ea6f28f3c` [PIR #1740] VS Code: accept tracker-key issue ids where Tower reports a key workspace
- `00908c025` [PIR #1740] Carry tracker-key issue ids end to end (spawn, overview, porch, linking)
- `c5a33709d` [PIR #1740] codev doctor: report tracker and gh logins for hybrid providers
- `e982e3cf2` [PIR #1740] Add the jira forge preset (acli, hybrid) and the provider issue-id kind
- `4d0cb8d11`, `74d09dd13`, `e0288ebba`, `98e308885`: plan draft and three revisions

Plus porch chore commits and one merge of `main`.

## Test Results

- `pnpm build`: pass
- `tsc --noEmit`: pass in `packages/codev`, `apps/vscode` and `apps/web`.
- Tests at the round-1 head:
  - `packages/codev`: 6846 passed, 49 skipped;
  - `apps/vscode`: 1243 passed;
  - `apps/web`: 509 passed, 1 skipped.
- New tests:
  - the jira scripts against a fake `acli` serving synthetic REST-v3-shaped fixtures (contract shapes, the JQL sent, injection guards, ADF flattening, comment-body fidelity);
  - provider resolution and fall-through;
  - `issueIdKind`;
  - doctor hybrid auth;
  - the issue-id helpers;
  - key forms at every recovery site, each paired with an "every existing numeric form resolves exactly as before" case;
  - the VS Code key gate, cell by cell;
  - VS Code labels, sort and terminal-title matching;
  - dashboard tab matching.
- Live verification (read-only, the owner's logged-in `acli` 1.3.39; no site data committed):
  - `auth-status`, `user-identity`, `issue-view`, `issue-list`, `issue-search` (open, closed, all) and `recently-closed` conform to the contracts, both standalone and through the built forge dispatcher;
  - a real `codev doctor` lists the 7 issue concepts as `preset acli` and the PR concepts as `default gh`, with `jira auth` and `gh auth` both authenticated;
  - a wrong `jira-site` reports not authenticated, with the login hint.
- Dev gate: approved by the owner. `issue-comment` was left for a human to exercise live, because it writes to a real site.
- **Browser (Playwright, headless Chromium)**, run against this branch's built dashboard (`apps/web/dist`):
  - **Setup:** every request is answered by the test. `api/state` and `api/overview` come from fixtures holding one Jira-key builder (`ENG-123`) and two numeric builders (`12`, `123`), with neutral tab names; anything else is aborted. Only the fake origin was ever contacted (asserted), and there were no page errors.
  - **Branch build:** all three builder cards' **Open** buttons activate their own terminal tab. Labels read `ENG-123`, `#12`, `#123`, `ENG-7`, `#42`. The undated Jira backlog item shows no age, and the page contains no `NaN`.
  - **Negative control:** the same check against main's `WorkView` (built separately) fails all three. The Jira card opens nothing (a case-sensitive miss), and **builders 12 and 123 both open the Jira builder's tab**, because `builder-pir-eng-123` contains both `12` and `123`.
  - The script lives outside the repo, since the e2e suite drives a real Tower. The unit test `apps/web/__tests__/issueIds.test.ts` pins the same matching logic.

## Architecture Updates

COLD (`codev/resources/arch.md`, Forge Concept Commands) gets two paragraphs:

- **Providers:** the hybrid providers and `isHybridProvider()`, plus provider settings (`PROVIDER_SETTINGS`).
- **Issue ids:** they are a number or a tracker key, with one home for the grammar plus two twins with sync notes; spawn canonicalizes keys; recovery sites try the numeric forms first; `OverviewData.issueIdKind`; the overview prefers the stored `builders.id`.

Nothing went to the HOT tier: these are reference facts for whoever next touches forge or id parsing, not a cross-cutting rule worth displacing an existing critical fact.

## Lessons Learned Updates

COLD (`codev/resources/lessons-learned.md`):

- **Architecture:** an identifier that round-trips through a name will eventually be parsed wrong. Prefer the persisted id, and pin any parser against the function that produced the name.
- **Testing:** an acceptance check must follow an id through its whole lifecycle; spec 719's spawn-parse check hid every downstream break.

The umask-077 test failure hit again here; it is already a lesson (from #1809), so there is no new entry. Nothing went to the HOT tier: both lessons are already covered in spirit by the hot rules on verifying the real user path and checking callers.

## Things to Look At During PR Review

**acli constraints that shaped the scripts** (see the plan's live findings):
- `workitem search` refuses every date field, so `issue-list` has no `createdAt`.
- Consumers drop items without `closedAt`, so `recently-closed` does one `view` per hit (parallel, capped at 25).
- The REST `self` link names an Atlassian infrastructure host, so browse URLs come from `jira-site` or from the `Site:` line of `auth status`.
- Unbounded JQL is rejected, so "all" maps to `statusCategory is not EMPTY`.
- Requesting only `--fields key` returns an array of `null`s.

**Stored id over parsed name** (`overview.ts`: `storedRoleId`, `projectIdForWorktree`):
- The stored `builders.id` is used as the role id only when it has the `buildAgentName` shape (`builder-…` / `worktree-…`). Legacy rows can carry `bugfix-42`.
- A key-shaped directory name whose stored row has `issue_number = null` stays in soft mode. An issue-less protocol spawn is named `<protocol>-<base64url short id>`, and the short id can look like a key (`maintain-Ab-3`).

**Role-id fallback for short ids (architect's should-fix).** `buildAgentName` lowercases the *whole* short id, giving `builder-experiment-ab-3` and `builder-maintain-x_9q`. **The old fallback results (`builder-experiment-ab`, `builder-maintain-x`, `builder-task-ab`) were already wrong** before this PR, and the dashboard lost those builders' terminals. The fallback now takes the whole short id, and the tests compare against `buildAgentName` itself.

**Numeric forms first everywhere.** `bugfix-200` matches the key grammar. The regression guards caught this in `issueIdFromProjectId`, and every key pattern now runs after the numeric ones.

**PR linking** (architect's confirmation request):
- PIR commits are tagged `[PIR #<id>]` and the PR body lists them, so a key renders `[PIR #ENG-1]` and links.
- BUGFIX has no bracketed tag: its title is `Fix #<N>: …` and its body `Fixes #<N>`. Tag-only matching would have missed every BUGFIX PR, so key linking also accepts a closing keyword on a `#`-prefixed key.
- `Closes ENG-1` without the `#`, and bare tokens like `UTF-8`, stay unlinked.
- On GitHub these keywords are inert for a Jira key: GitHub closes nothing in Jira. `forge.md` documents that closing stays manual. No smart commits.

**Doctor.** The real run found a false `Concept 'jira-site' is not a known forge concept` warning, which `linear-team` also had. `PROVIDER_SETTINGS` fixes it: a setting validates under its own provider, gets a clear message under any other, and a typo still warns.

**VS Code:**
- Key input is gated on `issueIdKind`, per surface. An explicit action (Open Issue by ID) accepts keys when the kind is unknown; passive search rows fall back to backlog inference.
- `parseIssueId` stays numeric, because Open PR by ID shares it.
- Labels drop the `#` only for canonical uppercase keys.
- `terminal-manager` matched builders by `split('-').pop()`, which turned a key into its digits (wrong tab title, or the wrong builder). Fixed via `roleShortId`.

**Web dashboard.** `WorkView` matched terminal tabs by case-sensitive substring, so Jira builder cards never opened. It now matches on the exact `roleId`, which also fixes a pre-existing numeric collision where builder 12 opened builder 123.

**Scope beyond the plan** (owner-requested, or the same root defect):
- provider-settings validation;
- BUGFIX closing-keyword linking;
- VS Code label, sort and terminal-title fixes;
- the web dashboard fix.

**Integration review round 1 (architect)**, all addressed:
1. **`createdAt` (must-fix):** now optional on `IssueListItem`, `OverviewBacklogItem` and `IssueSearchItem`. The dashboard's age cell and VS Code's `formatAge` render nothing when it is missing (no `NaN`), and undated items sort last on the age column in both directions. Tests cover each.
2. **Browser verification (must-fix):** done, see Test Results.
3. **Stored `issue_number`:** a value written before canonicalization (`eng-123`) is now canonicalized, so the forge's `ENG-123` matches the builder; tested with a lowercase stored row.
4. **Labels:** VS Code's backlog-search static rows and the Recently Closed view label keys via `issueRef`, and so do the dynamic rows (the inline key decision is gone).
5. **`[PIR #N]`:** now a numeric tag pattern, matched like `[Spec N]` and `[Bugfix #N]`, after them, so nothing that links today changes.
6. **Parity test:** `issue-id-parity.test.ts` extracts the grammar from the VS Code and dashboard homes and the Jira scripts, compares it with the codev constants, and fails if any extension or dashboard file hand-writes the grammar. Every other pattern now derives from the exported constants.
7. **`recently-closed.sh`:** the since-date fallback is validated against `^[0-9]{4}-[0-9]{2}-[0-9]{2}$` before it reaches JQL; tested with hostile values.

The architect's "noted" list: the 100-item cap is now documented in `forge.md`.

**Integration review round 2 (architect)**, all addressed:
1. **Key-shaped short ids (must-fix, a regression this PR introduced).** `generateShortId()` drew a key-shaped id (`Ab-3`) about 0.22% of the time. On this branch, an issue-less `pir-Ab-3` was then read as issue `AB-3`: by porch's cwd detection, by the overview's name fallback when no DB row exists, and by resume for the real `AB-3`.
   - **Fix:** the generator, the single source for task, protocol, shell and worktree spawns, now redraws any key-shaped id.
   - **Tests:** a key-shaped draw (`AA-0`) is redrawn; 50 000 real draws contain no key; and for the would-have-been `pir-AA-0`, each surface was checked: cwd detection gives `null`, the overview with no row is soft with no issue, and resuming `AA-0` finds nothing.
   - **Residual:** a worktree spawned *before* this change with a key-shaped id is still read as that key by porch's cwd detection, and by the overview when its DB row is missing. Documented in `forge.md`; there was no DB lookup added to porch, per the architect.
2. **Single DB read:** the `builders` table is read once per overview (`loadStoredBuilderIdentities`, now carrying `spawned_by_architect`), feeding both discovery and the issueId/spawnedByArchitect enrichment.
3. **Published-type change** (see Deviations below).
4. **`issueNumberFromPorchId` narrowing is intentional and pinned by a test.** `bugfix-` is the only protocol prefix porch puts on project ids, so any other `<word>-<N>` is a tracker key, not a prefix followed by digits.
5. **Forge-neutral spawn wording:** "Fetching issue ENG-123..." and the prompt's "work for issue ENG-123" (numbers keep `#42`).

**Deviations to carry into the release notes**
- **Published type change in `@cluesmith/codev-types`:** `OverviewBacklogItem.createdAt` and `IssueSearchItem.createdAt` are now optional (`string | undefined`), as is `IssueListItem.createdAt` on the codev side, because Jira's search cannot return dates. An external consumer of `codev-types` (the Stream Deck plugin and client SDK in the integrations repo) that reads `createdAt` must handle its absence. New optional field: `OverviewData.issueIdKind`.
- **Spawn ids:** issue-less spawns can no longer get a key-shaped short id. Old ids are unaffected.

**3-way consultation (single pass): Gemini APPROVE, Claude APPROVE, Codex REQUEST_CHANGES.** Codex's four points and their dispositions:
- **`createdAt` contracts:** fixed (round 1, item 1).
- **No browser verification:** fixed (round 1, item 2).
- **Backlog search exits when the backlog is empty, so the plan's empty-backlog row cases never apply: rebutted.** That early return is pre-existing and applies equally to numeric workspaces (the "No backlog issues to search" message); this PR does not change it. The plan's table describes which rows are offered *once the picker is open*. A Jira user's empty-backlog path is Open Issue by ID (`Cmd+K I`), which accepts keys when the kind is unknown. Changing the empty-backlog UX is a separate decision.
- **PR linking by branch name, which the plan listed: acknowledged, not done.** `parseLinkedIssue` receives only the title and body, and the `pr-list` contract carries no branch, so this needs a contract change. The protocols' PRs link through their tags and closing keywords instead. Tracked as a follow-up (the architect classed it as "no change required" in round 1).

**Not done:**
- Branch-name PR linking (above).
- `issue-comment` against a live site: the owner's call at the pr gate.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-1740 → **Review Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-1740`
- **Config**: use a repo whose code is on GitHub, not codev's own checkout. Run `acli jira auth login` and `gh auth login` first, then put `{"forge": {"provider": "jira", "jira-site": "https://<site>.atlassian.net", "jira-project": "<KEY>"}}` in `.codev/config.json`.
- **What to verify**:
  - `codev doctor` shows 7 `preset acli` concepts, plus `jira auth` and `gh auth` lines.
  - `afx spawn <KEY-N> --protocol bugfix`: the builder receives the issue, a bare `porch next` in the worktree resolves the project, and the dashboard and sidebar show its phase and terminal.
  - `issue-comment` lands on the work item with line breaks and quotes intact.
  - `recently-closed` returns only Done-category items.
  - VS Code `Cmd+K I` with a key opens the Jira page.
  - Backlog rows read `ENG-123` and sort by project, then number.

## Flaky Tests

None skipped. One **deterministic, environmental** failure: `packages/codev/src/agent-farm/__tests__/cloud-config.test.ts` ("enforces 0600 on pre-existing files"). Under this session's `umask 077`, the test's setup cannot create its 0644 starting file. The file is identical to `main` and passes under `umask 022`, and porch's checks were run under `umask 022`. It is a known pre-existing issue (lesson from #1809).
