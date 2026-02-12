# Spec 0100: Porch Gate Notifications

## Summary

When a builder hits a porch gate (human review required, PR ready, etc.), the Tower dashboard should display the blocker prominently and a message should be sent to the architect terminal. When the gate is approved and the builder unblocks, the notification should disappear from the dashboard.

## Problem

Builders hit gates silently. The only way to discover a builder is blocked is to run `porch status <id>` or manually check `codev/projects/<id>/status.yaml`. In practice, builders sit idle for minutes or hours because the architect (human) doesn't notice the gate. This wastes time and breaks flow.

Three specific gaps:

1. **No dashboard visibility**: The Tower API already returns `gateStatus` in `/api/state`, but the dashboard doesn't render it. There's no visual indicator that a builder needs attention.

2. **No architect notification**: When a gate fires, nothing alerts the architect terminal. The human must actively poll or remember to check. `af send` exists and can inject messages into the architect's tmux session, but porch doesn't call it.

3. **No auto-clear**: If the dashboard did show gate status, it would need to clear the notification when the gate is approved and the builder resumes.

## Current State

- `getGateStatusForProject()` in `gate-status.ts` reads `status.yaml` and returns `{ hasGate, gateName, builderId }`.
- Tower includes `gateStatus` in the `/api/state` response.
- Dashboard receives `gateStatus` but ignores it — no component renders it.
- `af send <target> "message"` can inject formatted messages into any tmux session (architect or builder).
- Porch already writes `requested_at` (ISO timestamp) to `status.yaml` when a gate fires — this is the data source for "how long has it been waiting."
- The dashboard polls `/api/state` every few seconds, so gate status changes are eventually visible if rendered.

## Desired State

### (i) Dashboard Gate Notification

When any builder has a pending gate, the dashboard shows a persistent, prominent notification. The notification includes:

- Which builder is blocked (e.g., "Builder 0100")
- What gate is pending (e.g., "spec-approval", "pr-ready")
- How long it's been waiting (e.g., "3m ago")
- A clear call-to-action (e.g., "Run: `porch approve 0100 spec-approval`")

The notification should be impossible to miss — not buried in a collapsed panel. Consider a banner at the top of the dashboard or a badge on the status bar.

Notifications are **per-project** — each project's dashboard view shows only the gates for that project's builders. When the Tower serves multiple projects, each project's `/api/state` response already scopes `gateStatus` to that project path.

### (ii) Architect Terminal Message

When a gate fires, porch (or the Tower) sends a formatted message to the architect terminal via `af send`. The message should:

- Identify the builder and gate type
- Include the approval command
- Be visually distinct (use ANSI formatting or the existing `af send` wrapper format)

This happens once per gate transition to `pending` — not on every poll.

### (iii) Auto-Clear on Unblock

When the gate is approved and the builder resumes:

- The dashboard notification disappears on the next `/api/state` poll (because `getGateStatusForProject()` no longer returns `hasGate: true`)
- No explicit "clear" action needed — the existing poll-based architecture handles this naturally

## Success Criteria

- [ ] Dashboard shows a visible notification when any builder has a pending gate
- [ ] Notification includes builder ID, gate name, wait time, and approval command
- [ ] Notification disappears within one poll cycle after gate approval
- [ ] Architect terminal receives a message when a gate transitions to pending
- [ ] Message is sent exactly once per gate (not on every poll)
- [ ] Existing `af send` protocol is used (no new message transport)
- [ ] Works for all gate types: spec-approval, plan-approval, pr-ready, merge-approval
- [ ] `af status` output shows pending gate info for blocked builders
- [ ] No notification when Tower runs without any active builders
- [ ] Existing tests pass; new tests cover notification behavior

## Constraints

### Technical Constraints

- Dashboard is React (Vite) — no server push, relies on polling `/api/state`
- `af send` uses tmux buffer paste — requires the architect to have an active tmux session
- Gate status is read from filesystem (`status.yaml`), not from a real-time event bus
- The Tower process may not have the project's working directory in its `cwd` — must use absolute paths when calling `af send` or porch commands

### Design Constraints

- New dependencies are acceptable if justified
- Must not change the `af send` protocol or porch state format
- Notification must be clearly visible without being disruptive (no modal dialogs, no sound)

## Assumptions

- The architect terminal runs inside a tmux session (standard Tower setup)
- `af send architect "message"` works from the Tower process context
- The dashboard already polls `/api/state` at a reasonable frequency (~3-5s)
- Gate status changes are infrequent (at most a few per hour per builder)

## Solution Approach

### Trigger: Tower-Side Gate Watcher

The Tower already calls `getGateStatusForProject()` on every `/api/state` poll. Add state tracking to detect gate transitions:

- Track the last-known gate status per project (in memory)
- When a gate transitions from `no gate` to `pending`, trigger the architect notification via `af send`
- This avoids modifying porch itself — the Tower is the integration point

### Dashboard: Gate Banner Component

Add a `GateBanner` component that renders when `gateStatus.hasGate === true`. Position it prominently (above the terminal split or as a status bar alert). The component reads from the existing `gateStatus` field in the API response — no new API endpoint needed.

### Wait Time Data Source

Porch already stores `requested_at` (ISO 8601 timestamp) in `status.yaml` when a gate transitions to `pending`. Extend `getGateStatusForProject()` to parse and return this timestamp. The `GateStatus` interface becomes:

```typescript
interface GateStatus {
  hasGate: boolean;
  gateName?: string;
  builderId?: string;
  requestedAt?: string;  // ISO 8601 from status.yaml gates.<name>.requested_at
}
```

The dashboard computes the "3m ago" display client-side from `requestedAt`.

### `af status` Output

`af status` already queries the Tower for builder state. Extend its output to include gate info when a builder is blocked:

```
Builder 0100  blocked  spec-approval (waiting 3m)  → porch approve 0100 spec-approval
Builder 0101  running  implement:phase_2
```

The gate info comes from the Tower's `/api/state` response (same `gateStatus` field the dashboard uses). `af status` already calls this endpoint.

### Deduplication

The Tower tracks which gates it has already notified about (in-memory Map of `projectPath:gateName` -> timestamp). A notification is sent only when a new gate appears that wasn't in the previous state. This prevents duplicate messages on every poll.

### Sanitization

Gate names and builder IDs originate from `status.yaml` file content. Before interpolating into `af send` messages, sanitize:

- Strip ANSI escape sequences from gate names and builder IDs
- Reject values containing tmux control characters (`;`, `\n`, `\r`)
- Use `af send`'s existing file-based message delivery (writes to temp file, loads into tmux buffer) which avoids shell injection

### Multiple Gates

Each pending gate produces its own notification — both in the dashboard (one banner per gate) and via `af send` (one message per gate transition). If multiple builders hit gates simultaneously, each gets a separate `af send` call. Since gate transitions are infrequent (at most a few per hour), flooding is not a concern. If `af send` fails for one gate, it does not block or retry — the dashboard notification is the primary channel.

## Test Scenarios

### Tower API Unit Tests (vitest)

1. **`getGateStatusForProject` returns `requestedAt`**: Write a `status.yaml` with `requested_at`, verify the field is parsed and returned
2. **Gate transition detection**: Mock sequential calls to `getGateStatusForProject`, verify `af send` is triggered only on `no gate → pending` transitions
3. **Dedup across polls**: Same pending gate on 3 consecutive polls → only 1 `af send` call
4. **Sanitization**: Gate names with ANSI escapes or semicolons are stripped/rejected before `af send`

### Dashboard Component Tests (vitest + React Testing Library)

5. **GateBanner renders when `gateStatus.hasGate` is true**: Mock API response with gate status, verify banner appears with builder ID, gate name, wait time, and approval command
6. **GateBanner hidden when no gate**: Mock API response with `hasGate: false`, verify no banner
7. **Wait time display**: Mock `requestedAt` = 3 minutes ago, verify "3m ago" text

### CLI Tests (vitest)

8. **`af status` shows gate info**: Mock Tower API response with a blocked builder, verify CLI output includes gate name and approval command

### Playwright E2E Tests

9. **Gate appears in dashboard**: Start Tower, activate project, write pending gate to `status.yaml`, verify dashboard shows notification banner
10. **Gate disappears on approval**: Change gate to `approved` in `status.yaml`, verify banner disappears on next poll
11. **Multiple builders blocked**: Two projects with pending gates, both banners visible

### Edge Cases

1. **Architect tmux not available**: `af send` fails gracefully, dashboard notification still works
2. **Gate approved between polls**: Notification never shows (correct — transient state)
3. **Tower restart**: In-memory dedup state is lost; re-sends notification for any existing pending gates (acceptable — better to re-notify than miss)

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| `af send` fails silently | Medium | Low | Dashboard notification is the primary channel; `af send` is best-effort |
| Notification fatigue | Low | Medium | Only fires on gate transitions, not every poll |
| Stale notifications | Low | Low | Poll-based auto-clear handles this; worst case is one poll cycle delay |

## Design Decisions

- **No clickable "Approve" button in v1** — showing the CLI command is sufficient. A Tower API endpoint for gate approval can be added later.
- **`af status` shows pending gates** — in addition to the dashboard, `af status` output should include pending gate info for each builder so the architect can see blockers from the CLI.

## Notes

This is a relatively small feature — the infrastructure (gate detection, af send, dashboard state) already exists. The main work is wiring them together and adding the dashboard UI component.
