# codev - Project Management CLI

The `codev` command manages project setup, maintenance, and framework-level operations, and
runs the read-only `codev check` commands architects use at merge and cleanup time.

## Synopsis

```
codev <command> [options]
```

## Commands

### codev init

Create a new codev project.

```bash
codev init [project-name] [options]
```

**Arguments:**
- `project-name` - Name of the project (optional, prompts if not provided)

**Options:**
- `-y, --yes` - Use defaults without prompting

**Description:**

Creates a minimal codev project structure:
- `codev/specs/` - Specification files
- `codev/plans/` - Implementation plans
- `codev/reviews/` - Review documents
- `CLAUDE.md` / `AGENTS.md` - AI agent instructions
- `.gitignore` - Standard ignores

Framework files (protocols, roles) are provided by the embedded skeleton at runtime, not copied to the project.

**Examples:**

```bash
# Interactive creation
codev init

# Create with name
codev init my-app

# Non-interactive with defaults
codev init my-app -y
```

---

### codev adopt

Add codev to an existing project.

```bash
codev adopt [options]
```

**Options:**
- `-y, --yes` - Skip conflict prompts

**Description:**

Adds codev structure to the current directory. Detects existing files (CLAUDE.md, AGENTS.md) and prompts before overwriting.

Use this when you want to add codev to a project that already has code.

If CLAUDE.md or AGENTS.md conflicts, adopt launches Claude to merge the `.codev-new` versions; interactively it waits for that session to end. Then, on a project with code to document, it asks "Draft the governance docs from this codebase now?" (default No); yes runs `codev bootstrap-docs`. With `-y` nothing is launched and the command is listed under "Next steps" instead. An empty project gets neither the offer nor the hint.

**Examples:**

```bash
# Add to current project
cd existing-project
codev adopt

# Skip prompts for conflicts
codev adopt -y
```

---

### codev bootstrap-docs

Draft the governance docs from the existing codebase.

```bash
codev bootstrap-docs [options]
```

**Options:**
- `-n, --dry-run` - Report which files are eligible and what would launch; launch and write nothing

**Description:**

Writes a first draft of the four governance files (`codev/resources/arch.md`, `lessons-learned.md`, `arch-critical.md`, `lessons-critical.md`) from the code shape, build wiring and git history. Only files that are still the untouched starters are rewritten; a file with real content is read as input and never edited, and a missing file is reported (run `codev update` to restore it). An empty project is left with its placeholders. Re-running on a populated result changes nothing.

**Flow:**

1. Classify the four files and print each one's status.
2. Write the prompt to `.consult/bootstrap-docs/prompt.md`, show the exact agent command, what it may write and that it consumes model quota, and ask before launching (always; there is no `-y`). The agent follows the `update-arch-docs` skill's bootstrap mode: the project's installed copy when it is identical to the package's version, otherwise the packaged text included in the prompt (the launch statement says which). The agent explores the git history itself, read-only.
3. Run the configured architect harness on the terminal. Exit the session when it says the drafts are done.
4. Report what changed: drafts written, hot-tier cap and map violations, and any path outside the four files (change detection covers the git state and every path git does not ignore, except `.consult/`, where consult writes its own output).
5. When `consult` is available, run a three-way review of the drafts; reviews land in `.consult/bootstrap-docs/<model>.md`.

Nothing is committed: review the drafts, edit, then commit them yourself.

**Manual fallback:** when no supported agent CLI is found, or the prompt is too long to pass as an argument, nothing is launched; give `.consult/bootstrap-docs/prompt.md` to your own agent as its first message.

**Exit codes:** `0` when nothing needed doing, the launch was declined, or the drafts are clean; `1` when there is no `codev/` directory, the agent failed, a draft is missing or breaks the hot-tier rules, or anything changed outside the four files (during the session) or anywhere (while the reviewers ran). Reviewer verdicts never change the exit code. Under `codev adopt`, a pass with problems is reported in its summary, and adopt still exits `0`.

**Examples:**

```bash
# See what would happen
codev bootstrap-docs --dry-run

# Draft the docs
codev bootstrap-docs
```

---

### codev doctor

Check system dependencies.

```bash
codev doctor
```

**Description:**

Verifies that all required dependencies are installed and properly configured:

