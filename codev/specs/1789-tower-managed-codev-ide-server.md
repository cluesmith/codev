# Specification: Tower-managed Codev IDE server from npm

## Problem Statement

The Codev IDE server (the Codev-branded VS Code server-web build that Tower forwards `/ide/` to, Issue #1668) cannot be installed or run without manual, error-prone steps. A user today must obtain a server build by hand, pass its absolute path to `afx ide start --server-path`, and separately arrange for the Codev sidebar extension to be present in the server's extensions directory. Nothing checks that the server is new enough for the Tower/sidebar it is paired with.

The IDE repository is now publishing the server to npm (`@cluesmith/codev-ide`, a meta-package with per-platform optional dependencies). This spec covers the **codev-package / Tower side** of that integration: once the user has run `npm i -g @cluesmith/codev @cluesmith/codev-ide`, `afx ide start` should just work: find the server, check it is compatible, install the sidebar Codev ships, and spawn the server pointed at that sidebar.

Affected: every user who wants the browser IDE (locally at `http://localhost:4100/ide/` or remotely through the cloud tunnel at `/t/<tower>/ide/`), and the owner, who wants this to be a one-command install.

## Current State

- `afx ide start` **requires** `--server-path <bin>` (`commander` `requiredOption`); without it the CLI exits with "there is no default, the codev-ide server-web build is not shipped with codev".
- The CLI resolves the path, checks it exists, and `POST`s `{ serverPath, port?, defaultFolder? }` to Tower's local-only, key-authed `/api/ide` endpoint. **Tower is the spawner**: it spawns the binary detached with `--host 127.0.0.1 --port <p> --server-base-path /ide --connection-token-file <tower-owned> --accept-server-license-terms [--default-folder]`, and writes `~/.agent-farm/ide-server.json` (`{prefix, port, serverPath, pid, defaultFolder?, startedAt}`). The same spawn path is reused by Tower's boot reconcile and by the on-demand respawn when a `/ide/` request finds the server down.
- Tower passes **no `--extensions-dir`**. The server therefore uses its default extensions directory, which does not contain the Codev sidebar unless the user put it there.
- There is **no version check**: any binary at the given path is spawned.
- The `@cluesmith/codev` npm package ships `dist`, `bin`, `skeleton`, `templates`, `dashboard-dist`, forge scripts and a postinstall. It does **not** ship the sidebar `.vsix`. The vsix is produced only by the extension's `vsix` script (`vsce package --no-dependencies`, run by `apps/vscode/scripts/publish.sh` at release) and published to the VS Code Marketplace and Open VSX. `vsce` is not a declared dependency of the repo; it is expected on the releaser's PATH. (The extension's `package` script runs check-types + lint + a production esbuild; it does not produce a `.vsix`.)
- The extension already detects when it runs inside the IDE server (`codev.ideMode`, #1144), so the same vsix works in both VS Code desktop and the browser IDE.

**Proof of concept (owner, 2026-10-06, macOS arm64):** a plain `npm i -g` of the meta + platform packages installs in ~3 s; `codev-ide-server --version` runs; the bundled `node` binary runs with no Gatekeeper prompt (npm-written files carry no quarantine xattr). An unmodified Tower 3.3.4 spawned the npm-installed server via `afx ide start --server-path $(which codev-ide-server)` and the sidebar rendered from an `--extensions-dir` outside the server tree. An environment variable set in the `afx ide start` shell does **not** reach the spawned server, because Tower (a long-running daemon) spawns it as its own child. So the extensions directory must be an argument Tower passes.

## Desired State

After `npm i -g @cluesmith/codev @cluesmith/codev-ide`:

1. `afx ide start` with no flags finds `codev-ide-server`, starts it through Tower, and the browser IDE at `/ide/` shows the Codev sidebar matching the installed codev version.
2. `--server-path <bin>` still works and takes precedence over discovery.
3. A server below the minimum version Tower supports is refused with a message naming the installed version, the required floor, and how to upgrade.
4. The sidebar comes from `@cluesmith/codev` itself (the same vsix published to Open VSX for that version), installed by Tower into a Tower-owned extensions directory on every start. A codev upgrade upgrades the sidebar on the next start, with no manual step. The server package ships no sidebar copy.
5. If the server is not installed, the error says exactly what to run (`npm i -g @cluesmith/codev-ide`, or `afx ide install`).
6. Optionally, `afx ide install` runs that npm command for the user and reports the result.
7. `afx ide status` shows enough to diagnose the pairing: server path and version, and the extensions directory with the installed sidebar version.

## Success Criteria

- [ ] The published `@cluesmith/codev` tarball (`pnpm pack` output) contains the sidebar vsix for the same version as the package, under a fixed package-relative location, and the package build produces it from `apps/vscode` without relying on a globally installed `vsce`.
- [ ] Adding the vsix grows the packed tarball by roughly the vsix size (order of hundreds of KB), not megabytes.
- [ ] `afx ide start` with no `--server-path` locates an npm-installed `codev-ide-server` on PATH and starts it; Tower records the resolved server path.
- [ ] With `codev-ide-server` absent from PATH but `@cluesmith/codev-ide` installed globally next to `@cluesmith/codev`, discovery still succeeds via the global `node_modules` fallback.
- [ ] With no server discoverable, `afx ide start` exits non-zero with a message naming `npm i -g @cluesmith/codev-ide` (and `afx ide install` if shipped) and `--server-path` as the override. Tower is not asked to spawn anything.
- [ ] `--server-path <bin>` overrides discovery, and the existing behaviour for a nonexistent path (clear error) is preserved.
- [ ] Before spawning, Tower runs `<server> --version`. A version below the declared floor is refused (no spawn, no record written) with an error naming the installed version and the floor. A server whose `--version` fails or is unparseable is refused with an error saying so. The floor lives in one place in the code.
- [ ] Before spawning, Tower installs the embedded vsix into the Tower-owned extensions directory (default `~/.agent-farm/ide-extensions`) using the server's own CLI (`--install-extension <vsix> --extensions-dir <dir>`). When that exact sidebar version is already installed there, the install is skipped (no server CLI invocation for the install).
- [ ] Tower spawns the server with `--extensions-dir <dir>` explicitly, on **every** spawn path: `afx ide start`, boot reconcile, and on-demand respawn.
- [ ] Other extensions a user installed into the Tower-owned directory survive a sidebar install or upgrade.
- [ ] A failed sidebar install (server CLI exits non-zero) does not leave Tower wedged: the start reports the failure clearly. (Whether it blocks the spawn is settled in the plan per Open Question 4.)
- [ ] `afx ide status` reports the server version and the extensions directory (and installed sidebar version when known), in addition to today's fields.
- [ ] Existing #1668 behaviour is unchanged: `/ide/` forward, auth, connection token, record file, stop, restart reconcile, respawn.
- [ ] If shipped, `afx ide install` runs `npm i -g @cluesmith/codev-ide` in the user's shell environment, streams or summarizes npm's output, and exits with npm's status; on success it reports the installed server version.
- [ ] Unit tests cover discovery order, version parsing/floor comparison, install-skip idempotency, and argument construction (including `--extensions-dir` on all spawn paths). A real end-to-end run (npm-installed server, sidebar visible in the browser IDE through Tower) is verified before the PR is called done.

## Constraints

### Target shape (decided with the owner; treated as fixed)

From Issue #1789 "Target shape (decided with the owner)". These are not relitigated here:

- `@cluesmith/codev` stays the lightweight package (CLI + Tower + dashboard) and additionally **carries the sidebar vsix** (`apps/vscode` build output, ~350 KB, the same file published to Open VSX).
- `@cluesmith/codev-ide` is a thin meta-package (bin `codev-ide-server`) with one `optionalDependencies` entry per platform (`@cluesmith/codev-ide-server-darwin-arm64`, `-linux-x64`, ..., `os`/`cpu` gated). **No npm dependency in either direction** between `@cluesmith/codev` and `@cluesmith/codev-ide` (peer deps under `npm i -g` install a second private copy of codev; avoided deliberately).
- Install: `npm i -g @cluesmith/codev @cluesmith/codev-ide`.
- Tower (not the user's shell) passes `--extensions-dir`, because environment set on `afx ide start` does not reach a Tower-spawned server.
- The sidebar is installed with the server's own CLI (`--install-extension <vsix> --extensions-dir <dir>`), idempotently, into a Tower-owned directory. The server package ships no copy of the sidebar.
- `--server-path` remains as an override.

### Existing-system constraints

- **Tower is the spawner** (#1668). All spawn paths (CLI-driven start, boot reconcile, on-demand respawn) go through one Tower-side function, so anything that must hold for every spawn (version check, `--extensions-dir`) belongs there, not in the CLI alone.
- **No config file, no `global.db` change** (#1668 §D3). IDE runtime state lives in Tower's `~/.agent-farm/ide-server.json`. New runtime facts (server version, extensions directory) extend that record; no new config surface.
- Tower is a long-running daemon whose environment (including `PATH`) is whatever it was started with, which may differ from the user's current shell.
- The `/api/ide` endpoint is local-only and key-authed; it spawns processes and must stay blocked from the tunnel.
- The vsix must be byte-for-byte the same artifact class as the one published to Open VSX for that version (same build, same `vsce package --no-dependencies`), so the sidebar the IDE shows is the released sidebar.
- `packages/codev` is product code, not a framework file: the `codev/` ↔ `codev-skeleton/` mirror rule does not apply. The `afx` skill docs (four shipped copies) and command reference docs do need updating for the changed `afx ide` surface.
- Windows is out of scope (no Windows server builds).

## Assumptions

- The IDE repository publishes `@cluesmith/codev-ide` with a `codev-ide-server` bin, and per-platform packages, in the shape above. Building and publishing those is out of scope here.
- `codev-ide-server` accepts the standard VS Code server CLI: `--version`, `--install-extension <vsix>`, `--extensions-dir <dir>`, `--list-extensions --show-versions` (verified for `--version` and `--extensions-dir` in the PoC; `--install-extension` with `--extensions-dir` is standard VS Code server behaviour).
- `codev-ide-server --version` prints a semver-parseable version on its first line (VS Code server convention: version, commit, arch on three lines). **What that version denotes** (the VS Code base version vs the npm package version) is Open Question 1.
- `@cluesmith/codev` and `apps/vscode` (`codev-vscode`) are versioned in lockstep (both 3.3.4 today), so "the vsix for this codev version" is well defined.
- An `npm i -g` places `@cluesmith/codev` and `@cluesmith/codev-ide` as siblings under the same global `node_modules/@cluesmith/`, and the `codev-ide-server` shim in the same global `bin` directory as `afx`.
- The npm bin shim for `codev-ide-server` is a Node script; Tower's spawn environment has a usable `node` (Tower itself runs on Node).

## Solution Approaches

The open design choices are (A) where server discovery runs and (B) where/when the sidebar install runs. Embedding the vsix and the version floor are fixed by the issue; their mechanics are plan-level.

### Approach 1: Discovery in the CLI, version check + sidebar install in Tower's spawn path (recommended)

- `afx ide start` (running in the user's shell) resolves the server: `--server-path` if given, else `codev-ide-server` on the user's `PATH`, else the global `node_modules` fallback (a sibling of the running codev install, then `npm root -g`). It sends the resolved absolute path to Tower exactly as today; the `/api/ide` contract is unchanged except that new fields appear in responses.
- Tower's single spawn function gains two pre-spawn steps used by every spawn path: run `<server> --version` and enforce the floor; install the embedded vsix into the Tower-owned extensions directory if that sidebar version is not already there. It then spawns with `--extensions-dir <dir>` and records the server version and extensions directory.

**Pros:** discovery uses the user's PATH, which is what the user means by "on PATH" (Tower's daemon PATH may be stale or minimal, e.g. a Tower started before the user installed the server or from a non-login context). The `/api/ide` contract stays backward compatible. Version check and `--extensions-dir` cover respawn and boot reconcile for free, so a server upgraded in place (same shim path) is re-checked on its next respawn, and a codev upgrade refreshes the sidebar on the next spawn. One place owns "what a spawn means".

**Cons:** discovery logic lives in the CLI while the check lives in Tower; two places to read. Boot reconcile depends on the recorded path still existing (same as today).

**Risk/complexity:** low. Mostly additive to existing functions.

### Approach 2: Everything in Tower (discovery, check, install)

The CLI sends no path when `--server-path` is absent; Tower discovers `codev-ide-server` on its own PATH / global `node_modules`.

**Pros:** one module owns the whole lifecycle; any future non-CLI caller (dashboard "Start IDE" button, VS Code command) gets discovery without duplicating it.

**Cons:** Tower's PATH is the daemon's, captured at Tower start. A user who installs the server after starting Tower, or whose Tower was started by a launcher without the npm global bin on PATH (nvm-managed Node is the common case), gets "not found" for a binary that `which` finds in their shell. That is exactly the confusing failure this issue removes. Changes the `/api/ide` contract (serverPath optional).

**Risk/complexity:** low code, but a real UX failure mode.

### Approach 3: Sidebar install in the CLI instead of Tower

The CLI runs `codev-ide-server --install-extension` before calling Tower.

**Pros:** install output appears directly in the user's terminal.

**Cons:** boot reconcile and on-demand respawn never install, so after a codev upgrade + Tower restart the respawned server runs a stale sidebar until the user re-runs `afx ide start`. Contradicts "Tower installs ... on every start" in the issue and splits spawn semantics.

**Risk/complexity:** low code, wrong ownership. Rejected.

**Recommendation: Approach 1.** It honors the user's PATH for discovery (the user-visible promise) and keeps every invariant of a spawn in Tower's single spawn function. Approach 2's "future non-CLI caller" benefit can be recovered later by having Tower fall back to its own discovery when no path is sent, without changing this design.

### Sub-decision: embedding the vsix

The codev package build produces the vsix from `apps/vscode` (`vsce package --no-dependencies`, with `@vscode/vsce` as a declared dev dependency rather than a global tool) and copies it to a fixed package-relative directory listed in `files`. Tower locates it relative to its own install, as it already does for `dashboard-dist` and `skeleton`. Alternative considered: download the vsix from Open VSX at start time. Rejected: requires network, breaks offline installs, and decouples sidebar version from codev version, which is the coupling we want.

### Sub-decision: idempotency check

"Already installed" means the extensions directory contains the codev sidebar at exactly the embedded vsix's version (read from the vsix manifest or a build-time constant, compared against the directory's installed-extension metadata or `--list-extensions --show-versions`). Any other version (older or newer) triggers an install with overwrite semantics, so a codev downgrade also downgrades the sidebar. Only the codev sidebar is touched; other extensions in the directory are left alone.

## Open Questions

### Critical (blocks progress)

1. **What does `codev-ide-server --version` report, and what is the initial floor?** If it reports the VS Code base version (e.g. `1.128.x`), the natural floor is the sidebar's `engines.vscode` minimum, and the two stay consistent by construction. If it reports the npm package version of `@cluesmith/codev-ide` (an independent scheme), the floor is a separate constant agreed with the IDE repo. *Proposed default if unanswered:* parse the first line as semver; floor is a single constant in Tower; initial value set to the first published `@cluesmith/codev-ide` version the owner names. Needs the architect / IDE repo to confirm the output format.

### Important (shapes design)

2. **`afx ide start` when a server is already live.** Today a live server on the port is adopted without respawn. If the sidebar was just upgraded, or the live server was spawned by an older Tower without `--extensions-dir`, adopting it leaves the user on the old sidebar. *Proposed:* still run the install, never silently kill a live server (it may have open sessions), and print a clear hint that `afx ide stop && afx ide start` is needed to load the new sidebar. Alternative: an explicit `--restart` flag.
3. **Discovery fallback order and depth.** Proposed order: `--server-path` → `PATH` → sibling of the running codev install in global `node_modules` → `npm root -g` (a subprocess, last resort). Should the recorded path be the PATH shim (follows in-place npm upgrades) or its resolved real path? *Proposed:* the shim, so `npm i -g` upgrades take effect on the next respawn.
4. **Sidebar install failure policy.** If `--install-extension` fails, should Tower refuse to spawn (strict: the IDE without its sidebar is broken) or spawn with a warning (lenient: the IDE is still usable)? Same question when the vsix is missing from the package (e.g. a source checkout run via `tsx` without a build). *Proposed:* missing vsix → warn and spawn (developer path); install command failure → refuse with the server CLI's stderr in the error.
5. **Is `afx ide install` in scope for this PR?** Marked optional in the issue. *Proposed:* include it; it is small (one `npm i -g` invocation in the user's shell, report the result and resulting `--version`), and it gives the "not found" error a one-command remedy.

### Nice-to-know

6. Should the extensions directory be overridable (flag or record field)? *Proposed:* no; fixed Tower-owned default, recorded in the IDE record for status/diagnostics.
7. Same-version-different-bytes (local dev builds of the vsix that did not bump the version) will be skipped by a version-only idempotency check. Acceptable for releases; developers can delete the directory or the plan can add a content hash if cheap.
8. Should `afx ide status` / `afx doctor` also warn when the installed server is below the floor without starting it? Nice diagnostic; not required.

## Test Scenarios

**Packaging**
1. Build `@cluesmith/codev`, `pnpm pack`, list the tarball: the vsix is present at the fixed location, its manifest version equals the package version, tarball growth ≈ vsix size.
2. A clean environment without a global `vsce` can still run the package build.

**Discovery**
3. `--server-path` given: used as-is, discovery not consulted; nonexistent path → existing clear error.
4. No flag, `codev-ide-server` on PATH → resolved to that path.
5. No flag, not on PATH, present as a sibling global package → resolved via the fallback.
6. No flag, nowhere → non-zero exit, message names `npm i -g @cluesmith/codev-ide` / `afx ide install` / `--server-path`; no request sent to Tower.

**Version handshake**
7. `--version` ≥ floor → proceeds. Equal to floor → proceeds.
8. `--version` < floor → refused; error names installed version and floor; no process spawned; no record written.
9. `--version` exits non-zero, times out, or prints unparseable output → refused with a clear error.
10. Respawn path (boot reconcile / on-demand) also runs the check; a server downgraded in place below the floor is not respawned, and the failure is logged.

**Extensions handover**
11. Empty extensions directory → install invoked with `--install-extension <embedded vsix> --extensions-dir <dir>`, then spawn args include `--extensions-dir <dir>`.
12. Same sidebar version already installed → no install invocation; spawn still passes `--extensions-dir`.
13. Older (or newer) sidebar installed → install runs and replaces it; an unrelated extension in the directory is untouched.
14. Install command fails → behaviour per Open Question 4, with stderr surfaced.
15. Boot reconcile and on-demand respawn both pass `--extensions-dir` (argument construction asserted in unit tests).
16. Live server adopted → behaviour per Open Question 2.

**Status / install**
17. `afx ide status` shows server version and extensions directory (and sidebar version).
18. `afx ide install` success → reports installed version; npm failure (e.g. EACCES on a system Node) → non-zero exit with npm's message.

**End-to-end (real user path, before PR is called done)**
19. On macOS arm64: `npm i -g` the packed `@cluesmith/codev` tarball plus `@cluesmith/codev-ide`; restart Tower; `afx ide start` with no flags; open `http://localhost:4100/ide/?folder=<repo>` in a browser (Playwright); the Codev sidebar renders and its version matches codev's.
20. Regression: the #1668 suites (`ide-record`, `ide-forward-integration`, routes/websocket auth) stay green.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Tower's daemon PATH lacks the npm global bin, so a Tower-side lookup misses the server | High (nvm users) | High | Discovery runs in the CLI with the user's PATH (Approach 1); Tower receives an absolute path |
| The npm bin shim needs `node` on Tower's spawn PATH | Low | Medium | Tower runs on Node; verify in E2E; if needed, prepend the directory of `process.execPath` to the spawn PATH |
| Adding vsix packaging (lint + type-check + esbuild + vsce) to the codev build slows CI and couples the builds | Medium | Low | Run vsce from the already-built extension output where possible; declare `@vscode/vsce` as a dev dependency so CI does not need a global install |
| The vsix in the npm tarball drifts from the one published to Open VSX | Low | Medium | Both produced by the same `vsce package --no-dependencies` from the same commit at release; release protocol notes the coupling |
| Sidebar's `engines.vscode` floor exceeds the installed server's VS Code base, so the server refuses to activate the sidebar | Medium | High | Version floor (Open Question 1) set at or above the sidebar's engine requirement when the server reports a VS Code version; status shows both versions |
| Installing a new sidebar into a directory a live server is using | Medium | Low | Never kill a live server silently; print a restart hint (Open Question 2) |
| `--install-extension` latency on every start | Low | Low | Version-equality skip makes the common case a cheap metadata read |
| Version check refuses a server that would have worked (floor too strict, or output format changes) | Low | Medium | Floor in one constant, easy to adjust; the check applies to `--server-path` too, so the error tells the user to upgrade rather than inviting a bypass; output format confirmed with the IDE repo (Open Question 1) |

## References

- Issue #1789 (this work); proof-of-concept notes in the issue body.
- Issue #1668 / `codev/plans/1668-tower-forward-a-sub-path-to-a-.md`: `/ide/` forward, `afx ide` lifecycle, `~/.agent-farm/ide-server.json` record, decisions §D1–§D5.
- Plan #1144 (`codev/plans/1144-vscode-ide-mode-foundation-dua.md`): extension IDE mode.
- `apps/vscode/scripts/publish.sh`: how the released vsix is packaged (single `vsce package --no-dependencies`, published to both registries).
- VS Code server CLI: `--version`, `--install-extension`, `--extensions-dir`, `--list-extensions --show-versions`.
