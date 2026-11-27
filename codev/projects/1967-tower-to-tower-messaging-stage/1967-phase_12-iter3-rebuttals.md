# Phase 12, iteration 3: responses to review

Reviews: codex REQUEST_CHANGES (HIGH), claude APPROVE (HIGH). Codex's point is fixed the way he
asks: main-process ownership now rests on process-local provenance, not on the environment and a
pid. Claude's one nit is fixed.

## codex: a valid marker with the current pid could be adopted and deleted, fixed

Agreed. A caller can write a prefixed folder and a marker naming its shell's pid, then `exec`
Playwright, which keeps that pid. `peersDirs()` accepted `ownerPid === proc.pid`, and the teardown
removed the folder.

The environment and the pid no longer prove anything in the main process
(`__tests__/e2e/peers-isolation.ts`):

- **An in-memory record.** When the main process makes its run folder, it records `{root, owner}`
  in its own memory: `madeRunRecord()`, an object on `globalThis` under
  `Symbol.for('codev.peers-e2e.made-run')`. The registered symbol lets the record outlive the
  config being evaluated again in the same process (Playwright and the unit test both do this).
  No environment, pid or marker a caller prepares can supply it. Code that could plant it would
  already be running inside the process.
- **The main process** reuses only the run in its record, after the marker check, and records it
  again for the workers. Otherwise it makes a new folder. Whatever the inherited environment
  names is ignored and never touched, including a folder validly marked with this very pid.
- **Removal** (`removePeersDirs`, `ownedPeersDirs`) goes only by the record. A process with no
  record removes nothing, whatever the environment names. A recorded folder whose marker no
  longer matches is refused and left in place.
- **The teardown**, if the environment records a run but this process holds no record, throws
  instead of leaking quietly.
- **Workers** are as in iteration 2. They learn the paths from the environment, their only
  channel, as real Playwright workers (an IPC channel and `TEST_WORKER_INDEX`) forked by the
  maker, with the marker matching. A worker removes nothing.

New tests (`playwright-peers-config.test.ts`, 19):

- **The config.** Given exported values naming a folder marked with this process's own pid, it
  makes its own run, and the caller's folder and file remain.
- **The main process, with an empty record,** is given folders validly marked with its own pid,
  its parent's and another process's. Each time it makes and removes a run of its own, and the
  caller's folder stays.
- **Removal with no record** removes nothing, even with the environment naming a folder marked
  with this pid.
- **A tampered marker** on the recorded folder is refused, removing nothing.
- **The same process evaluating the config again** reuses its run and restores the recorded
  values even if something changed them.

**The real run, codex's exact scenario.**
- `sh -c` makes `codev-peers-e2e-exec-caller` with a file, writes a marker `28859:<nonce>` with
  its own pid (`$$` = 28859), exports the run values, and `exec`s
  `node_modules/.bin/playwright test --config playwright.peers.config.ts`. That shim itself
  `exec`s node, so the pid is kept.
- 17 of 17 passed. The caller's folder and its file remained, and it was the only
  `codev-peers-e2e-*` folder left.
- The plain run also passed 17 of 17 and left none.

## claude (APPROVE), non-blocking note 1, fixed

`escapeHtml(tower.name)` (twice) and `escapeHtml(g.recipient)` now coerce with `String(...)`, as the
panel's other route values do, so a non-string degrades instead of throwing in `renderPeers`. I
changed only the panel's calls. The shared `escapeHtml` returns `''` for any falsy value, and its
other callers in `tower.html` may rely on that.
