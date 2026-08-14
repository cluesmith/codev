# bugfix-1455 — `pr-create` is not a forge concept

Issue #1455. BUGFIX protocol, strict mode. Upstream contribution: origin is the fork
`pseudoseed/codev`, PR targets `cluesmith/codev`.

## Environment notes (from the architect briefing)

- `command -v gh` → `/Users/chris/dev/codev-1455/.local/bin/gh` (verified). A bare `gh` on this
  machine would hit a Forgejo shim injected on PATH by `~/.zshrc`; the repo-local passthrough
  wins. Re-verify before trusting any `gh` output.
- `tea` 0.14.2 installed, one configured login (`pseudoseed` → https://git.pseudoseed.com,
  default). The gitea script can and will be tested end to end against live Forgejo.
- `.local/` is in `.git/info/exclude`; `.codev/config.json` is gitignored. Diff must contain
  only the fix.

## Investigate phase — findings

**Reproduced** (temporary vitest harness against `src/lib/forge.ts`, since removed):

```
concepts: issue-view, pr-list, issue-list, issue-search, issue-comment, pr-exists,
          recently-closed, recently-merged, user-identity, team-activity,
          on-it-timestamps, pr-merge, pr-search, pr-view, pr-diff, auth-status, repo-archive
gitea pr-merge : .../scripts/forge/gitea/pr-merge.sh
gitea pr-create: null          <-- unroutable, even with provider fully configured
```

**Root cause**, four linked gaps:

1. `packages/codev/src/lib/forge.ts:64` — `KNOWN_CONCEPTS` has no `pr-create`. Everything else
   is derived from that list: `getDefaultCommands()`, `buildPresetFromScripts()`,
   `resolveAllConcepts()` (doctor), and `validateForgeConfig()`. So `getForgeCommand('pr-create')`
   returns `null` for every provider, and a hand-written `forge["pr-create"]` override is
   reported by `codev doctor` as an *unknown concept* — and is never read by anything.
2. `packages/codev/scripts/forge/{github,gitea,gitlab}/` — no `pr-create.sh` exists.
3. Prompts hardcode `gh pr create` in 14 files (7 per tree):
   `{codev,codev-skeleton}/protocols/{air/prompts/pr.md, aspir/prompts/review.md,
   bugfix/prompts/pr.md, bugfix/protocol.md, maintain/prompts/review.md,
   pir/prompts/review.md, spir/prompts/review.md}`.
   (The issue's file list names `codev-skeleton/porch/prompts/*` — that directory does not
   exist; the real locations are the protocol prompt dirs above.)
4. Nothing injects a resolved `pr-create` command into a phase prompt. The precedent for doing
   so exists for `pr-merge`: `packages/codev/src/commands/porch/next.ts:227` and `:768` resolve
   the concept and paste the command string into the task description.

**Why it's invisible until the PR phase**: reads and `pr-merge` route correctly, so a Gitea
project looks fully configured right up to the one write that matters.

## Contract decision (the part the maintainer asked to agree on)

Going with the **env-var + JSON-stdout** shape, matching every other concept rather than an
argv passthrough:

- Inputs: `CODEV_PR_TITLE` (required), `CODEV_PR_BODY` (required, may be empty),
  `CODEV_PR_BASE`, `CODEV_PR_HEAD`, `CODEV_PR_REPO`, `CODEV_PR_DRAFT` (all optional).
- Output: `{"number": <int>, "url": "<web url>"}` on stdout; non-zero exit on failure.

Rationale: `executeForgeCommand()` passes inputs as `CODEV_*` env and parses stdout as JSON. An
argv-passthrough (`<cmd> --title … --body …`) would be unusable from TypeScript and would make
`pr-create` the only concept with its own calling convention. Will be argued in the PR body.

Prompt side: porch substitutes a `{{pr_create_command}}` template variable, same idea as the
`pr-merge` injection. Prose mentions of `gh pr create` (protocol.md files) get reworded
forge-neutrally.

## Constraints found

- `packages/codev/src/__tests__/bugfix-685-close-keyword.test.ts` pins the PR-body heredoc shape
  `--body "$(cat <<'EOF' … EOF)"` in 5 prompts, and pins codev↔codev-skeleton byte-identity for
  6 prompts. Changing the invocation means updating that guard's regex — deliberately, not
  incidentally.
- Docs carrying the concept table: `codev/resources/commands/forge.md`, plus the byte-identical
  pair `.claude/skills/forge/SKILL.md` and `.codex/skills/forge/SKILL.md`. The skeleton ships no
  forge skill, so nothing to mirror there.

Scope fits BUGFIX: ~1 line in `forge.ts`, 3 shell scripts, ~25 lines of porch/prompt plumbing,
small edits to 14 prompts + 3 docs, plus regression tests.

## Fix phase — what shipped

- `forge.ts`: `pr-create` added to `KNOWN_CONCEPTS` (one line — everything else derives from it).
- `forge-contracts.ts`: `PrCreateResult` documents the env-var inputs and `{number, url}` output.
- `scripts/forge/{github,gitea,gitlab}/pr-create.sh`. GitHub is `gh pr create` with the flags it
  already took. Gitea uses `--description` (not `--body`), sends tea's rendered output to stderr,
  and looks the new PR up with `tea pulls list --fields index,url,head --output json` rather than
  parsing that rendered view. GitLab is marked ⚠️ UNVERIFIED (`glab` is not installed here) —
  included anyway because without it the gitlab preset falls through to `gh`, which is the bug.
- `porch/prompts.ts`: `{{pr_create_command}}` template variable, resolved per project config,
  falling back to "open the PR manually" when the concept is disabled.
