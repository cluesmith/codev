# Specification: Overview Dashboard

## Metadata
- **ID**: 0029-overview-dashboard
- **Protocol**: TICK
- **Status**: specified
- **Created**: 2025-12-05
- **Priority**: medium

## Problem Statement

When running multiple agent-farm instances across different projects, there's no centralized view to see all running instances at a glance. Users must remember which ports each project is using and manually navigate to each dashboard.

## Current State

- Each agent-farm instance runs independently
- Port registry exists at `~/.agent-farm/ports.json` tracking all allocations
- No unified view across instances
- Users must remember/bookmark individual dashboard URLs

## Desired State

An overview dashboard that provides a single page showing all running agent-farm instances with:
- Project names and their allocated ports
- Links to each project's dashboard
- Status indication (running/stopped)
- Ability to launch new instances

## Success Criteria

- [ ] Overview dashboard lists all projects from `~/.agent-farm/ports.json`
- [ ] Shows all ports per project with their types (architect, builder, util, annotation)
- [ ] Provides clickable links to each dashboard
- [ ] Shows status (running/stopped) based on port availability
- [ ] Allows launching new agent-farm instances via directory picker
- [ ] Handles missing/corrupt ports.json gracefully (empty state)
- [ ] Fails with clear error if port 4100 is already in use

## Technical Approach

### Standalone Server

Run a lightweight server (separate from per-project dashboards) that:

1. **Reads global port registry**: Parse `~/.agent-farm/ports.json`
2. **Checks port status**: For each registered port, check if it's actually listening
3. **Renders dashboard**: Show all projects with their ports and status
4. **Launch capability**: Directory picker, then `cd <path> && afx start`

### CLI Integration

```bash
# Start overview dashboard on port 4100
afx overview

# Or with custom port
afx overview --port 4100
```

If port 4100 is in use, exit with error: "Port 4100 already in use. Try: afx overview --port <other>"

### UI Layout

```
┌─────────────────────────────────────────────────────┐
│  Agent Farm Overview                           [+]  │
├─────────────────────────────────────────────────────┤
│                                                     │
│  codev (running)                                    │
│    ├─ Architect: http://localhost:4200  [open]      │
│    ├─ Builder 0011: http://localhost:4210  [open]   │
│    └─ Util: http://localhost:4250  [open]           │
│                                                     │
│  webapp (stopped)                                   │
│    └─ Last active: 2025-12-04                       │
│                                                     │
│  [+ Launch New Instance]                            │
│    [ Select Project Directory... ] [Start]          │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### Launch New Instance

1. User clicks directory picker (`<input type="file" webkitdirectory>`)
2. Browser sends selected path to server
3. Server runs: `cd <path> && afx start` (detached)
4. Dashboard refreshes to show new instance

### Port Status Detection

```typescript
async function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => { resolve(false); });
    socket.connect(port, '127.0.0.1');
  });
}
```

## Scope

### In Scope
- Standalone overview server on port 4100
- Read from global port registry
- Port status detection
- Links to project dashboards
- Launch new instances via directory picker

### Out of Scope
- Cross-instance communication
- Real-time status updates (manual refresh is fine)
- Remote instance management

## Test Scenarios

1. Start overview with no instances running - shows empty state
2. Start one agent-farm instance, refresh overview - shows the instance
3. Start second instance in different project - both appear
4. Stop one instance - status changes to "stopped"
5. Click dashboard link - opens correct project dashboard
6. Use directory picker to launch new instance - spawns correctly
7. Corrupt/missing ports.json - graceful error handling
8. Port 4100 in use - fails with clear error message

## Dependencies

- Port registry from 0008 (already implemented)
- Directory-aware titles from 0011 (already implemented)

## Estimated Effort

- Server implementation: ~2 hours
- UI/template: ~1 hour
- CLI integration: ~30 minutes
- Testing: ~30 minutes
