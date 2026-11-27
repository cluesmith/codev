# Experiment 1989 — History: what the record on `main` shows porch doing

This is part of experiment #1989. The counting rules are in `notes.md`. They were fixed before
any case was read: the eight functions F1–F8, the save kinds (`S-*`), the cost kinds (`C-*`), and
what is not counted. This file counts saves and costs per function, says how each count was
sampled, and cites a file, line or issue for each case. It ends with what the record cannot show.

It draws no conclusion about strict against soft mode, and makes no recommendation. That finding
comes later, from the controlled run.

---

## 1. Sources, denominators and sampling

Base: `main` at `ab0fa50a9` (2026-11-26).

| Source | Population | What was read | How |
|---|---|---|---|
| `codev/projects/*/status.yaml` | 365 files (377 project directories; 12 hold only rebuttal files) | All | Parsed by script (section 9) |
| Git history of those files | 3,953 commits: 3,617 porch's own `chore(porch)`, 270 merges, 66 others | All 66 others, diff by diff | `git log` / `git show` |
| `codev/projects/*/*rebuttals.md` | 390 files in 92 directories, one per review round that porch closed with a rebuttal | Counted all; 40 read in full | Seeded random sample (`data/rebuttal-sample.txt`) |
| `codev/state/*_thread.md` | 320 threads, the first added 2026-05-22 | 309 read: the 306 the filter matched, plus 3 soft-mode threads it missed. 11 AIR/BUGFIX threads not read | Keyword filter, then reading around every match |
| `codev/reviews/*.md` | 285 reviews (`notes.md` said 287; 3 of the 288 files are images) | All 249 the filter matched. The 36 unmatched were grepped for approval, bypass and skipped review: no hits | Keyword filter, then reading around every match |
| GitHub issues | 311: every issue matching `gh issue list --search porch --state all`, which includes all 47 labelled `area/porch` | All 311 bodies; comments where the body was unclear | Every issue put in one bucket |

The filter for threads and reviews was `porch|status\.yaml|force.?advance|VERIFICATION REQUIRED|a-human-explicitly|gate|wedge|stuck|timed? ?out|timeout|roll(ed)? ?back|hand.?edit|--resume|check(s)? fail|rebuttal`
(reviews also `max.?iteration`), case-insensitive.

**Who read what, and how it was checked.** The threads, reviews and issues were read by reader
agents working from the rules in `notes.md`. Each returned a table of cases, with a verbatim quote
for every case. This builder then re-checked those tables mechanically:

- all 101 issue quotes are exact substrings of the issue bodies, fetched again;
- all 245 review rows and all 280 thread rows quote their cited line character for character;
- every case named in the text below was also read in its file.

The full per-case tables are kept in `data/`: `threads-cases.md`, `reviews-cases.md` and
`issues-cases.md`. They give every counted case with its file:line or issue number. The status-file
and git counts were run by this builder.

**Rules the readers applied on top of `notes.md`.** These were fixed before counting, and they
narrow the rules; they do not change them:

- `S-consult-loop` counts only a porch-run round at iteration 2 or later that found a new real
  defect which was then fixed. First-round findings are not counted, because a builder without
  porch also runs a first round. BUGFIX and AIR rounds are not counted: those protocols have no
  porch review loop, and the builder runs `consult` itself. PIR's porch review is one round, so
  PIR cannot produce this kind.
- `S-gate` needs the record to show that the gate's hold caught something real. A human sending a
  PR back at a `pr` gate is not counted, because that review happens with or without porch.
- In threads, a gate recorded as "approved by the architect" with no human named is a borderline
  F2 `C-bypass`. A builder's thread sees only the relay, so it cannot say whether a human decided.
- Each incident is one row. The same porch defect hitting different projects is one row per
  project.

**Do not add the columns across sources.** One incident can appear in a thread, a review and an
issue. The sources answer different questions:

- threads and reviews record incidents during work;
- issues record defects someone chose to file;
- status files and git record what porch wrote.

---

## 2. Totals

Saves and costs per function and source. Clear counts first, borderline counts in brackets.
Issues are counted per issue, and none recorded a save.

