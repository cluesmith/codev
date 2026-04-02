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
- The session can optionally reply back through channel tools

### Permission Relay (Stretch Goal)
The Claude Channel exposes permission relay capability, allowing remote users to approve or deny tool execution requests from builders via the cloud API.

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
- [ ] Two-way communication: channel exposes a `reply` tool so the session can respond
- [ ] Authentication uses existing `ctk_` tower API keys
- [ ] Rate limiting on cloud endpoint (configurable, default 60 messages/minute)
- [ ] All tests pass with >90% coverage
- [ ] Works with Claude Code v2.1.80+ (channels feature requirement)

## Constraints

### Technical Constraints
- **Tunnel dependency**: Cloud messaging requires an active tunnel connection. If the tunnel is down, messages fail (no queueing).
- **Claude Channels limitation**: Channel events only arrive while the session is running. No offline message delivery.
- **Existing `/api/send` contract**: The cloud route must produce identical behavior to local sends — same address resolution, same message formatting, same buffering semantics.
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
- Permission relay comes "for free" with channel protocol

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

### Important (Affects Design)
- [ ] Should the Claude Channel auto-start with builder/architect sessions, or require explicit opt-in? Recommendation: auto-start when Tower has a cloud config (tunnel is connected).
- [ ] Should the channel filter messages (only show messages addressed to this session) or show all workspace messages? Recommendation: filter to messages addressed to the current agent.

### Nice-to-Know (Optimization)
- [ ] Should we add a `--cloud` flag to `afx send`, or auto-detect when cloud routing is needed (e.g., target is on a different machine)?
- [ ] Should the channel support file attachments (existing `afx send --file` feature)?

## Performance Requirements
- **Message delivery latency**: < 2 seconds end-to-end (cloud API → tunnel → Tower → PTY/Channel)
- **Cloud API response time**: < 500ms p95 (proxy response, not delivery confirmation)
- **Rate limit**: 60 messages/minute per tower key (configurable)
- **Channel reconnection**: Automatic reconnect to `/ws/messages` within 5 seconds on disconnect

## Security Considerations
- **Authentication**: Cloud API authenticates with `ctk_` tower API keys via Bearer token. The key identifies which tower to route to.
- **Authorization**: The cloud verifies the API key belongs to the target tower before proxying. No cross-tower messaging without explicit sharing.
- **Transport security**: All cloud communication over TLS (HTTPS/WSS). Tunnel uses HTTP/2 over WSS.
- **Input validation**: Message content validated on cloud side (max size, UTF-8, no control characters except newline)
- **Rate limiting**: Per-key rate limiting on the cloud endpoint to prevent abuse
- **Channel sender gating**: The Claude Channel only accepts events from Tower's localhost WebSocket — no external sources can inject channel events

## Test Scenarios

### Functional Tests
1. **Happy path: Cloud send to builder** — Send message via cloud API, verify it arrives in builder's terminal and channel
2. **Happy path: Cloud send to architect** — Same flow, targeting architect session
3. **Address resolution via cloud** — Cross-project addressing (`project:agent`) works through cloud proxy
4. **Channel event delivery** — Message broadcast on `/ws/messages` appears as channel event in Claude session
5. **Two-way reply** — Session uses channel `reply` tool, message is delivered back to sender
6. **Authentication failure** — Invalid API key returns 401
7. **Tunnel disconnected** — Cloud returns 502 when tower is offline
8. **Rate limiting** — Exceeding rate limit returns 429

### Non-Functional Tests
1. **Latency test**: Measure end-to-end delivery time under normal load
2. **Reconnection test**: Channel reconnects to `/ws/messages` after Tower restart
3. **Concurrent sends**: Multiple simultaneous cloud sends to same tower

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
| Channel permission relay complexity | Medium | Low | Implement as stretch goal, ship core send/receive first |
| Cloud server deployment coordination | Medium | Medium | Design cloud API contract first, implement server-side separately |

## Notes

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
