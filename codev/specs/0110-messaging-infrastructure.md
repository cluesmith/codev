---
approved: 2026-02-15
validated: [claude]
---

# Spec 0110: Messaging Infrastructure

## Problem

`af send` works but is limited in three ways:

1. **No observability**: Messages are injected directly into terminal PTYs. There's no way to see a history of messages, subscribe to them, or display them in the dashboard.
2. **Inconsistent agent naming**: Builders are named ad-hoc — `0109`, `bugfix-269`, `task-784H`. There's no consistent convention that encodes protocol and identity.
3. **No cross-project messaging**: `af send` resolves targets within the current project (by CWD). You can't send a message from one project's agent to another project's agent, even though Tower manages all of them.

## Solution

### 1. Standardized Agent Names

Every agent in Tower gets a canonical name following this convention:

| Agent Type | Name Format | Examples |
|-----------|-------------|----------|
| Architect | `architect` | `architect` |
| SPIR builder | `builder-spir-{id}` | `builder-spir-0109` |
| TICK builder | `builder-tick-{id}` | `builder-tick-0042` |
| BUGFIX builder | `builder-bugfix-{id}` | `builder-bugfix-269` |
| EXPERIMENT builder | `builder-experiment-{id}` | `builder-experiment-0050` |
| Task builder | `builder-task-{id}` | `builder-task-784H` |
| Ad-hoc shell | `shell` / `shell-2` | `shell`, `shell-2` |

**Rules**:
- Exactly one `architect` per project
- Builder names encode their protocol: `builder-{protocol}-{id}`
- `{id}` is the spec number, issue number, or task ID depending on protocol
- Agent names are **case-insensitive** for matching but stored lowercase

**Migration**: The `builder_id` field in `af send` currently accepts raw IDs like `0109` or `bugfix-269`. After this change:
- New format: `builder-spir-0109`, `builder-bugfix-269`
- **Backwards compatibility**: Bare IDs (`0109`, `bugfix-269`) still resolve by prefix match. `architect` and `arch` still work.
- Display names in `af status` and the dashboard use the new format

**Where names are set**:
- `spawn.ts` — assigns `builderId` when creating builders
- `tower-instances.ts` — registers terminals with `role` and `builder_id`
- `state.db` (builders table) — stores `id` field
- `send.ts` — resolves target by name

### 2. Addressing Format: `[project:]agent`

`af send` gets a new addressing format:

```
af send <target> "message"
```

Where `<target>` is:
- `architect` → current project's architect (unchanged)
- `builder-spir-0109` → current project's builder (new naming)
- `codev-public:architect` → specific project's architect (cross-project)
- `codev-public:builder-spir-0109` → specific project's builder (cross-project)

**Resolution order**:
1. If target contains `:`, split into `project:agent`. Resolve project by name (the directory basename, matching what Tower shows).
2. If no `:`, resolve agent within the current project (detected from CWD).
3. Agent name match: exact match first, then prefix match for backwards compat (`0109` matches `builder-spir-0109`).

**Cross-project resolution**: Tower already indexes all projects. The `af send` command queries Tower's API with the full `project:agent` address. Tower resolves the project path and terminal ID.

### 3. Message Bus (WebSocket Subscribe API)

Tower exposes a new WebSocket endpoint:

```
ws://localhost:4100/ws/messages
```

**Protocol**:
- On connect, the client receives all future messages as JSON frames
- Optionally filter by project: `ws://localhost:4100/ws/messages?project=codev-public`

**Message frame format**:
```json
{
  "type": "message",
  "timestamp": "2026-02-15T03:30:00.000Z",
  "from": {
    "project": "codev-public",
    "agent": "builder-spir-0109"
  },
  "to": {
    "project": "codev-public",
    "agent": "architect"
  },
  "content": "GATE: spec-approval ...",
  "metadata": {
    "raw": true,
    "source": "porch"
  }
}
```

**Implementation**:
- Tower already has `handleWebSocket()` in `tower-websocket.ts`. Add a new path handler for `/ws/messages`.
- Maintain a `Set<WebSocket>` of subscribed message clients.
- When `af send` writes to a terminal via the API (`POST /api/terminals/:id/write` or equivalent), Tower also broadcasts the structured message to all message subscribers.
- Messages are **not persisted** — the bus is live-only. Dashboard connects on load, sees messages from that point forward.

