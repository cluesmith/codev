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

**Why this is first noticed with Jira rather than Linear.** Linear ids (`ENG-123`) have exactly the same shape and hit every gap listed here. They were never noticed because the Linear preset has not been run end to end through a builder lifecycle: its scripts carry `⚠️ UNVERIFIED` notes (no Linear credentials in the authoring environment, #920), and its acceptance criterion was only that `afx spawn ENG-123` parses (spec 719). Spawn parsing is the one site that works; everything that recovers the id afterwards is broken. Jira is the first tracker with a live site and a real project behind it, so these fixes repair Linear at the same time.

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

#### Live findings (acli 1.3.39-stable, against a live Jira Cloud site, read-only)

These were verified on 2026-10-12 with an installed, logged-in acli. Only reads were run. Several findings overturn assumptions in the first draft.

1. **`acli jira auth status` makes a real round trip.** It exits 0 with `✓ Authenticated / Site: <host> / Email: <addr> / Authentication Type: oauth`. With the network blackholed it exits 1 with `failed to retrieve authenticated status`. So it is a valid `auth-status` as is. It has no `--json` flag, so the text is parsed.
2. **The comment subcommand is `comment create`.** The docs' bare `comment --key …` example is a help-text artifact. Flags are `--key`, `--body`, `--body-file` ("plain text or ADF") and `--json`.
3. **`workitem search --fields` is allow-listed.** It accepts only `key, summary, status, labels, creator, reporter, assignee, description, issuetype, priority`. Dates (`created`, `resolutiondate`, `statuscategorychangedate`, `updated`), `fixVersions`, `comment`, `project` and the `*all` / `*navigable` wildcards are rejected (`field 'created' is not allowed`). **Search cannot return any timestamp.**
4. **`--fields key` on its own returns an array of `null`s.** Every search must also request at least one real field.
5. **`workitem view <key> --fields … --json` returns everything.** That includes `created`, `statuscategorychangedate`, `resolutiondate`, `fixVersions`, and `comment.comments[]`, each comment with `author{displayName,emailAddress}`, `body` (ADF) and `created`. View takes exactly **one** key (a comma or space list fails), and costs about 1.2 s per call.
6. **Search is slow.** 200 items took about 10 s. The forge exec timeout is 30 s (`forge.ts:370, 446`).
7. **The REST `self` link points at an internal host** (an Atlassian infrastructure host, not `<site>.atlassian.net`), **not the site.** The browse URL cannot be derived from `self`. It must come from `CODEV_JIRA_SITE`, or else from the `Site:` line of `auth status`.
8. **Unbounded JQL is rejected** ("Unbounded JQL queries are not allowed here"). Every query needs a restriction. `statusCategory != Done`, `= Done` and `is not EMPTY` all qualify.
9. **Done-category JQL works**: `statusCategory = Done … ORDER BY statusCategoryChangedDate DESC`. JQL date literals must be `yyyy-mm-dd [hh:mm]` (ISO `…T…Z` and `-36500d` are rejected), and they are interpreted in the user's Jira time zone.
10. **Other users' `emailAddress` is often hidden** (a profile privacy setting). `displayName` is always present.
11. **Real project keys can contain digits** (the `[A-Z][A-Z0-9_]+` grammar), which confirms that the spawn grammar must widen past `[A-Z]+`.

#### Revised concept mapping

| Concept | acli call | Mapping |
|---|---|---|
| `auth-status` | `acli jira auth status` | Exit code, plus a check that the `Site:` line matches `CODEV_JIRA_SITE` when that is set, so doctor never reports "authenticated" against the wrong tenant. |
| `user-identity` | `acli jira auth status` → `Email:` line | Plain text email. acli exposes no display name or account id for the current user. See the `assignees` row below for why email is the right key. |
| `issue-view` | `acli jira workitem view "$CODEV_ISSUE_ID" --fields summary,description,status,creator,reporter,assignee,labels,created,comment,fixVersions --json` | One call; comments are inline (finding 5), so no `comment list` call is needed. `title←summary`, `body←ADF→text(description)` (`null`→`""`), `state←status.name`, `url←<site>/browse/<key>`, `author←creator//reporter`, `createdAt←created`, `assignees←[assignee]`, `labels←labels[]`, `milestone←fixVersions[0]`, `comments←comment.comments[]` with ADF→text bodies. |
| `issue-list` | `search --jql "<scope> statusCategory != Done ORDER BY created DESC" --fields summary,status,labels,creator,assignee --limit 100 --json` | No dates are available (finding 3), so **`createdAt` is omitted**. The VS Code age sort and "new in 24h" marker already treat a missing date as unknown (`backlog-filter.ts:171`, `backlog-recency.ts:31`). The order still comes from JQL `ORDER BY created DESC`, so items arrive newest first. The limit is 100 rather than 200 to stay well inside the 30 s timeout (finding 6). |
| `issue-search` | Same, plus `description`. `CODEV_ISSUE_STATE` open/closed/all → `statusCategory != Done` / `= Done` / `is not EMPTY` (the last keeps the query bounded, per finding 8). | `IssueListItem` plus `body` (ADF→text). `createdAt` is omitted, as above. |
| `recently-closed` | `search --jql "<scope> statusCategory = Done AND statusCategoryChangedDate >= \"<since−1d, yyyy-mm-dd>\" ORDER BY statusCategoryChangedDate DESC" --fields summary,status,labels --limit 25`, then one `view <key> --fields created,statuscategorychangedate,resolutiondate --json` per hit, run with bounded parallelism (`xargs -P 6`). | `closedAt` is **mandatory**: `withinLast24h` (`github.ts:222`) drops any item without it. The one-day-earlier date-only bound is a superset that absorbs JQL's time-zone interpretation, and the consumer's exact 24 h filter trims it. `closedAt←statuscategorychangedate // resolutiondate`, `createdAt←created`. The window is 24 h, so the hit count is small. The cap of 25 bounds the worst case to about 2 rounds of parallel views. |
| `issue-comment` | `acli jira workitem comment create --key "$CODEV_ISSUE_ID" --body-file <mktemp>` | Plain text body via a temp file, which avoids quoting and argv limits. The temp file is removed by `trap`. **This is not exercised live:** posting a comment is a write to a real site, which I won't make without explicit permission. The dev-gate run confirms it, along with the line-break fidelity of plain text (ruling 7). If plain text renders badly, fall back to ADF paragraphs. |

Shared details:

- **Identity key: email, falling back to displayName.** The VS Code "mine" filter compares each item's `assignees[].login` against `user-identity`, lower-cased (`backlog-filter.ts:52-54`). `user-identity` can only be the email (finding 1), so `login ← emailAddress // displayName` for assignees, creators and comment authors. A user's own email is visible to themselves, so "mine" matches. Other users with hidden emails degrade to their display name, which is still readable. To be confirmed at the dev gate on an item assigned to the tester.
- **Site.** `CODEV_JIRA_SITE` from `forge.jira-site` takes precedence. Otherwise each URL-emitting script reads the `Site:` line of `acli jira auth status`. That adds one extra call (about 0.5 s), so the docs recommend setting `jira-site`.
- **Scope and injection safety.** `<scope>` is `project = "<KEY>" AND`, only when `CODEV_JIRA_PROJECT` is set. The key is **validated** against `^[A-Z][A-Z0-9_]+$`, and the script exits non-zero otherwise. That is stricter and simpler than escaping, because JQL string escaping is error-prone (probe: an embedded `"` breaks the parse). The issue-id inputs are passed as acli arguments, never spliced into JQL.
- **ADF→text** is a small `jq` `def`:
  - concatenate `text` nodes;
  - `hardBreak` → `\n`;
  - block nodes (`paragraph`, `heading`, `listItem`, `codeBlock`, `blockquote`) separated by blank lines;
  - `mention` / `emoji` / `inlineCard` use their `attrs.text` / `attrs.url`;
  - media is dropped.

  It is inlined in `issue-view` and `issue-search`.
- **Config plumbing needs no new code.** `buildForgeEnv` (`forge.ts:466-473`) maps `forge.jira-site` → `CODEV_JIRA_SITE` and `forge.jira-project` → `CODEV_JIRA_PROJECT`.
- **Fixtures for the unit tests** come from the live JSON captured above, **reduced to structure with synthetic values**. No site data is committed.

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

- **Risk: acli's output shape drifts between versions.** The shape was captured live from acli 1.3.39-stable. Consumers already treat non-conforming output as null, and jq field access uses `//` fallbacks throughout. The docs note the acli version the preset was verified against.
- **Risk: `issue-list` has no `createdAt`** (search refuses date fields). That is a deliberate degradation: VS Code age sort and the new-item marker treat it as unknown, and the order comes from JQL. Alternative rejected: one `view` per item (about 1.2 s × 100 exceeds the 30 s exec timeout).
- **Risk: `recently-closed` costs N+1 calls.** This is bounded by the 24 h window, the cap of 25 and parallel views. If it ever nears the timeout, lower the cap.
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
