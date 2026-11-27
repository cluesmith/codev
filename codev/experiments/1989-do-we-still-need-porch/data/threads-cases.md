# Experiment 1989 — porch saves and costs in builder threads (`codev/state/*_thread.md`)

Base: branch `builder/experiment-1989` (HEAD 01949988a, one commit over main `ab0fa50a9`). Read-only.
Counting rules: `codev/experiments/1989-do-we-still-need-porch/notes.md`, "Approach: counting rules".

## 1. Header

**Filter** (case-insensitive, extended regex), run over `codev/state/*_thread.md`:

```
grep -n -i -E 'porch|status\.yaml|force.?advance|VERIFICATION REQUIRED|a-human-explicitly|gate|wedge|stuck|timed? ?out|timeout|roll(ed)? ?back|hand.?edit|--resume|check(s)? fail|rebuttal' codev/state/*_thread.md
```

| Measure | Value |
|---|---|
| Thread files in population | 320 |
| Files matched by the filter | 306 (3,981 matching lines, of 41,674 total lines) |
| Files read | 306 matched (every matching line plus surrounding context; long threads read around every candidate line) + 3 of the 14 unmatched, read whole because they are soft-mode threads (`experiment-1782`, `task-_205`, `task-24AO`) = **309** |
| Unmatched, not read | 11 (`air-1043`, `air-1108`, `air-1383`, `air-1388`, `air-1505`, `air-1559`, `air-1608`, `air-1709`, `air-1773`, `air-1985`, `bugfix-838`) |
| Earliest thread | first `codev/state/` thread added 2026-05-22 |

The filter over-matches: "gate" also matches "investigate", "render-gate", "aggregate", and so on.

**Interpretation rules applied on top of notes.md.** These were fixed before any row was written:
- **S-consult-loop** means a *porch-emitted* round **after the first**: iteration ≥2, re-run after a REQUEST_CHANGES, that found a NEW real defect which was then fixed.
  - First-round catches are not counted.
  - Rounds the builder ran by hand are not counted, nor are architect integration reviews or architect-requested re-runs.
  - BUGFIX and AIR rounds are not counted. Those protocols have no porch `verify` block (`codev/protocols/{bugfix,air}/protocol.json`), and the builder runs `consult` itself from the phase prompt. They are listed separately in §4d.
  - PIR's porch review is single-pass (`max_iterations: 1`), so PIR cannot produce this kind.
- **S-gate** requires the record to show that someone was about to pass or move on, and that the gate's hold caught something real. A plain "waiting at gate" is not counted. A human sending a PR back at a pr gate is not counted, because that review happens with or without porch.
- **A porch defect that is only the subject of a thread's own fix** goes to the issue list (§4c), not the table, unless the thread records it hitting a builder during real work.
- **"Architect approved <human gate>" with no human named** is entered as F2 C-bypass **borderline**. A builder thread sees only the relay, so it cannot show whether a human decided. Gates recorded with no approver named at all are listed in §4a only.
- **One row per distinct event.** A file may have several rows on one line when the events are distinct.

## 2. Cases

