/**
 * Cloud tunnel management for tower server.
 * Spec 0105: Tower Server Decomposition — Phase 2
 *
 * Contains: tunnel client lifecycle, config file watching,
 * metadata refresh, and tunnel API endpoint handling.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logSafe } from '../utils/log-safe.js';
import http from 'node:http';
import os from 'node:os';
import {
  TunnelClient,
  TUNNEL_PROXY_HEADER,
  AUTH_RETRY_FAILED_MARKER,
  type TunnelState,
  type TunnelIdentity,
  type TunnelPeerOptions,
  type TunnelPeerSession,
  type TowerMetadata,
} from '../lib/tunnel-client.js';
import type { PeerSwitchState } from '@cluesmith/codev-types';
import { getGlobalDb } from '../db/index.js';
import { readSwitch } from '../peer/switch.js';
import { createReceiver } from '../peer/receiver.js';
import { recordEntryEvent } from '../peer/records.js';
import { onTunnelAuthOk, setTunnelSessionSource, shutdownPeerCloud, startPeerOutbox } from '../peer/cloud-wiring.js';
import { loadConfig, resolvePeerSettings } from '../../lib/config.js';
import { liveGrantWorld, resolveRemoteRecipient } from './tower-messages.js';
import { discoverableWorkspaces } from './tower-address-book.js';
import { deliverRemoteWithin, notifyHeldStateChanged } from './mailbox-wiring.js';
import {
  readCloudConfig,
  writeCloudConfig,
  updateCloudConfig,
  deleteCloudConfig,
  getCloudConfigPath,
  getOrCreateMachineId,
  maskApiKey,
  DEFAULT_CLOUD_URL,
  type CloudConfig,
} from '../lib/cloud-config.js';
import { createPendingRegistration, consumePendingRegistration } from '../lib/nonce-store.js';
import { redeemToken } from '../lib/token-exchange.js';
import { validateDeviceName } from '../lib/device-name.js';
import type { WorkspaceTerminals, InstanceStatus } from './tower-types.js';
import type { TerminalManager } from '../../terminal/pty-manager.js';
import { escapeHtml, readBody } from '../utils/server-utils.js';
import { cloudMutationBlocked } from '../../lib/test-env.js';
import type { WorkspaceKeyedMap } from './tower-terminals.js';

/** Minimal dependencies required by the tunnel module */
export interface TunnelDeps {
  port: number;
  log: (level: 'INFO' | 'ERROR' | 'WARN', message: string) => void;
  workspaceTerminals: WorkspaceKeyedMap<WorkspaceTerminals>;
  terminalManager: TerminalManager | null;
}

// ============================================================================
// Module-private state (lifecycle driven by orchestrator)
// ============================================================================

let tunnelClient: TunnelClient | null = null;
/** The registration `tunnelClient` was built from; meaningful only while it is set. */
let tunnelRegistration: CloudConfig | null = null;
let configWatcher: fs.FSWatcher | null = null;
let configWatchDebounce: ReturnType<typeof setTimeout> | null = null;
let metadataRefreshInterval: ReturnType<typeof setInterval> | null = null;

const METADATA_REFRESH_MS = 30_000;
const DEFAULT_SERVER_URL = DEFAULT_CLOUD_URL;

/** Stored references set by initTunnel() */
let _deps: TunnelDeps | null = null;
let _getInstances: (() => Promise<InstanceStatus[]>) | null = null;

// ============================================================================
// Internal functions
// ============================================================================

/**
 * Gather current tower metadata (workspaces + terminals) for codevos.ai.
 */
async function gatherMetadata(): Promise<TowerMetadata> {
  if (!_deps || !_getInstances) throw new Error('Tunnel not initialized');

  const instances = await _getInstances();
  const workspaces = instances.map((i) => ({
    path: i.workspacePath,
    name: i.workspaceName,
  }));

  // Build reverse mapping: terminal ID → workspace path
  const terminalToWorkspace = new Map<string, string>();
  for (const [workspacePath, entry] of _deps.workspaceTerminals) {
    // Spec 755: iterate all named architects, not just a singleton.
    for (const termId of entry.architects.values()) terminalToWorkspace.set(termId, workspacePath);
    for (const termId of entry.builders.values()) terminalToWorkspace.set(termId, workspacePath);
    for (const termId of entry.shells.values()) terminalToWorkspace.set(termId, workspacePath);
  }

  const manager = _deps.terminalManager;
  const terminals: TowerMetadata['terminals'] = [];
  if (manager) {
    for (const session of manager.listSessions()) {
      terminals.push({
        id: session.id,
        workspacePath: terminalToWorkspace.get(session.id) ?? '',
      });
    }
  }

  return { workspaces, terminals };
}

