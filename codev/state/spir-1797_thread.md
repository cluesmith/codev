# spir-1797 thread — adopt: bootstrap governance docs

## Specify
- No pre-existing spec; drafted from issue + code read (adopt.ts, scaffold.ts, managed-block.ts, update-arch-docs skill, MAINTAIN).
- Recommendation: dedicated `codev` subcommand (working name `bootstrap-docs`) offered at end of `adopt`; content rules as a new bootstrap mode in the `update-arch-docs` skill; CLI owns eligibility (per-file placeholder gating), launch, post-run validator (slots/cap/map), consult, "review before commit".
- Open for plan gate: interactive vs headless run, harness vs hardcoded claude, where consult output goes, classifier rule.
- Spec CMAP iter1: gemini APPROVE; codex + claude REQUEST_CHANGES. Folded in: per-file placeholder predicate (subset-of-starter AND marker present; seeded lessons = starter), non-empty-repo definition, section-scoped cap counting (comment lines excluded), map validity map→cold always / full coverage only when <=12 sections, detect-and-report (pre/post file+git snapshot, non-zero exit, no auto-revert) instead of a guarantee, await adopt's merge session before offering bootstrap, secrets bright-line rule, harness capability + manual-prompt fallback, consult output in .consult/bootstrap-docs/, real-repo verification as a review-phase gate.

## Spec gate
- spec-approval approved 2026-10-12T20:28:58Z (owner word relayed by main). OQ 1-5 stand as resolved in spec.
- Main's addition for the PLAN: the three universal lessons seeded in lessons-critical.md SURVIVE the bootstrap unless a project-specific lesson displaces one under the cap.

## Plan
- Plan drafted: 5 phases (classifier/validator lib → skill bootstrap mode + prompt template → harness `buildInteractiveTaskLaunch` capability → `codev bootstrap-docs` command → adopt/update integration + docs). Real-repo verification stays a review-phase gate item.
- Decisions: git-log digest computed by the CLI (last 300 subjects + ≤150 fix/revert/incident subjects), inlined into the prompt. `claude` and `codex` both verified (2026-10-13 `--help`) to accept a positional prompt for interactive sessions; OpenCode/custom → prompt-file fallback at `.consult/bootstrap-docs/prompt.md`. Seeded universal lessons survive unless displaced under the cap (demoted to cold, never dropped). Only earlier starter variant is the pre-#1012 cold text.
- Plan CMAP: iter1 G APPROVE / X,C REQUEST_CHANGES; iter2 G APPROVE / X,C RC; iter3 G,C APPROVE / X RC. All points folded except one (below). Final plan: 6 phases (consult split out as phase 5). Key iter fixes: missing files ineligible; verbatim single-version classifier; map rule promoted from hot-tier.test.ts helpers (+unique match); tree-tripwire core promoted to lib/tree-snapshot.ts + index hash; harness launch only on positive Claude/Codex identification, headless flags/subcommands unsupported; .claude/settings.local.json exit-bearing (annotated).
- OPEN for plan gate: Codex wants gitignored paths in the change detector; plan keeps the spec's "four files + git state" reading (ignored paths excluded, stated in the summary).
- plan-approval gate pending (2026-10-13).
- 2026-10-12 main ruling: change detector stays git-scoped (gitignored paths not watched; scope statement in every summary). Holding at plan-approval for the owner word.
- plan-approval APPROVED 2026-10-12T22:27Z (owner word "Approve the plan review gate for 1797", relayed by main). Owner did not override the git-scoped detector. Entering implement.

