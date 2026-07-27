# Rebuttal — `worktree_local_config` iteration 1

## Gemini and Codex: real-filesystem snapshot coverage appeared absent

The required test already existed at
`packages/codev/src/agent-farm/__tests__/local-config-snapshot.test.ts`, but it
was untracked when Consult generated the iteration-1 changed-file list. It is
now committed in `b6203560` and verifies with real temporary directories:

- a regular-file (non-symlink) snapshot;
- participation in the normal `loadConfig()` local layer;
- refresh after both main-side and builder-side changes;
- repeated-sync idempotency and absence of temporary-file debris;
- main-source immutability; and
- absent-source preservation of a builder-local preference.

The mocked spawn tests are intentionally complementary: they verify that both
worktree creation paths call the same real helper before post-spawn hooks.

## Codex: setup-path filesystem proof

The existing committed `setup.test.ts` verifies the `afx setup` call ordering
(`symlinkConfigFiles` → `syncLocalConfigSnapshot` → `runPostSpawnHooks`). To
make the on-disk boundary explicit as requested, iteration 2 also adds
`setup-filesystem.test.ts`. It runs the real snapshot helper through the real
`setup()` command against temporary workspace/worktree directories, and its
post-spawn-hook observer proves the refreshed bytes are present before the hook
runs. It repeats the flow after both main and builder snapshots change.

## Claude: implementation and tests were uncommitted

This was legitimate delivery feedback. The approved Phase 1 implementation is
now committed as `8aa39bad`, and the Phase 2 implementation plus original tests
are committed as `b6203560`. Both previously untracked Phase 2 test files are
therefore included in the review diff. The additional setup-filesystem test is
committed with this response.

The four focused Phase 2 suites pass 90/90 tests.