/**
 * Start periodic metadata refresh: re-gathers metadata every METADATA_REFRESH_MS while
 * the tunnel is connected, into the cache `GET /__tower/metadata` serves (nothing is
 * pushed to the cloud since #1986).
 */
function startMetadataRefresh(): void {
  stopMetadataRefresh();
  metadataRefreshInterval = setInterval(async () => {
    try {
      if (tunnelClient && tunnelClient.getState() === 'connected') {
        const metadata = await gatherMetadata();
        tunnelClient.sendMetadata(metadata);
      }
    } catch (err) {
      _deps?.log('WARN', `Metadata refresh failed: ${(err as Error).message}`);
    }
  }, METADATA_REFRESH_MS);
}

/**
 * Stop the periodic metadata refresh.
 */
function stopMetadataRefresh(): void {
  if (metadataRefreshInterval) {
    clearInterval(metadataRefreshInterval);
    metadataRefreshInterval = null;
  }
}

/** Whether the last read of the switch for `auth` failed, so its ERROR is logged once per failing run. */
let switchReadFailing = false;

/** A database error as a log line may name it: its class, and its code when it has the shape of one. */
function describeDbError(err: unknown): string {
  if (!(err instanceof Error)) return typeof err;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? `${err.constructor.name} ${code}` : err.constructor.name;
}

/**
 * The switch as `auth` states it. A read that fails fails the connect attempt, and the
 * back-off retries it: Tower states only what it knows, with no fallback (architect ruling,
 * 2026-11-27). The failure is loud: an ERROR line naming the cause the first time in a
 * failing run, and the tunnel's last failure, which `afx tower status` shows while the
 * connection is down.
 */
function readSwitchForAuth(): PeerSwitchState {
  try {
    const state = readSwitch(getGlobalDb()).state;
    switchReadFailing = false;
    return state;
  } catch (err) {
    const cause = `global.db could not be read (${describeDbError(err)})`;
    if (!switchReadFailing) {
      _deps?.log('ERROR', `Cloud connection not made: the remote-messaging switch is unreadable: ${cause}. Retrying on back-off.`);
    }
    switchReadFailing = true;
    throw new Error(cause);
  }
}

/**
 * The tunnel's peer entry point, as this Tower supplies it (Spec 1967). The switch is read
 * from the database for every `auth`, so a reconnect states it as it stands. A verified
 * request goes to the receiver (steps 9 to 16), which stores mail in the mailbox and makes
 * one gate attempt, or answers a discovery query from the grants; every request at the
 * entry point is written to the inbound record,
 * which is also what the clock surface reads.
 */
const PEER_OPTIONS: TunnelPeerOptions = {
  remoteMessaging: readSwitchForAuth,
  onVerifiedRequest: createReceiver({
    db: getGlobalDb,
    now: Date.now,
    world: liveGrantWorld,
    // Tower-global, from the user-global layer, as the mailbox settings are read.
    limits: () => resolvePeerSettings(loadConfig(os.homedir())).limits,
    resolveRecipient: resolveRemoteRecipient,
    discoverable: discoverableWorkspaces,
    deliverWithin: (workspacePath, toAgent, ms) => deliverRemoteWithin(logToTower, workspacePath, toAgent, ms),
    onHeldChanged: notifyHeldStateChanged,
    log: logToTower,
  }),
  onEntryEvent: (event) => recordEntryEvent(getGlobalDb(), event),
};

/** The Tower log, once the orchestrator has wired it. */
function logToTower(level: 'INFO' | 'ERROR' | 'WARN', message: string): void {
  _deps?.log(level, message);
}

