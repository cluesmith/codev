# Phase 12, iteration 1: responses to review

Reviews: codex REQUEST_CHANGES (HIGH), claude COMMENT (HIGH). Everything both raised is fixed in
place in this iteration except claude's point 3, which is a reading already flagged to the
architect, explained below.

## codex: the cleanup can remove directories a caller supplied (REQUEST_CHANGES), fixed

Agreed. `peersDirs()` adopted any `CODEV_PEERS_E2E_*` values already in the environment, and
`removePeersDirs()` then removed them recursively. Ownership is now provable
(`__tests__/e2e/peers-isolation.ts`):

- **One run folder.** Playwright's main process makes one new `codev-peers-e2e-*` folder
  directly under the system temp directory. It holds the agent-farm, socket and home directories
  and an owner marker, `.owner`, written by exclusive create (`wx`, mode 600). The marker holds
  `<pid>:<nonce>`, the making process's pid and 16 random bytes. The folder and the marker's text
  are recorded in `CODEV_PEERS_E2E_ROOT` and `CODEV_PEERS_E2E_OWNER`.
- **Reuse.** A recorded run is reused only by the process that made it or by its child (a
  Playwright worker), and only when the folder is a `codev-peers-e2e-*` folder directly under
  tmp whose marker is the recorded text. Values recorded by anyone else are ignored: this process
  makes a folder of its own and replaces the values, leaving what they name untouched.
- **Removal.** Only in the process that made the run (the teardown runs in the main process),
  after the same marker check and the live-directory path check on each directory and the folder.
  Anything else is refused and left in place.

New tests (`playwright-peers-config.test.ts`, now 18):

- The config, given a caller's exported run values, makes a run of its own and leaves the
  caller's folder and its file.
- A run recorded by another process is ignored, a new one is made and removed, and the caller's
  folder is kept.
- A caller's folder claimed for this process or its parent is refused without a marker, with a
  forged marker, or outside the run prefix, and every one is kept.
- A worker (child pid) finds the main process's folder.
- Removal by another pid is refused, removing nothing.
- Removal refuses an unmarked folder, a marked one not directly under tmp, and a live directory.

The real run also covered it. `TOWER_TEST_PORT=14102 npx playwright test --config
playwright.peers.config.ts` passed 16 of 16 and left nothing behind. Run again with a caller's
`CODEV_PEERS_E2E_ROOT`/`OWNER` exported, naming a `codev-peers-e2e-callers-own` folder with a
file in it, it again passed 16 of 16. That folder and its file remained, and no other
`codev-peers-e2e-*` folder did.

## claude 1: CI no longer runs the held-count suite, fixed

Agreed; the Decisions precedent was not followed. `.github/workflows/dashboard-e2e.yml` gains a
step after the Decisions one: `Run Peers panel and held-count tests`, on `TOWER_TEST_PORT=14102`,
under the same `if` (not cancelled, browsers installed), with `--retries 3`. It needs no other
environment, since the config makes and removes its own directories. The nightly run therefore
keeps the #1313/#1450 indicator suite and gains the Peers panel suite. The `PEERS_SUITE` doc in
`playwright.config.ts` names the step.

## claude 2: the waiting-for-a-peer count reads payloads, fixed

Agreed. `countWaitingForPeer` (on every `/api/overview` build) now reads
`store.countHeldOutboxBySender`, a `GROUP BY from_workspace_path` count with no payload, and
compares each stored path in canonical form as `heldOutboxForWorkspace` does. A new
`peer-inbox.test.ts` case checks that the count agrees with the list under either spelling of a
workspace, leaving out ended mail and other workspaces.

## claude 3: the unmocked case is "no cloud", not "a cloud with no relay", not changed

This is reading 4 in the thread, raised to the architect at the phase boundary. A throwaway Tower
has no cloud registration, and the standing order keeps the harness off the real cloud, so the
real route cannot be made to answer `relay: none` without a fake cloud. Building one is beyond
this phase's plan. The `relay: none` rendering is covered by the mocked case.

## claude 4: nits, fixed or recorded

- `mark.run` is now passed through `escapeHtml(String(...))` in both messages, so every text from
  the route is escaped without exception. `peerTime` also renders a time that is not a number
  as "an unknown time" instead of throwing in `toISOString()`. The throw would have broken the
  whole panel's render.
- The "no controls" assertion is now also in the local one-peer case.
- A run that dies before its global teardown leaves its one run folder. Nothing else removes it,
  because nothing else can prove it is that run's, which is the point of codex's fix. The config's
  doc says so.
