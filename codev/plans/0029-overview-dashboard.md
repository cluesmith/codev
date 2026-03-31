# Plan: Overview Dashboard

## Metadata
- **Spec**: codev/specs/0029-overview-dashboard.md
- **Protocol**: TICK
- **Created**: 2025-12-05

## Implementation Overview

A standalone dashboard on port 4100 that shows all running agent-farm instances and allows launching new ones via directory picker.

## Implementation Steps

### Step 1: Create Overview Server

**File**: `agent-farm/src/servers/overview-server.ts`

Create a simple HTTP server that:
1. Serves the overview HTML template
2. Provides `/api/status` endpoint returning all instances
3. Provides `/api/launch` endpoint to start new instances
4. Checks port status for each registered instance

```typescript
// Key functions needed:
async function isPortListening(port: number): Promise<boolean>
async function getInstances(): Promise<Instance[]>
async function launchInstance(projectPath: string): Promise<void>
```

### Step 2: Create Overview HTML Template

**File**: `codev/templates/overview.html`

Simple single-page dashboard:
- Header: "Agent Farm Overview"
- List of instances with status indicators
- Each instance shows project name, ports, and links
- Directory picker + Start button at bottom
- Auto-refresh every 5 seconds (or manual refresh button)

### Step 3: Add CLI Command

**File**: `agent-farm/src/commands/overview.ts`

```typescript
export async function overview(options: { port?: number }): Promise<void> {
  const port = options.port || 4100;

  // Check if port available
  if (await isPortInUse(port)) {
    console.error(`Port ${port} already in use. Try: afx overview --port <other>`);
    process.exit(1);
  }

  // Start overview server
  startOverviewServer(port);
  console.log(`Overview dashboard: http://localhost:${port}`);
}
```

### Step 4: Register Command in CLI

**File**: `agent-farm/src/index.ts`

Add overview command to the CLI:
```typescript
program
  .command('overview')
  .description('Start the overview dashboard showing all instances')
  .option('-p, --port <port>', 'Port to run on', '4100')
  .action(overview);
```

### Step 5: Port Status Detection

**File**: `agent-farm/src/servers/overview-server.ts`

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

### Step 6: Launch Instance Handler

**File**: `agent-farm/src/servers/overview-server.ts`

```typescript
async function launchInstance(projectPath: string): Promise<{ success: boolean; error?: string }> {
  // Validate path exists and has codev/
  if (!fs.existsSync(path.join(projectPath, 'codev'))) {
    return { success: false, error: 'Not a codev project (missing codev/ directory)' };
  }

  // Spawn detached: cd <path> && afx start
  const child = spawn('bash', ['-c', `cd "${projectPath}" && ./codev/bin/agent-farm start`], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  return { success: true };
}
```

### Step 7: Update codev-skeleton Template

**File**: `codev-skeleton/templates/overview.html`

Copy the template to skeleton for other projects.

## Files to Create

1. `agent-farm/src/servers/overview-server.ts` - Server implementation
2. `agent-farm/src/commands/overview.ts` - CLI command
3. `codev/templates/overview.html` - Dashboard template
4. `codev-skeleton/templates/overview.html` - Template for skeleton

## Files to Modify

1. `agent-farm/src/index.ts` - Register overview command

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Serve overview.html |
| `/api/status` | GET | Return all instances with port status |
| `/api/launch` | POST | Launch new instance (body: `{ projectPath: string }`) |

## Testing

1. `afx overview` - starts on port 4100
2. `afx overview --port 4200` - starts on custom port
3. `afx overview` when 4100 in use - fails with clear error
4. Dashboard shows running instances
5. Dashboard shows stopped instances (from ports.json history)
6. Click "Open" link - opens project dashboard
7. Directory picker + Start - launches new instance
8. New instance appears after refresh

## Estimated Effort

- overview-server.ts: ~1.5 hours
- overview.html template: ~1 hour
- CLI integration: ~15 minutes
- Testing: ~15 minutes
- **Total: ~3 hours**
