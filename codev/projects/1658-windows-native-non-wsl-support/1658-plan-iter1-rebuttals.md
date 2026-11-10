# Plan iteration 1: rebuttals

Every point was checked against the code before acting. All were accepted. One (Git Bash
order) is accepted as a flag to the architect rather than a silent change, because it touches
an owner ruling. The plan grew from 10 to 11 phases: the old Phase 3 was split, as Claude
suggested.

The "working tree changed" warnings on all three reviews were my own consult log redirects
(`.gemini.log`/`.codex.log`/`.claude.log` in the project dir). They are deleted and were never
staged.

## Codex (REQUEST_CHANGES)

1. **Git Bash precedence contradicts the ruled order.** Accepted. Phase 5 now uses the literal
   order from ruling 5 and the spec: install locations, then `PATH`, then override. The plan
   notes that this makes the override a last resort, not a winner over an installed Git, and
   raises it with the architect at plan approval. The order changes only on their ruling.
2. **A runtime load error doesn't prevent a source build.** Accepted. Phase 1 now measures each
   native dependency's install-script behavior. Phase 10 adds an install-time guard: narrow
   `engines.node` to the audited set if needed, disable source-build fallback, and have a
   Windows `postinstall` check that fails with the supported versions. A Windows CI test
   installs the packed tarball with `node-gyp` replaced by a failing stub and asserts the stub
   is never called. The owner also checks a toolchain-free global install.
3. **The install/e2e harness is not Windows-aware.** Accepted and verified:
   `verify-install.mjs` builds `<prefix>/bin/<bin>` and shell-quoted `execSync` strings, and
   `post-release-e2e.yml` uses `/tmp`. Phase 11 now names `verify-install.mjs` (`<prefix>\<bin>.cmd`,
   argv arrays) and has the Windows e2e jobs `pnpm pack` the dispatched ref so they test branch
   artifacts, using `runner.temp` and `shell: bash`.
4. **The early `windows.yml` PR is an unresolved prerequisite and conflicts with "one PR".**
   Accepted. It is now an explicit open decision for the architect. The plan is written for
   both outcomes: approved means `targeted` dispatches as written; declined means the owner's
   machine, the PR-gate pass, and a post-merge dispatch. No phase's scope changes either way.

## Claude (REQUEST_CHANGES)

1. **Phase 2's re-attach criterion needs the start-time fix.** Accepted and verified
   (`session-manager.ts` fails closed on a null start time). The Windows reconnect-identity swap
   (WELCOME verification) moved into Phase 2. Phase 2's Windows criterion is reconnect from a
   fresh `SessionManager`; reconnect across a real `afx tower stop`/`start` is in the new Phase 4.
2. **CIM census on the `/health` hot path guards the owner lock.** Accepted and verified (two
   awaits in `tower-routes.ts`; the budget rationale in `tower-owner.ts`). Phase 1 measures CIM
   latency. Phase 3 adds a TTL cache plus single-flight to the Windows provider and re-derives
   the `probeTowerHealth` budget from the numbers. Also added to the risk table.
3. **The census failure contract changes POSIX.** Accepted. Reporting failures is Windows only.
   POSIX keeps `[]`-on-failure, asserted by a test.
4. **Name the census `creationTime` and the husk-sweep seam reshape.** Accepted. Phase 3 names
   both, and a unit test asserts one census call per sweep.
5. **The VS Code resolver home is settled.** Accepted and verified (`apps/vscode` depends only
   on sdk/types/canvas; `packages/codev` depends on `codev-sdk`). The executable resolver now
   lives in `codev-sdk/node`, shared by both, under the sdk boundary test.
6. **`porch/checks.ts` group semantics are half-covered.** Accepted and verified. Phase 3 adds a
   `waitForTreeExit` companion, keeps the 5 s grace on Windows, and states what replaces the
   `detached` grouping (snapshot-tracked tree, `windowsHide`).

Non-blocking comments, all taken:
- Phase 3 split into "Process census and session-tree teardown" (3) and "Tower lifecycle and
  detached survival" (4).
- The dead `killProcess`/`killProcessTree` (no callers, verified) and the `tree-kill` dependency
  are deleted in Phase 3. The executive summary explains calling `taskkill` directly instead of
  the spec's "via tree-kill".
- Phase 10's doctor warns when `CODEV_AGENT_FARM_DIR` moves state outside the user profile.
- Who opens the early workflow PR: the builder, only if the architect asks (see Codex 4).

## Gemini (APPROVE, with watchouts)

All four watchouts were folded in:
- WELCOME's `pid` is the PTY child's PID. Phase 2 adds Windows-only `shellperPid` and
  `sessionId`.
- The #1686 keep-row-if-alive guard would block scenario 5. Phase 2 adds a distinct
  identity-refused result that cleans the row.
- On Windows the pipe path doesn't contain `socketDir`, and JSON escapes backslashes in argv.
  Phase 2 keeps `socketDir` in the shellper config; Phase 3 JSON-unescapes in the matchers.
- `tower.ts` dev-mode `npx`, the `pgrep` force-kill branch, and `tail -f`: Phase 4 handles the
  `pgrep` branch; Phase 6 handles `npx` and replaces `tail -f` with a Node follower.
