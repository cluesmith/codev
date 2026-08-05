# PIR Review: Introduce packages/codev-sdk (client SDK for Tower)

Fixes #1189

## Summary

Introduced `packages/sdk` (`@cluesmith/codev-sdk`): the single client implementation of
"how anything talks to Tower", so server and client dependencies are isolated at the
package level instead of by convention. codev-core shrank to server-side only (local-key
issuance + `AGENT_FARM_DIR`); the sdk absorbed the nine already-pure core modules, the
tower-client (with auth and transport reworked into injected adapters), and the
`@cluesmith/codev-client` implementation (SSE client, command relay, `/controller` and
`/node` subpaths). All three in-repo consumers (CLI/Tower, apps/web, apps/vscode)
migrated in the same PR; the isolation invariant (core and sdk never import each other,
both import only codev-types) is enforced by CI tests on both sides.

## Files Changed

89 files, +1514 / -208. By group (full stat on the PR's Files tab):

- `packages/sdk/**` (new): package manifest/tsconfig/vitest; 10 modules moved from core
  (git mv, history preserved); new `constants.ts`, `sse.ts`, `controller.ts`,
  `node/local-key.ts`; 5 test files (import-boundary, tower-client, workspace parity,
  plus the two moved suites)
- `packages/core/**`: exports shrink to `./auth` + `./constants`; `constants.ts` loses
  its pure values to the sdk; new `no-sdk-import` invariant guard test
- `packages/codev/**`: `lib/tower-client.ts` rewritten as the CLI's injection wrapper;
  new `lib/reconnect-backoff.ts` (documented private copy); ~14 files repoint imports
- `apps/web/**`: dependency swap + 3 import repoints
- `apps/vscode/**`: dependency swap + ~28 import repoints; `auth-wrapper.ts` reads the
  key via `@cluesmith/codev-sdk/node`; `tower-starter.ts` health probe now injects the
  read-only key
- Wiring: root `package.json` build order, `test.yml` (+ both e2e workflows),
  `bump-all.sh`, `local-install.sh`, release protocol, CLAUDE.md/AGENTS.md
  (byte-identical), `arch.md`, `arch-critical.md`, `lessons-learned.md`, Spec-1280
  manifest for the prompt-bearing doc touches

## Commits

- `1a205bea` [PIR #1189] Add @cluesmith/codev-sdk: environment-agnostic Tower client SDK
- `746a09ad` [PIR #1189] Shrink codev-core to server-side; migrate all consumers to codev-sdk
- `f2908624` [PIR #1189] Wire codev-sdk into build, CI, release, and docs
- `a257913d` [PIR #1189] Sweep: fix source-regex test, stale comments; auth tower-starter's health probe
- `8a5408c8` [PIR #1189] Add Spec-1280 inspection manifest for prompt-bearing doc touches
- (plus plan draft, thread notes, and porch state commits)

## Test Results

- `npm run build` (root, all five packages): pass
- `npm test`: pass — sdk 65 (17 new: boundary guard, client seams, SSE, base64url
  parity), core 1 (new invariant guard), codev 4106, web 323, vscode 643
- Boundary-test negative check: a planted `node:os` import fails the sdk suite (guard
  demonstrated live, then reverted)
- Manual verification: approved by the human at the `dev-approval` gate (running
  worktree review)

## Architecture Updates

- **HOT** (`arch-critical.md`, with displacement): added the #1189 isolation invariant
  (core/sdk never import each other; sdk environment-agnostic, boundary-tested).
  Demoted the forge-concept rule to `arch.md`'s Forge Concept Commands section, which
  already documents the abstraction in full — the demoted line is now recorded there
  explicitly.
- **COLD** (`arch.md`): Monorepo Structure table + dependency graph rewritten for the
  three-package taxonomy; build order, publishing set, directory map, and the VS Code
  extension section updated (TowerClient/subpath references now name the sdk).

## Lessons Learned Updates

- **COLD** (`lessons-learned.md`, Testing): (1) rename sweeps miss escaped-regex
  import assertions (`@scope\/pkg\/module`) — grep the bare name and trust the
  consumer's own suite; (2) write the boundary test before porting modules into a
  constrained package (it caught a `Buffer` dependency on first run), and pin
  hand-rolled codec replacements byte-exact against the platform implementation.
- No HOT lessons routed — both are testing recipes, not cross-cutting behavior rules.

## Things to Look At During PR Review

1. **`packages/sdk/src/workspace.ts`** — the only real algorithm change in the PR. The
   base64url codec replaces Node's `Buffer` (which the boundary test correctly
   rejected). Wire-format-critical: Tower decodes these URL segments server-side with
   Buffer, so `workspace.test.ts` asserts byte-exact parity in both directions plus
   padded-input tolerance. Worth a careful read.
2. **The auth seam inversion** — the sdk client defaults to NO auth; entitlement is
   injected per consumer (CLI wrapper: `ensureLocalKey`; vscode: SecretStorage-cached
   reader; tower-starter: read-only `readLocalKey`). Anyone constructing the sdk
   `TowerClient` directly in future gets unauthenticated requests by design — the
   wrapper is the CLI's front door.
3. **The private reconnect copy lives in `packages/codev`** (`lib/reconnect-backoff.ts`),
   refining the issue text which sketched it in codev-core. Rationale: its only
   consumers (tunnel-client, tower-websocket) live there, and core's public surface
   stays at exactly `auth` + `constants`. Both copies carry change-both-together
   header comments.
4. **`COMMAND_ROUTE` is mirrored** (sdk + codev-types) rather than imported, to keep
   the sdk's `dependencies: {}` contract with codev-types type-only. One string
   literal, recorded in both places.
5. **No facades**: the moved subpaths are gone from codev-core. Out-of-repo consumers
   of `@cluesmith/codev-core`'s removed subpaths (if any exist) would break on the next
   release — the known consumers (CLI, vscode, dashboard) all migrated in this PR.
6. **Consultation findings (Codex COMMENT + Claude COMMENT) — all fixed in-branch**:
   Codex flagged the release protocol's stable-release `git add` omitting
   `packages/sdk/package.json` and stale build-order lines in CLAUDE.md/AGENTS.md and
   arch.md; Claude flagged the same omission in the RC-publishing section's `git add`
   and its comment. All corrected. Every finding was doc accuracy — neither reviewer
   found code defects; Claude's pass explicitly reports "No bugs found" with HIGH
   confidence.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-1189 → **View Diff**
- **Real path**: from the worktree, `pnpm build && pnpm -w run local-install` (exercises
  the new three-tarball pack set, restarts Tower on this code), then `afx status`
  (CLI auth through the new wrapper), open the dashboard + a terminal pane (web on sdk
  escape-buffer/reconnect), and launch the extension dev host (sidebar + terminal =
  sdk tower-client + `/node` auth)
- **Boundary guard**: add a `node:*` import to any sdk module outside `src/node/`,
  run `pnpm --filter @cluesmith/codev-sdk test`, watch it fail naming the file

## Flaky Tests

None skipped; no pre-existing failures encountered.
