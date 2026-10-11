# PIR Plan: Jira forge provider preset (hybrid, via `acli`)

## Understanding

Codev's forge concept layer (spec 589) has four presets: `github`, `gitlab`, `gitea`, and `linear`. `linear` is the hybrid template from spec 719: it owns the issue concepts, and every PR concept falls through to the github default (`packages/codev/src/lib/forge.ts:130-134`). A Jira-tracked project has no preset, so it has to hand-roll per-concept overrides.

The architect ruling on #1740 (2026-10-12) fixes these constraints, and this plan follows them without relitigating any:

- Jira **Cloud** only.
- Wrap Atlassian's official **`acli`**. No REST, no third-party CLI. Each script declares `# forge-executable: acli`.
- acli owns the credential. Codev never touches a token. Service accounts are unsupported (CLOUD-12991).
- The preset is hybrid and mirrors Linear's: the seven issue concepts only, with `pr-create` included in the fall-through.
- `recently-closed` keys on the status *category* Done, never on status names.
- JQL is scoped to the configured project key.
- Comments go in as plain text or plain-paragraph ADF. No markdown→ADF converter.
- No smart commits.
- `KEY-123` ids must work end to end.
- Docs are part of the lane.

There are two halves to the work.

**A. The preset itself.** Seven scripts, registration, doctor auth reporting and docs. This half is mechanical, following Linear.

**B. Non-numeric ids end to end (ruling item 9).** I re-verified the path rather than assuming spec 719 covered it. Spec 719 only widened the `afx spawn` parse and the types. Every site that later *recovers* an id from a worktree directory name, cwd, artifact filename, commit or PR text still assumes digits. Linear's `ENG-123` hits all of the same gaps today. For `afx spawn PROJ-123 --protocol pir`:

- Spawn, the worktree `.builders/pir-PROJ-123`, the branch `builder/pir-PROJ-123`, porch state `codev/projects/PROJ-123-*`, `CODEV_ISSUE_ID` and an explicit `porch next PROJ-123` all **work**.
- These sites **break**. Each was checked against source:
  - `agent-farm/servers/overview.ts:491-526` `worktreeNameToRoleId`: the generic branch yields `builder-pir-proj`, but the real id is `builder-pir-proj-123`. The overview loses the builder's terminal.
  - `overview.ts:535-577` `extractProjectIdFromWorktreeName`: every pattern is `\d+`, so it returns null. The builder renders as soft mode, with no phase, gates or progress.
  - `overview.ts:660-661, 701-702`: the trailing-digit fallback yields `"123"`.
  - `overview.ts:742-747` `scanArtifactDir`: the `/^\d+$/` filename prefix check means backlog rows lose their spec, plan and review links.
  - `commands/porch/state.ts:360-376` `detectProjectIdFromCwd`: the regex only knows `(pir|spir|…)-(\d+)` and `bugfix-(\d+)`. A bare `porch next` inside the worktree cannot infer the id. Every porch phase prompt relies on that.
  - `porch/state.ts:~426` `detectProjectId` fallback: `bugfix-\d+|\d{4}` only.
  - `agent-farm/commands/spawn.ts:292-305` `inferProtocolFromWorktree`: it splits on `-`, so `--resume` without `--protocol` fails.
  - `agent-farm/cli.ts:260, 430`: `attach --issue` and `cleanup --issue` use `parseInt`. `lib/builder-lookup.ts:27-38, 105-114` `findBuilderByIssue(number)` matches on `bugfix-(\d+)`. The collision hint at `spawn-worktree.ts:565` tells the user to run a command that cannot work.
  - `agent-farm/commands/reset/context.ts:425-429` `issueNumberFromPorchId`: `PROJ-123` becomes `"123"`, the wrong issue (fallback path only).
  - `lib/github.ts:483-545` `parseLinkedIssue` / `parseAllLinkedIssues`: the `#(\d+)` and `[Bugfix #(\d+)]` patterns mean PR↔issue linking never matches a key.
  - `commands/consult/index.ts:337`: the `.builders/…-(\d+)-` regex throws when multiple project dirs exist.
  - `apps/vscode/src/commands/open-issue-by-id.ts:36-42` `parseIssueId`: `/^\d+$/`. Its own header comment anticipates loosening it.
  - `apps/vscode/src/views/backlog-search.ts:87-88` `BARE_ID` / `TYPED_ID`: `\d+` only.
