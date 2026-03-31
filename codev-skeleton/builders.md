# Active Builders

> **Note**: Builder status is now tracked automatically via SQLite database and the Tower dashboard. Use `afx status` to check all builders. This file is retained as a reference for status values only.

## Status Values

- **spawning**: Worktree being created, terminal starting
- **implementing**: Builder is working
- **blocked**: Builder waiting for architect input
- **pr**: Builder has created a PR
- **complete**: PR merged, ready for cleanup

## Commands

```bash
afx status              # Check all builder statuses
afx spawn <id>          # Spawn a new builder
afx cleanup -p <id>     # Clean up a completed builder
```