| Function | Threads: saves | Threads: costs | Reviews: saves | Reviews: costs | Issues: defects |
|---|---|---|---|---|---|
| F1 State machine | 0 (8) | 10 (16) | 2 (3) | 11 (7) | 33 |
| F2 Human gates | 0 (4) | 3 (14) | 0 (29) | 0 (2) | 1, and 5 gate incidents (section 4) |
| F3 Phase checks | 6 (3) | 44 (20) | 0 (0) | 30 (14) | 14 |
| F4 Consultation | 54 (25) | 15 (24) | 46 (27) | 20 (26) | 17 |
| F5 Prompt delivery | 0 (0) | 0 (2) | 0 (0) | 0 (1) | 13 |
| F6 Queryable state | 0 (1) | 0 (2) | 0 (1) | 2 (1) | 7 |
| F7 Context refresh | 0 (0) | 0 (4) | 0 (0) | 2 (3) | 2 |
| F8 Records | 0 (3) | 4 (18) | 0 (2) | 3 (2) | 9 |
| **All** | **60 (44)** | **76 (100)** | **48 (62)** | **68 (56)** | **96** |

- **Threads:** 280 rows from 93 threads. Eight threads give 113 of them; spir-1313 alone gives 21
  (`data/threads-cases.md` §3c).
- **Reviews:** 234 rows from 105 files. Seven reviews give 67 of them (`data/reviews-cases.md` §6).
- **Issues:** 96 defect issues, which are 78 distinct defects once duplicates are merged
  (`data/issues-cases.md` §2). 65 are open, 31 closed. 88 were seen in a real run, 8 were found by
  reading code. A human or architect had to step in on 34; on 23 the issue says no one did; 39 do
  not say. The other 210 issues are 22 feature requests and 188 incidental mentions.
- **Kinds with no case in any source:** `S-prompt` and `S-refresh`. `S-consult-skip` has a single
  borderline case. "VERIFICATION REQUIRED", the message porch prints when a review file is
  missing, appears in no thread and no review.

---

## 3. Function by function

### F1 — State machine

**Saves.**
- No clear save in the threads. The 8 borderline ones are builders using porch's state to resume
  at the right iteration after a pause or a kill. Examples:
  - `codev/state/spir-1313_thread.md:439`: after a resume, porch showed phase 4 at iteration 2, so
    the builder re-verified instead of re-implementing;
  - `codev/state/spir-1401_thread.md:179`: after the builder killed porch's own hung process,
    porch resumed at implement iteration 2 with nothing lost;
  - `codev/state/spir-1470_thread.md:1653`: in a live test, porch recovered a consultation that
    had died when the context was cleared.
- Two clear saves in the reviews:
  - `codev/reviews/0104-custom-session-manager.md:40`: a builder survived four context
    compactions by re-reading `status.yaml` and the git log;
  - `codev/reviews/1470-automatic-builder-context-refr.md:104`: the same recovered consultation
    as above.
- Issues #829, #831 and #1233 say in general terms that porch's state lets a respawned builder
  return to the right phase, but name no event.

**Costs.** 33 defect issues: 16 `C-state`, 8 `C-wedge`, 7 `C-other`. The recurring ones:

- **`afx spawn --resume` reset a finished project to `specify`** with all gates pending (#217,
  fixed by #218).
- **`status.yaml` read from the wrong worktree** (#1235, #1593, #1703). Approvals landed on another
  lane's branch while the owning gate stayed pending.
- **`porch <command> --help` ran the command** (#1259, #1539, #1762). In #1762 it advanced a
  project `pr → verified` and pushed the change.
- **Plan phases were wiped or lost:**
  - `verify-approval` on SPIR 1280 reset all 11 plan phases to `pending` (#1408);
  - ASPIR's plan → implement path never filled in `plan_phases`, so implement ran once instead
    of per phase (#697, which was observed; #1503, found by reading code and fixed by #1528);
  - plan phases cannot be re-scoped after the plan changes. #1135 wedged until the architect
    authorised a hand edit; see also #954 and #1900.
- **Porch waits to be called and never prompts** (#1295, #1298). Builders drifted ahead of the
  recorded phase or sat idle at a boundary. One workspace ran a hand-rolled watchdog to nudge them.
- **Porch's state commits move the open PR's head and restart CI** (#1462, #1733, #1873). #1462
  "only broke because two architects independently traced it in the same minute and told the
  builder to stop writing".

The threads add 10 clear and 16 borderline costs, and the reviews 11 clear and 7 borderline. For
example, `codev/reviews/0101-clickable-file-paths.md:107`: "Architect manually advanced
status.yaml after 7 iterations" to break a review loop.

**Hand repairs of porch state in git.** Of the 66 non-merge commits to a status file that porch
did not make, most are builders committing state that porch wrote. These are the ones whose
message or diff shows a hand repair:

| Commit | Date | What |
|---|---|---|
| `34e6443ee`, `e85794030`, `c3e73955a` | 2026-01-19 to 01-23 | Project 0074 state removed, reset, then deleted "so builder can create fresh" (the porch2 rewrite era) |
| `c7b504af1` | 2026-02-06 | 0092: phase set to `complete` and a gate marked approved, in a "Mark protocol complete" commit |
| `7f7e9ecb1` | 2026-02-12 | 0091's status file deleted inside the commit that added `--resume` |
| `bdf5efd82` | 2026-02-14 | "Remove stale 0106 porch state (PR already merged)" |
| `ec504c0ba` | 2026-02-15 | "Clean up porch state for completed builders 0110 and 0115" |
| `a0aaeeb3a` | 2026-02-15 | "Mark 0120 pr-ready gate as approved (PR already merged)": gate status and `approved_at` written by hand |
| `9c67aa862`, then `5d1273435`, `8d749b649`, `575d58f09`, `144feec19`, `edcc4f463` | 2026-08-01 to 08-06 | Spec 1280: plan phases "gated by architect inspection rather than 'porch done'", pointer advanced by hand with the owner's authorisation, one phase per commit |

That is 14 commits across 8 projects. Eight of them are from before 2026-02-17, when
`porch rollback` was added (`6231dfc6a`, #401). Since then, the only hand repair visible in git
is Spec 1280's run outside porch. Repairs made through porch commands (`rollback`, a `git revert`
of porch's commit as in #1735) or in a worktree that never reached `main` do not show here.

### F2 — Human gates

See section 4, which covers this function across all sources.
- **Saves:** none clear in any source.
- **Costs:** one defect issue, #1457: gate records keep `approved_at` but not `approved_by`.
  Five gate incidents. The threads give 3 clear and 14 borderline costs, the reviews 2 borderline.

### F3 — Phase checks

**Saves.**
- Six clear in the threads, in six threads. Five of the six are the same kind of defect: a shipped
  skill was edited without regenerating its hash or its parity copies. The cases are
  `codev/state/air-1893_thread.md:14`, `air-1900_thread.md:49`, `bugfix-1853_thread.md:63`,
  `bugfix-1871_thread.md:94` and `bugfix-1921_thread.md:17`, all under `codev/state/`. The same
  tests run in CI.
- The sixth is `codev/state/spir-1252_thread.md:489`: a baseline counted the project's own
  verdicts.
- None in the reviews. The one review case where a check should have caught a defect is a miss:
  `codev/reviews/1354-o-screen-replay-headless-termi.md:70`. The build check ran on the working tree, while the pushed head failed
  `tsc`.

**Costs.** This is the largest cost class in the threads and reviews:
- threads: 44 clear and 20 borderline, of which 42 clear are `C-check`, across 31 threads;
- reviews: 30 clear and 14 borderline;
- issues: 14 defects, 10 of them `C-check`.

The causes:
- **Machine load from builders running their suites at the same time.** For example,
  `codev/reviews/1940-tower-to-tower-messaging-proto.md:388` (#1956) and #1892: "concurrent heavy checks drove load to 35 and
  failed runs".
- **Pre-existing or flaky tests.** The reviews name nine projects (`data/reviews-cases.md` §3).
- **Environment and setup**, such as a missing `node_modules`, the wrong working directory or npm
  config.
- **Timeouts that did not end the check:**
  - #1706: `porch done` hung for "80+ minutes on a turbo build child";
  - #1752: blocked "for over 11 minutes, well past the 5-minute timeout";
  - #1814: a fixed 5-minute cap killed a 239-second suite four times in one afternoon.
- **Failed-check output that hid the failing test** (#1801, #1853, fixed by #1964). One builder
  "spent eight manual full-suite runs (all green)" before finding the test (#1801).
- **Checks that cannot fail, or cannot run:**
  - the `e2e_tests` check ends `|| echo 'e2e tests skipped (not configured)'` and so always
    passes (#1488; `codev-skeleton/protocols/air/protocol.json`, `pr` phase);
  - the `on_fail` and `max_retries` fields declared in `protocol.json` are never read by porch
    (#1895);
  - the npm-only default checks blocked a Python project (#1069).

In this repository the `build` and `tests` checks run only in `packages/codev`, and `e2e_tests` is
switched off (`.codev/config.json`). Changes to the VS Code extension or the dashboard are
therefore not checked by porch. The reviews note this four times as borderline, with nothing
recorded slipping through.

### F4 — Consultation

**Saves.** This is the largest save class:
- threads: 54 clear and 25 borderline. The 54 clear ones come from 18 threads, all SPIR or ASPIR,
  out of the 28 SPIR and ASPIR threads that could produce one;
- reviews: 46 clear and 27 borderline;
- issues: none.

**The rebuttal sample.** 40 of the 390 rebuttal files, drawn at random and read in full:
- 39 record the builder accepting at least one point and changing the artifact or the code;
- 1 rejected every point (`codev/projects/0118-shellper-multi-client/0118-phase_1-iter2-rebuttals.md`);
- 38 of the 39 accepted at least one substantive defect (a bug, a wrong claim, a missing
  requirement or a security issue). 32 of those were more than minor.

Examples from the sample:
- `clearRuntime()` deleted every workspace's builders from the shared database
  (`codev/projects/1118-consolidate-state-db-tables-in/1118-review-iter1-rebuttals.md:10`);
- a one-character nonce still got past a freshness gate
  (`codev/projects/1470-automatic-builder-context-refr/1470-phase_3_selfrefresh_core-iter3-rebuttals.md:12`).

Two qualifications apply to the sample:
- **A rebuttal file does not always mean a reviewer asked for changes.** 5 of the 40 record no
  REQUEST_CHANGES from any working reviewer: three were COMMENT-only rounds, one was all APPROVE,
  and in one the only REQUEST_CHANGES was a skipped Gemini lane that porch read as
  REQUEST_CHANGES (`codev/projects/819-core-parsearealabels-helper-fl/819-review-iter1-rebuttals.md:5`).
- **Most files show the first round, not porch's iteration.** Only 11 of the 40 are from round 2
  or later. 10 of those 11 record a substantive defect accepted.

At the 3-round review limit, porch moves the phase on even if reviewers still ask for changes. It
records this as `force_advanced`, which 10 projects carry on `main` (`grep -l force_advanced codev/projects/*/status.yaml`):
1049, 1286, 1307, 1313, 1401, 1470, 1595, 1658, 1797, 1951.

**Costs.**
- Issues: 17 defects, 9 `C-wedge` and 5 `C-bypass`.
- Threads: 15 clear and 24 borderline.
- Reviews: 20 clear and 26 borderline.

The recurring causes:
- **Fixes left unreviewed after the limit.** #1793: "A manual review of each unreviewed last fix
  found **1 blocker and 5 new majors**". In the reviews, by project and line:
  `codev/reviews/1286-consult-configurable-per-lane-.md:9`,
  `1307-arch-save-packaged-save-clear-.md:140`, `1313-afx-send-mailbox-first-delivery.md:312`,
  `1797-adopt-bootstrap-the-governance.md:116`, and `1951-read-only-pr-check-for-archite.md:240`
  and `:392`. In 1307 a confirming round outside porch then found real defects
  (`data/reviews-cases.md` §3).
- **Wrong text at the limit.** #1996: "All reviewers approved!" printed above two REQUEST_CHANGES
  verdicts, with the wrong round number.
- **The review loop skipped entirely.** #1997: `porch done` requests the gate without reading
  verdicts, so "a builder reaches the human gate after one review round in which every reviewer
  said REQUEST_CHANGES".
- **Verdict handling.**
  - In older porch a missing verdict counted as REQUEST_CHANGES and drove extra rounds, for
    example #295 (fixed by a hand edit of `status.yaml`) and #1033.
  - In current porch a missing verdict counts as COMMENT, and COMMENT counts as approval: see
    `packages/codev/src/commands/porch/verdict.ts:46` and `allApprove` at `:57-59`. Since `:58`
    approves an empty review list, a lane that never ran can pass as an approving reviewer
    (#1166, #1656).
- **Loops that could not end:**
  - the round limit was dead code until #870 (fixed by #871);
  - a review phase that cannot run once the PR has merged (#1271);
  - a lane roster that keeps lanes the policy has removed (#1291, #1294, #1736).

### F5 — Prompt delivery

**Saves.** None in any source.

**Costs.** Issues: 13 defects, 12 of them `C-text`.
- **The `verify` task says "Step 1: Merge the PR" before the `pr` gate** (#1791, #1863). All the
  builders affected noticed and did not merge.
- **Phase prompts told builders to read framework files** by a `codev/` path that fresh installs
  do not have (#1011, fixed by #1015).
- **`{{issue.number}}` was never filled in** (#1379).
- **The task for phase `phase_2b` embedded the text of Phase 2** (#1881).
- **The PIR prompts disagreed with porch** about reviewers and gates (#1903, fixed by #1904).

The threads give 2 borderline costs and the reviews 1 borderline. Defects in protocol text that a
builder without porch would read anyway are not counted as porch's (`data/issues-cases.md` §4,
tag `protocol-content`).

### F6 — Queryable state

**Saves.**
- One borderline in the threads: another project's `status.yaml` showed a test was still a live
  guard (`codev/state/spir-1313_thread.md:1688`).
- One borderline in the reviews: a `codev check pr` catch (`codev/reviews/1951-read-only-pr-check-for-archite.md:108`).

**Costs.**
- Issues: 7 defects.
  - `porch pending` was documented but not implemented (#711, fixed by #714). Later it listed
    "**810 gates pending approval**… None are live asks" (#1759, fixed by #1760).
  - `porch status` could not find a project from the main checkout (#622, fixed by #643).
  - Same-numbered projects hid each other (#1698).
- A further 16 issues are bugs in Tower, the dashboard or VS Code reading porch state that was
  itself correct. They are tagged incidental, not counted (`data/issues-cases.md` §4).

### F7 — Context refresh

**Saves.** None in any source.

**Costs.** Nine status files carry a `context_refreshes` record.
- Issues: 2 defects.
  - #1529: a refresh boundary could read as acknowledged before the clear ran.
  - #1758: the boundary was marked consumed although the refresh never ran. "Both occurrences
    needed an architect to notice and direct a manual builder-refresh."
- Threads: 4 borderline costs.
  - `codev/state/spir-1797_thread.md:23`, `:46` and `spir-1951_thread.md:86`: refresh tasks
    the builder never captured.
- Reviews: 2 clear and 3 borderline costs.

### F8 — Records

**Saves.**
- Three borderline in the threads. For example, `porch done --merged` refused because no PR was
  recorded, so the builder recorded it (`codev/state/spir-1951_thread.md:448`). And
  `codev/state/aspir-1286_thread.md:753`: the `force_advanced` record exposed a builder's false
  "all approved unanimously" claim.
- Two borderline in the reviews.

**Costs, from the status files themselves:**

- **The merge is rarely recorded.** 27 of 365 status files record a merge (`pr_history[].merged`).
- **Merged projects still show the `pr` gate pending.** 57 real projects (excluding this project
  and a task builder's file) show it pending on `main`. Every one of those 57 PRs merged; the list
  with PR numbers is in `data/pending-pr-gate-check.txt`. A status file reaches `main` through
  its own PR, so it cannot record that PR's approval or merge unless a later commit carries it.
- **A task builder's status file landed on `main`:**
  `codev/projects/builder-task-nhnj-task-NHnJ/status.yaml`, created 2026-08-12 (`0cc35cca2`),
  with three gates pending.

**Costs, from issues:** 9 defects.
- #1229: "**106 of 179 projects on main (59%) have `status.yaml` stranded in a non-terminal
  phase**", and repairs had to be made by hand.
- #1446, #1367 and #1732: post-merge commits stranded on the merged branch.
- #532: `afx cleanup` deleted completed projects' records (fixed by #534).
- #1719: `status.yaml` said a phase was complete beside REQUEST_CHANGES verdicts, and two reviewers
  misread it.

**Costs, from threads:** 4 clear and 18 borderline. Most are `chore(porch)` commits drawing
review objections, or records stranded after a merge.

The status files kept on `main` "for analytics" have, in the code today, one reader: the Spec 1252
metrics script. See `consumers.md` section 7.

---

## 4. The property that matters most: a gate passed without a human decision

This section brings together every source on this one question. A gate passed without a human
decision is the failure that porch's `--a-human-explicitly-approved-this` flag exists to prevent.

**What porch's check is.**
- `approve()` refuses only when the flag is missing (`packages/codev/src/commands/porch/index.ts:792-801`).
- Its error message prints the full command, flag included (`index.ts:798`).
- It records `approved_at` and not who approved (#1457).

So the flag records that whoever ran the command claimed a human approved. It cannot check that
claim, and the record cannot show it afterwards (`codev/reviews/1494-vscode-approval-gates-should-r.md:105`).

**Issues: five gate incidents** (`data/issues-cases.md` §3):

| Issue | What happened | Porch's part |
|---|---|---|
| #849 | An architect in an adopter workspace ran `porch approve <id> pr --a-human-explicitly-approved-this` on three PR gates in a row "with no explicit user authorization for any of the three merges" (2026-05-25) | The flag was typed; nothing stopped it |
| #1272 | `porch verify --skip`, then `porch done`, completed a SPIR project with `verify-approval` never requested and still pending. A builder caught it | Porch at fault |
| #583 | An adopter's SPIR builder said "The user has approved the spec" when no one had (codev 2.1.1) | Not established |
| #401 | Porch skipped `spec-approval` for Spec 399 because the spec carried approval frontmatter. The issue says this would have needed undoing "if the architect made a mistake (pre-approved something the human hasn't actually reviewed)" | By design; whether the approval was wrong is not stated |
| #1543 | In July 2026 a stray "gate approved / run porch next" message reached a builder, which "advanced in good faith on an approval no human gave". It was caught and rolled back | Messaging, not porch; thin (one table row) |

**Threads** (`data/threads-cases.md` §4a):
- **No clear case** of a gate passed while the record says no human decided.
- **9 borderline cases where the architect is the only approver named:**
  - `codev/state/spir-1313_thread.md`, three gates (`:44`, `:121`). At `:985` the architect said
    "I'll approve the pr gate directly when it's clean", and at `:991` it did.
  - `codev/state/spir-927_thread.md` (`:71`, `:123`). `:123` follows `:78`'s "Do NOT advance past
    plan-approval without the human."
  - `codev/state/pir-809_thread.md:12`, `pir-1428_thread.md:65`, `air-1357_thread.md:43` and
    `spir-1819_thread.md:183`.

  A builder's thread cannot show whether a human stood behind these.
- **The flag used on relayed words that named a different gate.**
  - `codev/state/pir-1070_thread.md:170`: the architect relayed "yes I approved dev-approval,
    merge it", and the builder ran `porch approve 1070 pr`.
  - A human had decided to merge. The architect later called it "structural guarantee BYPASSED —
    porch state produced from prose typed into a builder's pane" (`codev/state/pir-1494_thread.md:99`).
- **No thread records the flag stopping an approval that lacked a human.** Two threads record
  porch requiring it (`codev/state/spir-1280_thread.md:354`, `codev/state/air-1489_thread.md:99`).
  Both times the approval was a real human decision, relayed.
- **Builders refused to self-approve:**
  - `codev/state/aspir-1273_thread.md:347`: "Not approving it myself", although its brief said
    the merge was "pre-granted" (`:14`);
  - `codev/state/spir-778_thread.md:121`: "I did NOT self-approve";
  - also `codev/state/spir-1313_thread.md:40`, `spir-1280_thread.md:127` and `:1392`, and
    `aspir-1210_thread.md:86`.

  These are builders holding the line, not porch refusing.

**Reviews** (`data/reviews-cases.md` §4a):
- **No clear `S-gate`.** The 29 borderline cases are each a human finding a real defect while
  porch held a dev-, plan- or spec-approval gate. For example,
  `codev/reviews/1047-tower-terminals-architects-bui.md:64`: while dev-approval held, the human
  caught that the new byte caps blanked full-screen terminals, and the caps were dropped.
- **Four gate-without-human rows:**
  - 0078 added `PORCH_AUTO_APPROVE` for end-to-end tests. Today it exists only in the e2e test
    runner, `packages/codev/src/commands/porch/__tests__/e2e/runner.ts:175`.
  - 1494, the pir-1070 event above.
  - 809 and 1869, which name an architect as approver.

**Not visible in any source:**
- gate passes nobody noticed;
- who typed any given `porch approve`;
- whether "architect approved" was relaying a human.

All five issue incidents were caught after the fact, by a human or a builder.

---

## 5. Work recorded without porch orchestrating it

These are facts from the record, given for context. They are not a comparison: the record holds
few such cases, none designed as one.

**Soft-mode builders in the threads** (`data/threads-cases.md` §4b):
- **Experiments that recorded no model review:** experiment-1782 and experiment-1560.
  experiment-1560 still recorded a porch gate approval (`codev/state/experiment-1560_thread.md:45`).
- **Task builders that recorded no model review:** task-_205 and task-24AO. task-_205 relied on CI
  rather than running the tests itself.
- **Task builders that ran their own codex and claude reviews:** task-SVsf, task-47B5, task-yr9D,
  and task-H71_ inside bugfix-1455. Those reviews found real defects, which were fixed.
- None of the soft builders recorded a gate.

**Strict projects working outside porch:**
- spir-1313 after its rollback (`codev/state/spir-1313_thread.md:1331-1505`). The builder ran
  review rounds 1–4 itself, and rounds 2–4 each found new real defects.
- Spec 1280, where the architect inspected plan phases instead of porch
  (`codev/reviews/1280-prompt-surface-judgment-not-ru.md:48`, and the git table in section 3).
- Spec 1658's Amendment 2, five phases run while porch stayed parked at the `pr` gate
  (`codev/reviews/1658-windows-native-non-wsl-support.md:117`).

**Reviews from before porch existed** (37 reviews predate porch's first commit, 2026-01-18):
- 0001 skipped consultation twice and needed rework (`codev/reviews/0001-test-infrastructure.md:40`).
- 0009 merged untested and broken (`codev/reviews/0009-terminal-file-click.md:125`).
- 0073, the project that built porch, skipped consultation at first
  (`codev/reviews/0073-porch-protocol-orchestrator.md:65`).
- Several pre-porch reviews credit consultations that caught real defects, for example
  `codev/reviews/0005-typescript-cli.md:102` and `codev/reviews/0019-tab-bar-status-indicators.md:107`.

---

## 6. Against the expectation in `notes.md`

`notes.md` stated, before reading, what the history should show if porch still earns its place.
This section checks that expectation against the counts. It is not the experiment's finding.

| Expectation | What the record shows |
|---|---|
| F2 saves recorded, outnumbering costs | **Not shown.** No clear F2 save in any source. The borderline saves are humans finding defects while a gate held. The gate incidents and borderline costs outnumber them. |
| F4 saves recorded, outnumbering costs | **Shown in threads and reviews** (54 and 46 clear saves against 15 and 20 clear costs). Issues record 17 F4 defects and no save. The saves show that later review rounds catch real defects; whether only porch makes those rounds happen is not something the record can show (section 5). |
| F3 shows saves | **Few.** 6 clear saves in threads, 5 of them one defect class that CI also tests, and none in reviews. Costs are the largest class in both. |
| F5 and F7 show few saves of their own | **Shown.** None in any source. |
| F1 shows costs | **Shown.** 33 defect issues, plus costs in threads, reviews and git. |

---

## 7. What these records cannot show

- **Things that went right quietly.**
  - A check that passed, a round that found nothing, a gate that held without fuss, or a refresh
    that worked leaves little or no trace.
  - Issues record no saves at all: a refusal that worked is not filed.
  - So the record is biased toward costs, and the zeros for `S-prompt`, `S-refresh` and
    `S-consult-skip` may reflect what is written down, not what happened.
- **The counterfactual.** A save shows that porch, or a round porch ran, stopped something. It
  does not show that the builder, CI, the architect or the human would not have stopped it next.
  Most F3 saves are tests CI also runs.
- **Who approved.**
  - Porch stores no approver.
  - Commit authorship is the same name for builders and the owner: every commit here is authored
    "M Waleed Kadous".
  - Builder threads see only the relay.
- **Who ran a review round.** Many records say "CMAP" without saying whether porch or the builder
  started it. That is why many `S-consult-loop` rows are borderline.
- **Check failures.**
  - Failed-check logs are gitignored by porch
    (`packages/codev/src/commands/porch/checks.ts:476-479`), and status files do not record
    check results.
  - Before #1964, failed-check output was cut short. So most "unrelated failure" calls rest on
    the builder's own reruns.
- **Time.**
  - Threads start 2026-05-22, and the `area/porch` label on 2026-05-19.
  - Porch's earliest months are covered only by git, reviews and issues that use the word "porch".
- **Rates and weights.**
  - Counts are of cases and issues, not events. One issue may be a rate: #1229's 106 of 179, or
    #1759's 810 dead gates.
  - A security fix and a wording fix count the same, and so do an hour's wedge and a minute's.
  - Time and token cost are almost never recorded.
- **Denominators by protocol.** Only the 28 SPIR and ASPIR threads can produce a porch review-loop
  save or a force-advance. PIR (121 threads) and BUGFIX (114) mostly produce check rows. Comparing
  kinds across functions without this misleads.
- **Workspaces outside this repository.**
  - Many issues are field reports from adopter workspaces.
  - Their status files, threads and reviews are not on this `main`.
  - Their incidents are counted only as filed issues.
- **Soft mode.** The record has few soft-mode builds, and none set up as a comparison. That
  question is the controlled run's.

---

## 8. Data files

| File | What it holds |
|---|---|
| `data/threads-cases.md` | 280 thread cases with file:line, function, kind, clear/borderline and verbatim quote; counts; gate, soft-mode and defect lists; exclusions |
| `data/reviews-cases.md` | 234 review cases, the same columns; gate and soft-mode lists; the 40-file rebuttal table |
| `data/issues-cases.md` | All 311 issues bucketed; 96 defect and 5 gate-incident rows with a verbatim phrase each; duplicate clusters; reconciliation decisions |
| `data/rebuttal-sample.txt` | The 40 sampled rebuttal files |
| `data/pending-pr-gate-check.txt` | The 57 projects with a pending `pr` gate on `main`, each with its PR's merge state from GitHub |

## 9. Commands behind the mechanical counts

Run from the repository root at `ab0fa50a9`. YAML was parsed with PyYAML
(`uv run --with pyyaml python`).

```bash
ls codev/projects/*/status.yaml | wc -l                                   # 365
ls codev/projects/*/*rebuttals.md | wc -l                                 # 390
grep -l force_advanced codev/projects/*/status.yaml                       # 10 projects
grep -l -E '^approved:\s*true' codev/projects/*/status.yaml | wc -l       # 0 (see consumers.md §7)
git log --format=%h -- 'codev/projects/*/status.yaml' | wc -l             # 3953
git log --format='%h %s' -- 'codev/projects/*/status.yaml' | grep -c ' chore(porch)'   # 3617
git log --no-merges --format='%h %s' -- 'codev/projects/*/status.yaml' | grep -v ' chore(porch)' | wc -l   # 66
# gate status by protocol, merges recorded, pending gates: parse each status.yaml and read
# gates.*.status and pr_history[].merged; pending pr gates checked with `gh pr view <n> --json state`
# (or `gh pr list --search head:builder/<protocol>-<id>` where no PR number is recorded)
```