## Implement
- Plan-phase refresh task was emitted once and not captured; skipped (no state lost).
- phase_1: lib/governance-bootstrap.ts (classifier, isNonEmptyRepo, validators) + tests; hot-tier.test.ts now imports the shared cap/map helpers.
- Side fix: agent-farm cloud-config.test.ts "enforces 0600" failed deterministically under umask 077 (writeFileSync mode is umask-filtered) and blocked porch's test check. Added chmodSync(0o644) to set the precondition explicitly. Unrelated to 1797; flagged to architect.
- phase_1 iter1: Codex RC (files untracked at review time) -> committed c4b0ac538; Claude minors fixed (comment-line cap count, guarded ls-files). One porch test-check failure after the rebuttal did not reproduce (full suite green twice); failing test not captured; watch for recurrence.
- phase_1 APPROVED iter3 (G/X/C). Carry to phase_4: add an empty-section violation (hot file with zero entries, cold file with zero sections must not pass as success); a1/**/b glob over-match + skipped negations in non-git walk; SLOT_LINE flags '- <url>' bullets.
- phase_2 APPROVED iter2 (G/X approve, C comment: exact-heading map match + keep '-->' — both applied in a follow-up commit).
- phase_3: HarnessProvider.buildInteractiveTaskLaunch (claude/codex = positional prompt, verified vs --help on claude 2.1.296 / codex-cli 0.162.1) + resolveInteractiveTaskLauncher (positive identification only; claude -p/--print and any codex subcommand -> unsupported with reason; RetiredHarnessError/unknown names caught). Codex list holds ALL subcommands incl. resume/fork, since those read their own positionals.
- phase_3 iter1 CMAP: G approve, C approve (comments), X REQUEST_CHANGES (codex `mcp-server` missing; not in 0.162.1 help but existed in earlier releases, added). Applied C's comments too: Claude subcommands + --bg/--background + -r/--resume (optional value swallows the prompt) now block; per-harness rules moved to provider-level `interactiveLaunchBlocker?(flags)` instead of a name-keyed if-chain. Review doc must note the cloud-config.test.ts umask fix is a side fix, not phase work.
- phase_3 iter2 CMAP: G/X approve, C comment (variadic/optional-value flags swallow the appended prompt; =value form unmatched). Applied: prompt args are now ['--', prompt] for claude+codex (verified 2026-10-13 that both honour `--` after a variadic flag: `claude -p --add-dir /tmp -- "<p>"`, `codex exec -i <f> -- "<p>"`). Deviation from plan's literal `[prompt]`, noted for the review doc. Blocking flags match --flag=value; all-token subcommand scan's safe-direction false positive documented in harness.ts.
- phase_4: `codev bootstrap-docs` (commands/bootstrap-docs.ts, dependency seam `runBootstrapDocs(opts, deps)`), lib/tree-snapshot.ts (tripwire core moved; tree-tripwire.ts re-exports, its tests unchanged) + index fingerprint + non-git filesystem snapshot.
  - Decisions: the non-git walk does NOT honour .gitignore (phase_1 carry-forward: the ignore compiler over-ignores, so it must not exclude paths from change detection); it skips only .git/ and node_modules/, bounded at 50,000 files. Plan text said "root .gitignore honoured"; note in review doc.
  - A hot placeholder whose cold doc is MISSING is held back (its map has nothing to point at), reported alongside the `codev update` hint.
  - Prompt is always saved to .consult/bootstrap-docs/prompt.md before confirm; the stated command shows `"$(cat <file>)"` in place of the prompt arg.
  - Parent ignores SIGINT while the agent owns the terminal, so Ctrl-C in the session doesn't kill the CLI before its report.
  - Carry-forward applied: validator now flags empty facts/map sections and a bootstrap-written cold doc with zero sections ('empty-section').
  - Test gotcha: a developer's global git excludes file (here: **/.claude/settings.local.json) hides harness scratch paths; test repos pin core.excludesFile=/dev/null.
  - Flaky (review doc `## Flaky Tests`): terminal/__tests__/session-manager.test.ts "no stderr tail logged for file-based stderr (Bugfix #324)" timed out waiting for session-exit in 2 of 4 local full-suite runs (once also solo); already CI-skipped. Skipped with a FLAKY annotation.
  - consult-readonly-review.e2e.test.ts is opt-in (CODEV_ALLOW_REAL_CLAUDE_SDK=1, real model quota); not run. Tripwire unit tests (56) green after the move.
  - Full suite: 313 files passed, 6329 tests; tsc clean; build green.
