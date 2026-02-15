/**
 * CODEV_HQ Server (Spike Implementation)
 *
 * A minimal WebSocket server that:
 * 1. Accepts connections from local Agent Farm instances
 * 2. Tracks workspace status in-memory
 * 3. Serves a simple React dashboard
 * 4. Handles human approval flow
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import chalk from 'chalk';

import { state } from './state.js';
import { handleMessage, sendApproval } from './handlers.js';
import type { ApprovalPayload } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT || '4300', 10);
const API_KEY = process.env.CODEV_HQ_API_KEY || 'dev-key-spike';

const app = express();
app.use(express.json());

// Serve static dashboard files (built React app)
const dashboardPath = join(__dirname, '../dashboard/dist');
app.use(express.static(dashboardPath));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API: Get current state snapshot
app.get('/api/state', (_req, res) => {
  res.json(state.getSnapshot());
});

// API: Send approval
app.post('/api/approve', (req, res) => {
  const { instance_id, workspace_path, project_id, gate, approved_by, comment } = req.body;

  if (!instance_id || !workspace_path || !project_id || !gate) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  const approval: ApprovalPayload = {
    workspace_path,
    project_id,
    gate,
    approved_by: approved_by || 'dashboard-user',
    approved_at: new Date().toISOString(),
    comment,
  };

  const success = sendApproval(instance_id, approval);

  if (success) {
    res.json({ success: true, message: 'Approval sent' });
  } else {
    res.status(500).json({ error: 'Failed to send approval' });
  }
});

// Fallback to index.html for SPA routing
app.get('*', (_req, res) => {
  res.sendFile(join(dashboardPath, 'index.html'));
});

// Create HTTP server
const server = createServer(app);

// Create WebSocket server
const wss = new WebSocketServer({
  server,
  path: '/ws',
});

// Handle WebSocket connections
wss.on('connection', (ws: WebSocket, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(chalk.blue(`[HQ] New WebSocket connection from ${clientIp}`));

  // Simple API key auth (header or query param)
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const authHeader = req.headers.authorization;
  const queryKey = url.searchParams.get('key');

  const providedKey = authHeader?.replace('Bearer ', '') || queryKey;

  if (providedKey !== API_KEY && API_KEY !== 'dev-key-spike') {
    console.log(chalk.red(`[HQ] Auth failed for ${clientIp}`));
    ws.close(4001, 'Unauthorized');
    return;
  }

  // Handle messages
  ws.on('message', (data: Buffer) => {
    handleMessage(ws, data.toString());
  });

  // Handle close
  ws.on('close', (code, reason) => {
    const instance = state.getInstanceByWs(ws);
    if (instance) {
      console.log(chalk.yellow(`[HQ] Instance disconnected: ${instance.instance_id} (code: ${code})`));
      state.unregisterInstance(instance.instance_id);
    }
  });

  // Handle errors
  ws.on('error', (error) => {
    console.error(chalk.red(`[HQ] WebSocket error:`), error.message);
  });

  // Send a welcome message
  ws.send(JSON.stringify({
    type: 'welcome',
    id: 'server-welcome',
    ts: Date.now(),
    payload: { message: 'Connected to CODEV_HQ' },
  }));
});

// Start server
server.listen(PORT, () => {
  console.log(chalk.green(`
╔═══════════════════════════════════════════════════╗
║                   CODEV_HQ (Spike)                 ║
╠═══════════════════════════════════════════════════╣
║  Dashboard:  http://localhost:${PORT}               ║
║  WebSocket:  ws://localhost:${PORT}/ws              ║
║  API:        http://localhost:${PORT}/api/state     ║
╠═══════════════════════════════════════════════════╣
║  API Key:    ${API_KEY.substring(0, 12)}...                     ║
╚═══════════════════════════════════════════════════╝
`));
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log(chalk.yellow('\n[HQ] Shutting down...'));
  wss.close();
  server.close();
  process.exit(0);
});

// Subscribe to state changes for logging
state.subscribe((event) => {
  switch (event.type) {
    case 'instance_connected':
      console.log(chalk.green(`[HQ] State: Instance connected ${event.instance_id}`));
      break;
    case 'instance_disconnected':
      console.log(chalk.yellow(`[HQ] State: Instance disconnected ${event.instance_id}`));
      break;
    case 'status_updated':
      console.log(chalk.cyan(`[HQ] State: Status file updated ${event.status_file}`));
      break;
    case 'builder_updated':
      console.log(chalk.magenta(`[HQ] State: Builder ${event.builder_id} -> ${event.status}`));
      break;
  }
});
