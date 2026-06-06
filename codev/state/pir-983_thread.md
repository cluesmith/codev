# PIR #983 — Tower version divergence probe

## Builder thread

### Plan phase (started 2026-06-06)

Working on #983: detect when the **running** Tower process is older than the **installed** CLI / extension-expected version. The #791 preflight only inspects the on-disk binary (`codev --version`); after an `npm install -g` upgrade without a Tower restart, the running process serves stale code while the preflight reports green.

**Investigation findings:**
- Tower routes live in `packages/codev/src/agent-farm/servers/tower-routes.ts` — exact-match dispatch table `ROUTES`. `/health` already exists (unauthenticated, gated only by Host/Origin validation in `isRequestAllowed`). Adding `GET /api/version` is a one-line table entry + handler.
- `RouteContext` (tower-routes.ts:131) is built as `routeCtx` in `tower-server.ts:296`. Need to thread `version` (from `./version.js`) + `startedAt` (stamped at server start) onto it.
- `version` is exported from `packages/codev/src/version.ts` (reads package.json).
- Wire types for the extension already live in `@cluesmith/codev-types` (`OverviewData`, `IssueView`, etc.) consumed via `TowerClient`. New `TowerVersionInfo` type goes in `packages/types/src/api.ts`.
- `TowerClient` (packages/core/src/tower-client.ts) is the HTTP client; add a `getVersion()` method mirroring `getHealth()`.
- Preflight glue: `packages/vscode/src/preflight/preflight.ts` + pure core `preflight-core.ts`. Architect heads-up: #989/PR #995 just shipped the modal-first `showPreflightFeedback`/`preflightFeedbackMessage` helpers (currently CLI-dimension only). #983 extends them to a two-dimension `PreflightState` (CLI + Tower-running).
- `connect()` in `connection-manager.ts` already calls `getHealth()` on every connect/reconnect — natural hook point for the Tower-version probe (activation + reconnect, not per-tick).
- Cross-machine: `getTowerAddress()` (workspace-detector.ts) yields host (default localhost); restart action is local-only, so non-local host must degrade to informational wording.

Plan written to `codev/plans/983-vscode-tower-detect-installed-.md`. Awaiting `plan-approval` gate.

**Plan revision (still at gate):** Folded in the additive-`PreflightState` refinement after a blast-radius discussion with the reviewer. Key decisions now baked into the plan:
- `PreflightState` extended **additively** (keep `status`/`cliVersion`, add `towerStatus`/`runningVersion`/`hostIsLocal`) so `views/status.ts:76` doesn't break. Nested `{cli,tower}` restructure rejected.
- Tower-divergence toast lives on a **dedicated surface**, not by overloading no-arg `showPreflightFeedback()` (which stays the CLI command-guard path → `extension.ts:603` untouched). The helper that evolves per #989 is `preflightFeedbackMessage`.
- Added a first-class **Blast Radius** section: 3 packages additive; only contained, compile-caught edits are the 3 `makeCtx()` test helpers (new `RouteContext` fields) + 4 `preflightFeedbackMessage` call sites.
Scope confirmed: this addresses **only #983**. #982 is a separate bug class (shared UX echo only); #989/#995 already merged (foundation); #791 extended, not modified.

### Implement phase (dev-approval gate pending)

Plan approved. Implemented across 4 packages, all checks green (porch build 5.7s ✓, tests 20.6s ✓; vscode 328 unit tests ✓, codev 96 route tests ✓, both typechecks ✓, vscode lint ✓).

- **types**: `TowerVersionInfo { version, startedAt }` + export.
- **core**: `TowerClient.getVersion()` returns the raw `{ ok, status, data }` so the preflight can tell 404 (too-old) from status 0 (unreachable).
- **tower**: `GET /api/version` route + `handleVersion`; `RouteContext` gains `version`/`startedAt`, stamped at boot in `tower-server.ts`. Fixed the 3 `makeCtx()` test helpers; added a route test.
- **vscode**: `decideTowerStatus` + `towerDivergenceMessage` (pure, in preflight-core, 8 new unit tests); `probeTowerVersion` fired on each `connected` transition in `extension.ts`; dedicated `showTowerDivergenceFeedback` toast (modal-first then ephemeral) with local `Restart Tower` action vs remote-host informational wording; `restartTower` helper in tower-starter; additive `PreflightState` + Status-row tooltip.