- These sites are **risky**:
  - The spawn parse `cli.ts:342-349` (`/^[A-Z]+-\d+$/i`) rejects valid Jira keys that contain digits or underscores in the project key (`AB2-12`, `MY_PROJ-1`).
  - It also accepts lowercase `proj-123` and keeps it as typed. Porch and worktree lookups then compare case-sensitively, and macOS's case-insensitive filesystem hides the mismatch.

## Proposed Change

Delivered as one PR with one commit per step.

### Step 1: Jira preset scripts (`packages/codev/scripts/forge/jira/`)

There are seven POSIX `sh` scripts, styled like the Linear ones. Each sets `set -e`, declares `# forge-executable: acli`, pipes acli's `--json` through `jq` into the `forge-contracts.ts` shapes, and puts `number: .key` (a string) in `IssueListItem.number`.

| Concept | acli call (subject to `--help` verification, see below) | Mapping |
|---|---|---|
| `auth-status` | `acli jira auth status` | Must make an authenticated round trip. If `status` only reads local config, use a minimal authenticated read instead, e.g. a 1-item `workitem search`. When `CODEV_JIRA_SITE` is set, also fail if acli's active site differs, so doctor never reports "authenticated" against the wrong tenant. Exit code only. |
| `user-identity` | `acli jira auth status` (account line) | Plain text: the account's display name or email, whichever acli exposes. |
| `issue-view` | `acli jira workitem view "$CODEV_ISSUE_ID" --fields summary,description,status,creator,reporter,assignee,labels,created,comment,fixVersions --json` | `title←summary`, `body←ADF→text(description)`, `state←status.name`, `url←<site>/browse/<key>`, `author←creator/reporter.displayName`, `assignees←[assignee]`, `labels←labels[]` (Jira labels are plain strings), `milestone←first fixVersion` (the Linear-project analogue, optional), `comments←comment.comments[]` (ADF→text). If `view` doesn't inline comments, use a second `comment list --key … --json` call. |
| `issue-list` | `acli jira workitem search --jql "<scope> statusCategory != Done ORDER BY created DESC" --limit 200 --json` | The `IssueListItem` shape, without `body`. |
| `issue-search` | Same, with `CODEV_ISSUE_STATE` open/closed/all mapped to `statusCategory != Done` / `= Done` / no clause. Adds `description` to the fields. | `IssueListItem` plus `body`. |
| `recently-closed` | `--jql "<scope> statusCategory = Done [AND statusCategoryChangedDate >= \"$CODEV_SINCE_DATE\"] ORDER BY statusCategoryChangedDate DESC" --limit 1000` | `closedAt←statuscategorychangedate` (fallback `resolutiondate`). Done-category only, never status names (ruling 5). |
| `issue-comment` | `acli jira workitem comment create --key "$CODEV_ISSUE_ID" --body-file <tmpfile>` | The body is written to a `mktemp` file, which avoids shell quoting and argv length limits. The docs say `--body` / `--body-file` accept "plain text or ADF", so plain text goes through as is. If that turns out to be false in practice, wrap it as ADF paragraphs split on blank lines (ruling 7). Exit code only. |

Shared details:

- `<scope>` is `project = "$CODEV_JIRA_PROJECT" AND`, only when it is set. Otherwise the JQL is unscoped, the same way Linear handles an unset team. All JQL values pass through `jq -n --arg` to build the string, so a key can never inject JQL.
- The browse URL comes from `CODEV_JIRA_SITE` if set (`https://acme.atlassian.net`). Otherwise it is derived from the scheme and host of the issue's REST `self` link. It is never the API URL (the `IssueViewResult.url` contract).
- The ADF→text flattener is a small `jq` `def` that joins text nodes per block and separates blocks with blank lines. It is inlined in `issue-view` and `issue-search`, the only two consumers. No markdown fidelity is attempted.
- Config plumbing needs no new code. `buildForgeEnv` (`forge.ts:466-473`) already maps `forge.jira-site` → `CODEV_JIRA_SITE` and `forge.jira-project` → `CODEV_JIRA_PROJECT`.

**Verification before coding.** acli is not installed in this environment, and the official reference contradicts itself (`comment create` vs `comment` in its own examples; the `--json` wording on `view`). In the implement phase I will:

1. Install it with `brew tap atlassian/homebrew-acli && brew install acli`.
2. Confirm every subcommand and flag via `acli jira … --help` (ruling 2).

