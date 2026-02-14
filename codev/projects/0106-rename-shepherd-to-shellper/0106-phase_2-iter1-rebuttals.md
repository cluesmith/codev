# Phase 2, Iteration 1 Rebuttals

## Disputed: Phase 2 deliverables are not implemented (Codex)

This is the same false positive seen in Phase 1 iteration 1. Codex's review methodology uses `git diff --name-only main` which only examines committed diffs. In the SPIR builder workflow, implementation changes are staged in the worktree but **not committed until porch advances past consultation**. The Phase 2 documentation updates exist in the worktree:

**Evidence — all six deliverables are complete:**

```bash
# grep -ri shepherd in all six living doc files returns ZERO hits:
grep -ri shepherd codev/resources/arch.md                           # 0 hits
grep -ri shepherd codev-skeleton/resources/commands/agent-farm.md   # 0 hits
grep -ri shepherd codev-skeleton/protocols/maintain/protocol.md     # 0 hits
grep -ri shepherd README.md                                         # 0 hits
grep -ri shepherd INSTALL.md                                        # 0 hits
grep -ri shepherd MIGRATION-1.0.md                                  # 0 hits

# Build passes:
npm run build  # ✅ success
```

All six files were updated via sed replacement in the worktree. The changes are real and verifiable but invisible to `git diff main` because they haven't been committed yet — that's by design in the porch workflow.

## Disputed: Phase 2 verification evidence is missing (Codex)

Verification was performed and passed. The grep and build checks described in the plan were executed successfully. Again, this evidence exists in the worktree/session but not in the git diff that Codex examined.
