# Plan: Porch Gate Notifications

## Metadata
- **ID**: 0100
- **Status**: draft
- **Specification**: codev/specs/0100-porch-gate-notifications.md
- **Created**: 2026-02-12

## Executive Summary

Implement gate notifications across four integration points: (1) extend `getGateStatusForProject()` to return `requestedAt`, (2) include `gateStatus` in the Tower's `/api/state` response so the dashboard can render it, (3) build a `GateBanner` React component above the terminal split, (4) add Tower-side gate transition detection to send `af send` notifications, and (5) enhance `af status` output with wait time and approval command.

The work decomposes naturally into four phases: backend data plumbing, dashboard UI, architect notifications, and CLI enhancement.

## Success Metrics
- [ ] All specification success criteria met
- [ ] Existing tests pass; new tests cover notification behavior
- [ ] Gate banner appears within one poll cycle of a gate firing
- [ ] Banner disappears within one poll cycle of gate approval
- [ ] `af send` fires exactly once per gate transition
- [ ] `af status` shows wait time and approval command

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Backend: Gate Status Data Plumbing"},
    {"id": "phase_2", "title": "Dashboard: GateBanner Component"},
    {"id": "phase_3", "title": "Tower: Gate Watcher and af send Notifications"},
    {"id": "phase_4", "title": "CLI: Enhanced af status Output"}
  ]
}
```

## Phase Breakdown

### Phase 1: Backend — Gate Status Data Plumbing
**Dependencies**: None

#### Objectives
- Extend `GateStatus` interface with `requestedAt` field
- Parse `requested_at` from `status.yaml` in `getGateStatusForProject()`
- Include `gateStatus` in the Tower's `/api/state` response
- Extend dashboard's `DashboardState` type to include `gateStatus`

#### Deliverables
- [ ] Updated `GateStatus` interface (replace unused `timestamp?: number` with `requestedAt?: string`)
- [ ] Updated `getGateStatusForProject()` to parse `requested_at` from YAML
- [ ] Updated `/api/state` handler in `tower-server.ts` to call `getGateStatusForProject()` and include result
- [ ] Updated `DashboardState` in `dashboard/src/lib/api.ts` with `gateStatus` field
- [ ] Unit tests for `getGateStatusForProject()` with and without `requested_at`
- [ ] Unit test for `/api/state` including `gateStatus` in response

#### Implementation Details

**File: `packages/codev/src/agent-farm/utils/gate-status.ts`**
- Change `GateStatus.timestamp?: number` to `GateStatus.requestedAt?: string`
- In the parsing loop, after finding a pending gate, also extract `requested_at` from the YAML. The format is `requested_at: 'ISO-8601-string'` indented at 4 spaces under the gate name
- Return `requestedAt` as the raw ISO 8601 string (let consumers format it)
- **No sanitization here** — `getGateStatusForProject()` returns raw data. Sanitization for `af send` is handled in the `GateWatcher` (Phase 3). The dashboard uses React JSX which auto-escapes strings, so no sanitization needed for display. This keeps the data source truthful — a pending gate always shows in the dashboard even if the gate name has unusual characters.

**File: `packages/codev/src/agent-farm/servers/tower-server.ts` (around line 2366)**
- Import `getGateStatusForProject`
- After building the state object, call `getGateStatusForProject(projectPath)` and add the result as `state.gateStatus`
- Add `gateStatus` to the inline type annotation for the state object

**File: `packages/codev/dashboard/src/lib/api.ts`**
- Add `GateStatus` interface matching the backend:
  ```typescript
  export interface GateStatus {
    hasGate: boolean;
    gateName?: string;
    builderId?: string;
    requestedAt?: string;
  }
  ```
- Add `gateStatus?: GateStatus` to `DashboardState`

**Tests: `packages/codev/src/agent-farm/__tests__/gate-status.test.ts`**
- Test: `getGateStatusForProject` returns `requestedAt` when present in YAML
- Test: `getGateStatusForProject` returns `undefined` for `requestedAt` when missing
- Test: `getGateStatusForProject` returns `{ hasGate: false }` when no pending gates exist
- Test: `getGateStatusForProject` returns gate name as-is (no sanitization at data layer)

#### Acceptance Criteria
- [ ] `getGateStatusForProject()` correctly parses `requested_at` from status.yaml
- [ ] Missing `requested_at` returns `requestedAt: undefined` (no error)
- [ ] `/api/state` response includes `gateStatus` field
- [ ] Dashboard `DashboardState` type includes `gateStatus`
- [ ] All new unit tests pass
- [ ] All existing tests still pass

#### Test Plan
- **Unit Tests**: `gate-status.test.ts` — mock filesystem with various status.yaml content
- **Integration**: Verify via manual curl to `/api/state` during E2E

#### Rollback Strategy
Revert the three files to their previous versions. No schema migration needed.

#### Risks
- **Risk**: Existing code depends on `GateStatus.timestamp` field
  - **Mitigation**: Search shows it's never populated or consumed — safe to replace

---

### Phase 2: Dashboard — GateBanner Component
**Dependencies**: Phase 1

#### Objectives
- Build a `GateBanner` React component that renders above the terminal split when a gate is pending
- Compute relative wait time client-side from `requestedAt`
- Style with high-contrast amber/yellow background

#### Deliverables
- [ ] `GateBanner` component in `packages/codev/dashboard/src/components/GateBanner.tsx`
- [ ] Integrated into `App.tsx` above the `SplitPane` / terminal area
- [ ] CSS styles for the banner in `index.css`
- [ ] Component tests with React Testing Library

#### Implementation Details

**File: `packages/codev/dashboard/src/components/GateBanner.tsx`** (new file)
- Props: `gateStatus: GateStatus | undefined`
- If `!gateStatus?.hasGate`, render nothing (return `null`)
- Render a full-width bar with:
  - Left: Warning icon + "Builder {builderId} blocked on {gateName}"
  - Center: Wait time badge — compute from `requestedAt` using `Date.now() - Date.parse(requestedAt)`, display as "Xm" or "Xh Xm". Omit if `requestedAt` undefined.
  - Right: Copyable command text: `porch approve {builderId} {gateName}`
- Use `useEffect` + `setInterval` (every 30s) to update the relative time display

**File: `packages/codev/dashboard/src/components/App.tsx`**
- Import `GateBanner`
- Place `<GateBanner gateStatus={state?.gateStatus} />` immediately before the `<div className="app-body">` in the desktop layout (after the header, before the SplitPane)
- Also add it in the mobile layout above the content area
- **Note**: The banner is scoped to the current project instance. Each project's dashboard view (`/project/<encoded>/`) has its own `/api/state` endpoint that returns `gateStatus` for that project only. The banner renders within the per-project instance, not the Tower overall. No cross-project aggregation needed.

**File: `packages/codev/dashboard/src/index.css`**
- Add `.gate-banner` styles: amber/yellow background (#FFF3CD or similar), dark text, full width, padding, flex layout, z-index above content
- Ensure contrast ratio meets WCAG AA

**Tests: `packages/codev/dashboard/__tests__/GateBanner.test.tsx`**
- Test: Renders banner when `gateStatus.hasGate` is true with correct builder ID, gate name, and approval command
- Test: Returns null when `hasGate` is false
- Test: Displays wait time when `requestedAt` is provided
- Test: Omits wait time when `requestedAt` is undefined
- Test: Updates wait time on interval (mock timers)

#### Acceptance Criteria
- [ ] Banner visible above terminals when gate is pending
- [ ] Banner includes builder ID, gate name, wait time, approval command
- [ ] Banner hidden when no gate is pending
- [ ] Wait time omitted when `requestedAt` is undefined
- [ ] All component tests pass

#### Test Plan
- **Unit Tests**: React Testing Library tests with mocked state
- **Playwright E2E Tests**: `packages/codev/src/agent-farm/__tests__/e2e/dashboard-gate-banner.test.ts`
  - Test: Gate banner appears when `status.yaml` has a pending gate (write pending gate, wait for dashboard poll, assert banner visible with correct text)
  - Test: Gate banner disappears when gate is approved (change status.yaml to approved, wait for poll, assert banner gone)
  - Test: Gate banner renders without time indicator when `requested_at` is missing

#### Rollback Strategy
Remove `GateBanner.tsx`, revert App.tsx import, remove CSS classes.

#### Risks
- **Risk**: CSS conflicts with existing layout
  - **Mitigation**: Use scoped class names prefixed with `gate-banner`

---

### Phase 3: Tower — Gate Watcher and af send Notifications
**Dependencies**: Phase 1

#### Objectives
- Detect gate transitions in the Tower's poll loop
- Send `af send architect "..."` notification on new gate transitions
- Deduplicate: only notify once per gate appearance
- Handle `af send` failures gracefully (log warn, continue)

#### Deliverables
- [ ] Gate watcher module in `packages/codev/src/agent-farm/utils/gate-watcher.ts` (new file)
- [ ] Integration into Tower's polling/state refresh cycle in `tower-server.ts`
- [ ] Unit tests for gate transition detection and dedup logic

#### Implementation Details

**File: `packages/codev/src/agent-farm/utils/gate-watcher.ts`** (new file)
- `GateWatcher` class:
  - Two data structures for dedup:
    - `notified: Map<string, string>` keyed by `projectPath:builderId:gateName` → ISO timestamp of when we first saw it
    - `projectKeys: Map<string, Set<string>>` mapping `projectPath` → set of notification keys for that project
  - `checkAndNotify(gateStatus: GateStatus, projectPath: string): Promise<void>` method:
    1. If `!gateStatus.hasGate`: clear all entries for this `projectPath` (remove from `notified` using `projectKeys` index, then delete from `projectKeys`), return
    2. Build key: `${projectPath}:${gateStatus.builderId}:${gateStatus.gateName}`
    3. If key already in `notified`: skip (already notified)
    4. Clear previous keys for this project (gate changed) and add new key
    5. Sanitize `gateName` and `builderId` (strip ANSI, reject tmux control chars)
    6. If sanitization fails: log warn, skip `af send`, return
    7. Execute `af send architect "..."` via `child_process.execFile` with the message
    8. On failure: log at warn level, continue
  - `reset()`: clear both maps (useful for testing)

  This structure ensures:
  - When a gate resolves (`hasGate: false`), the project's entries are cleared via `projectKeys` index
  - When the same builder hits a new gate later, it triggers a fresh notification
  - When the same gate is seen across multiple polls, dedup prevents re-sends
- Message format:
  ```
  GATE: {gateName} (Builder {builderId})
  Builder {builderId} is waiting for approval.
  Run: porch approve {builderId} {gateName}
  ```

**File: `packages/codev/src/agent-farm/servers/tower-server.ts`**
- Import `GateWatcher`, instantiate one per Tower process (singleton)
- **Add a background `setInterval` (every 10s)** that iterates over all active projects, calls `getGateStatusForProject()`, and invokes `gateWatcher.checkAndNotify()`. This ensures architect notifications fire even if the dashboard tab is closed or focused on another project. The interval is independent of dashboard polling.
- Clean up the interval on server shutdown (add to the existing cleanup logic)
- The `/api/state` handler does NOT trigger `checkAndNotify` — that's solely the background poll's job. This avoids double-firing when the dashboard is open.

**Tests: `packages/codev/src/agent-farm/__tests__/gate-watcher.test.ts`**
- Test: New gate triggers notification (mock execFile)
- Test: Same gate on consecutive calls → only 1 notification
- Test: Different builders with same gate type → 2 notifications
- Test: Gate cleared → key removed from map → new appearance triggers notification again
- Test: Sanitization rejects semicolons, logs warning
- Test: `af send` failure is logged at warn and swallowed

#### Acceptance Criteria
- [ ] `af send` fires exactly once when a gate transitions to pending
- [ ] Duplicate polls don't re-send
- [ ] Two builders with same gate type each get their own notification
- [ ] Gate clear + re-appear triggers a new notification
- [ ] `af send` failures are logged warn and don't break the Tower
- [ ] All new tests pass

#### Test Plan
- **Unit Tests**: Mock `child_process.execFile`, verify call count and arguments
- **Integration**: Manual test with tower running and architect tmux session

#### Rollback Strategy
Remove `gate-watcher.ts`, revert tower-server.ts integration point.

#### Risks
- **Risk**: `af send` is a CLI command; calling from within the Tower process may have path issues
  - **Mitigation**: Use absolute path to `af` binary or resolve via `process.argv[0]`. Test in integration.

---

### Phase 4: CLI — Enhanced af status Output
**Dependencies**: Phase 1

#### Objectives
- Enhance `af status` gate warning to include wait time and approval command
- Format matches the spec example output

#### Deliverables
- [ ] Updated gate display in `packages/codev/src/agent-farm/commands/status.ts`
- [ ] Unit tests for enhanced output format

#### Implementation Details

**File: `packages/codev/src/agent-farm/commands/status.ts` (lines 61-64)**
- Replace the existing simple `logger.warn(...)` with an enhanced format:
  ```typescript
  if (projectStatus.gateStatus?.hasGate) {
    const gate = projectStatus.gateStatus;
    let waitInfo = '';
    if (gate.requestedAt) {
      const elapsed = Date.now() - new Date(gate.requestedAt).getTime();
      const mins = Math.floor(elapsed / 60000);
      waitInfo = mins > 0 ? ` (waiting ${mins}m)` : ' (waiting <1m)';
    }
    logger.blank();
    logger.warn(
      `  Builder ${gate.builderId}  ${chalk.yellow('blocked')}  ${gate.gateName}${waitInfo}  → porch approve ${gate.builderId} ${gate.gateName}`
    );
  }
  ```
- Also need to update `TowerProjectStatus` in `tower-client.ts` to include `requestedAt` in the `gateStatus` type (it currently uses the old `timestamp?: number`)

**File: `packages/codev/src/agent-farm/lib/tower-client.ts`**
- Update `gateStatus` in `TowerProjectStatus` interface to match the new `GateStatus` shape (replace `timestamp?: number` with `requestedAt?: string`)

**Tests: `packages/codev/src/agent-farm/__tests__/status-gate.test.ts`**
- Test: Blocked builder with `requestedAt` shows wait time and approval command
- Test: Blocked builder without `requestedAt` shows gate name and command but no wait time
- Test: No gate shows no gate warning

#### Acceptance Criteria
- [ ] `af status` output includes wait time and approval command for blocked builders
- [ ] Missing `requestedAt` omits wait time (no error)
- [ ] Format matches spec example
- [ ] All tests pass

#### Test Plan
- **Unit Tests**: Mock `TowerClient.getProjectStatus` return value, capture logger output
- **Manual Testing**: Run `af status` with active tower and blocked builder

#### Rollback Strategy
Revert status.ts and tower-client.ts changes.

#### Risks
- **Risk**: Low — minimal code change to existing output formatting

---

## Dependency Map
```
Phase 1 (Backend) ──→ Phase 2 (Dashboard)
       │
       └──────────→ Phase 3 (Gate Watcher)
       │
       └──────────→ Phase 4 (CLI)
