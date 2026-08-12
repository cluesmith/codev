# PIR Review: Enforce request authentication on the Tower local API

Private security lane (advisory GHSA-xvjp-7748-v88v). This retrospective, the PR body, and every
committed artifact are deliberately **mechanics-free**: they describe the hardening, never any
exploit mechanics or attack scenario, and refer to the advisory by id only.

No linked GitHub issue — this was an ad-hoc security task; the advisory is the source of record.

## Summary

Tower's local HTTP + WebSocket API performed no server-side request authentication. This PR makes
every non-public route require the shared local key (`~/.agent-farm/local-key`), fail closed, and
tightens the surrounding controls, then rolls the key transport across all clients. It implements
the advisory's five-layer remediation: HTTP key enforcement at the single request choke point,
WebSocket key enforcement at the upgrade, a fixed CORS origin allowlist, cross-client key
transport, and mandatory enforcement under `BRIDGE_MODE`. Key rotation (the advisory's 6th layer)
is a deferred follow-up.

## Files Changed

(Excludes the vendored three.js assets — see the Architecture note.)

- `packages/types/src/websocket.ts` (+36), `packages/types/src/index.ts` (+5) — shared wire
  contracts (header name, WS subprotocols, the terminal-WS subprotocol builder).
- `packages/codev/src/agent-farm/utils/server-utils.ts` (+280) — the auth helpers: HTTP key check,
  WS key check, public-route allowlist, constant-time compare, CORS + Host allowlists, cached key.
- `packages/codev/src/agent-farm/servers/tower-routes.ts` (+163) — front-door ordering (preflight
  before the key check, 401), CORS allowlist, same-origin key injection into served HTML shells,
  annotator sink encoding, rejected-request logging.
- `packages/codev/src/agent-farm/servers/tower-websocket.ts` (+37) — upgrade-time key gate
  (Origin-independent), clean reject shapes.
- `packages/codev/src/agent-farm/servers/tower-server.ts` (+30) — ensure the key at boot;
  mandatory enforcement + fail-closed-if-no-key under `BRIDGE_MODE`; subprotocol echo.
- `packages/codev/src/agent-farm/lib/reconnect-backoff.ts` (+11) — an app-range WS close code.
- `packages/codev/src/agent-farm/lib/tunnel-client.ts` (+10) — tunnel WS upgrade sends a loopback
  `Host` so it passes the Host guard.
- `packages/codev/src/agent-farm/commands/tower.ts` (+12) — the `afx tower start` readiness probe
  authenticates (the probe polls a now-keyed route).
- `packages/core/src/auth.ts` (+11) — repair an existing key file's permissions to `0600` on read.
- Clients: `apps/vscode/src/{terminal-adapter,sse-client,connection-manager}.ts`,
  `apps/web/src/{lib/api,hooks/useSSE,components/Terminal}.ts`,
  `packages/codev/templates/{tower,open,3d-viewer}.html` — send the key on HTTP/SSE/WS; browser
  pages consume the same-origin-injected key; the annotator loads media as authenticated blobs.
- `packages/codev/package.json` (+`codev-types` as a runtime dep), `scripts/local-install.sh`
  (pack + install `codev-types`), `pnpm-lock.yaml` — packaging fixes (see Lessons).
- Tests: new `request-auth.test.ts` (+260) plus updates to `tower-routes`, `tower-websocket`,
  `inbox-routes`, `spec-761-api-state`, `tower-cron-routes`, sdk `tower-client`, and the apps/web
  suites.

Plus 5 vendored three.js files (`packages/codev/templates/vendor/three*.js`, ~58k lines) — a
one-time local vendoring so no remote CDN code runs in a key-bearing page.

## Commits

`git log main..HEAD --oneline` (implementation commits; porch scaffolding omitted):

- `e6181262f` types: add request-authentication wire contracts
- `37814ee5f` server: enforce request authentication on the Tower API
- `3a882b303` clients: transport the shared key on HTTP and WebSocket
- `b0d711f24` tests: request-authentication enforcement
- `40a080954` types: centralize the terminal WS subprotocol builder
- `5f4cef9dc` server: same-origin key delivery, Host guard, CORS shell isolation
- `f98f42e56` clients: web dashboard + annotator key transport
- `9761070b7` tests: Host guard + annotator allowlist coverage
- `19ae5013a` server: bridge/tunnel Host handling, injection safety, diagnostics
- `c7ebde935` vscode: authenticate the SSE client
- `0220b46a9` annotator: vendor three.js locally; template hardening
- `34f259a76` tests: bridge Host, no-slash workspace, SSE-stream + mock updates
- `32dc43411` harden: narrow bridge Host to IP-literals; encode annotator XSS sinks
- `f0f4afe2a` fix: make @cluesmith/codev-types a runtime dependency of codev
- `e8795de95` fix(local-install): pack + install @cluesmith/codev-types
- `0ff32b63d` fix: authenticate the Tower startup readiness probe
- `11978b516` rename the auth header codev-web-key -> codev-tower-key (dual-accept)
- `f36a134ec` chore(vscode): satisfy eslint curly rule in tunnel.ts

## Test Results

- `pnpm --filter @cluesmith/codev build`: ✓ pass
- Full codev suite: ✓ 4884 passed, 48 skipped, 0 failed (incl. the new `request-auth` suite +
  the dual-accept test)
- `@cluesmith/codev-sdk`: ✓ 98 passed (incl. the import-boundary tests)
- `apps/web`: ✓ 335 passed; `apps/vscode`: ✓ 794 passed
- Typechecks: `apps/web` `tsc -b` ✓, `apps/vscode` main tsconfig ✓
- Packaging verified via `pnpm deploy --prod` and a throwaway-prefix `npm install` of all four
  tarballs (types/core/sdk/codev) — the boot module loads and resolves `codev-types`.
- Manual: the human approved the `dev-approval` gate after running the branch (Tower boot +
  cross-client paths).

## Architecture Updates

Routed one system-shape invariant into COLD `codev/resources/arch.md` § **Invariants & Constraints**
(invariant #9): Tower's local API now **enforces** request authentication — non-public routes
require the shared key and fail closed, and any new Tower route must decide public-vs-keyed via the
`isPublicRoute` allowlist. Mechanics-free wording (advisory by id). Routed cold rather than into the
hot always-injected tier to avoid churning that capped file in a security PR; a future MAINTAIN pass
can promote it if the hot tier warrants it. (`arch.md`/`lessons-learned.md` are our user-evolved
instance docs, not `codev-skeleton` framework files, so no skeleton mirror applies.)

## Lessons Learned Updates

Routed three entries into COLD `codev/resources/lessons-learned.md`:

1. § Architecture — **the first runtime (value) import of a previously type-only workspace package
   must move that dep `devDependencies` → `dependencies`**, or the published/deployed build crashes
   at module load (`Cannot find module`), invisible to build+test (the monorepo symlinks
   everything). Verify the packaged artifact with `pnpm deploy --prod` / a throwaway-prefix install;
   also update any local-install script that packs a hand-picked subset of workspace packages.
2. § Security — **an auth gate's public-route allowlist must include the tooling's own
   readiness/uptime probes**, or startup detection breaks (a keyed `/api/status` 401'd the
   `afx tower start` readiness probe, so a healthy Tower was killed by its own launcher).
3. § Security — **in a key-bearing page, any XSS is credential theft**: once the key is injected,
   an XSS there reads it and yields full API access, so every attacker-influenceable sink in those
   pages must be encoded and any `src`-loaded media route re-plumbed to an authenticated blob fetch.

## Things to Look At During PR Review

Security-sensitive spots worth focused attention:

- **Public-route allowlist** (`isPublicRoute`) — the one place a wrong entry either blocks a
  pre-auth path or exposes a data route. Note the GET-only rule, the `/workspace/<enc>/` static
  carve-out that excludes `api/`/`ws/`/`file`, and the annotator shell+vendor carve-out that keeps
  every data/media sub-route keyed.
- **Dual-accept header** — the server accepts the new `codev-tower-key` and the legacy
  `codev-web-key` for one release, so a not-yet-updated VS Code / Stream Deck keeps working;
  there's a `# drop the fallback next release` follow-up.
- **Host guard + `BRIDGE_MODE`** — strict loopback for the localhost bind; in bridge mode it also
  accepts IP-literal Hosts but still rejects hostNAMEs (the rebinding guard stays on). Confirm the
  relaxation never weakens the (separate, still-mandatory) key check.
- **Same-origin key delivery** — the key is injected into served HTML shells and those responses
  strip `Access-Control-Allow-Origin`, so a cross-origin page cannot read the injected key; the key
  is validated as hex before embedding. `window.__CODEV_TOWER_KEY__`.
- **WebSocket gate** — validated at the handshake before any session lookup, Origin-independent;
  the server echoes only the non-secret marker subprotocol, never the key token.
- **Annotator** — media (image/video/pdf/model) is fetched as authenticated blobs / via
  `setRequestHeader`; attacker-influenceable values interpolated into the key-bearing shell are
  encoded at their sink; three.js is vendored locally so no remote code runs in that page.
- **Constant-time compare** — length-guarded before `timingSafeEqual`; fail-closed when the key is
  unavailable.

### 3-Way Consultation Dispositions (single advisory pass)

Verdicts: **Gemini APPROVE**, **Claude COMMENT**, **Codex REQUEST_CHANGES**. PIR runs one advisory
pass and will not re-review, so each finding is dispositioned here for the `pr`-gate reviewer:

- **Missing BRIDGE_MODE/TLS + `CODEV_TOWER_ALLOWED_ORIGINS` docs** (Codex + Claude) — **Fixed.**
  Documented in `codev/resources/commands/agent-farm.md` under `afx tower start`: the mandatory
  bridge-mode auth, the cleartext-key/TLS-termination requirement, and the new
  `CODEV_TOWER_ALLOWED_ORIGINS` knob (Host + CORS allowlist for hostname clients).
- **WS marker-echo + vscode-subprotocol test gaps** (Codex) — **Fixed.** Extracted the echo rule to
  a testable `selectWsSubprotocol` (asserts it echoes the marker and never the key token) and added
  a vscode test asserting the WS is opened with `[marker, codev-key.<key>]` (and none without a key).
- **Header renamed `codev-web-key` → `codev-tower-key` + dual-accept, vs the plan's "one header"**
  (Codex) — **Reasoned deviation, not a defect.** This was an explicit post-plan decision by the
  human reviewer at the dev-approval gate: the Stream Deck plugin lives out-of-tree and bundles an
  older sdk, so a hard cutover would break it; the server dual-accepts the legacy header for one
  release. Disclosed above; Claude concurred the justification is sound.
- **CORS uses `CODEV_TOWER_ALLOWED_ORIGINS` instead of "the single tunnel origin from Tower config"**
  (Codex) — **Reasoned substitution, now documented.** The tunnel subsystem exposes no clean
  synchronous origin; the env var is an **exact-match** allowlist (not a wildcard), empty/secure by
  default. CORS is defense-in-depth; the key check is the control. (Doc gap fixed above.)
- **`BRIDGE_MODE` doesn't fail when the key file is absent (it creates it)** (Codex) — **By design,
  not a hole.** Tower owns key generation, so bridge mode always boots *with* enforced auth (a
  random key) rather than refusing to start; the fail-closed path triggers when the key genuinely
  cannot be obtained (unwritable `~/.agent-farm` → `getExpectedKey()` returns null → boot exits).
  The fail-closed auth behavior on a null key is unit-tested (`getExpectedKey` + `isRequestAllowed`);
  the boot-time `process.exit` itself runs at module load and isn't unit-tested.
- **`escapeHtml` renders `&#39;`/`&quot;` literally for quoted paths in `<script>` string contexts**
  (Codex + Claude) — **Cosmetic, no security impact.** HTML-escaping blocks the `<`/quote breakout
  in every context; the entity-rendering only affects display for pathological filenames.
- **Dual-accept removal tracked only as a code comment** (Claude) — flagged for the architect to
  file a follow-up issue (drop the `codev-web-key` fallback next release); noted here so it isn't
  lost past the one-release window.
- **e2e WS suites still open keyless sockets** (Claude, disclosed) — fast-follow; WS auth is covered
  by the in-PR unit/integration tests.

## How to Test Locally

For reviewers pulling the branch:

- **View diff**: VS Code sidebar → right-click builder → **Review Diff**.
- **Run**: `pnpm -w run local-install` (packs + installs types/core/sdk/codev), then the branch
  Tower runs on `:4100`; or run the built entry on a spare port.
- **What to verify** (maps to the plan's Test Plan): dashboard loads + a terminal attaches over WS
  on a *direct* `/workspace/<enc>/` entry; VS Code terminals + gate/comments + live updates;
  tower.html; the annotator for a text file, an image/video/pdf (authenticated blobs), and an
  STL/3MF (the vendored 3D viewer); LAN access under `BRIDGE_MODE`; a tunneled terminal; and a
  no-key / wrong-key request → clean **401** (not a hang).

## Flaky Tests

None skipped. Two pre-existing, out-of-scope items noted (not caused by this diff):

- `apps/vscode` webview tsconfig (`tsconfig.webview.json`) reports errors in
  `src/markdown-preview/webview/main.ts` when `@cluesmith/codev-artifact-canvas` isn't built in the
  worktree — a build-ordering artifact, untouched by this PR (the main tsconfig, which contains the
  changed `terminal-adapter.ts`, passes clean).
- The heavy e2e WS suites (excluded from the default run) still open keyless sockets; the WS auth
  path is covered by fast unit/integration tests in this PR, and updating the e2e suites is a
  fast-follow.