- phase_4 iter1 CMAP: G approve, X RC, C comment. Applied: non-git snapshot now honours root .gitignore (follows plan; consistent with main's git-scoped ruling; ignore compiler moved into lib/tree-snapshot.ts), 100 KB prompt-size guard -> manual fallback, lazy skeletonDir, permission wording only claims bypass for known bypass flags, prompt-file pointer on decline/spawn error, scope line names .gitignore and the unseen in-session `git init`. Kept the FLAKY skip per role rule (rebuttal explains); ask architect to track it.
  - Intermittent: one porch test-check run failed in a forge pr-create test (CODEV_PR_TITLE/CODEV_PR_BODY required); immediate rerun green. Not touched by this branch; record under Flaky Tests if it recurs.
- phase_4 iter2 CMAP: G approve, X RC (unborn->first-commit HEAD unseen; summary claimed nothing committed even when HEAD moved), C RC (project in a repo SUBDIRECTORY: porcelain repo-root paths mis-keyed + hashed at wrong base; reproduced). All fixed in lib/tree-snapshot.ts (show-prefix re-keying, unborn identity) + conditional summary + missing-file headline. SIGINT-for-agent-lifetime kept (intended).
- phase_4 iter3 CMAP: G/C approve, X RC (symlinks all hashed '<special>'; retarget invisible). Fixed: hashPath records '<link:TARGET>'. Scope line suppressed when detection lost.
- phase_4 force-advanced by porch at the iter-3 ceiling (b87516dcd unreviewed; architect told). Boundary refresh skipped (task not captured). Starting phase_5.
- main: flake tracked as #1800 (FLAKY annotation now cites it); forge pr-create one-off noted there. main will review b87516dcd explicitly at PR integration review.
- phase_5: draft review in bootstrap-docs.ts (reviewDrafts after validation; consult -m <model> --prompt-file .consult/bootstrap-docs/review-prompt.md --output .consult/bootstrap-docs/<model>.md, parallel; runConsult dep). Review prompt template codev-skeleton/templates/bootstrap-docs-review-prompt.md (skeleton-only, like the bootstrap prompt); drafts inlined with collision-proof fences. Gemini skip detected from consult's 'SUMMARY: … lane skipped' artifact; stale outputs removed before each run; outcome never changes exit code. argv verified by parsing through registerConsultOptions. Suite: 6341 passed.
- phase_5 iter1 CMAP: G/X/C APPROVE. Applied Claude's non-blocking notes in a follow-up: review errors degrade to 'did not run' (never lose the summary), summary printed BEFORE the slow review, drafts re-hashed after the review (reviewer edits named). Not applied: REVIEW_MODELS ignoring porch.consultation.models (not in plan; noted for review doc).
- phase_6: adopt awaits the conflict-merge session (reuses bootstrap-docs' spawnAgentProcess, so Ctrl-C in the merge no longer kills adopt), then offers "Draft the governance docs from this codebase now?" (default No) on a non-empty repo with eligible files; -y never launches and lists `codev bootstrap-docs` under Next steps, which now prints last. adopt returns the bootstrap exit code (cli sets process.exitCode). AdoptDeps seam: confirm, runMergeSession, shouldOfferBootstrap, runBootstrap.
  - Eligibility (classify + held-back + eligible + non-empty) moved into lib/governance-bootstrap.ts (classifyProjectGovernance, bootstrapEligibleFiles, shouldOfferBootstrap) so adopt/update/bootstrap-docs share one definition.
  - update: UpdateResult.bootstrapDocsHint, printed once after the summary; --agent puts it in instructions.bootstrapDocs; --dry-run says nothing.
  - Plan said codev/resources/commands/ has no skeleton twin: wrong, codev-skeleton/resources/commands/codev.md + overview.md exist; both trees updated. codev skill updated in all four copies; skeleton cheatsheet row added. README/INSTALL describe no post-adopt governance step, left alone.
- phase_6 iter1 CMAP: X/C APPROVE, G skipped (agy no output). Applied Claude's notes: shouldOfferBootstrap returns false if a starter is missing from the package (a hint must not fail adopt/update); `adopt -y` no longer awaits the merge session (nothing to sequence; launches after Next steps as before, so Tower's `adopt --yes` auto-adopt is no worse than before); our codev/resources/cheatsheet.md got the row too. Not applied: cli.ts JSON builder is duplicated in update.test.ts (pre-existing), so instructions.bootstrapDocs wiring is verified manually only (scratch-repo run), not by a unit test.

## Review
- Real-repo verification run on sindresorhus/execa (877 commits) with the branch build, under a pty with a headless `claude -p` wrapper as the configured agent: four execa-specific drafts, validation passed, nothing outside the eligible files, codex + claude draft review found real accuracy errors (gemini skipped), re-run a byte-identical no-op.
- Finding: both hot drafts dropped the starter's guidance comment (spec's hot-file shape keeps it; no reviewer noticed). Fixed: validator `missing-guidance` + an explicit prompt rule. Re-validating the execa drafts flags both.
- Review doc written; cold arch.md + lessons-learned.md updated (hot tier at cap, unchanged).
- PR #1808 opened. PR CMAP: codex RC (review-time mutations escaped detection), claude APPROVE (fence, --> placement, stale base), gemini skipped. All fixed (9e87ce164) + merged main.
- main integration review round 1 (4 must-fix): symlinks lstat-curated and hashed through the link; starter templates pinned; adopt exits 0 after successful adoption (ruling); agent-process + CONSULT_OWNED_PREFIXES moved to lib. Commits fd450a757, a7a469edc, d42fc36b3.
- Real-repo run 2 on final code (execa): validation passed incl. missing-guidance (comment kept this time), clean detection, re-run byte-identical no-op. Suite after merge: 6384 passed; tsc clean.

