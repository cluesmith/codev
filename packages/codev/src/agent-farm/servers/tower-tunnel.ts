/**
 * Cloud tunnel management for tower server.
 * Spec 0105: Tower Server Decomposition — Phase 2
 *
 * Contains: tunnel client lifecycle, config file watching,
 * metadata refresh, and tunnel API endpoint handling.
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { TunnelClient, type TunnelState, type TowerMetadata } from '../lib/tunnel-client.js';
import {
  readCloudConfig,
  writeCloudConfig,
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

/** Minimal dependencies required by the tunnel module */
export interface TunnelDeps {
  port: number;
  log: (level: 'INFO' | 'ERROR' | 'WARN', message: string) => void;
  workspaceTerminals: Map<string, WorkspaceTerminals>;
  terminalManager: TerminalManager | null;
}

// ============================================================================
// Module-private state (lifecycle driven by orchestrator)
// ============================================================================

let tunnelClient: TunnelClient | null = null;
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
    if (entry.architect) terminalToWorkspace.set(entry.architect, workspacePath);
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
 * Start periodic metadata refresh — re-gathers metadata and pushes to codevos.ai
 * every METADATA_REFRESH_MS while the tunnel is connected.
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

  const client = new TunnelClient({
    serverUrl: config.server_url,
    apiKey: config.api_key,
    towerId: config.tower_id,
    localPort: _deps.port,
  });

  client.onStateChange((state: TunnelState, prev: TunnelState) => {
    _deps!.log('INFO', `Tunnel: ${prev} → ${state}`);
    if (state === 'connected') {
      startMetadataRefresh();
    } else if (prev === 'connected') {
      stopMetadataRefresh();
    }
    if (state === 'auth_failed') {
      _deps!.log('ERROR', 'Cloud connection failed: API key is invalid or revoked. Run \'af tower connect --reauth\' to update credentials.');
    }
  });

  // Gather and set initial metadata before connecting
  const metadata = await gatherMetadata();
  client.sendMetadata(metadata);

  tunnelClient = client;
  client.connect();

  // Ensure config watcher is running — the config directory now exists.
  startConfigWatcher();

  return client;
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
          if (config) {
            // Skip if already connected (avoids redundant reconnect when the OAuth
            // callback writes config and connects directly — the file watcher fires
            // 500ms later and would kill the working connection)
            if (tunnelClient && tunnelClient.getState() === 'connected') {
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

  // Auto-connect tunnel if registered
  try {
    const config = readCloudConfig();
    if (config) {
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
 * Shut down the tunnel module. Disconnects client, stops watchers.
 */
export function shutdownTunnel(): void {
  stopMetadataRefresh();
  stopConfigWatcher();
  if (tunnelClient) {
    _deps?.log('INFO', 'Disconnecting tunnel...');
    tunnelClient.disconnect();
    tunnelClient = null;
  }
  _deps = null;
  _getInstances = null;
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
      const { towerId, apiKey } = await redeemToken(pending.serverUrl, token, pending.name, machineId);

      writeCloudConfig({
        tower_id: towerId,
        tower_name: pending.name,
        api_key: apiKey,
        server_url: pending.serverUrl,
      });

      _deps?.log('INFO', `Registration complete: tower="${pending.name}" id=${towerId} key=${maskApiKey(apiKey)}`);

      // Connect tunnel with new credentials
      const config = readCloudConfig();
      if (config) {
        await connectTunnel(config);
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(htmlPage('Connected to Codev Cloud',
        `<p>Tower "<strong>${pending.name}</strong>" is now connected.</p>` +
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
        res.end(JSON.stringify({ success: false, error: "Not registered. Run 'af tower connect' or use the Connect button in the Tower UI." }));
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

    const state = tunnelClient?.getState() ?? 'disconnected';
    const uptime = tunnelClient?.getUptime() ?? null;

    const response: Record<string, unknown> = {
      registered: config !== null,
      state,
      uptime,
      hostname: os.hostname(),
    };

    if (config) {
      response.towerId = config.tower_id;
      response.towerName = config.tower_name;
      response.serverUrl = config.server_url;
      response.accessUrl = `${config.server_url}/t/${config.tower_name}/`;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
    return;
  }

  // Unknown tunnel endpoint
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}
