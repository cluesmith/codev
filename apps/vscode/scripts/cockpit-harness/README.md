# Cockpit verification harness

Dev-only. Excluded from the vsix (`.vscodeignore`) and not run in CI.

This harness gives Spec 1963's rendered checkpoints an isolated Tower and an isolated VS Code
(`code serve-web`) running the branch's vsix. Neither can reach the owner's Tower (`:4100`),
`~/.agent-farm`, `~/.codev/run` or IDE (`/ide/`). The plan's *Verification harness* section is the
design; this file covers how to run it.

## Running it

```sh
export COCKPIT_SCRATCH=<the session scratchpad>   # must be under a temp root
export COCKPIT_TOWER_PORT=18764 COCKPIT_WEB_PORT=18765
H=apps/vscode/scripts/cockpit-harness/harness.mjs

node $H selftest            # prove every pre-flight refusal and the tripwire
node $H build-vsix          # vsce package → $COCKPIT_SCRATCH/cockpit-harness/codev-vscode.vsix
node $H start               # pre-flight, Tower, `empty` fixture, serve-web, tripwire
node $H seed one-builder    # seed a scenario; gate 6 asserts its overview
node $H check               # gates 3-5 again, plus the extension running against the Tower
node $H stop                # kill the harness's own PIDs; remove runtime dirs
```

Prerequisites:
- `packages/codev` is built, because the Tower and the fixture driver load its `dist`;
- `pnpm install` has run, because the browser driver resolves `playwright` from `packages/codev`.

Never run `playwright install`. The driver uses the Chromium already in
`~/Library/Caches/ms-playwright`.

## What runs, and how it is kept away from the owner's

| Piece | How it is isolated |
|---|---|
| Tower | Started as `node packages/codev/dist/agent-farm/servers/tower-server.js -p $COCKPIT_TOWER_PORT`, never through `afx tower start`.<br>Its environment is built from an allowlist: `CODEV_AGENT_FARM_DIR` and `HOME` are in the scratchpad, and `NODE_ENV`, `AF_TEST_DB` and `CODEV_TOWER_KEY` are unset. |
| Shellper sockets | They live in `<root>/run`, reached through a short `/tmp/cckp-<random>` symlink.<br>macOS caps a socket path at 104 bytes, and the scratchpad path alone is longer. Gate 2 checks the link's real path, and every teardown removes the link. |
| Fixture driver (`fixtures.mjs`) | Runs in the isolated environment. Creates state only through:<ul><li>explicit-port HTTP calls (activation, builder terminals);</li><li>the dist's in-process writers (porch `writeState`, `upsertBuilder`);</li><li>git.</li></ul>It runs no Tower-contacting `afx` or `porch` command. |
| Fixture sessions | Architects and builders are `/bin/bash --noprofile --norc`, through a no-op custom harness in each fixture's `.codev/config.json`. They are never agents. |
| VS Code | `code serve-web` on `$COCKPIT_WEB_PORT`, with the CLI, server, user and extensions dirs all under the root.<ul><li>Machine settings: `codev.towerPort=$COCKPIT_TOWER_PORT`, `codev.autoStartTower=false`, `files.autoSave=off`.</li><li>Environment: `CODEV_TOWER_KEY` is the isolated key, `HOME` is the scratch home, and `stubs/` comes first on `PATH`.</li></ul> |
| Stubs (`stubs/afx`, `porch`, `codev`) | Each call appends `{ tool, argv, cwd, caller }` to `<root>/logs/stub-calls.jsonl` and exits 0, so CLI-shelling actions are verified by their recorded argv.<br>`codev --version` prints the branch version.<br>The stubs are on the Tower's `PATH` too. |
| Browser (`workbench.mjs`) | Headless Chromium with a persistent profile under the root, so the folder-trust decision holds. Any request to `:4100` fails the check. |
| Tripwire (`tripwire.mjs`) | Samples `lsof` for ESTABLISHED connections on `:4100` once a second. It fails the run (writes `tripwire.tripped`, exits 3) if one belongs to the harness tree:<ul><li>the PIDs in `<root>/pids/`;</li><li>holders of sockets in the run dir;</li><li>descendants of either.</li></ul>It never connects to `:4100`. |

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
5. The serve-web Machine settings pin the port and turn auto-start off, and `afx`, `porch` and
   `codev` resolve to the stubs in the serve-web environment.
6. After a seed, each fixture workspace's `/api/overview` lists exactly the expected builders (with
   `spawnedByArchitect`) and architects. There is no fallback to faked data.

## Teardown

`stop` kills, by PID only:
- the recorded roots, each re-verified by its command line;
- the shellpers holding sockets in the run dir;
- previously recorded descendants whose command line is unchanged;
- all live descendants of those.

It then checks that none of them is still alive. It also removes:
- the socket symlink;
- the runtime dirs (`af`, `run`, `home`, `fixtures`, `pids`, the VS Code server, user and
  extensions dirs, and the browser profile);
- the state record.

It keeps `logs/`, `shots/`, the vsix and the downloaded VS Code server cache (`cache/`). A failed
`start` runs the same teardown.

If the tripwire fires, or a pre-flight gate refuses in a real run, stop and tell the architect
before retrying.

## Scenarios

`fixtures.mjs` defines them in `SCENARIOS`:
- `empty`: workspace `alpha`, not activated. `start` seeds it.
- `one-builder`: `alpha` activated, plus builder `spir-101` spawned by `main`.

Later phases add scenarios here.
