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
import { decodeWorkspacePath } from '../lib/tower-client.js';
import { readCloudConfig } from '../lib/cloud-config.js';
import { fileURLToPath } from 'node:url';
import { version } from '../../version.js';

const execAsync = promisify(exec);
import type { SessionManager } from '../../terminal/session-manager.js';
import type { PtySessionInfo } from '../../terminal/pty-session.js';
import type { BuilderSpawnedPayload, DashboardState, ArchitectState, TowerVersionInfo, HeldMessage } from '@cluesmith/codev-types';
import { getBuilders, setArchitectByName } from '../state.js';
import { DEFAULT_COLS, defaultSessionOptions } from '../../terminal/index.js';
import type { SSEClient, WorkspaceTerminals } from './tower-types.js';
import type { TerminalManager } from '../../terminal/pty-manager.js';
import { parseJsonBody, isRequestAllowed, isAllowedOrigin, isAllowedHost, getExpectedKey, escapeHtml } from '../utils/server-utils.js';
import { TOWER_KEY_HEADER, LEGACY_WEB_KEY_HEADER, VSCODE_USER_SENDER } from '@cluesmith/codev-types';
import {
  isRateLimited,
  normalizeWorkspacePath,
  getLanguageForExt,
  getMimeTypeForFile,
  serveStaticFile,
  persistableCommand,
  logSessionIdentity,
} from './tower-utils.js';
import { handleTunnelEndpoint } from './tower-tunnel.js';
import { getWorktreeConfig, getActivityHooks } from '../utils/config.js';
import { ensureCodevConfigWatcher } from './codev-config-watcher.js';
import { hasTeam, loadTeamMembers, loadMessages, type TeamMember, type TeamMessage } from '../../lib/team.js';
import { fetchTeamGitHubData, type TeamMemberGitHubData } from '../../lib/team-github.js';
import { resolveTarget, resolveAgentInRegistry, broadcastMessage, isResolveError, type ResolveResult } from './tower-messages.js';
import { handleCommandRoute, COMMAND_ROUTE } from './command-relay.js';
import { handleCanvasRoute, CANVAS_ROUTE_PREFIX } from './canvas-relay.js';
import {
  formatArchitectMessage,
  formatArchitectToBuilderMessage,
  formatBuilderMessage,
  formatUserViaVsCodeMessage,
  messageTooLargeError,
  MAX_MESSAGE_BYTES,
} from '../utils/message-format.js';
import type { PtySession } from '../../terminal/pty-session.js';
import { writeMessageToSession, writeEscapeToSession } from './message-write.js';
import { makeDeliveryPorts, getMailboxDrainer } from './mailbox-wiring.js';
import { deliverAgentMailSerialized, type DeliveryOutcome, type DeliveryPorts } from './mailbox-delivery.js';
import { deliverCronMail, CRON_SENDER, type CronDeliveryResult } from './cron-delivery.js';
import {
  enqueue as enqueueMailbox,
  getById as getMailboxById,
  markDelivered as markMailboxDelivered,
  listHeld as listHeldMailbox,
  dismiss as dismissMailbox,
  type EnqueueInput,
} from '../db/mailbox.js';
import type { MailboxReason } from '../db/types.js';
// Spec 1273 per-terminal submission lock. Originally the anti-fusion lock for the two
// explicit human-bypass paths (escape + interrupt); since Issue #1365 the gated mailbox
// delivery path takes it too, so it now serializes the whole write edge of a terminal.
// The operator paths pass a wait ceiling — see OPERATOR_SUBMIT_WAIT_CEILING_MS.
import { submitToSession, OPERATOR_SUBMIT_WAIT_CEILING_MS } from './session-submit.js';
// Spec 1307 `--delay` — Tower-side deferred delivery, re-homed onto the Spec 1313
// mailbox (the merge that carried this feature was flattened by a later rebase, so it
// is grafted here explicitly): the due-time callback enqueues to the mailbox and
// triggers a gated drain (see handleSend), so a delayed message delivers onto a
// render-verified empty prompt like any normal send — never force-injected.
import { scheduleDelayedSend, validateDelaySeconds } from './delayed-send.js';
import {
  getKnownWorkspacePaths,
  getInstances,
  getDirectorySuggestions,
  launchInstance,
  killTerminalWithShellper,
  instancesReady,
  stopInstance,
  addArchitect,
  removeArchitect,
} from './tower-instances.js';
import { OverviewCache } from './overview.js';
import {
  fetchIssue,
  fetchPR,
  searchIssues,
  fetchPRList,
  fetchCurrentUser,
  parseLinkedIssue,
  parseArea,
} from '../../lib/github.js';
import type { IssueSearchItem, IssueSearchResponse } from '@cluesmith/codev-types';
import { computeAnalytics } from './analytics.js';
import { getAllTasks, executeTask, getTaskId } from './tower-cron.js';
import { getGlobalDb } from '../db/index.js';
import { listProcessCensus } from './process-census.js';
import {
  SHELLPER_MARKER,
  computeRegisteredShellperPids,
  findHuskShellpers,
  sweepShellperHusks,
  resolveHuskGraceMs,
} from './shellper-husk-sweep.js';
import { getProcessStartTime } from '../../terminal/session-manager.js';
import type { CronTask } from './tower-cron.js';
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
  deleteFileTabsForWorkspace,
  saveFileTab,
  deleteFileTab,
  getRehydratedTerminalsEntry,
  isStartupReconcileSettled,
  getTerminalSessionById,
  getActiveShellLabels,
  updateTerminalLabel,
} from './tower-terminals.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Singleton cache for overview endpoint (Spec 0126 Phase 4)
const overviewCache = new OverviewCache();

// Spec 1313: the in-memory SendBuffer (Spec 403) is retired. Every send is now
// persisted to the durable `mailbox` table before the response and delivered only
// through the render-gate; the backstop drainer lifecycle lives in
// `mailbox-wiring.ts` (startMailboxDrainer / stopMailboxDrainer), wired from
// tower-server. There is no shutdown force-flush — held rows survive in SQLite.

// ============================================================================
// Route context — dependencies provided by the orchestrator
// ============================================================================

export interface RouteContext {
  log: (level: 'INFO' | 'ERROR' | 'WARN', message: string) => void;
  port: number;
  /** Version of the running Tower process — served by `GET /api/version` (#983). */
  version: string;
  /** ISO-8601 timestamp of when this Tower process started — served by `GET /api/version` (#983). */
  startedAt: string;
  templatePath: string | null;
  reactDashboardPath: string;
  hasReactDashboard: boolean;
  getShellperManager: () => SessionManager | null;
  broadcastNotification: (notification: { type: string; title: string; body: string; workspace?: string }) => void;
  addSseClient: (client: SSEClient) => boolean;
  removeSseClient: (id: string) => void;
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
  'GET /health':          (_req, res, _url, ctx) => handleHealthCheck(res, ctx),
  'GET /api/shellpers/husks': (_req, res, _url, ctx) => handleHuskPreview(res, ctx),
  'POST /api/shellpers/husks/sweep': (_req, res, _url, ctx) => handleHuskSweep(res, ctx),
  'GET /api/workspaces':  (_req, res) => handleListWorkspaces(res),
  'POST /api/terminals':  (req, res, _url, ctx) => handleTerminalCreate(req, res, ctx),
  'GET /api/terminals':   (_req, res) => handleTerminalList(res),
  'GET /api/status':      (_req, res) => handleStatus(res),
  'GET /api/version':     (_req, res, _url, ctx) => handleVersion(res, ctx),
  'GET /api/overview':    (_req, res, url, ctx) => handleOverview(res, url, undefined, ctx),
  'GET /api/issue':       (_req, res, url) => handleIssueView(res, url),
  'GET /api/pr':          (_req, res, url) => handlePRView(res, url),
  'GET /api/issue-search': (_req, res, url) => handleIssueSearch(res, url),
  'GET /api/worktree-config': (_req, res, url) => handleWorktreeConfigView(res, url),
  'GET /api/activity-hooks': (_req, res, url) => handleActivityHooksView(res, url),
  'GET /api/analytics':   (_req, res, url) => handleAnalytics(res, url),
  'POST /api/overview/refresh': (_req, res, _url, ctx) => handleOverviewRefresh(res, ctx),
  'GET /api/events':      (req, res, _url, ctx) => handleSSEEvents(req, res, ctx),
  'POST /api/notify':     (req, res, _url, ctx) => handleNotify(req, res, ctx),
  'GET /api/browse':      (_req, res, url) => handleBrowse(res, url),
  'POST /api/create':     (req, res, _url, ctx) => handleCreateWorkspace(req, res, ctx),
  'POST /api/launch':     (req, res) => handleLaunchInstance(req, res),
  'POST /api/stop':       (req, res) => handleStopInstance(req, res),
  'POST /api/send':       (req, res, _url, ctx) => handleSend(req, res, ctx),
  'GET /api/inbox':       (_req, res, url) => handleInboxList(res, url),
  'GET /api/cron/tasks':  (_req, res, url) => handleCronList(res, url),
  'GET /':                (_req, res, _url, ctx) => handleDashboard(res, ctx),
  'GET /index.html':      (_req, res, _url, ctx) => handleDashboard(res, ctx),
};

/**
 * Issue #1261: tell "Tower isn't wired up yet" apart from "no such thing".
 * A route that needs the instances module must not report a missing terminal
 * (404) or a successful kill (204) when the truth is that it could not act at
 * all. 503 + Retry-After says so, and matches what `stopInstance()` already
 * returns in the same situation.
 *
 * Tower's readiness gate holds requests until boot completes, so these guards
 * should be unreachable in practice — they exist so the failure mode, if the
 * gate is ever bypassed, is honest rather than misleading.
 */
function respondStartingUp(res: http.ServerResponse): void {
  res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' });
  res.end(JSON.stringify({
    error: 'STARTING_UP',
    message: 'Tower is still starting up. Try again shortly.',
  }));
}

// ============================================================================
// Main request handler
// ============================================================================

