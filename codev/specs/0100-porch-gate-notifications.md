# Spec 0100: Porch Gate Notifications

## Summary

When a builder hits a porch gate (human review required, PR ready, etc.), the Tower dashboard should display the blocker prominently and a message should be sent to the architect terminal. When the gate is approved and the builder unblocks, the notification should disappear from the dashboard.

## Problem

Builders hit gates silently. The only way to discover a builder is blocked is to run `porch status <id>` or manually check `codev/projects/<id>/status.yaml`. In practice, builders sit idle for minutes or hours because the architect (human) doesn't notice the gate. This wastes time and breaks flow.

Three specific gaps:

1. **No dashboard visibility**: The Tower computes `gateStatus` internally via `getGateStatusForProject()`, but does **not** include it in the `/api/state` response. The dashboard has no `gateStatus` field in its `DashboardState` type and cannot render gate information. There is no visual indicator that a builder needs attention.

2. **No architect notification**: When a gate fires, nothing alerts the architect terminal. The human must actively poll or remember to check. `afx send` exists and can inject formatted messages into any tmux session via file-based buffer paste, but nothing triggers it on gate transitions.

3. **No auto-clear**: If the dashboard did show gate status, it would need to clear the notification when the gate is approved and the builder resumes.

## Current State

- `getGateStatusForProject()` in `gate-status.ts` reads `status.yaml` and returns `{ hasGate, gateName, builderId }`. The current `GateStatus` interface also has `timestamp?: number` but this field is **never populated** by the implementation.
- The Tower's `/api/state` handler does **not** call `getGateStatusForProject()` and does **not** include `gateStatus` in the response. Gate status is computed and returned by the separate `/api/projects/:id/status` endpoint.
- The dashboard's `DashboardState` interface does **not** have a `gateStatus` field — it neither receives nor renders gate information.
- `afx send <target> "message"` can inject formatted messages into any tmux session (architect or builder) using file-based tmux buffer paste (writes to temp file, loads into buffer, pastes to session).
- Porch writes `requested_at` (ISO 8601 timestamp) to `status.yaml` gates when a gate transitions to `pending` — this is the data source for "how long has it been waiting."
- The dashboard polls `/api/state` every few seconds, so gate status changes will be visible once the endpoint includes `gateStatus`.
- `afx status` **already shows basic gate info** via `logger.warn()` when a pending gate exists (using the `/api/projects/:id/status` endpoint). This spec enhances the output format to include wait time and the approval command.

## Desired State

### (i) Dashboard Gate Notification

When any builder has a pending gate, the dashboard shows a **banner above the terminal split area** — a full-width, high-contrast bar that is impossible to miss. The notification includes:

- Which builder is blocked (e.g., "Builder 0100")
- What gate is pending (e.g., "spec-approval", "pr-ready")
- How long it's been waiting (e.g., "3m ago"), or no time indicator if `requested_at` is missing
- A clear call-to-action (e.g., "Run: `porch approve 0100 spec-approval`")

**Data model**: Each project has exactly one builder, and each builder can have at most one pending gate at a time (porch enforces sequential gate flow — a builder must clear one gate before the next can fire). The `gateStatus` field is therefore a single object per project, not an array. The dashboard renders zero or one banner for the active project.

The dashboard always shows a single project at a time. Notifications are scoped to the active project — no cross-project filtering is needed.

### (ii) Architect Terminal Message

When a gate fires, the Tower sends a formatted message to the architect terminal via `afx send`. The message should:

- Identify the builder and gate type
- Include the approval command
- Be visually distinct (use the existing `afx send` wrapper format with structured headers)

This happens once per gate transition to `pending` — not on every poll. If `afx send` fails (e.g., tmux session unavailable), the error is logged at warn level and the failure is swallowed — the dashboard notification is the primary channel.

### (iii) Auto-Clear on Unblock

When the gate is approved and the builder resumes:

- The dashboard notification disappears on the next `/api/state` poll (because `getGateStatusForProject()` no longer returns `hasGate: true`)
- No explicit "clear" action needed — the existing poll-based architecture handles this naturally

### (iv) Enhanced `afx status` Output

`afx status` already shows a basic "Gate pending" warning. Enhance it to include wait time and the approval command. Example with two active projects:

```
Project 0100 (porch-gate-notifications)
  Builder 0100  blocked  spec-approval (waiting 3m)  → porch approve 0100 spec-approval

Project 0101 (clickable-file-paths)
  Builder 0101  running  implement:phase_2
```

The gate info comes from the Tower's `/api/projects/:id/status` endpoint (same data source already used by `afx status`).

## Success Criteria

