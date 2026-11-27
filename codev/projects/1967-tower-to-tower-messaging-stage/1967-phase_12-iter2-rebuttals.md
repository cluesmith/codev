# Phase 12, iteration 2: responses to review

Reviews: codex REQUEST_CHANGES (HIGH), claude APPROVE (HIGH). Codex's point is fixed. Claude's
non-blocking notes 1 and 3 are fixed; note 2 is the architect's call and goes to them unchanged.

## codex: the main process could adopt a validly marked folder under its parent's pid, fixed

Agreed. `peersDirs()` reused a recorded run when `ownerPid === proc.ppid` and the marker matched.
In Playwright's main process the parent is the caller's shell, so a caller who wrote a matching
`.owner` under their shell's pid had their folder adopted. It was not removed, since the teardown
refuses another pid's run, but the run used it and then failed.

The parent-pid path is now open only to a real Playwright worker (`peers-isolation.ts`). Playwright
1.59 forks each worker with an IPC channel (`runner/processHost.js`, `stdio: [..., 'ipc']`). It sets
`TEST_WORKER_INDEX` in the `WorkerMain` constructor, before `_loadIfNeeded()` evaluates the config
(`worker/workerMain.js`). A main process started from a shell has no IPC channel. So:

- **Main process** (no channel): reuses only a run recorded under its own pid, which happens when
  it evaluates the config twice. Anything else recorded, whoever it names, is ignored: it makes a
  folder of its own and never touches theirs.
- **Worker** (`TEST_WORKER_INDEX` set and `process.send` a function): reuses only a run recorded
  by its parent, with the marker matching. A worker that finds none is refused instead of making
  a folder. A worker misjudged as the main process would therefore leak a folder, and the
  after-run check would show it.

New tests (`playwright-peers-config.test.ts`, 19):

- **Codex's case.** The main process is given a folder validly marked as made by its parent, and
  separately one marked as made by another process. Each time it makes and removes a run of its
  own, and the caller's folder and file remain.
- **A worker forked by the maker** finds the same folder.
- **A worker refused, making nothing:** one with nothing recorded, one recorded by a non-parent,
  and one claiming its parent's pid without a marker.
- **Claims of this very process** are refused when the marker is missing or forged, or the folder
  is outside the run prefix.

The real run passed 17 of 17 and left no `codev-peers-e2e-*` folder. That shows the workers took
the worker path; a misjudged worker would have left a folder.

## claude (APPROVE), non-blocking notes

1. **`refreshPeers()` had no in-flight guard, fixed.** Each request takes a number, and an answer
   is rendered only if no later request has been made, the same idea as `HeldCountBadge`'s
   `generationRef`. A new Playwright case holds the first of two refreshes until the second has
   rendered, then releases it, and the newer list stays. With the guard removed, that case fails
   (negative run, `tower.html` restored byte-identical afterwards).
2. **The Peers section on every Tower home page, including one never connected to Codev Cloud:
   not changed.** As claude says, this is the architect's call; it is raised to them at the phase
   boundary.
3. **`peerModeText` labelled any unknown mode "deliver", fixed.** `hold` and `deliver` keep their
   words; any other mode is shown as it is, escaped. The hostile-text case now includes a
   `<b>later</b>` mode shown as text.