export async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  // CORS headers — reflect only allowlisted origins (advisory Layer 3).
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', `Content-Type, ${TOWER_KEY_HEADER}, ${LEGACY_WEB_KEY_HEADER}`);
  res.setHeader('Cache-Control', 'no-store');

  // A CORS preflight carries no credentials and performs no action, so it is
  // answered before the key check — otherwise browser clients could never
  // complete the preflight that precedes an authenticated request.
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Request authentication (advisory GHSA-xvjp-7748-v88v): every route outside
  // the narrow public-route allowlist must present the shared local key. This
  // is the single HTTP choke point every route passes through. CORS above is
  // defense-in-depth only — a no-preflight "simple" request still lands here.
  if (!isRequestAllowed(req)) {
    // Log the reason so a broken legitimate client (disallowed Host vs missing
    // key) is diagnosable — a bare 401 is indistinguishable from either side.
    const reason = isAllowedHost(req.headers.host)
      ? 'missing or invalid key'
      : `disallowed Host "${req.headers.host ?? ''}"`;
    ctx.log('WARN', `401 ${req.method ?? 'GET'} ${req.url ?? '/'} — ${reason}`);
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Unauthorized');
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

    // Command relay: /api/command — the module self-routes and lazily
    // initializes, so this is the only Tower-side seam. Relays a canonical verb
    // to the active editor provider for any controller.
    if (url.pathname === COMMAND_ROUTE) {
      return await handleCommandRoute(req, res, url, ctx);
    }

    // Canvas command channel: /api/canvas/* — same self-routing shape as the command relay, but
    // targeted rather than broadcast: it keeps a registry of live canvas views so it can resolve
    // exactly one and answer when none is open (spec 1401).
    if (url.pathname.startsWith(CANVAS_ROUTE_PREFIX)) {
      return await handleCanvasRoute(req, res, url, ctx);
    }

    // Workspace API: /api/workspaces/:encodedPath/activate|deactivate|status (Spec 0090 Phase 1)
    const workspaceApiMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/(activate|deactivate|status)$/);
    if (workspaceApiMatch) {
      return await handleWorkspaceAction(req, res, ctx, workspaceApiMatch);
    }

    // Workspace API: /api/workspaces/:encodedPath/architects (Spec 755 — multi-architect)
    const architectsMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/architects$/);
    if (architectsMatch) {
      return await handleAddArchitect(req, res, architectsMatch, ctx);
    }

    // Workspace API: DELETE /api/workspaces/:encodedPath/architects/:name (Spec 786)
    const architectRemoveMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/architects\/([^/]+)$/);
    if (architectRemoveMatch) {
      return await handleRemoveArchitect(req, res, architectRemoveMatch, ctx);
    }

    // Terminal-specific routes: /api/terminals/:id/* (Spec 0090 Phase 2)
    const terminalRouteMatch = url.pathname.match(/^\/api\/terminals\/([^/]+)(\/.*)?$/);
    if (terminalRouteMatch) {
      return await handleTerminalRoutes(req, res, url, terminalRouteMatch);
    }

    // Cron task routes: /api/cron/tasks/:name/* (Spec 399)
    const cronTaskMatch = url.pathname.match(/^\/api\/cron\/tasks\/([^/]+)\/(status|run|enable|disable)$/);
    if (cronTaskMatch) {
      return await handleCronTaskAction(req, res, url, cronTaskMatch);
    }

    // Inbox dismiss: POST /api/inbox/:id/dismiss (Spec 1313, Phase 7)
    const inboxDismissMatch = url.pathname.match(/^\/api\/inbox\/([^/]+)\/dismiss$/);
    if (inboxDismissMatch) {
      return handleInboxDismiss(req, res, ctx, inboxDismissMatch);
    }

    // Inbox show: GET /api/inbox/:id — a single row INCLUDING its body (Spec 1313 §178).
    // Checked AFTER the dismiss match, so /:id/dismiss never falls through here (its
    // trailing segment can't match this single-segment pattern anyway).
    const inboxShowMatch = url.pathname.match(/^\/api\/inbox\/([^/]+)$/);
    if (inboxShowMatch) {
      return handleInboxShow(req, res, inboxShowMatch);
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

/**
 * Issue #1227: fleet RSS + unregistered-shellper count, scoped to this Tower
 * instance's socketDir. `fleetRssKb` sums every in-scope shellper AND its
 * direct children (the full process-group tree Tower manages) regardless of
 * DB-registration state, so a husk not yet swept still counts toward the
 * visible cost. `unregisteredShellperCount` is the lighter, ungated signal
 * ("N shellpers Tower doesn't currently track") — distinct from the stricter
 * childless+aged reap predicate in shellper-husk-sweep.ts.
 *
 * Best-effort: returns undefined fields (never throws) if `ps` or the DB read
 * fails, so a fleet-accounting hiccup never takes down /health itself.
 */
async function computeFleetHealthFields(
  ctx: RouteContext,
): Promise<{ fleetRssKb?: number; unregisteredShellperCount?: number }> {
  const shellperManager = ctx.getShellperManager();
  if (!shellperManager) return {};
  try {
    const census = await listProcessCensus();
    const scopeMarker = shellperManager.socketDir.endsWith('/')
      ? shellperManager.socketDir
      : `${shellperManager.socketDir}/`;

    const inScopePids = new Set<number>();
    let fleetRssKb = 0;
    for (const entry of census) {
      if (entry.cmdline.includes(SHELLPER_MARKER) && entry.cmdline.includes(scopeMarker)) {
        inScopePids.add(entry.pid);
        fleetRssKb += entry.rssKb;
      }
    }
    for (const entry of census) {
      if (inScopePids.has(entry.ppid)) {
        fleetRssKb += entry.rssKb;
      }
    }

    const registered = await computeRegisteredShellperPids(getGlobalDb());
    let unregisteredShellperCount = 0;
    for (const pid of inScopePids) {
      if (!registered.has(pid)) unregisteredShellperCount++;
    }

    return { fleetRssKb, unregisteredShellperCount };
  } catch {
    return {};
  }
}

async function handleHealthCheck(res: http.ServerResponse, ctx: RouteContext): Promise<void> {
  const instances = await getInstances();
  const activeCount = instances.filter((i) => i.running).length;
  const fleetFields = await computeFleetHealthFields(ctx);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      status: 'healthy',
      // #997: `status` is liveness (process up); `ready` is readiness — true only
      // once the startup reconcile has re-registered persistent sessions, so a
      // client can await a deterministic state read after a Tower restart.
      ready: isStartupReconcileSettled(),
      uptime: process.uptime(),
      activeWorkspaces: activeCount,
      totalWorkspaces: instances.length,
      memoryUsage: process.memoryUsage().heapUsed,
      ...fleetFields,
      timestamp: new Date().toISOString(),
    })
  );
}

/**
 * Issue #1227: GET /api/shellpers/husks — preview, read-only. Returns the
 * husk candidates the next sweep (periodic or `--apply`) would reap, without
 * touching anything.
 */
async function handleHuskPreview(res: http.ServerResponse, ctx: RouteContext): Promise<void> {
  const shellperManager = ctx.getShellperManager();
  if (!shellperManager) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Shellper manager not initialized' }));
    return;
  }
  try {
    const graceMs = resolveHuskGraceMs();
    // One census snapshot, shared between the candidate decision and the
    // displayed RSS — passing it via the `census` seam avoids a second `ps`
    // scan and guarantees the RSS shown is for the exact snapshot that decided
    // candidacy, not a later, possibly-different one (codex #1227 PR review).
    const census = await listProcessCensus();
    const rssByPid = new Map(census.map((entry) => [entry.pid, entry.rssKb]));

    const registered = await computeRegisteredShellperPids(getGlobalDb());
    const pids = await findHuskShellpers({
      socketDir: shellperManager.socketDir,
      registeredShellperPids: registered,
      graceMs,
      census: () => census,
    });

    const now = Date.now();
    const candidates = await Promise.all(
      pids.map(async (pid) => {
        const startTime = await getProcessStartTime(pid);
        return {
          pid,
          rssKb: rssByPid.get(pid) ?? 0,
          ageMs: startTime !== null ? now - startTime : null,
        };
      }),
    );

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ candidates, graceMs }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

/**
 * Issue #1227: POST /api/shellpers/husks/sweep — apply. Actually reaps the
 * current husk candidates. Destructive; the `afx tower sweep-husks` CLI is
 * the only caller expected in practice, and it gates this behind `--apply`
 * plus a confirmation prompt (unless `--yes`).
 */
async function handleHuskSweep(res: http.ServerResponse, ctx: RouteContext): Promise<void> {
  const shellperManager = ctx.getShellperManager();
  if (!shellperManager) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Shellper manager not initialized' }));
    return;
  }
  try {
    const result = await sweepShellperHusks({
      socketDir: shellperManager.socketDir,
      db: getGlobalDb(),
      graceMs: resolveHuskGraceMs(),
      log: (msg: string) => ctx.log('INFO', msg),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

/**
 * GET /api/version (#983) — report the version of the *running* Tower process.
 *
 * `ctx.version` is read from this process's in-memory `package.json` at boot,
 * so it reflects the code Tower is actually executing — not the on-disk binary
 * `codev --version` inspects. After an `npm install -g` upgrade without a Tower
 * restart, the two diverge; the VS Code preflight probes this to detect that.
 * Read-only, no auth beyond the existing Host/Origin gate (same as /health).
 */
function handleVersion(res: http.ServerResponse, ctx: RouteContext): void {
  const body: TowerVersionInfo = { version: ctx.version, startedAt: ctx.startedAt };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
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

/**
 * POST /api/workspaces/:encodedPath/architects (Spec 755)
 * Body: { name?: string }
 * Adds a named architect terminal to an active workspace.
 * Returns 200 { success: true, name, terminalId } on success,
 * 400 / 404 with { success: false, error } otherwise.
 */
async function handleAddArchitect(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  match: RegExpMatchArray,
  ctx: RouteContext,
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const [, encodedPath] = match;
  let workspacePath: string;
  try {
    workspacePath = decodeWorkspacePath(encodedPath);
    if (!workspacePath || (!workspacePath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(workspacePath))) {
      throw new Error('Invalid path');
    }
    workspacePath = normalizeWorkspacePath(workspacePath);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid workspace path encoding' }));
    return;
  }

  let body: { name?: string };
  try {
    body = (await parseJsonBody(req)) as { name?: string };
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  const result = await addArchitect(workspacePath, body.name);
  if (result.success) {
    // Spec 823: emit an `architects-updated` SSE event so VSCode's
    // WorkspaceProvider tree refreshes when the add happens via the CLI
    // (today the tree only refreshes when add is triggered from within
    // VSCode itself). Mirrors `codev-config-updated`'s broadcast shape.
    ctx.broadcastNotification({
      type: 'architects-updated',
      title: 'Architects updated',
      body: JSON.stringify({ workspace: workspacePath }),
      workspace: workspacePath,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, name: result.name, terminalId: result.terminalId }));
  } else {
    // Distinguish "workspace not active" (404) from validation errors (400).
    const status = result.error?.includes('not running') ? 404 : 400;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: result.error }));
  }
}

/**
 * DELETE /api/workspaces/:encodedPath/architects/:name (Spec 786)
 *
 * Removes a named sibling architect from an active workspace. Refuses to
 * remove `main` (returns 400). Returns 404 when the workspace isn't active or
 * the named architect isn't registered.
 *
 * Removing an architect with in-flight builders is allowed (per OQ-A) — the
 * builders fall back to `main` via the existing `tower-messages.ts:336` chain.
 */
async function handleRemoveArchitect(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  match: RegExpMatchArray,
  ctx: RouteContext,
): Promise<void> {
  if (req.method !== 'DELETE') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const [, encodedPath, encodedName] = match;
  let workspacePath: string;
  try {
    workspacePath = decodeWorkspacePath(encodedPath);
    if (!workspacePath || (!workspacePath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(workspacePath))) {
      throw new Error('Invalid path');
    }
    workspacePath = normalizeWorkspacePath(workspacePath);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid workspace path encoding' }));
    return;
  }

  const name = decodeURIComponent(encodedName);
  const result = await removeArchitect(workspacePath, name);
  if (result.success) {
    // Spec 823: emit `architects-updated` so VSCode's WorkspaceProvider
    // refreshes when remove happens via CLI (the dashboard polls and
    // doesn't need an explicit event; VSCode subscribes to this notification).
    ctx.broadcastNotification({
      type: 'architects-updated',
      title: 'Architects updated',
      body: JSON.stringify({ workspace: workspacePath }),
      workspace: workspacePath,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  } else {
    // Distinguish "not registered" / "not running" (404) from validation
    // errors like "Cannot remove main" (400).
    const status = result.error?.includes('not running') || result.error?.includes('not found') ? 404 : 400;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: result.error }));
  }
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
    workspacePath = decodeWorkspacePath(encodedPath);
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

function emitBuilderSpawned(ctx: RouteContext, payload: BuilderSpawnedPayload): void {
  ctx.broadcastNotification({
    type: 'builder-spawned',
    title: `Builder ${payload.roleId} spawned`,
    body: JSON.stringify(payload),
    workspace: payload.workspacePath,
  });
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

    // Optional session persistence via shellper.
    // The whitelist below is the gate that keeps `'dev'` (ephemeral dev PTYs)
    // out of SQLite and shellper — the dev process dies with Tower, so
    // persisting a row would point at a non-existent process. Add new
    // persistent terminal kinds here if you ever introduce one.
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

        // Read session info BEFORE awaiting replay: an instantly-exiting
        // child's EXIT frame can remove the session from the manager during
        // the await, and this lookup must not miss (#1198).
        const shellperInfo = shellperManager.getSessionInfo(sessionId)!;
        const replayData = await client.waitForReplay(); // #1198: fresh shellpers always send REPLAY (possibly empty); awaiting avoids racing early child output

        const session = manager.createSessionRaw({
          label: label || `terminal-${sessionId.slice(0, 8)}`,
          cwd,
          // Spec 1313: thread the launch command so the render-gate can resolve
          // this session's profile (builders keep the `.builder-start.sh` backstop
          // too; this makes identity direct and restart-safe via the persisted row).
          command,
          args,
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
            emitBuilderSpawned(ctx, { terminalId: session.id, roleId, workspacePath });
          } else {
            entry.shells.set(roleId, session.id);
          }
          // PIR #1475: prefer the identity the shellper reports. A fresh spawn is
          // the no-op case (it reports back what we just asked for), but routing
          // it through the same accessor keeps one rule everywhere: the row
          // records what is RUNNING, not what was requested.
          logSessionIdentity(ctx.log, 'terminal-create', session.id, ptySession, command ?? null);
          saveTerminalSession(session.id, workspacePath, termType, roleId, shellperInfo.pid,
            shellperInfo.socketPath, shellperInfo.pid, shellperInfo.startTime, label ?? null, cwd ?? null,
            persistableCommand(ptySession) ?? command ?? null);
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
          emitBuilderSpawned(ctx, { terminalId: info.id, roleId, workspacePath });
        } else {
          entry.shells.set(roleId, info.id);
        }
        saveTerminalSession(info.id, workspacePath, termType, roleId, info.pid, null, null, null, null, cwd ?? null, command ?? null);
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
    // Issue #1261: without this, a not-yet-wired Tower answers 404 for a
    // terminal that exists — the exact symptom the issue reports.
    if (!instancesReady()) {
      respondStartingUp(res);
      return;
    }
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

  // PATCH /api/terminals/:id/rename - Rename terminal session (Spec 468)
  if (req.method === 'PATCH' && subpath === '/rename') {
    try {
      const body = await parseJsonBody(req);
      let name = body.name as string | undefined;
      if (typeof name !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Name must be 1-100 characters' }));
        return;
      }

      // Strip control characters
      name = name.replace(/[\x00-\x1f\x7f]/g, '');

      if (name.length === 0 || name.length > 100) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Name must be 1-100 characters' }));
        return;
      }

      // Two-step ID lookup: direct PtySession ID match, then shellperSessionId match
      let session = manager.getSession(terminalId);
      if (!session) {
        for (const info of manager.listSessions()) {
          const candidate = manager.getSession(info.id);
          if (candidate?.shellperSessionId === terminalId) {
            session = candidate;
            break;
          }
        }
      }
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }

      // Look up terminal_sessions row to check type
      const dbSession = getTerminalSessionById(session.id);
      if (!dbSession) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }

      if (dbSession.type !== 'shell') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Cannot rename builder/architect terminals' }));
        return;
      }

      // Dedup: check active shell labels in the same workspace, excluding current session
      const otherLabels = new Set(getActiveShellLabels(dbSession.workspace_path, session.id));
      let finalName = name;
      if (otherLabels.has(name)) {
        let suffix = 1;
        while (otherLabels.has(`${name}-${suffix}`)) {
          suffix++;
        }
        finalName = `${name}-${suffix}`;
      }

      // Update SQLite and in-memory
      updateTerminalLabel(session.id, finalName);
      session.label = finalName;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: terminalId, name: finalName }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    }
    return;
  }
}

