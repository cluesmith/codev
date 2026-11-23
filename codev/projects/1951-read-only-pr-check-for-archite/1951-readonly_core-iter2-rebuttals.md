# Phase 2 (readonly_core): iteration 2 response

Both reviewers asked for changes, and every point is accepted. The changes are in the commit after `08fd44979`.

## Codex

**1. The stub `git` accepts valid forms outside the allow-list, such as `git log <sha>` or `git diff <sha> <sha>` without the mandatory guards.**
Accepted. The stub's grammar is now closed for each subcommand. Each one has its own list of permitted flags, and every option before `--` must be on that list. `log`, `show`, `diff` and `diff-tree` must carry both `--no-ext-diff` and `--no-textconv`, and `version` takes no arguments. Globbing is off in the stub (`set -f`), so its flag lists are never expanded against files.

The grammar is still separate code from the runner's allow-list, written in `sh`.

A new shared list, `OFF_GRAMMAR_FORMS` in `helpers/git-forms.ts`, holds invocations that are read-only in themselves but fall outside the grammar:
- the four diff-family commands without their guards;
- `rev-list --all`, `cat-file --batch`, `ls-files --stage`, `rev-parse --git-path` and `version --build-options`.

Both the allow-list test and the stub self-test now require each of these to be refused. So a regression that drops a guard is caught by either layer.

**2. The stub `gh` misses joined write-flag forms.**
Accepted. `gh api` now refuses any argument that begins with `--method`, `--field`, `--raw-field` or `--input`. It also refuses any single-dash argument containing `X`, `f` or `F`. That covers `-XPOST`, `-ftitle=x`, `-Fbody=@f` and short clusters such as `-iX POST`.

The self-test covers all twelve write forms: `pr merge`, `pr comment`, `-X POST`, `-f`, `--method=POST`, `-XPOST`, `-iX POST`, `--field=…`, `-f…`, `-F…`, `--raw-field=…` and `--input=…`. It also checks that the read-only `api --paginate … --jq …` form the forge scripts use still gets through.

## Claude

**1. `settings.test.ts` and `roots.test.ts` read the developer's real `~/.codev/config.json`.**
Accepted. A new helper, `helpers/fake-home.ts`, points both `HOME` and `USERPROFILE` at an empty temp directory for each test, as `src/__tests__/config.test.ts` does. The settings, roots and runner tests use it. The runner test is included because it also loads forge configuration through the same layers.

A new settings test writes `check.*` into the fake `~/.codev/config.json`. It confirms that the file is read as a layer, and that a bad value there is reported naming that file.

**2. `diff-tree` is exempt from the forced `--no-ext-diff --no-textconv` (minor).**
Accepted. `diff-tree` now requires both flags in the allow-list and in the stub, like `diff`, `log` and `show`. The shared read form carries them, and the unguarded form is refused by both layers.

**3. `remoteDefaultBranch` returns an unvalidated branch name supplied by the remote (minor).**
Accepted. A name that fails `isRefName` now returns `{ ok: false, reason: "origin's HEAD names an invalid branch \"…\"" }`, instead of failing later as a runner refusal. A test injects such a reply.