/** What each `auth_ok` let this Tower take of the cloud's relay, for the log. Never the secret. */
function logRelay(config: CloudConfig, identity: TunnelIdentity): void {
  switch (identity.relay) {
    case 'available':
      _deps?.log('INFO', 'Codev Cloud relay available: remote messaging can reach this Tower');
      return;
    case 'absent':
    case 'null':
      _deps?.log('INFO', 'This Codev Cloud has no relay: remote messaging is unavailable');
      return;
    case 'insecure':
      _deps?.log('WARN', `Codev Cloud offered a relay over a tunnel without TLS (${logSafe(config.server_url)}); its session secret was refused and remote messaging is unavailable. Use an https: server URL.`);
      return;
    case 'malformed':
    case 'unsupported':
      _deps?.log('WARN', `Codev Cloud's relay was ${identity.relay === 'malformed' ? 'not in the expected form' : 'for no protocol version this Tower speaks'}; remote messaging is unavailable`);
      return;
    case 'not-stated':
      return;
  }
}

/**
 * Create or reconnect the tunnel client using the given config.
 * Sets up state change listeners and sends initial metadata.
 */
async function connectTunnel(config: CloudConfig): Promise<TunnelClient> {
  if (!_deps) throw new Error('Tunnel not initialized');

  // Disconnect existing client if any
  if (tunnelClient) {
    tunnelClient.disconnect();
  }

  // The switch as this client's last `auth` stated it, for the `auth_ok` that answers it.
  let statedSwitch: PeerSwitchState | null = null;
  const client = new TunnelClient({
    serverUrl: config.server_url,
    apiKey: config.api_key,
    towerId: config.tower_id,
    localPort: _deps.port,
    peer: {
      ...PEER_OPTIONS,
      remoteMessaging: () => {
        statedSwitch = readSwitchForAuth();
        return statedSwitch;
      },
    },
  });

  client.onStateChange((state: TunnelState, prev: TunnelState, reason?: string) => {
    // #1372: always log *why* — a bare `prev → state` line made the uplink-flap
    // wedge undiagnosable from the tower log.
    _deps!.log('INFO', `Tunnel: ${prev} → ${state}${reason ? ` (${reason})` : ''}`);
    if (state === 'connected') {
      startMetadataRefresh();
    } else if (prev === 'connected') {
      stopMetadataRefresh();
    }
    // Only the first park raises the alarm — the breaker half-opens every 15
    // minutes (#1372), and a revoked key would otherwise log ERROR forever.
    if (state === 'auth_failed' && !reason?.includes(AUTH_RETRY_FAILED_MARKER)) {
      _deps!.log('ERROR', 'Cloud connection failed: API key is invalid or revoked. Run \'afx tower connect --reauth\' to update credentials.');
    }
    if (state === 'deregistered') {
      markDeregistered(config);
    }
  });

  client.onAuthOk((identity) => {
    adoptCloudIdentity(config, identity);
    logRelay(config, identity);
    // The peer list learns what this session stated of a relay; a switch change made while
    // the `auth` was in flight is reported now (Spec 1967, contract sections 1 and 2).
    try {
      onTunnelAuthOk(identity.relay, statedSwitch, { serverUrl: config.server_url, towerId: config.tower_id });
    } catch (err) {
      _deps?.log('ERROR', `Peer: could not take in the connection's relay state: ${(err as Error).message}`);
    }
  });

  // Gather and set initial metadata before connecting
  const metadata = await gatherMetadata();
  client.sendMetadata(metadata);

  tunnelClient = client;
  tunnelRegistration = config;
  client.connect();

  // Ensure config watcher is running — the config directory now exists.
  startConfigWatcher();

  return client;
}

/**
 * Follow the cloud's identity for this tower (Issue #1871): a rename in the
 * cloud UI changes the slug, and Tower learns it from `auth_ok` on the next
 * reconnect. A cloud that predates codev-cloud#17 sends no slug, and the stored
 * identity stands.
 */
function adoptCloudIdentity(config: CloudConfig, identity: TunnelIdentity): void {
  if (!identity.slug) return;
  const current = readCloudConfig();
  if (!current) return;
  const name = identity.name ?? current.display_name;
  if (current.tower_name === identity.slug && current.display_name === name) return;
  if (updateCloudConfig(config.api_key, { tower_name: identity.slug, display_name: name })) {
    _deps?.log('INFO', `Codev Cloud identity changed: slug "${current.tower_name}" → "${identity.slug}"${name ? ` (name "${name}")` : ''}`);
  }
}

