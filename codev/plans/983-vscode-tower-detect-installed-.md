# PIR Plan: Detect installed-vs-running Tower version divergence

Fixes #983.

## Understanding

The #791 CLI preflight (shipped v3.1.7) verifies that the **installed** `codev` binary on disk is at least as new as the VS Code extension, via `codev --version`. It cannot tell whether the **running** Tower process is executing that same code. After `npm install -g @cluesmith/codev@<newer>` *without* a Tower restart, two version surfaces diverge:

| Surface | Reports | Changes when |
|---|---|---|
| Installed binary (`codev --version`) | version on disk | `npm install -g` completes |
| Running Tower (in-memory) | version Tower booted with | only on Tower restart |

The preflight inspects the first; the second is invisible. A user upgrades, sees the preflight pass green, and still hits stale handlers / old wire shapes / un-applied bug fixes because Tower is serving the pre-upgrade in-memory code. `scripts/local-install.sh` restarts Tower as its final step precisely to dodge this; an end-user upgrade has no such automatic restart.

**Goal:** Tower exposes its in-memory version over HTTP; the extension probes it alongside the existing CLI preflight and, on divergence, shows an actionable `Restart Tower` toast.

### Key facts from investigation

- `packages/codev/src/agent-farm/servers/tower-routes.ts` — exact-match `ROUTES` dispatch table (`tower-routes.ts:144-176`). `GET /health` (`handleHealthCheck`, `tower-routes.ts:281`) already exists and is **unauthenticated** — route-level security is Host/Origin validation (`isRequestAllowed`), not a token. A new `GET /api/version` follows the identical pattern. (Confirmed: no per-route token check; `codev-web-key` is only forwarded opportunistically by `TowerClient.request`.)
- `RouteContext` (`tower-routes.ts:131`) is constructed as `routeCtx` in `tower-server.ts:296`. The running version must be threaded onto it.
- `version` is exported from `packages/codev/src/version.ts` (reads `package.json` at load → reflects the on-disk code the process actually booted).
- Extension wire types live in `@cluesmith/codev-types` (`packages/types/src/api.ts`), consumed via `TowerClient` (`packages/core/src/tower-client.ts`). `TowerHealth` currently lives in `tower-client.ts`, but the acceptance criteria require the *new* response type in `@cluesmith/codev-types`.
- `ConnectionManager.connect()` (`packages/vscode/src/connection-manager.ts:108`) already calls `getHealth()` on every connect/reconnect — the natural hook for the version probe (activation + reconnect, **not** per-overview-tick; the in-memory version can't change without a restart, and a restart severs the connection anyway).
- Preflight glue: `packages/vscode/src/preflight/preflight.ts` + pure `preflight-core.ts`. Per the architect heads-up, #989/PR #995 shipped the modal-first `showPreflightFeedback` / `preflightFeedbackMessage` helpers (currently single-dimension: CLI only). #983 extends them to carry a second dimension.
- `getTowerAddress()` (`packages/vscode/src/workspace-detector.ts:44`) yields `{ host, port }` (host default `localhost`). The restart action shells `afx tower stop && afx tower start` **locally**, so a non-local host must degrade to informational wording (design Q5).
- `afx tower` exposes `towerStart` / `towerStop` (`agent-farm/cli.ts:10`); there is no `restart` subcommand — restart == stop then start.

## Design decisions (the plan-approval questions)

**Q1 — Compare running Tower against what?** Both, with two distinct meanings:
- `running < extVersion` → **incompatible**: the running Tower predates what this extension build needs. User-facing compatibility rule.
- `running < installedCli` → **stale**: the user upgraded the CLI on disk but Tower is still running the old code. "You upgraded but it didn't take."

Single predicate: **stale/divergent iff `running < max(installedCli, extVersion)`**. A running Tower *newer* than the installed CLI (local-dev / global-install lag) is **not** flagged — no false positive. Healthy = `running >= extVersion` AND `running >= installedCli`.

**Q2 — Auto-restart vs prompt-only?** Prompt-only, with a `Restart Tower` action button. Auto-restarting could kill in-flight builder work; the user decides. (Matches the issue's recommendation.)

**Q3 — Tower predates the endpoint?** A `404` from `/api/version` (old Tower has no such route) is treated as **"too old to even report its version"** → same restart toast, with stronger wording ("running Tower is too old to report its version"). Distinct from "unreachable".

**Q4 — Frequency?** Activation (folded into the existing preflight flow) + every `connected` transition (reconnect). Not per-tick. The probe is cheap and idempotent; gating it on connect avoids redundant calls and naturally re-checks after a restart re-establishes the connection.

**Q5 — Cross-machine / tunnel?** The probe itself works through any host (it's just an HTTP GET to `baseUrl`). But the `Restart Tower` action runs `afx tower stop && afx tower start` against the **local** machine, which is wrong when the extension is tunnelled to a Tower elsewhere. Decision: when `getTowerAddress().host` is **non-local** (not `localhost` / `127.0.0.1`), the divergence toast omits the local `Restart Tower` button and instead shows informational wording naming the remote host ("Restart the Tower on `<host>` to pick up the upgrade"). Local host → full actionable button. This keeps the action honest rather than silently restarting the wrong process.

## Proposed Change

### 1. Wire type (`@cluesmith/codev-types`)

`packages/types/src/api.ts` — add:

```ts
/** Response of GET /api/version — the version of the *running* Tower process. */
export interface TowerVersionInfo {
  /** Semver of the in-memory Tower process (from package.json at boot). */
  version: string;
  /** ISO-8601 timestamp of when this Tower process started. */
  startedAt: string;
}
```

Export it from `packages/types/src/index.ts`.

### 2. Tower endpoint (`@cluesmith/codev`)

- `tower-routes.ts:131` — extend `RouteContext` with `version: string` and `startedAt: string`.
- `tower-server.ts` — `import { version } from '../../version.js'`; stamp `const startedAt = new Date().toISOString()` near the top of server bootstrap; add `version` + `startedAt` to the `routeCtx` literal (`tower-server.ts:296`).
- `tower-routes.ts` — register `'GET /api/version': (_req, res, _url, ctx) => handleVersion(res, ctx)` in `ROUTES`; add `handleVersion(res, ctx)` returning `200 { version, startedAt }` (shape = `TowerVersionInfo`). Read-only, no auth beyond the existing Host/Origin gate.

### 3. TowerClient probe (`@cluesmith/codev-core`)

`packages/core/src/tower-client.ts` — add:

```ts
async getVersion(): Promise<TowerVersionInfo | null> {
  const result = await this.request<TowerVersionInfo>('/api/version');
  return result.ok ? result.data! : null;
}
```

The caller distinguishes the **404 "too old"** case (`result.status === 404`) from **unreachable** (`status === 0`). To preserve that distinction, the probe exposes status — either return the raw `request(...)` result, or add a small discriminated result (`{ kind: 'ok'|'too-old'|'unreachable', info? }`). Plan to keep `getVersion()` returning the raw `{ ok, status, data }` and let the preflight interpret it, so we don't bake policy into core (consistent with `feedback_types_are_wire_contracts` / keep policy out of the wire layer).

### 4. Extension preflight extension (`@cluesmith/codev-vscode`)

`preflight-core.ts` (pure, unit-tested):
- Add `TowerStatus = 'ok' | 'stale' | 'too-old' | 'unreachable' | 'pending'`.
- Add `decideTowerStatus({ runningVersion, installedCli, extVersion, probe })` returning a `TowerStatus` using the Q1 predicate + Q3 404 mapping.
- Extend `PreflightState` **additively** — keep the existing top-level `status` and `cliVersion` fields exactly as they are, and *add* the Tower dimension alongside: `{ status, cliVersion, towerStatus, runningVersion, hostIsLocal }`. This is the blast-radius-minimizing choice: the one external consumer, `views/status.ts:76` (`const { status, cliVersion } = getPreflightState()`), keeps compiling untouched and simply gains the option to read the new fields for its tooltip. A nested `{ cli: {...}, tower: {...} }` restructure was rejected purely because it would break that destructure for no functional gain.
- Extend `preflightFeedbackMessage` to accept the combined state (or a `towerStatus`) and branch on the Tower dimension. This is the helper whose signature evolves per the architect's #989/PR #995 note — **not** the `showPreflightFeedback()` guard entry point, which stays no-arg (see below) so `extension.ts:603` is untouched.

`preflight.ts` (vscode glue):
- After the existing CLI probe resolves OK, fetch `client.getVersion()` (the `ConnectionManager`'s client) and run `decideTowerStatus`.
- Cache the Tower dimension alongside the CLI dimension; `getPreflightState()` returns both; fire `onPreflightChange`.
- On `stale` / `too-old`: show a toast from a **dedicated Tower-divergence surface** (a new `showTowerDivergenceFeedback`-style function), *not* by overloading `showPreflightFeedback()`. The existing `showPreflightFeedback()` stays no-arg and CLI-only — it is the command-guard path called from `extension.ts:603`, so leaving its signature alone keeps `extension.ts` untouched. If `hostIsLocal`, the toast carries an action button `Restart Tower` → spawn `afx tower stop && afx tower start` (reuse the afx-path resolution from `tower-starter.ts`), then re-probe via a `recheckCli`-style flow. If non-local: informational toast naming the host, no local restart button.
  - **Dependency on #991 (merged, now on main):** the `Restart Tower` action is only viable because PIR #991 changed `afx tower stop` to `lsof -ti :PORT -sTCP:LISTEN` (`agent-farm/commands/tower.ts`), so a stop now SIGTERMs only the listening Tower server. Before #991, the unfiltered `lsof` also matched the VSCode extension host's established sockets (SSE + terminal WebSockets), so an in-extension restart action would have killed its own host. Post-#991 the extension host survives the stop; `ConnectionManager.scheduleReconnect()` re-establishes the connection after `tower start`, and the re-probe fires on the resulting `connected` transition. (This is the "verify the runtime survives the event before building recovery on it" check — confirmed it does.)
- `unreachable`: defer to the existing "Not connected to Tower" path — **no new signal**.
- `ok`: no toast, no signal (acceptance: no false positives in healthy state).
- Wire the probe into `ConnectionManager`'s `connected` transition (reconnect coverage), in addition to the activation-time preflight call.

`views/status.ts` (optional, in scope per acceptance "optional"):
- Extend the existing Codev CLI Status row tooltip to surface running-Tower-version alongside installed-CLI-version, so divergence is visible proactively. Implement as a tooltip line (lighter than a second row).

### 5. Restart helper (`@cluesmith/codev-vscode`)

Add a small `restartTower(...)` to `tower-starter.ts` (or a sibling): resolve afx path, run `tower stop` then `tower start`, poll `isRunning()`, then re-probe. Reuses `resolveAfxPath` already in that file.

## Files to Change

- `packages/types/src/api.ts` — add `TowerVersionInfo`.
- `packages/types/src/index.ts` — export it.
- `packages/codev/src/agent-farm/servers/tower-routes.ts:131,144-176` — `RouteContext` fields + `GET /api/version` route + `handleVersion`.
- `packages/codev/src/agent-farm/servers/tower-server.ts:296` — stamp `startedAt`, import `version`, populate `routeCtx`.
- `packages/core/src/tower-client.ts` — `getVersion()` + import `TowerVersionInfo`.
- `packages/vscode/src/preflight/preflight-core.ts` — `TowerStatus`, `decideTowerStatus`, combined `PreflightState`, extended `preflightFeedbackMessage`.
- `packages/vscode/src/preflight/preflight.ts` — Tower probe, caching, toast + restart action, connect-hook.
- `packages/vscode/src/connection-manager.ts` — invoke the Tower probe on `connected` transition.
- `packages/vscode/src/tower-starter.ts` — `restartTower` helper.
- `packages/vscode/src/views/status.ts` — tooltip line for running-Tower version (optional sub-item).
- Tests: `packages/codev/src/agent-farm/__tests__/tower-routes.test.ts` (new `/api/version` case); `packages/vscode/src/__tests__/preflight-core.test.ts` (decideTowerStatus + message branches).

## Risks & Alternatives Considered

- **Risk: false-positive toast in local dev** where the running Tower is *newer* than the globally-installed CLI. Mitigated by the `running < max(cli, ext)` predicate — newer-running is never flagged.
- **Risk: probe latency stalling activation.** Mitigated by reusing the existing async, fire-and-forget preflight pattern and `TowerClient`'s `REQUEST_TIMEOUT_MS`; the probe never blocks `activate()`.
- **Risk: restart kills in-flight builders.** Mitigated by prompt-only (Q2) — the user chooses when to restart.
- **Alternative considered — fold `version` into `/health`** instead of a new endpoint. `connect()` already calls `/health`, so this would be zero extra round-trips and old Towers would simply omit the field (a clean "too old" signal). **Rejected as the primary surface** because (a) acceptance explicitly asks for `/api/version` *and* the response type in `@cluesmith/codev-types`, while `TowerHealth` lives in core; (b) a dedicated endpoint keeps the version-probe semantics separable from liveness. *Mitigation if the reviewer prefers minimalism:* I can additionally stamp `version`/`startedAt` onto `/health` so the connect path gets it for free — flagging this as an open option for the gate.
- **Alternative considered — per-tick polling.** Rejected (Q4): in-memory version is restart-only; polling is waste.
- **Alternative considered — auto-restart on divergence.** Rejected (Q2): too aggressive with in-flight builder work.

## Blast Radius

Four packages in dependency order `types → core → codev → vscode`. No existing route, existing wire type, or existing CLI-preflight behavior is modified. `TowerVersionInfo` is a *new* type, not a field added to a hot shape like `OverviewBuilder`, so none of the silent-undefined wire-drift the issue warns about applies to the change itself.

**Purely additive (zero existing-consumer risk):**
- `@cluesmith/codev-types` — new `TowerVersionInfo`.
- `@cluesmith/codev-core` — new `getVersion()` method.
- Tower — new `GET /api/version` route + handler; the new divergence toast surface; the connect-time probe hook.

**Compile-time-caught, contained:**
- `RouteContext` gains `version` + `startedAt` → 3 test `makeCtx()` helpers need a 2-line addition each (`tower-routes.test.ts:127`, `spec-761-api-state.test.ts:107`, `tower-cron-routes.test.ts:115`); one real construction site at `tower-server.ts:296`. TypeScript flags all of these; nothing reaches runtime.
- `preflightFeedbackMessage(...)` signature change → 4 call sites (`preflight.ts:277` + 3 in `preflight-core.test.ts`).

**Avoided by the additive design (no longer breaking):**
- `PreflightState` kept additive → its one external consumer `views/status.ts:76` is untouched.
- `showPreflightFeedback()` kept no-arg → `extension.ts:603` is untouched.

**Runtime / behavioral:**
- New endpoint shares `/health`'s trust model (localhost-bound, Host/Origin-gated, no token, low-sensitivity version string) — no new attack surface.
- New toast only fires on genuine divergence; healthy state is silent. The one real UX risk is a false-positive toast, mitigated by the `running < max(cli, ext)` predicate (a newer-running Tower is never flagged).
- One extra HTTP GET per connect — negligible.

## Test Plan

**Unit (pure core):**
- `decideTowerStatus`: ok (running == cli == ext), stale (running < cli), incompatible (running < ext), too-old (probe 404), unreachable (probe status 0), and the newer-running no-false-positive case.
- `preflightFeedbackMessage` Tower branches.
- `tower-routes.test.ts`: `GET /api/version` returns 200 with `{ version, startedAt }`.

**Manual (reviewer at `dev-approval`, running the worktree via `afx dev pir-983`):**
1. Healthy: running == installed == expected → activate extension → **no** toast, Status tooltip shows both versions matching.
2. Stale: start Tower, then `npm install -g` a newer build (or bump the on-disk version) without restart → reconnect/activate → divergence toast appears with `Restart Tower`; click it → Tower restarts → re-probe clears the toast.
3. Too-old: point the extension at a Tower build lacking `/api/version` (404) → "too old to report" toast with stronger wording.
4. Unreachable: stop Tower → only the existing "Not connected to Tower" path fires, no new toast.
5. Cross-machine: set `codev.towerHost` to a non-local host → divergence toast omits the local restart button and names the remote host.

**Cross-platform:** N/A (desktop VS Code + Node Tower only).
