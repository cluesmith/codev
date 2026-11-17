# 1658 review (PR) iteration 1: dispositions

Head reviewed: f6458b7d5. Gemini skipped (agy exit 3).

## Codex (REQUEST_CHANGES)
All three points are the declared pr-gate conditions: claude ConPTY fixtures, the codex / #1858 scope (recorded as a known gap in the review; owner decision), and the owner's manual pass. None is a code change on this branch.

## Claude (REQUEST_CHANGES)
1. Root taskkill PID-reuse window (process-tree.ts): ADDRESSED. After a job round trip, the root is re-checked on a fresh census (present, same creation time) before `taskkill /T /F`. A census failure skips the tree kill. Test: "skips taskkill on the root when its pid was reused during the job round trip". Three job-path event expectations updated (one extra census).
2. Bare-name system binaries: ADDRESSED. `windowsSystem32Path` and `windowsPowerShellPath` live in lib/platform.ts. The census, job helper, CIM Tower launch, both port queries, taskkill and the CIM cmd.exe all use full paths. The broader class (bare git/gh with a worktree cwd) was raised with the architect, not expanded unilaterally.
3. POSIX CI pending: checked before the gate request.
4. WINDOWS_PREBUILD_NODE_ABIS fail-closed: REBUTTED, deliberate (no prebuild means no install; the message names the supported versions).
5. Gemini absent: recorded under Methodology Improvements.

## Also in this iteration (architect integration review round 1 must-fix items)
- readShellperInfo resolve-on-data gated to Windows; POSIX EOF read pinned by a test.
- sdk /node charter restated in packages/sdk/package.json and arch.md.
- #1858 recorded as a known gap in the review doc.
- jira recently-closed: a jq failure no longer reads as "nothing closed" (Windows run 39924678195 flake; the masking defect is fixed, the trigger is unproven).