/**
 * The cloud rejected a key this tunnel had connected with (Issue #1871).
 * Stamp the registration deregistered rather than deleting it — the user may
 * want to inspect the credentials — and say how to recover.
 */
function markDeregistered(config: CloudConfig): void {
  const marked = updateCloudConfig(config.api_key, { deregistered_at: new Date().toISOString() });
  if (!marked) {
    _deps?.log('WARN', 'Tunnel key rejected after a successful connection, but cloud-config.json now holds a different registration; leaving it in place.');
    return;
  }
  _deps?.log('ERROR', `Tower "${config.tower_name}" was deregistered from Codev Cloud (deleted there, or its key replaced by a newer registration). Tunnel stopped; credentials kept in ${getCloudConfigPath()}. Run 'afx tower connect' to register again.`);
}

function sameCredentials(a: CloudConfig, b: CloudConfig): boolean {
  return a.api_key === b.api_key && a.tower_id === b.tower_id && a.server_url === b.server_url;
}

/**
 * Start watching cloud-config.json for changes.
 * On change: reconnect with new credentials.
 * On delete: disconnect tunnel.
 */
function startConfigWatcher(): void {
  stopConfigWatcher();

  const configPath = getCloudConfigPath();
  const configDir = path.dirname(configPath);
  const configFile = path.basename(configPath);

  // Watch the directory (more reliable than watching the file directly)
  try {
    configWatcher = fs.watch(configDir, (eventType, filename) => {
      if (filename !== configFile) return;

      // Debounce: multiple events fire for a single write
      if (configWatchDebounce) clearTimeout(configWatchDebounce);
      configWatchDebounce = setTimeout(async () => {
        configWatchDebounce = null;
        try {
          const config = readCloudConfig();
          if (config?.deregistered_at) {
            _deps?.log('INFO', 'Cloud config marks this tower deregistered, tunnel stays down');
            if (tunnelClient) {
              tunnelClient.disconnect();
              tunnelClient = null;
            }
          } else if (config) {
            // Skip if already connected with this registration (avoids redundant
            // reconnect when the OAuth callback writes config and connects directly —
            // the file watcher fires 500ms later and would kill the working
            // connection). An identity-only change (#1871) is skipped too, but new
            // credentials must replace the client, or it keeps the old key until the
            // cloud rejects it.
            if (
              tunnelClient &&
              tunnelClient.getState() === 'connected' &&
              tunnelRegistration !== null &&
              sameCredentials(tunnelRegistration, config)
            ) {
              _deps?.log('INFO', 'Cloud config changed but tunnel already connected, skipping reconnect');
              return;
            }
            _deps?.log('INFO', `Cloud config changed, reconnecting tunnel (key: ${maskApiKey(config.api_key)})`);
            // Reset circuit breaker in case previous key was invalid
            if (tunnelClient) tunnelClient.resetCircuitBreaker();
            await connectTunnel(config);
          } else {
            // Config deleted or invalid
            _deps?.log('INFO', 'Cloud config removed or invalid, disconnecting tunnel');
            if (tunnelClient) {
              tunnelClient.disconnect();
              tunnelClient = null;
            }
          }
        } catch (err) {
          _deps?.log('WARN', `Error handling config change: ${(err as Error).message}`);
        }
      }, 500);
    });
  } catch {
    // Directory doesn't exist yet — that's fine, user hasn't registered
  }
}

/**
 * Stop watching cloud-config.json.
 */
function stopConfigWatcher(): void {
  if (configWatcher) {
    configWatcher.close();
    configWatcher = null;
  }
  if (configWatchDebounce) {
    clearTimeout(configWatchDebounce);
    configWatchDebounce = null;
  }
}

// ============================================================================
// Public API (called by orchestrator)
// ============================================================================

/**
 * Initialize the tunnel module. Reads cloud config and connects if registered.
 * Starts config file watcher for credential changes.
 */