async function handleStatus(res: http.ServerResponse): Promise<void> {
  const instances = await getInstances();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ instances }));
}

/**
 * List a workspace's architects whose PtySession is live, built from the
 * (rehydrated) terminals entry: one entry per registered architect (stale or
 * racing registrations whose session is gone are skipped), with `main` moved to
 * index 0 so consumers can rely on `architects[0]` as the default architect.
 *
 * The live-terminal sibling of state.ts's `getArchitects` (which reads the
 * persisted `architect` table): this one reflects which architects actually have
 * a running session right now. Single source of truth (Issue 1104) shared by the
 * dashboard-state handler (`/api/state`) and the overview handler
 * (`/api/overview`), so the two payloads list an identical set and can't drift.
 * Extracted verbatim from the dashboard-state builder's former inline loop.
 */
function liveArchitects(entry: WorkspaceTerminals, manager: TerminalManager): ArchitectState[] {
  const architects: ArchitectState[] = [];
  for (const [architectName, terminalId] of entry.architects) {
    const session = manager.getSession(terminalId);
    if (!session) continue;
    architects.push({
      name: architectName,
      port: 0,
      pid: session.pid || 0,
      terminalId,
      persistent: isSessionPersistent(terminalId, session),
    });
  }
  const mainIdx = architects.findIndex(a => a.name === 'main');
  if (mainIdx > 0) {
    const [mainEntry] = architects.splice(mainIdx, 1);
    architects.unshift(mainEntry);
  }
  return architects;
}

async function handleOverview(res: http.ServerResponse, url: URL, workspaceOverride?: string, ctx?: RouteContext): Promise<void> {
  // Accept workspace from: explicit override (workspace-scoped route), ?workspace= param, or first known path.
  let workspaceRoot = workspaceOverride || url.searchParams.get('workspace');

  if (!workspaceRoot) {
    const knownPaths = getKnownWorkspacePaths();
    workspaceRoot = knownPaths.find(p => !p.includes('/.builders/')) || null;
  }

  if (!workspaceRoot) {
    // Honor the full OverviewData contract even on the no-workspace branch:
    // every collection field is required ('never undefined' for `architects`,
    // Issue 1104), so emit them all empty rather than a partial payload.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ builders: [], pendingPRs: [], backlog: [], recentlyClosed: [], architects: [], heldCount: 0, mailboxEscalated: false, queuedFeedback: {}, feedbackMode: 'forward' }));
    return;
  }

  // Build set of active builder role_ids (lowercased) from live terminal sessions.
  // Bugfix #718: rehydrate the wsTerminals entry from SQLite + shellper before
  // reading, matching what /api/state has always done. Without this the sidebar
  // diverges from the dashboard after any state-loss event (Tower restart with
  // non-shellper sessions, crashed builders, etc.).
  const entry = await getRehydratedTerminalsEntry(workspaceRoot);
  const activeBuilderRoleIds = new Set<string>();
  for (const key of entry.builders.keys()) {
    activeBuilderRoleIds.add(key.toLowerCase());
  }

  const data = await overviewCache.getOverview(workspaceRoot, activeBuilderRoleIds);

  // Enrich each builder with `lastDataAt` — the wall-clock time Tower
  // last received a DATA frame from that builder's shellper. The UI uses
  // this to flag builders silent past a threshold as "waiting for input"
  // (separate from formal porch gates, which `blocked` already covers).
  //
  // Pattern mirrors /api/state's builder loop (around line 1572): iterate
  // `entry.builders` (Map<roleId, PtySession ID>), look up the session,
  // do the work. Discovery already stamps `roleId` on each builder, so
  // matching the runtime registry back to the discovery list is a single
  // `find`. Builders with no attached session keep `lastDataAt = null`
  // (the discover-time default).
  const terminalManager = getTerminalManager();
  for (const [builderId, terminalId] of entry.builders) {
    const ptySession = terminalManager.getSession(terminalId);
    if (!ptySession) { continue; }
    const builder = data.builders.find(b => b.roleId === builderId.toLowerCase());
    if (!builder) { continue; }
    builder.lastDataAt = new Date(ptySession.lastDataAt).toISOString();
  }

  // Issue 1104: enrich with the live architects (main-first) so the VSCode
  // Agents tree can render its architect tier and attribution badge straight
  // off the overview cache. Same `liveArchitects` helper (and so the same set)
  // the dashboard-state handler uses.
  data.architects = liveArchitects(entry, terminalManager);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function handleIssueView(res: http.ServerResponse, url: URL): Promise<void> {
  // Workspace resolution mirrors handleOverview: ?workspace= param, else
  // the first known non-builder workspace path.
  let workspaceRoot = url.searchParams.get('workspace');
  if (!workspaceRoot) {
    const knownPaths = getKnownWorkspacePaths();
    workspaceRoot = knownPaths.find(p => !p.includes('/.builders/')) || null;
  }

  const number = url.searchParams.get('number');
  if (!workspaceRoot || !number) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing workspace or number' }));
    return;
  }

  // Routes through the `issue-view` forge concept (forge-agnostic).
  const issue = await fetchIssue(number, { cwd: workspaceRoot });
  if (!issue) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Issue #${number} not found or forge unavailable` }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(issue));
}

async function handlePRView(res: http.ServerResponse, url: URL): Promise<void> {
  // Mirror of handleIssueView for PRs: same workspace resolution, same
  // ?number= param, routed through the `pr-view` forge concept. Powers the
  // VSCode `codev.openPRById` / QuickPick "View PR #N" browser-open flow.
  let workspaceRoot = url.searchParams.get('workspace');
  if (!workspaceRoot) {
    const knownPaths = getKnownWorkspacePaths();
    workspaceRoot = knownPaths.find(p => !p.includes('/.builders/')) || null;
  }

  const number = url.searchParams.get('number');
  if (!workspaceRoot || !number) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing workspace or number' }));
    return;
  }

  const pr = await fetchPR(number, { cwd: workspaceRoot });
  if (!pr) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `PR #${number} not found or forge unavailable` }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(pr));
}

/**
 * GET /api/issue-search — the data source for the VSCode "Search Backlog"
 * editor-tab webview (#920). Returns the issue set for the requested
 * `state`, each row carrying its `body` so the panel can substring-match
 * title + body host-side.
 *
 * Deliberately separate from /api/overview: this does a *fresh* fetch with
 * `body` opted in, so the always-on overview payload stays body-free. The
 * panel hits this on open, on refresh, and when the Status dropdown changes.
 *
 * - `state=open` (default): reproduces the sidebar backlog — open issues
 *   minus those already linked to a PR ("no PR yet"). Matches `deriveBacklog`.
 * - `state=closed|all`: lifts the PR-exclusion (a closed issue usually *has*
 *   a merged PR, so excluding would empty the list) and returns the raw set.
 */
async function handleIssueSearch(res: http.ServerResponse, url: URL): Promise<void> {
  let workspaceRoot = url.searchParams.get('workspace');
  if (!workspaceRoot) {
    const knownPaths = getKnownWorkspacePaths();
    workspaceRoot = knownPaths.find(p => !p.includes('/.builders/')) || null;
  }
  if (!workspaceRoot) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing workspace' }));
    return;
  }

  const rawState = url.searchParams.get('state');
  const state: 'open' | 'closed' | 'all' =
    rawState === 'closed' || rawState === 'all' ? rawState : 'open';

  const issues = await searchIssues(workspaceRoot, state);
  if (issues === null) {
    const body: IssueSearchResponse = {
      items: [],
      error: 'Forge unavailable — could not fetch issues',
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }

  // Only the open backlog excludes PR-linked issues (the "no PR yet" set the
  // sidebar shows). Closed/all return the raw set — see the doc comment.
  let prLinkedIssues = new Set<string>();
  if (state === 'open') {
    const prs = await fetchPRList(workspaceRoot);
    if (prs) {
      prLinkedIssues = new Set(
        prs
          .map(pr => parseLinkedIssue(pr.body || '', pr.title))
          .filter((id): id is string => id !== null),
      );
    }
  }

  const items: IssueSearchItem[] = issues
    .filter(issue => !prLinkedIssues.has(String(issue.number)))
    .map(issue => {
      const item: IssueSearchItem = {
        id: String(issue.number),
        title: issue.title,
        url: issue.url,
        area: parseArea(issue.labels),
        createdAt: issue.createdAt,
        body: issue.body ?? '',
      };
      if (issue.author?.login) { item.author = issue.author.login; }
      const assignees = issue.assignees?.map(a => a.login) ?? [];
      if (assignees.length > 0) { item.assignees = assignees; }
      return item;
    });

  const response: IssueSearchResponse = { items };
  const currentUser = await fetchCurrentUser(workspaceRoot);
  if (currentUser) { response.currentUser = currentUser; }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response));
}

/**
 * GET /api/worktree-config — returns the canonical `ResolvedWorktreeConfig`
 * for the requested workspace (defaults / cache / global / project /
 * project-local, deep-merged per `lib/config.ts:loadConfig`). This is
 * the single source of truth for any client that needs to act on
 * worktree config (currently the VSCode extension's "Open Dev URL"
 * surface; the dashboard is welcome to use it too).
 *
 * Side effect: lazily installs a directory watcher on the workspace's
 * `.codev/` so any subsequent edit to `config.json` /
 * `config.local.json` fans out a `codev-config-updated` SSE event
 * — clients refetch via this same endpoint and re-render.
 */
function handleWorktreeConfigView(res: http.ServerResponse, url: URL): void {
  let workspaceRoot = url.searchParams.get('workspace');
  if (!workspaceRoot) {
    const knownPaths = getKnownWorkspacePaths();
    workspaceRoot = knownPaths.find(p => !p.includes('/.builders/')) || null;
  }
  if (!workspaceRoot) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing workspace' }));
    return;
  }
  try {
    const config = getWorktreeConfig(workspaceRoot);
    ensureCodevConfigWatcher(workspaceRoot);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Failed to resolve worktree config: ${message}` }));
  }
}

/**
 * GET /api/activity-hooks — returns the canonical `ResolvedActivityHooks` (the
 * `activityHooks` block merged across the loadConfig layer chain). Installs the
 * shared config-file watcher, so an edit to `.codev/config(.local).json` fans out a
 * `codev-config-updated` SSE (the config-file-change signal) and clients re-fetch.
 */
function handleActivityHooksView(res: http.ServerResponse, url: URL): void {
  let workspaceRoot = url.searchParams.get('workspace');
  if (!workspaceRoot) {
    const knownPaths = getKnownWorkspacePaths();
    workspaceRoot = knownPaths.find(p => !p.includes('/.builders/')) || null;
  }
  if (!workspaceRoot) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing workspace' }));
    return;
  }
  try {
    const config = getActivityHooks(workspaceRoot);
    ensureCodevConfigWatcher(workspaceRoot);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Failed to resolve activity hooks: ${message}` }));
  }
}

