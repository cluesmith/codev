# Cockpit verification harness

Dev-only. Excluded from the vsix (`.vscodeignore`) and not run in CI.

This harness gives Spec 1963's rendered checkpoints an isolated Tower and an isolated VS Code
(`code serve-web`, or the IDE server binary) running the branch's vsix. Neither can reach the
owner's Tower (`:4100`), `~/.agent-farm`, `~/.codev/run` or IDE (`/ide/`). The plan's *Verification harness* section is the
design; this file covers how to run it.

## Running it

```sh
export COCKPIT_SCRATCH=<the session scratchpad>   # must be under a temp root
export COCKPIT_TOWER_PORT=18764 COCKPIT_WEB_PORT=18765
H=apps/vscode/scripts/cockpit-harness/harness.mjs

node $H selftest            # prove every pre-flight refusal and the tripwire
node $H build-vsix          # vsce package → $COCKPIT_SCRATCH/cockpit-harness/codev-vscode.vsix
node $H start               # pre-flight, Tower, `empty` fixture, VS Code, tripwire
node $H seed one-builder    # seed a scenario; gate 6 asserts its overview
node $H check               # gates 3-5 again, plus the extension running against the Tower
node $H verify render       # a scripted rendered check (cockpit-verify.mjs); see below
node $H tower-down          # stop only the isolated Tower (by PID); tower-up starts it again
node $H vscode-restart      # restart only the isolated VS Code (by PID)
node $H stop                # kill the harness's own PIDs; remove runtime dirs
```

`selftest` needs both ports set and free, even though it serves no web. Its refusal cases run real
`start` processes, and each must refuse for the gate under test, not for a missing port.

`build-vsix` records a digest of every tracked or untracked file the vsix is built from. `check`
treats the installed vsix as the branch's only while that digest still matches, so an
uncommitted edit that was built in passes, and any edit since the build fails until you run
`build-vsix` again. The loop while iterating is: edit, `build-vsix`, `stop`, `start`, `check`.

If `code serve-web` cannot run, start with the IDE server binary instead:

```sh
COCKPIT_VSCODE=ide-server COCKPIT_IDE_SERVER_BIN=<path to the VS Code Server's bin/code-server> node $H start
```

Prerequisites:
- `packages/codev` is built, because the Tower and the fixture driver load its `dist`;
- `pnpm install` has run, because the browser driver resolves `playwright` from `packages/codev`.

Never run `playwright install`. The driver uses the Chromium already in
`~/Library/Caches/ms-playwright`, or in `PLAYWRIGHT_BROWSERS_PATH` when that is set.

## What runs, and how it is kept away from the owner's

