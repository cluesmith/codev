# 1797 review iter1: rebuttals

## Codex (REQUEST_CHANGES)

1. **Change detection ends before the draft review.** Accepted and changed (9e87ce164). After the review, the tree is re-snapshotted against the post-session state with no file eligible to change, so any change made by a reviewer is named under "Changes made while the reviewers ran" and makes the exit non-zero. That covers an edited draft (marked as validated against the earlier version), source edits, HEAD and the index. Reviewer verdicts still never change the exit code. New tests: a draft edit during the review, a source edit plus commit during the review, and a clean review leaving exit 0.
2. **Branch behind `main`.** Changed: `origin/main` merged (1f0983796); the full suite after the merge has 6384 passed and `tsc` is clean.
3. **`d15693931` commit format.** Not changed. It is a declared side fix unrelated to the spec (`test(cloud-config): … (unrelated to Spec 1797)`), recorded as such in the review doc and the thread log. It is pushed, and history is not rewritten.

## Claude (APPROVE): non-blocking items, all taken

- Trailing `-->` false positive in `missing-guidance`: fixed, with a test (9e87ce164).
- Git digest fence escape: the digest is wrapped with `fenceFor`, with a test (9e87ce164).
- Stale base: merged.
- Floating `mergeConflicts()` under `-y`: left as is; `spawnAgentProcess` never rejects, and the shape is the one it replaced.

## Also in this iteration (main's integration review round 1)

fd450a757 (symlinked governance files lstat-curated and hashed through the link; starter templates pinned), a7a469edc (adopt exits 0 after a successful adoption), d42fc36b3 (`lib/agent-process.ts`, `CONSULT_OWNED_PREFIXES` in `lib/tree-snapshot.ts`, lazy `bootstrap-docs` load). Real-repo run 2 on the final code is recorded in the review doc.