**Owner, while waiting at the pr gate:** the Claude and codex launch-blocker lists looked like Claude-specific knowledge sitting in the general-purpose harness module. Small fix on this PR: the lists are no longer exported and sit beside `CLAUDE_HARNESS` / `CODEX_HARNESS`, and the tests check the blocker through the provider instead of the constants. Filed #1810 (area/tower) for the proper split: one file per built-in provider.

**Team review (waleedkadous) on PR #1808, handled at the owner's direction:**
- Dropped the CLI-built git digest. The skill's bootstrap-mode survey now tells the agent how to explore history itself, and the prompt's restated rules are gone.
- #1811 in this PR: `codev update` refreshes unedited shipped skills (hash history generated from git). An edited skill gets `.codev-new` copies on every update; the owner chose this over a lock file. `bootstrap-docs` now runs the installed skill by name when it matches the package, and inlines the packaged skill otherwise.
- Suite 6397 passed, tsc clean.
- Real-repo run 3 (an old adopter's clone: pre-branch skill, then `update`, then bootstrap) is in progress.

**CMAP round 3 (bc6331a12):** Gemini APPROVE; Codex and Claude REQUEST_CHANGES.
- Codex found a real defect: an edited skill holding a symlinked subdirectory let the `.codev-new` write escape the project. Reproduced against bc6331a12 and fixed: a skill holding a symlink, or a symlinked skills root, is left alone. Regression tests added.
- Also fixed: a `.codev-new` the skill has caught up with is now deleted, the unused result field is gone, and the PR body is rewritten.
- Escalated to main: whether the approved spec needs an amendment for the owner-directed scope (#1811, digest removal).

**Real-repo run 3 (older-adopter path):** passed end to end. `update` refreshed only `update-arch-docs`. Bootstrap ran the installed skill (the transcript shows `Skill("update-arch-docs")`) and explored history with the skill's git commands. Validation passed, exit 0, and the re-run was a no-op.

**Integration review round 3 (main, 9dd499ad9):** fixed both must-fix items.
- `update --dry-run` now previews skills, including under `--force`.
- `--force` keeps files the package does not ship.

Also all five should-fix items: a cap-parity test, the inline source follows the provider, `.codev-new` cleanup on the edited path, a `generate-skill-hashes` script, and the local-build warning (worded as `.codev-new` copies plus `--force` overwriting, not a silent revert). Confirmed in the review that a file the package newly adds to an edited skill arrives only as `.codev-new`, on purpose. Raised separately with main: `update --dry-run` already writes CLAUDE.md/AGENTS.md `.codev-new` copies.

**Integration review round 4 (main's ruling):** fixed the root-file dry-run writes in this PR.
- Plain `--dry-run` wrote CLAUDE.md/AGENTS.md `.codev-new` copies.
- `--dry-run --force` created a missing CLAUDE.md or AGENTS.md. It never overwrote an existing one: without `handleConflicts`, `copyRootFiles` skips existing files. Told main its note was wrong on this point.
- Audited the rest of `update`: no other unguarded writes. Two existing wording/labelling oddities are recorded as follow-ups.

**CMAP round 5 (bc8bfb8f9):** Gemini and Claude APPROVE; Codex REQUEST_CHANGES. The fixes:
- `validateHotFile` now counts only the exact required sections, so a similarly named section can't fill an empty one or dodge a cap. Regression test added.
- The orphaned JSDoc is moved, and the `.consult/` exemption is now in the command docs.
- Rebutted: limiting skill history to release tags. Commit-level content can't match a user's own edit, and tags would misclassify local or pre-release builds as edited.
- Full suite on the final code: 315 files, 6410 passed; tsc clean.

**Owner direction: deepen the history guidance.**
- The last 100 raw commits cover about 9 days here, which was too shallow.
- The skill's bootstrap-mode history step now also covers: the project's own record (CHANGELOG, ADRs, tags); one line per PR via `--first-parent`, with merge-commit PR titles from the bodies (execa squash-merges, so `--merges` alone fails there); sampling older eras; and removed areas.
- Changed in all four copies, hash history regenerated. Real-repo run 4 to follow.

**CMAP round 6 (c979579f6):** Gemini and Claude APPROVE; Codex REQUEST_CHANGES. The fixes:
- A symlinked `.codev-new` was written through, for skills and for root files.
- A dangling root-file symlink was followed to create a file.
- Required hot sections matched by prefix.
- Committed the untracked rebuttal docs.
- Full suite: 315 files, 6414 passed; tsc clean.

**Real-repo run 4 (history guidance):** passed. The agent read tags, counted commits per year, sampled 2024 and 2019 along the first-parent line, grepped scar tissue with its own words, looked for removals, and used `git show` on specific commits. Validation passed, exit 0, all three reviewers ran, and the re-run was a no-op.

**Owner direction (history verbosity), 2515db3b0:** merged main; resolved the lessons-learned.md conflict by keeping both sides; regenerated the shipped-skill hashes for main's afx and porch skill changes. The bootstrap-mode survey step now names the history sources and leaves the commands to the agent. Full suite: 323 files, 6702 passed; tsc clean.

**Real-repo run 5 (trimmed step):** passed. The agent chose its own commands and still covered every source: tags across majors, merge bodies, eras and the start, scar tissue in its own words, deletions, churn, `-S` and `git show`. Validation passed, exit 0, all three reviewers ran, and the re-run was a no-op.

**CMAP round 7 (fe9853366):** Gemini and Claude APPROVE; Codex REQUEST_CHANGES. The fixes:
- A symlinked `codev/` or `codev/resources/` ancestor now makes every governance file under it curated.
- `bootstrap-docs` no longer writes its own `.consult/bootstrap-docs/` files through a symlink: a bad prompt path stops the run with exit 1, and a bad reviewer path skips the review.
- A draft replaced by a symlink is flagged, not read.
- An unreadable skill is skipped by `update`.
- The launch statement discloses the three-model review.
- Full suite: 323 files, 6709 passed; tsc clean.

**Owner's manual adopt:** the skill folders were empty because an earlier install's files had been removed. `adopt` skipped existing folders even when empty (pre-existing), and `update` would have called them edited. Both now treat an empty skill folder as missing. Tested, and reproduced on a scratch repo: 20 folders filled.

**pr gate approved** (the owner's word, relayed by main). Head at approval: d3725f7a3.

**CMAP round 8 (7b3f9457d):** Gemini APPROVE; Codex and Claude REQUEST_CHANGES. The fixes:
- A symlinked draft is no longer sent to the reviewers.
- Main merged (28 commits, clean).
- The #1809 and #1802 umask lessons are reconciled.
- Full suite: 324 files, 6726 passed; tsc clean.