```

Phases 2, 3, and 4 can be worked on concurrently after Phase 1, but will be done sequentially as a single builder.

## Risk Analysis

### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| `af send` fails from Tower process context | Medium | Low | Dashboard is primary channel; log warn and swallow |
| CSS banner breaks existing layout | Low | Medium | Scoped class names; test in Playwright E2E |
| `timestamp` field removal breaks consumers | Low | High | Search confirms field is never populated or read |
| Three parallel `GateStatus` type definitions drift | Low | Medium | gate-status.ts is source of truth; tower-client.ts and dashboard api.ts must match. Document in code comments. |

## Validation Checkpoints
1. **After Phase 1**: `curl /api/state` returns `gateStatus` with `requestedAt`
2. **After Phase 2**: Dashboard shows/hides banner on gate state changes
3. **After Phase 3**: Architect tmux gets notification on gate fire
4. **After Phase 4**: `af status` shows enhanced gate info

## Documentation Updates Required
- [ ] `codev/resources/arch.md` with new modules (gate-watcher)

## Consultation Log

### Iteration 1 (2026-02-12)

**Gemini**: APPROVE (HIGH confidence). No issues.

**Claude**: APPROVE (HIGH confidence). Minor notes:
- `getGateStatusForProject` scans all project dirs; should clarify filtering. Response: acceptable — Tower serves one project per dashboard instance; the function returns first pending gate which is correct for single-project view.
- Three parallel `GateStatus` type definitions need synchronization. Response: added as a risk with mitigation.

**Codex**: REQUEST_CHANGES (MEDIUM confidence). Three issues:
1. Sanitization in `getGateStatusForProject` suppresses gate data system-wide — spec only requires suppressing `af send`. **Fixed**: moved sanitization to `GateWatcher` only. Data layer returns raw values; React JSX auto-escapes for dashboard.
2. Architect notifications depend on dashboard polling — if dashboard is closed, `af send` never fires. **Fixed**: added background `setInterval` (10s) in Tower that polls gate status independently of dashboard requests.
3. Playwright testing required for UI changes but absent from plan. **Fixed**: added explicit Playwright E2E tests in Phase 2 test plan.

### Iteration 2 (2026-02-12)

**Gemini**: APPROVE (HIGH confidence). No issues.

**Claude**: APPROVE (HIGH confidence). Minor notes:
- "No notification when Tower runs without active builders" success criterion lacks explicit test. Response: handled implicitly — `getGateStatusForProject()` returns `hasGate: false` when no projects exist, watcher does nothing. Can add an explicit test during implementation.
- `getGateStatusForProject()` may be called redundantly (already called inside `getTerminalsForProject`). Response: will check during implementation and reuse if possible.

**Codex**: REQUEST_CHANGES (HIGH confidence). Two issues:
1. GateWatcher dedup map can't clear entries when gate resolves — no `projectPath` tie in the Map. **Fixed**: restructured to dual-map design with `notified` (keyed by `projectPath:builderId:gateName`) and `projectKeys` index (mapping `projectPath` → set of keys). When `hasGate` is false, all keys for that project are cleared.
2. Playwright tests in wrong directory — claims they should be in `packages/codev/tests/e2e/`. **Not a real issue**: `playwright.config.ts` specifies `testDir: './src/agent-farm/__tests__/e2e'` and all existing Playwright tests are in that directory. Plan has the correct location.
