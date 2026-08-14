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