function handleOverviewRefresh(res: http.ServerResponse, ctx?: RouteContext): void {
  overviewCache.invalidate();
  // Bugfix #388: Broadcast SSE event so all connected dashboard clients
  // immediately re-fetch instead of waiting for the next poll cycle.
  if (ctx) {
    ctx.broadcastNotification({ type: 'overview-changed', title: 'Overview updated', body: 'Cache invalidated' });
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

async function handleAnalytics(res: http.ServerResponse, url: URL, workspaceOverride?: string): Promise<void> {
  let workspaceRoot = workspaceOverride || url.searchParams.get('workspace');

  if (!workspaceRoot) {
    const knownPaths = getKnownWorkspacePaths();
    workspaceRoot = knownPaths.find(p => !p.includes('/.builders/')) || null;
  }

  // Validate range parameter (before workspace check so fallback uses correct range)
  const rangeParam = url.searchParams.get('range') ?? '7';
  if (!['1', '7', '30', 'all'].includes(rangeParam)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid range. Must be 1, 7, 30, or all.' }));
    return;
  }

  const rangeLabel = rangeParam === 'all' ? 'all' : rangeParam === '1' ? '24h' : `${rangeParam}d`;

  if (!workspaceRoot) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ timeRange: rangeLabel, activity: { prsMerged: 0, medianTimeToMergeHours: null, issuesClosed: 0, medianTimeToCloseBugsHours: null, projectsByProtocol: {} }, consultation: { totalCount: 0, totalCostUsd: null, costByModel: {}, avgLatencySeconds: null, successRate: null, byModel: [], byReviewType: {}, byProtocol: {} } }));
    return;
  }
  const range = rangeParam as '1' | '7' | '30' | 'all';
  const refresh = url.searchParams.get('refresh') === '1';

  const data = await computeAnalytics(workspaceRoot, range, refresh);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function handleSSEEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteContext,
): void {
  const clientId = crypto.randomBytes(8).toString('hex');

  // Bugfix #1124: check capacity BEFORE writing 200 headers.
  // Once headers are sent the client thinks it's connected; rejecting
  // pre-headers lets us return 503 + Retry-After, which is a dead end
  // (no reconnect cascade).
  const client: SSEClient = { res, id: clientId, connectedAt: Date.now() };
  const accepted = ctx.addSseClient(client);
  if (!accepted) {
    res.writeHead(503, {
      'Content-Type': 'text/plain',
      'Retry-After': '5',
    });
    res.end('SSE capacity reached. Retry later.\n');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Bugfix #1124: send retry directive to space out browser reconnections.
  // Without this, browsers default to ~3s which amplifies churn.
  res.write('retry: 5000\n\n');

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: 'connected', id: clientId })}\n\n`);

  // Clean up on disconnect — guard against duplicate cleanup (Bugfix #580)
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    ctx.removeSseClient(clientId);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
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

/** Minimal JSON responder for the send route. */
function sendJson(res: http.ServerResponse, status: number, payload: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/**
 * The specific architect NAME whose live terminal is `terminalId`, or null when
 * `terminalId` is a builder/shell terminal. Reverse-maps via the routing registry
 * (Spec 1313): storing the canonical architect name on a mailbox row is what lets
 * held mail redeliver to the right terminal after a respawn, and it also tells an
 * architect target from a builder target for message formatting.
 */
function architectNameForTerminal(workspacePath: string, terminalId: string): string | null {
  const entry = getWorkspaceTerminals().get(workspacePath);
  if (!entry) return null;
  for (const [name, tid] of entry.architects) {
    if (tid === terminalId) return name;
  }
  return null;
}

/**
 * The canonical mailbox identity of a live-resolved target: architect targets are
 * stored under their SPECIFIC architect name (reverse-mapped from the terminal),
 * everything else under its resolved agent id.
 */
function liveTargetIdentity(result: ResolveResult): { toAgent: string; isArchitectTarget: boolean } {
  const archName = architectNameForTerminal(result.workspacePath, result.terminalId);
  return { toAgent: archName ?? result.agent, isArchitectTarget: archName !== null };
}

/**
 * Format a message per sender/target — preserves the pre-1313 formatting rules.
 *
 * #1574: `toAgent` is the CANONICAL recipient the mailbox row is keyed on (the
 * architect reverse-map for architect targets, the resolved agent id otherwise),
 * so the header a recipient reads names the same identity the row was addressed
 * to. Passing anything else here would make the frame attest to a fiction.
 */
function formatMessageForTarget(
  isArchitectTarget: boolean,
  from: string | undefined,
  toAgent: string,
  message: string,
  raw: boolean,
): string {
  // #1494: a human's approval relayed by the VS Code extension gets its own
  // header, so the architect can tell it from a peer-architect instruction.
  if (isArchitectTarget && from === VSCODE_USER_SENDER) return formatUserViaVsCodeMessage(toAgent, message, undefined, raw);
  if (isArchitectTarget && from) return formatBuilderMessage(from, toAgent, message, undefined, raw); // builder → architect
  if (!isArchitectTarget) return formatArchitectToBuilderMessage(toAgent, message, undefined, raw); // any → builder
  return raw ? message : formatArchitectMessage(toAgent, message, undefined, false); // unknown → architect
}

/**
 * Route a cron notification through the Spec 1313 mailbox + gate — the Tower-wired
 * front half of {@link deliverCronMail} (Phase 6). Resolves the task's target to a
 * canonical recipient agent: a live terminal via {@link resolveTarget} plus the
 * architect reverse-map ({@link liveTargetIdentity}, because a bare `architect`
 * target resolves to the generic id, which the mailbox can't address), or — when the
 * agent is known but has no live PTY — via {@link resolveAgentInRegistry}, so the
 * message HOLDS as `no-live-pty` instead of vanishing (spec decision 9). Then it
 * hands off to the registry-free core. Cron is a non-builder sender, so no
 * sender-affinity or spoofing check applies. Wired into the cron scheduler as its
 * `deliver` port (see `initCron`), keeping the scheduler ignorant of mailbox
 * internals and giving cron exactly one gated path shared with `handleSend`.
 */
export async function deliverCronMessage(
  task: Pick<CronTask, 'name' | 'target' | 'workspacePath'>,
  message: string,
  log: (level: 'INFO' | 'ERROR' | 'WARN', msg: string) => void,
): Promise<CronDeliveryResult> {
  const db = getGlobalDb();
  const ports = makeDeliveryPorts(log);
  // Preserve the pre-1313 cron framing: a message FROM the `af-cron` pseudo-builder,
  // regardless of whether the target is an architect or a builder.
  //
  // #1574: the frame names its recipient, which is only known AFTER resolution —
  // so it is built per-branch rather than once up front. `base` carries everything
  // that does not depend on the target.
  const base = {
    body: message,
    supersedeKey: task.name,
  };

  const live = resolveTarget(task.target, task.workspacePath);
  if (!isResolveError(live)) {
    const { toAgent } = liveTargetIdentity(live);
    return deliverCronMail(ports, db, {
      ...base,
      formattedMessage: formatBuilderMessage(CRON_SENDER, toAgent, message),
      workspacePath: live.workspacePath,
      toAgent,
      terminalId: live.terminalId,
    });
  }

  // Live resolution failed. A NOT_FOUND target may still be a known agent with no
  // live PTY (Tower restarting, builder between respawns) — hold its mail so a
  // respawn drains it, instead of the old blind drop-with-WARN (decision 9).
  if (live.code === 'NOT_FOUND') {
    const reg = resolveAgentInRegistry(task.target, task.workspacePath);
    if (!isResolveError(reg)) {
      return deliverCronMail(ports, db, {
        ...base,
        formattedMessage: formatBuilderMessage(CRON_SENDER, reg.agent, message),
        workspacePath: reg.workspacePath,
        toAgent: reg.agent,
        terminalId: null,
      });
    }
  }

  log('WARN', `Cron '${task.name}': target '${task.target}' not found — message not delivered`);
  return { outcome: 'unresolved', reason: null, mailboxId: null };
}

/**
 * Persist a `held` mailbox row and write the Spec 1313 `held` send response. Used
 * for both dead-session cases (no live PTY, held `no-live-pty`). The row exists
 * before the response returns, so the backstop drainer will redeliver it once the
 * agent has a clean prompt — nothing is dropped.
 */
function holdAndRespond(
  res: http.ServerResponse,
  ctx: RouteContext,
  input: EnqueueInput,
  reason: MailboxReason,
): void {
  const row = enqueueMailbox(getGlobalDb(), { ...input, reason });
  ctx.log(
    'INFO',
    `Message held (${reason}) → ${input.toAgent} @ ${path.basename(input.workspacePath)} (mailbox ${row.id.slice(0, 8)}...)`,
  );
  // A new held row appeared → refresh the held-count indicator (Spec 1313, Phase 7).
  ctx.broadcastNotification({ type: 'overview-changed', title: 'Held mail changed', body: `held ${reason}` });
  sendJson(res, 200, {
    ok: true,
    terminalId: input.terminalId ?? null,
    resolvedTo: input.toAgent,
    deferred: true, // back-compat: a held message is "deferred" to old binaries
    delivered: false,
    held: true,
    reason,
    mailboxId: row.id,
    bodyLength: Buffer.byteLength(input.body, 'utf8'),
  });
}

/** Machine-readable reason paired with `degraded: true` on an operator send response. */
const DEGRADED_SUBMIT_REASON = 'submit-wait-ceiling-expired';

/**
 * Announce that an operator submission gave up waiting for the per-terminal lock and wrote
 * unserialized (Issue #1365).
 *
 * This is the degraded path, and it is deliberately loud. The ceiling arms only against a
 * DELIVERY write (behind another operator the wait stays unbounded, as before #1365), so what
 * expiry falls back to is exactly the pre-#1365 operator-vs-delivery behaviour: two disjoint
 * locks, no serialization. That one pair is therefore no worse than the old status quo — but
 * it used to be invisible, and now it is not, here and in the `degraded` flag on the response.
 */
function logCeilingExpired(
  ctx: RouteContext,
  action: string,
  toAgent: string,
  terminalId: string,
  waitedMs: number,
): void {
  ctx.log(
    'WARN',
    `${action} → ${toAgent} (terminal ${terminalId.slice(0, 8)}...) waited ${waitedMs}ms for an in-flight ` +
      `write and proceeded UNSERIALIZED — it may interleave with that write. A message long enough to ` +
      `hold the line this long is the usual cause.`,
  );
}

/** Inputs for a delayed (`--delay`) send, captured from the parsed request. */
interface DelayedSendParams {
  to: string;
  workspace: string | undefined;
  from: string | undefined;
  message: string;
  raw: boolean;
  noEnter: boolean;
  interrupt: boolean;
  deliverAfter: number;
  senderWorkspace: string;
}

/**
 * Handle a delayed (`--delay`) send (Spec 1307, re-homed onto the Spec 1313 mailbox; round 3
 * durable rework). The row is RESOLVED, authorized (the builder-spoofing check inside
 * `resolveTarget`), formatted, and PERSISTED here at REQUEST time with `not_before = now +
 * delay*1000` — the security property the immediate path documents (a delayed send must not
 * defer an authorization check past the conditions that would fail it) is preserved, and only
 * DELIVERY is deferred. Persisting at request time is what makes `--delay` DURABLE across a
 * Tower restart (the conscious, architect+maintainer-approved reversal of Spec 1307's
 * drop-on-restart semantics): the render gate still guarantees a post-restart delivery only
 * ever lands on a verified-empty prompt, and a pre-due row is visible/cancellable in
 * `afx inbox`.
 *
 * Resolution is live-first then registry (a known agent with no live PTY) so a
 * dead/unwritable/registry-only target schedules UNIFORMLY — a delayed send does not require a
 * live session now. reason is left null: the row is SCHEDULED, not held-for-a-reason; the
 * drainer re-evaluates liveness at due time.
 *
 * The body is NEVER written from here. A normal delayed send is delivered by the gated
 * backstop drainer once `not_before` passes (≤ one 1.5 s tick after due — the delay is a lower
 * bound). A delayed `--interrupt` (change 2 reshape) additionally keeps a small in-memory timer
 * that fires ONLY the Ctrl+C at due time (guarded by `isStillLive` + a re-fetched writable
 * session, inside the submission lock); the ^C ends the turn and the body then delivers through
 * the SAME gate every send uses — nothing is marked delivered here, so a #1198 dropped write or
 * a shutdown during the wait can never falsely report delivery or double-deliver. A restart
 * during the wait loses only the ^C nudge, never the message.
 */
function handleDelayedSend(
  res: http.ServerResponse,
  ctx: RouteContext,
  db: ReturnType<typeof getGlobalDb>,
  params: DelayedSendParams,
): void {
  const { to, workspace, from, message, raw, noEnter, interrupt, deliverAfter, senderWorkspace } = params;
  const now = Date.now();
  const notBefore = now + deliverAfter * 1000;

  // Resolve to a canonical AGENT — live first, then registry (known agent, no live PTY yet).
  let workspacePath: string;
  let toAgent: string;
  let isArchitectTarget: boolean;
  let terminalId: string | null;

  const live = resolveTarget(to, workspace, from);
  if (!isResolveError(live)) {
    const identity = liveTargetIdentity(live);
    workspacePath = live.workspacePath;
    toAgent = identity.toAgent;
    isArchitectTarget = identity.isArchitectTarget;
    terminalId = live.terminalId;
  } else if (live.code === 'NOT_FOUND') {
    const reg = resolveAgentInRegistry(to, workspace, from);
    if (isResolveError(reg)) {
      const statusCode = reg.code === 'AMBIGUOUS' ? 409 : reg.code === 'NO_CONTEXT' ? 400 : 404;
      const errorCode = reg.code === 'NO_CONTEXT' ? 'INVALID_PARAMS' : reg.code;
      sendJson(res, statusCode, { error: errorCode, message: reg.message });
      return;
    }
    workspacePath = reg.workspacePath;
    toAgent = reg.agent;
    isArchitectTarget = reg.kind === 'architect';
    terminalId = null;
  } else {
    const statusCode = live.code === 'AMBIGUOUS' ? 409 : live.code === 'NO_CONTEXT' ? 400 : 404;
    const errorCode = live.code === 'NO_CONTEXT' ? 'INVALID_PARAMS' : live.code;
    sendJson(res, statusCode, { error: errorCode, message: live.message });
    return;
  }

  const formattedMessage = formatMessageForTarget(isArchitectTarget, from, toAgent, message, raw);

  // Persist NOW, at request time, with the due time. reason=null → SCHEDULED, not stuck.
  const row = enqueueMailbox(db, {
    workspacePath,
    toAgent,
    body: message,
    formattedMessage,
    fromAgent: from ?? null,
    fromWorkspace: senderWorkspace,
    noEnter,
    terminalId,
    notBefore,
  });
  // A new held (scheduled) row appeared → refresh the held-count indicator (Phase 7).
  ctx.broadcastNotification({ type: 'overview-changed', title: 'Held mail changed', body: 'scheduled' });

  if (interrupt) {
    // Change 2 reshape: an in-memory timer that fires ONLY the Ctrl+C at due time. It writes
    // no message body and marks nothing delivered — the body delivers through the gated
    // drainer after the ^C ends the turn. Everything the ^C depends on — `isStillLive`
    // (delayed-send.ts's generation guard), the session's existence, and its writability — is
    // re-checked INSIDE the submission lock, right before the write, so a shutdown OR a session
    // teardown/respawn during the lock-wait writes nothing (invariant 2; the directive's
    // preferred shape). Diagnostics arg falls back to toAgent when the target has no terminal
    // id yet.
    scheduleDelayedSend(deliverAfter, terminalId ?? toAgent, (isStillLive) => {
      if (!isStillLive()) return; // shutdown before/at due → drop the ^C nudge (body survives)
      if (terminalId) {
        let fired = false;
        void submitToSession(
          terminalId,
          () => {
            // Re-check EVERYTHING inside the lock: the queued submission can acquire the lock only
            // AFTER a shutdown or a session teardown/respawn that landed while it waited behind an
            // in-flight write. Re-fetch the session and re-check live + writable here; bail with no
            // ^C otherwise (the body still delivers via the gate).
            if (!isStillLive()) return 0;
            const live = getTerminalManager().getSession(terminalId);
            if (!live || !live.writable) return 0;
            live.write('\x03'); // Ctrl+C only — end the turn; body follows via the gate
            fired = true;
            return 0; // no body, no Enter on this path
          },
          undefined,
          // The same operator ceiling as the immediate paths (Issue #1365). This one fires
          // UNATTENDED, so it is the writer most likely to meet a gated delivery mid-pace —
          // which is precisely why the delayed `^C` must take this lock at all.
          {
            waitCeilingMs: OPERATOR_SUBMIT_WAIT_CEILING_MS,
            onCeilingExpired: (waitedMs) => logCeilingExpired(ctx, 'delayed interrupt ^C', toAgent, terminalId, waitedMs),
            // This is the one operator path whose write can be a NO-OP (the liveness re-check
            // above). A degraded no-op raced nobody, so it must not bump the bypass counter —
            // that would make a concurrent delivery hold and re-deliver for nothing.
            wroteBytes: () => fired,
          },
        )
          .then(() =>
            ctx.log('INFO', fired
              ? `Delayed interrupt ^C fired → ${toAgent} (terminal ${terminalId.slice(0, 8)}...); body delivers via the gate`
              : `Delayed interrupt for ${toAgent}: session not live/writable at write time — body delivers via the gate on the next clean pass`),
          )
          .catch((err) => ctx.log('ERROR', `Delayed interrupt ^C failed for ${toAgent}: ${(err as Error).message}`));
      } else {
        ctx.log('INFO', `Delayed interrupt for ${toAgent}: no live terminal at due time — body delivers via the gate on the next clean pass`);
      }
      // Nudge the gated drainer so the now-due body delivers promptly (gated — a spurious
      // nudge onto a busy/mid-turn screen simply re-holds; the backstop is the ultimate net).
      void getMailboxDrainer().scheduleDrain(workspacePath, toAgent);
    });
  }
  // A normal delayed send keeps NO timer: the persisted `not_before` row is delivered by the
  // gated backstop drainer once due — durable across restart by construction.

  ctx.log('INFO', `Message scheduled (+${deliverAfter}s): ${from ?? 'unknown'} → ${toAgent} (mailbox ${row.id.slice(0, 8)}...)`);
  sendJson(res, 200, {
    ok: true,
    terminalId,
    resolvedTo: toAgent,
    deferred: false,
    scheduled: true,
    deliverAfter,
    mailboxId: row.id,
    notBefore,
    bodyLength: Buffer.byteLength(params.message, 'utf8'),
  });
}

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

  // Issue #1573: refuse an over-large body LOUDLY, here at the route rather than only at the
  // CLI — `/api/send` is a public local route, and the CLI is not its only caller. Nothing
  // downstream bounded message size, so an oversized body used to be paced onto the line one
  // line at a time and reported delivered whatever the composer made of it. Rejecting is the
  // only honest option: truncating would reproduce #1564 on purpose.
  const bodyLength = Buffer.byteLength(message, 'utf8');
  if (bodyLength > MAX_MESSAGE_BYTES) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'MESSAGE_TOO_LARGE', message: messageTooLargeError(bodyLength) }));
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
  const escape = options.escape === true;

  // Spec 1307 `--delay` (re-homed onto the mailbox): optional deferred delivery.
  // Validated here as well as at the CLI boundary — /api/send is a public route, so an
  // unvalidated value would become a setTimeout that fires instantly (NaN) or never
  // (Infinity). `escape` cannot be combined with a delay: an ESC interrupts the CURRENT
  // turn by design, so deferring it is contradictory — refuse rather than silently drop
  // one of the two (a quietly-dropped delay would look like it worked).
  let deliverAfter: number | undefined;
  if (options.deliverAfter !== undefined && options.deliverAfter !== null) {
    const delayError = validateDelaySeconds(options.deliverAfter);
    if (delayError) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'INVALID_PARAMS', message: delayError }));
      return;
    }
    if (escape) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'INVALID_PARAMS',
        message: 'escape cannot be combined with a delay: an ESC keystroke bypasses buffering by design so that it interrupts the CURRENT turn. Send the ESC now, or send a delayed message without escape.',
      }));
      return;
    }
    deliverAfter = options.deliverAfter as number;
  }

  const db = getGlobalDb();
  const senderWorkspace = fromWorkspace ?? workspace ?? 'unknown';

  // Spec 1313 round 3: a delayed send (`--delay`) is RESOLVED, authorized, formatted, and
  // PERSISTED here at REQUEST time, then deferred — it does NOT require a live session now,
  // so it is handled BEFORE the immediate live/dead/unwritable/escape/interrupt branches
  // below (those would 404/503 a delayed send to a target that has no live PTY yet). Only
  // DELIVERY is deferred, through the same render gate every send uses; the row's `not_before`
  // makes the delay durable across a Tower restart.
  if (deliverAfter !== undefined) {
    handleDelayedSend(res, ctx, db, {
      to, workspace, from, message, raw, noEnter, interrupt, deliverAfter, senderWorkspace,
    });
    return;
  }

  // Resolve the target address against LIVE terminals.
  // Spec 755: pass `from` so architect resolution is sender-affinity-aware
  // when the sender is a builder. Non-builder senders see unchanged behavior.
  const result = resolveTarget(to, workspace, from);

  // --- Resolution failed against live terminals ---
  if (isResolveError(result)) {
    // Spec 1313 dead-session seam: a NOT_FOUND target may still be a KNOWN agent
    // with no live PTY (e.g. registered in global.db while Tower restarts). Hold
    // its mail instead of 404ing. escape/interrupt act on a live session only, so
    // an unresolved target keeps the original error for them.
    if (result.code === 'NOT_FOUND' && !escape && !interrupt) {
      const reg = resolveAgentInRegistry(to, workspace, from);
      if (!isResolveError(reg)) {
        holdAndRespond(
          res,
          ctx,
          {
            workspacePath: reg.workspacePath,
            toAgent: reg.agent,
            body: message,
            formattedMessage: formatMessageForTarget(reg.kind === 'architect', from, reg.agent, message, raw),
            fromAgent: from ?? null,
            fromWorkspace: senderWorkspace,
            noEnter,
            terminalId: null,
          },
          'no-live-pty',
        );
        return;
      }
      if (reg.code === 'AMBIGUOUS') {
        sendJson(res, 409, { error: 'AMBIGUOUS', message: reg.message });
        return;
      }
      // else: fall through to the original live-resolution error below.
    }
    const statusCode = result.code === 'AMBIGUOUS' ? 409 : result.code === 'NO_CONTEXT' ? 400 : 404;
    // Map NO_CONTEXT to INVALID_PARAMS per plan's error contract
    const errorCode = result.code === 'NO_CONTEXT' ? 'INVALID_PARAMS' : result.code;
    sendJson(res, statusCode, { error: errorCode, message: result.message });
    return;
  }

  // --- Live target resolved; locate its session ---
  const manager = getTerminalManager();
  const session = manager.getSession(result.terminalId);
  const { toAgent, isArchitectTarget } = liveTargetIdentity(result);

  // Dead session: the routing entry resolved but the PTY is gone (exited > 30s).
  // Hold a normal message; escape/interrupt need a live session → original 404.
  if (!session) {
    if (escape || interrupt) {
      sendJson(res, 404, {
        error: 'NOT_FOUND',
        message: `Terminal session ${result.terminalId} not found (agent '${result.agent}' resolved but terminal is gone).`,
      });
      return;
    }
    holdAndRespond(
      res,
      ctx,
      {
        workspacePath: result.workspacePath,
        toAgent,
        body: message,
        formattedMessage: formatMessageForTarget(isArchitectTarget, from, toAgent, message, raw),
        fromAgent: from ?? null,
        fromWorkspace: senderWorkspace,
        noEnter,
        terminalId: result.terminalId,
      },
      'no-live-pty',
    );
    return;
  }

  // #1198: a session whose shellper connection died still reports status
  // 'running', but every write is dropped. Hold a normal message (it delivers
  // when the connection recovers); keep the loud 503 for escape/interrupt, which
  // are operator actions that require the live PTY here and now.
  if (!session.writable) {
    if (escape || interrupt) {
      ctx.log('ERROR', `Interrupt/ESC not deliverable: ${from ?? 'unknown'} → ${result.agent} (terminal not writable, shellper connection down)`);
      sendJson(res, 503, {
        error: 'TERMINAL_NOT_WRITABLE',
        message: `Terminal for '${result.agent}' is not accepting input (its process connection is down). Retry shortly; if this persists, check Tower logs.`,
      });
      return;
    }
    holdAndRespond(
      res,
      ctx,
      {
        workspacePath: result.workspacePath,
        toAgent,
        body: message,
        formattedMessage: formatMessageForTarget(isArchitectTarget, from, toAgent, message, raw),
        fromAgent: from ?? null,
        fromWorkspace: senderWorkspace,
        noEnter,
        terminalId: result.terminalId,
      },
      'no-live-pty',
    );
    return;
  }

  // --- Live, writable session ---

  // Spec 1273: `escape` delivers a bare ESC keystroke and returns. Explicit human
  // bypass — no gate, no mailbox row. ESC ends the running turn so already-queued
  // messages process; the trailing Enter (default) is what lets them through
  // (matching the verified recovery `afx send <b> --raw "$(printf '\x1b')"`).
  if (escape) {
    // Awaited: the response must not claim delivery before the ESC and its
    // Enter have actually been written (Spec 1273 verify).
    // Issue #1365: escape is an operator submission — it blocks behind an in-flight write
    // (including a gated mailbox delivery, which now takes this same lock) so its ESC and
    // Enter can no longer truncate a delivery mid-pace, but only up to the wait ceiling.
    let escapeDegraded = false;
    await submitToSession(result.terminalId, () => writeEscapeToSession(session, noEnter), undefined, {
      waitCeilingMs: OPERATOR_SUBMIT_WAIT_CEILING_MS,
      onCeilingExpired: (waitedMs) => {
        escapeDegraded = true;
        logCeilingExpired(ctx, 'ESC', toAgent, result.terminalId, waitedMs);
      },
    });
    broadcastMessage({
      type: 'message',
      from: { project: path.basename(senderWorkspace), agent: from ?? 'unknown' },
      to: { project: path.basename(result.workspacePath), agent: toAgent },
      content: '<ESC>',
      metadata: { raw: true, source: 'api', escape: true },
      timestamp: new Date().toISOString(),
    });
    ctx.log('INFO', `Interrupt (ESC) sent: ${from ?? 'unknown'} → ${toAgent} (terminal ${result.terminalId.slice(0, 8)}...)`);
    sendJson(res, 200, {
      ok: true,
      terminalId: result.terminalId,
      resolvedTo: toAgent,
      deferred: false,
      ...(escapeDegraded ? { degraded: true, degradedReason: DEGRADED_SUBMIT_REASON } : {}),
    });
    return;
  }

  const formattedMessage = formatMessageForTarget(isArchitectTarget, from, toAgent, message, raw);

  // NB: `--delay` (deliverAfter) is handled earlier by handleDelayedSend, before this
  // immediate-path block — a delayed send is resolved + persisted at request time and does
  // not fall through here.

  // Spec 1313: `interrupt` is the explicit human bypass. Ctrl+C, then deliver
  // WITHOUT the render-gate (the operator is looking at this terminal). A row is
  // still persisted and marked delivered for audit parity — every send is a row.
  if (interrupt) {
    const row = enqueueMailbox(db, {
      workspacePath: result.workspacePath,
      toAgent,
      body: message,
      formattedMessage,
      fromAgent: from ?? null,
      fromWorkspace: senderWorkspace,
      noEnter,
      terminalId: result.terminalId,
    });
    // Claim the row as delivered SYNCHRONOUSLY, before any await (CMAP round 2 — Codex): the
    // interrupt writes the message itself (a gate bypass), so the row must never be visible to
    // the mailbox drainer as `held`, or a concurrent backstop/scheduleDrain pass could gate-deliver
    // the SAME row and put the bytes on the wire twice. enqueue→markDelivered are both synchronous
    // (no await between), so there is no window for the drainer to pick it up before we own it.
    // Tradeoff (CMAP round 3 — Codex/Claude): claiming BEFORE the write below means that if
    // submitToSession throws/crashes, the row reads `delivered` for audit though no bytes reached
    // the PTY — the message is lost, not retried. This is the deliberate choice: the write is not
    // transactional, so a partial write may already have put bytes on the wire, and re-holding (the
    // alternative) would let the backstop gate-deliver a SECOND copy. Losing a crashed interrupt is
    // preferred over double-delivering it; `--interrupt` is the explicit human gate-bypass anyway.
    markMailboxDelivered(db, row.id);
    // Deliver the interrupt as ONE atomic critical section under the Spec 1273 per-terminal
    // submission lock (CMAP round 1 — Gemini/Codex/Claude): the Ctrl+C, its 100 ms settle, and
    // the message write all occur inside a single lock acquisition. Previously the \x03 + the
    // settle sat OUTSIDE the lock, so a concurrent submission to the same terminal could land
    // its Ctrl+C inside another submission's text→Enter window (killing that composer) or run
    // during the 100 ms gap. `writeMessageToSession(..., 100)` schedules the text 100 ms after
    // the ^C (the settle) and returns the completion offset, so the lock is held until the
    // whole interrupt is on the wire; uncontended, it runs at once.
    //   Scope of the guarantee (Issue #1365 — this used to end at "interrupt vs interrupt/escape"):
    //   the gated mailbox delivery path now takes this SAME per-terminal lock, so an interrupt is
    //   serialized against a concurrent delivery too. That closes the case where a `^C` landed
    //   inside a delivery's own text→Enter window, clearing the composer while every byte still
    //   reported success — the row read `delivered` for a message the agent never saw. The lock
    //   order is per-agent → per-terminal (the delivery takes this one as a leaf), never the
    //   reverse, so there is no cycle. See session-submit.ts for the full boundary.
    // Whether this interrupt gave up waiting and wrote unserialized. It must reach the SENDER,
    // not just the Tower log (codex review of PR #1492): the row above was claimed `delivered`
    // before the write, so a degraded interrupt would otherwise report an unqualified success
    // for a body that may have interleaved with the delivery it skipped. We keep the
    // claim-first tradeoff (un-claiming risks a double delivery — see above) and tell the
    // truth about it instead.
    let degraded = false;
    await submitToSession(
      result.terminalId,
      () => {
        session.write('\x03'); // Ctrl+C
        return writeMessageToSession(session, formattedMessage, noEnter, 100);
      },
      undefined,
      {
        waitCeilingMs: OPERATOR_SUBMIT_WAIT_CEILING_MS,
        onCeilingExpired: (waitedMs) => {
          degraded = true;
          logCeilingExpired(ctx, 'interrupt', toAgent, result.terminalId, waitedMs);
        },
      },
    );
    broadcastMessage({
      type: 'message',
      from: { project: path.basename(senderWorkspace), agent: from ?? 'unknown' },
      to: { project: path.basename(result.workspacePath), agent: toAgent },
      content: message,
      metadata: { raw, source: 'api' },
      timestamp: new Date().toISOString(),
    });
    ctx.log('INFO', `Message delivered (interrupt): ${from ?? 'unknown'} → ${toAgent} (terminal ${result.terminalId.slice(0, 8)}...)`);
    sendJson(res, 200, {
      ok: true,
      terminalId: result.terminalId,
      resolvedTo: toAgent,
      deferred: false,
      delivered: true,
      held: false,
      mailboxId: row.id,
      reason: null,
      bodyLength,
      // Additive and present only when it happened, so older clients are unaffected.
      ...(degraded ? { degraded: true, degradedReason: DEGRADED_SUBMIT_REASON } : {}),
    });
    return;
  }

  // Spec 1313 normal path: PERSIST first (survives a crash), then attempt gated
  // delivery through the single serialized path. The response reports the row's
  // real first outcome — a clean, render-verified empty prompt delivers now;
  // anything else (busy/menu/wrapper/no-profile) stays held for the backstop.
  const row = enqueueMailbox(db, {
    workspacePath: result.workspacePath,
    toAgent,
    body: message,
    formattedMessage,
    fromAgent: from ?? null,
    fromWorkspace: senderWorkspace,
    noEnter,
    terminalId: result.terminalId,
  });
  // Deliver to the session THIS request already resolved rather than re-resolving
  // by agent: the base resolver would repeat the routing-map lookup (redundant) and
  // could target a different terminal if the map changed mid-request. The backstop
  // drainer, which only has the agent, still uses the base resolver.
  const basePorts = makeDeliveryPorts(ctx.log);
  const ports: DeliveryPorts = {
    ...basePorts,
    getSessionForAgent: (ws, agent) =>
      ws === result.workspacePath && agent === toAgent ? session : basePorts.getSessionForAgent(ws, agent),
  };
  // Issue #1584: keep the outcome — it carries whether the delivered message's header was
  // actually seen on the receiving terminal, which is the only thing the sender can act on now
  // that an unconfirmed delivery is recorded rather than re-written.
  let outcome: DeliveryOutcome | null = null;
  try {
    outcome = await deliverAgentMailSerialized(ports, db, result.workspacePath, toAgent);
  } catch (err) {
    // A gate/write error leaves the row HELD (markDelivered only runs on a
    // completed write); the backstop drainer will retry. Report held, not a 500.
    ctx.log('ERROR', `Delivery attempt errored for ${toAgent} (row ${row.id.slice(0, 8)}... stays held): ${(err as Error).message}`);
  }
  const stored = getMailboxById(db, row.id);
  if (stored?.status === 'delivered') {
    ctx.log('INFO', `Message delivered: ${from ?? 'unknown'} → ${toAgent} (terminal ${result.terminalId.slice(0, 8)}...)`);
    sendJson(res, 200, {
      ok: true,
      terminalId: result.terminalId,
      resolvedTo: toAgent,
      deferred: false,
      delivered: true,
      held: false,
      mailboxId: row.id,
      reason: null,
      bodyLength,
      // Additive (Issue #1584). `false` means the bytes were written and accepted but the header
      // never appeared on the terminal — delivered, flagged, and NOT re-written. Reported only
      // when THIS row is the one our own pass delivered: a pass picks the agent's OLDEST held
      // row, so without the id check a concurrent drainer delivery of this row could be
      // reported with another message's verification. Absent (verification skipped, or someone
      // else's pass delivered it) reads exactly as it did before this field existed.
      ...(outcome?.delivered.includes(row.id) && outcome.verified !== undefined
        ? { verified: outcome.verified }
        : {}),
    });
    return;
  }
  const reason: MailboxReason = stored?.reason ?? 'busy';
  ctx.log('INFO', `Message held (${reason}): ${from ?? 'unknown'} → ${toAgent} (mailbox ${row.id.slice(0, 8)}...)`);
  // The message stayed held → a new held row is in the set; refresh the indicator
  // count (Spec 1313, Phase 7). The delivered branch above needs no fire — the
  // delivery path's onHeldStateChange already broadcast when the row left the set.
  ctx.broadcastNotification({ type: 'overview-changed', title: 'Held mail changed', body: `held ${reason}` });
  sendJson(res, 200, {
    ok: true,
    terminalId: result.terminalId,
    resolvedTo: toAgent,
    deferred: true,
    delivered: false,
    held: true,
    reason,
    mailboxId: row.id,
    bodyLength,
  });
}

/**
 * GET /api/inbox — list held (undelivered) mailbox rows for a workspace. Backs the
 * workspace-scoped `afx inbox` (Spec 1313 decision 8): `?workspace=<path>` selects the
 * workspace (the CLI passes the current one by default); the path is normalized to the
 * same realpath form the enqueue path stores, so a raw workspace root still matches its
 * held rows. Omitting `?workspace=` lists every workspace — an API-level convenience the
 * CLI never triggers, kept for direct callers. Metadata-only projection (Spec 1313
 * redaction rule): id, addresses, why-held reason, escalation flag, and enqueue time —
 * the message BODY is deliberately never surfaced here (it travels only over the live
 * terminal stream on delivery). `escalated` is normalized from SQLite's 0/1 to a bool.
 *
 * Issue 1450: `workspaceOverride` lets the workspace-scoped route
 * (`/workspace/<base64>/api/inbox`, which backs the dashboard's held-mail popover) pass the
 * workspace resolved from the URL prefix, exactly as `handleOverview` / `handleAnalytics` do.
 * The override arrives already normalized by the prefix decoder, so `normalizeWorkspacePath`
 * re-running on it is a safe no-op.
 *
 * Two separate widening hazards are closed here, because a scoped caller must never receive
 * another workspace's held mail:
 *   - `??` (not `||`) means `?workspace=` can never take effect once an override was passed.
 *   - An EMPTY override does not fall through to the unscoped all-workspaces listing; it
 *     scopes to a path that matches nothing. Today the dispatcher 400s a missing prefix so
 *     this is unreachable, but "unreachable" is a property of the caller, not of this
 *     function, and the safe failure for a scoped call is zero rows, never every row.
 * The all-workspaces listing therefore remains reachable only when NO override was passed —
 * the Tower-level route without `?workspace=`, the direct-caller convenience the CLI never uses.
 *
 * NOTE: this lists ALL held rows, including pre-due `--delay` rows, while the badge count
 * (`heldSummaryForWorkspace`) excludes them — see the `HeldMessage` type for why the two
 * legitimately disagree.
 */
// Exported as a narrow test seam (Issue 1450): the empty-override branch below cannot be
// reached through `handleRequest` — the workspace dispatcher rejects a missing or non-absolute
// prefix with a 400 before this runs — so the only way to pin that guard's behaviour is to call
// the handler directly. Production callers go through the two route tables, not this export.
export function handleInboxList(res: http.ServerResponse, url: URL, workspaceOverride?: string): void {
  const scoped = workspaceOverride !== undefined;
  const rawWorkspace = workspaceOverride ?? url.searchParams.get('workspace');
  // Normalize to the stored realpath key (mailbox workspace_path is normalized at
  // enqueue — tower-routes handleSend / holdAndRespond — matching overview.ts). Without
  // this a symlinked workspace root would miss its own held rows.
  // `scoped ? '' : undefined` on the empty branch: '' matches no workspace_path, so a scoped
  // call with a blank override returns nothing rather than widening to every workspace.
  const workspace = rawWorkspace
    ? normalizeWorkspacePath(rawWorkspace)
    : (scoped ? '' : undefined);
  const rows = listHeldMailbox(getGlobalDb(), workspace);
  // Annotated, not inferred: `HeldMessage` is the shared contract this route owes its
  // clients, so a projection that drifts from it (a dropped field, or a `body` slipping in)
  // fails the server build rather than only surprising the dashboard at runtime.
  const projected: HeldMessage[] = rows.map((r) => ({
    id: r.id,
    workspacePath: r.workspace_path,
    toAgent: r.to_agent,
    fromAgent: r.from_agent,
    reason: r.reason,
    escalated: r.escalated === 1,
    createdAt: r.created_at,
    // Spec 1313 round 3: due time of a pre-due delayed (`--delay`) row; null = deliver-ASAP.
    // The CLI renders "in Ns" for a row whose notBefore is still in the future.
    notBefore: r.not_before,
  }));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(projected));
}

/**
 * POST /api/inbox/:id/dismiss — mark a held row `dismissed` (operator-cleared via
 * `afx inbox dismiss`). Soft transition: the row is marked, not deleted, and NEVER
 * delivered. The dispatch matches this path for ANY method, so the method is guarded
 * here: a non-POST request (e.g. GET) must not mutate state → 405. 404 when the id names
 * no currently-held row (already terminal or unknown), so the CLI reports a clean error.
 * On success, fires `overview-changed` so the held-count indicator drops immediately.
 * Authorized at the workspace-human trust level — any local operator may dismiss any held
 * row (Spec 1313 decision 8); no ownership check.
 */
function handleInboxDismiss(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteContext,
  match: RegExpMatchArray,
): void {
  // Dismissal mutates state — only POST may reach it. The path match in the dispatch is
  // method-agnostic, so without this guard a GET (or any method) to this URL would dismiss
  // mail. Matches the method-guard convention used by the cron action routes.
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  const id = decodeURIComponent(match[1]);
  if (!dismissMailbox(getGlobalDb(), id)) {
    sendJson(res, 404, { error: 'NOT_FOUND', message: `No held message with id '${id}'` });
    return;
  }
  ctx.broadcastNotification({ type: 'overview-changed', title: 'Held mail changed', body: 'dismissed' });
  ctx.log('INFO', `Inbox: dismissed held message ${id.slice(0, 8)}...`);
  sendJson(res, 200, { ok: true });
}

/**
 * GET /api/inbox/:id — return a single mailbox row INCLUDING its body. Backs
 * `afx inbox show <id>` (Spec 1313 §178: `afx inbox` is a UI surface that legitimately
 * displays message bodies over the local Tower connection — the redaction rule applies to
 * logs/diagnostics/telemetry only, never this view). Mirrors dismiss's addressing model:
 * by unique id at the workspace-human trust level, no per-recipient/workspace ownership
 * check (decision 8). GET-only (the path match in the dispatch is method-agnostic, so a
 * non-GET is rejected here); 404 when the id names no row. The body is returned to the
 * caller but never logged.
 */
function handleInboxShow(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  match: RegExpMatchArray,
): void {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  const id = decodeURIComponent(match[1]);
  const row = getMailboxById(getGlobalDb(), id);
  if (!row) {
    sendJson(res, 404, { error: 'NOT_FOUND', message: `No message with id '${id}'` });
    return;
  }
  sendJson(res, 200, {
    id: row.id,
    workspacePath: row.workspace_path,
    toAgent: row.to_agent,
    fromAgent: row.from_agent,
    fromWorkspace: row.from_workspace,
    status: row.status,
    reason: row.reason,
    escalated: row.escalated === 1,
    body: row.body,
    createdAt: row.created_at,
    notBefore: row.not_before,
    resolvedAt: row.resolved_at,
  });
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
    sendKeyInjectedHtml(res, template);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Error loading template: ' + (err as Error).message);
  }
}

/**
 * Same-origin key injection (advisory GHSA-xvjp-7748-v88v Layer 4). Writes the
 * shared local key into an HTML shell Tower serves (tower.html or the React SPA
 * index.html) so the page can authenticate its own API/WebSocket calls, without
 * embedding a readable secret in the shipped template. The key is hex, so
 * JSON.stringify yields a safe `<script>`-embeddable literal.
 *
 * tower.html carries an explicit placeholder; the built SPA index.html does not,
 * so the script is inserted before `</head>` there — ahead of the deferred SPA
 * module, so `window.__CODEV_TOWER_KEY__` is set before the app's first request.
 */
function injectWebKey(html: string): string {
  const key = getExpectedKey();
  // Only embed a well-formed hex key. `ensureLocalKey` always produces 64 hex
  // chars; validating before embedding means a hand-edited or third-party-written
  // key file containing e.g. `</script>` can never become stored XSS in a shell.
  // A malformed key yields no injection (clients then fail closed with 401).
  const injection = key && /^[0-9a-f]{64}$/.test(key)
    ? `<script>window.__CODEV_TOWER_KEY__ = ${JSON.stringify(key)};</script>`
    : '';
  if (html.includes('<!-- CODEV_TOWER_KEY_INJECTION -->')) {
    return html.replace('<!-- CODEV_TOWER_KEY_INJECTION -->', injection);
  }
  if (injection && html.includes('</head>')) {
    return html.replace('</head>', `${injection}</head>`);
  }
  return html;
}

/**
 * Send a key-injected HTML shell. Strips the CORS `Access-Control-Allow-Origin`
 * header set by the front door: this response body carries the key, and the
 * shell is only ever loaded by a same-origin navigation, so it must never be
 * readable by a cross-origin `fetch` (advisory GHSA-xvjp-7748-v88v). Same-origin
 * reads are unaffected; the key check still guards the actual API routes.
 */
function sendKeyInjectedHtml(res: http.ServerResponse, template: string): void {
  res.removeHeader('Access-Control-Allow-Origin');
  res.removeHeader('Vary');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(injectWebKey(template));
}

/**
 * Serve the React dashboard's index.html with the key injected (SPA shell + SPA
 * client-side-routing fallback). Returns false if the file cannot be read.
 */
function serveDashboardIndex(dashboardPath: string, res: http.ServerResponse): boolean {
  try {
    const html = fs.readFileSync(path.join(dashboardPath, 'index.html'), 'utf-8');
    sendKeyInjectedHtml(res, html);
    return true;
  } catch {
    return false;
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
    workspacePath = decodeWorkspacePath(encodedPath);
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

  // GET /file?path=<relative-path> — Read file by path (allows files outside workspace — see issue #502)
  if (req.method === 'GET' && subPath === 'file' && url.searchParams.has('path')) {
    const relPath = url.searchParams.get('path')!;
    const fullPath = path.resolve(workspacePath, relPath);
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
    // The SPA shell (index.html) is served with the shared key injected same-origin
    // (advisory GHSA-xvjp-7748-v88v) so a direct navigation to a workspace URL can
    // authenticate without first visiting the Tower root. Other static assets
    // (JS/CSS/images) carry no secret and stream as-is.
    const isIndex = !subPath || subPath === '' || subPath === 'index.html';
    if (isIndex) {
      if (serveDashboardIndex(ctx.reactDashboardPath, res)) {
        return;
      }
    } else {
      const staticPath = path.join(ctx.reactDashboardPath, subPath);
      if (serveStaticFile(staticPath, res)) {
        return;
      }
    }

    // SPA fallback: serve the (key-injected) index.html for client-side routing.
    if (serveDashboardIndex(ctx.reactDashboardPath, res)) {
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

    // DELETE /api/architects/:name - Remove a sibling architect (Spec 786 Phase 4)
    // Workspace-scoped variant of /api/workspaces/:encoded/architects/:name —
    // the workspace path comes from the /workspace/<base64>/ URL prefix already
    // resolved above. Used by the dashboard's close-button → confirmation
    // modal flow.
    const archDeleteMatch = apiPath.match(/^architects\/([^/]+)$/);
    if (req.method === 'DELETE' && archDeleteMatch) {
      const name = decodeURIComponent(archDeleteMatch[1]);
      const result = await removeArchitect(workspacePath, name);
      if (result.success) {
        // Spec 823 Phase 4 (iter-1 Codex): emit architects-updated from
        // every successful remove path, not just the /api/workspaces/
        // route, so the VSCode tree refreshes when the dashboard's
        // close-button → confirmation modal triggers the remove.
        ctx.broadcastNotification({
          type: 'architects-updated',
          title: 'Architects updated',
          body: JSON.stringify({ workspace: workspacePath }),
          workspace: workspacePath,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } else {
        const status = result.error?.includes('not running') || result.error?.includes('not found') ? 404 : 400;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: result.error }));
      }
      return;
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

    // GET /api/team - Return team members with GitHub data + messages (Spec 587)
    if (req.method === 'GET' && apiPath === 'team') {
      return handleWorkspaceTeam(res, workspacePath);
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

    // GET /api/overview - Work view overview data (Spec 0126 Phase 4)
    if (req.method === 'GET' && apiPath === 'overview') {
      return handleOverview(res, url, workspacePath, ctx);
    }

    // GET /api/inbox - held mailbox rows for THIS workspace (Issue 1450). Backs the
    // dashboard's clickable held-mail counter. Reuses the Tower-level handler with the
    // workspace resolved from the /workspace/<base64>/ prefix, the same way `overview`
    // and `analytics` above do — the dashboard calls relative `./api/...` and has no
    // absolute workspace path of its own to pass as `?workspace=`.
    //
    // Deliberately an EXACT match on 'inbox', not a prefix: `inbox/:id` (which returns the
    // message BODY) and `inbox/:id/dismiss` (which mutates) do not match, fall through to
    // the 404 below, and so stay off the dashboard surface. That is what keeps this read
    // path inside Spec 1313's redaction rule and decision 8 (dismissal is CLI-only).
    if (req.method === 'GET' && apiPath === 'inbox') {
      return handleInboxList(res, url, workspacePath);
    }

    // POST /api/overview/refresh - Invalidate overview cache (Spec 0126 Phase 4)
    if (req.method === 'POST' && apiPath === 'overview/refresh') {
      return handleOverviewRefresh(res, ctx);
    }

    // GET /api/analytics - Dashboard analytics (Spec 456)
    if (req.method === 'GET' && apiPath === 'analytics') {
      return handleAnalytics(res, url, workspacePath);
    }

    // GET /api/events - SSE push notifications (Bugfix #388)
    if (req.method === 'GET' && apiPath === 'events') {
      return handleSSEEvents(req, res, ctx);
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
    res.end('Overview not available');
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
  // Rehydrate wsTerminals (SQLite sync + shellper reconnect) before reading.
  // Shared with /api/overview so both endpoints always see a freshly-reconciled
  // entry — see getRehydratedTerminalsEntry doc.
  const entry = await getRehydratedTerminalsEntry(workspacePath);
  const manager = getTerminalManager();
  // Spec 761: type as DashboardState directly to prevent inline-literal drift.
  // ArchitectState.name (Spec 761) carries the architect's stable identity.
  const state: DashboardState = {
    architect: null,
    architects: [],
    builders: [],
    utils: [],
    annotations: [],
    workspaceName: path.basename(workspacePath),
    version,
    hostname: (() => { try { return readCloudConfig()?.tower_name; } catch { return undefined; } })(),
    teamEnabled: await hasTeam(path.join(workspacePath, 'codev', 'team')),
  };

  // Spec 761: build the architects collection from entry.architects (skip dead
  // sessions, main-first). Shared with /api/overview via `liveArchitects`
  // (Issue 1104) so both payloads list an identical set.
  // Spec 755: the scalar `state.architect` is preserved as a backward-compat
  // pointer to the same default architect (architects[0] when present).
  const architects = liveArchitects(entry, manager);
  state.architects = architects;
  state.architect = architects[0] ?? null;

  // Add shells from refreshed cache
  for (const [shellId, terminalId] of entry.shells) {
    const session = manager.getSession(terminalId);
    if (session) {
      state.utils.push({
        id: shellId,
        name: session.label,
        port: 0,
        pid: session.pid || 0,
        terminalId,
        persistent: isSessionPersistent(terminalId, session),
        lastDataAt: session.lastDataAt,
      });
    }
  }

  // Spec 786 Phase 4: build a lookup from builder id → spawned_by_architect so
  // the dashboard's remove-architect confirmation modal can show which builders
  // would lose their spawning architect (informational; per OQ-A removal
  // proceeds regardless and they fall back to `main` routing). The data lives
  // in `state.db.builders.spawned_by_architect` but the in-memory cache used by
  // /api/state doesn't carry it — we read it explicitly here. Single query
  // amortised across all builders rather than per-builder lookups.
  const spawnedByMap = new Map<string, string | null>();
  try {
    // Issue #1118: scope to this workspace — handleWorkspaceState builds the
    // modal for one workspace, and builder ids can collide across workspaces.
    for (const b of getBuilders(workspacePath)) {
      spawnedByMap.set(b.id, b.spawnedByArchitect ?? null);
    }
  } catch {
    // DB unavailable — modal degrades to "no in-flight builders" display.
    // Acceptable since the modal text is informational per OQ-A.
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
        // Spec 786 Phase 4: surface spawning architect to the dashboard so the
        // remove-architect modal can show affected builders. May be undefined
        // when the builder row isn't in state.db (e.g. ephemeral test builders).
        spawnedByArchitect: spawnedByMap.get(builderId) ?? null,
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

async function handleWorkspaceTeam(
  res: http.ServerResponse,
  workspacePath: string,
): Promise<void> {
  const teamDir = path.join(workspacePath, 'codev', 'team');

  // Single read — avoids double filesystem traversal from hasTeam() + loadTeamMembers()
  const membersResult = await loadTeamMembers(teamDir);
  if (membersResult.items.length < 2) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ enabled: false }));
    return;
  }

  const messagesResult = await loadMessages(path.join(teamDir, 'messages.md'));

  const { data: githubData, error: githubError } = await fetchTeamGitHubData(
    membersResult.items,
    workspacePath,
  );

  const members = membersResult.items.map((m: TeamMember) => ({
    name: m.name,
    github: m.github,
    role: m.role,
    filePath: m.filePath,
    github_data: githubData.get(m.github) ?? null,
  }));

  const messages = messagesResult.items.map((msg: TeamMessage) => ({
    author: msg.author,
    timestamp: msg.timestamp,
    body: msg.body,
    channel: msg.channel,
  }));

  const warnings = [...membersResult.warnings, ...messagesResult.warnings];

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    enabled: true,
    members,
    messages,
    warnings,
    ...(githubError ? { githubError } : {}),
  }));
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
        // Inject session identity for afx rename (Spec 468)
        shellEnv['SHELLPER_SESSION_ID'] = sessionId;
        shellEnv['TOWER_PORT'] = String(ctx.port);
        const client = await shellperManager.createSession({
          sessionId,
          command: shellCmd,
          args: shellArgs,
          cwd: workspacePath,
          env: shellEnv,
          ...defaultSessionOptions(),
        });

        // Read session info BEFORE awaiting replay: an instantly-exiting
        // child's EXIT frame can remove the session from the manager during
        // the await, and this lookup must not miss (#1198).
        const shellperInfo = shellperManager.getSessionInfo(sessionId)!;
        const replayData = await client.waitForReplay(); // #1198: fresh shellpers always send REPLAY (possibly empty); awaiting avoids racing early child output

        const session = manager.createSessionRaw({
          label: `Shell ${shellId.replace('shell-', '')}`,
          cwd: workspacePath,
          // Spec 1313: thread/persist for reconstruction symmetry with the other
          // createSessionRaw sites. A workspace-root shell resolves to no-profile
          // (its command is a shell, not an agent, and the cwd has no launch script),
          // so `afx send` correctly holds. (A shell whose cwd happened to be a builder
          // worktree would resolve that worktree's harness via the launch-script fallback.)
          command: shellCmd,
          args: shellArgs,
        });
        const ptySession = manager.getSession(session.id);
        if (ptySession) {
          ptySession.attachShellper(client, replayData, shellperInfo.pid, sessionId);
        }

        const entry = getWorkspaceTerminalsEntry(workspacePath);
        entry.shells.set(shellId, session.id);
        // PIR #1475: hydrated identity wins; a fresh spawn reports back `shellCmd`.
        logSessionIdentity(ctx.log, 'shell-create', session.id, ptySession, shellCmd);
        saveTerminalSession(session.id, workspacePath, 'shell', shellId, shellperInfo.pid,
          shellperInfo.socketPath, shellperInfo.pid, shellperInfo.startTime, session.label, workspacePath,
          persistableCommand(ptySession) ?? shellCmd);

        shellCreated = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: shellId,
          port: 0,
          name: session.label,
          terminalId: session.id,
          persistent: true,
        }));
      } catch (shellperErr) {
        ctx.log('WARN', `Shellper creation failed for shell, falling back: ${(shellperErr as Error).message}`);
      }
    }

    // Fallback: non-persistent session (graceful degradation per plan)
    // Shellper is the only persistence backend for new sessions.
    // Note: SHELLPER_SESSION_ID is not set for non-persistent sessions since
    // they don't survive Tower restarts and rename wouldn't persist.
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
      saveTerminalSession(session.id, workspacePath, 'shell', shellId, session.pid, null, null, null, session.label, workspacePath, shellCmd);
      ctx.log('WARN', `Shell ${shellId} for ${workspacePath} is non-persistent (shellper unavailable)`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: shellId,
        port: 0,
        name: session.label,
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
    const body = await parseJsonBody(req);
    const filePath = body.path as string | undefined;
    const line = body.line;
    const terminalId = body.terminalId as string | undefined;

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

    // Resolve symlinks for canonical path (but allow files outside workspace — see issue #502)
    try {
      fullPath = fs.realpathSync(fullPath);
    } catch {
      try {
        fullPath = path.join(fs.realpathSync(path.dirname(fullPath)), path.basename(fullPath));
      } catch {
        fullPath = path.resolve(fullPath);
      }
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
    const { content } = await parseJsonBody(req);

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
    // Bugfix #474: Always attempt DB deletion even if not in memory (stale tab recovery)
    entry.fileTabs.delete(tabId);
    deleteFileTab(tabId);
    ctx.log('INFO', `Deleted file tab: ${tabId}`);
    res.writeHead(204);
    res.end();
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
    // Spec 755: tabId 'architect' targets the architect surfaced by /api/state
    // — prefer 'main', else the first registered.
    const name = entry.architects.has('main')
      ? 'main'
      : entry.architects.keys().next().value;
    if (name) {
      terminalId = entry.architects.get(name);
      entry.architects.delete(name);
    }
  } else if (tabId.startsWith('architect:')) {
    // Spec 786 Phase 4 / PR iter-1 review fix: sibling architect tabs (Spec
    // 761 ids `architect:<name>`) are closable from the mobile TabBar, which
    // dispatches `DELETE /api/tabs/<tabId>`. Route the sibling close through
    // `removeArchitect()` so the full lifecycle (kills PTY, deletes state.db
    // row, suppresses cascaded delete via intentional-stop flag) runs the
    // same way as the desktop close button + CLI.
    const name = tabId.slice('architect:'.length);
    const result = await removeArchitect(workspacePath, name);
    if (result.success) {
      // Spec 823 Phase 4 (iter-1 Codex): emit architects-updated so the
      // VSCode tree refreshes when the remove originates from the mobile
      // TabBar close (which doesn't trigger the dashboard's add/remove
      // SSE event from within VSCode).
      ctx.broadcastNotification({
        type: 'architects-updated',
        title: 'Architects updated',
        body: JSON.stringify({ workspace: workspacePath }),
        workspace: workspacePath,
      });
      res.writeHead(204);
      res.end();
    } else {
      const status = result.error?.includes('not found') || result.error?.includes('not running') ? 404 : 400;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: result.error }));
    }
    return;
  }

  if (terminalId) {
    // Issue #1261: this path discards the kill result and answers 204 either
    // way, so a not-yet-wired Tower would report a successful close for a
    // terminal it never touched. Refuse instead.
    if (!instancesReady()) {
      respondStartingUp(res);
      return;
    }
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

  // Spec 786 PR iter-2 race-fix (Codex): explicitly delete every architect's
  // `state.db.architect` row BEFORE killing or clearing the registry. The
  // cascaded architect exit handlers in tower-instances.ts (lines 452-...,
  // 501-..., etc.) and tower-terminals.ts work by scanning
  // `currentEntry.architects` to recover the architect name from a dead
  // terminal id. But stop-all clears that registry synchronously after the
  // kills, before node-pty's async 'exit' events fire — so by the time the
  // exit handlers look up the name, it's already gone, and they silently
  // skip the row deletion. Result: stale `state.db.architect` rows survive
  // what's supposed to be a full wipe, and `launchInstance` reconciliation
  // re-spawns them on the next workspace start.
  //
  // The intentional-stop flag isn't the right tool here either — stop-all
  // explicitly wants the rows gone. Pre-emptive deletion makes it
  // explicit and order-independent: even if the exit handler somehow runs
  // first, `setArchitectByName(name, null)` is idempotent.
  for (const name of entry.architects.keys()) {
    try {
      // Bugfix #826: scoped by workspace_path.
      setArchitectByName(workspacePath, name, null);
    } catch { /* best-effort cleanup */ }
  }

  // Kill all terminals (disable shellper auto-restart if applicable).
  // Spec 755: iterate all named architects, not just the singleton.
  for (const terminalId of entry.architects.values()) {
    await killTerminalWithShellper(manager, terminalId);
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

  // Bugfix #474: Delete all file tabs for this workspace
  deleteFileTabsForWorkspace(workspacePath);

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
  const isHtml = ['html', 'htm'].includes(ext);

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

      // The shell carries the injected key (advisory GHSA-xvjp-7748-v88v), so a
      // maliciously-named file must not become XSS (which would read the key).
      // HTML-escape values that land in markup/attributes (safe in the JS string
      // contexts too — it blocks `<`, `"`, `'`), and for the JSON-in-<script>
      // value escape `<` so a filename containing `</script>` can't break out.
      const safeFileName = escapeHtml(fileName);
      const safeFilePath = escapeHtml(filePath);
      const filePathJson = JSON.stringify(filePath).replace(/</g, '\\u003c');
      if (is3D) {
        html = html.replace(/\{\{FILE\}\}/g, safeFileName);
        html = html.replace(/\{\{FILE_PATH_JSON\}\}/g, filePathJson);
        html = html.replace(/\{\{FORMAT\}\}/g, escapeHtml(ext));
      } else {
        html = html.replace(/\{\{FILE\}\}/g, safeFileName);
        html = html.replace(/\{\{FILE_PATH\}\}/g, safeFilePath);
        html = html.replace(/\{\{BUILDER_ID\}\}/g, '');
        html = html.replace(/\{\{LANG\}\}/g, escapeHtml(getLanguageForExt(ext)));
        html = html.replace(/\{\{IS_MARKDOWN\}\}/g, String(isMarkdown));
        html = html.replace(/\{\{IS_IMAGE\}\}/g, String(isImage));
        html = html.replace(/\{\{IS_VIDEO\}\}/g, String(isVideo));
        html = html.replace(/\{\{IS_PDF\}\}/g, String(isPdf));
        html = html.replace(/\{\{IS_HTML\}\}/g, String(isHtml));
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
          initScript = `fetch('file',{headers:authHeaders()}).then(r=>r.text()).then(init);`;
        }
        html = html.replace('// FILE_CONTENT will be injected by the server', initScript);
      }

      // Handle ?line= query param for scroll-to-line. Validate as a bare integer
      // before interpolating into the script — untrusted query input must never
      // reach the key-bearing shell's markup unescaped.
      const lineParam = url.searchParams.get('line');
      if (lineParam && /^\d+$/.test(lineParam)) {
        const scrollScript = `<script>window.addEventListener('load',()=>{setTimeout(()=>{const el=document.querySelector('[data-line="${lineParam}"]');if(el){el.scrollIntoView({block:'center'});el.classList.add('highlighted-line');}},200);})</script>`;
        html = html.replace('</body>', `${scrollScript}</body>`);
      }

      // Same-origin key injection so the annotator's fetches can authenticate
      // (advisory GHSA-xvjp-7748-v88v). The shell is public (iframe navigation);
      // its data/media sub-routes stay keyed.
      sendKeyInjectedHtml(res, html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Failed to serve annotator: ${(err as Error).message}`);
    }
    return;
  }
}

// ============================================================================
// Cron route handlers (Spec 399)
// ============================================================================

function handleCronList(res: http.ServerResponse, url: URL): void {
  const workspaceFilter = url.searchParams.get('workspace') || undefined;

  const tasks = getAllTasks();
  const filtered = workspaceFilter
    ? tasks.filter(t => t.workspacePath === workspaceFilter)
    : tasks;

  // Merge with SQLite state
  const db = getGlobalDb();
  const result = filtered.map(task => {
    const taskId = getTaskId(task.workspacePath, task.name);
    const row = db.prepare(
      'SELECT last_run, last_result, enabled FROM cron_tasks WHERE id = ?',
    ).get(taskId) as { last_run: number | null; last_result: string | null; enabled: number } | undefined;

    return {
      name: task.name,
      schedule: task.schedule,
      enabled: row ? row.enabled === 1 : task.enabled,
      last_run: row?.last_run ?? null,
      last_result: row?.last_result ?? null,
      workspacePath: task.workspacePath,
    };
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
}

async function handleCronTaskAction(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  match: RegExpMatchArray,
): Promise<void> {
  const taskName = decodeURIComponent(match[1]);
  const action = match[2]; // status | run | enable | disable
  const workspace = url.searchParams.get('workspace') || undefined;

  // Find the task across workspaces
  const allTasks = getAllTasks();
  const matchingTasks = allTasks.filter(t => {
    if (t.name !== taskName) return false;
    if (workspace && t.workspacePath !== workspace) return false;
    return true;
  });

  if (matchingTasks.length === 0) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'NOT_FOUND', message: `Cron task '${taskName}' not found` }));
    return;
  }

  if (matchingTasks.length > 1 && !workspace) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'AMBIGUOUS',
      message: `Multiple tasks named '${taskName}' found. Specify ?workspace= to disambiguate.`,
      workspaces: matchingTasks.map(t => t.workspacePath),
    }));
    return;
  }

  const task = matchingTasks[0];

  switch (action) {
    case 'status':
      return handleCronTaskStatus(res, task);
    case 'run':
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }
      return await handleCronRun(res, task);
    case 'enable':
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }
      return handleCronEnable(res, task);
    case 'disable':
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }
      return handleCronDisable(res, task);
    default:
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'NOT_FOUND' }));
  }
}

function handleCronTaskStatus(res: http.ServerResponse, task: CronTask): void {
  const taskId = getTaskId(task.workspacePath, task.name);
  const db = getGlobalDb();
  const row = db.prepare(
    'SELECT last_run, last_result, last_output, enabled FROM cron_tasks WHERE id = ?',
  ).get(taskId) as {
    last_run: number | null;
    last_result: string | null;
    last_output: string | null;
    enabled: number;
  } | undefined;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    name: task.name,
    schedule: task.schedule,
    command: task.command,
    enabled: row ? row.enabled === 1 : task.enabled,
    last_run: row?.last_run ?? null,
    last_result: row?.last_result ?? null,
    last_output: row?.last_output ?? null,
    workspacePath: task.workspacePath,
    target: task.target,
    timeout: task.timeout,
  }));
}

async function handleCronRun(res: http.ServerResponse, task: CronTask): Promise<void> {
  try {
    const { result, output } = await executeTask(task);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result, output }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'EXECUTION_FAILED', message: (err as Error).message }));
  }
}

function handleCronEnable(res: http.ServerResponse, task: CronTask): void {
  const taskId = getTaskId(task.workspacePath, task.name);
  const db = getGlobalDb();
  db.prepare(`
    INSERT INTO cron_tasks (id, workspace_path, task_name, enabled)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET enabled = 1
  `).run(taskId, task.workspacePath, task.name);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, name: task.name, enabled: true }));
}

function handleCronDisable(res: http.ServerResponse, task: CronTask): void {
  const taskId = getTaskId(task.workspacePath, task.name);
  const db = getGlobalDb();
  db.prepare(`
    INSERT INTO cron_tasks (id, workspace_path, task_name, enabled)
    VALUES (?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET enabled = 0
  `).run(taskId, task.workspacePath, task.name);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, name: task.name, enabled: false }));
}
