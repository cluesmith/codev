/**
 * Playwright global setup: activate workspace and wait for architect terminal.
 *
 * When Playwright starts a fresh tower (CI, or locally without a running tower),
 * no workspace is active and no architect terminal exists. Tests that wait for
 * `.terminal-container` time out because the Terminal component never mounts.
 *
 * This setup:
 *   1. Activates the workspace via POST /api/launch (with retry on the
 *      transient "Tower is still starting up" 400 — see bugfix #773)
 *   2. Polls GET /api/state until architect.terminalId is present
 *
 * In CI, set TOWER_ARCHITECT_CMD=bash so the architect terminal uses a plain
 * shell instead of `claude` (which isn't installed on CI runners).
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TOWER_PORT = Number(process.env.TOWER_TEST_PORT || '4100');
const TOWER_URL = `http://localhost:${TOWER_PORT}`;
const WORKSPACE_PATH = resolve(__dirname, '../../../../../../');
const ENCODED_PATH = Buffer.from(WORKSPACE_PATH).toString('base64url');
const STATE_URL = `${TOWER_URL}/workspace/${ENCODED_PATH}/api/state`;

/**
 * Tower returns this exact error string while its async `_deps` initialization
 * is still in progress (see `launchInstance` in tower-instances.ts). The HTTP
 * layer maps it to 400, but it's a transient startup race, not a genuine
 * launch failure — the client should retry until Tower is ready.
 */
const TOWER_STARTING_MARKER = 'Tower is still starting up';

export interface LaunchResult {
  ok: boolean;
  status: number;
  body: string;
  attempts: number;
}

/**
 * POST /api/launch with bounded retry on the transient "Tower is still
 * starting up" 400. Other non-OK responses (genuinely-failing launches,
 * an already-active workspace's odd responses, etc.) return immediately
 * so callers can decide how to react.
 *
 * Exported for unit testing — see bugfix-773-launch-retry.test.ts.
 */
export async function launchWorkspaceWithRetry(
  url: string,
  workspacePath: string,
  options: {
    timeout?: number;
    interval?: number;
    fetchFn?: typeof fetch;
  } = {},
): Promise<LaunchResult> {
  const timeout = options.timeout ?? 30_000;
  const interval = options.interval ?? 500;
  const fetchFn = options.fetchFn ?? fetch;
  const start = Date.now();

  let attempts = 0;
  while (true) {
    attempts++;
    const res = await fetchFn(url, {
      method: 'POST',
      body: JSON.stringify({ workspacePath }),
      headers: { 'Content-Type': 'application/json' },
    });
    const body = await res.text();

    // Success, or a terminal failure unrelated to the startup race → stop.
    if (res.ok || !body.includes(TOWER_STARTING_MARKER)) {
      return { ok: res.ok, status: res.status, body, attempts };
    }

    // Transient startup race. Retry until the budget is exhausted.
    if (Date.now() - start + interval >= timeout) {
      return { ok: false, status: res.status, body, attempts };
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

export default async function globalSetup() {
  // Step 1: Activate the workspace via POST /api/launch (with retry).
  const launch = await launchWorkspaceWithRetry(`${TOWER_URL}/api/launch`, WORKSPACE_PATH);

  if (!launch.ok) {
    // Workspace may already be active, or launch genuinely failed — only
    // warn here so the state poll below can confirm reality.
    console.warn(
      `[global-setup] POST /api/launch returned ${launch.status} after ${launch.attempts} attempt(s): ${launch.body}`,
    );
  } else {
    console.log(
      `[global-setup] Workspace activated (${launch.attempts} attempt(s)): ${launch.body}`,
    );
  }

  // Step 2: Poll for architect terminal readiness
  const timeout = 30_000;
  const interval = 500;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const stateRes = await fetch(STATE_URL);
      if (stateRes.ok) {
        const state = await stateRes.json();
        if ((state as { architect?: { terminalId?: string } }).architect?.terminalId) {
          console.log(`[global-setup] Architect terminal ready (${Date.now() - start}ms)`);
          return;
        }
      }
    } catch {
      // Server may not be fully ready yet
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  // Don't fail hard — some tests don't need the terminal.
  // Terminal-dependent tests will fail on their own with clear timeout errors.
  console.warn(
    `[global-setup] Architect terminal not ready after ${timeout}ms. ` +
      'Terminal-dependent tests will likely fail. ' +
      'In CI, ensure TOWER_ARCHITECT_CMD=bash is set.',
  );
}
