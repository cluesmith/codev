/**
 * E2E Test Teardown Helper
 *
 * Cleans up test resources after E2E tests complete.
 */

import * as fs from 'node:fs';
import type { TestContext } from './setup.js';

/**
 * Clean up all test resources.
 */
export async function teardown(ctx: TestContext): Promise<void> {
  if (!ctx.tempDir) {
    return;
  }

  // Remove temp directory
  if (fs.existsSync(ctx.tempDir)) {
    fs.rmSync(ctx.tempDir, { recursive: true, force: true });
  }
}

/**
 * Kill any lingering porch/claude processes for a test.
 */
export async function killTestProcesses(ctx: TestContext): Promise<void> {
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  try {
    // Kill any processes that might be running in the temp directory
    await execAsync(`pkill -f "${ctx.tempDir}" 2>/dev/null || true`);
  } catch {
    // Ignore errors - processes may not exist
  }
}