- [ ] `/api/state` response includes `gateStatus` field with gate info for the active project
- [ ] Dashboard shows a banner above terminals when any builder has a pending gate
- [ ] Banner includes builder ID, gate name, wait time (or omitted if unavailable), and approval command
- [ ] Banner disappears within one poll cycle after gate approval
- [ ] Architect terminal receives a message when a gate transitions to pending
- [ ] Message is sent exactly once per gate transition (not on every poll)
- [ ] Existing `afx send` protocol is used (no new message transport)
- [ ] Works for all gate types: spec-approval, plan-approval, pr-ready, merge-approval
- [ ] `afx status` output includes wait time and approval command for blocked builders
- [ ] No notification when Tower runs without any active builders
- [ ] `afx send` failures are logged at warn level and do not break the poll loop
- [ ] Existing tests pass; new tests cover notification behavior

## Constraints

### Technical Constraints

- Dashboard is React (Vite) — no server push, relies on polling `/api/state`
- `afx send` uses tmux buffer paste — requires the architect to have an active tmux session
- Gate status is read from filesystem (`status.yaml`), not from a real-time event bus
- The Tower process may not have the project's working directory in its `cwd` — must use absolute paths when calling `afx send` or porch commands

### Design Constraints

- New dependencies are acceptable if justified
- Must not change the `afx send` protocol or porch state format
- Notification must be clearly visible without being disruptive (no modal dialogs, no sound)

## Assumptions

- The architect terminal runs inside a tmux session (standard Tower setup)
- `afx send architect "message"` works from the Tower process context
- The dashboard already polls `/api/state` at a reasonable frequency (~3-5s)
- Gate status changes are infrequent (at most a few per hour per builder)
- The dashboard always shows a single project at a time (not multi-project simultaneously)

## Solution Approach

### Step 1: Extend `getGateStatusForProject()` Return Type

Update the `GateStatus` interface to replace the unused `timestamp?: number` with `requestedAt?: string`:

```typescript
interface GateStatus {
  hasGate: boolean;
  gateName?: string;
  builderId?: string;
  requestedAt?: string;  // ISO 8601 from status.yaml gates.<name>.requested_at
}
```

Update the implementation to parse `requested_at` from the gate entry in `status.yaml`. If `requested_at` is missing (e.g., older status files or manual edits), `requestedAt` is `undefined` and the UI omits the wait time display.

### Step 2: Include `gateStatus` in `/api/state` Response

Add a call to `getGateStatusForProject()` in the Tower's `/api/state` handler and include the result in the JSON response:

```typescript
const state = {
  architect: { ... },
  builders: [ ... ],
  utils: [ ... ],
  annotations: [ ... ],
  projectName: '...',
  gateStatus: gateStatusResult,  // NEW
};
```

Update the dashboard's `DashboardState` type to include `gateStatus?: GateStatus`.

### Step 3: Dashboard Gate Banner Component

Add a `GateBanner` React component positioned above the terminal split area. It renders when `gateStatus.hasGate === true`. The banner is a full-width, high-contrast bar (amber/yellow background) with:

- Builder ID and gate name
- Relative wait time computed client-side from `requestedAt` (or omitted if undefined)
- Copyable approval command

### Step 4: Tower-Side Gate Watcher for `afx send`

Add state tracking in the Tower to detect gate transitions:

- Track the last-known gate status per builder (in-memory Map of `builderId:gateName` -> timestamp)
- When a gate transitions from `no gate` to `pending`, trigger `afx send architect "..."` with the gate info
- This avoids modifying porch itself — the Tower is the integration point

### Step 5: Enhanced `afx status` Output

Update `afx status` to include wait time (computed from `requestedAt`) and the approval command in the gate warning output. Uses the existing `/api/projects/:id/status` endpoint which already returns `gateStatus`.

### Deduplication

The Tower tracks which gates it has already notified about (in-memory Map keyed by `builderId:gateName` -> timestamp). A notification is sent only when a new gate appears that wasn't in the previous state. This prevents duplicate messages on every poll.

The key includes `builderId` so that two builders hitting the same gate type (e.g., both waiting on `spec-approval`) each produce their own notification. Since each project has one builder, this is primarily a correctness safeguard.

### Sanitization

Gate names and builder IDs originate from `status.yaml` file content. Before interpolating into `afx send` messages, sanitize:

- Strip ANSI escape sequences from gate names and builder IDs
- Reject values containing tmux control characters (`;`, `\n`, `\r`) — if rejected, log a warning and skip the `afx send` notification (dashboard still shows the banner)
- Use `afx send`'s existing file-based message delivery (writes to temp file, loads into tmux buffer) which avoids shell injection
- If `gateName` or `builderId` is missing/empty in `status.yaml`, treat as `hasGate: false` (no notification)

