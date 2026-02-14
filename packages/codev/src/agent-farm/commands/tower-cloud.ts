/**
 * Cloud Tower Registration Commands (Spec 0097 Phase 5)
 *
 * Implements `af tower connect`, `af tower connect --reauth`,
 * `af tower disconnect`, and cloud status display for `af tower status`.
 */

import http from 'node:http';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline';
import { logger, fatal } from '../utils/logger.js';
import { openBrowser } from '../utils/shell.js';
import {
  readCloudConfig,
  writeCloudConfig,
  deleteCloudConfig,
  maskApiKey,
  getOrCreateMachineId,
  type CloudConfig,
} from '../lib/cloud-config.js';
import { redeemToken } from '../lib/token-exchange.js';

const CODEVOS_URL = process.env.CODEVOS_URL || 'https://cloud.codevos.ai';
const DEFAULT_TOWER_PORT = 4100;
const CALLBACK_TIMEOUT_MS = 120_000; // 2 minutes

/**
 * Prompt the user for input via stdin.
 */
function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Prompt for yes/no confirmation. Returns true if user answers y/yes.
 */
async function confirm(question: string): Promise<boolean> {
  const answer = await prompt(question);
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}

/**
 * Get a persistent machine ID (UUID).
 * Delegates to cloud-config's getOrCreateMachineId() which reads or generates
 * a UUID stored at ~/.agent-farm/machine-id.
 */
function getMachineId(): string {
  return getOrCreateMachineId();
}

/**
 * Signal the running tower daemon to connect/disconnect the tunnel.
 */
