# Specification: Cloud Messaging — Send and Receive afx-style Messages via Codev Cloud

## Metadata
- **ID**: spec-2026-04-02-cloud-messaging
- **Status**: draft
- **Created**: 2026-04-02

## Clarifying Questions Asked

1. **Q: Should this use Claude Channels as the receive mechanism, or build a separate notification system?**
   A: The issue explicitly mentions Claude Channels as a possible receive mechanism. Given that Claude Channels are now a shipping feature (v2.1.80+) with a clean MCP protocol, they are the right abstraction for pushing messages into running sessions. A separate notification system would duplicate what Channels already provide.

2. **Q: What authentication model for message senders?**
   A: Reuse the existing `ctk_` tower API keys. They already authenticate the tunnel connection and are scoped per-tower. No need for a separate key type — the cloud already knows which tower a key belongs to.

3. **Q: Should there be a web UI on codevos.ai for sending/reading messages?**
   A: Out of scope for this spec. The cloud API endpoints enable future web UI development, but the initial deliverable is the API + CLI + Channel integration.

4. **Q: Rate limiting and abuse prevention?**
   A: Yes, cloud-side rate limiting is required. Messages are small text payloads proxied to local Tower — the blast radius of abuse is limited but rate limiting prevents spam.

## Problem Statement

`afx send` only works locally — the sender must be on the same machine as Tower. For distributed teams, remote monitoring, or mobile-friendly workflows, there is no way to:

- Send a message to a builder from a phone or different machine
- Receive gate notifications, PR readiness alerts, or blocker reports without being at the terminal
- Approve permission requests remotely

This forces the architect to be physically present at their development machine to interact with builders, limiting the effectiveness of the autonomous builder workflow.

## Current State

### Local Message Flow
1. CLI (`afx send`) detects the current workspace and builder identity
2. Posts to Tower's `POST /api/send` on `localhost:4100`
3. Tower resolves the target address (e.g., `builder-spir-655`) to a terminal ID
4. Message is formatted, buffered if user is typing, then written to PTY
5. Message frame is broadcast to `/ws/messages` WebSocket subscribers

### Cloud Tunnel (Already Exists)
- Tower maintains an HTTP/2-over-WebSocket tunnel to `cloud.codevos.ai`
- All Tower API routes are already proxied through the tunnel
- Authentication via `ctk_` API keys in the WebSocket handshake
- Browser access via `/t/{towerId}/...` proxy path
- Metadata (workspace paths, terminal IDs) synced every 30 seconds

### Key Limitation
The tunnel already proxies HTTP requests bidirectionally, meaning `POST /api/send` is technically reachable through the cloud. However:
- There is no public cloud API endpoint that routes to a specific tower's `/api/send`
- There is no way for sessions to receive messages pushed from the cloud
- There is no CLI support for sending via the cloud route

## Desired State

### Send: Remote to Tower
A cloud API endpoint accepts authenticated messages and routes them through the existing tunnel to the target Tower's `POST /api/send`. From the sender's perspective, it works identically to local `afx send` — same address format, same message semantics.

```
# From any machine, authenticated with tower API key:
afx send --cloud builder-spir-655 "run tests"

# Or via direct API call:
POST https://cloud.codevos.ai/api/messages/send
Authorization: Bearer ctk_...
{ "to": "builder-spir-655", "message": "run tests" }
```

### Receive: Tower to Session
A Claude Channel MCP server subscribes to Tower's WebSocket message bus (`/ws/messages`) and pushes incoming messages into the running Claude Code session as channel events. This means:

- Builders and architects receive `afx send` messages directly in their Claude context
- Gate notifications, blocker reports, and status updates appear as channel events
- The session can send messages back through the channel's `send_message` tool

### Delivery Model: Channel-Only for Cloud Messages (No Double Delivery)

When a message arrives via the cloud proxy, Tower's `/api/send` writes it to the PTY as today (maintaining backward compatibility). The Claude Channel MCP server subscribes to `/ws/messages` but **only delivers messages that originate from the cloud** — it does NOT re-deliver locally-originated messages that were already written to the PTY. This is achieved by filtering on the `metadata.source` field in the message frame:

- `source: "cloud"` → Channel delivers as structured event (cloud-originated, PTY write is the fallback for non-channel sessions)
- `source: "api"` (local `afx send`) → Channel ignores (already delivered via PTY)

For sessions with an active channel, Tower adds a `X-Cloud-Origin: true` header to cloud-proxied requests. The `/api/send` handler uses this to set `metadata.source = "cloud"` on the broadcast frame. For channel-equipped sessions, a future enhancement can suppress the PTY write entirely — but for v1, double delivery is avoided by the channel's source filter.