| file:line | fn | kind | clear/borderline | summary | quote (exact substring of that line) |
|---|---|---|---|---|---|
| codev/state/spir-1313_thread.md:44 | F2 | C-bypass | borderline | Spec-approval is recorded as approved by the architect, with no human named. This is an external contributor's workspace, so who decided is unknown. | Architect approved spec-approval gate + told me to continue to Plan. |
| codev/state/spir-1313_thread.md:75 | F3 | C-check | borderline | `porch check` failed with "Project not found" because it was run from a subdirectory; the change had no defect. | a stray `cd` into packages/ made `porch check` fail |
| codev/state/spir-1313_thread.md:96 | F4 | S-consult-loop | clear | The iteration-2 plan re-consult found 3 new real implementation-seam gaps, all fixed. | Codex found 3 deeper implementation-seam gaps (all verified in code, |
| codev/state/spir-1313_thread.md:121 | F2 | C-bypass | borderline | Plan-approval is recorded as approved by the architect (commit 36582b2d), with no human named. | Architect approved plan-approval gate (commit 36582b2d). Architect decisions: |
| codev/state/spir-1313_thread.md:439 | F1 | S-state | borderline | After a resume, porch showed phase_4 at iteration 2, so the builder re-verified and re-consulted instead of re-implementing. A snapshot file was also used. | `porch next` confirms **iteration 2** of phase_4; the 3 iter1 Codex fixes are already committed |
| codev/state/spir-1313_thread.md:508 | F1 | S-state | borderline | After a pause, porch emitted only the iteration-2 re-consult, and phase_5 was not re-implemented. | `porch next 1313` → emitted the phase_5 **iter-2** 3-way consult task. |
| codev/state/spir-1313_thread.md:679 | F4 | S-consult-loop | clear | The phase_7 iteration-2 round found a new defect: `afx inbox` defaulted to Tower-wide, against a baked decision. Fixed. | Codex accepted all 3 iter-1 fixes and raised **one NEW issue** (Gemini+Claude both APPROVE): |
| codev/state/spir-1313_thread.md:705 | F4 | S-consult-loop | clear | The phase_7 iteration-3 round found a third real bug: the dismiss route was reachable by GET. Fixed. | re-ran it → APPROVE/HIGH, no issues. **Codex found a THIRD real |
| codev/state/spir-1313_thread.md:724 | F3 | C-check | clear | `porch done`'s tests check failed once on an unrelated timing test; the retry passed. | `porch done` (iter-3 rebuttal) tests failed ONCE on a flake: `session-manager.test.ts:1386` |
| codev/state/spir-1313_thread.md:728 | F4 | C-bypass | borderline | Porch force-advanced phase_7 at its 3-iteration ceiling, so the last fix was never re-reviewed by porch. The architect verified it by hand. | porch hit its **3-iteration safety ceiling** and **force-advanced** phase_7 |
| codev/state/spir-1313_thread.md:838 | F1 | S-state | borderline | On the phase_8 resume, porch's iteration showed that only the build-complete signal remained. | Reconciled state from snapshot + git + porch: |
| codev/state/spir-1313_thread.md:897 | F3 | C-check | clear | `porch done`'s tests check failed twice on an environment race under sibling load; a direct run and a retry passed. | `porch done`'s test check FAILED twice (43.2s, 43.1s) |
| codev/state/spir-1313_thread.md:909 | F1 | S-state | borderline | The review-phase resume rebuilt history from the thread, status.yaml and the consult files. | Reconstructed full history from thread + status.yaml + a subagent that |
| codev/state/spir-1313_thread.md:985 | F2 | C-bypass | borderline | The architect said it would approve the pr gate itself after its own review, and did (L991). No human decision is recorded. | I'll approve the pr gate directly when it's clean. |
| codev/state/spir-1313_thread.md:1331 | F1 | C-state | clear | An architect-authorized rollback from verify to implement reset all 9 completed plan phases and the pr/verify gates to pending. | porch rollback verify→implement (architect-authorized). SIDE EFFECT: reset all 9 plan_phases to pending |
| codev/state/spir-1313_thread.md:1516 | F1 | C-wedge | clear | Walking porch forward again, `porch next` emitted full implement prompts for phases already shipped. It took several architect round-trips to reach review. | WALL = exactly the human's stop-trigger ("porch prompts you to (re)implement a phase"). phase_2 is ALREADY SHIPPED in |
| codev/state/spir-1313_thread.md:1561 | F8 | C-other | borderline | Driving porch forward auto-committed and auto-pushed about 30 status.yaml-only commits onto the PR, against a "don't touch" instruction. The architect later ruled them expected. | driving porch forward made porch STRICT MODE auto-commit AND AUTO-PUSH. |
| codev/state/spir-1313_thread.md:1598 | F1 | C-text | clear | Porch emitted an iteration-2 "fix issues" task that replayed feedback fixed before the rollback. | The porch iter-2 "Fix issues from iteration 1" task is a REPLAY of the original phase_9 iter-1 |
| codev/state/spir-1313_thread.md:1630 | F1 | C-text | clear | Porch replayed the pre-rollback review iteration-1 request as a fix task; all of it was already addressed. | porch replayed the pre-rollback review iter-1 (Codex RC: 2 mailbox races + frontmatter) as an iter-2 "fix issues" task |
| codev/state/spir-1313_thread.md:1688 | F6 | S-state | borderline | Another project's status.yaml (1280, still at phase_0) showed that test T16 was a live guard, which reversed the builder's deletion of that test. | Issue #1280 is **OPEN** (status.yaml: `phase_0_instrument` in |
| codev/state/spir-1313_thread.md:1709 | F1 | S-state | borderline | A stale snapshot contradicted porch and git, and the builder trusted porch and git. | state that does NOT match porch or git log — treated as stale, trusted porch+git. |
| codev/state/bugfix-1952_thread.md:42 | F3 | C-check | clear | The tests check failed intermittently under load. Porch truncated the output, so the test was unnamed; two later runs passed. | First porch `tests` run failed intermittently (load ~17-23; porch truncates output so the test |
| codev/state/bugfix-1952_thread.md:50 | F8 | C-other | borderline | Codex returned REQUEST_CHANGES because porch's own `chore(porch)` commits break protocol.md's prefix rule. | `chore(porch):` commits violate protocol.md's |
| codev/state/air-1370_thread.md:52 | F3 | C-check | borderline | `porch check`'s build failed because the worktree had no node_modules, unrelated to the change. | The worktree had no `node_modules` — `porch check`'s build failed with |
| codev/state/bugfix-1199_thread.md:15 | F3 | C-check | borderline | A shared /tmp/.git and global config contaminated unrelated tests. Whether porch's run was the one that failed is not stated. | initially contaminated unrelated non-hermetic tests |
| codev/state/pir-809_thread.md:12 | F2 | C-bypass | borderline | Plan-approval is recorded as approved by the architect, with no human named. | Approved by architect on 2026-05-28. |
| codev/state/spir-1470_thread.md:354 | F1 | C-bypass | borderline | A porch defect (#1503) meant ASPIR's ungated advance never built per-plan-phase state, so ASPIR projects silently lost per-phase review. Found and fixed in this thread. | **ASPIR entered `implement` with an empty `plan_phases` and never reached the per-plan-phase |
| codev/state/spir-1470_thread.md:435 | F4 | S-consult-loop | clear | The Phase 2 second round found the #1408 test still vacuous and the refresh firing twice. Both fixed. | ### Phase 2 iter2 (codex): the #1408 test was STILL vacuous |
| codev/state/spir-1470_thread.md:633 | F4 | C-bypass | borderline | Porch force-advanced Phase 2 at the ceiling while codex still had a REQUEST_CHANGES open. The builder says nothing real was open, and missed the notice because it filtered porch output. | Porch force-advanced Phase 2 at 17:56Z (83c9e5a2a), max_iterations 3 reached with codex |
| codev/state/spir-1470_thread.md:753 | F4 | S-consult-loop | clear | The Phase 3 second round found a type-confusion bypass of the nonce freshness gate. Fixed. | ### Phase 3 iter2: a real freshness BYPASS (codex) + 5 more from claude |
| codev/state/spir-1470_thread.md:791 | F4 | S-consult-loop | clear | The Phase 3 third round found the round-2 fix incomplete, plus a disabled safety parameter. Fixed. | ### Phase 3 iter3: I fixed the instance and missed the class — twice |
| codev/state/spir-1470_thread.md:843 | F4 | C-bypass | clear | Porch force-advanced Phase 3 with fixes no round had reviewed. An ad-hoc consult outside porch then found a HIGH bypass the builder says it would have shipped. | (1cad0ec75) — but the fixes never went through a CMAP round, which is the honest caveat I reported. |
| codev/state/spir-1470_thread.md:1017 | F4 | S-consult-loop | clear | The Phase 4 second round found the same missing `--boundary` flag in a second workflow. Fixed. | ### Phase 4 iter2 (codex): the SAME omission, at a second instructed workflow |
| codev/state/spir-1470_thread.md:1069 | F4 | S-consult-loop | clear | The Phase 4 third round found that the regression test pinned a copy, not the production binding. Fixed. | ### Phase 4 iter3: BOTH reviewers found my regression test was pinning a COPY |
| codev/state/spir-1470_thread.md:1451 | F1 | C-state | clear | Chaining `porch done` and `porch next` reset build_complete and re-emitted implement tasks. Hit twice. | verification — the `next` re-emits implement tasks and resets `build_complete` to false. Running |
| codev/state/spir-1470_thread.md:1653 | F1 | S-state | borderline | In a live test on a throwaway project, porch recovered a consultation that was lost when the context was cleared. | resumption via `porch next` — with porch **recovering the consultation that died with the clear**, |
| codev/state/spir-1470_thread.md:1687 | F4 | S-consult-loop | clear | The Phase 8 second round found the simulation never drove the orchestrator. Fixed. | ## Phase 8 iter-2 — Codex REQUEST_CHANGES (2), Claude APPROVE (2 non-blocking). All four taken. |
| codev/state/spir-1470_thread.md:1781 | F4 | C-wedge | clear | The review phase could neither finish nor escape: consult cannot resolve a merged PR, and porch cannot record a consult that cannot run (#1531). | verdict rounds. So the phase can neither finish nor escape. **Issue #1531**, both halves. |
| codev/state/spir-1470_thread.md:1798 | F1 | C-other | borderline | Near-miss: backticks in a message made the shell run `porch rollback` and `porch verify`. Both died on argument errors; nothing guards rollback (#1532). | bash string. The shell substituted them and actually ran `porch rollback` and `porch verify` — both |
| codev/state/spir-1951_thread.md:69 | F3 | C-check | clear | The tests check failed at load ~30 on unrelated tests and did not name them. It was skipped once on the architect's ruling. | porch `tests` failed again at load ~30 (names not shown); |
| codev/state/spir-1951_thread.md:86 | F7 | C-other | borderline | The context-refresh task at the Phase 1→2 boundary was never run, because the next `porch next` replaced it. | - Porch's context-refresh task at the Phase 1→2 boundary was not run: its commands were not captured before the |
| codev/state/spir-1951_thread.md:89 | F3 | C-check | clear | The Phase 2 tests check failed on 4 unrelated files, hidden by truncation (#1853). It was skipped on the architect's word. | - Phase 2 tests check: one local porch run failed on 4 unrelated spawn-heavy files (names found in vitest's |
| codev/state/spir-1951_thread.md:96 | F4 | S-consult-loop | clear | The Phase 2 second round found new gaps in the stub-git and gh allow-lists. Fixed. | - CMAP Phase 2 iter 2 (both REQUEST_CHANGES): stub git flags not closed per subcommand (log/diff without the |
| codev/state/spir-1951_thread.md:102 | F4 | S-consult-loop | clear | The Phase 2 third round found stub ls-remote arguments unchecked, which led to an audit and fixes. | - CMAP Phase 2 iter 3: claude APPROVE; codex REQUEST_CHANGES (stub ls-remote args unchecked: another remote |
| codev/state/spir-1951_thread.md:107 | F4 | C-bypass | borderline | Porch force-advanced Phase 2 at the ceiling, so the round-3 fix was never re-reviewed. It was disclosed in the PR body only. | - Phase 2 was FORCE-ADVANCED by porch at the 3-iteration ceiling (8c9715a4b): the round-3 fix was not re-reviewed |
| codev/state/spir-1951_thread.md:309 | F1 | C-other | borderline | Running `porch done` before `porch next` had read the verdicts re-signalled the old build, which led to unrun iteration-2 criteria and an extra skip. | - Porch sequencing (2026-11-24 ~03:20): I committed the iter1 fixes (dd21e15ce) and ran the architect-approved |
| codev/state/spir-1951_thread.md:317 | F4 | S-consult-loop | clear | The Phase 6 second round found that a keep-list symlink is data. Fixed. | - Review iter2: codex REQUEST_CHANGES — a keep-list symlink is data (spec line 577) that --keep-ignored deletes, so |
| codev/state/spir-1951_thread.md:337 | F4 | S-consult-loop | clear | The Phase 6 third round found Windows hard-link and copy fallbacks misread as data. Fixed. | - Review iter3: codex REQUEST_CHANGES — native Windows spawn falls back on a HARD LINK, then a COPY |
| codev/state/spir-1951_thread.md:346 | F4 | C-bypass | borderline | Porch force-advanced Phase 6 at the ceiling with the round-3 fix unreviewed. The architect routed it into Phase 7's review. | - Iteration 3 FORCE-ADVANCED by porch (safety ceiling, 927795193); porch moved to docs_guidance (68eef5795). |
| codev/state/spir-1951_thread.md:401 | F4 | S-consult-loop | clear | The Phase 7 second round found three cleanup suites whose mocks made an assertion vacuous. Fixed. | - Claude iter2 note 2 (architect order): three cleanup suites mocked execFile with 3 params, so the dirty |
| codev/state/spir-1951_thread.md:425 | F4 | C-bypass | borderline | After a review-phase REQUEST_CHANGES, porch went to the pr gate with no second round. The architect ran codex by hand. | ordinary porch done at load 17.8 → no second consult |
| codev/state/spir-1951_thread.md:448 | F8 | S-record | borderline | `porch done --merged` refused because no PR was recorded, so the builder recorded the PR and the merge. | porch done --merged first refused ("No PR history |
| codev/state/spir-1252_thread.md:158 | F4 | S-consult-loop | clear | The spec's second round found an enforcement hole (a map listing 3 of 40 classes passes) plus a second blocker. | **Verdicts: Gemini APPROVE / Codex REQUEST_CHANGES / Claude APPROVE.** |
| codev/state/spir-1252_thread.md:362 | F4 | C-bypass | borderline | From mined status.yaml data, 0 of 48 finished plan phases ended all-APPROVE: porch advances on rebuttal, not consensus. This is a systemic finding and overlaps the mechanical status.yaml count. | **Porch advances a phase on builder rebuttal, not consensus.** So B2 would never |
| codev/state/spir-1252_thread.md:489 | F3 | S-check | clear | Porch's checks failed on iteration 2 because the baseline counted this project's own verdicts (160 vs 163). A self-exclusion fix followed. | Porch's checks failed on iter-2: the reproduction test expected 160 verdicts, |
| codev/state/spir-1252_thread.md:569 | F3 | S-check | borderline | Porch checks caught a baked-decisions test broken by the change. The builder calls frozen baselines "drift bombs". | Porch checks caught baked-decisions.test.ts failing: it froze the THEN-DRIFTED |
| codev/state/spir-1252_thread.md:640 | F4 | S-consult-loop | clear | The Phase 4 third round found an unguarded source-vs-embedded skeleton copy boundary. A parity test was added. | ## Phase 4 iter-3 — Codex found the drift thesis at ANOTHER copy boundary |
| codev/state/spir-1252_thread.md:687 | F4 | S-consult-loop | clear | The Phase 5 second round found an architect.md self-contradiction. Fixed. | Iter-2: architect.md self-contradiction; |
| codev/state/spir-1252_thread.md:688 | F4 | S-consult-loop | clear | The Phase 5 third round found a second afx-anywhere instance. Fixed. | Iter-3: SECOND afx-anywhere instance |
| codev/state/spir-1252_thread.md:690 | F4 | S-consult-loop | clear | The Phase 5 fourth round found 11 "bypass checks" variants. Fixed. | Iter-4: "bypass checks" variant ×11 (grepped the rule's phrasings, not the |
| codev/state/aspir-1307_thread.md:451 | F4 | S-consult-skip | borderline | Porch held phase_2 open waiting on verification consults while the builder drifted into phase-3 work. Found via `porch status`, then closed properly. | porch had been sitting on phase_2 waiting for *my* |
| codev/state/bugfix-1853_thread.md:59 | F3 | C-other | clear | Seen firsthand (#1853): the installed porch printed npm warnings instead of the failing test and saved no log. | lines and saved no log: the bug this fix addresses hid its own evidence. |
| codev/state/bugfix-1853_thread.md:63 | F3 | S-check | clear | The fix-phase tests check failed on a real defect this PR caused: skill hashes not regenerated. | the one real failure was `src/__tests__/skill-refresh.test.ts` |
| codev/state/bugfix-1024_thread.md:31 | F3 | C-bypass | borderline | The tests check runs only the codev package, so it passed without testing this vscode-package change. | `tests` check is `pnpm --filter @cluesmith/codev test` (the codev-package vitest), |
| codev/state/bugfix-1573_thread.md:243 | F8 | C-other | borderline | The post-merge status.yaml commit was stranded on the branch. | - One stranded porch commit for the records PR: `5d717a278` (`chore(porch): bugfix-1573 PR |
| codev/state/pir-1869_thread.md:29 | F3 | C-check | clear | The tests check failed only because the user's npm config overrode the test's registry. | Porch's local tests check failed only on protocol-drift-audit: a scoped @cluesmith:registry in the user npm config overrides the test's npm_config_registry |
| codev/state/pir-1917_thread.md:27 | F3 | C-check | clear | The tests check failed on 7 unrelated Windows tests, and the builder was blocked awaiting a ruling. | - Local porch `tests` check fails on 7 unrelated tests (temp-dir EPERM in cold-tier/update tests, a #1691 tower-start assertion); |
| codev/state/pir-1917_thread.md:38 | F3 | C-check | clear | The tests check timed out at 300s while other builders' suites overlapped. | - `porch done` ~04:50Z: build passed (76.6s); tests check timed out at 300s (391.6s), with other builders' |
| codev/state/pir-932_thread.md:23 | F3 | C-check | clear | The build check failed because the worktree had no node_modules ("tsc: command not found"). | installed `node_modules` — porch's `build` check (`npm run build` → `tsc`) failed |
| codev/state/air-1826_thread.md:44 | F3 | C-check | clear | The first tests check failed with truncated output. Three later runs on the same commit passed. | - Porch's first `tests` check failed with truncated output; three later full runs on the same |
| codev/state/bugfix-1686_thread.md:106 | F2 | C-other | clear | Running `porch done --help` actually ran `porch done` and requested the pr gate early. | pr gate is already surfaced (my `porch done --help` fired it — harmless, human-approval-only). |
| codev/state/bugfix-1686_thread.md:132 | F8 | C-state | borderline | The builder accidentally amended porch's pushed gate-requested commit, swallowing its status.yaml change. Recovered. | Git recovery: I accidentally `git commit --amend`'d porch's pushed `cba20f67b` "pr |
| codev/state/pir-1179_thread.md:43 | F2 | S-gate | borderline | While dev-approval held the builder, the human's feedback caught a real tsc error the builder's piped compile had hidden. | Dev-approval feedback caught a real tsc error my piped `pnpm compile |
| codev/state/spir-1658_thread.md:69 | F3 | C-check | borderline | The tests check failed twice for an unknown cause; porch showed only stderr. | Intermittent porch tests-check failure x2, unidentified (porch shows only stderr) |
| codev/state/spir-1658_thread.md:114 | F4 | S-consult-loop | borderline | The Phase 4 second round raised a codex bridge-mode stop point. Addressed; whether it was a defect is unclear. | phase_4 iter2 consult addressed (codex bridge-mode stop; claude test tightening) |
| codev/state/spir-1658_thread.md:155 | F3 | C-check | borderline | The Phase 7 tests check failed once, then passed on rerun; the failing test was not captured. | Intermittent: porch's first `tests` check for Phase 7 failed once, then passed on direct rerun and on porch retry (7173/0); the failing test was not captured. |
| codev/state/spir-1658_thread.md:184 | F3 | C-check | borderline | The tests check failed 2/2, only under porch, on load-sensitive #1800 tests. | porch tests check failed 2/2 under porch only: #1800 (session-manager auto-restart real-shellper tests, fixed inner deadlines, load-sensitive; ~400 more tests on this branch made it consistent). |
| codev/state/spir-1658_thread.md:185 | F4 | S-consult-loop | clear | The Phase 9 second round found that stop with no listener deleted the record. Fixed. | iter2: codex REQUEST_CHANGES (stop with no listener deleted the record): Windows now tells a failed port query (null) from no listener |
| codev/state/spir-1658_thread.md:185 | F4 | S-consult-loop | clear | The Phase 9 third round found never-ready stop unverified on Windows. Fixed. | iter3: codex REQUEST_CHANGES (never-ready "stopped" unverified on Windows): now waits on the kill snapshot (waitForTreeExit). |
| codev/state/spir-1658_thread.md:185 | F4 | C-bypass | borderline | Porch force-advanced Phase 9 at the ceiling after a round-3 REQUEST_CHANGES; the fix was not re-reviewed. | Porch force-advanced at its 3-iteration ceiling; iter3 rebuttal is the audit trail. |
| codev/state/spir-1658_thread.md:225 | F4 | S-consult-loop | borderline | The PR CMAP second round found install_guard missing from the final CI dispatch. That is a process omission. | iter2, codex: install_guard was missing from the final-head dispatch. Fixed by redispatching with install_guard=true. |
| codev/state/spir-1658_thread.md:226 | F4 | C-bypass | borderline | The PR CMAP force-advanced at the ceiling; only the owner's gate items were still open. | iter3: gate items only. Porch force-advanced at the ceiling. |
| codev/state/spir-1595_thread.md:33 | F4 | S-consult-loop | clear | The plan's second round: claude REQUEST_CHANGES, all accepted, plan amended. | Plan CMAP iter2: gemini APPROVE, codex COMMENT, claude REQUEST_CHANGES; all accepted |
| codev/state/spir-1595_thread.md:34 | F4 | S-consult-loop | clear | The plan's third round found the missing-script silence, and the plan changed. | Plan CMAP iter3: gemini+claude APPROVE, codex REQUEST_CHANGES (missing-script silence) -> hook command is a fail-silent shell wrapper |
| codev/state/spir-1595_thread.md:38 | F3 | C-check | borderline | The Phase 1 check failed with no output captured; a retry passed. | One porch done run failed checks with output not captured; porch check + retry passed: suspected flaky test, now capturing output on every run. |
| codev/state/spir-1595_thread.md:67 | F4 | S-consult-loop | clear | The Phase 6 second round found a hardcoded port 4100. Fixed. | iter2 codex REQUEST_CHANGES (hardcoded 4100 -> DEFAULT_TOWER_PORT): fixed; claude APPROVE. |
| codev/state/spir-1595_thread.md:117 | F3 | C-check | borderline | The tests check failed once with truncated output; the identical command passed directly. | Flaky: porch done's test check failed once (output truncated, failing test not named); the identical command passed directly |
| codev/state/spir-1595_thread.md:119 | F4 | S-consult-loop | clear | The Phase 8 second round found a watermark regression. Fixed with a test. | codex REQUEST_CHANGES: the ignored idle_prompt did not advance the ordering watermark, so a delayed older report could regress the hold (SC17). |
| codev/state/spir-1595_thread.md:120 | F3 | C-check | borderline | A third porch-only check failure at the same step, never reproduced. | Flaky porch test check, third occurrence at the same step (phases 7 and 8). Never reproduced |
| codev/state/aspir-1273_thread.md:166 | F4 | S-consult-loop | borderline | Phase 5 rounds 2–4 each had real codex findings, fixed. The line merges rounds 1–4, and porch-vs-manual is unclear. | Iterations 1–4 (all Codex findings accepted): partial porch/issue frames were possible |
| codev/state/aspir-1273_thread.md:196 | F4 | S-consult-loop | borderline | In Phase 5 round 6, codex caught a defect that two APPROVEs would have shipped. Porch-vs-manual is unclear (see :293). | **Iteration 6 — Codex found a real one, and two APPROVEs would have shipped it.** |
| codev/state/aspir-1273_thread.md:293 | F4 | C-state | borderline | The builder ran consults outside porch, so porch's iteration counter sat at 2 while the builder was on 7. Builder-caused; porch did not notice. | task, so porch never registered iterations 2–7 — its counter sat at 2 while I was on 7. |
| codev/state/aspir-1273_thread.md:315 | F4 | S-consult-loop | borderline | The PR CMAP second round found a confirmClear false-confirm bug. Fixed. The mapping to the round is inferred. | 2. Pattern matched `/clear` → always **confirmed**. A check that looked at its own keystroke echo. |
| codev/state/aspir-1273_thread.md:316 | F4 | S-consult-loop | borderline | The PR CMAP third round found a second false-confirm. Fixed. The mapping is inferred. | 3. Pattern matched the save request's `CONTEXT RESET INCOMING` header → always **confirmed**. |
| codev/state/aspir-1273_thread.md:336 | F8 | C-other | borderline | A PR round-4 REQUEST_CHANGES cited commit format; four of the seven commits cited were porch-generated. | all seven cited commits are correct, and four are porch-generated). The commit-format |
| codev/state/bugfix-1903_thread.md:5 | F5 | C-text | borderline | Porch's investigate prompt rendered `{{issue.number}}` literally to this builder. This is the thread's own bug, hit live. | Reproduced #8 live: this builder's own BUGFIX investigate task from porch renders |
| codev/state/bugfix-1903_thread.md:73 | F3 | C-check | clear | The tests check failed on a known unrelated teardown flake; clean on retry. | Flake: one `porch done` test check failed on the known unhandled `ERR_INTERNAL_ASSERTION` from |
| codev/state/task-NHnJ_thread.md:8 | F5 | C-text | borderline | The plan task's Goal was only the builder id, so no task description reached the builder. | porch `## Goal` for the plan task is literally `task-NHnJ` (my builder id). |
| codev/state/task-NHnJ_thread.md:49 | F3 | C-check | clear | plan_exists could never pass because porch's id matcher rejects letter-suffixed ids. The builder was blocked until `porch init` was re-run as `secfix-1`. | **BLOCKED:** `porch done` fails the `plan_exists` check ("Plan not found") even though |
| codev/state/pir-1563_thread.md:162 | F1 | C-text | borderline | After pr approval, porch prompted a merge the human had explicitly deferred. Not done. | execution follows separately on Amr's word via main. Honoring that over porch's generic prompt — I did |
| codev/state/pir-1450_thread.md:287 | F1 | C-text | borderline | Porch's completion task said to merge, against a standing no-merge instruction. Not done. | **Deliberately did NOT run the protocol's final task.** Porch's completion task says "Merge the |
| codev/state/bugfix-1472_thread.md:110 | F1 | C-text | borderline | Porch handed out a merge task when only maintainers may merge. Not done. | `porch next` then hands out a final "Merge the pull request" task. **Deliberately not done.** |
| codev/state/pir-1920_thread.md:16 | F3 | C-check | clear | The tests check was blocked by failures already on main on this machine. | porch `tests` check blocked by failures already on main on this machine (EPERM temp cleanup in update/cold-tier/hot-tier tests, bugfix-1691; verified by restoring the base source files). |
| codev/state/pir-1920_thread.md:22 | F3 | C-check | clear | `porch done` timed out at 300s under parallel builder load; the architect serialized the runs. | First `porch done` timed out at 300s because several builders ran the full suite at once; the architect serialized the runs. |
| codev/state/bugfix-1921_thread.md:16 | F3 | C-check | clear | Two `porch done` runs failed by colliding with sibling suites. | first two porch done runs collided with sibling suites (timeout, then pir-1920's approve on top). |
| codev/state/bugfix-1921_thread.md:17 | F3 | S-check | clear | Run alone, the check caught a real defect the change caused (skill hashes not regenerated). | Third run, alone, found a real failure caused by this change: skill-refresh needs `generate-skill-hashes` after editing the afx skill. |
| codev/state/bugfix-1137_thread.md:53 | F1 | C-state | borderline | After a resume, porch status showed phase `fix` and a stale pending gate that did not match the existing PR. | `gates: {merge-approval: pending}` in status.yaml predating this session |
| codev/state/bugfix-1990_thread.md:63 | F8 | C-other | borderline | Round 1 REQUEST_CHANGES included porch's own `chore(porch)` commits. Rebutted. | (a) reword the `chore(porch): …` commits: rebutted, |
| codev/state/bugfix-1990_thread.md:79 | F8 | C-other | borderline | Round 2 REQUEST_CHANGES was only about porch's commits. | CMAP round 2: claude APPROVE; codex REQUEST_CHANGES only on porch's `chore(porch):` commits |
| codev/state/bugfix-1982_thread.md:63 | F8 | C-other | borderline | Round 1 REQUEST_CHANGES was only about porch's commit subjects. | CMAP round 1: codex REQUEST_CHANGES (only porch's own `chore(porch)` commit subjects; |
| codev/state/bugfix-1982_thread.md:67 | F8 | C-other | borderline | Round 2 repeated the porch-commit objection, plus one real nit. | Round 2: codex same objection plus a stale name in the PR body (fixed); |
| codev/state/bugfix-1978_thread.md:74 | F8 | C-other | borderline | Codex REQUEST_CHANGES cited three commits, all porch's own. | (2) Commit prefixes: the three it named are porch's own `chore(porch)` commits. |
| codev/state/air-1238_thread.md:89 | F8 | C-other | borderline | A reviewer asked for porch-managed status.yaml to be removed. Rebutted. | Remove `status.yaml` and `air-1238_thread.md` — workflow/runtime artifacts, not |
| codev/state/pir-1498_thread.md:54 | F8 | C-other | borderline | Second-hand: another lane reproduced #1462 live (porch's gate commits moved the head and re-pended checks). | reproduced #1462 live" to codev/reviews/1495-stream-deck-architect-action-k.md ON MAIN |
| codev/state/pir-1428_thread.md:65 | F2 | C-bypass | borderline | Plan-approval is recorded as approved by the architect; line 63 had routed the gate to Amr, but no human is named for the approval. | ## Plan APPROVED by architect (2026-08-12) |
| codev/state/spir-1280_thread.md:132 | F4 | C-bypass | clear | Porch went from the iteration-1 rebuttal straight to spec-approval, skipping round 2. A manual round 2 the architect forced found 9 findings, 2 of them arithmetic errors. | **No CMAP round 2 ran.** Porch advanced straight from the iteration-1 rebuttal to the |
| codev/state/spir-1280_thread.md:137 | F4 | C-other | borderline | Porch's consult set was codex+claude only (the agy lane fault), so the review was 2-way. | **Gemini/agy did not participate.** Porch's model set for this consult was codex+claude |
| codev/state/spir-1280_thread.md:926 | F1 | C-state | clear | The plan-phase pointer stayed stale at phase_0; the architect fixed it with a status.yaml commit. | Also flagged: **porch's plan-phase pointer is stale** — it still reads `phase_0_instrument` |
| codev/state/spir-1280_thread.md:1097 | F1 | C-state | clear | The builder advanced the status.yaml phase pointer by hand, on the architect's instruction and owner permission. | Advanced status.yaml pointer: phase_5 → complete, phase_6 → in_progress (architect instruction |
| codev/state/spir-1280_thread.md:1386 | F8 | C-state | clear | After the merge, `porch done` committed and pushed a state commit to the builder branch, so the record never reached main. | `porch done` auto-committed **and pushed** `e235ba45` (`build_complete: false → true`) to the builder |
| codev/state/spir-1280_thread.md:1390 | F1 | C-state | borderline | After the merge, porch still read implement/phase_10 because phases had been advanced by hand-edit. | **Protocol not marked complete**: porch still reads `implement`/`phase_10_integration` because phases |
| codev/state/aspir-1912_thread.md:40 | F3 | C-check | clear | The tests check failed twice under outside load while the suite passed 3/3 directly; it could not name the test (#1801). | The `porch done 1912` tests check failed twice |
| codev/state/aspir-1912_thread.md:92 | F3 | C-check | clear | The phase_4 tests check failed on 3 unrelated load-sensitive files, showing only npm warnings. | porch done phase_4, first attempt: build ✓ (20.3s), tests ✗ (76.3s), at a starting load of 6.49. |
| codev/state/aspir-1912_thread.md:94 | F4 | C-other | borderline | Porch's claude lane ran the globally installed pre-fix `consult`, billing the metered API from the worktree `.env`. | Observation: porch's claude review ran the globally installed, pre-1912 `consult` |
| codev/state/spir-1216_thread.md:9 | F8 | C-other | clear | Porch's auto-push of transition commits is hard-coded to `origin` and failed on a fork setup. The builder pushed by hand each time. | Pushed the approval and plan-transition Porch commits to `fork` after Porch's hard-coded `origin` push failed |
| codev/state/spir-1216_thread.md:15 | F3 | C-check | clear | The full-test check failed on 18 pre-existing failures caused by a global config. An out-of-scope isolation fix was needed. | Blocker: the full Porch test check has 18 pre-existing `tower-utils.test.ts` failures |
| codev/state/spir-1216_thread.md:17 | F4 | S-consult-loop | borderline | The phase-1 second round raised a legitimate coverage gap, fixed before round 3. | Iteration 2 received two approvals and a legitimate Codex request to cover enabled behavior/state across all mapped phases. |
| codev/state/pir-1911_thread.md:23 | F3 | C-check | clear | The tests check was blocked twice by an unrelated timing test under load. | porch tests check blocked twice by bugfix-1814-check-timeout under load |
| codev/state/pir-1911_thread.md:27 | F3 | C-check | clear | The tests check failed again on 2 known unrelated flakes (#1923); the second run passed. | porch done #1: build pass, tests fail on 2 known #1923 flakes |
| codev/state/pir-799_thread.md:67 | F3 | C-check | borderline | Porch's root build/test checks fail at the monorepo root for a VS Code change, unrelated to it. No specific run is recorded. | porch's generic `npm run build`/`npm test` checks target the CLI package and fail at the monorepo root, unrelated to this change |
| codev/state/pir-956_thread.md:54 | F3 | C-bypass | borderline | The root checks do not exercise the vscode package being changed, so they pass regardless. | Note for porch checks: root `npm run build` / `npm test` target core+codev, not vscode, so |
| codev/state/bugfix-1871_thread.md:94 | F3 | S-check | clear | The tests check failed on skill-parity suites because the fourth afx skill copy was missed. Fixed. | Porch tests check failed once: 3 skill-parity suites. I had missed the fourth afx skill copy |
| codev/state/pir-1189_thread.md:65 | F3 | S-check | borderline | The check failed on the T16 manifest guard (prompt files touched without a manifest row). Real, but CI would also catch it. | One porch-check surprise worth remembering: Spec 1280's T16 manifest guard fails any |
| codev/state/pir-1196_thread.md:19 | F3 | C-check | borderline | Host contamination failed the first full-suite run; checks were rerun with an isolated HOME and TMPDIR. Whether that first run was porch's is not stated. | global Codex config and `/tmp/.git`; rerunning porch checks with isolated |
| codev/state/pir-929_thread.md:7 | F1 | C-state | borderline | The architect rewound porch state to the plan phase after a rescope. Deliberate. | Architect rewound porch to the plan phase. |
| codev/state/pir-929_thread.md:77 | F3 | C-check | clear | `pr_exists` failed falsely because gh's default repo was not the fork that held the PR. | (`pr_exists` check first failed because `gh` had no default repo → defaulted to cluesmith where the branch doesn't live; fixed with `gh repo set-default mohidmakhdoomi/codev`.) |
| codev/state/pir-929_thread.md:91 | F4 | C-bypass | borderline | After the architect's REQUEST_CHANGES, porch returned to gate_pending without re-running review. The builder consulted by hand. | Porch quirk: re-running `porch done` landed straight back at `gate_pending` (iter1) without re-issuing consult tasks |
| codev/state/pir-929_thread.md:113 | F2 | C-other | borderline | The push inside a human-instructed `porch approve` was rejected (the fork was ahead), and its commit had to be rebased. | its `git push -u origin HEAD` was **rejected**: the architect had merged `main` into the fork's builder/pir-929 (commit 0fd70b72) to keep #1059 current, so the fork was ahead. |
| codev/state/pir-929_thread.md:193 | F4 | C-bypass | borderline | After a re-implementation, porch showed cached verify verdicts instead of a fresh round. The builder ran a 3-way by hand. | Porch's recorded verify verdicts: gemini=APPROVE, codex=APPROVE |
| codev/state/pir-1494_thread.md:105 | F2 | C-other | borderline | Porch records approved_at but not approved_by (#1457), so the record cannot prove who approved this lane's own plan gate. | approved_at, never approved_by (#1457), so the state machine can't settle it either. |
| codev/state/pir-1494_thread.md:132 | F3 | C-check | borderline | The build check failed on stale node_modules after a rebase, unrelated to the diff. | Note: porch build check first failed on `Cannot find module 'three'` — a STALE-DEPS issue (three is |
| codev/state/spir-1797_thread.md:16 | F4 | S-consult-loop | borderline | Plan rounds 2 and 3 were still REQUEST_CHANGES, and their fixes were folded in. Which round found which fix is not stated. | iter2 G APPROVE / X,C RC; iter3 G,C APPROVE / X RC. All points folded except one (below). |
| codev/state/spir-1797_thread.md:23 | F7 | C-other | borderline | A plan-phase refresh task was emitted, not captured, and skipped. | - Plan-phase refresh task was emitted once and not captured; skipped (no state lost). |
| codev/state/spir-1797_thread.md:25 | F3 | C-check | clear | An unrelated umask-dependent test blocked porch's test check. | failed deterministically under umask 077 (writeFileSync mode is umask-filtered) and blocked porch's test check. |
| codev/state/spir-1797_thread.md:26 | F3 | C-check | borderline | A test-check failure did not reproduce, and the failing test was never named. | One porch test-check failure after the rebuttal did not reproduce (full suite green twice); failing test not captured; watch for recurrence. |
| codev/state/spir-1797_thread.md:31 | F4 | S-consult-loop | clear | The phase_3 second round found that variadic flags swallow the prompt. Fixed. | - phase_3 iter2 CMAP: G/X approve, C comment (variadic/optional-value flags swallow the appended prompt; =value form unmatched). |
| codev/state/spir-1797_thread.md:43 | F3 | C-check | clear | One test-check run failed in an unrelated forge test; the rerun was green. | - Intermittent: one porch test-check run failed in a forge pr-create test (CODEV_PR_TITLE/CODEV_PR_BODY required); immediate rerun green. |
| codev/state/spir-1797_thread.md:44 | F4 | S-consult-loop | clear | The phase_4 second round found the repo-subdirectory mis-keying, reproduced. Fixed. | C RC (project in a repo SUBDIRECTORY: porcelain repo-root paths mis-keyed + hashed at wrong base; reproduced) |
| codev/state/spir-1797_thread.md:45 | F4 | S-consult-loop | clear | The phase_4 third round found symlink retargets invisible. Fixed. | - phase_4 iter3 CMAP: G/C approve, X RC (symlinks all hashed '<special>'; retarget invisible). Fixed: hashPath records '<link:TARGET>'. |
| codev/state/spir-1797_thread.md:46 | F4 | C-bypass | clear | Porch force-advanced phase_4 at the ceiling with fix commit b87516dcd unreviewed. | - phase_4 force-advanced by porch at the iter-3 ceiling (b87516dcd unreviewed; architect told). |
| codev/state/spir-1797_thread.md:46 | F7 | C-other | borderline | A second boundary-refresh task was not captured and was skipped. | Boundary refresh skipped (task not captured). |
| codev/state/spir-1797_thread.md:73 | F4 | S-consult-loop | borderline | A review-phase round found a symlink write escaping the project. Fixed. Porch emission is unclear. | - Codex found a real defect: an edited skill holding a symlinked subdirectory let the `.codev-new` write escape the project. |
| codev/state/spir-1797_thread.md:91 | F4 | S-consult-loop | borderline | Round 5 found loose matching of hot-file sections. Fixed. | - `validateHotFile` now counts only the exact required sections, so a similarly named section can't fill an empty one or dodge a cap. |
| codev/state/spir-1797_thread.md:102 | F4 | S-consult-loop | borderline | Round 6 found writes through a symlinked `.codev-new`. Fixed. | - A symlinked `.codev-new` was written through, for skills and for root files. |
| codev/state/spir-1797_thread.md:115 | F4 | S-consult-loop | borderline | Round 7 found a symlinked-ancestor escape. Fixed. | - A symlinked `codev/` or `codev/resources/` ancestor now makes every governance file under it curated. |
| codev/state/spir-1797_thread.md:127 | F4 | S-consult-loop | borderline | Round 8 found symlinked drafts being sent to reviewers. Fixed. | - A symlinked draft is no longer sent to the reviewers. |
| codev/state/spir-987_thread.md:61 | F4 | S-consult-loop | clear | The spec's second round found the interactive-session surface underspecified. Fixed. | Real gap: I'd conflated runtime 4-tier resolution (works for porch via `resolveCodevFile()`) with the interactive surface |
| codev/state/spir-1819_thread.md:148 | F4 | S-consult-loop | clear | The Phase 7 second round found the test Tower sharing the live `~/.codev/run` socket directory. Fixed. | - (codex) The test Tower still shared `~/.codev/run` |
| codev/state/spir-1819_thread.md:170 | F3 | C-bypass | borderline | Porch's e2e_tests check cannot fail: it runs the vitest e2e config, not Playwright, and ends in an echo fallback. | (Porch's `e2e_tests` check runs `vitest.e2e.config.ts`, not the Playwright suites, and its command ends in |
| codev/state/spir-1819_thread.md:183 | F2 | C-bypass | borderline | Verify-approval is recorded as approved by the architect, with no human word recorded for that gate. | ## 2026-10-18 · Verify: approved by the architect |
| codev/state/spir-1789_thread.md:27 | F4 | S-consult-loop | borderline | The plan's second round (COMMENT) produced small refinements, one a transactional-failure case. | - Iter2: gemini APPROVE, codex COMMENT, claude APPROVE; small refinements folded in (budget formula, import-safe manifest helper, below-floor + live server fails transactionally). |
| codev/state/spir-1789_thread.md:45 | F3 | C-check | clear | The tests check failed twice on an unrelated flake, and porch printed only stderr (#1801). | - Porch `tests` check failed intermittently twice (porch prints only stderr, so the test was unnamed). |
| codev/state/spir-1789_thread.md:95 | F4 | C-bypass | borderline | Porch went to the pr gate after the rebuttal with no second consultation; CMAP on the fix was run by hand. | - Porch went straight to the pr gate after the rebuttal (no second consultation), so CMAP on the fix was run by hand |
| codev/state/pir-819_thread.md:96 | F4 | C-wedge | clear | Porch kept requesting another Gemini run while that model was retired; an architect directive was needed to move past it. | Porch currently blocking on Gemini producing an output. PR gate not yet pending — `porch next 819` reports `status: tasks` requesting another Gemini attempt. |
| codev/state/pir-819_thread.md:104 | F4 | C-text | clear | Porch read a SKIPPED verdict as REQUEST_CHANGES, which forced a rebuttal. | - Porch parsed SKIPPED as REQUEST_CHANGES (anything non-APPROVE/COMMENT does) |
| codev/state/bugfix-1079_thread.md:31 | F4 | C-wedge | borderline | The builder held before the PR gate for a "required" third verdict while the Claude lane was quota-blocked. A human authorized the bypass. | Holding before the PR gate until the required third verdict is available. |
| codev/state/bugfix-1941_thread.md:31 | F3 | S-check | borderline | A test run caught a real defect (skill hashes not regenerated). Whether the run was porch's is not stated. | First full run: `skill-refresh` failed for a real reason (my SKILL.md edit needs `generate-skill-hashes`), fixed in 4877866f5. |
| codev/state/bugfix-1941_thread.md:31 | F3 | C-check | clear | Three tests runs under machine load each failed a different unrelated test. | three porch `tests` runs at load average 35–54 (the load is from other workspaces, chiefly a `shannon` builder's python process) each failed a different, unrelated test, and each passes alone: |
| codev/state/bugfix-1941_thread.md:41 | F3 | C-check | clear | The retry also failed on an unrelated test. The phase stalled until the owner ruled that CI stands in, and the check was skipped. | tests ✗ on `src/commands/consult/__tests__/agy-auth-cache.test.ts` (27.2s). It references nothing this change touched and passes alone (27/27). |
| codev/state/bugfix-1941_thread.md:53 | F8 | C-other | borderline | A reviewer flagged porch's own `chore(porch):` commits as off-format. Rebutted. | - "`chore(porch):` commits off-format": rebutted. They are porch's own state commits |
| codev/state/pir-1354_thread.md:79 | F3 | C-bypass | clear | The build check ran on the working tree, so a pushed head that failed tsc got through; review caught it. | committed — vitest transpiles without typechecking and porch's build check ran against |
| codev/state/bugfix-1992_thread.md:86 | F8 | C-other | borderline | Round 3 REQUEST_CHANGES was only about porch-generated commit format. | - codex: REQUEST_CHANGES, **only** for commit-message format: the `chore(porch):` commits and |
| codev/state/bugfix-1455_thread.md:130 | F3 | C-check | clear | The tests check could not pass on this machine because of a slow unrelated test; advanced via an override. | Porch's `tests` check could not pass on this machine: `spec-1280-measurement-instrument.test.ts` |
| codev/state/bugfix-1922_thread.md:54 | F3 | C-check | borderline | The tests check was held by a Windows load flake until the test was changed. The failure is implied. | After that, 3 green full runs and porch's tests check passed. |
| codev/state/air-1478_thread.md:117 | F3 | C-bypass | borderline | The e2e_tests check passed in 0.1s having run nothing (#1488); the builder ran e2e itself. | it passed in 0.1s having run nothing. Don't read a green `porch check` as e2e coverage. |
| codev/state/air-1357_thread.md:43 | F2 | C-bypass | borderline | The architect approved the AIR pr gate after review; Amr's word was reserved for the merge only. | - PR-phase checks green; pr gate approved by the architect after review. |
| codev/state/air-1357_thread.md:46 | F4 | C-bypass | borderline | The AIR PR advanced with consultation skipped at builder discretion (doc contradiction #1359). | - Architect confirmed the consult-skip was within AIR's builder discretion; |
| codev/state/bugfix-922_thread.md:24 | F3 | C-check | clear | The phase check was blocked by pre-existing flaky tests (#905). The builder skipped them, and the architect had that reverted. | Note on intermediate history: I initially skipped these to unblock porch's |
| codev/state/pir-1011_thread.md:111 | F4 | C-bypass | borderline | PIR's single pass ended with Codex's fix never re-reviewed. The architect's extra CMAP found another real defect. | Single-pass means the Codex fix was NOT independently re-reviewed; escalated to the architect (the remaining reviewer) via afx send |
| codev/state/spir-1049_thread.md:361 | F4 | S-consult-loop | clear | The Phase 3 third round found stale multi-diff sub-file navigation. Fixed with a test. | Gemini+Claude APPROVE; Codex REQUEST_CHANGES: multi-diff sub-file nav stale (no onDidChangeActiveTextEditor). |
| codev/state/spir-1049_thread.md:409 | F4 | S-consult-loop | clear | The Phase 4 second round found the summary unreachable while viewing an artifact. Fixed. | Gemini+Claude APPROVE; Codex REQUEST_CHANGES: resolveSelection artifact fallback → summary |
| codev/state/spir-1338_thread.md:229 | F8 | C-other | borderline | Porch's chore commit sat on top of the phase commit and blocked a clean amend. | Committed as a 2nd phase_2 commit (porch chore was on |
| codev/state/spir-1338_thread.md:277 | F4 | S-consult-loop | clear | The phase_2 second round found a third fail-open gap that the round-1 fix and both approvers had missed. | Codex found a THIRD, deeper gap (C3) that the iter1 C2 fix missed AND both approving reviewers missed. |
| codev/state/spir-1338_thread.md:429 | F4 | S-consult-loop | clear | The phase_4 second round found the README escape-hatch snippet broken. Fixed. | Codex + Claude CONVERGED (both HIGH) on one real bug iter1's selector-fix left behind: the README |
| codev/state/spir-1338_thread.md:545 | F4 | C-state | borderline | Porch held stale verdicts from an old HEAD, and the builder deleted the files by hand to force a fresh review. | Forced a fresh consult by clearing the 3 stale old-HEAD review-iter1 verdict files (unrecorded in |
| codev/state/bugfix-1814_thread.md:47 | F3 | C-check | clear | The first tests check failed on an unrelated timing flake at load 22–41; the retry passed. | First `porch done` failed `tests` on `session-manager.test.ts` |
| codev/state/pir-1066_thread.md:125 | F4 | C-text | clear | Porch counted Gemini's verdict-less output as REQUEST_CHANGES and wrote a rebuttal file. | (porch parsed it as REQUEST_CHANGES → wrote rebuttal file.) |
| codev/state/pir-1365_thread.md:224 | F1 | C-text | borderline | Porch's final task said to merge, against the standing order. Not done. | Porch's final task says "merge the PR" — not taken; PR #1492 and issue |
| codev/state/bugfix-1158_thread.md:80 | F1 | C-other | clear | Porch state lived in the main checkout, so stateful commands run from the worktree did nothing or said "not found". | **porch-from-where gotcha**: this project's porch state lives in the MAIN checkout's |
| codev/state/bugfix-901_thread.md:7 | F6 | C-state | borderline | Second-hand: porch v3.1.4 re-set pr_ready_for_human=true on the terminal advance, so Needs Attention showed merged builders. | v3.1.4 re-set `pr_ready_for_human=true` on terminal `pr→verified` advance. In-flight builders that crossed that boundary still carry the stale `true` in status.yaml. |
| codev/state/air-1352_thread.md:32 | F4 | C-bypass | borderline | The AIR builder skipped CMAP and porch requested the pr gate anyway. The architect caught it at the gate, and the late review found a real defect. | I had skipped the consult, reading AIR's "optional" clause as builder discretion; the architect corrected this at the gate. |
| codev/state/bugfix-1586_thread.md:140 | F2 | C-other | clear | `porch approve … pr` committed state, then its push was rejected. Recovery was a manual merge and push. | `porch approve ... pr` failed its first run: it commits state then pushes, and |
| codev/state/bugfix-1586_thread.md:147 | F8 | C-other | clear | Porch's post-merge commits were stranded on the branch and needed a records PR. | Porch commits after the merge are stranded on the branch and need a records PR: |
| codev/state/spir-823_thread.md:12 | F4 | S-consult-loop | clear | The spec's second round found real spec errors, including the wrong in-flight thread path. Fixed. | **Iter-2** (Codex REQUEST_CHANGES on Item 3): three findings — strict-mode delivery rationale, in-flight thread path |
| codev/state/spir-823_thread.md:13 | F4 | S-consult-loop | borderline | The spec's third round asked for MUST and retention rules: requirement gaps more than defects. | **Iter-3** (Codex REQUEST_CHANGES): skeleton templates MUST for item 2, explicit commit/retention rule for item 3, removeArchitect wording hedge. |
| codev/state/spir-823_thread.md:14 | F4 | S-consult-loop | clear | The spec's fourth round found contradictions the round-3 edits had introduced. Fixed. | **Iter-4** (Codex REQUEST_CHANGES): internal-contradiction fixes I introduced in iter-3 |
| codev/state/spir-823_thread.md:24 | F4 | S-consult-loop | borderline | The plan's second round was COMMENT-level only; its findings (wrong test path, validation gap) were addressed. | **Iter-2**: APPROVE/COMMENT/APPROVE. Codex's COMMENT-level findings (Phase 4 acceptance-criterion alignment, Tower test path correction, copy-skeleton validation gap) all addressed. |
| codev/state/pir-1070_thread.md:170 | F2 | C-bypass | borderline | The builder ran `porch approve 1070 pr --a-human-explicitly-approved-this` on relayed words that named a different gate (dev-approval). pir-1494:99 later calls this "structural guarantee BYPASSED"; a human had decided to merge. | Architect relayed Amr's verbatim "yes I approved dev-approval, merge it". Ran `porch approve 1070 pr |
| codev/state/spir-1940_thread.md:86 | F4 | C-other | borderline | A second spec review was wanted, but porch, parked at the gate, emits no consultation, so the lanes were run by hand. | Porch is parked at the gate and hands out no further |
| codev/state/spir-1940_thread.md:298 | F3 | C-check | clear | The Phase 1 tests check failed once under load for a change touching no production path. | `porch done` failed its `tests` check once (build passed). |
| codev/state/spir-1940_thread.md:364 | F3 | C-check | clear | The Phase 2 tests check failed under load. Porch prints only the first lines, so the test was unnamed. | `porch done` on `d6124d76c` failed its `tests` check (build passed). Porch prints only the |
| codev/state/spir-1940_thread.md:392 | F3 | C-check | clear | Blocked: 92 tests in 17 untouched files timed out at load 33–49. | phase 2 iteration 1: BLOCKED on porch's tests check under machine load |
| codev/state/spir-1940_thread.md:449 | F4 | S-consult-loop | clear | The Phase 2 second round found the #1633 ordering defect. Fixed. | phase 2 review iteration 2: issue #1633 fixed in place |
| codev/state/spir-1940_thread.md:612 | F3 | C-check | clear | The Phase 3 tests check failed under its own load on five untouched files. | Run at load 12.7. Build passed (21 s); **tests check failed** (93 s). |
| codev/state/spir-1940_thread.md:694 | F4 | S-consult-loop | borderline | The Phase 3 second round: claude's non-blocking notes were fixed on the architect's instruction. | **Claude**, two notes fixed on the architect's instruction: the naming module told workspaces |
| codev/state/spir-1940_thread.md:743 | F3 | C-check | borderline | The owner ruled "ci-first": no plain `porch done`, with CI standing in for porch's local tests check until #1956. This follows from the rows above. | **Owner ruling main-38, "ci-first"** (relayed by the architect, 00:33Z), in force until issue |
| codev/state/spir-1940_thread.md:1429 | F8 | C-other | borderline | status.yaml shows no review rounds for phases 4–6, because porch records only rounds that asked for changes. | `status.yaml` shows no review round for phases 4 to 6 because porch records only rounds that |
| codev/state/spir-1940_thread.md:1440 | F4 | C-bypass | borderline | After a review-phase REQUEST_CHANGES, porch went to the pr gate with no second round, so the final head was seen by no reviewer. | Porch went straight to the `pr` gate (`90b6ac8b7`); it ran no second review round, though the |
| codev/state/aspir-1286_thread.md:65 | F4 | S-consult-loop | clear | The specify second round found two more real defects, one introduced in round 1. | **iter 2**: gemini/claude APPROVE, codex REQUEST_CHANGES. Two more real catches, both conceded: |
| codev/state/aspir-1286_thread.md:78 | F4 | S-consult-loop | clear | The specify third round found an undefined value space for reasoningEffort. | **iter 3**: gemini/claude APPROVE, codex REQUEST_CHANGES — `consult.reasoningEffort.codex` had a |
| codev/state/aspir-1286_thread.md:88 | F4 | C-bypass | clear | Porch force-advanced the spec at max_iterations with codex at REQUEST_CHANGES; the round-3 fix went unreviewed. | `status.yaml` records `force_advanced: {phase: specify, iteration: 3, max_iterations: 3}`. |
| codev/state/aspir-1286_thread.md:105 | F4 | C-other | borderline | A trap the builder avoided: a re-run spec consult would have been saved as a plan-phase review that porch could count as plan verification. | **Trap avoided**: porch had already advanced to `plan`, so a `--project-id` consult would have |
| codev/state/aspir-1286_thread.md:210 | F3 | C-check | clear | The tests check held phase_1 for about a day on an unrelated baseline test that measures live repo history. | **Held at phase_1 iter2**: `porch done`'s tests check fails on exactly one test |
| codev/state/aspir-1286_thread.md:257 | F1 | C-state | clear | After a rebase, `porch done` committed build_complete locally, then failed at its own push. | **3. Rebase then makes `porch done` fail at a step that has nothing to do with your phase.** |
| codev/state/aspir-1286_thread.md:302 | F1 | C-text | borderline | Run from the wrong cwd, porch's flat "Project not found" looked like state corruption. | And `porch` resolves the project from |
| codev/state/aspir-1286_thread.md:488 | F4 | S-consult-loop | borderline | The phase_3 second round raised three minor findings, which were fixed. | plus three more minor ones at iter2 that I fixed rather than banked with the approval. |
| codev/state/aspir-1286_thread.md:520 | F3 | C-check | borderline | The phase_4 check failed on 5 tests in an untouched file; the fix came in from main. | `porch check` failed with 5 tests red in `spec-1280-measurement-instrument.test.ts` — a file this |
| codev/state/aspir-1286_thread.md:558 | F4 | S-consult-loop | clear | The phase_4 second round found a stale-dist concurrency test that hid a real SQLITE_BUSY bug. | after an iter2 where **both reviewers independently |
| codev/state/aspir-1286_thread.md:663 | F4 | S-consult-loop | borderline | The phase_5 second round found a test comment that overstated coverage. | **claude's iter2 note**, which I'd rank higher than its "minor" label |
| codev/state/aspir-1286_thread.md:689 | F4 | C-bypass | clear | Porch force-advanced phase_6 at iteration 3 with codex at REQUEST_CHANGES; the round-3 doc fixes went unreviewed. | `max_iterations: 3`, and porch **force-advanced** — `status.yaml` has the `force_advanced` record. |
| codev/state/aspir-1286_thread.md:707 | F4 | S-consult-loop | clear | The phase_6 second round found the docs' only shell example did not run. | - **iter2**: the section's only shell example didn't run. |
| codev/state/aspir-1286_thread.md:710 | F4 | S-consult-loop | clear | The phase_6 third round found invalid JSON comments in a docs example. | - **iter3**: `//` comments in a `.codev/config.json` example that `JSON.parse` rejects. |
| codev/state/aspir-1286_thread.md:753 | F8 | S-record | borderline | status.yaml's force_advanced record exposed the builder's false "all approved unanimously" claim. | `status.yaml` says phase_6 **force-advanced** at |
| codev/state/spir-945_thread.md:57 | F2 | C-bypass | borderline | The builder ran `porch gate` before addressing REQUEST_CHANGES, and porch accepted the request. | I also **prematurely ran `porch gate`** before addressing the REQUEST_CHANGES, so the gate is |
| codev/state/spir-945_thread.md:81 | F4 | S-consult-loop | borderline | The spec's second round found three real issues, but the gate was already requested, so the round may have been manual. | **iter-2 consult verdicts (per verdict files):** Gemini SKIPPED (agy lane no output), Codex |
| codev/state/spir-945_thread.md:91 | F2 | C-state | borderline | Porch kept a stale `spec-approval: approved` against the pre-revision spec; who approved is not stated. | **Gate state note:** porch still carries a stale `spec-approval: approved` (2026-06-02) from a |
| codev/state/spir-945_thread.md:98 | F4 | S-consult-loop | borderline | The spec's fourth round raised three small items, deferred to the plan; possibly a manual round. | iter-4 (on committed iter-3): **Claude APPROVE (HIGH); Codex REQUEST_CHANGES (HIGH, 3 small |
| codev/state/spir-945_thread.md:110 | F1 | C-other | borderline | Porch's auto-push failed after rebases, and a force-push was needed. | **Mechanics:** the rebases had diverged the branch from origin; porch's auto-push then failed |
| codev/state/spir-945_thread.md:154 | F4 | S-consult-loop | clear | The plan's second round found two valid spec-contract issues. Fixed. | Plan iter-2 (14ac8e73): Gemini SKIPPED, **Codex REQUEST_CHANGES (HIGH)**, **Claude APPROVE (HIGH)**. |
| codev/state/spir-945_thread.md:169 | F4 | S-consult-loop | clear | The plan's third round found three repo-wiring defects. Fixed. | Plan iter-3 (58be1b5d): Gemini SKIPPED, **Codex REQUEST_CHANGES (HIGH)**, **Claude APPROVE (HIGH)**. |
| codev/state/spir-945_thread.md:185 | F4 | S-consult-loop | clear | The plan's fourth round found two legitimate gaps. Fixed. | Plan iter-4 (7f06e594): Gemini SKIPPED, **Codex REQUEST_CHANGES (HIGH)**, **Claude APPROVE (HIGH)**. |
| codev/state/spir-945_thread.md:200 | F4 | S-consult-loop | clear | The plan's fifth round found a self-inflicted contradiction and a git-add gap. Fixed; the human then stopped the loop. | Plan iter-5 (0bd1dd79): Gemini SKIPPED, **Codex REQUEST_CHANGES (HIGH)**, **Claude APPROVE (HIGH)** (5th APPROVE). |
| codev/state/spir-945_thread.md:219 | F1 | C-other | borderline | Porch's auto-push failed again after rebases; force-pushed. | rebases → porch auto-push failed → force-pushed (user-approved) to reconcile; porch then |
| codev/state/spir-945_thread.md:271 | F4 | C-state | borderline | A manual round-2 consult run ahead of porch tangled its iteration bookkeeping. Builder-caused. | I went slightly off porch's rails (ran a manual iter-2 consult before porch reached iteration 2), |
| codev/state/spir-945_thread.md:276 | F4 | C-wedge | clear | Porch read a verdict-less gemini timeout file as REQUEST_CHANGES and blocked phase_1. | **porch-parser issue found:** porch flagged gemini iter-2 as REQUEST_CHANGES, but that file had NO |
| codev/state/spir-945_thread.md:314 | F3 | C-check | clear | The tests check (whole codev suite) failed on flaky codev tests for a change in another package. | BLOCKED: porch Phase 2 tests check fails on flaky CODEV tests |
| codev/state/spir-945_thread.md:391 | F4 | S-consult-loop | clear | The Phase 3 second round found an async race. Fixed. | - iter-2 Codex RC: async race (stale read/list overwrite) + prior-markers test. Fixed via |
| codev/state/spir-945_thread.md:393 | F4 | S-consult-loop | clear | The Phase 3 third round found a warning that fired on every reload. Fixed. | - iter-3 Codex RC: out-of-range warn-once (was warning every reload). Fixed via warnedRef |
| codev/state/spir-945_thread.md:395 | F4 | S-consult-loop | clear | The Phase 3 fourth round found a real gap in no-watcher refresh. Fixed. | - iter-4 Codex RC (HIGH): spec D6 says a no-watcher host forces refresh by re-rendering, but the |
| codev/state/spir-945_thread.md:414 | F4 | S-consult-loop | clear | The Phase 3 fifth round found a stale activeLine bug. Fixed at root. | 1. **Stale activeLine (real bug, fixed at root).** activeLine survived watch/refreshKey reloads |
| codev/state/air-1900_thread.md:49 | F3 | S-check | clear | The tests check failed because an edited shipped skill's hash was not regenerated, a real defect. | One failure: `src/__tests__/skill-refresh.test.ts`. Editing a shipped skill (porch SKILL.md) |
| codev/state/air-1900_thread.md:58 | F3 | C-check | clear | The second tests check failed on two untouched files under load. | Build ✓. Tests ✗ in two files that passed in run #1 and don't touch porch: |
| codev/state/pir-933_thread.md:11 | F1 | C-state | borderline | Porch state was rolled back with `git reset --hard` to the porch-init commit for a restart, because porch has no restart command. | - `git reset --hard fcea5028` (pristine porch-init commit) → porch back in the |
| codev/state/pir-841_thread.md:33 | F4 | C-text | clear | Porch recorded a gemini non-review as REQUEST_CHANGES, forcing a rebuttal for a finding that did not exist. | Gemini = non-review (agy got empty workspace, no diff → porch defaulted to REQUEST_CHANGES). |
| codev/state/air-1950_thread.md:30 | F6 | C-text | borderline | `porch status --json` prints an [auto-detected] line on stdout before the JSON. | - Noticed, not changed: `porch status --json` with an auto-detected project prints |
| codev/state/air-1950_thread.md:35 | F3 | C-check | clear | The tests check failed three times on untouched tests at load up to 59; CI stood in. | - The local porch `tests` check failed three times on tests this PR doesn't touch: timeouts in the |
| codev/state/bugfix-1935_thread.md:16 | F8 | C-other | borderline | Codex's only REQUEST_CHANGES was over porch-authored commit prefixes. | codex REQUEST_CHANGES only over porch-authored `chore(porch):` commit prefixes (not rewritten, porch owns those) |
| codev/state/bugfix-1224_thread.md:137 | F8 | C-other | borderline | Codex flagged the porch-committed status.yaml in the PR. Rebutted. | status.yaml is committed by porch's own |
| codev/state/spir-1963_thread.md:60 | F4 | C-other | borderline | The spec was revised at the gate, and porch cannot re-review there, so codex and claude were run by hand. | Revision committed; re-consult (codex + claude, manual — porch is at the gate) running. |
| codev/state/spir-1963_thread.md:115 | F2 | S-gate | borderline | The plan gate was pre-approved subject to the architect's check. While porch held it, the architect found the spawn harness could not work. | The architect caught that the plan's `afx spawn --task` |
| codev/state/spir-1963_thread.md:259 | F4 | S-consult-loop | clear | The Phase 1 second round found the vsix-freshness defect that "would have broken later phases". | advancing, because one would have broken later phases: |
| codev/state/spir-1963_thread.md:470 | F3 | C-check | clear | The Phase 4 tests check failed in an untouched package. Porch printed only npm warnings, and a one-time skip was granted. | failed. porch printed only npm warnings as the tail and kept no log, so the failing test names |
| codev/state/spir-1963_thread.md:1068 | F7 | C-state | borderline | Porch recorded a refresh boundary as acknowledged on a second `porch next`, before any refresh happened. | porch's `arrange_cockpit` refresh boundary was recorded as acknowledged when I |
| codev/state/spir-1963_thread.md:1128 | F4 | S-consult-loop | clear | The Phase 9 second round found two real arrange defects, fixed with tests that fail on the old code. | Both were real and are fixed in place after the approvals, so the PR review is the first to see |
| codev/state/spir-1963_thread.md:1386 | F8 | C-other | clear | `porch approve` pushed its own status.yaml record, which moved the PR head past the one cleared to merge. The architect had to re-rule. | `porch approve` committed and pushed its own gate record, `014a166cd` (status.yaml only), so |
| codev/state/spir-1963_thread.md:1397 | F8 | S-record | borderline | `porch done --merged` refused with "No PR history found", so the PR and the merge were recorded. | `porch done --merged` first failed |
| codev/state/spir-927_thread.md:71 | F2 | C-bypass | borderline | Spec-approval is recorded as approved by the architect, with no human named. | Architect approved spec-approval. |
| codev/state/spir-927_thread.md:123 | F2 | C-bypass | borderline | Plan-approval is recorded as approved by the architect, after line 78 said not to pass it without the human. No human is named. | Architect approved plan-approval. Confirmed decisions: |
| codev/state/spir-927_thread.md:213 | F1 | C-wedge | borderline | After `porch done`, `porch next` re-showed the iteration-2 implement prompt, and a second `porch done` was needed. | (Porch quirk: after committing the fix + `porch done`, the first `porch next` re-showed the |
| codev/state/pir-1473_thread.md:311 | F2 | S-gate | borderline | The architect sent a dev-approval request back for evidence, and the evidence run found a real bug in the `afx send` request path. | The architect sent the gate back for evidence, correctly: I had requested it on build-green + |
| codev/state/pir-1473_thread.md:673 | F4 | C-wedge | clear | The claude lane could not run, and porch, which tracks consultation as file presence, offered only "make a file exist" or "change the lane config". | The phase then offers two exits: make a file exist, or change the lane config |
| codev/state/pir-1473_thread.md:693 | F4 | C-text | clear | `porch next` showed claude as COMMENT for a consultation that never ran. | claude as `COMMENT` — a reviewer position — for a consultation that never ran. |
| codev/state/spir-1401_thread.md:169 | F1 | C-wedge | borderline | `porch next` hung about 65 minutes on a `git push` child it had spawned. The builder says the root cause was not porch. | `porch next 1401` hung for ~65 minutes with zero output. |
| codev/state/spir-1401_thread.md:179 | F1 | S-state | borderline | After the kill, porch resumed at implement iteration 2 with no state loss; the interruption was porch's own hang. | porch resumed correctly at implement iteration 2 with no state loss. |
| codev/state/spir-1401_thread.md:331 | F4 | S-consult-loop | clear | The phase_3 second round found check-types failing, which every signal the builder watched had missed. | ### phase_3 iter2: gemini APPROVE, codex + claude REQUEST_CHANGES — check-types was FAILING |
| codev/state/spir-1401_thread.md:531 | F4 | C-wedge | clear | The phase_6 review loop could not converge (the same 2-1 split on a human-only verification). The architect stopped it. | ### phase_6 loop cannot converge — escalated (2026-08-12) |
| codev/state/spir-1401_thread.md:540 | F4 | S-consult-loop | borderline | Fixes credited to round 2 are not in round 1's list; the attribution is an inference. | All actionable findings from iter1/iter2 ARE fixed (reconnect, re-registration race, |
| codev/state/bugfix-1902_thread.md:87 | F1 | C-other | clear | `porch done --help` actually ran `porch done`, checks included. The builder stopped it. | - **`porch <cmd> --help` executed the command.** Verifying prompts with `--help` ran |
| codev/state/bugfix-1902_thread.md:120 | F3 | C-check | clear | The first check run failed on an intermittent test under load; truncation hid which test. | failure under machine load; porch truncates check output, so the failing test is unknown |
| codev/state/bugfix-1902_thread.md:132 | F2 | C-text | clear | Porch's own "To approve:" hints left out the human-approval flag. | porch's own `To approve:` hints lacked the |
| codev/state/spir-778_thread.md:103 | F4 | C-other | clear | After the spec was rewritten at the gate, porch could not run a new review (rollback rejected, approve human-only), so all three consults were run by hand. | Porch couldn't re-consult from the gate (rollback rejected: already in specify; approve=human-only; |
| codev/state/pir-991_thread.md:54 | F2 | S-gate | borderline | At dev-approval, the reviewer's live test showed the reconnect fix did not work, and it was redesigned before the PR. | Reviewer tested via vsix and VSCode terminals still didn't reconnect on Tower restart |
| codev/state/air-1893_thread.md:14 | F3 | S-check | clear | The tests check caught a real failure: skill hashes not regenerated after an afx skill edit. | The first had one real failure (I'd edited the afx skill, so `generate-skill-hashes` was needed) |
| codev/state/air-1893_thread.md:14 | F3 | C-check | clear | Two more tests-check failures showed no output (porch prints five stderr lines); the same command passed outside porch. | The next two failed with no visible output: porch prints only the first five stderr lines, all npm warnings. |
| codev/state/air-1477_thread.md:149 | F1 | S-state | borderline | With the PR open, `porch status` still showed implement with checks unrun. The builder then ran the checks and the PR-stage CMAP, which found nothing. | `porch status 1477` showed PHASE: implement with build/tests "not yet run". |
| codev/state/pir-1914_thread.md:17 | F3 | C-check | clear | The tests check failed on a pre-existing test because of npm registry config; an env override was ruled. | porch tests check failed on the pre-existing protocol-drift-audit test |
| codev/state/pir-1919_thread.md:19 | F3 | C-check | clear | The tests check failed while overlapping another builder's suite, with output truncated; a solo run passed. | First porch tests check failed while overlapping another builder's suite (output truncated, failures unknown). |
| codev/state/aspir-1210_thread.md:48 | F4 | S-consult-loop | borderline | Labelled round 2, but no round 1 is recorded, and the finding is closer to a reuse request than a defect. | Phase 1 iter2: codex REQUEST_CHANGES (used custom walk instead of `listSkeletonFiles`) → fixed |
| codev/state/aspir-1210_thread.md:56 | F4 | S-consult-loop | borderline | Labelled round 2, with two real text/version defects fixed; no round 1 is recorded. | Phase 2 iter2: codex REQUEST_CHANGES ×2 (differs line lacked skeleton version; header parenthetical |
| codev/state/aspir-1210_thread.md:70 | F4 | S-consult-loop | clear | The Phase 3 second round found a missing plan-required assertion. Fixed with a real-timeout test. | Phase 3 iter2: codex REQUEST_CHANGES (MEDIUM) — plan's 2nd non-functional assertion (staleness |

All 280 quotes were checked mechanically: each is an exact substring of its cited line, at most 240 chars.

## 3. Counts

**Totals.** 280 rows from 93 distinct thread files.

| | Clear | Borderline |
|---|---|---|
| Saves | 60 | 44 |
| Costs | 76 | 100 |

### 3a. Function × kind

| fn | kind | clear | borderline | total |
|---|---|---|---|---|
| F1 | S-state | 0 | 8 | 8 |
| F1 | C-bypass | 0 | 1 | 1 |
| F1 | C-other | 2 | 4 | 6 |
| F1 | C-state | 5 | 4 | 9 |
| F1 | C-text | 2 | 5 | 7 |
| F1 | C-wedge | 1 | 2 | 3 |
| F2 | S-gate | 0 | 4 | 4 |
| F2 | C-bypass | 0 | 11 | 11 |
| F2 | C-other | 2 | 2 | 4 |
| F2 | C-state | 0 | 1 | 1 |
| F2 | C-text | 1 | 0 | 1 |
| F3 | S-check | 6 | 3 | 9 |
| F3 | C-bypass | 1 | 4 | 5 |
| F3 | C-check | 42 | 16 | 58 |
| F3 | C-other | 1 | 0 | 1 |
| F4 | S-consult-loop | 54 | 24 | 78 |
| F4 | S-consult-skip | 0 | 1 | 1 |
| F4 | C-bypass | 5 | 15 | 20 |
| F4 | C-other | 1 | 5 | 6 |
| F4 | C-state | 0 | 3 | 3 |
| F4 | C-text | 4 | 0 | 4 |
| F4 | C-wedge | 5 | 1 | 6 |
| F5 | C-text | 0 | 2 | 2 |
| F6 | S-state | 0 | 1 | 1 |
| F6 | C-state | 0 | 1 | 1 |
| F6 | C-text | 0 | 1 | 1 |
| F7 | C-other | 0 | 3 | 3 |
| F7 | C-state | 0 | 1 | 1 |
| F8 | S-record | 0 | 3 | 3 |
| F8 | C-other | 3 | 17 | 20 |
| F8 | C-state | 1 | 1 | 2 |

Kinds with no rows anywhere: S-prompt, S-refresh. The only S-gate rows are 4 borderline ones. The only S-consult-skip row is 1 borderline one.

### 3b. By function, saves against costs

| fn | saves clear | saves borderline | costs clear | costs borderline |
|---|---|---|---|---|
| F1 State machine | 0 | 8 | 10 | 16 |
| F2 Human gates | 0 | 4 | 3 | 14 |
| F3 Phase checks | 6 | 3 | 44 | 20 |
| F4 Consultation | 54 | 25 | 15 | 24 |
| F5 Prompt delivery | 0 | 0 | 0 | 2 |
| F6 Queryable state | 0 | 1 | 0 | 2 |
| F7 Context refresh | 0 | 0 | 0 | 4 |
| F8 Records | 0 | 3 | 4 | 18 |

### 3c. Concentration and denominators the counts depend on

**Rows are concentrated in a few threads.** Eight threads give 113 of the 280 rows:

| Thread | Rows |
|---|---|
| spir-1313 | 21 |
| spir-945 | 17 |
| spir-1797 | 15 |
| aspir-1286 | 15 |
| spir-1470 | 13 |
| spir-1951 | 13 |
| spir-1940 | 10 |
| spir-1658 | 9 |

**Distinct files behind the main kinds:**

| Kind | Rows | Distinct threads | Notes |
|---|---|---|---|
| F4 S-consult-loop, clear | 54 | 18 | All SPIR or ASPIR. |
| F3 C-check, clear | 42 | 31 | |
| F3 S-check, clear | 6 | 6 | 5 of the 6 are one defect class: a shipped skill edited without regenerating its hash or parity copies (air-1893, air-1900, bugfix-1853, bugfix-1871, bugfix-1921). The `skill-refresh` and parity tests also run in CI. |
| F4 C-bypass, clear | 5 | 4 | |
| F4 C-bypass, borderline | 15 | 11 | |
| F2 C-bypass, borderline | 11 | 8 | |

**Force-advance.** "Force-advance at the 3-iteration ceiling" appears in 10 threads. It accounts for 4 of the 5 clear F4 C-bypass rows and most of the borderline ones.

**The S-consult-loop population is 28 threads, not 320.** Porch runs a multi-round review loop only in SPIR and ASPIR, and there are 23 SPIR and 5 ASPIR threads. PIR's review is single-pass; BUGFIX and AIR rounds are run by the builder. Population by protocol: 121 PIR, 114 BUGFIX, 49 AIR, 23 SPIR, 5 ASPIR, 2 EXPERIMENT, 6 task.

**First-round catches** were excluded by rule and tallied per bin. The 8 readers defined the tally differently: some counted only porch-emitted rounds, others any lane. Their tallies sum to about 128 file-mentions. That is not a reliable number. It only says that first-round catches are common in every protocol, including the ones where porch runs no review.

## 4. Lists

### 4a. Gates passed without a human decision

**Clear cases: none.** No thread records a builder or architect passing a human gate while saying that no human had decided.

**Borderline: the architect is named as approver and no human is named.** These are all rows in §2 as F2 C-bypass borderline. A builder thread sees only the relay, so none of them can show whether a human stood behind the approval. Who typed `porch approve`, and whether `--a-human-explicitly-approved-this` was used, is not recorded in any of them.

| Where | Gate | What the thread records |
|---|---|---|
| spir-1313:44 | spec-approval | "Architect approved". Line 40 had said "Waiting for human". |
| spir-1313:121 | plan-approval | "Architect approved … (commit 36582b2d)". |
| spir-1313:985, :991 | pr | The architect: "I'll approve the pr gate directly when it's clean". Line 991: "Architect approved the pr gate". |
| spir-927:71 | spec-approval | "Architect approved". |
| spir-927:123 | plan-approval | "Architect approved", although line 78 said "Do NOT advance past plan-approval without the human". |
| pir-809:12 | plan-approval | "Approved by architect". |
| pir-1428:65 | plan-approval | Line 63 routed the gate "→ Amr". Line 65 says "Plan APPROVED by architect". |
| air-1357:43 | pr | "approved by the architect after review". The human's word was reserved for the merge (:44-45). |
| spir-1819:183 | verify-approval | "approved by the architect". The pr approval before it was a relayed human approval (:181). |

spir-1313 is an external contributor's workspace (a fork), where the "architect" may be the contributor's own session.

**Approve flag used on relayed prose that named a different gate.** pir-1070:170 (row). The architect relayed Amr's "yes I approved dev-approval, merge it". The builder then ran `porch approve 1070 pr --a-human-explicitly-approved-this`.
- A human did decide to merge.
- pir-1494:99 records the architect's later reading: "structural guarantee BYPASSED — porch state produced from prose typed into a builder's pane".
- pir-1494:105 adds that porch stores approved_at and never approved_by (#1457), so even a legitimate relay cannot be proven from the record.

**Other gate-state irregularities:**
- **spir-945:91 (row).** Porch carried a stale `spec-approval: approved` (2026-06-02) recorded against the pre-revision spec. Who approved is not stated.
- **spir-945:57 (row).** The builder requested a gate (`porch gate`) before fixing REQUEST_CHANGES. That is a request, not a pass.

**Gates recorded as approved with no approver named at all** (list only, not rows):
- pir-1139:12, :21
- pir-1140:12, :20
- pir-1198:21
- pir-961:31
- pir-1145:15
- spir-823:17 ("Architect locked OQ-B … Spec-approval gate approved.")

**Where the flag demanded something:**
- spir-1280:354: "porch required the `--a-human-explicitly-approved-this` flag — correct guard".
- air-1489:99-100: approve "needed the explicit" flag.

Both approvals were legitimate human relays. No thread records the flag stopping an approval that lacked a human.

**Reviews and checks passed without approval (not human gates):**
- **Force-advance at max_iterations, with no reviewer approval and no human:**
  - spir-1313:728
  - spir-1470:633, :843
  - spir-1951:107, :346
  - spir-1658:185, :226
  - spir-1797:46
  - aspir-1286:88, :689
- **Porch went to the pr gate with no second round:** spir-1940:1440, spir-1951:425, spir-1789:95, spir-1280:132 (spec gate).
- **Phase checks skipped on architect or owner rulings:**
  - spir-1951:71, :89
  - spir-1963:499
  - spir-1940:743 (the owner's "ci-first")
  - bugfix-1941:47
- **ASPIR spec and plan "auto-approved"** (aspir-1273:454, :456) are by design: ASPIR has no spec or plan human gates.

**Holds and refusals, recorded by builders:**
- spir-1313:40-41
- spir-1280:127, :1392
- aspir-1273:347, which refused to approve its own pr gate although line 14's brief said the merge was "pre-granted"
- aspir-1210:86
- spir-778:120-121 ("I did NOT self-approve")

**Merges declined even though porch's own task said to merge:** pir-1365:224, pir-1450:287, bugfix-1472:110, pir-1563:162 (rows).

**Builders ran `porch approve` themselves on a relayed human decision** under the #1494 rule. Examples:
- pir-1668:50, :79
- pir-1553:101
- pir-1552:239
- pir-1802:19
- spir-1951:56
- bugfix-1677:138-139

### 4b. Soft-mode and no-porch work (facts only)

**Soft builders:**
- **experiment-1782** (not matched by the filter; read whole):
  - :5: "Spawned soft-mode EXPERIMENT"; the issue body served as the spec.
  - Checks: it ran validate and the plugin tests (12/12 at :9 and :12; 16/16 at :14).
  - Consultation: none recorded.
  - Rulings: contradictions were raised to the vscode architect, who ruled (:7).
  - Live questions needed a human watching the TUI (:12).
  - Gates: none recorded.
- **experiment-1560:5** ("EXPERIMENT, soft"):
  - No consultations and no checks recorded.
  - :45: "Owner approved experiment-complete (relayed by architect:vscode); porch protocol complete". So a porch gate record was kept in soft mode.
- **task-_205** (not matched; read whole):
  - No consultation recorded.
  - It did not run vitest locally (no node_modules) and relied on CI for the parity tests (:21-22). The architect verified the fix on Windows 11 (:22-23).
  - Gates: none.
- **task-24AO** (not matched; read whole):
  - No model consultation recorded.
  - Live testing found three defects of the #1455 class, and the architect independently flagged the same three (:69-72).
  - Tests were reported against a control (:148-160).
  - Gates: none. Neither PR was merged: "the maintainer merges" (:6, :169).
- **task-SVsf:**
  - Consultation: it ran its own codex and claude CMAP (:74), which found real defects (:79, :97).
  - Checks: it ran its own tests (:72).
  - Gates: none.
- **task-47B5:**
  - Consultation: its own CMAP, codex and claude (:40). 10 findings accepted, 3 declined with reasons (:80-92).
  - Checks: build, tsc and full suite (:96-98).
  - Gates: none. The PR waits on maintainer CI approval (:105).
- **task-yr9D:**
  - Checks: build and full suite (:37, :82).
  - Consultation: it applied the architect's 3-way integration findings (:41), then ran its own 3-way CMAP (:84). It fixed codex's two blocking items and claude's notes (:91-118).
  - Gates: none. The architect handles PR communication (:5).
- **task-H71_, inside bugfix-1455 (:181 onward):** maintainer-side finish of a porch bugfix branch.
  - Consultation: "CMAP on the delta" (:241), where codex and claude both returned REQUEST_CHANGES. Both were fixed.
  - Checks: build and full suite (:236-237).
  - Gates: none recorded.
- **task-NHnJ** is not soft: a `--task` spawn that ran PIR in strict mode (:5).

**Strict projects working outside porch:**
- **spir-1313:1331-1505.** After the rollback, on the architect's direction, the builder made changes without porch.
  - It ran 3-way CMAP rounds 1-4 itself (:1371, :1394, :1432, :1460). Rounds 2-4 each found new real defects, so review loops caught things with porch out of the loop.
  - It ran the full suite itself and approved no gate.
  - Later fix rounds also left porch untouched (:1684 "no porch state change").
- **bugfix-1883:145.** A second PR (#1888) from the same worktree with "no porch project for it".
  - It ran CMAP, all three APPROVE (:151).
  - It waited at "the PR gate", with no porch gate behind it.
  - No porch checks are recorded.
- **Consults by hand at or around a gate, because porch could not run them:** spir-1963:60, spir-778:103-104, spir-1940:86, pir-929:91, :193, spir-1789:95.
- **aspir-1273:293.** Consults were run outside porch; porch's counter sat at 2 while the builder was on 7.

### 4c. Porch defects named by issue or PR number

**Porch code or porch-emitted text.** "Subject" means the thread exists to fix it.

| Number | Where | Defect |
|---|---|---|
| #870 | bugfix-870:5, :27 | `getMaxIterations()` was dead code; the rebuttal-exists branch advanced regardless of remaining REQUEST_CHANGES. Subject. |
| #872 | bugfix-872:4, :6 | No explicit `pr_ready_for_human` field, so BUGFIX PRs were dropped from Needs Attention. Subject. |
| #887 (from PR #874) | bugfix-887:3, :7 | BUGFIX `pr_ready_for_human` was set only at `porch done`, after the merge. Subject. |
| #888 | bugfix-901:7 | v3.1.4 re-set `pr_ready_for_human=true` on the terminal advance. |
| #894 | bugfix-894:5; spir-1470:398 | Flaky timeout in porch's own `next.test.ts`. Test only. |
| #903 | bugfix-903 | `porch done` on an already-verified project. Subject. |
| #919 | spir-927:28, :40 | Sticky-field hazard in `pr_ready_for_human`. |
| #1077 | bugfix-1077:15-16 | Porch CMAP dispatch and partial-review re-emit multiply agy spawns. |
| #1279 | bugfix-1279:45 | The SPIR/ASPIR specify phase had `"checks": {}`. Subject. |
| #1286 | aspir-1286:18, :731 | A second, unvalidated copy of the consult-model precedence logic in `porch done` swallowed malformed config. Subject. |
| #1408 | spir-1470:410 | Porch resetting phase statuses and rewinding recorded progress (harm class). |
| #1455 | bugfix-1455 | Phase prompts hardcode `gh pr create`. Subject. |
| #1611 | bugfix-1455:225 | The PIR review prompt still hardcodes `gh pr edit/view/merge`. |
| #1457 | pir-1494:22, :105 | Gate records carry approved_at, never approved_by. |
| #1462 | pir-1498:54, :188 | Porch's gate-record commits move the head after pr approval and re-pend checks. |
| #1488 | air-1478:133 | The `e2e_tests` check is a no-op that cannot fail. |
| #1503 (fixed in PR #1528) | spir-1470:503 | ASPIR's ungated advance never extracted plan_phases. |
| #1529 | spir-1470:1733 | False acknowledgment in porch's refresh signal. |
| #1531 | spir-1470:1809 | Consult cannot resolve a merged PR, and porch cannot record a consult that cannot run. |
| #1532 | spir-1470:1800 | `porch rollback` runs unguarded. |
| #1740 | pir-1740:6 | Porch cwd detection and resume assume numeric ids. Subject. |
| #1801 | aspir-1912:43, :92; spir-1789:54 | A failed check's stdout is dropped and only the first 5 stderr lines are shown. |
| #1814 | bugfix-1814:7, :18 | Per-check `timeout_ms` was ignored, so a timed-out check could hang porch. Subject. |
| #1853 (fix PR #1964) | bugfix-1853:3; spir-1951:90 | `porch done` truncates failing check output. |
| #1900 | air-1900:1-9 | Plan phases are copied once; a dropped phase made review unreachable; rollback resets every phase. Subject. |
| #1902 | bugfix-1902:22 | `normalizePhase` ignores a phase's `consultation` block, so the BUGFIX/AIR model lists were dead data. Subject. |
| #1903 | bugfix-1903:5, :30, :34, :38 | Unrendered `{{issue.number}}`; a false "architect has already been notified" gate text; wrong PIR rebuttal and verdict-grep instructions. Subject, hit live. |
| #1235 | pir-1494:206 | An architect running `porch approve` hits a wrong-cwd problem. |
| #619 | spir-1280:854 | An earlier prompt told ASPIR builders to follow SPIR, with the wrong gates. Prompt text. |

**Consumers of porch state** (Tower, dashboard, VS Code; F6), each the subject of its own fix:
- #1777 (bugfix-1777:4, :15): experiment-, maintain- and research- worktrees were treated as soft, so status.yaml was never read, and non-core gates were missed.
- #844, #931.

**Adjacent; consult or protocol text, not porch code:**
- #1032/#1033 (spir-1280:138): the agy `--type` lane gives no verdict.
- #1359 (air-1357:47): AIR consult "optional" contradiction.
- #1431 (pir-1410:14): verify-approval in phaseArtifactVerb.

**Unnumbered porch defects:**
- matchesProjectId rejects letter-suffixed ids (task-NHnJ:51).
- The `porch done` review glob broke on Windows backslashes, so done always refused (spir-1658:195).
- Chaining `done` and `next` resets build_complete (spir-1470:1450-1451).
- A force-advance notice can be prepended to a refresh task (spir-1470:513-518).
- `porch <cmd> --help` executes the command (bugfix-1902:87, bugfix-1686:106).
- "To approve:" hints lacked the flag (bugfix-1902:132).
- A verdict-less file or timeout is parsed as REQUEST_CHANGES (spir-945:276, pir-841:33, pir-819:104, pir-1066:125). The parseVerdict COMMENT fallback is at pir-1473:691; its follow-up was deliberately not filed (pir-1473:738).
- Rollback resets all plan phases and replays old fix prompts (spir-1313:1331, :1598, :1630).
- The `chore(porch)` commit prefix contradicts protocol.md's commit rule (bugfix-1952:50 and 9 other F8 rows).
- Transition pushes are hard-coded to `origin` (spir-1216:9).
- `runCheck` reports "Timed out" whenever the timer fired (bugfix-1946:10, :20; checks.ts:115).
- `loadPromptFile` did not resolve `{{> }}` includes (pir-1011:92, :96).
- `porch next` hung on a `git push` child (spir-1401:169).

**Test or environment defects that blocked porch checks, not porch code:** #905 (bugfix-922), bugfix-1691 (pir-1920:16), #1800, #1923, #1925, #1946/#1947, #1956 (uncapped vitest workers).

### 4d. Excluded from the table, recorded so the exclusions can be checked

- **Builder-run BUGFIX and AIR later rounds that found real defects.** They would be S-consult-loop if porch ran them.
  - Rows considered: bugfix-1515:243, bugfix-1982:68, bugfix-1992:69, bugfix-1455:162, bugfix-1922:63, air-1478:102, bugfix-1224:135, bugfix-1584:156, air-1900:89.
  - Also mentioned by readers: bugfix-1685, bugfix-1664, bugfix-1372, bugfix-1219 (4 rounds), bugfix-1519 (3), bugfix-1629 (3), bugfix-1264 (2).
- **Architect-requested re-runs, not porch:** pir-811:74 (PIR iteration 2 after architect reconsideration; "single-pass — no automatic re-review", :77), the pir-1011 iteration-2 round, spir-1049:78, pir-1365:170, pir-1118 (3 rounds at the pr gate).
- **Predicted or flagged, no incident:** air-1900:102 (`porch gate` does not set pr_ready_for_human), air-1900:104 (approve runs optional checks), bugfix-966:39 (a node-ABI problem "will block" the check).
- **Deduplicated:** pir-1494:99 is the architect's account of the pir-1070:170 event, which is the row.
- **Human send-backs at gates** (the review would happen without porch): spir-1940:59, bugfix-1224:82, bugfix-1681:119, pir-920:33, pir-1118:32.
- **Neither save nor cost:** spir-1338:374-378. After a resume, porch emitted a fix task already done.

## 5. What these records cannot show

1. **Events that were never written down.** Threads are builder self-reports. A check that passes, a review round that finds nothing, a gate that holds quietly, and a refresh that works leave little or no trace.
   - spir-1470:633 missed a force-advance notice because the builder filtered porch output.
   - spir-1797:23 and :46 and spir-1951:86 lost refresh tasks that were never captured.
   - Saves are therefore under-recorded for F2, F5, F6 and F7. Costs that a builder chose to complain about are over-represented.
2. **Whether a human stood behind an approval.** A builder thread sees only the relay ("Architect approved"). Porch records approved_at but not approved_by (#1457). §4a's borderline cases cannot be resolved from threads; the architect sessions and status.yaml commit authorship would be needed.
3. **Who ran a review round.** Many threads do not say whether porch or the builder emitted a later round (spir-945 spec rounds, aspir-1273, spir-1797's review phase, aspir-1210). That is why 24 S-consult-loop rows are borderline.
   - Even a clear S-consult-loop shows that a second round caught something, not that only porch would have run it.
   - Soft and no-porch work in §4b ran rounds 2-4 without porch and they also caught defects. That evidence is thin: one spir-1313 stretch and four task builders.
4. **Real failure or false failure.** Porch truncated failed-check output until #1853/PR #1964, so most C-check calls ("unrelated", "load") rest on the builder's own reruns. A check failure that was in fact real could be misfiled as C-check.
5. **The time window.** The first thread is from 2026-05-22. Porch incidents before then, including the period when porch's gates and loop were designed, are absent.
   - Thread-writing discipline varies: some threads are 14 lines, spir-1313 is about 2,000.
   - 8 threads give 40% of the rows.
6. **Denominators by protocol.** Only 28 SPIR/ASPIR threads can produce S-consult-loop or force-advance rows. PIR (121) and BUGFIX (114) threads mostly produce F3 check rows. Comparing kinds across functions without these denominators misleads.
7. **The filter.** It misses consult rounds that never say porch, rebuttal or gate (bugfix-1515's rounds matched only via "INVESTIGATE"). It also missed 3 soft-mode threads, read here by hand.
   - 11 unmatched AIR/BUGFIX threads were not read.
   - Its "gate" term over-matches ("investigate", "render-gate").
8. **No counterfactual.** A save shows that porch stopped something; it does not show that CI, the architect or the human would not have stopped it next. Examples: most S-check rows are skill-hash tests that CI also runs, and pir-1354:79's type error was caught by review.
9. **Overlap with other sources.** Some rows restate what status.yaml or rebuttal files record mechanically (force_advanced records; spir-1252:362's 0-of-48 all-APPROVE finding). Summing across sources double-counts these.
10. **Inter-reader consistency.** Eight readers classified the bins under one fixed brief, and their output was reconciled to the §1 rules afterwards. Borderline-versus-clear calls may still differ slightly between bins. Every quote and line was re-verified mechanically.