**Tower-side changes**:
- `tower-routes.ts`: When handling `af send`'s write request, also emit to message bus
- `tower-websocket.ts`: Add `/ws/messages` handler, manage subscriber set
- New file `tower-messages.ts`: Message bus logic (subscriber management, broadcast, filtering)

### 4. Dashboard Message Panel

A new panel in the Tower dashboard that displays messages from the bus:

- Shows sender, recipient, timestamp, and content
- Color-coded by message type (gate notifications, architect instructions, builder messages)
- Auto-scrolls, with ability to scroll back
- Filter by project or agent
- Click on a message to navigate to the relevant terminal

**This is a follow-up UI task** — the WebSocket API is the foundation. The dashboard panel can be built incrementally after the API exists.

## Design Details

### Message Flow

```
af send codev-public:architect "GATE: ..."
  │
  ▼
Tower API (POST /api/send)  ◄── NEW: structured send endpoint
  │
  ├──► Write to target terminal PTY (existing behavior)
  │
  └──► Broadcast to /ws/messages subscribers (new)
        │
        └──► Dashboard message panel (new, future)
```

### New Tower API Endpoint

Replace the current approach (af send resolves terminal ID locally, then calls `writeTerminal`) with a structured endpoint:

```
POST /api/send
Content-Type: application/json

{
  "to": "codev-public:architect",
  "message": "GATE: spec-approval ...",
  "from": "builder-spir-0109",
  "options": {
    "raw": true,
    "noEnter": false,
    "interrupt": false
  }
}
```

Tower resolves the `to` address, writes to the terminal, and broadcasts to the message bus. This keeps all routing logic in Tower (single source of truth) rather than in the CLI.

**Backwards compatibility**: The existing `writeTerminal` API continues to work. The new `/api/send` endpoint is preferred for `af send` but old clients still function.

### Agent Name Changes in Spawn

```typescript
// Current (spawn.ts line 147)
const builderId = projectId;  // "0109"

// New
const builderId = `builder-spir-${projectId}`;  // "builder-spir-0109"

// Current (spawn.ts line 437)
const builderId = `bugfix-${issueNumber}`;  // "bugfix-269"

// New
const builderId = `builder-bugfix-${issueNumber}`;  // "builder-bugfix-269"
```

## Scope

### Phase 1 (this spec)
- Standardize agent naming in `spawn.ts` (all builder types)
- Update `af send` to support `[project:]agent` addressing
- Add `POST /api/send` endpoint to Tower
- Add `/ws/messages` WebSocket endpoint to Tower
- Broadcast messages to subscribers on send
- Update `af status` display to use new names
- Backwards compatibility for bare IDs
- Unit tests for name resolution, cross-project routing, message bus

### Phase 2 (follow-up)
- Dashboard message panel UI
- Message filtering in dashboard
- Click-to-navigate from message to terminal
- Message history (optional persistence in SQLite)

## Acceptance Criteria

1. `af send architect "msg"` still works (backward compat)
2. `af send builder-spir-0109 "msg"` works with new naming
3. `af send codev-public:architect "msg"` delivers to codev-public's architect from any project
4. `af status` shows agents with new naming convention
5. `/ws/messages` WebSocket broadcasts all `af send` messages in structured JSON
6. `af spawn -p 0109` creates a builder named `builder-spir-0109` (not `0109`)
7. Bare ID `0109` still resolves to `builder-spir-0109` via prefix match
8. Messages include sender, recipient, timestamp, and content

## Dependencies

- **Spec 0108** (Porch gate notifications): Porch calls `af send` — uses the new addressing format
- **Spec 0109** (Tunnel keepalive): Independent, no dependency

## Testing

1. **Unit**: Agent name generation for each protocol type
2. **Unit**: Address parsing (`project:agent` split, bare ID resolution)
3. **Unit**: Message bus subscribe/broadcast/filter
4. **Integration**: Cross-project send (spawn two projects, send between them)
5. **Integration**: WebSocket message subscription receives broadcast
6. **Unit**: Backwards compatibility — bare IDs resolve correctly