| Piece | How it is isolated |
|---|---|
| Tower | Started as `node --require request-log.cjs packages/codev/dist/agent-farm/servers/tower-server.js -p $COCKPIT_TOWER_PORT`, never through `afx tower start`.<br>Its environment is built from an allowlist: `CODEV_AGENT_FARM_DIR`, `HOME` and `TMPDIR` are in the scratchpad, and `NODE_ENV`, `AF_TEST_DB` and `CODEV_TOWER_KEY` are unset.<br>`request-log.cjs` appends each HTTP request and WebSocket upgrade it receives to `<root>/logs/tower-requests.jsonl` (for the request-count check). |
| Shellper sockets | They live in `<root>/run`, reached through a short `/tmp/cckp-<random>` symlink.<br>macOS caps a socket path at 104 bytes, and the scratchpad path alone is longer. Gate 2 checks the link's real path, and every teardown removes the link. |
| Fixture driver (`fixtures.mjs`) | Runs in the isolated environment. Creates state only through:<ul><li>explicit-port HTTP calls (activation, builder terminals);</li><li>the dist's in-process writers (porch `writeState`, `upsertBuilder`);</li><li>git.</li></ul>It runs no Tower-contacting `afx` or `porch` command. |
| Fixture workspaces | Git repos in a fresh `cockpit-fixtures-*` dir (`mkdtemp`) under the real per-user temp dir (`/private/var/folders/…/T`), **not** the scratchpad. Tower's `/api/workspaces` drops every workspace under `/tmp`, `/private/tmp` or its own `os.tmpdir()` (`isTempDirectory`), and the scratchpad is under `/private/tmp`, so fixtures there never reach the fleet the Tower and Cockpit views list. The Tower's own `TMPDIR` points into the scratchpad, so this dir is not its temp dir. `start` writes a marker holding a per-run token in it; see *Teardown*. |
| Fixture sessions | Architects and builders are `/bin/bash --noprofile --norc`, through a no-op custom harness in each fixture's `.codev/config.json`. They are never agents. |
| VS Code | Runs on `$COCKPIT_WEB_PORT` in one of two modes, set by `COCKPIT_VSCODE`:<ul><li>`serve-web` (default): `code serve-web`, with the CLI, server, user and extensions dirs all under the root.</li><li>`ide-server`: the plan's alternative for when serve-web cannot run. It launches the VS Code Server binary Tower's IDE support uses (`COCKPIT_IDE_SERVER_BIN`) **directly**, never through any Tower's `/api/ide`. It passes the flags `ide-server.ts` passes (`--host 127.0.0.1`, `--port`, `--server-base-path /ide`, `--connection-token-file`, `--extensions-dir`), plus `--server-data-dir` and `--user-data-dir`, all in the scratchpad.</li></ul>The mode is chosen explicitly. A serve-web failure fails the start; it does not switch modes by itself.<ul><li>Machine settings: `codev.towerPort=$COCKPIT_TOWER_PORT`, `codev.autoStartTower=false`, `files.autoSave=off`.</li><li>Environment: `CODEV_TOWER_KEY` is the isolated key, `HOME` is the scratch home, and `stubs/` comes first on `PATH`.</li></ul> |
| Stubs (`stubs/afx`, `porch`, `codev`) | Each call appends `{ tool, argv, cwd, caller }` to `<root>/logs/stub-calls.jsonl` and exits 0, so CLI-shelling actions are verified by their recorded argv.<br>`codev --version` prints the branch version.<br>The stubs are on the Tower's `PATH` too. |
| Browser (`workbench.mjs`) | Headless Chromium with a persistent profile under the root, so the folder-trust decision holds. Any request to `:4100` fails the check. |
| Tripwire (`tripwire.mjs`) | Samples `lsof` for ESTABLISHED connections on `:4100` every 2 s. The machine-wide socket-holder scan runs on every 5th sample only. It fails the run (writes `tripwire.tripped`, exits 3) if one belongs to the harness tree:<ul><li>the PIDs in `<root>/pids/`;</li><li>holders of sockets in the run dir;</li><li>descendants of either.</li></ul>It never connects to `:4100`. |

The tripwire **detects**; it does not enforce. It samples every 2 s, so a connect, request and
close to `:4100` that completes between two samples would escape it. (The extension's Tower
connection is a long-lived event stream, so a misdirected one would not.) Isolation is enforced by
the layers above:
- no Tower-contacting CLI;
- recording stubs on `PATH`;
- `codev.autoStartTower=false` and the pinned `codev.towerPort`;
- the isolated `CODEV_TOWER_KEY`, so a stray request to the owner's Tower would get a 401.

## Pre-flight gates

These match the plan's numbering. Any refusal exits with code 2.

1. Each port is set, numeric and not 4100, and has no listener before the start.
2. `COCKPIT_SCRATCH` is under a temp root. The agent-farm dir and socket dir resolve under it, never
   into `~/.agent-farm` or `~/.codev`. A shellper socket path also fits the Unix-socket limit.
   - Gates 1 and 2 run before anything is created.
3. The fixture driver's `AGENT_FARM_DIR` is the isolated dir, and its `getGlobalDbPath()` is the
   one `.db` file the isolated Tower has open (`lsof`).
   - The driver re-checks this before every seed, and refuses before writing.
4. The only listener on the Tower port is the PID the harness spawned. `/api/version` answers the
   isolated key, and a wrong key gets 401.
5. The VS Code Machine settings pin the port and turn auto-start off, and `afx`, `porch` and
   `codev` resolve to the stubs in the VS Code server's environment.
6. After a seed, each fixture workspace's `/api/overview` lists exactly the expected builders (with
   `spawnedByArchitect`) and architects, and `/api/workspaces` lists each activated workspace as
   active or dormant as seeded. There is no fallback to faked data.

## Teardown

`stop` kills, by PID only:
- the recorded roots, each re-verified by its command line;
- the shellpers holding sockets in the run dir;
- previously recorded descendants whose command line is unchanged;
- all live descendants of those.

It then checks that none of them is still alive. It also removes:
- the socket symlink;
- the runtime dirs (`af`, `run`, `home`, `tmp`, `pids`, the VS Code server, user and
  extensions dirs, and the browser profile);
