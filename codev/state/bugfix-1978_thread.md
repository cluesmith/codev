# bugfix-1978 thread

Issue #1978: `afx workspace list` shows stopped workspaces as running, because an empty
terminal-map entry counts as running.

## Investigate (2026-11-24)

Reproduced read-only on the installed Tower (3.3.8): `afx workspace list --json` gives 53
workspaces, 46 marked running, 7 not running, and only 12 with a live agent.

The root cause is proved, not inferred. `getInstances()` (`tower-instances.ts`) sits behind
`/health`, `/api/workspaces`, `/api/status` and `/api/workspaces/:path/status`. It calls
`getTerminalsForWorkspace()` for every known workspace that exists on disk and is not a temp dir
or a builder worktree. That function ends with `workspaceTerminals.set(path, freshEntry)` whether
or not the entry holds a terminal. The 7 marked not running are exactly the ones `getInstances`
skips: 6 missing directories and `/private/tmp/todo`. The per-workspace reads (`GET
/workspace/<p>/api/state`, `/api/overview`) leave empty entries the same way, which is how
`shannon/.builders/research-8593`, a worktree, got one.

Every "running" in the address book, the naming rules (`findWorkspaceByAddressName`,
`workspaceAddressName`), the resolvers (`locateWorkspace`), the reply footer
(`crossWorkspaceOrigin`) and the name route is "has a key in the terminal map". `afx whoami` uses
"has a `terminal_sessions` row" instead.

Decisions sent to the architect:
1. A workspace is running when the map holds at least one terminal for it whose session is open
   (it exists in the terminal manager and has not exited). A workspace that is activated but has
   no terminal yet is not running. "Open" rather than "writable", so the naming and ambiguity
   rules do not flip while a shellper reconnects. The rule is one function,
   `runningWorkspaces()`, in the shared naming module: Tower feeds it its open terminals and
   whoami feeds it the `terminal_sessions` rows.
2. A send to a registered agent in a stopped workspace, by an address that names the workspace,
   is refused as not running, whether or not an entry exists. Own-workspace sends, with no
   workspace written, still hold as before.
3. Read routes that create entries are left alone: that is a separate change of about 15 call
   sites, and (1) does not depend on it.

The architect agreed to all three (2026-11-24 22:00Z) and added two things to pin down:
(a) mail already held for an agent of a stopped workspace stays held, shows in `afx inbox`, and
delivers when the workspace starts; (b) what a send gets in the window after a Tower restart,
before the shellpers are re-adopted.

## Fix (2026-11-24)

- `runningWorkspaces()` (`utils/workspace-address.ts`) is the one definition. Tower feeds it
  through `runningWorkspacePaths()` (`tower-messages.ts`): a terminal counts when its id is on the
  map and its session exists and has not exited. That function is used by the address book,
  `locateWorkspace`, `crossWorkspaceOrigin` and the name route. `afx whoami` feeds
  `runningWorkspaces()` from the `terminal_sessions` rows and no longer adds its own workspace
  (that never changed its own name).
- (b) The window is real: Tower listens before the startup reconcile finishes. On today's
  restart that took 0.6 s for 64 sessions (21:28:47.463 listen, 21:28:48.081 reconcile complete).
  `/api/send` and `/api/address-book` now await `whenStartupReconcileSettled()` (bounded at 10 s),
  as the dashboard's reads already did.
- (a) The fix doesn't touch the mailbox: delivery keys on the agent's live session, not on
  "running". The e2e pins it: mail held while the workspace is stopped stays held, is listed by
  `afx inbox`, is untouched by the refusal, and is offered to the new terminal when the workspace
  starts (its reason goes from `no-live-pty` to `no-profile` under the inert terminal).
- Fixtures that encoded the bug: `spec-1313-registry-resolve` treated an empty slot as a live
  workspace, and one route test removed every session on the Tower to simulate one dead
  recipient.
- Checked the tests against the pre-fix source and build: 9 unit tests and 4 e2e cases fail, and
  the e2e reproduces every consequence in the issue. With the fix, all pass.
- Step 5 (verify on a real Tower with many workspaces) needs the fix on the live Tower, which
  means an install plus a Tower restart: the owner's call. A test Tower on a copy of `global.db`
  would reconcile the live shellpers and take over their connections, so I didn't do that.
