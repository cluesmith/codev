# pir-1740 thread: Jira forge preset

## 2026-10-12: plan phase
- Architect ruling on #1740 fixes: Cloud only, wrap `acli`, hybrid like Linear, Done-category closed semantics, no smart commits, KEY-123 ids end to end.
- acli not installed here; official reference is self-inconsistent (`comment create` vs `comment`). Implement phase installs via brew tap and verifies with --help. JSON shape can only be confirmed against a live Cloud site (asked architect for a sandbox).
- Surprise: non-numeric ids are NOT end-to-end for Linear either. Spec 719 widened spawn parse + types only; overview worktree-name recovery, porch cwd detection, resume, PR<->issue linking, VS Code open-by-id all assume digits. Plan step 4 fixes them via a shared issue-id helper + uppercase canonicalization at spawn.
- Doctor reports auth only for github today; plan adds provider auth + gh auth for hybrids.

## 2026-10-12: live acli probe (owner installed + logged in), plan revised
- Read-only probe of acli 1.3.39. Key facts: auth status is a real round trip (text, no --json); `workitem search --fields` is allow-listed and returns NO dates; `view` returns everything (one key per call, ~1.2s); REST `self` is an infra host, so browse URL needs jira-site or the auth-status Site line; unbounded JQL is rejected; `--fields key` alone returns nulls.
- Design changes: issue-list omits createdAt; recently-closed does search + per-hit view (24h window, capped); identity keyed on email.
- Owner instruction: keep tenant-specific details out of committed artifacts; fixtures are structural with synthetic values.

## 2026-10-21: implement phase
- Plan approved (owner word via architect); plan text verified identical across the rebase hash change before `porch approve`.
- Jira scripts follow gitea's `_lib.sh` pattern (sourced helpers: site, JQL scope, key validation, ADF flattener). Live read-only smoke against the owner's acli: issue-list/search/view/recently-closed/auth-status/user-identity all conform. issue-comment NOT exercised live (write to a real site).
- Safety check flagged an `rm -f "$2/$1.json"` in script text; rewrote recently-closed to write `.part` then rename, cleanup via `${WORK:?}`.
- Overview: stored `builders.id` is the terminal role id, so it is now preferred over parsing names, BUT only when it has the buildAgentName shape (`builder-`/`worktree-`); legacy rows carry ids like `bugfix-42`.
- Key/short-id collision: issue-less protocol spawns are `<protocol>-<base64url shortid>`, e.g. `maintain-Ab-3`, indistinguishable from a key by name. Stored row with null issue_number wins (soft, no issue).
- Trap caught by the regression tests: `bugfix-200` is itself key-shaped; every key pattern now tries numeric forms first.
- `parseIssueId` stays numeric because Open PR by ID shares it; new `parseIssueInput` for issues.
- spawn.test.ts re-implemented inferProtocolFromWorktree instead of testing it; extracted a pure exported `inferProtocolFromDirs` and pointed the old cases at it.
- Not done (outside plan or not reachable): branch-name PR linking (parseLinkedIssue never sees the branch); numeric `[PIR #N]` tag linking was already missing and is left as is.
- Real-path check caught what unit tests missed: `codev doctor` warned "jira-site is not a known forge concept" (validateForgeConfig only knew concepts; linear-team had the same false warning). Added a per-provider settings registry. Real doctor now: 7 issue concepts `preset acli`, PR concepts `default gh`, `jira auth` + `gh auth` both authenticated; a wrong jira-site reports not authenticated with the login hint.
- Full suites: build ok, tsc ok (codev + vscode), vscode 1233/1233, codev 6646 pass + 1 deterministic unrelated failure (cloud-config 0600 test: fixture writes 0644 but env umask 077 yields 0600; not touched by this branch).

## 2026-10-21: dev gate, architect review note
- Role-id fallback: buildAgentName lowercases the WHOLE base64url short id (`builder-experiment-ab-3`, `builder-maintain-x_9q`). The old generic/task/worktree branches stopped at '-'/'_' and were wrong (lost the terminal); new key branch already matched for `Ab-3`, and the fallback now takes the whole short id. Pinned against buildAgentName itself.
- PR linking: BUGFIX PRs carry no bracketed tag (title `Fix #<N>:`, body `Fixes #<N>`), so key linking only via tags missed every BUGFIX PR. Added closing-keyword + `#KEY` (hash required; `Closes KEY` inert). PIR links via its `[PIR #KEY]` commit list in the PR body.
- umask-077 cloud-config failure: known pre-existing (architect has it on record); no action in this lane.
- Owner asked for the remaining id edges now. VS Code: id sort is key-aware (project, then zero-padded number); labels drop `#` for canonical keys only (issueRef); terminal-manager matched builders by `split('-').pop()`, which turned a key into its digits (wrong tab title / wrong builder); fixed via roleShortId.
- Web dashboard (apps/web) audit: one real break: WorkView matched the terminal tab by case-sensitive substring of issueId (`ENG-123` never in `builder-pir-eng-123`); now exact roleId first, case-insensitive fallback. Also fixes a pre-existing numeric collision (builder 12 opening 123). `#` labels in BuilderCard/NeedsAttention/Backlog/RecentlyClosed use issueRef. Browser (Playwright) check pending at the dev gate: needs a Tower serving this build.
