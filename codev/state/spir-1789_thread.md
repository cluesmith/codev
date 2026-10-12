# spir-1789 thread

## 2026-10-06 specify
- No spec existed; drafted codev/specs/1789-tower-managed-codev-ide-server.md from the issue + #1668 code (commands/ide.ts, servers/ide-server.ts, lib/ide-record.ts).
- Recommended: discovery in the CLI (user's PATH; Tower daemon PATH may lack npm global bin), version check + sidebar install inside Tower's single spawnIdeServer so start/reconcile/respawn all get --extensions-dir.
- Facts found: apps/vscode `package` script does not produce a vsix (`vsix` script does, via a globally-installed vsce, not a declared dep).
- Critical open question for architect: what `codev-ide-server --version` reports (VS Code base vs npm pkg version) and the initial floor.

## 2026-10-06 specify iter1 CMAP (gemini APPROVE, codex REQUEST_CHANGES, claude COMMENT)
- Verified against a local codev-ide server build (scratch clone, 1.135.0): --version = VS Code base version;
  --install-extension into external --extensions-dir works (~2.2s cold, 0.2s same-version); downgrade NEEDS --force;
  other extensions survive. SURPRISE: if the server tree bundles extensions/codev-vscode as a built-in, install is
  refused ("built-in ... not allowed to be updated"). The pre-npm local build does bundle it -> requirement on IDE repo.
- Resolved in spec: floor = Tower constant test-tied to sidebar engines.vscode min (1.128.0); install failure refuses spawn;
  missing vsix warns; live server never killed (hint restart); afx ide install in scope; transactional preflight;
  serialized spawns; optional record fields; 0700/non-symlink ext dir; Tower adds dirname(process.execPath) to spawn PATH.

## 2026-10-06 spec questions answered by IDE side (via main)
- Floor 1.128.0 accepted; published server excludes built-in codev-vscode (pr43 is the counter-example); first published server reports 1.138.0; parse --version line 1 only, ignore npm package suffix (e.g. 1.138.0-codev.1). Folded into spec.

## 2026-10-13 plan drafted
- Plan written (6 phases: vsix packaging, version handshake, extensions dir/install, transactional preflight in spawnIdeServer, CLI discovery/install/status, docs + E2E).
- Decisions in plan: embedded `ide-extension/{codev-vscode.vsix,manifest.json}`; vsce as apps/vscode devDep run via `pnpm --filter codev-vscode exec`; one promise-chain lock in ide-server.ts; E2E Tower restart needs human OK (isolated Tower offered as fallback).

## 2026-10-13 plan-approval gate reached
- Plan CMAP iter1: gemini APPROVE, codex/claude REQUEST_CHANGES (lock re-entrancy deadlock, CLI 30 s timeout vs preflight budget, build blast radius, skill parity wording). All folded in.
- Iter2: gemini APPROVE, codex COMMENT, claude APPROVE; small refinements folded in (budget formula, import-safe manifest helper, below-floor + live server fails transactionally).
- Waiting on human plan-approval.
- Architect main ruling (2026-10-12): phase 6 E2E uses an isolated Tower (non-default port, separate AGENT_FARM_DIR). Do NOT restart the real Tower; if isolation is insufficient, report why and main asks the owner.

## 2026-10-13 implement phase_1 (embedded sidebar vsix)
- `@vscode/vsce` pinned `^3.9.2` in apps/vscode devDeps (4.x requires Node >= 22; CI runs Node 20). Release-time global vsce is also 3.9.2.
- New `packages/codev/scripts/build-ide-extension.mjs` (runs from `bundle-assets`) + pure `ide-extension-manifest.mjs`; `files` gains `ide-extension`; gitignored.
- Owner ruling (2026-10-13): DROP the planned `CODEV_SKIP_IDE_EXTENSION` CI skip flag. Measured cost of the vsix step is ~5.4 s warm, not worth a second build shape. Every `pnpm build` now produces the vsix; no workflow changes.
- Measured with global vsce off PATH: tarball 3,127,626 -> 3,478,353 bytes (+~343 KB; vsix 342 KB, 25 files). `verify-install.mjs` now asserts the vsix exists and manifest version == package version; passes on packed tarballs.
- Note: post-release-e2e.yml also runs verify-install, so a manual dispatch against a pre-1789 published version would now fail the new check (expected; release shape changed).
- SURPRISE: the spec's "codev and codev-vscode are versioned in lockstep" holds only for stable versions. scripts/bump-all.sh skips apps/vscode for pre-releases (Marketplace rejects semver suffixes), so codev 3.4.0-rc.1 embeds the last stable sidebar. verify-install and the unit test therefore enforce version equality only for stable versions; pre-releases only need a present, well-formed manifest. Functionally fine: Tower's idempotency keys on the manifest version, not the codev version.
- Owner ruling (2026-10-13), superseding the pre-release note above: no version-equality check between the embedded vsix and the codev package at all. Both come from the same build/commit, so they are compatible by construction; RCs are no longer used. verify-install checks only presence + well-formed manifest. Spec and plan amended (equality and skip flag removed).
- Phase 1 iter2: codex flagged vsce 3.9.2's Azure deps (Node >=22) vs CI Node 20. Verified `vsce package` never loads @azure/identity (publish-only) and the vsix build succeeds under Node 20.20.2.

## 2026-10-13: phase_2 (version handshake)
- New `src/agent-farm/lib/ide-version.ts`: floor `1.128.0`, line-1-only strict parser (prerelease on line 1 = unparseable), comparator, `buildIdeServerEnv` (sanitized env + Node dir on PATH), `checkIdeServerVersion` via execFile, and all IDE subprocess bounds (version 10s, install 60s, ready 15s, stop-exit 5s) plus derived `IDE_START_BUDGET_MS`. ide-server.ts now imports ready/stop bounds from it.
- Floor-tie test reads embedded manifest when built, else apps/vscode/package.json, and asserts which source it read.
- Spawn env wiring into ide-server.ts left for phase 3 (plan lists only ide-version.ts for this phase).
- Porch `tests` check failed intermittently twice (porch prints only stderr, so the test was unnamed). Bounded repro loop per main caught it on run 4 of 6: `src/terminal/__tests__/session-manager.test.ts > SessionManager > auto-restart logic > applies crashLoopFallback after repeated fast failures` (10.4s; `expect(fs.existsSync(sentinel)).toBe(true)` at :1430 got false). Already `skipIf(CI)`; unrelated to this lane (no terminal files touched). Reported to main for filing; goes under Flaky Tests in the review.
- phase_2 iter2 CMAP: gemini/codex/claude all APPROVE. Claude's non-blocking notes carried into phase 3: extract the bounded-run (timer + SIGKILL + pipe destroy) into a shared helper for the 60s install call; consider killing the process group so grandchildren are not orphaned; cap the quoted unparseable line 1; reject with an Error-shaped value.

## Phase 3 (2026-10-13): extensions dir + idempotent sidebar install

- New `lib/ide-extensions.ts`: `getIdeExtensionsDir`, `ensureIdeExtensionsDir` (0700 + explicit chmod; refuses symlink incl. dangling, non-dir, foreign uid), `locateEmbeddedSidebar`, `readInstalledExtensionVersion` (case-insensitive id), `ensureSidebarInstalled` (skip when indexed == embedded, else `--install-extension <vsix> --force --extensions-dir <dir>`; re-reads the index after install and throws if the embedded version is still not listed).
- Bounded-run extracted from phase 2's `runVersion` into exported `runIdeServerCommand` in `ide-version.ts` (spawn as own process group, SIGKILL the group on timeout, stderr capped, rejects with an Error subclass). Both `--version` and `--install-extension` use it. Unparseable `--version` line 1 now quoted capped at 200 chars.
- Verified against the real pre-npm server (built-in sidebar): the refusal ("is a built-in extension and not allowed to be updated") goes to stderr, exit 1, so surfacing stderr is the right channel.
- Embedded-layout constants redeclared in src with a parity test against `scripts/ide-extension-manifest.mjs` (the .mjs is not shipped).
- Main filed the session-manager flake as #1800 and the porch stdout defect as #1801.
- Phase 3 full-suite run: build green; 6283 passed, 1 failed: `session-manager.test.ts` "logs session exit without stderr tail" (15s timeout under full-suite load, real shellper, already skipIf(CI)); passes 3/3 in isolation. Same family as #1800; unrelated to phase 3.

## Phase 4 (2026-10-13): transactional, serialized spawn preflight

- `ide-server.ts`: `withIdeLock` (non-reentrant promise chain) at the entry points only: exported `spawnIdeServer` / `stopIdeServer` (the `/api/ide` POST and DELETE) and the respawn body of `ensureIdeServerLive` (boot reconcile reaches it). Unlocked bodies `spawnIdeServerUnlocked` / `stopIdeServerUnlocked` call each other freely. The respawn body re-reads the record inside the lock, so a respawn queued behind a stop does not resurrect the server, and a start queued behind a respawn adopts its result.
- Order in spawn: validate path, preflight (version floor, then sidebar install, which validates the extensions dir), port-change stop, live-port adopt, spawn with `--extensions-dir` and `buildIdeServerEnv()`. Record gains `serverVersion` / `extensionsDir` / `sidebarVersion` (optional; legacy records parse).
- Adopt never kills; `restartRequired` true when the sidebar was just installed, the prior record lacks `extensionsDir`, or there is no prior record on that port. Adopt keeps the prior record's three fields (absent stays absent), including `sidebarVersion` (what the live process loaded), not just the two the plan named.
- `spawnIdeServer` now returns `{ record, restartRequired }`; POST response is `{ ok, ...record, restartRequired }` (additive). `LogFn` exported once from `ide-version.ts`.
- Mutation check: replacing the lock with a pass-through fails the three serialization tests.
- Phase 4 CMAP iter1: codex + claude REQUEST_CHANGES (gemini skipped: agy no output), same defect: `restartRequired` used only this start's install outcome, so a second start after an unrestarted sidebar upgrade reported false. Fixed: adopt compares the record's `sidebarVersion` and `extensionsDir` with the preflight's (`liveServerIsCurrent`); also kept the prior `defaultFolder` on adopt when the start names none (claude minor). Tests for repeated starts, extensions-dir mismatch, missing vsix, default folder.
- Phase 4 CMAP iter2: gemini, codex, claude all APPROVE. Claude non-blocking, carried to phase 5: (1) adopt records the new `opts.serverPath` with the prior `serverVersion`, and a changed `--server-path` against a live server does not set `restartRequired`; consider a path comparison in `liveServerIsCurrent` (status in phase 5 makes the mismatch visible); (2) the lock spans the 15s readiness wait, so `afx ide stop` can queue behind a start (bounded; the CLI budget in phase 5 already doubles for one queued op); (3) run-on line in the `SpawnIdeResult` docstring.

## 2026-10-13: phase 5 (CLI discovery, afx ide install, status)
- commands/ide.ts: resolveIdeServerPath (--server-path, then PATH scan, then sibling @cluesmith/codev-ide of the running install, then `npm root -g`; returns the bin link, not its realpath). ideStart refuses before any Tower request when nothing is found; prints server/sidebar versions and the restart hint. ideInstall runs npm in the user's env, exits with npm's status. Status shows server version, extensions dir, sidebar version ("unknown" for legacy). POST/DELETE timeout = IDE_START_BUDGET_MS, GET 10s.
- Took the phase-4 carry note: adopt now flags restartRequired when the live server was started from a different serverPath (discovery can pick a different bin than an earlier --server-path).
- Tests: __tests__/ide-command.test.ts (fake PATH dirs, fake global node_modules, fake npm script, stubbed http.request).
- Phase 5 CMAP iter1: gemini, codex, claude all APPROVE. Claude non-blocking, for the review doc: (1) the serverPath restart hint is one-shot (adopt writes the new serverPath, keeps the prior serverVersion, so a second start drops the hint and status can pair a path and version from two binaries); (2) `afx ide stop` can wait up to IDE_START_BUDGET_MS with no progress line; (3) pre-existing: `--port abc` parses to NaN and Tower silently defaults to 8200.

## 2026-10-13: phase 6 (docs + Scenario 21 E2E)
- Docs: new `## afx ide` section in the four afx skill copies (same text in each, inserted before `## afx workspace`; root/skeleton tier differences untouched); `### afx ide` in codev/resources/commands/agent-farm.md; arch.md §"IDE prefix forward (Issue #1668)" gains the record fields, npm distribution, CLI discovery, preflight, lock, and the floor/engines coupling sentence.
- UNRELEASED.md NOT edited on this branch: its own header says release-note entries are added per PR by the architect on docs/vscode-changelog, never on main. Suggested entry handed to main with the PR.
- Scenario 21 (macOS arm64), isolated per main's ruling: `@cluesmith/codev-ide` is not on npm yet (404), so the sanctioned fallback: APFS clone of the local 1.135.0 server tree with `extensions/codev-vscode` removed (source tree untouched), exposed as `codev-ide-server` on a scratch PATH dir to exercise discovery (no --server-path). Packed core/sdk/types/codev tarballs `npm i -g --prefix <scratch>`; Tower from that install on port 4199 with CODEV_AGENT_FARM_DIR=<scratch>/af; IDE on 8299. The afx ide CLI hardcodes Tower port 4100 (DEFAULT_TOWER_PORT), so the scratch install's sdk constant was patched to 4199, guaranteeing no call reached the real Tower. Real Tower (4100) and real IDE (8200) PIDs unchanged before/after.
  - `afx ide start -p 8299` (no --server-path): discovered the PATH bin, Server version 1.135.0, Sidebar version 3.3.4 (= codev 3.3.4); `afx ide status` agrees; ide-extensions is 0700. Playwright on http://localhost:4199/ide/?folder=<worktree> (key via codev-tower-key header): Codev activity-bar container renders WORKSPACE/AGENTS/BACKLOG/PULL REQUESTS/RECENTLY CLOSED/TEAM/STATUS; extension details show Version 3.3.4, Source VSIX. Screenshots: /private/tmp/claude-501/-Users-amrmohamed-repos-cluesmith-codev--builders-spir-1789/53ba375a-1069-4791-b27c-8fb460def1b0/scratchpad/pw/scenario21.png, /private/tmp/claude-501/-Users-amrmohamed-repos-cluesmith-codev--builders-spir-1789/53ba375a-1069-4791-b27c-8fb460def1b0/scratchpad/pw/scenario21-extension.png.
  - Unrelated extension survives: installed acme.dummy-ext 0.0.1 into the dir, then swapped the embedded vsix/manifest in the scratch install to a 3.3.5 build. `afx ide start` against the live server: installed 3.3.5, kept the live server, reported Sidebar version 3.3.4 (what it loaded) plus the restart hint. extensions.json then listed acme.dummy-ext 0.0.1 and cluesmith.codev-vscode 3.3.5.
  - `afx ide stop && afx ide start`: Sidebar version 3.3.5; Playwright extension details show Version 3.3.5 (/private/tmp/claude-501/-Users-amrmohamed-repos-cluesmith-codev--builders-spir-1789/53ba375a-1069-4791-b27c-8fb460def1b0/scratchpad/pw/upgrade-3.3.5.png).
  - Not found (no bin on PATH, none in the real global node_modules): exit 1 before contacting Tower, message names afx ide install and --server-path. Below floor (fake bin printing 1.120.0 via --server-path): refused with installed version, floor 1.128.0, and upgrade command; the running 1.135.0 server stayed up (transactional).
- SURPRISE (test-harness only): a malformed hand-built dummy vsix that the server fails to scan still lands in extensions.json, and a retry then demands a VS Code restart. Server-side behaviour, not Tower's; reset the scratch dir and used a well-formed vsix.
- Observation: `afx ide start` prints the PID of the `codev-ide-server` launcher script while `afx ide status` shows the PID listening on the port (its node child). Pre-existing #1668 behaviour (live PID discovered by port); noted for the review.
- Observation: the sidebar in the isolated IDE showed the REAL Tower's workspaces in its Codev Tower view, because the extension's Tower URL defaults to localhost:4100. Read-only; worth knowing for anyone running an isolated E2E.
- Phase 6 CMAP iter1: gemini APPROVE, codex APPROVE, claude COMMENT. Taken: mirrored `### afx ide` into codev-skeleton/resources/commands/agent-farm.md (adopters' command reference had every other afx section); "up to a minute" -> "a minute or more" (client budget is ~3 min worst case); committed the untracked phase_4 rebuttals file.
- Suggested UNRELEASED.md entry (for main to apply on docs/vscode-changelog, under its own ## section):
  "Codev IDE server from npm (#1789). Install the IDE server with `npm i -g @cluesmith/codev-ide` (or `afx ide install`) and run `afx ide start` with no flags: afx finds the server on PATH or in the global node_modules. Tower checks the server's version, installs the Codev sidebar that now ships inside @cluesmith/codev into ~/.agent-farm/ide-extensions, and starts the server with it. `afx ide status` shows the server and sidebar versions. `--server-path` still works as an override."

## 2026-10-13: review
- Context refreshed at the review boundary. Review doc written (codev/reviews/1789-tower-managed-codev-ide-server.md); two cold lessons routed to lessons-learned.md Architecture ([From #1789] entry-point lock; restart check compares live vs desired state). No hot-tier changes. Follow-ups listed in the review for main to decide on (none self-filed).

## 2026-10-13: PR #1806 integration review round 1 (main)
- Must-fix items from main (Codex REQUEST_CHANGES, Claude agreeing): adopt kept the requested serverPath and never compared serverVersion, so a same-path `npm i -g` upgrade got no restart hint and a changed-path hint was consumed on first use. Fixed in `aeafc99c0`: adopt keeps the live serverPath (and, in round 2, startedAt); `liveServerIsCurrent` compares a known serverVersion. The test asserting the defect was flipped, and tests were added for a same-path upgrade and a changed path twice. Also capped CLI stdout at 64 KB (Codex), added an extensions-dir sentence to six docs, and a RELEASE pre-flight check for the floor/engines coupling (codev/ only; the skeleton has no RELEASE protocol).
- Post-fix: tsc clean; IDE suites plus doc/parity tests 23 files / 695 tests green.
- Full packages/codev suite after the main merge: 316 files / 6349 tests passed (48 skipped).
- Porch went straight to the pr gate after the rebuttal (no second consultation), so CMAP on the fix was run by hand: claude APPROVE, codex REQUEST_CHANGES (sync with main), gemini skipped. Merged origin/main (#1783 changed sanitizeAgentEnv, which the IDE env uses; no overlap). Rebuttal: 1789-review-iter2-rebuttals.md.