The *JSON shape* of acli's output can only be confirmed against a live, logged-in Cloud site, which I don't have. I'll code to the documented Jira REST v3 issue shape that acli wraps, mark each script's mapping as `⚠️ UNVERIFIED against a live site` exactly as Linear did (#920), and make the dev-gate live run the confirmation. **If the architect can provide a sandbox Jira Cloud site + login, I'll verify there before the dev gate instead.**

### Step 2: register the preset (`packages/codev/src/lib/forge.ts:126-135`)

`jira: buildPresetFromScripts('jira', ['team-activity', 'on-it-timestamps'])` sits next to `linear`, with a comment that points at the Linear hybrid rationale. The backend key resolves to `acli` through the `forge-executable` declaration (`resolveForgeBackend`), so it gets its own rate-limit budget. Jira's PR concepts key to `gh`, the same as Linear's. No change is needed in `forge-rate-limit.ts`.

### Step 3: honest auth in `codev doctor` (`packages/codev/src/commands/doctor.ts:1262-1282`)

Today auth is reported only when `provider === 'github'`, so a Jira (or Linear) workspace gets no auth line. I'll make two changes:

- For any non-github provider whose `auth-status` resolves (not disabled), run it and print `<provider> auth  authenticated | not authenticated`. The recommendation is per provider: `jira` → `run: acli jira auth login (standard user account; service accounts unsupported)`, `linear` → `set LINEAR_API_KEY`.
- For the hybrid providers (`linear`, `jira`), also report `gh auth` by running the github default `auth-status` via the `forgeConfig: { provider: 'github' }` option. Every PR concept they use spends `gh`, so a Jira project that isn't logged into `gh` cannot open PRs. Doctor should say so.

### Step 4: issue keys end to end

Add one shared helper module, `packages/codev/src/lib/issue-id.ts`, so the key grammar lives in one place:

- `ISSUE_KEY_SOURCE = '[A-Za-z][A-Za-z0-9_]*-\\d+'`, Jira's project-key grammar. It is a superset of Linear's.
- `isIssueKey(s)`.
- `canonicalIssueId(s)`: uppercases a key, and leaves numbers alone.

Then fix each broken site from the Understanding list:

- **Spawn parse** (`cli.ts:342-349`): accept the full key grammar and **canonicalize to uppercase** at the single entry point. Jira and Linear keys are uppercase by definition. This removes the case-split class (lowercase spawn followed by uppercase `porch next`) at its source. The same canonicalization applies to `attach --issue` / `cleanup --issue` (`cli.ts:260, 430`), and `findBuilderByIssue` widens to `number | string`.
- **Worktree-name recovery** (`overview.ts` `worktreeNameToRoleId`, `extractProjectIdFromWorktreeName`, the trailing-digit fallbacks): add a key branch per protocol prefix. `pir-PROJ-123[-slug]` → `builder-pir-proj-123` / `PROJ-123`, and `bugfix-PROJ-123[-slug]` → `bugfix-PROJ-123`. These run *before* the generic and numeric branches. The key pattern is anchored as `<prefix>-<KEY>-<digits>`, so a slug can't be misread as part of the key.
- **Artifact scan** (`overview.ts:742-747`): accept a key prefix as well as a numeric one.
- **Porch cwd detection** (`porch/state.ts` `detectProjectIdFromCwd`, `detectProjectId`): the same key alternatives.
- **Resume** (`spawn.ts` `inferProtocolFromWorktree`): match the protocol prefix plus the id, not `split('-')[1]`.
- **Reset fallback** (`reset/context.ts` `issueNumberFromPorchId`): return the key, not its digits.
- **PR↔issue linking** (`lib/github.ts` `parseLinkedIssue` / `parseAllLinkedIssues`): recognise keys **only inside the bracketed protocol tags** (`[Bugfix #KEY-N]`, `[PIR #KEY-N]`, `[Spec KEY-N]`), plus a branch name `builder/<proto>-KEY-N`. Bare `ABC-123` tokens in free text are not matched, because `UTF-8`-style false positives are real.
- **Consult** (`consult/index.ts:337`): accept key worktree names.

The VS Code extension gets a twinned copy of the key pattern, with a sync note pointing at `issue-id.ts`. That is the accepted twinned-map pattern. The `codev-types` package stays wire-contracts only.

- **`open-issue-by-id.ts` `parseIssueId`**: accept `#?\d+` **or** a key (canonicalized to uppercase), and reword the input-box prompt to "issue id (e.g. 42 or PROJ-123)".
- **`backlog-search.ts` `BARE_ID` / `TYPED_ID`**: the same widening.

Deliberately untouched:

- `on-it-timestamps` skips non-numeric ids by design, and it is disabled for Jira.
- `team-update.ts:44` is a cosmetic `#N` scrape of commit lines.
- The protocol prompt templates already render `[PIR #PROJ-123]`, which is readable. After the `parseLinkedIssue` change it is parseable too.

### Step 5: docs

- `codev/resources/commands/forge.md`: add `jira` to the provider list, along with:
  - a hybrid paragraph;
  - prerequisites: install `acli` and run `acli jira auth login` once, with a standard user account (CLOUD-12991);
  - Cloud-only scope;
  - the `jira-site` / `jira-project` config keys with an example;
  - a short "Jira notes" section: Done-category semantics, plain-text comment fidelity, no smart commits (close the issue yourself on merge), and `KEY-123` ids.
- The forge skill in both shipped copies, `.claude/skills/forge/SKILL.md` and `.codex/skills/forge/SKILL.md`, which are byte-identical: add `linear` and `jira` to the "Built-in presets" line. The Linear omission predates this lane, but it is the same line. There is no skeleton copy of the forge skill.
- Skeleton user-facing docs keep hardcoding `gh` for PR work (ruling 10). No skeleton edits.

## Files to Change

- `packages/codev/scripts/forge/jira/{auth-status,user-identity,issue-view,issue-list,issue-search,recently-closed,issue-comment}.sh`: new.
- `packages/codev/src/lib/forge.ts:126-135`: register `jira`.
- `packages/codev/src/lib/forge-contracts.ts` and `packages/types/src/api.ts:434,442`: add Jira's field mapping to the `url` / `author` doc comments (comment-only).
- `packages/codev/src/commands/doctor.ts:1262-1282`: provider auth and hybrid `gh` auth reporting.
- `packages/codev/src/lib/issue-id.ts`: new shared key helper.
- `packages/codev/src/agent-farm/cli.ts:260, 342-349, 430`: key grammar and canonicalization.
- `packages/codev/src/agent-farm/lib/builder-lookup.ts:27-38, 105-114`.
- `packages/codev/src/agent-farm/commands/spawn.ts:292-305`, `spawn-worktree.ts:565` (hint text).
- `packages/codev/src/agent-farm/servers/overview.ts:491-577, 660-702, 742-747`.
- `packages/codev/src/commands/porch/state.ts:360-430`.
- `packages/codev/src/agent-farm/commands/reset/context.ts:425-429`.
- `packages/codev/src/lib/github.ts:483-545`.
- `packages/codev/src/commands/consult/index.ts:337`.
- `apps/vscode/src/commands/open-issue-by-id.ts:36-42, 83-86`, `apps/vscode/src/views/backlog-search.ts:87-88`.
- `codev/resources/commands/forge.md`, `.claude/skills/forge/SKILL.md`, `.codex/skills/forge/SKILL.md`.
- Tests: see the Test Plan.

## Risks & Alternatives Considered

- **Risk: acli's real JSON differs from the REST v3 shape.** Consumers already treat non-conforming output as null, so a wrong mapping degrades to "unavailable" rather than crashing. Each script is marked unverified, and the dev-gate live run (or a sandbox site, if provided) is the confirmation. jq field access uses `//` fallbacks throughout.
- **Risk: `acli jira auth status` doesn't hit the server.** I would then use a 1-item authenticated read instead. Which one ships is decided by the `--help` / behavior check in implement.
- **Risk: uppercase canonicalization changes behavior for existing lowercase Linear spawns** (`eng-123` → `ENG-123`). Lowercase Linear ids currently produce exactly the case-split bug, and Linear identifiers are uppercase, so this is a fix. Existing numeric ids are untouched.
- **Risk: the worktree-name key branch misreads a protocol name plus a numeric slug** (e.g. `experiment-1560-slug`). This is mitigated by requiring the key to start with a letter *after* the protocol prefix and to be immediately followed by `-<digits>`. Regression tests cover every existing numeric form.
- **Risk: scope.** Step 4 touches about ten sites. All of them are the same root-cause defect (digit-only id recovery), and ruling 9 explicitly puts the path in scope. Each site gets a focused test.
- **Alternative: direct REST with `curl` + `jq`** (zero dependency, like Linear). Rejected by ruling 2.
- **Alternative: a markdown→ADF converter.** Rejected by ruling 7.
- **Alternative: lowercase keys everywhere instead of uppercase.** Rejected because Jira and Linear render keys uppercase, and users will type or paste them that way from the tracker UI.
- **Alternative: put the key regex in `codev-types` so VS Code can import it.** Rejected because types is wire-contracts only. A twinned pattern with a sync note is the accepted pattern.

## Test Plan

**Unit (vitest, `packages/codev`):**

- `forge.test.ts`:
  - `jira` is in `getKnownProviders()`.
  - Issue concepts resolve to `scripts/forge/jira/*.sh` with source `preset`.
  - `pr-create`, `pr-list` and `pr-merge` fall through to the github scripts.
  - `team-activity` and `on-it-timestamps` are disabled.
  - No concept is unresolvable (the hybrid guard).
  - `resolveForgeBackend('issue-list', jira)` → `acli`, `pr-list` → `gh`.
  - The existing #1645 builtin test covers the `forge-executable` declarations automatically.
- Jira script output tests with a **stub `acli` on `PATH`**: a fixture script that echoes recorded REST-v3-shaped JSON and logs its argv. These assert:
  - contract-shaped output for `issue-view`, `issue-list`, `issue-search` and `recently-closed`;
  - the JQL that was sent: project scoping, Done-category clauses, the since-date clause, and quoting of a hostile project key;
  - `issue-comment` passing the body via `--body-file` and preserving multi-line and quote characters;
  - the browse URL derived from `self` and from `CODEV_JIRA_SITE`;
  - the ADF flattening.
- `issue-id.test.ts`:
  - accepts `PROJ-123`, `AB2-12`, `MY_PROJ-1`;
  - rejects `-12`, `PROJ-`, `PROJ`, `12-PROJ`;
  - canonicalizes `proj-123` → `PROJ-123`.
- Worktree-name tests (`overview` tests): `pir-PROJ-123`, `pir-PROJ-123-slug`, `bugfix-PROJ-123-slug` and `spir-ENG-7`, plus **every existing numeric case unchanged**.
- `detectProjectIdFromCwd` / `detectProjectId`, `inferProtocolFromWorktree`, `issueNumberFromPorchId`, `parseLinkedIssue` (including the negative case: `UTF-8` in a PR body is not linked), and `findBuilderByIssue`.
- doctor:
  - a jira provider prints a `jira auth` line and a `gh auth` line;
  - `acli` missing → the executable warning;
  - auth failure → a recommendation that mentions `acli jira auth login`.

**Unit (`apps/vscode`):** `parseIssueId` accepts `#42`, `42`, `PROJ-123` and ` proj-123 ` (→ `PROJ-123`), and still rejects the existing malformed cases. The same goes for the backlog-search typed-id detection.

**Full-suite gates:** `pnpm build`, `pnpm test`, and `check-types` (tsc) in both `packages/codev` and `apps/vscode`.

**Manual (dev-approval gate, live Jira Cloud site, per the architect's ruling).** Config: `{"forge": {"provider": "jira", "jira-site": "https://<site>.atlassian.net", "jira-project": "<KEY>"}}`, after `acli jira auth login`.

1. Run `codev doctor` and check:
   - the Forge Concepts section shows the 7 issue concepts as `preset acli` and the PR concepts as `default gh`;
   - the `jira auth` line shows authenticated;
   - logging out of acli flips it to not authenticated, with the login recommendation.
2. Run `afx spawn <KEY-N> --protocol bugfix`. The builder's prompt contains the real issue title and body. The worktree is `.builders/bugfix-<KEY-N>…`, and a bare `porch next` inside it resolves the project.
3. The dashboard/overview shows that builder with its phase and terminal, not as soft mode.
4. Exercise `issue-comment` (e.g. the builder's "On it!" comment). The comment lands on the work item, and line breaks and quotes are intact.
5. `recently-closed` returns only Done-category items: move one item to a custom-named Done status and confirm it appears, and one item to an in-progress status and confirm it does not.
6. VS Code: `Cmd+K I`, type `<KEY-N>`, and the Jira work item opens in the browser.