**Core Dependencies (required):**
- Node.js (>= 22.0.0)
- git (>= 2.5.0)
- gh (GitHub CLI, authenticated)

**AI CLI Dependencies (at least one required):**
- Claude (the installed `claude` CLI, 2.1.141 or newer; its login is checked with `claude auth status`, with no model call)
- Gemini (Antigravity CLI, `agy`)
- Codex (`@openai/codex`)

**Migration Backups (report-only):**
- Leftover copies of pre-migration state — whole-directory `~/.agent-farm.bak-*` / `~/agent-farm-db-backup-*` copies and the `*.pre-merge-<timestamp>` renames left by `afx db consolidate` — listed with age and size on disk.
- Nothing reaps these automatically, so doctor surfaces each one together with the exact `rm -rf` command and leaves the decision to you. It never deletes anything.
- Backups younger than 7 days are listed but not counted as warnings; the section is omitted entirely when there are none.

**Exit Codes:**
- `0` - All OK or warnings only
- `1` - Required dependencies missing

**Example:**

```bash
codev doctor
```

Output:
```
Codev Doctor - Checking your environment
============================================

Core Dependencies (required for Agent Farm)

  ✓ Node.js      22.12.0
  ✓ git          2.42.0
  ✓ gh           authenticated
  ✓ @cluesmith/codev  1.0.0

AI CLI Dependencies (at least one required)

  ✓ Claude       2.1.326
  ✓ Gemini       working
  ○ Codex        not installed (npm i -g @openai/codex)

============================================
ALL OK - Your environment is ready for Codev!
```

---

### codev update

Update codev templates and protocols.

```bash
codev update [options]
```

**Options:**
- `-n, --dry-run` - Show changes without applying
- `-f, --force` - Force update, overwrite all files
- `-a, --agent` - Non-interactive agent mode with JSON output on stdout

**Description:**

Updates framework files (protocols, roles, agents) from the installed `@cluesmith/codev` package. User data (specs, plans, reviews) is never modified.

If you've customized a file locally, the update creates a `.codev-new` file with the new version so you can merge changes manually.

Shipped Claude and Codex skills (`.claude/skills/`, `.codex/skills/`) are refreshed too. A missing skill is added. A skill you never edited, one whose content matches a version Codev shipped, is replaced with the package's version. An edited skill is kept, and each of its files that differs gets a `<file>.codev-new` copy of the new version for the merge, on every update while it differs. A file the package adds to an edited skill arrives as `.codev-new` too. `--force` overwrites an edited skill's packaged files as well, keeping any file the package does not ship. A symlinked skill directory, one holding a symlink, or a symlinked `.claude/`, `.codex/` or skills root is left alone. `--dry-run` reports all of this without writing.

CLAUDE.md and AGENTS.md are compared with the package's template everywhere outside the generated hot-context block (between the `CODEV HOT CONTEXT` markers). One that matches is up to date and left alone. One edited outside the block is kept, and the template is written beside it as `.codev-new` for the merge. The block is regenerated from `codev/resources/{arch,lessons}-critical.md` on every update, so an edit inside it is replaced and reported as a block refresh, never a conflict: edit the hot files instead. A doc an older release wrote is a conflict too when the template has since changed outside the block, even if you never edited it. `--dry-run` prints the lines the real run would print, writing nothing.

When a governance file is still a starter on a project with code, `codev update` prints one line pointing at `codev bootstrap-docs` (in `--agent` mode it is the `instructions.bootstrapDocs` string instead; never on `--dry-run`).

In agent mode (`--agent`), human-readable output goes to stderr and structured JSON is written to stdout. The JSON includes file lists, conflict details, and merge instructions. The interactive Claude merge is skipped.

**Examples:**

```bash
# Preview changes
codev update --dry-run

# Apply updates
codev update

# Force overwrite (discard local changes)
codev update --force

# Agent mode (JSON output for automation)
codev update --agent
```

### codev check

Read-only checks an architect runs at the moments that need them: `codev check pr` before
recommending a merge, `codev check deploy` after merges, `codev check worktree` before
`afx cleanup`.

```bash
codev check pr <number> [--json]
codev check deploy <number>... [--json]
codev check worktree <builder-id|path> [--json]
```

