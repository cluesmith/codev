/**
 * HTTP route handlers for tower server.
 * Spec 0105: Tower Server Decomposition — Phase 6
 *
 * Contains all HTTP request routing and response logic.
 * The orchestrator (tower-server.ts) creates the HTTP server and
 * delegates to handleRequest() for all HTTP requests.
 *
 * NOTE: This file exceeds the 900-line guideline because it contains
 * all HTTP route handlers (~30 routes) which share a single responsibility
 * (HTTP request handling). Splitting would create arbitrary boundaries
 * without improving cohesion. See spec: "cohesion trumps arbitrary ceilings."
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const execAsync = promisify(exec);
import type { SessionManager } from '../../terminal/session-manager.js';
import type { PtySessionInfo } from '../../terminal/pty-session.js';
import { DEFAULT_COLS, defaultSessionOptions } from '../../terminal/index.js';
import type { SSEClient } from './tower-types.js';
import { parseJsonBody, isRequestAllowed } from '../utils/server-utils.js';
import {
  isRateLimited,
  normalizeWorkspacePath,
  getLanguageForExt,
  getMimeTypeForFile,
  serveStaticFile,
} from './tower-utils.js';
import { handleTunnelEndpoint } from './tower-tunnel.js';
import { resolveTarget, broadcastMessage, isResolveError } from './tower-messages.js';
import { formatArchitectMessage, formatBuilderMessage } from '../utils/message-format.js';
import {
  getKnownWorkspacePaths,
  getInstances,
  getDirectorySuggestions,
  launchInstance,
  killTerminalWithShellper,
  stopInstance,
} from './tower-instances.js';
import { OverviewCache } from './overview.js';
import {
  getWorkspaceTerminals,
  getTerminalManager,
  getWorkspaceTerminalsEntry,
  getNextShellId,
  saveTerminalSession,
  isSessionPersistent,
  deleteTerminalSession,
  removeTerminalFromRegistry,
  deleteWorkspaceTerminalSessions,
  saveFileTab,
  deleteFileTab,
  getTerminalsForWorkspace,
} from './tower-terminals.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Singleton cache for overview endpoint (Spec 0126 Phase 4)
const overviewCache = new OverviewCache();

// ============================================================================
// Route context — dependencies provided by the orchestrator
// ============================================================================

export interface RouteContext {
  log: (level: 'INFO' | 'ERROR' | 'WARN', message: string) => void;
  port: number;
  templatePath: string | null;
  reactDashboardPath: string;
  hasReactDashboard: boolean;
  getShellperManager: () => SessionManager | null;
  broadcastNotification: (notification: { type: string; title: string; body: string; workspace?: string }) => void;
  addSseClient: (client: SSEClient) => void;
  removeSseClient: (id: string) => void;
}

// ============================================================================
// Helper: read raw request body
// ============================================================================

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer) => data += chunk.toString());
    req.on('end', () => resolve(data));
  });
}

// ============================================================================
// Route dispatch table — exact-match routes (O(1) lookup)
// ============================================================================

type RouteEntry = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: RouteContext,
) => Promise<void> | void;

const ROUTES: Record<string, RouteEntry> = {
  'GET /health':          (_req, res) => handleHealthCheck(res),
  'GET /api/workspaces':  (_req, res) => handleListWorkspaces(res),
  'POST /api/terminals':  (req, res, _url, ctx) => handleTerminalCreate(req, res, ctx),
  'GET /api/terminals':   (_req, res) => handleTerminalList(res),
  'GET /api/status':      (_req, res) => handleStatus(res),
  'GET /api/overview':    (_req, res, url) => handleOverview(res, url),
  'POST /api/overview/refresh': (_req, res) => handleOverviewRefresh(res),
  'GET /api/events':      (req, res, _url, ctx) => handleSSEEvents(req, res, ctx),
  'POST /api/notify':     (req, res, _url, ctx) => handleNotify(req, res, ctx),
  'GET /api/browse':      (_req, res, url) => handleBrowse(res, url),
  'POST /api/create':     (req, res, _url, ctx) => handleCreateWorkspace(req, res, ctx),
  'POST /api/launch':     (req, res) => handleLaunchInstance(req, res),
  'POST /api/stop':       (req, res) => handleStopInstance(req, res),
  'POST /api/send':       (req, res, _url, ctx) => handleSend(req, res, ctx),
  'GET /':                (_req, res, _url, ctx) => handleDashboard(res, ctx),
  'GET /index.html':      (_req, res, _url, ctx) => handleDashboard(res, ctx),
};

// ============================================================================
// Main request handler
// ============================================================================

export async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  // Security: Validate Host and Origin headers
  if (!isRequestAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  // CORS headers — allow localhost and tunnel proxy origins
  const origin = req.headers.origin;
  if (origin && (
    origin.startsWith('http://localhost:') ||
    origin.startsWith('http://127.0.0.1:') ||
    origin.startsWith('https://')
  )) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${ctx.port}`);

  try {
    // Exact-match route dispatch (O(1) lookup)
    const routeKey = `${req.method} ${url.pathname}`;
    const handler = ROUTES[routeKey];
    if (handler) {
      return await handler(req, res, url, ctx);
    }

    // Pattern-based routes (require regex or prefix matching)

    // Tunnel endpoints: /api/tunnel/* (Spec 0097 Phase 4)
    if (url.pathname.startsWith('/api/tunnel/')) {
      const tunnelSub = url.pathname.slice('/api/tunnel/'.length);
      await handleTunnelEndpoint(req, res, tunnelSub);
      return;
    }

    // Workspace API: /api/workspaces/:encodedPath/activate|deactivate|status (Spec 0090 Phase 1)
    const workspaceApiMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/(activate|deactivate|status)$/);
    if (workspaceApiMatch) {
      return await handleWorkspaceAction(req, res, ctx, workspaceApiMatch);
    }

    // Terminal-specific routes: /api/terminals/:id/* (Spec 0090 Phase 2)
    const terminalRouteMatch = url.pathname.match(/^\/api\/terminals\/([^/]+)(\/.*)?$/);
    if (terminalRouteMatch) {
      return await handleTerminalRoutes(req, res, url, terminalRouteMatch);
    }

    // Workspace routes: /workspace/:base64urlPath/* (Spec 0090 Phase 4)
    if (url.pathname.startsWith('/workspace/')) {
      return await handleWorkspaceRoutes(req, res, ctx, url);
    }

    // 404 for everything else
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    ctx.log('ERROR', `Request error: ${(err as Error).message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

// ============================================================================
// Global route handlers
// ============================================================================

async function handleHealthCheck(res: http.ServerResponse): Promise<void> {
  const instances = await getInstances();
  const activeCount = instances.filter((i) => i.running).length;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      status: 'healthy',
      uptime: process.uptime(),
      activeWorkspaces: activeCount,
      totalWorkspaces: instances.length,
      memoryUsage: process.memoryUsage().heapUsed,
      timestamp: new Date().toISOString(),
    })
  );
}

async function handleListWorkspaces(res: http.ServerResponse): Promise<void> {
  const instances = await getInstances();
  const workspaces = instances.map((i) => ({
    path: i.workspacePath,
    name: i.workspaceName,
    active: i.running,
    proxyUrl: i.proxyUrl,
    terminals: i.terminals.length,
  }));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ workspaces }));
}

async function handleWorkspaceAction(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteContext,
  match: RegExpMatchArray,
): Promise<void> {
  const [, encodedPath, action] = match;
  let workspacePath: string;
  try {
    workspacePath = Buffer.from(encodedPath, 'base64url').toString('utf-8');
    if (!workspacePath || (!workspacePath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(workspacePath))) {
      throw new Error('Invalid path');
    }
    workspacePath = normalizeWorkspacePath(workspacePath);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid workspace path encoding' }));
    return;
  }

  // GET /api/workspaces/:path/status
  if (req.method === 'GET' && action === 'status') {
    const instances = await getInstances();
    const instance = instances.find((i) => i.workspacePath === workspacePath);
    if (!instance) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Workspace not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        path: instance.workspacePath,
        name: instance.workspaceName,
        active: instance.running,
        terminals: instance.terminals,
      })
    );
    return;
  }

  // POST /api/workspaces/:path/activate
  if (req.method === 'POST' && action === 'activate') {
    // Rate limiting: 10 activations per minute per client
    const clientIp = req.socket.remoteAddress || '127.0.0.1';
    if (isRateLimited(clientIp)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many activations, try again later' }));
      return;
    }

    const result = await launchInstance(workspacePath);
    if (result.success) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, adopted: result.adopted }));
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: result.error }));
    }
    return;
  }

  // POST /api/workspaces/:path/deactivate
  if (req.method === 'POST' && action === 'deactivate') {
    const knownPaths = getKnownWorkspacePaths();
    const resolvedPath = fs.existsSync(workspacePath) ? fs.realpathSync(workspacePath) : workspacePath;
    const isKnown = knownPaths.some(
      (p) => p === workspacePath || p === resolvedPath
    );

    if (!isKnown) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Workspace not found' }));
      return;
    }

    const result = await stopInstance(workspacePath);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }
}

async function handleTerminalCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  try {
    const body = await parseJsonBody(req);
    const manager = getTerminalManager();

    // Parse request fields
    const command = typeof body.command === 'string' ? body.command : undefined;
    const args = Array.isArray(body.args) ? body.args as string[] : undefined;
    const cols = typeof body.cols === 'number' ? body.cols : undefined;
    const rows = typeof body.rows === 'number' ? body.rows : undefined;
    const cwd = typeof body.cwd === 'string' ? body.cwd : undefined;
    const env = typeof body.env === 'object' && body.env !== null ? (body.env as Record<string, string>) : undefined;
    const label = typeof body.label === 'string' ? body.label : undefined;

    // Optional session persistence via shellper
    const workspacePath = typeof body.workspacePath === 'string' ? body.workspacePath : null;
    const termType = typeof body.type === 'string' && ['builder', 'shell'].includes(body.type) ? body.type as 'builder' | 'shell' : null;
    const roleId = typeof body.roleId === 'string' ? body.roleId : null;
    const requestPersistence = body.persistent === true;

    let info: PtySessionInfo | undefined;
    let persistent = false;

    // Try shellper if persistence was requested
    const shellperManager = ctx.getShellperManager();
    if (requestPersistence && shellperManager && command && cwd) {
      try {
        const sessionId = crypto.randomUUID();
        // Strip CLAUDECODE so spawned Claude processes don't detect nesting
        const sessionEnv = { ...(env || process.env) } as Record<string, string>;
        delete sessionEnv['CLAUDECODE'];
        const client = await shellperManager.createSession({
          sessionId,
          command,
          args: args || [],
          cwd,
          env: sessionEnv,
          ...defaultSessionOptions(),
          cols: cols || DEFAULT_COLS,
        });

        const replayData = client.getReplayData() ?? Buffer.alloc(0);
        const shellperInfo = shellperManager.getSessionInfo(sessionId)!;

        const session = manager.createSessionRaw({
          label: label || `terminal-${sessionId.slice(0, 8)}`,
          cwd,
        });
        const ptySession = manager.getSession(session.id);
        if (ptySession) {
          ptySession.attachShellper(client, replayData, shellperInfo.pid, sessionId);
        }

        info = session;
        persistent = true;

        if (workspacePath && termType && roleId) {
          const entry = getWorkspaceTerminalsEntry(normalizeWorkspacePath(workspacePath));
          if (termType === 'builder') {
            entry.builders.set(roleId, session.id);
          } else {
            entry.shells.set(roleId, session.id);
          }
          saveTerminalSession(session.id, workspacePath, termType, roleId, shellperInfo.pid,
            shellperInfo.socketPath, shellperInfo.pid, shellperInfo.startTime);
          ctx.log('INFO', `Registered shellper terminal ${session.id} as ${termType} "${roleId}" for workspace ${workspacePath}`);
        }
      } catch (shellperErr) {
        ctx.log('WARN', `Shellper creation failed for terminal, falling back: ${(shellperErr as Error).message}`);
      }
    }

    // Fallback: non-persistent session (graceful degradation per plan)
    // Shellper is the only persistence backend for new sessions.
    if (!info) {
      info = await manager.createSession({ command, args, cols, rows, cwd, env, label });
      persistent = false;

      if (workspacePath && termType && roleId) {
        const entry = getWorkspaceTerminalsEntry(normalizeWorkspacePath(workspacePath));
        if (termType === 'builder') {
          entry.builders.set(roleId, info.id);
        } else {
          entry.shells.set(roleId, info.id);
        }
        saveTerminalSession(info.id, workspacePath, termType, roleId, info.pid);
        ctx.log('WARN', `Terminal ${info.id} for ${workspacePath} is non-persistent (shellper unavailable)`);
      }
    }

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...info, wsPath: `/ws/terminal/${info.id}`, persistent }));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    ctx.log('ERROR', `Failed to create terminal: ${message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'INTERNAL_ERROR', message }));
  }
}

function handleTerminalList(res: http.ServerResponse): void {
  const manager = getTerminalManager();
  const terminals = manager.listSessions();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ terminals }));
}

async function handleTerminalRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  match: RegExpMatchArray,
): Promise<void> {
  const [, terminalId, subpath] = match;
  const manager = getTerminalManager();

  // GET /api/terminals/:id - Get terminal info
  if (req.method === 'GET' && (!subpath || subpath === '')) {
    const session = manager.getSession(terminalId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'NOT_FOUND', message: `Session ${terminalId} not found` }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(session.info));
    return;
  }

  // DELETE /api/terminals/:id - Kill terminal (disable shellper auto-restart if applicable)
  if (req.method === 'DELETE' && (!subpath || subpath === '')) {
    if (!(await killTerminalWithShellper(manager, terminalId))) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'NOT_FOUND', message: `Session ${terminalId} not found` }));
      return;
    }

    // TICK-001: Delete from SQLite
    deleteTerminalSession(terminalId);

    // Bugfix #290: Also remove from in-memory registry so dashboard
    // stops showing tabs for cleaned-up builders
    removeTerminalFromRegistry(terminalId);

    res.writeHead(204);
    res.end();
    return;
  }

  // POST /api/terminals/:id/write - Write data to terminal (Spec 0104)
  if (req.method === 'POST' && subpath === '/write') {
    try {
      const body = await parseJsonBody(req);
      if (typeof body.data !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'INVALID_PARAMS', message: 'data must be a string' }));
        return;
      }
      const session = manager.getSession(terminalId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'NOT_FOUND', message: `Session ${terminalId} not found` }));
        return;
      }
      session.write(body.data);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'INVALID_PARAMS', message: 'Invalid JSON body' }));
    }
    return;
  }

  // POST /api/terminals/:id/resize - Resize terminal
  if (req.method === 'POST' && subpath === '/resize') {
    try {
      const body = await parseJsonBody(req);
      if (typeof body.cols !== 'number' || typeof body.rows !== 'number') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'INVALID_PARAMS', message: 'cols and rows must be numbers' }));
        return;
      }
      const info = manager.resizeSession(terminalId, body.cols, body.rows);
      if (!info) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'NOT_FOUND', message: `Session ${terminalId} not found` }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(info));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'INVALID_PARAMS', message: 'Invalid JSON body' }));
    }
    return;
  }

  // GET /api/terminals/:id/output - Get terminal output
  if (req.method === 'GET' && subpath === '/output') {
    const lines = parseInt(url.searchParams.get('lines') ?? '100', 10);
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const output = manager.getOutput(terminalId, lines, offset);
    if (!output) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'NOT_FOUND', message: `Session ${terminalId} not found` }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(output));
    return;
  }
}

async function handleStatus(res: http.ServerResponse): Promise<void> {
  const instances = await getInstances();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ instances }));
}

async function handleOverview(res: http.ServerResponse, url: URL): Promise<void> {
  // Accept optional ?workspace= to specify the workspace root.
  // Falls back to first known non-builder workspace path.
  let workspaceRoot = url.searchParams.get('workspace');

  if (!workspaceRoot) {
    const knownPaths = getKnownWorkspacePaths();
    workspaceRoot = knownPaths.find(p => !p.includes('/.builders/')) || null;
  }

  if (!workspaceRoot) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ builders: [], pendingPRs: [], backlog: [] }));
    return;
  }

  const data = await overviewCache.getOverview(workspaceRoot);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function handleOverviewRefresh(res: http.ServerResponse): void {
  overviewCache.invalidate();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

function handleSSEEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteContext,
): void {
  const clientId = crypto.randomBytes(8).toString('hex');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: 'connected', id: clientId })}\n\n`);

  const client: SSEClient = { res, id: clientId };
  ctx.addSseClient(client);

  ctx.log('INFO', `SSE client connected: ${clientId}`);

  // Clean up on disconnect
  req.on('close', () => {
    ctx.removeSseClient(clientId);
    ctx.log('INFO', `SSE client disconnected: ${clientId}`);
  });
}

async function handleNotify(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const body = await parseJsonBody(req);
  const type = typeof body.type === 'string' ? body.type : 'info';
  const title = typeof body.title === 'string' ? body.title : '';
  const messageBody = typeof body.body === 'string' ? body.body : '';
  const workspace = typeof body.workspace === 'string' ? body.workspace : undefined;

  if (!title || !messageBody) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Missing title or body' }));
    return;
  }

  // Broadcast to all connected SSE clients
  ctx.broadcastNotification({
    type,
    title,
    body: messageBody,
    workspace,
  });

  ctx.log('INFO', `Notification broadcast: ${title}`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true }));
}

// ============================================================================
// POST /api/send — send a message to a resolved agent terminal
// ============================================================================

async function handleSend(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const body = await parseJsonBody(req);

  // Validate required fields
  const to = typeof body.to === 'string' ? body.to.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';

  if (!to) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'INVALID_PARAMS', message: 'Missing or empty "to" field' }));
    return;
  }

  if (!message) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'INVALID_PARAMS', message: 'Missing or empty "message" field' }));
    return;
  }

  // Optional fields
  const from = typeof body.from === 'string' ? body.from : undefined;
  const workspace = typeof body.workspace === 'string' ? body.workspace : undefined;
  const fromWorkspace = typeof body.fromWorkspace === 'string' ? body.fromWorkspace : undefined;
  const options = typeof body.options === 'object' && body.options !== null
    ? (body.options as Record<string, unknown>)
    : {};
  const raw = options.raw === true;
  const noEnter = options.noEnter === true;
  const interrupt = options.interrupt === true;

  // Resolve the target address to a terminal ID
  const result = resolveTarget(to, workspace);

  if (isResolveError(result)) {
    const statusCode = result.code === 'AMBIGUOUS' ? 409
      : result.code === 'NO_CONTEXT' ? 400
      : 404;
    // Map NO_CONTEXT to INVALID_PARAMS per plan's error contract
    const errorCode = result.code === 'NO_CONTEXT' ? 'INVALID_PARAMS' : result.code;
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: errorCode, message: result.message }));
    return;
  }

  // Get the terminal session
  const manager = getTerminalManager();
  const session = manager.getSession(result.terminalId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'NOT_FOUND',
      message: `Terminal session ${result.terminalId} not found (agent '${result.agent}' resolved but terminal is gone).`,
    }));
    return;
  }

  // Format the message based on sender/target
  const isArchitectTarget = result.agent === 'architect';
  let formattedMessage: string;
  if (isArchitectTarget && from) {
    // Builder → Architect
    formattedMessage = formatBuilderMessage(from, message, undefined, raw);
  } else if (!isArchitectTarget) {
    // Architect → Builder (or any → builder)
    formattedMessage = formatArchitectMessage(message, undefined, raw);
  } else {
    // Unknown sender to architect — use raw
    formattedMessage = raw ? message : formatArchitectMessage(message, undefined, false);
  }

  // Optionally interrupt first
  if (interrupt) {
    session.write('\x03'); // Ctrl+C
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // Write the message to the terminal
  session.write(formattedMessage);

  // Send Enter to submit (unless noEnter)
  if (!noEnter) {
    session.write('\r');
  }

  // Broadcast structured message to WebSocket subscribers
  const senderWorkspace = fromWorkspace ?? workspace ?? 'unknown';
  broadcastMessage({
    type: 'message',
    from: {
      project: path.basename(senderWorkspace),
      agent: from ?? 'unknown',
    },
    to: {
      project: path.basename(result.workspacePath),
      agent: result.agent,
    },
    content: message,
    metadata: { raw, source: 'api' },
    timestamp: new Date().toISOString(),
  });

  ctx.log('INFO', `Message sent: ${from ?? 'unknown'} → ${result.agent} (terminal ${result.terminalId.slice(0, 8)}...)`);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    terminalId: result.terminalId,
    resolvedTo: result.agent,
  }));
}

async function handleBrowse(res: http.ServerResponse, url: URL): Promise<void> {
  const inputPath = url.searchParams.get('path') || '';

  try {
    const suggestions = await getDirectorySuggestions(inputPath);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ suggestions }));
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ suggestions: [], error: (err as Error).message }));
  }
}

async function handleCreateWorkspace(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const body = await parseJsonBody(req);
  const parentPath = body.parent as string;
  const workspaceName = body.name as string;

  if (!parentPath || !workspaceName) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Missing parent or name' }));
    return;
  }

  // Validate workspace name
  if (!/^[a-zA-Z0-9_-]+$/.test(workspaceName)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Invalid workspace name' }));
    return;
  }

  // Expand ~ to home directory
  let expandedParent = parentPath;
  if (expandedParent.startsWith('~')) {
    expandedParent = expandedParent.replace('~', homedir());
  }

  // Validate parent exists
  if (!fs.existsSync(expandedParent)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: `Parent directory does not exist: ${parentPath}` }));
    return;
  }

  const workspacePath = path.join(expandedParent, workspaceName);

  // Check if workspace already exists
  if (fs.existsSync(workspacePath)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: `Directory already exists: ${workspacePath}` }));
    return;
  }

  try {
    // Run codev init (it creates the directory)
    await execAsync(`codev init --yes "${workspaceName}"`, {
      cwd: expandedParent,
      timeout: 60000,
    });

    // Launch the instance
    const launchResult = await launchInstance(workspacePath);
    if (!launchResult.success) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: launchResult.error }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, workspacePath }));
  } catch (err) {
    // Clean up on failure
    try {
      if (fs.existsSync(workspacePath)) {
        fs.rmSync(workspacePath, { recursive: true });
      }
    } catch {
      // Ignore cleanup errors
    }
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: `Failed to create workspace: ${(err as Error).message}` }));
  }
}

async function handleLaunchInstance(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await parseJsonBody(req);
  let workspacePath = body.workspacePath as string;

  if (!workspacePath) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Missing workspacePath' }));
    return;
  }

  // Expand ~ to home directory
  if (workspacePath.startsWith('~')) {
    workspacePath = workspacePath.replace('~', homedir());
  }

  // Reject relative paths — tower daemon CWD is unpredictable
  if (!path.isAbsolute(workspacePath)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: `Relative paths are not supported. Use an absolute path (e.g., /Users/.../workspace or ~/Development/workspace).`,
    }));
    return;
  }

  // Normalize path (resolve .. segments, trailing slashes)
  workspacePath = path.resolve(workspacePath);

  const result = await launchInstance(workspacePath);
  res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
}

async function handleStopInstance(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await parseJsonBody(req);
  const targetPath = body.workspacePath as string;

  if (!targetPath) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Missing workspacePath' }));
    return;
  }

  const result = await stopInstance(targetPath);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
}

function handleDashboard(res: http.ServerResponse, ctx: RouteContext): void {
  if (!ctx.templatePath) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Template not found. Make sure tower.html exists in agent-farm/templates/');
    return;
  }

  try {
    const template = fs.readFileSync(ctx.templatePath, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(template);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Error loading template: ' + (err as Error).message);
  }
}

// ============================================================================
// Workspace-scoped route handler
// ============================================================================

async function handleWorkspaceRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteContext,
  url: URL,
): Promise<void> {
  const pathParts = url.pathname.split('/');
  // ['', 'workspace', base64urlPath, ...rest]
  const encodedPath = pathParts[2];
  const subPath = pathParts.slice(3).join('/');

  if (!encodedPath) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing workspace path' }));
    return;
  }

  // Decode Base64URL (RFC 4648)
  let workspacePath: string;
  try {
    workspacePath = Buffer.from(encodedPath, 'base64url').toString('utf-8');
    // Support both POSIX (/) and Windows (C:\) paths
    if (!workspacePath || (!workspacePath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(workspacePath))) {
      throw new Error('Invalid workspace path');
    }
    // Normalize to resolve symlinks (e.g. /var/folders → /private/var/folders on macOS)
    workspacePath = normalizeWorkspacePath(workspacePath);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid workspace path encoding' }));
    return;
  }

  // Phase 4 (Spec 0090): Tower handles everything directly
  const isApiCall = subPath.startsWith('api/') || subPath === 'api';
  const isWsPath = subPath.startsWith('ws/') || subPath === 'ws';

  // Tunnel endpoints are tower-level, not workspace-scoped, but the React
  // dashboard uses relative paths (./api/tunnel/...) which resolve to
  // /workspace/<encoded>/api/tunnel/... in workspace context. Handle here by
  // extracting the tunnel sub-path and dispatching to handleTunnelEndpoint().
  if (subPath.startsWith('api/tunnel/')) {
    const tunnelSub = subPath.slice('api/tunnel/'.length); // e.g. "status", "connect", "disconnect"
    await handleTunnelEndpoint(req, res, tunnelSub);
    return;
  }

  // GET /file?path=<relative-path> — Read workspace file by path (for StatusPanel workspace list)
  if (req.method === 'GET' && subPath === 'file' && url.searchParams.has('path')) {
    const relPath = url.searchParams.get('path')!;
    const fullPath = path.resolve(workspacePath, relPath);
    // Security: ensure resolved path stays within workspace directory
    if (!fullPath.startsWith(workspacePath + path.sep) && fullPath !== workspacePath) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
    return;
  }

  // Serve React dashboard static files directly if:
  // 1. Not an API call
  // 2. Not a WebSocket path
  // 3. React dashboard is available
  // 4. Workspace doesn't need to be running for static files
  if (!isApiCall && !isWsPath && ctx.hasReactDashboard) {
    // Determine which static file to serve
    let staticPath: string;
    if (!subPath || subPath === '' || subPath === 'index.html') {
      staticPath = path.join(ctx.reactDashboardPath, 'index.html');
    } else {
      // Check if it's a static asset
      staticPath = path.join(ctx.reactDashboardPath, subPath);
    }

    // Try to serve the static file
    if (serveStaticFile(staticPath, res)) {
      return;
    }

    // SPA fallback: serve index.html for client-side routing
    const indexPath = path.join(ctx.reactDashboardPath, 'index.html');
    if (serveStaticFile(indexPath, res)) {
      return;
    }
  }

  // Phase 4 (Spec 0090): Handle workspace APIs directly instead of proxying to dashboard-server
  if (isApiCall) {
    const apiPath = subPath.replace(/^api\/?/, '');

    // GET /api/state - Return workspace state (architect, builders, shells)
    if (req.method === 'GET' && (apiPath === 'state' || apiPath === '')) {
      return handleWorkspaceState(res, workspacePath);
    }

    // POST /api/tabs/shell - Create a new shell terminal
    if (req.method === 'POST' && apiPath === 'tabs/shell') {
      return handleWorkspaceShellCreate(res, ctx, workspacePath);
    }

    // POST /api/tabs/file - Create a file tab (Spec 0092)
    if (req.method === 'POST' && apiPath === 'tabs/file') {
      return handleWorkspaceFileTabCreate(req, res, ctx, workspacePath);
    }

    // GET /api/file/:id - Get file content as JSON (Spec 0092)
    const fileGetMatch = apiPath.match(/^file\/([^/]+)$/);
    if (req.method === 'GET' && fileGetMatch) {
      return handleWorkspaceFileGet(res, ctx, workspacePath, fileGetMatch[1]);
    }

    // GET /api/file/:id/raw - Get raw file content (for images/video) (Spec 0092)
    const fileRawMatch = apiPath.match(/^file\/([^/]+)\/raw$/);
    if (req.method === 'GET' && fileRawMatch) {
      return handleWorkspaceFileRaw(res, ctx, workspacePath, fileRawMatch[1]);
    }

    // POST /api/file/:id/save - Save file content (Spec 0092)
    const fileSaveMatch = apiPath.match(/^file\/([^/]+)\/save$/);
    if (req.method === 'POST' && fileSaveMatch) {
      return handleWorkspaceFileSave(req, res, ctx, workspacePath, fileSaveMatch[1]);
    }

    // DELETE /api/tabs/:id - Delete a terminal or file tab
    const deleteMatch = apiPath.match(/^tabs\/(.+)$/);
    if (req.method === 'DELETE' && deleteMatch) {
      return handleWorkspaceTabDelete(res, ctx, workspacePath, deleteMatch[1]);
    }

    // POST /api/stop - Stop all terminals for workspace
    if (req.method === 'POST' && apiPath === 'stop') {
      return handleWorkspaceStopAll(res, workspacePath);
    }

    // GET /api/files - Return workspace directory tree for file browser (Spec 0092)
    if (req.method === 'GET' && apiPath === 'files') {
      return handleWorkspaceFiles(res, url, workspacePath);
    }

    // GET /api/git/status - Return git status for file browser (Spec 0092)
    if (req.method === 'GET' && apiPath === 'git/status') {
      return handleWorkspaceGitStatus(res, ctx, workspacePath);
    }

    // GET /api/files/recent - Return recently opened file tabs (Spec 0092)
    if (req.method === 'GET' && apiPath === 'files/recent') {
      return handleWorkspaceRecentFiles(res, workspacePath);
    }

    // GET /api/annotate/:tabId/* — Serve rich annotator template and sub-APIs
    const annotateMatch = apiPath.match(/^annotate\/([^/]+)(\/(.*))?$/);
    if (annotateMatch) {
      return handleWorkspaceAnnotate(req, res, ctx, url, workspacePath, annotateMatch);
    }

    // POST /api/paste-image - Upload pasted image to temp file (Issue #252)
    if (req.method === 'POST' && apiPath === 'paste-image') {
      const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB
      let size = 0;
      const chunks: Buffer[] = [];
      let aborted = false;

      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_IMAGE_SIZE) {
          aborted = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Image too large (max 10 MB)' }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (aborted) return;
        try {
          const buffer = Buffer.concat(chunks);
          const contentType = req.headers['content-type'] || 'image/png';
          const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? '.jpg'
            : contentType.includes('gif') ? '.gif'
            : contentType.includes('webp') ? '.webp'
            : '.png';
          const filename = `paste-${crypto.randomUUID()}${ext}`;
          const pasteDir = path.join(tmpdir(), 'codev-paste');
          fs.mkdirSync(pasteDir, { recursive: true });
          const filePath = path.join(pasteDir, filename);
          fs.writeFileSync(filePath, buffer);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ path: filePath }));
        } catch (err) {
          if (!res.headersSent) {
            const status = (err as Error).message.includes('too large') ? 413 : 500;
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: (err as Error).message }));
          }
        }
      });

      req.on('error', (err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Unhandled API route
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'API endpoint not found', path: apiPath }));
    return;
  }

  // For WebSocket paths, let the upgrade handler deal with it
  if (isWsPath) {
    // WebSocket paths are handled by the upgrade handler
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('WebSocket connections should use ws:// protocol');
    return;
  }

  // If we get here for non-API, non-WS paths and React dashboard is not available
  if (!ctx.hasReactDashboard) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Dashboard not available');
    return;
  }

  // Fallback for unmatched paths
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

// ============================================================================
// Workspace API sub-handlers
// ============================================================================

async function handleWorkspaceState(
  res: http.ServerResponse,
  workspacePath: string,
): Promise<void> {
  // Refresh cache via getTerminalsForWorkspace (handles SQLite sync
  // and shellper reconnection in one place)
  const encodedPath = Buffer.from(workspacePath).toString('base64url');
  const proxyUrl = `/workspace/${encodedPath}/`;
  await getTerminalsForWorkspace(workspacePath, proxyUrl);

  // Now read from the refreshed cache
  const entry = getWorkspaceTerminalsEntry(workspacePath);
  const manager = getTerminalManager();
  const state: {
    architect: { port: number; pid: number; terminalId?: string; persistent?: boolean } | null;
    builders: Array<{ id: string; name: string; port: number; pid: number; status: string; phase: string; worktree: string; branch: string; type: string; terminalId?: string; persistent?: boolean }>;
    utils: Array<{ id: string; name: string; port: number; pid: number; terminalId?: string; persistent?: boolean }>;
    annotations: Array<{ id: string; file: string; port: number; pid: number }>;
    workspaceName?: string;
  } = {
    architect: null,
    builders: [],
    utils: [],
    annotations: [],
    workspaceName: path.basename(workspacePath),
  };

  // Add architect if exists
  if (entry.architect) {
    const session = manager.getSession(entry.architect);
    if (session) {
      state.architect = {
        port: 0,
        pid: session.pid || 0,
        terminalId: entry.architect,
        persistent: isSessionPersistent(entry.architect, session),
      };
    }
  }

  // Add shells from refreshed cache
  for (const [shellId, terminalId] of entry.shells) {
    const session = manager.getSession(terminalId);
    if (session) {
      state.utils.push({
        id: shellId,
        name: `Shell ${shellId.replace('shell-', '')}`,
        port: 0,
        pid: session.pid || 0,
        terminalId,
        persistent: isSessionPersistent(terminalId, session),
      });
    }
  }

  // Add builders from refreshed cache
  for (const [builderId, terminalId] of entry.builders) {
    const session = manager.getSession(terminalId);
    if (session) {
      state.builders.push({
        id: builderId,
        name: builderId,
        port: 0,
        pid: session.pid || 0,
        status: 'running',
        phase: '',
        worktree: '',
        branch: '',
        type: 'spec',
        terminalId,
        persistent: isSessionPersistent(terminalId, session),
      });
    }
  }

  // Add file tabs (Spec 0092 - served through Tower, no separate ports)
  for (const [tabId, tab] of entry.fileTabs) {
    state.annotations.push({
      id: tabId,
      file: tab.path,
      port: 0,  // No separate port - served through Tower
      pid: 0,   // No separate process
    });
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(state));
}

async function handleWorkspaceShellCreate(
  res: http.ServerResponse,
  ctx: RouteContext,
  workspacePath: string,
): Promise<void> {
  try {
    const manager = getTerminalManager();
    const shellId = getNextShellId(workspacePath);
    const shellCmd = process.env.SHELL || '/bin/bash';
    const shellArgs: string[] = [];

    let shellCreated = false;

    // Try shellper first for persistent shell session
    const shellperManager = ctx.getShellperManager();
    if (shellperManager) {
      try {
        const sessionId = crypto.randomUUID();
        // Strip CLAUDECODE so spawned Claude processes don't detect nesting
        const shellEnv = { ...process.env } as Record<string, string>;
        delete shellEnv['CLAUDECODE'];
        const client = await shellperManager.createSession({
          sessionId,
          command: shellCmd,
          args: shellArgs,
          cwd: workspacePath,
          env: shellEnv,
          ...defaultSessionOptions(),
        });

        const replayData = client.getReplayData() ?? Buffer.alloc(0);
        const shellperInfo = shellperManager.getSessionInfo(sessionId)!;

        const session = manager.createSessionRaw({
          label: `Shell ${shellId.replace('shell-', '')}`,
          cwd: workspacePath,
        });
        const ptySession = manager.getSession(session.id);
        if (ptySession) {
          ptySession.attachShellper(client, replayData, shellperInfo.pid, sessionId);
        }

        const entry = getWorkspaceTerminalsEntry(workspacePath);
        entry.shells.set(shellId, session.id);
        saveTerminalSession(session.id, workspacePath, 'shell', shellId, shellperInfo.pid,
          shellperInfo.socketPath, shellperInfo.pid, shellperInfo.startTime);

        shellCreated = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: shellId,
          port: 0,
          name: `Shell ${shellId.replace('shell-', '')}`,
          terminalId: session.id,
          persistent: true,
        }));
      } catch (shellperErr) {
        ctx.log('WARN', `Shellper creation failed for shell, falling back: ${(shellperErr as Error).message}`);
      }
    }

    // Fallback: non-persistent session (graceful degradation per plan)
    // Shellper is the only persistence backend for new sessions.
    if (!shellCreated) {
      const session = await manager.createSession({
        command: shellCmd,
        args: shellArgs,
        cwd: workspacePath,
        label: `Shell ${shellId.replace('shell-', '')}`,
        env: process.env as Record<string, string>,
      });

      const entry = getWorkspaceTerminalsEntry(workspacePath);
      entry.shells.set(shellId, session.id);
      saveTerminalSession(session.id, workspacePath, 'shell', shellId, session.pid);
      ctx.log('WARN', `Shell ${shellId} for ${workspacePath} is non-persistent (shellper unavailable)`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: shellId,
        port: 0,
        name: `Shell ${shellId.replace('shell-', '')}`,
        terminalId: session.id,
        persistent: false,
      }));
    }
  } catch (err) {
    ctx.log('ERROR', `Failed to create shell: ${(err as Error).message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

async function handleWorkspaceFileTabCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteContext,
  workspacePath: string,
): Promise<void> {
  try {
    const body = await readBody(req);
    const { path: filePath, line, terminalId } = JSON.parse(body || '{}');

    if (!filePath || typeof filePath !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing path parameter' }));
      return;
    }

    // Resolve path: use terminal's cwd for relative paths when terminalId is provided
    let fullPath: string;
    if (path.isAbsolute(filePath)) {
      fullPath = filePath;
    } else if (terminalId) {
      const manager = getTerminalManager();
      const session = manager.getSession(terminalId);
      if (session) {
        fullPath = path.join(session.cwd, filePath);
      } else {
        ctx.log('WARN', `Terminal session ${terminalId} not found, falling back to workspace root`);
        fullPath = path.join(workspacePath, filePath);
      }
    } else {
      fullPath = path.join(workspacePath, filePath);
    }

    // Security: symlink-aware containment check
    // For non-existent files, resolve the parent directory to handle
    // intermediate symlinks (e.g., /tmp -> /private/tmp on macOS).
    let resolvedPath: string;
    try {
      resolvedPath = fs.realpathSync(fullPath);
    } catch {
      try {
        resolvedPath = path.join(fs.realpathSync(path.dirname(fullPath)), path.basename(fullPath));
      } catch {
        resolvedPath = path.resolve(fullPath);
      }
    }

    let normalizedWorkspace: string;
    try {
      normalizedWorkspace = fs.realpathSync(workspacePath);
    } catch {
      normalizedWorkspace = path.resolve(workspacePath);
    }

    const isWithinWorkspace = resolvedPath.startsWith(normalizedWorkspace + path.sep)
      || resolvedPath === normalizedWorkspace;

    if (!isWithinWorkspace) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Path outside workspace' }));
      return;
    }

    // Non-existent files still create a tab (spec 0101: file viewer shows "File not found")
    const fileExists = fs.existsSync(fullPath);

    const entry = getWorkspaceTerminalsEntry(workspacePath);

    // Check if already open
    for (const [id, tab] of entry.fileTabs) {
      if (tab.path === fullPath) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, existing: true, line, notFound: !fileExists }));
        return;
      }
    }

    // Create new file tab (write-through: in-memory + SQLite)
    const id = `file-${crypto.randomUUID()}`;
    const createdAt = Date.now();
    entry.fileTabs.set(id, { id, path: fullPath, createdAt });
    saveFileTab(id, workspacePath, fullPath, createdAt);

    ctx.log('INFO', `Created file tab: ${id} for ${path.basename(fullPath)}`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id, existing: false, line, notFound: !fileExists }));
  } catch (err) {
    ctx.log('ERROR', `Failed to create file tab: ${(err as Error).message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

function handleWorkspaceFileGet(
  res: http.ServerResponse,
  ctx: RouteContext,
  workspacePath: string,
  tabId: string,
): void {
  const entry = getWorkspaceTerminalsEntry(workspacePath);
  const tab = entry.fileTabs.get(tabId);

  if (!tab) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File tab not found' }));
    return;
  }

  try {
    const ext = path.extname(tab.path).slice(1).toLowerCase();
    const isText = !['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp4', 'webm', 'mov', 'pdf'].includes(ext);

    if (isText) {
      const content = fs.readFileSync(tab.path, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        path: tab.path,
        name: path.basename(tab.path),
        content,
        language: getLanguageForExt(ext),
        isMarkdown: ext === 'md',
        isImage: false,
        isVideo: false,
      }));
    } else {
      // For binary files, just return metadata
      const stat = fs.statSync(tab.path);
      const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext);
      const isVideo = ['mp4', 'webm', 'mov'].includes(ext);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        path: tab.path,
        name: path.basename(tab.path),
        content: null,
        language: ext,
        isMarkdown: false,
        isImage,
        isVideo,
        size: stat.size,
      }));
    }
  } catch (err) {
    ctx.log('ERROR', `GET /api/file/:id failed: ${(err as Error).message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

function handleWorkspaceFileRaw(
  res: http.ServerResponse,
  ctx: RouteContext,
  workspacePath: string,
  tabId: string,
): void {
  const entry = getWorkspaceTerminalsEntry(workspacePath);
  const tab = entry.fileTabs.get(tabId);

  if (!tab) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File tab not found' }));
    return;
  }

  try {
    const data = fs.readFileSync(tab.path);
    const mimeType = getMimeTypeForFile(tab.path);
    res.writeHead(200, {
      'Content-Type': mimeType,
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch (err) {
    ctx.log('ERROR', `GET /api/file/:id/raw failed: ${(err as Error).message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

async function handleWorkspaceFileSave(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteContext,
  workspacePath: string,
  tabId: string,
): Promise<void> {
  const entry = getWorkspaceTerminalsEntry(workspacePath);
  const tab = entry.fileTabs.get(tabId);

  if (!tab) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File tab not found' }));
    return;
  }

  try {
    const body = await readBody(req);
    const { content } = JSON.parse(body || '{}');

    if (typeof content !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing content parameter' }));
      return;
    }

    fs.writeFileSync(tab.path, content, 'utf-8');
    ctx.log('INFO', `Saved file: ${tab.path}`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  } catch (err) {
    ctx.log('ERROR', `POST /api/file/:id/save failed: ${(err as Error).message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

async function handleWorkspaceTabDelete(
  res: http.ServerResponse,
  ctx: RouteContext,
  workspacePath: string,
  tabId: string,
): Promise<void> {
  const entry = getWorkspaceTerminalsEntry(workspacePath);
  const manager = getTerminalManager();

  // Check if it's a file tab first (Spec 0092, write-through: in-memory + SQLite)
  if (tabId.startsWith('file-')) {
    if (entry.fileTabs.has(tabId)) {
      entry.fileTabs.delete(tabId);
      deleteFileTab(tabId);
      ctx.log('INFO', `Deleted file tab: ${tabId}`);
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File tab not found' }));
    }
    return;
  }

  // Find and delete the terminal
  let terminalId: string | undefined;

  if (tabId.startsWith('shell-')) {
    terminalId = entry.shells.get(tabId);
    if (terminalId) {
      entry.shells.delete(tabId);
    }
  } else if (tabId.startsWith('builder-')) {
    terminalId = entry.builders.get(tabId);
    if (terminalId) {
      entry.builders.delete(tabId);
    }
  } else if (tabId === 'architect') {
    terminalId = entry.architect;
    if (terminalId) {
      entry.architect = undefined;
    }
  }

  if (terminalId) {
    // Disable shellper auto-restart if applicable, then kill the PtySession
    await killTerminalWithShellper(manager, terminalId);

    // TICK-001: Delete from SQLite
    deleteTerminalSession(terminalId);

    res.writeHead(204);
    res.end();
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Tab not found' }));
  }
}

async function handleWorkspaceStopAll(
  res: http.ServerResponse,
  workspacePath: string,
): Promise<void> {
  const entry = getWorkspaceTerminalsEntry(workspacePath);
  const manager = getTerminalManager();

  // Kill all terminals (disable shellper auto-restart if applicable)
  if (entry.architect) {
    await killTerminalWithShellper(manager, entry.architect);
  }
  for (const terminalId of entry.shells.values()) {
    await killTerminalWithShellper(manager, terminalId);
  }
  for (const terminalId of entry.builders.values()) {
    await killTerminalWithShellper(manager, terminalId);
  }

  // Clear registry
  getWorkspaceTerminals().delete(workspacePath);

  // TICK-001: Delete all terminal sessions from SQLite
  deleteWorkspaceTerminalSessions(workspacePath);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

function handleWorkspaceFiles(
  res: http.ServerResponse,
  url: URL,
  workspacePath: string,
): void {
  const maxDepth = parseInt(url.searchParams.get('depth') || '3', 10);
  const ignore = new Set(['.git', 'node_modules', '.builders', 'dist', '.agent-farm', '.next', '.cache', '__pycache__']);

  function readTree(dir: string, depth: number): Array<{ name: string; path: string; type: 'file' | 'directory'; children?: Array<unknown> }> {
    if (depth <= 0) return [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries
        .filter(e => !e.name.startsWith('.') || e.name === '.env.example')
        .filter(e => !ignore.has(e.name))
        .sort((a, b) => {
          // Directories first, then alphabetical
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        })
        .map(e => {
          const fullPath = path.join(dir, e.name);
          const relativePath = path.relative(workspacePath, fullPath);
          if (e.isDirectory()) {
            return { name: e.name, path: relativePath, type: 'directory' as const, children: readTree(fullPath, depth - 1) };
          }
          return { name: e.name, path: relativePath, type: 'file' as const };
        });
    } catch {
      return [];
    }
  }

  const tree = readTree(workspacePath, maxDepth);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(tree));
}

async function handleWorkspaceGitStatus(
  res: http.ServerResponse,
  ctx: RouteContext,
  workspacePath: string,
): Promise<void> {
  try {
    // Get git status in porcelain format for parsing
    const { stdout: result } = await execAsync('git status --porcelain', {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: 5000,
    });

    // Parse porcelain output: XY filename
    // X = staging area status, Y = working tree status
    const modified: string[] = [];
    const staged: string[] = [];
    const untracked: string[] = [];

    for (const line of result.split('\n')) {
      if (!line) continue;
      const x = line[0]; // staging area
      const y = line[1]; // working tree
      const filepath = line.slice(3);

      if (x === '?' && y === '?') {
        untracked.push(filepath);
      } else {
        if (x !== ' ' && x !== '?') {
          staged.push(filepath);
        }
        if (y !== ' ' && y !== '?') {
          modified.push(filepath);
        }
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ modified, staged, untracked }));
  } catch (err) {
    // Not a git repo or git command failed — return graceful degradation with error field
    ctx.log('WARN', `GET /api/git/status failed: ${(err as Error).message}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ modified: [], staged: [], untracked: [], error: (err as Error).message }));
  }
}

function handleWorkspaceRecentFiles(
  res: http.ServerResponse,
  workspacePath: string,
): void {
  const entry = getWorkspaceTerminalsEntry(workspacePath);

  // Get all file tabs sorted by creation time (most recent first)
  const recentFiles = Array.from(entry.fileTabs.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 10)  // Limit to 10 most recent
    .map(tab => ({
      id: tab.id,
      path: tab.path,
      name: path.basename(tab.path),
      relativePath: path.relative(workspacePath, tab.path),
    }));

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(recentFiles));
}

function handleWorkspaceAnnotate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteContext,
  url: URL,
  workspacePath: string,
  annotateMatch: RegExpMatchArray,
): void {
  const tabId = annotateMatch[1];
  const subRoute = annotateMatch[3] || '';
  const entry = getWorkspaceTerminalsEntry(workspacePath);
  const tab = entry.fileTabs.get(tabId);

  if (!tab) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File tab not found' }));
    return;
  }

  const filePath = tab.path;
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext);
  const isVideo = ['mp4', 'webm', 'mov'].includes(ext);
  const is3D = ['stl', '3mf'].includes(ext);
  const isPdf = ext === 'pdf';
  const isMarkdown = ext === 'md';

  // Sub-route: GET /file — re-read file content from disk
  if (req.method === 'GET' && subRoute === 'file') {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(content);
    } catch (err) {
      ctx.log('ERROR', `GET /api/annotate/:id/file failed: ${(err as Error).message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  // Sub-route: POST /save — save file content
  if (req.method === 'POST' && subRoute === 'save') {
    // Note: async body reading handled via callback pattern since this function is sync
    let data = '';
    req.on('data', (chunk: Buffer) => data += chunk.toString());
    req.on('end', () => {
      try {
        const parsed = JSON.parse(data || '{}');
        const fileContent = parsed.content;
        if (typeof fileContent !== 'string') {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing content');
          return;
        }
        fs.writeFileSync(filePath, fileContent, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        ctx.log('ERROR', `POST /api/annotate/:id/save failed: ${(err as Error).message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
    return;
  }

  // Sub-route: GET /api/mtime — file modification time
  if (req.method === 'GET' && subRoute === 'api/mtime') {
    try {
      const stat = fs.statSync(filePath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mtime: stat.mtimeMs }));
    } catch (err) {
      ctx.log('ERROR', `GET /api/annotate/:id/api/mtime failed: ${(err as Error).message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  // Sub-route: GET /api/image, /api/video, /api/model, /api/pdf — raw binary content
  if (req.method === 'GET' && (subRoute === 'api/image' || subRoute === 'api/video' || subRoute === 'api/model' || subRoute === 'api/pdf')) {
    try {
      const data = fs.readFileSync(filePath);
      const mimeType = getMimeTypeForFile(filePath);
      res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Length': data.length,
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    } catch (err) {
      ctx.log('ERROR', `GET /api/annotate/:id/${subRoute} failed: ${(err as Error).message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  // Sub-route: GET /vendor/* — serve bundled vendor libraries (PrismJS, marked, DOMPurify)
  if (req.method === 'GET' && subRoute.startsWith('vendor/')) {
    const vendorFile = subRoute.slice('vendor/'.length);
    // Security: only allow known file extensions and no path traversal
    if (vendorFile.includes('..') || vendorFile.includes('/') || !/\.(js|css)$/.test(vendorFile)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad request');
      return;
    }
    const vendorPath = path.resolve(__dirname, `../../../templates/vendor/${vendorFile}`);
    try {
      const content = fs.readFileSync(vendorPath);
      const contentType = vendorFile.endsWith('.css') ? 'text/css' : 'application/javascript';
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' });
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
    return;
  }

  // Default: serve the annotator HTML template
  if (req.method === 'GET' && (subRoute === '' || subRoute === undefined)) {
    try {
      const templateFile = is3D ? '3d-viewer.html' : 'open.html';
      const tplPath = path.resolve(__dirname, `../../../templates/${templateFile}`);
      let html = fs.readFileSync(tplPath, 'utf-8');

      const fileName = path.basename(filePath);
      const fileSize = fs.statSync(filePath).size;

      if (is3D) {
        html = html.replace(/\{\{FILE\}\}/g, fileName);
        html = html.replace(/\{\{FILE_PATH_JSON\}\}/g, JSON.stringify(filePath));
        html = html.replace(/\{\{FORMAT\}\}/g, ext);
      } else {
        html = html.replace(/\{\{FILE\}\}/g, fileName);
        html = html.replace(/\{\{FILE_PATH\}\}/g, filePath);
        html = html.replace(/\{\{BUILDER_ID\}\}/g, '');
        html = html.replace(/\{\{LANG\}\}/g, getLanguageForExt(ext));
        html = html.replace(/\{\{IS_MARKDOWN\}\}/g, String(isMarkdown));
        html = html.replace(/\{\{IS_IMAGE\}\}/g, String(isImage));
        html = html.replace(/\{\{IS_VIDEO\}\}/g, String(isVideo));
        html = html.replace(/\{\{IS_PDF\}\}/g, String(isPdf));
        html = html.replace(/\{\{FILE_SIZE\}\}/g, String(fileSize));

        // Inject initialization script (template loads content via fetch)
        let initScript: string;
        if (isImage) {
          initScript = `initImage(${fileSize});`;
        } else if (isVideo) {
          initScript = `initVideo(${fileSize});`;
        } else if (isPdf) {
          initScript = `initPdf(${fileSize});`;
        } else {
          initScript = `fetch('file').then(r=>r.text()).then(init);`;
        }
        html = html.replace('// FILE_CONTENT will be injected by the server', initScript);
      }

      // Handle ?line= query param for scroll-to-line
      const lineParam = url.searchParams.get('line');
      if (lineParam) {
        const scrollScript = `<script>window.addEventListener('load',()=>{setTimeout(()=>{const el=document.querySelector('[data-line="${lineParam}"]');if(el){el.scrollIntoView({block:'center'});el.classList.add('highlighted-line');}},200);})</script>`;
        html = html.replace('</body>', `${scrollScript}</body>`);
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Failed to serve annotator: ${(err as Error).message}`);
    }
    return;
  }
}
