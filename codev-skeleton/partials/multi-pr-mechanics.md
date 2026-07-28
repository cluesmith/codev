### Multi-PR Mechanics (when the architect requests sequential PRs)

Your worktree is persistent — it survives across PR merges. When the architect asks for sequential PRs (e.g., to slice a large spec into shippable pieces), use this loop:

1. Cut a branch, open a PR, wait for merge
2. After merge: `git fetch origin <integration-branch> && git checkout -b <next-branch> origin/<integration-branch>` — where `<integration-branch>` is the branch the architect targets PRs at (usually `main`; check the open PR's `baseRefName` if unsure)
3. Continue to the next slice, open another PR
4. Repeat

**Important**: Do NOT run `git checkout <integration-branch>` — git worktrees cannot check out a branch that's checked out elsewhere. Always branch off `origin/<integration-branch>` via fetch.

Record PRs in status.yaml: `porch done {{project_id}} --pr <N> --branch <name>`
Record merges: `porch done {{project_id}} --merged <N>`