# Review: Tower-managed Codev IDE server from npm

## Summary

`afx ide start` now works with no flags after `npm i -g @cluesmith/codev @cluesmith/codev-ide`. The codev package ships the sidebar vsix. The CLI discovers `codev-ide-server` on the user's PATH or in the global `node_modules`. On every spawn path, Tower checks the server's version against a floor, installs the embedded sidebar into a Tower-owned `~/.agent-farm/ide-extensions`, and starts the server with `--extensions-dir`. Six plan phases shipped as commits in one PR, verified end to end on an isolated Tower (Scenario 21).

## Spec Compliance

**Packaging**
- [x] The packed tarball carries `ide-extension/codev-vscode.vsix` plus `manifest.json` (id, version, engine range), built from `apps/vscode` with a declared `@vscode/vsce` devDependency (Phase 1).
- [x] The tarball grows by about 343 KB (3,127,626 → 3,478,353 bytes) (Phase 1).

**Discovery**
- [x] With no `--server-path`, PATH lookup returns the absolute bin link (Phase 5).
- [x] Global `node_modules` fallback, first as a sibling of the running install, then `npm root -g` (Phase 5).
- [x] Nothing found: non-zero exit naming `afx ide install`, `npm i -g @cluesmith/codev-ide` and `--server-path`, with no Tower request sent (Phase 5).
- [x] `--server-path` overrides discovery and keeps the nonexistent-path error (Phase 5).

**Version handshake**
- [x] `--version` runs under a hard bound (own timer, SIGKILL of the process group, pipes destroyed). Only line 1 is parsed, as strict semver. A lower version, a failure, a timeout or unparseable output is refused with nothing spawned or recorded (Phases 2 and 4).
- [x] Floor `1.128.0` is a single constant, with a test tying it to the sidebar's `engines.vscode` minimum (from both `apps/vscode/package.json` and the embedded manifest when built) (Phase 2).

**Extensions handover**
- [x] Tower reads `extensions.json` first and skips the subprocess when the embedded version is already indexed. Otherwise it runs `--install-extension <vsix> --force --extensions-dir <dir>` under a 60 s bound (Phase 3).
- [x] `--extensions-dir` is passed on start, boot reconcile and on-demand respawn (Phase 4).
- [x] Unrelated extensions survive: covered by unit tests and by a real server in Scenario 21 (Phases 3 and 6).
- [x] The directory is created 0700 with an explicit chmod. Tower refuses a symlink (dangling included), a non-directory, or a directory owned by another uid (Phase 3).
- [x] An install failure refuses the spawn and surfaces stderr. The built-in-sidebar hint appears only when the CLI itself failed (Phase 3).
- [x] A missing embedded vsix logs a warning and the spawn still passes `--extensions-dir` (Phases 3 and 4).

**Transactional start**
- [x] The preflight runs before any stop or replace. A failed preflight on a port change leaves the live server and its record untouched (Phase 4; also observed in Scenario 21 with a below-floor bin).
- [x] Starts, stops and respawns are serialized by one non-reentrant lock at the entry points (Phase 4).

**Live server**
- [x] Tower installs but never kills a live server. `restartRequired` compares the live record's server path, server version, extensions dir and sidebar version with the preflight's result, and the CLI prints `afx ide stop && afx ide start`. The adopted record keeps the live process's own values (Phases 4 and 5; completed in the review round).

**Spawn environment**
- [x] `dirname(process.execPath)` is moved to the front of the spawned server's PATH, with no duplicates (Phase 2, wired in Phase 4).

**Record compatibility**
- [x] `serverVersion`, `extensionsDir` and `sidebarVersion` are optional, and legacy records still parse and are adopted (Phase 4).
- [x] `--default-folder` is retired end to end, and a record still carrying `defaultFolder` parses with the field ignored (review round, owner ruling 2026-10-21).

**Status and install**
- [x] `afx ide status` shows the server version, extensions dir and sidebar version. A legacy record shows `unknown` (Phase 5).
- [x] `afx ide install` runs npm in the user's environment, inherits stdio, exits with npm's status and reports the installed version (Phase 5).