On the dashboard side, React's JSX auto-escapes string content, preventing HTML injection. No additional escaping is needed for `gateName` or `builderId` in the `GateBanner` component.

### Simultaneous Gates Across Projects

Each project has exactly one builder with at most one pending gate. The Tower may manage multiple projects concurrently, each with its own pending gate. Each gate transition produces its own `afx send` notification. Since gate transitions are infrequent (at most a few per hour across all projects), flooding is not a concern. If `afx send` fails for one gate, the error is logged at warn level and execution continues — the dashboard notification is the primary channel.

Note: A builder cannot have two gates pending simultaneously. Porch enforces sequential gate flow within a project.

## Test Scenarios

### Tower API Unit Tests (vitest)

1. **`getGateStatusForProject` returns `requestedAt`**: Write a `status.yaml` with `requested_at`, verify the field is parsed and returned
2. **`getGateStatusForProject` handles missing `requested_at`**: Write a `status.yaml` without `requested_at`, verify `requestedAt` is undefined (not an error)
3. **Gate transition detection**: Mock sequential calls to `getGateStatusForProject`, verify `afx send` is triggered only on `no gate → pending` transitions
4. **Dedup across polls**: Same pending gate on 3 consecutive polls → only 1 `afx send` call
5. **Dedup key includes builderId**: Two builders with same gate type → 2 separate `afx send` calls
6. **Sanitization**: Gate names with ANSI escapes or semicolons are stripped/rejected before `afx send`
7. **`/api/state` includes gateStatus**: Mock gate status, verify it appears in the `/api/state` JSON response

### Dashboard Component Tests (vitest + React Testing Library)

8. **GateBanner renders when `gateStatus.hasGate` is true**: Mock API response with gate status, verify banner appears with builder ID, gate name, wait time, and approval command
9. **GateBanner hidden when no gate**: Mock API response with `hasGate: false`, verify no banner
10. **Wait time display**: Mock `requestedAt` = 3 minutes ago, verify "3m ago" text
11. **Wait time omitted when `requestedAt` is undefined**: Verify banner renders without time indicator

### CLI Tests (vitest)

12. **`afx status` shows enhanced gate info**: Mock Tower API response with a blocked builder including `requestedAt`, verify CLI output includes gate name, wait time, and approval command

### Playwright E2E Tests

13. **Gate appears in dashboard**: Start Tower, activate project, write pending gate to `status.yaml`, verify dashboard shows notification banner
14. **Gate disappears on approval**: Change gate to `approved` in `status.yaml`, verify banner disappears on next poll
15. **Gate banner with missing requestedAt**: Write pending gate to `status.yaml` without `requested_at`, verify banner renders without time indicator

### Edge Cases

1. **Architect tmux not available**: `afx send` fails gracefully (logged at warn), dashboard notification still works
2. **Gate approved between polls**: Notification never shows (correct — transient state)
3. **Tower restart**: In-memory dedup state is lost; re-sends notification for any existing pending gates (acceptable — better to re-notify than miss)
4. **Missing `requested_at` in status.yaml**: Wait time is omitted from banner and `afx status` output; no error
5. **Malformed `gateName` or `builderId`**: Values with ANSI escapes are sanitized; empty/missing values cause `hasGate: false`
6. **Tower restart with pending gate**: After restart, in-memory dedup is lost; existing pending gate triggers a new `afx send` notification (acceptable — better to re-notify than miss)

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| `afx send` fails silently | Medium | Low | Dashboard notification is the primary channel; `afx send` is best-effort with warn logging |
| Notification fatigue | Low | Medium | Only fires on gate transitions, not every poll |
| Stale notifications | Low | Low | Poll-based auto-clear handles this; worst case is one poll cycle delay |

## Design Decisions

- **Banner above terminals, not a badge** — a full-width amber banner above the terminal split is impossible to miss and clearly communicates urgency. A badge on a status bar could be overlooked.
- **No clickable "Approve" button in v1** — showing the CLI command is sufficient. A Tower API endpoint for gate approval can be added later.
- **Enhanced `afx status` (not new)** — `afx status` already shows basic gate warnings. This spec improves the format to include wait time and approval command, not adds the feature from scratch.
- **Single project per dashboard view** — the dashboard always shows one project at a time. No cross-project gate aggregation is needed.
- **`afx send` failures are non-fatal** — logged at warn level, swallowed. Dashboard is the primary notification channel.

## Notes

This is a relatively small feature. The main work is:
1. Adding a `getGateStatusForProject()` call and `gateStatus` field to the `/api/state` response
2. Building the `GateBanner` React component
3. Adding tower-side gate transition detection for `afx send` notifications
4. Enhancing the `afx status` output format
