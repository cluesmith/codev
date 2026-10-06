# Specification: Tower-managed Codev IDE server from npm

## Problem Statement

The Codev IDE server (the Codev-branded VS Code server-web build that Tower forwards `/ide/` to, Issue #1668) cannot be installed or run without manual, error-prone steps. Today a user has to get a server build by hand, pass its absolute path to `afx ide start --server-path`, and make sure the Codev sidebar extension is present for that server. Nothing checks that the server is new enough for the Tower and sidebar it is paired with.

The IDE repository is now publishing the server to npm (`@cluesmith/codev-ide`, a meta-package with per-platform optional dependencies). This spec covers the **codev-package / Tower side** of that integration. After `npm i -g @cluesmith/codev @cluesmith/codev-ide`, `afx ide start` should just work. It should find the server, check that it is compatible, install the sidebar that Codev ships, and spawn the server pointed at that sidebar.

This affects every user who wants the browser IDE, whether locally at `http://localhost:4100/ide/` or remotely through the cloud tunnel at `/t/<tower>/ide/`. It also affects the owner, who wants installation to be a single command.

## Current State

- `afx ide start` **requires** `--server-path <bin>` (`commander` `requiredOption`). Without it, the CLI exits with "there is no default, the codev-ide server-web build is not shipped with codev".
- The CLI resolves the path, checks that it exists, and `POST`s `{ serverPath, port?, defaultFolder? }` to Tower's local-only, key-authed `/api/ide` endpoint.
- **Tower is the spawner.** `spawnIdeServer` spawns the binary detached with:
  - `--host 127.0.0.1 --port <p> --server-base-path /ide`
  - `--connection-token-file <tower-owned> --accept-server-license-terms`
  - `--default-folder` when given

  It then writes `~/.agent-farm/ide-server.json` (`{prefix, port, serverPath, pid, defaultFolder?, startedAt}`). Tower's boot reconcile and the on-demand respawn (a `/ide/` request that finds the server down) reuse the same function. `readIdeRecord` returns `null`, meaning "no server registered", when the record fails its field whitelist.
- When a start names a port different from a live recorded server's port, `spawnIdeServer` stops the existing server **before** it spawns the new one.
- Tower passes **no `--extensions-dir`**, so the server uses its default extensions directory.
- There is **no version check**: any binary at the given path is spawned.
- The `@cluesmith/codev` npm package ships `dist`, `bin`, `skeleton`, `templates`, `dashboard-dist`, forge scripts and a postinstall. It does **not** ship the sidebar `.vsix`.
  - The vsix is produced only by the extension's `vsix` script (`vsce package --no-dependencies`). `apps/vscode/scripts/publish.sh` runs it at release and publishes the result to the VS Code Marketplace and Open VSX.
  - `vsce` is not a declared dependency of the repo; the releaser is expected to have it on PATH.
  - The extension's `package` script runs check-types, lint and a production esbuild. It does not produce a `.vsix`.
  - The packaged vsix is about 342 KB (25 files).
- The extension already detects when it runs inside the IDE server (`codev.ideMode`, #1144), so the same vsix works in both VS Code desktop and the browser IDE.

**Proof of concept (owner, 2026-10-06, macOS arm64):**
- A plain `npm i -g` of the meta and platform packages installs in about 3 s, and `codev-ide-server --version` runs.
- The bundled `node` binary runs with no Gatekeeper prompt.
- An unmodified Tower 3.3.4 spawned the npm-installed server with `afx ide start --server-path $(which codev-ide-server)`. The sidebar rendered from an `--extensions-dir` outside the server tree.
- An environment variable set in the `afx ide start` shell does **not** reach the spawned server. Tower is a long-running daemon and spawns the server as its own child, so the extensions directory has to be an argument that Tower passes.

**Verified while writing this spec (local IDE server build, VS Code base 1.135.0, darwin-arm64):**
- `codev-ide-server --version` prints three lines: the **VS Code base version** (`1.135.0`), the commit, and the arch.
- `--install-extension <vsix> --extensions-dir <dir>` installs the sidebar into an external directory in about 2.2 s cold and 0.2 s when the same version is already present. `--list-extensions --show-versions --extensions-dir <dir>` then reports `cluesmith.codev-vscode@<ver>`. The directory gets one `<publisher>.<name>-<version>` folder per install plus an `extensions.json` index.
- Upgrading to a newer vsix works without flags. **Downgrading needs `--force`**; without it the server CLI refuses ("A newer version ... is already installed").
- Installing or replacing the sidebar leaves an unrelated extension in the same directory untouched.
- **If the server tree bundles `codev-vscode` as a built-in extension, `--install-extension` refuses it** ("is a built-in extension and not allowed to be updated"). The pre-npm local build bundles it under `extensions/codev-vscode`. The npm-published server must not. This matches "the server package ships no copy of the sidebar" and is a hard requirement on the IDE repo.

## Desired State

After `npm i -g @cluesmith/codev @cluesmith/codev-ide`:

1. `afx ide start` with no flags finds `codev-ide-server` and starts it through Tower. The browser IDE at `/ide/` shows the Codev sidebar for the installed codev version.
2. `--server-path <bin>` still works and takes precedence over discovery.
3. Tower refuses a server below the minimum version it supports. The error names the installed version, the required floor, and how to upgrade.
4. The sidebar comes from `@cluesmith/codev` itself (the vsix built for that version). Tower installs it into a Tower-owned extensions directory before every spawn. A codev upgrade or downgrade changes the sidebar on the next spawn with no manual step. The server package ships no sidebar copy.
5. If the server is not installed, the error says exactly what to run (`afx ide install`, or `npm i -g @cluesmith/codev-ide`).
6. `afx ide install` runs that npm command for the user and reports the result.
7. `afx ide status` shows enough to diagnose the pairing: the server path and version, the extensions directory, and the installed sidebar version.

## Success Criteria

**Packaging**
- [ ] The packed `@cluesmith/codev` tarball contains the sidebar vsix for the package's own version at a fixed package-relative location. The package build produces it from `apps/vscode` using a declared `@vscode/vsce` dependency, not a global `vsce`.
- [ ] The tarball grows by about the vsix size (hundreds of KB), not by megabytes.

**Discovery (in the CLI, using the user's shell environment)**
- [ ] With no `--server-path`, `afx ide start` resolves `codev-ide-server` on the user's `PATH` and sends Tower the absolute path.
- [ ] If the server is not on `PATH` but `@cluesmith/codev-ide` is installed globally, discovery succeeds through the global `node_modules` fallback.
- [ ] With no server found, `afx ide start` exits non-zero. The message names `afx ide install`, `npm i -g @cluesmith/codev-ide`, and `--server-path`. No request is sent to Tower.
- [ ] `--server-path <bin>` overrides discovery and keeps today's clear error for a nonexistent path.

**Version handshake (in Tower, on every spawn path)**
- [ ] Before any spawn, Tower runs `<server> --version` with a bounded timeout and parses **line 1 only** (the VS Code base version, e.g. `1.138.0`; line 2 is the commit, line 3 the arch) as a semver version, compared against the floor. The npm *package* version may carry a suffix (e.g. `1.138.0-codev.1`); it is never read or compared, so a package suffix has no effect on the check.
  - It refuses a version below the floor, or a command that fails, times out, or prints unparseable output.
  - When it refuses, nothing is spawned and no record is written. The error names the installed version (or the failure) and the floor.
- [ ] The floor is a single constant declared by Tower. A unit test asserts that the floor is at least the minimum of the embedded sidebar's `engines.vscode` range, so the sidebar can never be paired with a server too old to activate it.

**Extensions handover (in Tower, on every spawn path)**
- [ ] Before any spawn, Tower makes sure the Tower-owned extensions directory (`~/.agent-farm/ide-extensions`) holds the embedded sidebar at exactly the embedded version.
  - If it does not, Tower runs the server's own CLI: `--install-extension <vsix> --force --extensions-dir <dir>`, with a bounded timeout.
  - If that exact version is already installed, Tower skips the install without running a subprocess, by reading the directory's metadata.
- [ ] Tower spawns the server with `--extensions-dir <dir>` explicitly on all three spawn paths: `afx ide start`, boot reconcile, and on-demand respawn.
- [ ] Extensions a user installed into the same directory survive a sidebar install, upgrade or downgrade.
- [ ] Tower creates the extensions directory with owner-only permissions (0700). Tower refuses to use it, with a clear error, if the path is a symlink or not a directory owned by the current user.
- [ ] **Install failure** (the server CLI exits non-zero or times out): Tower refuses to spawn and surfaces the CLI's stderr. The usual cause is a server that bundles the sidebar as a built-in.
- [ ] **Missing embedded vsix** (a source checkout run without a package build): Tower logs a warning and still spawns with `--extensions-dir`. The IDE works without the sidebar, so the developer path is not blocked.

**Transactional start**
- [ ] The version check and the sidebar install complete **before** Tower stops or replaces anything. A failed preflight leaves an existing healthy server and its record untouched, including on the port-change path that stops the previous server.
- [ ] Concurrent starts and respawns are serialized in Tower, so two spawns never race on the same port, record or extensions directory.

**Live server**
- [ ] When `afx ide start` finds a server already live on the port, Tower still runs the install step but never kills the live server. If the sidebar version changed, or the live server was spawned without `--extensions-dir` (a pre-#1789 record), the CLI prints a clear hint to run `afx ide stop && afx ide start` so the server loads it.

**Spawn environment**
- [ ] Tower puts the directory of its own Node binary (`dirname(process.execPath)`) on the spawned server's `PATH`. An npm bin shim that needs `node` then still runs when Tower's daemon `PATH` lacks it (the nvm case).

**Record compatibility**
- [ ] New record fields (server version, extensions directory, sidebar version) are optional. A record written by a pre-#1789 Tower still parses, and its live server is still tracked and adopted.

**Status and install**
- [ ] `afx ide status` reports the server version, the extensions directory and the installed sidebar version, as well as today's fields. Fields missing from a legacy record show as unknown rather than erroring.
- [ ] `afx ide install` runs `npm i -g @cluesmith/codev-ide` in the user's shell environment, never through Tower. It shows npm's output and exits with npm's status. On success it reports the installed server version.

**Regression and verification**
- [ ] Existing #1668 behaviour is unchanged: the `/ide/` forward, auth, connection token, stop, restart reconcile and respawn. The #1668 test suites stay green.
- [ ] Unit tests cover:
  - discovery order
  - version parsing and floor comparison
  - install skip, upgrade and downgrade (`--force`)
  - install failure
  - the transactional preflight
  - parsing a legacy record
  - `--extensions-dir` on all spawn paths
- [ ] The real user path is verified end-to-end before the PR is called done (Test Scenario 21).

**Documentation**
- [ ] The `afx ide` surface is documented in the four shipped `afx` skill copies and in `codev/resources/commands/agent-farm.md` (both are new documentation, not updates). The `codev/resources/arch.md` §"IDE prefix forward (Issue #1668)" record shape and lifecycle are updated.

## Constraints

### Target shape (decided with the owner; treated as fixed)

These come from Issue #1789, "Target shape (decided with the owner)", and are not relitigated here:

- `@cluesmith/codev` stays the lightweight package (CLI, Tower and dashboard). It additionally **carries the sidebar vsix** (`apps/vscode` build output, about 350 KB, the same file published to Open VSX).
- `@cluesmith/codev-ide` is a thin meta-package (bin `codev-ide-server`). It has one `optionalDependencies` entry per platform, gated by `os` and `cpu` (`@cluesmith/codev-ide-server-darwin-arm64`, `-linux-x64`, and so on).
- There is **no npm dependency in either direction** between `@cluesmith/codev` and `@cluesmith/codev-ide`. This is deliberate: with peer dependencies, `npm i -g` installs a second private copy of codev.
- Install: `npm i -g @cluesmith/codev @cluesmith/codev-ide`.
- Tower (not the user's shell) passes `--extensions-dir`, because environment set on `afx ide start` does not reach a server that Tower spawns.
- The sidebar is installed idempotently into a Tower-owned directory, using the server's own CLI (`--install-extension <vsix> --extensions-dir <dir>`). The server package ships no copy of the sidebar.
- `--server-path` remains as an override.

### Existing-system constraints

- **Tower is the spawner** (#1668). Every spawn path (CLI-driven start, boot reconcile, on-demand respawn) goes through one Tower-side function. Anything that must hold for every spawn (the version check, the sidebar install, `--extensions-dir`) belongs there, not in the CLI alone.
- **No config file and no `global.db` change** (#1668 §D3). IDE runtime state lives in Tower's `~/.agent-farm/ide-server.json`, and new runtime facts extend that record as optional fields.
- Tower is a long-running daemon. Its environment, including `PATH`, is whatever it was started with, which can differ from the user's current shell.
- The `/api/ide` endpoint is local-only and key-authed. It spawns processes and must stay blocked from the tunnel. Its request contract stays backward compatible.
- The embedded vsix must be built from the same commit, with the same command (`vsce package --no-dependencies`), at the same version as the vsix published to Open VSX for that release. Byte-identical artifacts are **not** required, because `vsce` zips are not reproducible.
- `packages/codev` is product code, not a framework file, so the `codev/` ↔ `codev-skeleton/` mirror rule does not apply. The afx skill documentation does ship in four copies ({`.claude`,`.codex`} × {root, skeleton}), and all four change together.
- Windows is out of scope (there are no Windows server builds).

### Requirement on the IDE repository (out of scope here, recorded as a dependency)

- The npm-published server tree must **not** bundle `codev-vscode` as a built-in extension. If it does, `--install-extension` refuses the sidebar (verified above). Its other built-ins (`codev-defaults`, `theme-codev`) are unaffected.

## Assumptions

- The IDE repository publishes `@cluesmith/codev-ide` in the shape above, with a `codev-ide-server` bin that forwards the standard VS Code server CLI. Building and publishing those packages is out of scope.
- The npm-published server's `--version` reports the VS Code base version on line 1, then the commit, then the arch (confirmed by the IDE side; the first published server reports `1.138.0`). The npm package version may differ by a suffix (e.g. `1.138.0-codev.1`) and is not what Tower checks.
- `@cluesmith/codev` and `apps/vscode` (`codev-vscode`) are versioned in lockstep (both 3.3.4 today), so "the vsix for this codev version" is well defined.
- An `npm i -g` places `@cluesmith/codev` and `@cluesmith/codev-ide` as siblings under the same global `node_modules/@cluesmith/`. The `codev-ide-server` bin link lands in the same global `bin` directory as `afx`.
- The `codev-ide-server` bin link may resolve to a script that needs `node` or `bash` from `PATH`. Tower's spawn environment provides Node, as required above.

## Solution Approaches

Two design choices are open: where server discovery runs, and where and when the sidebar install runs. Embedding the vsix and the version floor are fixed by the issue; only their mechanics are left to settle.

### Approach 1: Discovery in the CLI; version check and sidebar install in Tower's spawn path (recommended)

- `afx ide start` runs in the user's shell and resolves the server in this order:
  1. `--server-path`, if given
  2. `codev-ide-server` on the user's `PATH`
  3. the global `node_modules` fallback: first a sibling of the running codev install, then `npm root -g`

  It sends the resolved absolute path to Tower exactly as today.
- Tower's single spawn function gains a **preflight** that every spawn path uses: the version check, then the idempotent sidebar install. It runs before anything is stopped or replaced. Tower then spawns with `--extensions-dir` and records the server version, extensions directory and sidebar version.

**Pros:**
- Discovery uses the user's `PATH`, which is what the user means by "on PATH". Tower's daemon `PATH` may be stale or minimal, for example when Tower started before the server was installed, or a launcher started it without the npm global bin.
- The `/api/ide` contract stays backward compatible.
- The version check and `--extensions-dir` cover respawn and boot reconcile for free. A server upgraded in place (same bin path) is re-checked on its next respawn, and a codev upgrade refreshes the sidebar on the next spawn.
- One place owns what a spawn means.

**Cons:** discovery lives in the CLI while the check lives in Tower, so there are two places to read. Boot reconcile still depends on the recorded path existing, as it does today.

**Risk and complexity:** low. Mostly additive changes to existing functions.

### Approach 2: Everything in Tower (discovery, check, install)

When `--server-path` is absent, the CLI sends no path, and Tower discovers `codev-ide-server` on its own `PATH` and global `node_modules`.

**Pros:** one module owns the whole lifecycle. A future non-CLI caller (a dashboard "Start IDE" button, a VS Code command) gets discovery without duplicating it.

**Cons:** Tower's `PATH` is the daemon's, captured when Tower started. Under nvm, the npm global bin is often missing from it. A user would then get "not found" for a binary that `which` finds in their shell, which is exactly the confusing failure this issue removes. It also changes the `/api/ide` contract (`serverPath` becomes optional).

**Risk and complexity:** little code, but a real failure mode for users.

### Approach 3: Sidebar install in the CLI instead of Tower

The CLI runs `codev-ide-server --install-extension` before calling Tower.

**Pros:** install output appears directly in the user's terminal.

**Cons:** boot reconcile and on-demand respawn never install. After a codev upgrade and a Tower restart, the respawned server runs a stale sidebar until the user re-runs `afx ide start`. This contradicts the issue's "Tower installs ... on every start" and splits spawn semantics.

**Risk and complexity:** little code, but the wrong owner. Rejected.

**Recommendation: Approach 1.** It honors the user's `PATH` for discovery, which is the promise users see, and keeps every invariant of a spawn in Tower's single spawn function. If a non-CLI caller is ever added, Approach 2's benefit can be recovered by letting Tower fall back to its own discovery when no path is sent. That does not change this design.

### Decided sub-points

- **Embedding the vsix.** The codev package build produces the vsix from `apps/vscode` and copies it to a fixed package-relative directory listed in `files`. Tower finds it relative to its own install, as it already does for `dashboard-dist` and `skeleton`.
  - *Rejected:* downloading the vsix from Open VSX at start time. That needs network access, breaks offline installs, and decouples the sidebar version from the codev version, which is exactly the coupling we want.
- **Idempotency.** "Installed" means the extensions directory's own index lists `cluesmith.codev-vscode` at exactly the embedded vsix's version. Any other version, older or newer, triggers `--install-extension --force`, so a codev downgrade also downgrades the sidebar (verified that `--force` is needed). Only the codev sidebar is touched.
- **Floor source.** Tower declares the floor as one constant. A test ties it to the embedded sidebar's `engines.vscode` minimum (`^1.128.0` today), so that bumping the sidebar's engine without bumping the floor fails CI. The initial floor is `1.128.0` (confirmed acceptable by the IDE side: every server CLI flag Tower relies on, `--extensions-dir`, `--install-extension`, `--connection-token-file`, `--server-base-path`, predates it). The first published server (`1.138.0`) clears it.
- **Live server.** Never killed implicitly: it may have open browser sessions. Tower installs and the CLI hints at a restart (see Success Criteria).
- **Install failure.** Refuse to spawn. A server that runs without its sidebar looks broken in confusing ways, while a clear error points at the cause.
- **Missing vsix.** Warn and spawn, because only source checkouts hit this.
- **`afx ide install`.** In scope. It is small and gives the "not found" error a one-command fix. It runs in the CLI, not Tower: Tower must not expose an endpoint that runs `npm`.
- **Recorded server path.** The path that discovery resolved (the PATH bin link), not its real path, so that an in-place `npm i -g` upgrade takes effect on the next respawn.

## Open Questions

### Critical (blocks progress)

N/A: the original critical question (what `--version` reports) is answered by verification. It is the VS Code base version, and the floor derives from the sidebar's engine requirement.

### Important (shapes design)

N/A: both resolved by the IDE side (recorded on #1789):
- **Floor:** `1.128.0` is acceptable (see Decided sub-points).
- **Built-in exclusion:** confirmed. The published server packages do not bundle `extensions/codev-vscode`; this is an explicit requirement of the IDE-side publish lane, whose PoC ran with the built-in removed and the sidebar installed via `--install-extension`. The pre-npm `pr43` tree tested above is the counter-example, not the shipped shape.

### Nice-to-know

1. Should the extensions directory be overridable? The default answer is no: it is a fixed Tower-owned path, shown in status.
2. A vsix rebuilt locally without a version bump is skipped by the version-only check. That is acceptable for releases; a developer can delete the directory.
3. The release could reuse one packaged vsix for both the npm embed and the Open VSX upload. That would be nice, but it is not required (see Constraints).

## Test Scenarios

**Packaging**
1. Build `@cluesmith/codev`, run `pnpm pack`, and list the tarball. The vsix is at the fixed location, its manifest version equals the package version, and the tarball grows by about the vsix size.
2. The package build succeeds with no global `vsce` installed.

**Discovery**
3. `--server-path` given: it is used as-is and discovery is not consulted. A nonexistent path gives the existing clear error.
4. No flag, with `codev-ide-server` on `PATH`: it resolves to that path.
5. No flag, not on `PATH`, but present as a sibling global package: it resolves through the fallback.
6. No flag and no server anywhere: the CLI exits non-zero with the install hints, and no request is sent to Tower.

**Version handshake**
7. A version at or above the floor proceeds, including one exactly equal to the floor.
8. A version below the floor is refused. The error names both versions, nothing is spawned, and no record is written.
9. `--version` exits non-zero, times out, or prints unparseable output: Tower refuses with a clear error.
10. The respawn paths (boot reconcile and on-demand) run the check too. A server downgraded in place below the floor is not respawned, and the reason is logged.
11. The floor-versus-`engines.vscode` unit test fails if the sidebar's engine minimum moves above the floor.

**Extensions handover**
12. Empty directory: the install runs with `--install-extension <embedded vsix> --force --extensions-dir <dir>`, and the spawn args include `--extensions-dir <dir>`.
13. Same sidebar version already indexed: no install subprocess, and the spawn still passes `--extensions-dir`.
14. An older or newer sidebar is indexed: the install runs and replaces it, and an unrelated extension in the directory is untouched.
15. The install fails (non-zero exit or timeout): Tower refuses to spawn and shows stderr.
16. The embedded vsix is missing: Tower warns and spawns without installing.
17. The extensions path is a symlink or owned by another user: Tower refuses with a clear error.
18. Boot reconcile and on-demand respawn both pass `--extensions-dir` (argument construction asserted in unit tests).

**Transactional and concurrent**
19. A start on a new port whose preflight fails (low version or failed install) leaves the existing live server running and its record unchanged.
20. Two overlapping starts (or a start plus a respawn) do not double-spawn or interleave record writes.

**End-to-end: the real user path, before the PR is called done**
21. On macOS arm64:
    1. `npm i -g` the packed `@cluesmith/codev` tarball plus `@cluesmith/codev-ide` (or, until it is published, a server tree with the built-in sidebar removed, passed by `--server-path`).
    2. Restart Tower.
    3. Run `afx ide start` with no flags.
    4. Open `http://localhost:4100/ide/?folder=<repo>` in a browser (Playwright).

    Expected: the Codev sidebar renders, and `afx ide status` shows a sidebar version that matches codev's.

**Status, install and compatibility**
22. `afx ide status` shows the server version, the extensions directory and the sidebar version. With a legacy record, these show as unknown, and the live server is still reported.
23. A legacy `ide-server.json` with no new fields is parsed, and its live server is adopted on boot.
24. `afx ide install` success reports the installed version. An npm failure (for example EACCES on a system Node) exits non-zero with npm's message.
25. Regression: the #1668 suites (`ide-record`, `ide-forward-integration`, routes and websocket auth) stay green.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Tower's daemon `PATH` lacks the npm global bin and `node` (the nvm case) | High | High | Discovery runs in the CLI with the user's `PATH` (Approach 1). Tower spawns with `dirname(process.execPath)` added to the spawned `PATH` (a success criterion). These are one condition with two mitigations. |
| The npm server bundles `codev-vscode` as a built-in, so the install is refused | Low | High | Confirmed IDE-side requirement (published packages exclude it). Tower's install-failure message names the cause if a stray build bundles it. |
| A version-only idempotency check misses a same-version, different-bytes vsix | Low | Low | Release versions always bump. Developers can clear the directory. |
| The npm-embedded and Open VSX vsix drift apart | Low | Medium | Both come from the same commit, command and version at release. Byte identity is not required. |
| The sidebar's `engines.vscode` exceeds the server's base version, so the sidebar does not activate | Medium | High | The floor is test-tied to the sidebar's engine minimum. |
| A preflight subprocess (`--version`, install) hangs inside the `/api/ide` handler or a respawn | Low | Medium | Bounded timeouts on both. Spawns are serialized. |
| A failed preflight on a port change takes down a healthy server | Medium | High | The preflight runs before any stop or replace (transactional start). |
| A pre-#1789 record fails the stricter parse, and Tower loses a live server | Medium | High | New fields are optional. A legacy-record test is required. |
| The respawn path gains filesystem writes (into the extensions directory) | Low | Low | The directory is Tower-owned, 0700, and its ownership and non-symlink status are checked. The trust boundary is unchanged (`/ide/` and `/api/ide` stay key-gated, and `/api/ide` stays local-only). |
| Adding vsix packaging (lint, type-check, esbuild, vsce) slows the codev build and CI | Medium | Low | Declare `@vscode/vsce` as a dev dependency. Reuse the extension's production build output. |

## References

- Issue #1789 (this work), with proof-of-concept notes in the issue body.
- Issue #1668 and `codev/plans/1668-tower-forward-a-sub-path-to-a-.md`: the `/ide/` forward, the `afx ide` lifecycle, the `~/.agent-farm/ide-server.json` record, and decisions §D1 to §D5.
- `codev/resources/arch.md` §"IDE prefix forward (Issue #1668)".
- Plan #1144 (`codev/plans/1144-vscode-ide-mode-foundation-dua.md`): the extension's IDE mode.
- `apps/vscode/scripts/publish.sh`: how the released vsix is packaged (one `vsce package --no-dependencies`, published to both registries).
- The VS Code server CLI: `--version`, `--install-extension [--force]`, `--extensions-dir`, `--list-extensions --show-versions`. Behaviour was verified against a local codev-ide server build (1.135.0) on 2026-10-06.