**What every subcommand shares:**

- It never merges, approves, pushes, comments, deletes, cleans up or moves a ref. Every
  subprocess goes through one runner that checks its argv against a closed allow-list of git
  subcommands and flags before it starts, and calls only the read forge concepts `pr-view`,
  `pr-search`, `commit-checks` and `workflow-runs`. Anything else is refused and the command
  exits 2 naming it.
- The first line is the verdict and what needs attention. Then a header, then one line per
  check with a status word:

  | Word | Status | Meaning |
  |---|---|---|
  | `ok` | `ok` | Passed |
  | `ATTN` | `attention` | Blocks a recommendation, or the project flagged it |
  | `info` | `info` | Worth knowing; never changes the verdict (size, overlap, files to read, unflagged watched files) |
  | `not run` | `not-run` | Could not run, with the reason (the concept, key, call or git version). Always counts as attention, never as passing |
  | `off` | `off` | No configuration for it |
  | `skip` | `skip` | Declared skipped in `check.skip` |

- Exit codes: **0** clear (nothing needs attention, nothing failed to run); **1** something
  needs attention, including any check that could not run; **2** the command failed and made
  no report (bad input, not in a git repository, no `origin`, invalid configuration, a
  refused command, for `pr` a PR that cannot be read, for `worktree` a worktree that is not
  found).
