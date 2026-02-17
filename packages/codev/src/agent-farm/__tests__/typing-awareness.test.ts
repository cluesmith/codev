/**
 * Tests for PtySession input tracking (Spec 403 — Phase 1)
 * Tests recordUserInput(), isUserIdle(), and lastInputAt.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node-pty so PtySession can be instantiated without a real PTY
vi.mock('node-pty', () => ({
  default: {
    spawn: vi.fn(() => ({
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      pid: 12345,
      kill: vi.fn(),
    })),
  },
}));

// Mock fs to avoid disk log creation
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    openSync: vi.fn(() => 99),
    writeSync: vi.fn(),
    closeSync: vi.fn(),
  };
});

import { PtySession } from '../../terminal/pty-session.js';

function createTestSession(): PtySession {
  return new PtySession({
    id: 'test-session-1',
    command: '/bin/bash',
    args: [],
    cols: 80,
    rows: 24,
    cwd: '/tmp',
    env: {},
    label: 'test',
    logDir: '/tmp/logs',
    diskLogEnabled: false,
  });
}

describe('PtySession Input Tracking (Spec 403)', () => {
  let session: PtySession;

  beforeEach(() => {
    vi.useFakeTimers();
    session = createTestSession();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('lastInputAt', () => {
    it('should be 0 initially (no input yet)', () => {
      expect(session.lastInputAt).toBe(0);
    });

    it('should update to current timestamp after recordUserInput()', () => {
      vi.setSystemTime(new Date('2026-02-17T12:00:00Z'));
      session.recordUserInput();
      expect(session.lastInputAt).toBe(new Date('2026-02-17T12:00:00Z').getTime());
    });

    it('should update on each call to recordUserInput()', () => {
      vi.setSystemTime(new Date('2026-02-17T12:00:00Z'));
      session.recordUserInput();
      const first = session.lastInputAt;

      vi.setSystemTime(new Date('2026-02-17T12:00:01Z'));
      session.recordUserInput();
      const second = session.lastInputAt;

      expect(second).toBeGreaterThan(first);
      expect(second - first).toBe(1000);
    });
  });

  describe('isUserIdle', () => {
    it('should return true when no input has ever been recorded', () => {
      expect(session.isUserIdle(3000)).toBe(true);
    });

    it('should return false immediately after input', () => {
      vi.setSystemTime(new Date('2026-02-17T12:00:00Z'));
      session.recordUserInput();
      expect(session.isUserIdle(3000)).toBe(false);
    });

    it('should return false when within threshold', () => {
      vi.setSystemTime(new Date('2026-02-17T12:00:00Z'));
      session.recordUserInput();

      // Advance 2 seconds (below 3s threshold)
      vi.setSystemTime(new Date('2026-02-17T12:00:02Z'));
      expect(session.isUserIdle(3000)).toBe(false);
    });

    it('should return true after threshold elapses', () => {
      vi.setSystemTime(new Date('2026-02-17T12:00:00Z'));
      session.recordUserInput();

      // Advance exactly 3 seconds
      vi.setSystemTime(new Date('2026-02-17T12:00:03Z'));
      expect(session.isUserIdle(3000)).toBe(true);
    });

    it('should return true well after threshold', () => {
      vi.setSystemTime(new Date('2026-02-17T12:00:00Z'));
      session.recordUserInput();

      // Advance 10 seconds
      vi.setSystemTime(new Date('2026-02-17T12:00:10Z'));
      expect(session.isUserIdle(3000)).toBe(true);
    });

    it('should reset to not-idle when new input arrives', () => {
      vi.setSystemTime(new Date('2026-02-17T12:00:00Z'));
      session.recordUserInput();

      // Go idle
      vi.setSystemTime(new Date('2026-02-17T12:00:05Z'));
      expect(session.isUserIdle(3000)).toBe(true);

      // New input arrives
      session.recordUserInput();
      expect(session.isUserIdle(3000)).toBe(false);
    });

    it('should work with different thresholds', () => {
      vi.setSystemTime(new Date('2026-02-17T12:00:00Z'));
      session.recordUserInput();

      vi.setSystemTime(new Date('2026-02-17T12:00:01Z'));
      // 1 second elapsed: idle for 500ms threshold, not idle for 3000ms
      expect(session.isUserIdle(500)).toBe(true);
      expect(session.isUserIdle(3000)).toBe(false);
    });
  });

  describe('recordUserInput', () => {
    it('should be callable multiple times rapidly', () => {
      vi.setSystemTime(new Date('2026-02-17T12:00:00Z'));

      // Simulate rapid keystrokes
      for (let i = 0; i < 100; i++) {
        session.recordUserInput();
      }

      expect(session.lastInputAt).toBe(new Date('2026-02-17T12:00:00Z').getTime());
      expect(session.isUserIdle(3000)).toBe(false);
    });
  });
});
