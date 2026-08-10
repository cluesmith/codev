# Builder air-1394 — Issue #1394 (marketplace rejects plugin: SDKVersion 3 / Stream Deck 6.9)

## 2026-08-10 — implement

- Manifest bumped: `SDKVersion` 2 → 3, `Software.MinimumVersion` "6.5" → "6.9".
- `@elgato/cli` bumped ^1.7.4 → ^1.8.0 (+ lockfile). Note: 1.8.0 still depends on
  `@elgato/schemas ^0.4.14` (resolves 0.4.15, whose static schema hardcodes
  `SDKVersion: const 2`) — but the CLI's `validate` downloads current validation rules at
  runtime ("Updating validation rules" on first run) and accepts SDKVersion 3 with no
  additional requirements surfaced. `validate` passes clean; `package` produces
  `dist/com.cluesmith.codev.streamDeckPlugin` (761.8 kB unpacked, 67 files).
- Checked `@elgato/streamdeck` 2.1.0 (dep unchanged) for SDKVersion-3 behavior differences:
  registration/connection handshake (`-port`/`-pluginUUID`/`-registerEvent`/`-info`) has no
  SDKVersion branching. The only version-3-gated feature is the Secrets API
  (`requiresSDKVersion(3, "Secrets")` + app 6.9); our plugin doesn't use it. SDKVersion 3 is
  a pure opt-in unlock, no breaking changes.
- `@elgato/cli` 1.8.0 changelog: one new flag (`--no-file-list`), no breaking changes.
- Added regression tests in `version-sync.test.ts` pinning SDKVersion >= 3 and
  MinimumVersion >= 6.9 (local validate can lag marketplace requirements, so the manifest
  floor is pinned in tests). 54/54 tests pass.
- Remaining human step at the pr gate: Amr verifies on a physical device (Stream Deck app
  >= 6.9) and re-uploads to Maker Console.