### Receive Scope Limitation

Channel events only arrive while the Claude Code session is running with the channel server active. This spec does **not** provide offline notification delivery. The "receive" capability enables:
- Real-time message delivery into active sessions (builders and architects)
- Structured context injection (vs. raw terminal text)
- Programmatic reply capability

It does **not** replace checking the Tower dashboard or SSE event stream for messages sent while offline.

## Stakeholders
- **Primary Users**: Architects who need to interact with builders remotely (phone, laptop, web)
- **Secondary Users**: Builders (receive side — messages appear in their sessions)
- **Technical Team**: Codev maintainers
- **Business Owners**: Codev project lead

## Success Criteria
- [ ] `afx send --cloud <target> "message"` delivers a message to a running builder/architect session via the cloud tunnel
- [ ] Cloud API endpoint `POST /api/messages/send` accepts authenticated requests and proxies to the correct Tower
- [ ] Claude Channel MCP server receives messages from Tower's `/ws/messages` bus and delivers them as channel events to the Claude Code session
- [ ] Channel events include structured metadata (sender, project, timestamp)
- [ ] Two-way communication: channel exposes a `send_message(to, message)` tool (stateless, explicit target address)
- [ ] Authentication uses existing `ctk_` tower API keys
- [ ] Rate limiting on cloud endpoint (configurable, default 60 messages/minute)
- [ ] All tests pass with >90% coverage
- [ ] Works with Claude Code v2.1.80+ (channels feature requirement)

## Constraints

### Technical Constraints
- **Tunnel dependency**: Cloud messaging requires an active tunnel connection. If the tunnel is down, messages fail (no queueing).
- **Claude Channels limitation**: Channel events only arrive while the session is running. No offline message delivery.
- **Existing `/api/send` contract**: The cloud route must produce identical *delivery* behavior to local sends — same address resolution, same message formatting, same buffering semantics. However, *response semantics* differ: the cloud proxy returns success when Tower accepts the message (may be buffered), not when the message is displayed. Remote callers cannot observe send-buffer flush timing.
- **Cloud server changes**: This spec requires new API endpoints on `cloud.codevos.ai`. The cloud server is a separate deployment.

### Business Constraints
- Must not break existing local `afx send` behavior
- Must work with existing tower registration and key management

## Assumptions
- The cloud server (`cloud.codevos.ai`) can be updated to add new API endpoints
- Claude Code v2.1.80+ is available and channels are stable
- The `@modelcontextprotocol/sdk` package is available for building the channel server
- Tower's WebSocket message bus (`/ws/messages`) provides all messages needed for the channel

## Solution Approaches

### Approach 1: Cloud Proxy + Claude Channel (Recommended)

**Description**: Two components working together:
1. **Cloud proxy endpoint**: A new `POST /api/messages/send` on codevos.ai that authenticates the request, looks up the tower's tunnel connection, and proxies the message through the existing HTTP/2 tunnel to Tower's `POST /api/send`.
2. **Claude Channel MCP server**: A local MCP server process that connects to Tower's `/ws/messages` WebSocket, receives message frames, and emits `notifications/claude/channel` events into the Claude Code session.

**Pros**:
- Leverages existing tunnel infrastructure — no new connection protocols
- Claude Channels are the official mechanism for pushing events into sessions
- Minimal new code on the cloud side (routing + auth)
- Clean separation: cloud handles inbound routing, channel handles session delivery
- Permission relay possible in future (channel protocol supports it)