- 14 prompt files across both trees now use
  `CODEV_PR_TITLE=… CODEV_PR_BODY="$(cat <<'EOF' … EOF)" {{pr_create_command}}`.
  PIR switched off `--body-file` (its body is `$(cat codev/reviews/…)` now).
- Docs: `codev/resources/commands/forge.md` + the `.claude`/`.codex` forge SKILL.md pair.
- `bugfix-685-close-keyword.test.ts`: the body-template regex now accepts `CODEV_PR_BODY=` as
  well as `--body`; guard intent unchanged.

### Live Forgejo E2E (tea 0.14.2, git.pseudoseed.com/pseudoseed/research)

Three scratch PRs, all closed and their branches deleted afterwards:

- PR #15 — explicit `CODEV_PR_BASE`/`CODEV_PR_HEAD`. Script printed
  `{"number":15,"url":"https://git.pseudoseed.com/pseudoseed/research/pulls/15"}` and nothing
  else on stdout. Body read **back from the server** via the REST API: 428 bytes sent, 428
  received, byte-identical — quotes, backticks, `$VAR`, `\backslash`, fenced block, checkboxes,
  em dash all intact. Server-side `base`/`head`/`title` matched the inputs.
- PR #16 — no `CODEV_PR_HEAD`: the `git rev-parse --abbrev-ref HEAD` default and tea's own base
  default both resolved correctly.
- Answering the issue's open question: on tea **0.14.2** with a single configured login and an
  explicit `--head`, `tea pulls create` needs no `--repo`/`--login` and does not prompt.
  Both are still forwarded when set.

### Pre-existing gitea bugs found while testing (NOT fixed here — #1137/#1146 territory)

- `tea pulls view <n> --output json` ignores `<n>` and dumps a list of all pulls, so
  `gitea/pr-view.sh`'s `jq '.url = …'` gets an array.
- `tea pulls list` rejects `--fields description`, so `gitea/pr-list.sh`'s `description -> body`
  mapping cannot populate.
- `tea pulls list --output json` gives `head` as a plain branch string, but
  `gitea/pr-exists.sh` filters on `.head.ref`.
- `gh pr edit --body-file` is still hardcoded in `pir/prompts/review.md` — `pr-edit` is not a
  concept and adding one is outside this issue.

## PR phase

PR **#1458** against `cluesmith/codev` (base `main`, head `pseudoseed:builder/bugfix-1455`,
`isCrossRepository: true` — verified from the server, not assumed). Opened with the new
`scripts/forge/github/pr-create.sh`; the 7,937-byte body read back over the API is byte-identical
to what went in.

Porch's `tests` check could not pass on this machine: `spec-1280-measurement-instrument.test.ts`
shells out to `measure-prompt-surface.sh`, which costs 25–30 s per invocation here (~2.0 s on
record), and two of its tests call it twice against a 60 s budget. The branch is 0 commits behind
`upstream/main` and that file and script are byte-identical to main. Architect chose "advance past
it, don't touch the budgets, disclose it in the PR body". Advanced via a `porch.checks.tests`
override in `.codev/config.json`, which is a **symlink to the main workspace** — so I copied the
file into the worktree, added the override, advanced, then restored the symlink. Main's config was
never modified.

### CMAP: gemini APPROVE · codex REQUEST_CHANGES · claude REQUEST_CHANGES

Three real defects, all fixed in `a9f534ed`+ follow-ups:

1. **codex** — the prompts used an assignment *prefix* (`CODEV_PR_TITLE=… cmd`). A script reading
   the environment works, but an **inline** override (the documented form, e.g.
   `"pr-merge": "glab mr merge \"$CODEV_PR_NUMBER\" --yes"`) has its `"$CODEV_PR_TITLE"` argument
   expanded by the calling shell *before* the assignment applies — so it receives empty strings.
   Verified with a two-line shell experiment. Prompts now `export`. Pinned by a test that renders
   the real shipped prompt, extracts the bash block and **executes** it against an inline override.
2. **claude** — `extractExecutable` reads a script's first substantive line, so `set -e` made
   `codev doctor` report `pr-create … set not found`; it could no longer tell a Gitea user that
   `tea` was missing. Added a `# forge-executable: <tool>` declaration honoured ahead of the
   heuristic, plus a shell-builtin skip list. Verified against the built `dist`: github→gh,
   gitea→tea, gitlab→glab.
3. **claude** — `gitea/pr-create.sh`'s lookup had no `--limit`, unlike every sibling script; on a
   busy repo it would create the PR and then exit 1 claiming it couldn't find it. Now `--limit 200`.

Also took claude's non-blocking note: the disabled-concept fallback rendered as a `#` comment
(valid shell, exit 0, no PR). It now fails loudly.

### CMAP round 2: gemini APPROVE · claude APPROVE · codex REQUEST_CHANGES

4. **codex** — the scripts checked the title but not the body. `--body ""` succeeds on every
   forge, so omitting `CODEV_PR_BODY` entirely opened a bodyless PR at exit 0 — the exact silent
   failure the issue's testing notes describe. Now `${CODEV_PR_BODY+x}` separates unset from
   deliberately empty, failing before the forge CLI is reached, with a per-provider test covering
   both. Also documented `CODEV_PR_LOGIN` (claude's minor: read by the gitea script, named
   nowhere).

### CMAP round 3: gemini APPROVE · codex APPROVE · claude APPROVE

Took claude's two remaining minors: `.head` now accepts both the string (tea 0.14.2) and the
object-with-`.ref` shape sibling scripts assume, so a lookup miss can't report failure for a PR
that exists and invite a duplicate retry; and the stale "15 concepts" counts in `forge.ts` and
`arch.md` are corrected to 18 with `pr-create` listed.

Re-verified live afterwards: PR #17 on the Forgejo scratch repo, body/base/head correct on the
server, closed and branch deleted.
