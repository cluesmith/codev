# Spec 1963 evidence (Codev Cockpit, PR #1971)

This branch holds the rendered-verification evidence for Spec 1963: screenshots, check results
(JSON), dashboard snapshots and the layout spike's screenshots. It is **never merged**. Evidence
binaries are kept out of `main`'s tree, and the PR branch links here by commit SHA.

The files were taken from `builder/spir-1963` at `98a7c2c17b5485590103cdae43df584d4c763cc7`, with `codev/projects/1963-vscode-alternative-layout-seco/` removed from their
paths. On the PR branch, `codev/projects/1963-vscode-alternative-layout-seco/verification.md` lists every check with its pass count and a
permalink into this branch.

| Folder | Run |
|---|---|
| `verification-increment1/` | Phase 5 (increment 1); `actions` and `reconnect` re-run in the review phase on the final code (see its README) |
| `verification-phase6/` | Phase 6: the dashboard before and after the shared-package extraction |
| `verification-phase7/` | Phase 7: the Decisions panel |
| `verification-phase8/` | Phase 8: the Work panel, Decisions re-run, the dashboard |
| `verification-phase9/` | Phase 9 and the review phase: Arrange Cockpit, activity-bar profiles |
| `layout-spike/` | The plan's layout spike (VS Code 1.147.0) |

Every screenshot here was read with OCR, and none shows a machine's shell prompt.

## The final-head run

The second commit on this branch replaces `verification-phase9/verify-arrange.json` and its 19
`arrange-*` screenshots. They now hold the `verify arrange` run on the PR's final head
`2780caa05297c4d027beb203836edb24b78818fe`, with the vsix built at that commit: 19/19, the shell-prompt check included
(2026-11-24T16:49Z). The first commit holds the same check names from the run on the same
extension code before the merge from main.
