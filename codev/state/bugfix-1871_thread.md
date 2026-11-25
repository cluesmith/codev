# bugfix-1871 thread

Issue #1871: Tower persists the typed tower name instead of the cloud's canonical slug; add
rename, deregistration and name-takeover handling (Tower half of codev-cloud#17).

## 2026-11-25 — investigate

**Reproduced** with a scratch script against a fake cloud (local HTTP + WS server, isolated
`CODEV_AGENT_FARM_DIR`; the live Tower and the real `~/.agent-farm/cloud-config.json` were not
touched):

- Redeem answers `{towerId, slug: "mac-2", name: "mac", apiKey}`. Tower persists
  `tower_name: "mac"`, the success page names `mac`, and `getPublicAuthority()` builds
  `/t/mac/ide`, which is the prefix that 502s under the cloud URL.
- After a successful connect, a cloud-side delete (session closed, key dead) makes the reconnect
  get `auth_error: invalid_api_key`. The client parks in `auth_failed` with the #1372 15-minute
  half-open retry armed indefinitely. The config is unchanged, the log advises `--reauth`, and
  status does not say the Tower was deregistered.

**Root cause** (matches the issue, re-verified in source):

- `lib/token-exchange.ts` `redeemToken` parses only `towerId`/`apiKey` and drops `slug`/`name`.
- `servers/tower-tunnel.ts` OAuth callback and `commands/tower-cloud.ts` `towerRegister` both
  persist the typed name as `tower_name`. Every public URL (`accessUrl`, the success page, the
  IDE `x-forwarded-prefix` and cookie Path) derives from that.
- `lib/tunnel-client.ts` `auth_ok` handler reads only `towerId`, so a rename made in the cloud
  never reaches Tower.
- `handleAuthError('invalid_api_key')` cannot tell a key that was never valid from a key that
  worked and then died. Both get the half-open retry.

**Cloud contract confirmed** in cluesmith/codev-cloud main (PR #18, merged 2026-11-17): `auth_ok`
already carries `{towerId, slug, name}`, redeem returns `{towerId, slug, name, apiKey}` and accepts
`claimSlug`, and DELETE calls `removeSession` and then tombstones. `invalid_api_key` is sent only
when `authenticateTower` returns null; DB errors go out as `internal_error`. So it is a precise
signal.

**Design** (Tower only, six parts of the issue, no split):

1. `redeemToken` returns `slug`/`name` and falls back to the requested name when either is absent.
   It sends `claimSlug: true` only when asked. The callback and the CLI persist
   `tower_name: slug` plus a new optional `display_name`. The success page and log name the slug
   and say when it differs from the requested name.
2. `TunnelClient.onAuthOk(identity)`. tower-tunnel rewrites `tower_name`/`display_name` when the
   slug differs. An `auth_ok` without a slug (older cloud) leaves the config alone.
3. New terminal `TunnelState` `deregistered`: `invalid_api_key` after this client has been
   `connected`, with no half-open retry. tower-tunnel stamps `deregistered_at` into the config
   (credentials kept). The write is guarded on `api_key` still matching, so it cannot clobber a
   concurrent re-registration. init, the watcher and smart reconnect do not connect a
   deregistered config. `/api/tunnel/status` reports `state: deregistered`, the home page shows
   it, and `afx tower status` says so and points at `afx tower connect`.
4. `afx tower connect --claim` sends `claimSlug: true`. The default stays the bump.
5. `afx tower status` prints the slug, the display name and the access URL built from the slug.

"Previously successful connection" is scoped to the TunnelClient's lifetime, as the issue words it.
A Tower that was offline during the delete keeps the #1372 half-open behaviour on its first
reconnect.

Scope: roughly 250 LOC of source across token-exchange, cloud-config, tunnel-client,
tower-tunnel, tower-cloud, cli.ts, tower.html and the status types, plus tests and docs in both
trees. That is inside BUGFIX.

## 2026-11-25 — fix

Architect rules received mid-investigation: fake-cloud tests only (never touch the live Tower or
the real `cloud-config.json`), build for both `auth_ok` shapes, `--claim` opt-in, deregistered
must keep the credentials, run the Windows workflow, docs in both trees plus the afx skill hashes,
present the PR gate as PRFT. Second message: the cloud's `auth_ok` has carried `slug`/`name` since
codev-cloud PR #18. A cloud-side **rename does not close the tunnel**, so a connected Tower keeps
the old slug until it next reconnects. That gap is the cloud's to close, so no Tower workaround;
the PR says so.

Built as designed. Notes for readers:

- `MockTunnelServer` gained `redeemResponse`, `slug`/`name` in `auth_ok`, `configure()` and
  `authAttempts`/`redeemBodies`, so the end-to-end test can play the whole cloud.
- Regression file `bugfix-1871-cloud-identity.test.ts`: 6 of its 7 tests fail on the pre-fix
  source (verified by restoring the four `HEAD` source files temporarily). The 7th pins the
  unchanged older-cloud path.
- Test race avoided: an `auth_ok` identity write wakes the config watcher 500 ms later, and if
  the tunnel has dropped by then the watcher reconnects with a fresh client, which (never having
  connected) parks in `auth_failed` instead of `deregistered`. The deregistration tests therefore
  start from the identity the fake cloud confirms, and wait on the watcher's own log line rather
  than a fixed delay.
- Browser check: the built Tower ran on :14871 with an isolated `CODEV_AGENT_FARM_DIR` seeded with
  a deregistered config. The home page shows a red dot, "mac-2 deregistered", Connect and an
  explanatory tooltip, with no page errors. `afx tower status -p 14871` prints the deregistered
  block and `afx tower connect --help` lists `--claim`. The Tower then logged "not connecting" and
  never contacted the (fake) server URL.
- The dashboard's CloudStatus (`apps/web`) was left alone: a deregistered registration reports
  `registered: false`, so it shows "Cloud: not registered", which is accurate.

## 2026-11-25 — PR #1988 and CMAP

- Porch tests check failed once: 3 skill-parity suites. I had missed the fourth afx skill copy
  (root `.codex/skills/afx/SKILL.md`). Fixed, told the architect, re-ran, green.
- CMAP iter 1: codex REQUEST_CHANGES, claude COMMENT.
  - **Real bug (codex):** the config watcher skipped every change while the tunnel was connected,
    so a re-registration written during a live connection kept the old client. It ended up
    terminal `deregistered` with nothing connecting the new key. The watcher now skips only when
    the live client's credentials match the config. The test now demands a reconnect on the new
    key and fails on the old condition.
  - The dialog prefill uses the display name (I had wrongly reverted it; the dialog normalizes
    names). The dashboard title (`/api/state` hostname) uses `display_name ?? tower_name`.
  - Not changed: porch's own `chore(porch)` commit subjects.
- Architect: the canonical name must come from the slug, never from `auth_ok.name`. Confirmed:
  all three `tower_name` writes take the slug.
- Windows: the first run's targeted job found no files because vitest filters are path
  substrings, not regex. Re-dispatched on head `3baa9f5` with `filter=bugfix-1871-cloud-identity`.
- CMAP iter 2 (codex, on `3baa9f5`): COMMENT, no blockers. Claude iter 1 was COMMENT; its points are
  addressed.
- Windows on `3baa9f5`: all jobs pass except Unit tests, whose only failure is
  `bugfix-1982-update-root-docs.test.ts` (5 tests, CRLF). A baseline run on **main** fails the same
  5 tests (run 45703930614). The failure comes from #1982, is unrelated to this PR, and is not flaky.
  It is named in the PR and was reported to the architect.
