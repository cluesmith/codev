# experiment-1989 thread

## 2026-11-27 — scope and start

Spawned soft, EXPERIMENT protocol, issue #1989 ("do we still need porch?"). The spec file the
spawn prompt names (`codev/specs/1989-experiment-do-we-still-need-po.md`) does not exist; the issue
is the brief.

The architect (porchless) narrowed this run on arrival: History and Consumers only. The controlled
strict-vs-soft run is the architect's and already under way. So: no comparison design, no spawns,
no contact with other builders, no porch command against another project, no builds or test runs,
no conclusions about strict vs soft, no PR, no experiment-complete gate. Deliverables: two
documents in `codev/experiments/1989-do-we-still-need-porch/`, committed and pushed, then stop.

Wrote `notes.md` first with the counting rules (what a save is, what a cost is, kinds, sources,
denominators) before reading any case, so the cases are scored against rules fixed in advance.

Reading split four ways (threads, reviews + a seeded sample of 40 rebuttal files, the 311 GitHub
issues that mention porch, and the consumer code sweep), done by background agents; every case they
return is re-checked in its file before it is cited. Mechanical counts on the status files and the
git history of `status.yaml` I ran myself.

Early mechanical facts worth knowing:
- 365 status files; only 27 record a merge; 57 real projects show the `pr` gate pending on `main`
  although every one of those PRs merged. The status file on `main` is a snapshot from the PR
  branch, so it cannot record its own PR's approval or merge.
- 390 rebuttal files (review rounds ending in REQUEST_CHANGES) across 92 project directories; 10
  projects hit the 3-round ceiling and were force-advanced.
- Of 3953 commits that touched a status file, 3617 are porch's own `chore(porch)` commits, 270 are
  merges and 66 are other commits; most of those 66 are builders committing state porch wrote. Explicit hand repairs are few and mostly from January
  and February 2026 (porch2 era), plus Spec 1280's owner-authorised pointer advances in August.
- `porch approve` checks only that the literal flag is present (`index.ts:792`), and its own error
  message prints the flag. It records a human decision; it cannot verify one.

## 2026-11-27 — History and Consumers drafted

Both documents are written: `codev/experiments/1989-do-we-still-need-porch/history.md` and
`consumers.md`, with the verified per-case tables in `data/`.

How the reading was checked: every quote the reader agents returned was re-checked by script.
All 101 issue phrases match freshly fetched bodies; all 245 review rows and 280 thread rows match
their cited line exactly. Every consumer file:line was printed and compared with its claim. A few
were off by a line or pointed at a brace, and those are corrected in `consumers.md`. Every case
named in the prose was read in its file. Two of my own errors were caught the same way: the
hand-repair table has 14 commits, not 15, and a duplicate line in the pending-gate data.

Things a future reader would want to know:
- Issues record no porch saves at all (96 defect issues, 78 distinct). Saves only show up in
  threads and reviews, and those are mostly F4 later-round review catches.
- No source has a clear F2 save. The clear gate incidents are in issues: #849, an agent typing
  `--a-human-explicitly-approved-this` on three gates with no user authorization, and #1272, porch
  completing a protocol with `verify-approval` never requested. Porch's flag check is presence
  only (`index.ts:792`). No thread or review records a clear one.
- F3 checks are the largest cost class in threads and reviews (load, flakes, timeouts that did
  not end the check, hidden failure output). The few clear saves are mostly one class
  (skill hashes) that CI also tests.
- Consumers: everything funnels through `overview.ts` `parseStatusYaml`. Soft builders still
  get `porch init`, and the overview marks any builder with a `status.yaml` as strict
  (`overview.ts:834`). So soft builders in the controlled run will show in the UIs as strict,
  their phase frozen, and they will not show a pending gate. Flagging this to the architect
  because it bears on reading their run.
- Dead consumers: `team update` gate events (0 of 365 files match its regex), the `afx cleanup`
  porch tidy prefix, `notifyGateHit` / `notifyBlocked`.

Stopped here as instructed: no PR, no experiment-complete gate, no strict-vs-soft conclusions.