async function signalTower(endpoint: 'connect' | 'disconnect', port?: number): Promise<void> {
  const towerPort = port || DEFAULT_TOWER_PORT;
  try {
    await fetch(`http://127.0.0.1:${towerPort}/api/tunnel/${endpoint}`, {
      method: 'POST',
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Tower may not be running — that's fine
  }
}

/**
 * Get tunnel status from the running tower daemon.
 */
export async function getTunnelStatus(port?: number): Promise<{
  registered: boolean;
  state: string;
  uptime: number | null;
  towerId: string | null;
  towerName: string | null;
  serverUrl: string | null;
  accessUrl: string | null;
} | null> {
  const towerPort = port || DEFAULT_TOWER_PORT;
  try {
    const response = await fetch(
      `http://127.0.0.1:${towerPort}/api/tunnel/status`,
      { signal: AbortSignal.timeout(3_000) },
    );
    if (!response.ok) return null;
    return (await response.json()) as Awaited<ReturnType<typeof getTunnelStatus>>;
  } catch {
    return null;
  }
}

export interface TowerRegisterOptions {
  reauth?: boolean;
  serviceUrl?: string;
  port?: number;
}

/**
 * Register this tower with codevos.ai.
 *
 * Flow:
 * 1. Check existing registration
 * 2. Start ephemeral HTTP server for browser callback
 * 3. Open browser to codevos.ai registration page
 * 4. Wait for callback (2 min timeout), fallback to manual token paste
 * 5. Prompt for tower name (skip on --reauth)
 * 6. Exchange token for API key
 * 7. Write cloud-config.json
 * 8. Signal tower daemon if running
 */
export async function towerRegister(options: TowerRegisterOptions = {}): Promise<void> {
  const existing = readCloudConfig();

  // Check existing registration
  if (existing && !options.reauth) {
    const proceed = await confirm(
      `This tower is already registered as '${existing.tower_name}'. Re-register? (y/N) `,
    );
    if (!proceed) {
      logger.info('Registration cancelled.');
      return;
    }
  }

  logger.header('Tower Registration');

  // Resolve service URL: CLI --service flag > CODEVOS_URL env var > existing config > default
  // Normalize to HTTPS — HTTP POST requests get downgraded to GET by 301 redirects
  const rawUrl = options.serviceUrl || process.env.CODEVOS_URL || existing?.server_url || 'https://cloud.codevos.ai';
  const serverUrl = rawUrl.replace(/^http:\/\/(?!localhost)/, 'https://');

  // Start ephemeral callback server
  const callbackServer = await startCallbackServer();
  const callbackUrl = `http://localhost:${callbackServer.port}/callback`;

  const callbackParam = `callback=${encodeURIComponent(callbackUrl)}`;
  const browserUrl = options.reauth
    ? `${serverUrl}/towers/register?reauth=true&${callbackParam}`
    : `${serverUrl}/towers/register?${callbackParam}`;

  logger.info('Opening browser for authentication...');
  logger.kv('URL', browserUrl);

  try {
    await openBrowser(browserUrl);
  } catch {
    logger.warn('Could not open browser automatically.');
    logger.info(`Open this URL manually: ${browserUrl}`);
  }

  logger.info('Waiting for authentication (2 minute timeout)...');

  // Wait for callback or timeout
  let token = await callbackServer.waitForToken(CALLBACK_TIMEOUT_MS);

  if (!token) {
    // Fallback: manual token paste
    logger.warn('Browser callback timed out.');
    token = await prompt('Paste registration token from browser: ');

    if (!token) {
      fatal('No token provided. Registration cancelled.');
    }
  }

  // Prompt for tower name (skip on reauth)
  let towerName: string;
  if (options.reauth && existing) {
    towerName = existing.tower_name;
    logger.kv('Tower name', towerName);
  } else {
    const defaultName = hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    towerName = await prompt(`Tower name (default: ${defaultName}): `);
    if (!towerName) towerName = defaultName;
  }

  // Exchange token for API key
  logger.info('Exchanging token...');

  let towerId: string;
  let apiKey: string;
  try {
    ({ towerId, apiKey } = await redeemToken(serverUrl, token, towerName, getMachineId()));
  } catch (err) {
    fatal(`Token exchange failed: ${(err as Error).message}`);
  }

  // Write config
  const config: CloudConfig = {
    tower_id: towerId,
    tower_name: towerName,
    api_key: apiKey,
    server_url: serverUrl,
  };
  writeCloudConfig(config);

  // Signal tower daemon if running
  await signalTower('connect', options.port);

  // Print success
  const accessUrl = `${serverUrl}/t/${towerName}/`;
  logger.blank();
  logger.success(`Tower '${towerName}' registered successfully.`);
  logger.kv('Tower ID', towerId);
  logger.kv('API Key', maskApiKey(apiKey));
  logger.kv('Access URL', accessUrl);
}

/**
 * Deregister this tower from codevos.ai.
 */
export async function towerDeregister(options: { port?: number } = {}): Promise<void> {
  const config = readCloudConfig();

  if (!config) {
    fatal('Tower is not registered. Nothing to deregister.');
  }

  // Call server to deregister
  try {
    const response = await fetch(
      `${config.server_url}/api/towers/${config.tower_id}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${config.api_key}`,
        },
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!response.ok && response.status !== 404) {
      const text = await response.text().catch(() => '');
      logger.warn(`Server deregistration returned ${response.status}: ${text || response.statusText}`);
    }
  } catch (err) {
    logger.warn(`Could not reach codevos.ai: ${(err as Error).message}. Removing local config anyway.`);
  }

  // Delete local config
  deleteCloudConfig();

  // Signal tower daemon to disconnect
  await signalTower('disconnect', options.port);

  logger.blank();
  logger.success('Tower deregistered successfully.');
}

/**
 * Display cloud connection status.
 */
export async function towerCloudStatus(port?: number): Promise<void> {
  const config = readCloudConfig();

  if (!config) {
    logger.blank();
    logger.info('Cloud Registration: not registered. Run \'af tower connect\' to connect to codevos.ai.');
    return;
  }

  logger.blank();
  logger.header('Cloud Connection');
  logger.kv('Registration', 'registered');
  logger.kv('Tower Name', config.tower_name);
  logger.kv('Tower ID', config.tower_id);
  logger.kv('Server', config.server_url);
  logger.kv('API Key', maskApiKey(config.api_key));

  // Try to get live tunnel status from daemon
  const status = await getTunnelStatus(port);

  if (status) {
    logger.kv('Connection', status.state);
    if (status.uptime !== null) {
      logger.kv('Uptime', formatUptime(status.uptime));
    }
    if (status.accessUrl) {
      logger.kv('Access URL', status.accessUrl);
    }
  } else {
    logger.kv('Connection', 'unknown (tower not running)');
    logger.kv('Access URL', `${config.server_url}/t/${config.tower_name}/`);
  }
}

/**
 * Format uptime in milliseconds to a human-readable string.
 */
function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

// ============================================================================
// Internal: Callback server helper
// ============================================================================

interface CallbackServer {
  port: number;
  waitForToken(timeoutMs: number): Promise<string | null>;
  close(): void;
}

function startCallbackServer(): Promise<CallbackServer> {
  return new Promise((resolve) => {
    let tokenResolve: ((token: string | null) => void) | null = null;

    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost`);

      if (url.pathname === '/callback') {
        const token = url.searchParams.get('token');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Registration received!</h1><p>You can close this tab.</p></body></html>');

        if (token && tokenResolve) {
          const r = tokenResolve;
          tokenResolve = null;
          r(token);
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };

      resolve({
        port: addr.port,
        waitForToken(timeoutMs: number): Promise<string | null> {
          return new Promise((r) => {
            tokenResolve = (token) => {
              server.close();
              r(token);
            };

            setTimeout(() => {
              if (tokenResolve) {
                tokenResolve = null;
                server.close();
                r(null);
              }
            }, timeoutMs);
          });
        },
        close() {
          server.close();
        },
      });
    });
  });
}