- the fixtures dir, which is outside the scratchpad, **only if every check holds**:
  - it is a real directory, not a symlink, and its realpath is the recorded path;
  - the realpath's parent is the per-user temp dir;
  - its basename is `cockpit-fixtures-*`;
  - it holds the `.cockpit-harness-fixtures` marker `start` wrote, with this run's token.

  Otherwise `stop` deletes nothing there, prints `REFUSED … deleted nothing: <reason>`, keeps the
  state record and exits 1. `selftest` proves each refusal;
- the state record.

It keeps `logs/`, `shots/`, the vsix and the downloaded VS Code server cache (`cache/`). A failed
`start` runs the same teardown.

If the tripwire fires, or a pre-flight gate refuses in a real run, stop and tell the architect
before retrying.

## Scenarios

`fixtures.mjs` defines them in `SCENARIOS`:
- `empty`: workspace `alpha`, not activated. `start` seeds it.
- `one-builder`: `alpha` activated, plus builder `spir-101` spawned by `main`.
- `fleet` (Phase 5): four workspaces.
  - `alpha` is activated with a sibling architect `web` and a dev config (`devCommand` and two
    `devUrls`). It has three builders: `#101` (spawned by `main`, blocked on spec approval, with a
    committed spec and a changed file), `#102` (`main`) and `#103` (`web`).
  - `beta` has one builder, `#201`.
  - `gamma` has none.
  - `delta` is activated and then deactivated, so it is dormant.

Seed each scenario once per `start`. Re-seeding is not supported, for two reasons:
- `seedBuilder` refuses an existing worktree.
- The extension activates `alpha` on the isolated Tower by itself when the workbench first
  loads, so `empty`'s "no architects" expectation stops holding after the first `check`.

To get a different scenario, `stop` and `start` again.

## Scripted Cockpit checks (`verify`)

`node $H verify <script>` runs one script of `cockpit-verify.mjs` against the running harness,
headless, and writes `logs/verify-<script>.json` and screenshots under `shots/`. It refuses
unless the installed vsix is the current build. Seed `fleet` first. The scripts change fixture
state, so run them in this order, once per `start`:

| Script | What it checks |
|---|---|
| `render` | The Cockpit button directly below Codev, the Codev container unchanged, the hierarchy with N>1, N=1 and N=0 builders, the Dormant group, dark and light themes |
| `reveal` | Active-file reveal with the workspace and architect rows collapsed |
| `windows` | Builder-worktree window, no-workspace window, and Cockpit-only freshness (`#102` requests its gate) |
| `requests` | Spec scenario 21. Tower request counts in three layouts: the Cockpit alone; the Workspace, Agents and Tower views alone; and both at once (the Cockpit moved to the panel with *View: Move View*, undone with *Reset View Locations*). Each layout asserts what the side bar, secondary side bar and panel show before measuring. Each counts a 60 s idle window plus a 15 s burst (`#103`'s gate and a `codev-config-updated`), started 2 s after a fleet poll tick so no poll tick lands in it. Each runs in a freshly restarted VS Code server (`vscode-restart`), because VS Code keeps a closed window's extension host alive for its reconnection grace period, and those hosts would keep polling the Tower. It fails if the Cockpit alone makes anything the source views do not, if fleet or overview counts differ across layouts, if `getWorktreeConfig` runs while idle, if both at once add anything but `getWorktreeConfig`, or if a window opens more than one event stream |
| `actions` | Every builder context action, Approve Gate inline (it relays to the spawning architect through `/api/send`, #1494, so the check asserts that and no porch call), every workspace-row action (Spawn Builder's `afx spawn` checked in the stub log, with its cwd), and Remove Architect: offered on siblings only. A childless sibling, added through Tower, loses its row. A sibling that spawned a builder keeps its header as that builder's owner, as in Agents. Other workspaces' rows navigate; their workspace rows keep Open and Deactivate. It sets #102's and #103's gates back to unrequested first, because `windows` and `requests` request them |
| `reconnect` | **Run last.** A loaded Cockpit keeps its content with Tower down; a fresh window shows *Not connected to Tower*; Tower up + the row's Reconnect restores it. Stops and restarts only the isolated Tower, by PID (`tower-down` / `tower-up`) |

A restarted Tower does not reconnect the fixture sessions: its startup reconciliation skips, and
kills, sessions of any workspace under `/tmp`, `/private/tmp`, `/var/folders` or
`/private/var/folders` (`POSIX_TEMP_ROOTS`, `tower-terminals.ts`), by design. Real workspaces keep
their sessions across a restart; the fixtures cannot. So after `tower-up` the fleet has fewer
sessions than before (other workspaces read dormant, builders are gone), and `reconnect` checks the
Cockpit's states and recovery, not session survival. Anything after it needs a fresh `start`.
