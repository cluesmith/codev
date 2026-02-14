# Review: Tower Cloud Connect UI

## Summary

Moved the Tower cloud registration flow from CLI-only (`af tower register`) to both web UI and CLI. The implementation adds a connect dialog to the Tower homepage with device name input, service URL, and OAuth initiation. Disconnect confirmation with full cleanup (tunnel + server-side + credentials) is also supported. CLI commands were renamed from `register`/`deregister` to `connect`/`disconnect` with hidden backward-compatible aliases.

## Spec Compliance

- [x] Tower homepage shows "Connect" when not connected to Codev Cloud
- [x] User can connect from the web UI: dialog with device name + service URL, OAuth flow, auto-connect
- [x] OAuth callback handled by Tower server (no ephemeral port) with nonce validation
- [x] Connected state shows device name + "Disconnect" button
- [x] Disconnect fully cleans up: tunnel, server-side registration (best-effort), local credentials
- [x] Smart connect: reconnects tunnel if credentials exist without re-doing OAuth
- [x] CLI commands renamed to `af tower connect` / `af tower disconnect`
- [x] Old CLI names (`register`/`deregister`) work as hidden aliases
- [x] Existing tunnel connect/disconnect behavior preserved
- [x] Callback error pages rendered for all failure modes

## Implementation Phases

### Phase 1: Shared Infrastructure
- Nonce store with 5-minute TTL and single-use semantics
- Token exchange extracted from tower-cloud.ts into shared lib
- Device name validation and normalization utilities
- `getOrCreateMachineId()` for persistent machine identification

### Phase 2: Enhanced Tunnel Endpoints
- POST `/api/tunnel/connect` enhanced to support OAuth initiation (with body) and reconnect (without body)
- GET `/api/tunnel/connect/callback` with nonce validation, token exchange, credential writing
- POST `/api/tunnel/disconnect` with full cleanup: tunnel + server-side deregister (best-effort) + credentials
- HTML error/success pages for callback results

### Phase 3: Tower UI
- Connect dialog with device name input (auto-normalized) and service URL
- Smart connect: registered → reconnect, not registered → open dialog
- Disconnect confirmation with warning toast for server-side failures
- Cloud status area shows "Codev Cloud" + "Connect" button when not registered

### Phase 4: CLI Rename & Aliases
- `af tower register` → `af tower connect` with hidden `register` alias
- `af tower deregister` → `af tower disconnect` with hidden `deregister` alias
- All user-facing messages updated across 5 files
- Help text shows only new names; old names still functional

## Deviations from Plan

- **Phase 3**: Used `<div class="dialog-overlay">` instead of `<dialog>` element for the connect dialog. The existing create-project dialog uses the same `div.dialog-overlay > div.dialog-box` pattern, and consistency with existing UI was prioritized over semantic HTML.
- **Phase 4**: Used `towerCmd.addCommand(cmd, { hidden: true })` instead of `.alias()` to hide old command names from `--help`. The plan assumed Commander.js aliases are hidden by default, but they show as `command|alias` in help output.

## Lessons Learned

### What Went Well
- Phase decomposition worked well — each phase was independently reviewable and testable
- 3-way consultation caught real bugs (stuck button in submitConnect, nonce placement, body.name truthiness)
- Extracting shared infrastructure first (Phase 1) made subsequent phases cleaner
- The rebuttal mechanism effectively handled false positives from reviewers

### Challenges Encountered
- **Commander.js alias visibility**: Plan assumed `.alias()` hides from help, but it doesn't. Resolved by using hidden commands via `addCommand()`.
- **body.name truthiness**: `body && body.name` treated `{ name: "" }` as a reconnect instead of validation error. Caught by Codex in Phase 2 review. Fixed with `body && 'name' in body`.
- **Nonce placement**: Initially put nonce on authUrl instead of callback URL. Caught by Claude in Phase 2 review. Fixed to embed nonce in callback URL.

### What Would Be Done Differently
- Research Commander.js alias behavior before writing the plan
- The plan should explicitly state which existing patterns to follow for UI elements (avoiding the `<dialog>` vs `<div>` back-and-forth)

## Technical Debt

- `tower-cloud.ts` still uses function name `towerRegister`/`towerDeregister` internally — not user-facing, but could be confusing for contributors. Low priority.

## Follow-up Items

- None identified — all spec criteria met.