**Cons**:
- Requires Claude Code v2.1.80+ for channel support
- Channel requires `--dangerously-load-development-channels` flag during development (or publishing to Anthropic's allowlist)
- No message persistence — if session is offline, messages are lost

**Estimated Complexity**: Medium
**Risk Level**: Low

### Approach 2: Cloud Proxy + Tower Push Notifications

**Description**: Same cloud proxy for sending, but instead of a Claude Channel, Tower pushes messages directly into sessions via PTY writes (as it does today) and adds a cloud-side WebSocket subscription endpoint for remote monitoring.

**Pros**:
- No Claude Code version dependency
- Messages delivered via existing PTY mechanism (proven reliable)
- Cloud WebSocket allows web/mobile clients to subscribe

**Cons**:
- PTY writes already work locally — this adds nothing new for the receive side
- No structured event delivery into Claude's context (just raw terminal text)
- Cloud WebSocket subscription is a larger feature (new persistent connections on cloud side)
- No permission relay capability

**Estimated Complexity**: Medium-High
**Risk Level**: Medium

### Approach 3: Full Cloud Message Broker

**Description**: Cloud acts as a message broker with persistence. All messages (local and remote) route through the cloud. Provides offline delivery, message history, and a unified API.

**Pros**:
- Offline message delivery (messages queued until session connects)
- Full message history and audit trail
- Single unified messaging API

**Cons**:
- Significantly more complex (message storage, delivery guarantees, ordering)
- Breaks the current local-first architecture
- Adds cloud dependency for local messaging (regression)
- Overkill for the current use case

**Estimated Complexity**: High
**Risk Level**: High

### Recommendation: Approach 1

Approach 1 is the clear winner. It:
- Builds on existing infrastructure (tunnel proxying, `/api/send`, `/ws/messages`)
- Uses the official Claude mechanism for session events (Channels)
- Has the smallest scope while delivering the full feature set
- Enables permission relay with minimal additional work

## Open Questions

### Critical (Blocks Progress)
- [x] Does the existing tunnel support proxying `POST /api/send` from the cloud side? **Yes** — the tunnel proxies all HTTP requests bidirectionally. The cloud just needs an endpoint that routes to the right tunnel.

### Important (Affects Design) — Resolved
- [x] **Channel auto-start vs opt-in?** Decision: Auto-start when Tower is running and the session is a builder or architect terminal. The channel server discovers its identity via `detectCurrentBuilderId()` (inherits worktree `process.cwd()` from Claude Code). Falls back to `'architect'` if not in a builder worktree. Only one channel subscriber per terminal ID — if a subscriber already exists for that terminal, the new connection replaces the old one (prevents duplicates on session restart).
- [x] **Filter per-session or all messages?** Decision: Filter to messages addressed to the current agent only. The channel subscribes to `/ws/messages?project=<workspace-basename>` and further filters client-side on `frame.to.agent === currentAgentId`.
- [x] **`--cloud` flag vs auto-detect?** Decision: Explicit `--cloud` flag. Auto-detection adds latency on local failure and creates ambiguous behavior. The `--cloud` flag is clear, predictable, and easy to script. Local `afx send` (default) is unchanged.
- [x] **File attachments via cloud?** Decision: Out of scope for v1. Cloud API rejects `--file` with a clear error message ("file attachments not supported via cloud messaging").

## Performance Requirements
- **Message delivery latency**: < 2 seconds end-to-end (cloud API → tunnel → Tower → PTY/Channel)
- **Cloud API response time**: < 500ms p95 (proxy response, not delivery confirmation)
- **Rate limit**: 60 messages/minute per tower key (configurable)
- **Channel reconnection**: Automatic reconnect to `/ws/messages` within 5 seconds on disconnect

## Security Considerations
- **Authentication**: Cloud API authenticates with `ctk_` tower API keys via Bearer token. The key identifies which tower to route to.
- **Cloud-to-Tower trust**: When the cloud proxies a message through the tunnel, it adds a `X-Cloud-Origin: true` header. Tower trusts this header because the tunnel is an authenticated HTTP/2 connection — only the cloud server can inject headers into tunnel-proxied requests. Local requests (from localhost) cannot set this header (Tower strips it on non-tunnel requests).
- **Authorization**: The cloud verifies the API key belongs to the target tower before proxying. All holders of a tower key can message any builder/architect in that tower (tower-scoped, not agent-scoped). No cross-tower messaging.
- **Key exposure risk**: `ctk_` keys used on mobile/remote devices carry the same tower-level access as the local tunnel. Users who need tighter scoping should rotate keys via `afx tower connect --reauth`. Key revocation is immediate (cloud rejects on next request, tunnel disconnects).
- **Transport security**: All cloud communication over TLS (HTTPS/WSS). Tunnel uses HTTP/2 over WSS.
- **Input validation**: Message content validated on cloud side — max 64KB payload (body JSON), UTF-8 only, no control characters except newline/tab. `to` field max 128 chars. `message` field max 60KB.
- **Rate limiting**: Per-key rate limiting on the cloud endpoint — 60 messages/minute default, 429 response with `Retry-After` header on excess.
- **Channel sender gating**: The Claude Channel only accepts events from Tower's localhost WebSocket — no external sources can inject channel events.
- **Audit**: Cloud logs message metadata (timestamp, from, to, tower_id, payload size) but does NOT log message content. Content is proxied but not persisted.

## Test Scenarios

### Functional Tests
1. **Happy path: Cloud send to builder** — Send message via cloud API, verify it arrives in builder's terminal and channel
2. **Happy path: Cloud send to architect** — Same flow, targeting architect session
3. **Address resolution via cloud** — Cross-project addressing (`project:agent`) works through cloud proxy
4. **Address resolution errors** — Invalid address returns 404, ambiguous address returns 409, both with descriptive messages
5. **Channel event delivery** — Message broadcast on `/ws/messages` with `source: "cloud"` appears as channel event in Claude session
6. **No double delivery** — Local `afx send` (source: "api") does NOT produce a channel event (only PTY delivery)
7. **Two-way send_message tool** — Session uses channel `send_message(to, message)` tool, message is delivered to target
8. **Authentication failure** — Invalid API key returns 401
9. **Tunnel disconnected** — Cloud returns 502 when tower is offline
10. **Rate limiting** — Exceeding rate limit returns 429 with Retry-After header
11. **Payload validation** — Oversized message (>60KB), invalid UTF-8, missing required fields all return 400
12. **Channel identity detection** — Channel correctly identifies itself as the current builder ID (from worktree path) or architect
13. **Channel startup without Tower** — Channel server handles Tower not running gracefully (retry with backoff)

### Non-Functional Tests
1. **Latency test**: Measure end-to-end delivery time under normal load (target: <2s)
2. **Reconnection test**: Channel reconnects to `/ws/messages` after Tower restart, no message loss during reconnect window
3. **Concurrent sends**: Multiple simultaneous cloud sends to same tower
4. **Duplicate subscriber prevention**: Restarting a session replaces the old channel subscriber (no duplicate events)

## Dependencies
- **External Services**: `cloud.codevos.ai` (new API endpoint required)
- **Internal Systems**: Tower (existing `/api/send` and `/ws/messages`), tunnel infrastructure
- **Libraries/Frameworks**: `@modelcontextprotocol/sdk` (for Claude Channel MCP server)

## References
- [Claude Channels documentation](https://code.claude.com/docs/en/channels-reference) — MCP protocol for channels
- [Claude Channels user guide](https://code.claude.com/docs/en/channels) — Setup and enterprise controls
- Spec 0097: Cloud Tower Client — Tunnel architecture
- Spec 0110: Messaging Infrastructure — Address resolution, message bus
- Issue #655 — Original feature request

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Claude Channels API changes (research preview) | Medium | High | Pin to specific SDK version, abstract channel protocol behind interface |
| Tunnel latency spikes | Low | Medium | Timeout + retry on cloud proxy, clear error messages |
| Channel permission relay complexity | Medium | Low | Explicitly deferred to follow-on spec |
| Cloud server deployment coordination | Medium | Medium | Design cloud API contract first, implement server-side separately |

## Cloud API Contract

### `POST /api/messages/send`

**Request:**
```
Authorization: Bearer ctk_...
Content-Type: application/json

{
  "to": "builder-spir-655",          // Required. Address: "[project:]agent"
  "message": "run tests",            // Required. Max 60KB UTF-8 text.
  "from": "architect",               // Optional. Sender identity for display.
  "options": {                        // Optional.
    "raw": false,                     //   Skip message formatting wrapper
    "interrupt": false                //   Send Ctrl+C before message
  }
}
```

**Success Response (200):**
```json
{
  "ok": true,
  "delivered": true,                  // false if message was buffered (user typing)
  "target": {
    "project": "codev",
    "agent": "builder-spir-655",
    "terminal": "term-abc123"
  }
}
```

**Error Responses:**
| Status | Code | When |
|--------|------|------|
| 400 | `INVALID_PARAMS` | Missing `to`/`message`, payload too large, invalid UTF-8 |
| 401 | `UNAUTHORIZED` | Invalid or missing API key |
| 404 | `NOT_FOUND` | Target agent not found in any workspace |
| 409 | `AMBIGUOUS` | Multiple matches for target address |
| 429 | `RATE_LIMITED` | Per-key rate limit exceeded. `Retry-After` header included |
| 502 | `TUNNEL_OFFLINE` | Tower is not connected to the cloud |

**Error envelope:**
```json
{
  "ok": false,
  "error": { "code": "NOT_FOUND", "message": "No agent matching 'builder-spir-999' found" }
}
```

The cloud endpoint transparently proxies Tower's 400/404/409 error responses, wrapping them in the standard cloud error envelope. The cloud adds its own 401/429/502 errors for auth, rate limiting, and connectivity failures.

### Channel Event Format

Messages delivered to Claude Code sessions via the channel:

```
<channel source="codev-messages" from="architect" project="codev" timestamp="2026-04-02T10:30:00Z">
Message content here
</channel>
```

The `from`, `project`, and `timestamp` metadata are set from the message frame's fields.

### Channel `send_message` Tool

The channel exposes a stateless MCP tool for outbound messages:

```json
{
  "name": "send_message",
  "description": "Send a message to a builder or architect in the current workspace",
  "inputSchema": {
    "type": "object",
    "properties": {
      "to": { "type": "string", "description": "Target agent address (e.g., 'architect', 'builder-spir-655')" },
      "message": { "type": "string", "description": "Message text to send" }
    },
    "required": ["to", "message"]
  }
}
```

The tool posts to Tower's `POST /api/send` on localhost. It uses the channel server's detected identity as the `from` field.

## Notes

### Permission Relay — Deferred

Permission relay (allowing remote users to approve/deny tool execution requests) is explicitly **deferred to a follow-on spec**. The Claude Channel protocol supports it (`claude/channel/permission` capability), but implementing it requires:
- Cloud API endpoints for permission request forwarding
- A notification mechanism for the remote approver (push notification, web UI)
- Timeout and fallback semantics when remote approval is unavailable

This is a distinct feature with its own design space. The channel infrastructure built in this spec provides the foundation.

### Component Boundaries

This spec covers three distinct components:

1. **Cloud API endpoint** (`POST /api/messages/send` on codevos.ai) — Authenticates and routes messages through the tunnel. This is a cloud-server change.

2. **Claude Channel MCP server** (local, spawned by Claude Code) — Subscribes to Tower's `/ws/messages` WebSocket and emits channel events. This is a new package/module in the codev repo.

3. **CLI enhancement** (`afx send --cloud`) — Optional convenience flag for sending via the cloud route instead of local Tower. Falls back to cloud when local Tower is unreachable.

### What This Spec Does NOT Cover
- Web UI for sending/reading messages on codevos.ai
- Mobile push notifications
- Message persistence or offline delivery
- Cross-tower messaging (messages between different towers)
- Changes to the existing local `afx send` behavior

## Expert Consultation

**Date**: 2026-04-02
**Models Consulted**: Gemini, Codex (GPT-5.4), Claude
**Iteration**: 1

### Gemini — REQUEST_CHANGES (addressed)
- **Double delivery conflict**: PTY write + channel event = duplicate messages. **Resolution**: Added source-based filtering — channel only delivers `source: "cloud"` messages, ignores local `source: "api"` messages.
- **Channel identity**: MCP server must discover its own agent ID. **Resolution**: Specified use of `detectCurrentBuilderId()` via worktree CWD inheritance.
- **Reply tool statefulness**: Stateful `reply` is brittle. **Resolution**: Replaced with stateless `send_message(to, message)` tool with explicit target address.

### Codex — REQUEST_CHANGES (addressed)
- **Cloud-to-Tower trust contract**: Missing mechanism for Tower to verify cloud-proxied requests. **Resolution**: Added `X-Cloud-Origin: true` header set by cloud, trusted because tunnel is authenticated H2 connection. Tower strips this header on non-tunnel requests.
- **Receive semantics mismatch**: Channel requires running session but spec promised "remote notification". **Resolution**: Added explicit "Receive Scope Limitation" section narrowing the promise.
- **Reply routing underspecified**: No message envelope or routing contract. **Resolution**: Added complete Cloud API Contract section with request/response schemas and error envelope.
- **Channel auto-start lifecycle undefined**: No startup, identity, or duplicate prevention. **Resolution**: Resolved all open questions with concrete decisions (auto-start, identity via CWD, subscriber replacement).
- **Cloud API surface incomplete**: Error schema, payload limits, timeout behavior missing. **Resolution**: Added full API contract with error table, payload limits (64KB body, 60KB message), and response semantics.
- **Security gaps**: Key exposure on mobile, audit logging. **Resolution**: Added key rotation guidance, revocation semantics, and explicit audit logging policy (metadata only, no content).
- **Missing test scenarios**: Reconnect duplicates, oversized payloads, identity spoofing. **Resolution**: Added 5 new test scenarios covering these cases.

### Claude — COMMENT (addressed)
- **Permission relay scope ambiguity**: Mentioned in 3 places with no criteria. **Resolution**: Explicitly deferred to follow-on spec with clear rationale.
- **Cloud error passthrough strategy**: Undefined. **Resolution**: Specified transparent proxy of Tower 400/404/409 wrapped in cloud error envelope.
- **Message size limit**: Not specified. **Resolution**: Added explicit limits (64KB body, 60KB message field).
- **"Identical behavior" caveat**: Buffer semantics differ remotely. **Resolution**: Added caveat in constraints section about response semantics vs delivery semantics.
- **Open questions should be decided**: Auto-start, filtering, --cloud flag. **Resolution**: All resolved with concrete decisions.