- `--json` prints exactly one JSON object (schema 1) on stdout; diagnostics go to stderr.
  See [JSON reports](#json-reports) below.
- It reads the same from the main checkout, a subdirectory or any builder worktree:
  configuration is read from the main checkout, and builder ids resolve under its
  `.builders/`.
- Live tips come from `git ls-remote`; the local `origin/<branch>` is never trusted. Each forge
  call, `ls-remote` and `fetch` has a 30 s limit; a call that times out makes the checks that
  needed it `not run`.

#### codev check pr

Everything an architect reads before recommending a merge, for one PR:

| Check id | What it reports |
|---|---|
| `head` | The exact head commit from the forge, against the local branch of that name. Attention when the local branch is ahead of it (not pushed) or has diverged, when origin's branch is past it (a push the forge has not indexed yet), or when it moved during the run |
| `state` | Attention unless the PR is OPEN and not a draft |
| `forge` | The forge's mergeability, with its merge state beside it in the forge's words (`MERGEABLE, BLOCKED (review required)`). `MERGEABLE` is `ok`; `CONFLICTING` is attention, and so is `UNKNOWN` (not computed yet; it is read once more) |
| `attribution` | Lines in the description and in every commit not on the base that match `check.attribution`; any hit is attention |
| `trial-merge` | A merge of the head into the live base tip, computed in the object store (`git merge-tree --write-tree`); any conflict is attention |
| `checks` | CI on the code. When the top commits change only `codev/projects/` (porch state), the runs on the last code commit are shown beside the head's |
| `watched` | Files matching `check.watch` that moved; attention for those matching `check.flag` |
| `linked-issue` | The closing keyword (`Fixes #N`) and whether it names the branch's issue; attention when it names another |
| `overlap` | Files the base also changed since the branch point |
| `size` | Lines added and removed, files changed |
| `to-read` | The files a person still has to read: the PR's files minus `check.notForReading` |

A PR whose head and state are fine shows them in the header only. Run from the main checkout
on an open bugfix PR:

```
$ codev check pr 1965
CLEAR  PR #1965 — ready to recommend

PR #1965  Fix #1956: cap packages/codev vitest at 3 workers (singleFork was dead since Vitest 4)   OPEN   builder/bugfix-1956 → main
head  0513558  (local builder/bugfix-1956 matches)      base  main @ e0e96fd (origin, live)

  ok      forge          MERGEABLE, BLOCKED (review required)
  off     attribution    no patterns configured (check.attribution)
  ok      trial merge    clean into main @ e0e96fd
  ok      checks         head 0513558: porch-only, 8 passed
  ok      watched        no watched file changed
  info    linked issue   "Fixes #1956" — matches builder/bugfix-1956
  info    overlap        no file also changed on main since the branch point
  info    size           +157 −11 in 8 files
  info    to read        6 files (2 not for reading): packages/codev/src/__tests__/bugfix-1956-vitest-worker-cap.test.ts, … +5
```

A draft PR whose CI is still running:

```
$ codev check pr 1958
ATTENTION  PR #1958 — state (draft), checks (running)

PR #1958  [Spec 1951] Read-only PR check for architects: codev check pr | deploy | worktree   OPEN (draft)   builder/spir-1951 → main
head  f93aa60  (local builder/spir-1951 matches)      base  main @ e0e96fd (origin, live)

  ATTN    state          OPEN but a draft: it must be marked ready for review first
  ok      forge          MERGEABLE, BLOCKED (review required)
  off     attribution    no patterns configured (check.attribution)
  ok      trial merge    clean into main @ e0e96fd
  ATTN    checks         head f93aa60: 1 passed, 14 still running
  ok      watched        no watched file changed
  info    linked issue   "Fixes #1951" — matches builder/spir-1951
  info    overlap        no file also changed on main since the branch point
  info    size           +13,297 −60 in 76 files
  info    to read        65 files (11 not for reading): codev/plans/1951-read-only-pr-check-for-archite.md, … +64
```

`codev check pr` checks the merge mechanics; `consult --type integration` reviews the content.
Run the check first: its `size` and `to read` lines are the inputs to risk triage, and a
blocker it names makes a model review premature.

**Porch-only heads.** A commit is porch-only when every path it changes from its first parent
is under `codev/projects/`; a merge commit never is. The last code commit is the first commit
that is not porch-only, walking the first-parent chain from the head back to the merge base.
The code's runs are those on the newest commit from that one up to the head that has any
check result. `checks` is `ok` only when those runs all passed (skipped and neutral count as
passed) and nothing on the head failed or is pending. No runs anywhere on the code is
attention. At most 10 commits are queried; beyond that the check is `not run`.

#### codev check deploy

For each merged PR: is the merge commit on the deploy branch (`check.deploy.branch`, else the
PR's base, read live), and, with `check.deploy.workflow` set, inside the latest green run of
that workflow on the deploy branch? Without a deploy workflow, `merge-checks` reports CI on
the merge commit itself instead. A PR that cannot be read, or is not merged, is reported as
such and the other PRs are still checked.

| Check id | What it reports |
|---|---|
| `merged` | Whether the PR is merged; attention when it is not |
| `on-branch` | Whether the deploy branch's live tip contains the merge commit |
| `deploy-run` | Whether the latest green `check.deploy.workflow` run contains the merge commit; `off` without one |
| `merge-checks` | CI on the merge commit; reported when no deploy workflow is configured |

With nothing configured:

```
$ codev check deploy 1972 1962
ATTENTION  #1972 merge checks failed

#1972  merged 2026-11-24 → main   merge e0e96fd
  ok      on main        origin/main @ e0e96fd contains e0e96fd
  ATTN    merge checks   e0e96fd: 8 passed, 2 failed (Verify Release (ubuntu-latest), Verify Release (macos-latest))
  off     deploy run     no deploy workflow configured (check.deploy.workflow)
#1962  merged 2026-11-24 → main   merge adb179f
  ok      on main        origin/main @ e0e96fd contains adb179f
  ok      merge checks   adb179f: 18 passed
  off     deploy run     no deploy workflow configured (check.deploy.workflow)
```

With `"check": { "deploy": { "branch": "main", "workflow": "test.yml" } }`, and one PR not
yet merged:

```
$ codev check deploy 1962 1965
ATTENTION  #1965 not merged

#1962  merged 2026-11-24 → main   merge adb179f
  ok      on main      origin/main @ e0e96fd contains adb179f
  ok      deploy run   latest green test.yml run (2026-11-24 10:41, e0e96fd) contains adb179f
#1965  OPEN → main
  ATTN    merged       OPEN: not merged
  not run on main      the PR is not merged (OPEN)
  not run deploy run   the PR is not merged (OPEN)
```

#### codev check worktree

Would removing a builder's worktree and its local branch lose data? The argument is a
builder id (resolved to `.builders/<id>` under the main checkout) or a path to a registered
worktree; anything else is exit 2.

| Check id | What it reports |
|---|---|
| `uncommitted` | Staged, unstaged and untracked files git does not ignore. Spawn's scaffold is counted apart and is not data |
| `commits` | Local commits on neither the live base tip nor the live remote branch tip. When the PR is merged by squash or rebase and the local tip is its merged head, every commit was part of what merged |
| `remote` | The local tip against `origin/<branch>`: matches, ahead, behind, diverged or absent. Context only |
| `pr` | The branch's PR. OPEN is attention ("builder not finished"); no PR found is attention; MERGED and CLOSED are `ok` |
| `ignored` | Ignored files matching `cleanup.keepIgnored` (and not dependency or build output) would be lost; every other ignored path is counted as regenerable |

The verdict word describes **data only**: `REMOVABLE`, `REMOVABLE AFTER KEEPING N FILES` (only
keep-list files would be lost: copy them out first, or use `afx cleanup --keep-ignored`) or
`NOT REMOVABLE`. **`REMOVABLE` means no data would be lost, not that the builder is
finished.** An open PR, or a PR state the forge cannot give, makes the exit code 1 without
changing the verdict word. Exit 0 only for `REMOVABLE` with nothing else needing attention.

```
$ codev check worktree air-1938
REMOVABLE  air-1938

worktree  .builders/air-1938   branch builder/air-1938   base main @ e0e96fd (origin, live)
  ok      uncommitted   nothing uncommitted   [5 scaffold files not counted]
  ok      commits       1 commit not on origin/main, all on origin/builder/air-1938
  ok      remote        origin/builder/air-1938 matches local (07e9090)
  ok      pr            #1939 MERGED
  ok      ignored       no keep-list files; 31 ignored paths treated as regenerable: .claude/settings.local.json, .codev/, … +29
```

```
$ codev check worktree bugfix-1956
REMOVABLE AFTER KEEPING 2 FILES  bugfix-1956 — PR #1965 open: builder not finished

worktree  .builders/bugfix-1956   branch builder/bugfix-1956   base main @ e0e96fd (origin, live)
  ok      uncommitted   nothing uncommitted   [5 scaffold files not counted]
  ok      commits       7 commits not on origin/main, all on origin/builder/bugfix-1956
  ok      remote        origin/builder/bugfix-1956 matches local (0513558)
  ATTN    pr            #1965 OPEN: builder not finished
  ATTN    ignored       2 keep-list files would be lost: codev/projects/bugfix-1956-tests-one-run-of-the-packages-/bugfix-1956-pr-iter1-claude.txt, … +1
                        (31 other ignored paths treated as regenerable: .claude/settings.local.json, .codev/, … +29)
                        → copy them out first, or use `afx cleanup --keep-ignored`
```

**What is scaffold, not data.** The files `afx spawn` writes (root `.builder-*` files, the
write guard's hook script and settings, OpenCode's `opencode.json`), when untracked, and the
entries spawn links in from the main checkout: the root `.env`, `.codev/config.json` and each
`worktree.symlinks` entry. Spawn makes each of those as a symbolic link to the same path in the
main checkout, or, where it may not, a hard link of that file, or a copy. Any of the three
shapes is scaffold while it matches (a copy only while its bytes equal the main checkout's
file); a changed copy is data. So an untracked file whose bytes equal the main checkout's
file at the same path is scaffold whoever made it: removing it loses nothing while the main
checkout still holds that file. `afx cleanup`'s uncommitted-changes notice uses the same rule.
A project that gitignores `.builder-*` sees those files under `ignored`, where the default keep
list matches them, so they show as keep-list data instead.

**Links among the keep-list files.** A symbolic link to a keep-list file inside the worktree is
judged as that file. Any other link (outside the worktree, to a file that is not kept, or to
nothing) is listed apart as `path -> target` and makes the worktree `NOT REMOVABLE`:
`afx cleanup --keep-ignored` never copies a link, so it cannot keep one. This errs on the safe
side: a link to an unkept file inside the worktree also blocks.

**What `regenerable` counts.** Every ignored path that is not a keep-list file, as
`git ls-files --ignored --directory` lists it: a wholly ignored directory counts once (so the
number is approximate inside collapsed directories), and a directory holding a keep-list match
is left out. A nested repository's `dir/` entry is counted as listed, not expanded.

#### Configuration

All keys are read from the main checkout through the usual configuration layers (arrays
replace, never concatenate). A bad value is exit 2, naming the key and the file that set it.

| Key | Meaning | Default |
|---|---|---|
| `check.attribution` | Regexes (JavaScript syntax, case-insensitive, matched per line) for forbidden attribution lines in the PR description and in every commit message not already on the base. They are trusted configuration and run without a time limit, so keep them simple: a pattern that backtracks badly on a long line can hang the command | `[]`: `off` |
| `check.watch` | Globs of files whose movement is always listed | `CLAUDE.md`, `AGENTS.md`, `.codev/**`, `.claude/**`, `codev/roles/**`, `codev/protocols/**`, `codev/templates/**`, `codev/resources/arch-critical.md`, `codev/resources/lessons-critical.md` |
| `check.flag` | Globs, within what `check.watch` matches, whose movement is attention | `[]` |
| `check.notForReading` | Globs left out of the files a person still has to read | `codev/projects/**`, `codev/state/**`, and the lockfiles `**/pnpm-lock.yaml`, `**/package-lock.json`, `**/yarn.lock`, `**/Cargo.lock`, `**/poetry.lock`, `**/uv.lock`, `**/go.sum`, `**/Gemfile.lock`, `**/composer.lock` |
| `check.deploy.branch` | The deploy branch for `codev check deploy` | each PR's base branch |
| `check.deploy.workflow` | The workflow (file name or name) whose latest green run on the deploy branch must contain the merge | unset: `deploy run` is `off` and `merge checks` is reported |
| `check.skip` | Check ids to skip, e.g. `["checks"]` for a project with no CI | `[]` |
| `cleanup.keepIgnored` | Ignored-file globs worth keeping (#1950, shared with `afx cleanup --keep-ignored`) | `codev/projects/**`, `codev/state/**`, `.builder-*`, `tmp/**`, `scratch/**` |

Globs are git `:(glob)` pathspecs, so git does the matching: `*` stays within one directory and
`**` crosses directories. Setting `check.notForReading` replaces the default list; add a
project's generated files there (for example `packages/*/dist/**`).

Example, in `.codev/config.json`:

```json
{
  "check": {
    "attribution": ["^Co-Authored-By:.*(Claude|Copilot)", "Generated with \\[Claude Code\\]"],
    "flag": ["CLAUDE.md", "AGENTS.md"],
    "deploy": { "branch": "production", "workflow": "deploy.yml" }
  }
}
```

#### Forges

`codev check` reads the forge only through concepts: `pr-view` (with the optional fields
`headRefOid`, `isDraft`, `mergeable`, `mergeStateStatus`, `mergeCommit`, `mergedAt`,
`reviewDecision`), `pr-search`, `commit-checks` and `workflow-runs`; see
[forge](forge.md). A preset that cannot supply one makes the checks that need it `not run`,
naming the concept, never a guess. `gitlab` and `gitea` disable `commit-checks` and
`workflow-runs`, so their `checks`, `merge checks` and `deploy run` lines read
`not run: commit-checks unavailable on gitlab` until an override supplies them. A `pr-view`
without `headRefOid` is exit 2 for `codev check pr`, because nothing can be reported against a
guessed head.

#### What it writes, and what it trusts

The only writes are additions to git's object store: the packs a ref-neutral fetch downloads
when the head or base commit is missing locally
(`git -c gc.auto=0 -c maintenance.auto=false fetch --no-write-fetch-head --refmap= origin <sha>…`),
and the tree and blob objects the trial merge writes (unreachable; normal gc collects them). No
ref, `HEAD`, index, working-tree file or `FETCH_HEAD` is created, changed or removed. Status
reads use `git --no-optional-locks`.

The allow-list governs every git command the check runs and which forge concepts it calls.
Two things run that it does not inspect, and both are yours rather than the PR's:

- **A project's own concept override** (a `forge` entry in your configuration) runs as you
  wrote it, as overrides do everywhere in Codev. The shipped scripts for the four concepts
  call only `gh pr view`, `gh pr list`, `gh run list` and `gh api` with GET, and tests hold
  them to that.
- **A custom merge driver** may run during the trial merge. A PR's `.gitattributes` can name a
  driver but cannot define its command: that comes only from your own git configuration.

#### JSON reports

`--json` prints one object. Every report has `schema: 1`, `command` (`pr`, `deploy` or
`worktree`), `verdict` (`clear` or `attention`) and `generatedAt` (ISO 8601). A failed command
(exit 2) prints `{ schema: 1, command, error: { message, cause? } }` instead.

Each check is `{ id, status, summary, details, reason? }`: `status` is one of `ok`,
`attention`, `info`, `not-run`, `off`, `skip`; `summary` is the text the summary line prints;
`reason` says why for `not-run`, `off` and `skip`, and such a check's `details` may be empty or
partial. Paths are repository-relative; SHAs are full.

| Report | Fields |
|---|---|
| `pr` | `pr: { number, title, url?, state, draft, headRef, head, baseRef, baseTip, localBranch }`, `checks`. `draft` is `null` when the forge does not say; `baseTip` is `null` when the live base tip could not be read (the base checks are then `not run`); `localBranch` is `{ name, sha }` or `null` |
| `deploy` | `deployBranch` (`null`: each PR's own base), `workflow` (or `null`), `prs: [{ number, mergedAt, mergeCommit, baseRef, verdict, checks }]`; the first three of each PR are `null` until known |
| `worktree` | `removable` (`removable`, `removable-after-keeping` or `not-removable`), `worktree: { path, builderId, branch, baseRef, baseTip }`, `checks`. `builderId` is `null` for a worktree outside `.builders/`; `baseRef` is `null` when neither the PR's base nor origin's default branch could be read, and `baseTip` when the live tip could not be (`commits` is then `not run`) |

`details` per check id:

| id | `details` |
|---|---|
| `head` | `{ forgeHead, relation, localBranchSha?, aheadOfPr?, behindPr?, originBranchSha?, originAheadOfPr?, movedTo? }`: `relation` is `matches`, `ahead`, `behind`, `diverged`, `absent` (no local branch), `origin-ahead` or `not-origin-branch` (a fork's PR, or the branch moved: the local branch is not compared) |
| `state` | `{ state, draft }` |
| `forge` | `{ mergeable, mergeStateStatus, reviewDecision }`, in the forge's words |
| `attribution` | `{ patterns, hits: [{ where: 'description' or 'commit', sha?, line, text }] }` |
| `trial-merge` | `{ baseTip, head, conflicts, files }` |
| `checks` | `{ head: CommitRuns, code?: CommitRuns, lastCodeCommit, porchOnlyAbove }`, where `CommitRuns` is `{ sha, runs: [{ name, state, url?, workflow? }], passed, failed, pending }`. `lastCodeCommit` is `null` when every commit since the branch point is porch-only |
| `watched` | `{ files: [{ path, flagged }] }` |
| `linked-issue` | `{ references: [{ keyword, issue }], keyword?, issue?, branchIssue? }`: every closing reference, the one chosen, and the issue a `builder/<protocol>-<id>` branch is for |
| `overlap` | `{ files }` |
| `size` | `{ additions, deletions, files }` |
| `to-read` | `{ files: [{ path, additions, deletions }], excluded }` |
| `merged` | `{ state, mergedAt, mergeCommit }` |
| `on-branch` | `{ branch, tip, contains }` |
| `deploy-run` | `{ workflow, run?: { headSha, url, createdAt }, contains? }` |
| `merge-checks` | `CommitRuns` |
| `uncommitted` | `{ files: [{ path, change }], scaffold }` |
| `commits` | `{ total, notOnBase, unsafe }`: `unsafe` is the commits on no remote branch, which are what blocks removal |
| `remote` | `{ remoteSha, relation }`: `relation` is `matches`, `ahead`, `behind`, `diverged` or `absent`; `remoteSha` is `null` when absent |
| `pr` | `{ number?, state?, mergedHead? }` |
| `ignored` | `{ keep, regenerable, links: [{ path, target, missing }], scaffold }`: `keep` is the keep-list files that would be lost, `regenerable` the count above, `links` the keep-list links that block removal (`missing` when the target does not exist), `scaffold` spawn's links among the ignored files |

---

## See Also

- [afx](agent-farm.md) - Agent Farm commands
- [consult](consult.md) - AI consultation
- [overview](overview.md) - CLI overview
