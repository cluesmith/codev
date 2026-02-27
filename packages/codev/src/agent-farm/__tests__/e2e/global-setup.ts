/**
 * Playwright global setup: activate workspace and wait for architect terminal.
 *
 * When Playwright starts a fresh tower (CI, or locally without a running tower),
 * no workspace is active and no architect terminal exists. Tests that wait for
 * `.terminal-container` time out because the Terminal component never mounts.
 *
 * This setup:
 *   1. Activates the workspace via POST /api/launch
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

export default async function globalSetup() {
  // Step 1: Activate the workspace via POST /api/launch
  const launchRes = await fetch(`${TOWER_URL}/api/launch`, {
    method: 'POST',
    body: JSON.stringify({ workspacePath: WORKSPACE_PATH }),
    headers: { 'Content-Type': 'application/json' },
  });

  const launchBody = await launchRes.text();
  if (!launchRes.ok) {
    // Workspace may already be active — only warn if it's a real failure
    console.warn(`[global-setup] POST /api/launch returned ${launchRes.status}: ${launchBody}`);
  } else {
    console.log(`[global-setup] Workspace activated: ${launchBody}`);
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