**Deviation from plan (reduces blast radius):** kept `preflightFeedbackMessage` and its 4 call sites untouched; added a *separate* `towerDivergenceMessage` pure helper instead of overloading it. Net: the only non-additive edits were the 3 `makeCtx()` helpers (new required RouteContext fields). `views/status.ts` and `extension.ts:603` guard untouched as planned.

**Dev-approval review finding (toast logic corrected — deviation from plan Q1).** Reviewer tested with the extension bumped to 3.1.8 (CLI + running Tower both 3.1.7) and got two toasts: the #791 "update CLI" toast (correct) AND my divergence toast saying "running 3.1.7, but 3.1.8 is installed, restart to load it" — but 3.1.8 is the *extension* version, nothing 3.1.8 is installed, and a restart would reload 3.1.7 (a no-op). Root cause: `decideTowerStatus` compared `running < max(installedCli, extVersion)`; the extVersion arm fires when the *CLI itself* is behind the extension, which is #791's domain and not fixable by a restart. **Fix:** Tower toast now fires on `running < installedCli` only (the genuine upgraded-but-not-restarted case a restart fixes); dropped the extVersion arm; message now names the installed CLI ("X is installed" is literally true); toast suppressed when installed CLI is unknown. This reverses plan Q1's "compare against both" decision — the screenshot was good evidence the both-rule produced redundant/futile advice. Updated unit tests accordingly. Proper #983 repro is `npm i -g @cluesmith/codev@<newer>` without restarting Tower (installedCli > running), NOT bumping the extension version.

**Dev-approval finding 2 (startup race fixed).** The Tower probe fires on the `connected` event while the installed-CLI version comes from a separate ~400ms `codev --version` spawn. If connect wins the race, the probe sees `installedCli=null` → `decideTowerStatus` returns `ok` → no toast even on genuine divergence — exactly the headline open-after-upgrade case, and a source of test flakiness. Fix: after `performPreflight` resolves the CLI version, re-run the probe via `lastTowerClient` if one already ran. Whichever of {CLI-resolve, Tower-connect} finishes last triggers the comparison with complete data. Also fixed `INSTALL_DOCS_URL` → `#quick-start` (reviewer-directed tweak to the existing #791 toast, riding along).

### Review phase

dev-approval approved. Wrote `codev/reviews/983-*.md`, updated arch.md (new "Running-Tower version probe (#983)" bullet after the #791 bullet) and lessons-learned.md (3 lessons: gate-remedy-on-fixable-condition, probe-running-process-not-disk, reconcile-two-async-inputs-against-the-race). Next: open PR, record with porch, porch done → single-pass 3-way consult → pr gate.

**PR #1000 open. 3-way consult: gemini=APPROVE, claude=APPROVE, codex=REQUEST_CHANGES (HIGH).** Codex caught the same futile-remedy bug class in the too-old/404 path: a 404 prompted restart even when the installed CLI was itself outdated (restart reloads the same endpoint-less code). FIXED in cf68274e — `decideTowerStatus` gates `too-old` on `cliStatus==='ok'`; `stale` stays ungated (running<installedCLI always actionable). Regression tests added (404+outdated→ok, 404+missing→ok, stale+outdated→stale); 331 vscode tests. Rebuttal written (983-review-iter1-rebuttals.md). Architect notified leading with the REQUEST_CHANGES + disposition. **Now waiting at the `pr` gate** — single-pass means this fix isn't re-reviewed by the models; human verifies at the gate.

**Rebased on main (picked up PIR #991 / PR #999).** Clean rebase, no conflicts. Re-verified every line ref in the plan — all still accurate (RouteContext tower-routes.ts:131, routeCtx tower-server.ts:296, status.ts:76 destructure, preflight.ts:277, extension.ts:603, the 3 makeCtx helpers). #991's net change did **not** touch vscode `connection-manager.ts` or preflight (they pivoted to a core-side terminal-id-preservation fix), so my hook points are intact. **Key new dependency:** #991 changed `afx tower stop` to `lsof -ti :PORT -sTCP:LISTEN` so it only kills the listening Tower, not the extension host's client sockets. This is what makes my `Restart Tower` action safe to fire from inside the extension. Folded that into the plan (section 4 + runtime-survival check).