export async function initTunnel(
  deps: TunnelDeps,
  callbacks: { getInstances: () => Promise<InstanceStatus[]> },
): Promise<void> {
  _deps = deps;
  _getInstances = callbacks.getInstances;
  switchReadFailing = false;
  setTunnelSessionSource(getTunnelPeerSession, logToTower);
  // Mail this Tower holds for its peers resumes from its rows, whether or not it is
  // registered now: until it can leave, the outbox only looks at it again (Spec 1967).
  try {
    startPeerOutbox(notifyHeldStateChanged);
  } catch (err) {
    deps.log('ERROR', `Peer: mail held for other Towers could not be resumed at start (${(err as Error).message})`);
  }

  // Auto-connect tunnel if registered
  try {
    const config = readCloudConfig();
    if (config?.deregistered_at) {
      deps.log('WARN', `Tower "${config.tower_name}" was deregistered from Codev Cloud at ${config.deregistered_at}; not connecting. Run 'afx tower connect' to register again.`);
    } else if (config) {
      deps.log('INFO', `Cloud config found, connecting tunnel (tower: ${config.tower_name}, key: ${maskApiKey(config.api_key)})`);
      await connectTunnel(config);
    } else {
      deps.log('INFO', 'No cloud config found, operating in local-only mode');
    }
  } catch (err) {
    deps.log('WARN', `Failed to read cloud config: ${(err as Error).message}. Operating in local-only mode.`);
  }

  // Start watching cloud-config.json for changes
  startConfigWatcher();
}

/**
 * The connected tunnel session's identity and relay (Spec 1967): this Tower's own name
 * while connected, and whether the cloud's relay can reach it. `null` while not connected.
 * Never the session secret, which stays inside the tunnel client.
 */
export function getTunnelPeerSession(): TunnelPeerSession | null {
  return tunnelClient?.getPeerSession() ?? null;
}

/**
 * Shut down the tunnel module. Disconnects client, stops watchers.
 */
export function shutdownTunnel(): void {
  stopMetadataRefresh();
  stopConfigWatcher();
  shutdownPeerCloud();
  if (tunnelClient) {
    _deps?.log('INFO', 'Disconnecting tunnel...');
    tunnelClient.disconnect();
    tunnelClient = null;
  }
  _deps = null;
  _getInstances = null;
}



/** Where a tunnel management request came from — see describeSource(). */
interface RequestSource {
  /** True when the request was proxied in from codevos.ai rather than issued locally. */
  viaTunnel: boolean;
  /** Pre-formatted `key=value` attribution suffix for the log line. */
  text: string;
}

/**
 * Describe the origin of a tunnel management request (#1370).
 *
 * `POST /api/tunnel/disconnect` deregisters the tower server-side and deletes
 * the local credentials, so an unattributed one is impossible to investigate
 * after the fact. Every call now logs its remote address, user-agent and
 * origin, plus whether it arrived through the tunnel proxy.
 */
function describeSource(req: http.IncomingMessage): RequestSource {
  const viaTunnel = req.headers[TUNNEL_PROXY_HEADER] !== undefined;
  const remote = req.socket?.remoteAddress ?? 'unknown';
  const ua = logSafe(req.headers['user-agent']) || 'none';
  const origin = logSafe(req.headers.origin ?? req.headers.referer);
  return {
    viaTunnel,
    text:
      `remote=${logSafe(remote, 64)} via=${viaTunnel ? 'tunnel' : 'local'} ua="${ua}"` +
      (origin ? ` origin=${origin}` : ''),
  };
}

/**
 * Reject a management request that arrived through the tunnel.
 *
 * TunnelClient already blocks `/api/tunnel/*` on the proxy side; this is the
 * second, independent layer — a cloud-side actor must never be able to
 * deregister the tower through the tower's own tunnel.
 */
function rejectIfProxied(
  res: http.ServerResponse,
  source: RequestSource,
  action: string,
): boolean {
  if (!source.viaTunnel) return false;
  _deps?.log('WARN', `Tunnel ${action} REJECTED — arrived via tunnel proxy (${source.text})`);
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      success: false,
      error: 'Forbidden: tunnel management endpoints are local-only',
    }),
  );
  return true;
}

function htmlPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:60px auto;text-align:center}
h1{font-size:1.4em}a{color:#0066cc}</style></head>
<body><h1>${title}</h1>${body}</body></html>`;
}

/**
 * Handle tunnel management endpoints (Spec 0097 Phase 4, Spec 0107 Phase 2).
 * Dispatches /api/tunnel/{connect,connect/callback,disconnect,status} requests.
 */
export async function handleTunnelEndpoint(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  tunnelSub: string,
): Promise<void> {
  // GET connect/callback — OAuth callback (MUST be checked BEFORE 'connect')
  if (req.method === 'GET' && tunnelSub === 'connect/callback') {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    const nonce = url.searchParams.get('nonce');

    if (!token || !nonce) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(htmlPage('Registration Failed', '<p>Missing token or nonce parameter.</p><p><a href="/">Back to Tower</a></p>'));
      return;
    }

    const pending = consumePendingRegistration(nonce);
    if (!pending) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(htmlPage('Registration Failed', '<p>Invalid or expired registration link. Please try again from the Tower UI.</p><p><a href="/">Back to Tower</a></p>'));
      return;
    }

    try {
      const machineId = getOrCreateMachineId();
      _deps?.log('INFO', `OAuth callback: redeeming token for tower "${pending.name}" (key: ${maskApiKey(token)})`);
      const { towerId, apiKey, slug, name } = await redeemToken(pending.serverUrl, token, pending.name, machineId);

      // Persist the cloud's slug, not the requested name: every public URL
      // Tower builds derives from tower_name (Issue #1871).
      writeCloudConfig({
        tower_id: towerId,
        tower_name: slug,
        display_name: name,
        api_key: apiKey,
        server_url: pending.serverUrl,
      });

      const renamed = slug !== pending.name;
      _deps?.log('INFO', `Registration complete: tower="${slug}"${renamed ? ` (requested "${pending.name}")` : ''} id=${towerId} key=${maskApiKey(apiKey)}`);

      // Connect tunnel with new credentials
      const config = readCloudConfig();
      if (config) {
        await connectTunnel(config);
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(htmlPage('Connected to Codev Cloud',
        `<p>Tower "<strong>${escapeHtml(slug)}</strong>" is now connected.</p>` +
        (renamed
          ? `<p>Registered as <strong>${escapeHtml(slug)}</strong>: <strong>${escapeHtml(pending.name)}</strong> was taken or is not a valid tower name.</p>`
          : '') +
        '<p>Redirecting to Tower homepage...</p>' +
        '<meta http-equiv="refresh" content="3;url=/">' +
        '<p><a href="/">Back to Tower</a></p>'));
    } catch (err) {
      _deps?.log('ERROR', `OAuth callback failed: ${(err as Error).message}`);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(htmlPage('Registration Failed',
        `<p>${escapeHtml((err as Error).message)}</p><p><a href="/">Back to Tower</a></p>`));
    }
    return;
  }

  // POST connect — OAuth initiation or smart reconnect
  if (req.method === 'POST' && tunnelSub === 'connect') {
    const source = describeSource(req);
    if (rejectIfProxied(res, source, 'connect')) return;
    _deps?.log('INFO', `Tunnel connect requested (${source.text})`);

    if (!_deps) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Tower is still starting up. Try again shortly.' }));
      return;
    }

    try {
      const rawBody = await readBody(req);
      let body: Record<string, unknown> | null = null;
      if (rawBody.trim()) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid JSON in request body.' }));
          return;
        }
      }

      // OAuth initiation: body contains { name, serverUrl?, origin? }
      if (body && 'name' in body) {
        const name = String(body.name);
        const serverUrl = String(body.serverUrl || DEFAULT_SERVER_URL);
        const origin = String(body.origin || `http://localhost:${_deps.port}`);

        // Validate device name
        const nameResult = validateDeviceName(name);
        if (!nameResult.valid) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: nameResult.error }));
          return;
        }

        // Validate origin is a well-formed URL
        try {
          new URL(origin);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid origin URL.' }));
          return;
        }

        // Validate serverUrl is HTTPS (or HTTP on localhost for development)
        try {
          const parsed = new URL(serverUrl);
          const isLocalhost = parsed.hostname === 'localhost' && parsed.protocol === 'http:';
          if (parsed.protocol !== 'https:' && !isLocalhost) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Server URL must use HTTPS.' }));
            return;
          }
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid server URL.' }));
          return;
        }

        const nonce = createPendingRegistration(name, serverUrl);
        const callbackUrl = `${origin}/api/tunnel/connect/callback?nonce=${nonce}`;
        const authUrl = `${serverUrl}/towers/register?callback=${encodeURIComponent(callbackUrl)}`;

        _deps.log('INFO', `OAuth initiation: tower="${name}" server=${serverUrl}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authUrl }));
        return;
      }

      // Smart reconnect: no body or empty body — reconnect using existing config
      const config = readCloudConfig();
      if (!config) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: "Not registered. Run 'afx tower connect' or use the Connect button in the Tower UI." }));
        return;
      }
      if (config.deregistered_at) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: "This tower was deregistered from Codev Cloud. Run 'afx tower connect' or use the Connect button in the Tower UI to register it again." }));
        return;
      }
      if (tunnelClient) tunnelClient.resetCircuitBreaker();
      const client = await connectTunnel(config);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, state: client.getState() }));
    } catch (err) {
      _deps?.log('ERROR', `Tunnel connect failed: ${(err as Error).message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: (err as Error).message }));
    }
    return;
  }

  // POST disconnect — deregister server-side + delete local config
  if (req.method === 'POST' && tunnelSub === 'disconnect') {
    const source = describeSource(req);
    if (rejectIfProxied(res, source, 'disconnect')) return;
    // Deregisters server-side and deletes local credentials — always attributable.
    _deps?.log('INFO', `Tunnel disconnect requested (${source.text})`);

    // #1515: defence in depth. A Tower spawned by the test helpers should never
    // see real cloud credentials (its agent-farm dir is isolated), but if one
    // ever does again, refuse loudly rather than deregister a human's Tower.
    if (cloudMutationBlocked()) {
      const error =
        'Refusing to disconnect: this Tower is running under a test runner ' +
        '(#1515). Disconnect deregisters the tower server-side and deletes its ' +
        'cloud credentials. Set CODEV_ALLOW_TEST_CLOUD_MUTATION=1 if this test ' +
        'owns a fake cloud config in an isolated CODEV_AGENT_FARM_DIR.';
      _deps?.log('ERROR', error);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error }));
      return;
    }

    let warning: string | undefined;

    // Read config FIRST (need credentials for server-side deregister)
    let config: CloudConfig | null = null;
    try {
      config = readCloudConfig();
    } catch {
      // Config corrupted — proceed with local cleanup
    }

    // Disconnect tunnel
    if (tunnelClient) {
      tunnelClient.disconnect();
      tunnelClient = null;
    }

    // Server-side deregister (best-effort)
    if (config) {
      try {
        const resp = await fetch(`${config.server_url}/api/towers/${config.tower_id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${config.api_key}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) {
          warning = `Server-side deregister failed (${resp.status}). Local credentials removed.`;
          _deps?.log('WARN', warning);
        } else {
          _deps?.log('INFO', `Server-side deregister succeeded for tower ${config.tower_id}`);
        }
      } catch (err) {
        warning = `Server-side deregister failed: ${(err as Error).message}. Local credentials removed.`;
        _deps?.log('WARN', warning);
      }
    }

    // Delete local config LAST
    try {
      deleteCloudConfig();
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: `Failed to delete local config: ${(err as Error).message}` }));
      return;
    }

    const response: Record<string, unknown> = { success: true };
    if (warning) response.warning = warning;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
    return;
  }

  // GET status
  if (req.method === 'GET' && tunnelSub === 'status') {
    let config: CloudConfig | null = null;
    try {
      config = readCloudConfig();
    } catch {
      // Config file may be corrupted — treat as unregistered
    }

    // A deregistered registration (Issue #1871) has no tunnel, whatever a
    // leftover client says; its credentials stay on disk, so name it.
    const deregistered = Boolean(config?.deregistered_at);
    const state = deregistered ? 'deregistered' : (tunnelClient?.getState() ?? 'disconnected');
    const uptime = deregistered ? null : (tunnelClient?.getUptime() ?? null);

    const response: Record<string, unknown> = {
      registered: config !== null && !deregistered,
      state,
      uptime,
      hostname: os.hostname(),
      // Why the connection is down, while it is (the client's last failure; already sanitized).
      lastFailure: deregistered || state === 'connected' ? null : (tunnelClient?.getLastFailure() ?? null),
    };

    if (config) {
      response.towerId = config.tower_id;
      response.towerName = config.tower_name;
      response.displayName = config.display_name ?? null;
      response.serverUrl = config.server_url;
      response.accessUrl = deregistered ? null : `${config.server_url}/t/${config.tower_name}/`;
      if (deregistered) response.deregisteredAt = config.deregistered_at;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
    return;
  }

  // Unknown tunnel endpoint
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}
