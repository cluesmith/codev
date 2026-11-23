# bugfix-1952 thread — no AI attribution trailers in this repo

## Investigate (2026-11-23)

- Reproduced the claim: `git log origin/main --since=2026-06-01` has 361 commits with a
  `Co-Authored-By: Claude … <noreply@anthropic.com>` trailer (Opus 4.6 → Fable 5.1 names).
- Settings key verified against code.claude.com/docs (settings + settings-reference):
  `attribution: { commit: "", pr: "" }` hides both; `includeCoAuthoredBy` is deprecated since
  v2.0.62 and ignored once `attribution.commit`/`.pr` is set, so it is not added.
  `attribution: false` also exists but needs v2.1.281+, so the empty-string form is the one
  older contributor installs understand.
- `--settings <file>` is a separate layer above user/project/local that overrides only the keys
  it sets. Tower's lifecycle-reporter file sets only `hooks`, so it cannot shadow `attribution`.
- Project `.claude/settings.json` is read from the session's working directory. Builders start
  in their worktree root, the architect in the workspace root; both get the committed file.
- Nothing ignores it: `.gitignore` has only `.claude/channels/ci/`; the owner's global ignore
  covers only `settings.local.json`. Spawn writes only `.claude/settings.local.json` (hooks), so
  nothing shadows the key at the local layer. No managed-settings file on this machine.
- Gotcha for the A/B test: with the owner's `~/.claude/CLAUDE.md` loaded, the model honoured the
  private rule and the baseline showed no trailer. The fair baseline is the contributor's case
  (no private rule): `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`.
- A/B (scratch repos, Tower flags, `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`): without the settings
  file the commit got `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and pr.md got
  `🤖 Generated with [Claude Code](…)`; with it, neither. Root cause confirmed: harness default.

## Fix (2026-11-23)

- `.claude/settings.json` (attribution commit/pr = "") + one rule line in the Git section of
  CLAUDE.md/AGENTS.md (byte-identical). Skeleton untouched per the issue's scope.
- Regression test `packages/codev/src/__tests__/bugfix-1952-no-attribution.test.ts`: 3 of 4 fail
  before the fix (ENOENT on settings.json; no rule in either Git section), all pass after.
- Live evidence: the moment `.claude/settings.json` landed in this worktree, this running builder
  session (launched by Tower with `--settings <lifecycle-reporter file>`) had its harness
  attribution instruction flip from "End git commit messages with: Co-Authored-By: Claude Opus
  5.5…" to "do not add attribution lines". Claude Code hot-reloads the project settings file.
- `hot-tier-materialization.test.ts` fails in a fresh worktree before `pnpm build` ("Skeleton
  directory not found"); environmental, passes once the build bundles the skeleton.
- Worktree check: a headless session started at this worktree's root with Tower's builder flags
  and Tower's real `--settings` lifecycle-reporter file (CODEV_* unset, so the hook posts
  nothing; CLAUDE.md loading off) committed into a scratch repo with no attribution; the same
  run from a clone at the pre-fix commit got both the trailer and the "Generated with" line.
- First porch `tests` run failed intermittently (load ~17-23; porch truncates output so the test
  is unnamed); the full suite then passed twice (405 files / 8266 tests, and porch's rerun).

## PR (2026-11-23)

- PR #1953. CMAP: claude APPROVE (nits taken: skeleton guard always asserts; PR body notes the
  test covers presence not effectiveness; Test Plan heading). codex REQUEST_CHANGES ×2:
  (1) loosened doc assertions dropped the prohibition, resolved by requiring no/never/not
  earlier in the same sentence as each term; (2) `chore(porch):` commits violate protocol.md's
  "every commit starts with [Bugfix #N]". Rebutted: porch writes those itself (19 of the last
  21 builder merges carry them); the protocol-vs-porch contradiction is the owner's call, not
  a history rewrite here. Flagged to the architect.
- Correction: the diagnostic `vitest run` started at load 23, over the issue's ceiling of 18.
