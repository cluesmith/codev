# bugfix-1077 — agy auth-state pre-flight cache

Issue #1077: consult's gemini lane spawns `agy` before it can know agy is
unauthenticated. Each spawn opens an OAuth browser tab (upstream agy behavior),
so an N-wide CMAP burst strands N tabs. The existing `AGY_OAUTH_MARKERS` kill
fires *after* the tab is already open.

## Investigate

- Confirmed the code path: `packages/codev/src/commands/consult/index.ts`
  `runAgyConsultation` → `spawn(bin, args)` unconditionally; marker detection is
  in the stdout/stderr `watch()` handler, i.e. post-spawn (index.ts:834-873).
- Confirmed the amplifiers named in the issue:
  - CMAP-N dispatch emits one `consult -m <model>` process per model
    (`porch/next.ts:529-531`), gemini lane = 1 agy spawn per round.
  - Partial-review re-emit (`porch/next.ts:544+`) re-issues the same consult
    commands, so a malformed/racy gemini skip causes another agy spawn.
- `doctor.ts:472 verifyAgy()` probes agy on every `codev doctor` run — same
  tab-opening cost, separate entry point.
- Fix is cross-process, not in-process: each consult is its own OS process
  (`bin/consult.js`), so a module-level memo would not help. Needs a
  filesystem-backed cache + lock, as the issue proposes.
- agy credential path: not discoverable on this machine. `~/.gemini/antigravity-cli/`
  holds settings/state but no credentials/token file; nothing in the login
  keychain under "Antigravity". So mtime-based invalidation is best-effort over
  a candidate list, and the TTL is the real recovery window (the issue
  anticipates exactly this fallback).
- Scope: 1 new module + 2 integration points + tests. Well within BUGFIX.

### Reproduced

Fake unauthenticated agy (`CODEV_AGY_BIN` → script that logs each invocation,
then prints an `accounts.google.com/o/oauth2` banner on stderr like real agy),
5 parallel `consult -m gemini --prompt`:

```
=== AGY SPAWNS (== browser tabs): 5
```

All 5 correctly emitted the non-blocking COMMENT skip — *after* spawning. That
is the bug precisely: the semantics are right, the timing is too late.

### Detour: main's build was broken

`doctor.ts` imported `formatBytes` from two modules (TS2300), landed via PR #1243.
I fixed it locally to unblock, then the architect asked me to drop it — they are
shipping it as a separate fast PR. Reverted; will merge main once that lands.
My branch stays scoped to the auth cache.

### Design decision: the real run IS the probe

The issue proposes a dedicated `--print-timeout 5s` probe when the cache is cold.
Implemented instead: the lock holder's *real* consult run doubles as the probe,
publishing the auth verdict as soon as it is knowable. Rationale:

- No extra agy spawn per TTL window in the authenticated (common) case — a
  dedicated probe would mean probe-spawn + real-spawn.
- Reuses the already-tested `AGY_OAUTH_MARKERS` detection instead of duplicating
  marker logic in a second code path that could classify differently.
- Same observable guarantee the ACs ask for: at most 1 agy spawn per TTL window
  when unauthenticated.

Waiters poll the cache (they do NOT block on the lock, which the holder may hold
for minutes) and **fail open** — an undecided wait proceeds with the spawn. The
bias is deliberate: only positive marker evidence records `unauth`, so the
failure mode is "status-quo tab" and never "silently skip a working lane".

`doctor.verifyAgy` becomes both consumer and producer of the same cache.

## Fix

Three commits: fix, tests, docs (+ a merge of main for the hotfix).

Verified with a fake agy (`CODEV_AGY_BIN`) that logs every invocation, so spawn
counts are observed rather than mocked. Real 5-process bursts:

| Scenario | Spawns | Wanted |
|---|---|---|
| unauthenticated, 5 parallel `consult -m gemini` | **1** | 1 |
| authenticated, 5 parallel | **5** | 5 (every lane is real work) |
| unauth verdict already cached | **0** | 0 |
| cache disabled, 3 calls | **3** | 3 (pre-fix behaviour) |

Sign-in recovery also verified end-to-end: unauth cached → flip the fake to
authenticated → wait out the TTL → next call re-probes, finds `auth`, delivers a
review. No manual cache clear.

### Test-pollution trap worth remembering

The cache lives at a **user-global** path, so the first full-suite run wrote a
verdict into my own `~/.cache/codev` — and worse, a verdict recorded by one
doctor case made a sibling case stop spawning the thing it asserted on (one real
test failure, `doctor.test.ts` "passes the probe text immediately after --print").

Two-part fix: the consult/doctor suites pin `CODEV_AGY_AUTH_CACHE_DIR` into their
temp dirs, and the module itself is inert under `VITEST` unless a cache dir is
explicitly set. The guard is what makes this safe for *future* tests — otherwise
every new test that reaches `doctor()` silently re-acquires the hazard.

Full suite: 3720 passed, 0 failed, and `~/.cache/codev` is not created by a test run.