**Regression and verification**
- [x] The #1668 suites stay green (`ide-record`, forward integration, routes, websocket auth) (all phases).
- [x] The unit tests the spec lists exist: `ide-extension-packaging`, `ide-version`, `ide-extensions`, `ide-server-preflight` and `ide-command` tests, plus an `ide-record` legacy case (Phases 1 to 5).
- [x] Scenario 21 ran end to end on macOS arm64 with Playwright: the sidebar rendered at version 3.3.4 (= codev), then 3.3.5 after an upgrade and restart (Phase 6). It used the spec's sanctioned fallback because `@cluesmith/codev-ide` is not on npm yet: a local 1.135.0 server tree with the built-in sidebar removed, exposed on a scratch PATH so discovery was still exercised.

**Documentation**
- [x] `## afx ide` is in all four afx skill copies, and `### afx ide` is in `codev/resources/commands/agent-farm.md` and its skeleton twin. The record shape and lifecycle in arch.md §"IDE prefix forward" are updated (Phase 6).

## Deviations from Plan

- **Phase 1, no `CODEV_SKIP_IDE_EXTENSION`** (owner ruling, 2026-10-13). The vsix step costs about 5.4 s warm, which does not justify a second build shape, so every `pnpm build` produces the vsix.
- **Phase 1, no version-equality check between the vsix and codev** (owner ruling, 2026-10-13). The two come from the same build and commit, so they are compatible by construction, and RCs are no longer used. `verify-install.mjs` checks presence and a well-formed manifest only. The spec and plan were amended to match.
- **Phase 1, vsce pinned to `^3.9.2`.** vsce 4.x requires Node 22 and CI runs Node 20. `vsce package` never loads vsce's Node-22 Azure dependencies (they are publish-only); verified under Node 20.20.2.
- **Phase 3, a successful install re-reads `extensions.json` and throws** if the embedded version is still not indexed. The plan had a benign "reinstall next time" fallback here. A zero-exit install that did not take would otherwise start a server without its sidebar. Scenario 21 confirmed the check passes against a real server.
- **Phase 3, the bounded runner was extracted** into `runIdeServerCommand` (process group, SIGKILL on timeout, capped stderr), shared by `--version` and `--install-extension`.
- **Phase 4, adopt keeps the prior `sidebarVersion`** (the plan named only the server version and extensions dir), so the record describes what the live process actually loaded. (It also kept the prior `defaultFolder` until that field was retired; see below.)
- **Phase 5, `restartRequired` also compares the server path** (Phase 4 CMAP carry-over), because discovery can pick a different bin than an earlier `--server-path`.
- **Review round, the adopt rule now covers the whole record.** The adopted record keeps the live `serverPath`, and `restartRequired` also compares the server version, so an in-place `npm i -g` upgrade is flagged and the hint persists until a restart. Stdout from server CLI calls is capped at 64 KB. Docs say where extra extensions go, and the RELEASE protocol has a pre-flight check for the floor coupling.
- **Review round, `--default-folder` retired end to end** (owner ruling, 2026-10-21, relayed by main from the codev-ide architect). Tower manages several workspaces, so a single default folder makes no sense: the IDE opens the folder chosen per connection (`?folder=` on `/ide/`). Removed the `afx ide start` option, the CLI-to-Tower body field, the spawn argument, the record field and its status line, and the adopt/respawn plumbing. A record on disk that still carries `defaultFolder` (from #1668 or earlier runs of this branch) parses, and the field is ignored (tested). The spec gains Desired State 8 and a success criterion. Deriving the folder from Tower's workspace registry is a follow-up for main to file.
- **Phase 6, `docs/releases/UNRELEASED.md` was not edited.** Its header reserves entries for the architect on `docs/vscode-changelog`. The suggested wording is in the thread and the PR body.
- **Phase 6, the skeleton command reference was mirrored** (`codev-skeleton/resources/commands/agent-farm.md`). The spec named only the root copy; Claude's CMAP flagged the parity gap.
- **Phase 6, Scenario 21 ran on an isolated Tower** (port 4199, scratch `CODEV_AGENT_FARM_DIR`) per the architect's ruling, not on a restarted real Tower. The real Tower and IDE PIDs were unchanged before and after.

## Consultation Feedback

### Specify Phase (Round 1)

#### Gemini (APPROVE)
- **Concern**: use `--force` to replace a sidebar → **Addressed**: adopted (verified that a downgrade requires it).
- **Concern**: timeouts, idempotency from metadata with no subprocess, 0700 directory → **Addressed**: all became success criteria.

#### Codex (REQUEST_CHANGES)
- **Concern**: resolve what `--version` reports, and the floor → **Addressed**: verified it is the VS Code base version. The floor is a Tower constant tied to `engines.vscode`.
- **Concern**: decide live-server, install-failure and `afx ide install` behaviour → **Addressed**: decided in Decided sub-points.
- **Concern**: artifact identity → **Addressed**: same commit, command and version; byte identity not required.
- **Concern**: transactional failure; coverage for replacement failure, legacy records, timeouts and concurrency → **Addressed**: new criteria and test scenarios 15, 19, 20, 22 and 23.
- **Concern**: extensions-dir security → **Addressed**: 0700, with symlinks and foreign owners refused.

#### Claude (COMMENT)
- **Concern**: `--install-extension` behaviour unverified → **Addressed**: verified against a real server, which surfaced the built-in-sidebar refusal (recorded as an IDE-repo requirement).
- **Concern**: inconsistent PATH risks; record backward compatibility; bounded timeouts; documentation scope; bin-link assumption; conditional criteria → **Addressed**: all folded into the spec.

### Plan Phase (Round 1)

#### Gemini (APPROVE)
- **Concern**: lock re-entrancy note → **Addressed**: same fix as Codex and Claude.

#### Codex (REQUEST_CHANGES)
- **Concern**: lock re-entrancy deadlock → **Addressed**: a non-reentrant lock at the three entry points, with unlocked inner bodies.
- **Concern**: the CLI's 30 s timeout is shorter than the preflight budget → **Addressed**: a derived `IDE_START_BUDGET_MS`.
- **Concern**: prerelease comparison → **Addressed**: a suffix on line 1 is refused as unparseable.

#### Claude (REQUEST_CHANGES)
- **Concern**: lock deadlock; timeout budget → **Addressed** (as above).
- **Concern**: build blast radius → **Addressed** in the plan (later superseded by the owner's no-skip-flag ruling).
- **Concern**: skill parity wording; minor points (Scenario 16, null prior record, case-insensitive id, chmod) → **Addressed**.

### Plan Phase (Round 2)

#### Gemini (APPROVE), Claude (APPROVE), Codex (COMMENT)
- **Concern**: budget formula; import cycle → **Addressed**: every bound named, doubled for one queued wait, constants moved to `ide-version.ts`.
- **Concern**: an import-safe manifest helper (Codex) → **Addressed**.
- **Concern**: a below-floor server path while a live server runs (Claude) → **Addressed**: the start fails transactionally (tested).

### Phase 1 (Rounds 1 and 2)

#### Gemini (APPROVE ×2)
- No concerns raised.

#### Codex (REQUEST_CHANGES, then COMMENT)
- **Concern**: the pre-release exemption weakens the spec's lockstep → **Addressed** by owner ruling: the equality check was removed and the spec amended.
- **Concern**: vsce 3.9.2's Azure dependencies need Node 22 while CI runs Node 20 → **Rebutted**: those dependencies are publish-only; packaging verified under Node 20.20.2.

#### Claude (APPROVE ×2)
- **Concern**: the plan still described the skip flag → **Addressed**.
- **Concern**: phase 3 must not import the unshipped `.mjs` → **Addressed**: constants redeclared in `src/` with a parity test.
- **Concern**: `rmSync` before vsce discards the last good vsix → **Rebutted**: intended, since a failed build must not ship a stale vsix.
- **Concern**: duplicated path literals in verify-install → **Addressed**.

### Phase 2 (Rounds 1 and 2)

#### Gemini (APPROVE ×2)
- No concerns raised.

#### Codex (REQUEST_CHANGES, then APPROVE)
- **Concern**: the Node dir is not moved to the front when it is already later on PATH → **Addressed**.
- **Concern**: the strict parser accepts leading zeroes → **Addressed**.

#### Claude (COMMENT, then APPROVE)
- **Concern**: the `execFile` timeout is SIGTERM-based, not a hard bound → **Addressed**: own timer, SIGKILL, pipes destroyed (a grandchild holding stdout is covered by a test).
- **Concern**: tautological floor-tie assertion; `compareVersions` returning NaN → **Addressed**.
- **Concern**: the 190 s start budget → **Rebutted**: the formula is the plan's, and the CLI prints a progress line.
- **Concern** (round 2, non-blocking): share the bounded runner, kill the process group, cap the quoted line, reject with an Error → **Addressed** in Phase 3.

### Phase 3 (Round 1)

#### Gemini (APPROVE), Codex (APPROVE)
- No concerns raised.

#### Claude (APPROVE)
- **Concern**: the built-in-sidebar hint also appeared on the zero-exit index-mismatch path, where it misleads → **Addressed** (`47acd38ee`).
- **Concern**: the post-install re-verification throws instead of falling back → **N/A**: kept on purpose (see Deviations) and verified against a real server in Phase 6.
- **Concern**: duplicated `LogFn` → **Addressed** in Phase 4 (exported once). `defaultLog` routing and the pid-reuse window → **N/A**: nits, no action required.

### Phase 4 (Rounds 1 and 2)

#### Gemini (COMMENT, then APPROVE)
- Round 1: `CONSULT_ERROR`-equivalent skip (agy produced no output). Round 2: no concerns raised.

#### Codex (REQUEST_CHANGES, then APPROVE), Claude (REQUEST_CHANGES, then APPROVE)
- **Concern**: `restartRequired` used only this start's install outcome, so a second start after an unrestarted upgrade reported `false` → **Addressed** (`25808d453`): `liveServerIsCurrent` compares the record with the preflight.
- **Concern** (Claude): an extensions-dir mismatch was not treated as stale; adopt dropped the prior `defaultFolder` → **Addressed**.
- **Concern** (Claude, round 2): adopt does not flag a changed `--server-path` → **Addressed** in Phase 5.
- **Concern** (Claude, round 2): the lock spans the 15 s readiness wait → **N/A**: bounded, and the CLI budget covers one queued operation.

### Phase 5 (Round 1)

#### Gemini (APPROVE), Codex (APPROVE)
- No concerns raised.

#### Claude (APPROVE), non-blocking
- **Concern**: the server-path restart hint is one-shot (adopt writes the new path but keeps the prior version) → **N/A**: carried to Follow-up Items.
- **Concern**: `afx ide stop` can wait up to the start budget with no progress line → **N/A**: Follow-up Items.
- **Concern**: pre-existing `--port abc` parses to NaN, so Tower falls back to 8200 → **N/A**: pre-existing, Follow-up Items.

### Phase 6 (Round 1)

#### Gemini (APPROVE), Codex (APPROVE)
- No concerns raised.

#### Claude (COMMENT)
- **Concern**: the skeleton command reference lacks `### afx ide` → **Addressed** (`3b3ac9f8c`).
- **Concern**: the phase 4 rebuttals file was untracked → **Addressed**: committed.
- **Concern**: the UNRELEASED wording was not recorded → **Addressed**: it is in the thread and the PR body.
- **Concern**: "up to a minute" understates the worst-case budget → **Addressed**: now "a minute or more".
- **Concern**: the screenshots are ephemeral → **N/A**: the thread's textual record is the durable evidence.

### Review Phase (Round 1, PR #1806)

#### Gemini (APPROVE)
- No concerns raised.

#### Codex (REQUEST_CHANGES)
- **Concern**: `liveServerIsCurrent` never compares the server version, so a same-path `npm i -g` upgrade gets no restart hint → **Addressed**: version comparison added; the fixture that asserted the defect was flipped; new same-path-upgrade test.
- **Concern**: adopt writes the requested `serverPath` with the live process's version, so the changed-path hint is consumed on first use → **Addressed**: adopt keeps the live `serverPath`; new changed-path-twice test.
- **Concern**: `runIdeServerCommand` buffers stdout without limit → **Addressed**: 64 KB cap and a flooding-server test.

#### Claude (APPROVE)
- **Concern**: the one-shot hint and a status that mixes two binaries → **Addressed** (as Codex above).
- **Concern**: an existing extensions dir is not tightened to 0700 → **N/A**: matches the spec; a hardening follow-up at most.
- **Concern**: the preflight installs into a live server's extensions dir → **N/A**: by design, flagged by `restartRequired`.
- **Concern**: the build couples CI jobs to apps/vscode health → **N/A**: owner ruling (phase 1).

#### Architect integration review (main, round 1)
- **Concern**: the Codex headline item → **Addressed** (above).
- **Concern**: tell #1668 users where extensions now go → **Addressed**: one paragraph in both command references and the four afx skill copies.
- **Concern**: a release-time guard for the floor coupling → **Addressed**: a pre-flight check in `codev/protocols/release/protocol.md` (the skeleton carries no RELEASE protocol).

## Lessons Learned

### What Went Well
- Verifying the server CLI directly while writing the spec settled the critical open question and found two facts no reviewer could have known: a downgrade needs `--force`, and a server that bundles the sidebar as a built-in refuses to install it. That second fact became an explicit requirement on the IDE repo.
- One spawn function owning the preflight meant reconcile and respawn got the version check, the install and `--extensions-dir` with no extra wiring.
- Phase-scoped CMAP caught the `restartRequired` state-versus-action defect before it reached a user.
- The isolated-Tower E2E was fully real (packed tarballs, a real server, Playwright) without touching the live Tower.

### Challenges Encountered
- **Lock design.** Spawn, stop and respawn call each other, so a naive per-function lock deadlocks. Plan CMAP caught this before any code existed; the fix was entry-point-only locking with a re-read inside the lock.
- **Hard timeouts.** `execFile`'s timeout sends SIGTERM and still waits for stdio to close, so a grandchild that holds stdout hangs the call. The fix was an own timer that kills the process group and destroys the pipes.
- **The `afx ide` CLI is hardwired to Tower port 4100.** Isolating the E2E needed a patched scratch install.
- **Flaky session-manager tests** failed porch's `tests` check intermittently, and porch printed only stderr, so the failing test was unnamed (#1800, #1801). A bounded repro loop named it.

### What Would Be Done Differently
- Model the "live process versus desired state" comparison explicitly in the plan, for every field of the record, rather than deriving `restartRequired` from the install outcome. Fixing one field at a time took three review rounds (sidebar in phase 4, server path in phase 5, server version and the recorded path in the PR review).
- Check every adopter-facing doc twin (skills and command references, root and skeleton) in the plan's doc phase, not only the files the spec lists.

### Methodology Improvements
- Porch's check failure output should include stdout or the failing test name (#1801).
- An `afx ide` Tower-port override (or reuse of the CLI's Tower URL resolution) would make isolated E2E runs need no patching.

## Architecture Updates

- Routed: cold — `codev/resources/arch.md` §"IDE prefix forward (Issue #1668)" — the record gains `serverVersion` / `extensionsDir` / `sidebarVersion` (optional); npm distribution (`@cluesmith/codev-ide`, embedded `ide-extension/`); CLI-side discovery order; Tower preflight (floor, then idempotent sidebar install, then `--extensions-dir` on every spawn path); the entry-point lock; and the floor/`engines.vscode` coupling. Done in Phase 6.
- No hot-tier change: this is subsystem detail, not a cross-cutting invariant every builder needs up front.

## Lessons Learned Updates

- Routed: cold — Architecture — [From #1789] serialize a spawn lifecycle with a non-reentrant lock taken only at the entry points, and re-read state inside it (with a mutation check that proves the lock is load-bearing).
- Routed: cold — Architecture — [From #1789] "does the live process need a restart?" compares the live state with the desired state, never this call's action outcome.
- No hot-tier change: both are narrower than the existing hot lessons, and the hot file is at its cap.

## Flaky Tests

- `packages/codev/src/terminal/__tests__/session-manager.test.ts` › "applies crashLoopFallback after repeated fast failures": `expect(fs.existsSync(sentinel)).toBe(true)` got `false` intermittently under full-suite load (about 1 in 6 runs in a bounded repro). It passes in isolation and is already `skipIf(CI)`. Filed as #1800. Not skipped further; unrelated to this lane.
- Same file › "logs session exit without stderr tail": hit the 15 s timeout under full-suite load (real shellper). It passes 3/3 in isolation and is already `skipIf(CI)`. Same family as #1800.

## Follow-up Items

For the architect to decide whether to file (none were self-filed):
- `afx ide stop` can wait up to `IDE_START_BUDGET_MS` with no progress line when queued behind a start.
- Pre-existing: `afx ide start --port abc` parses to NaN, and Tower silently defaults to 8200.
- Pre-existing (#1668): `afx ide start` prints the launcher script's PID, while `afx ide status` prints the PID listening on the port (its node child).
- The server can list a vsix it failed to scan in `extensions.json`, so Tower's post-install index check would then report success. This is server-side behaviour, seen only with a malformed hand-built vsix.
- The `afx ide` CLI is hardwired to Tower port 4100 (`DEFAULT_TOWER_PORT`), and the sidebar's Tower view defaults to `localhost:4100` even inside an isolated IDE.
- `post-release-e2e`'s verify-install now fails for published versions older than #1789 (no embedded vsix), which is expected after the release shape change.
- Pending release-note wording for `docs/releases/UNRELEASED.md` (architect, on `docs/vscode-changelog`): see the PR body.
