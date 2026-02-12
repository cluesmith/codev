/**
 * Tests for start command utilities
 */

import { describe, it, expect } from 'vitest';
import * as shell from '../utils/shell.js';

/**
 * Tests for stale architect state recovery (Issue #148)
 *
 * These tests verify that the isProcessRunning check correctly identifies
 * dead PIDs and allows recovery from stale state.
 *
 * Note: Tests for setArchitect(null) clearing state are in state.test.ts
 * which properly mocks the database to avoid mutating live state.
 */
describe('stale architect state recovery', () => {
  it('isProcessRunning returns false for definitely-dead PID', async () => {
    // PID 999999 is virtually guaranteed not to exist on any system
    const result = await shell.isProcessRunning(999999);
    expect(result).toBe(false);
  });

  it('isProcessRunning returns true for current process PID', async () => {
    // Our own process is definitely running
    const result = await shell.isProcessRunning(process.pid);
    expect(result).toBe(true);
  });
});
